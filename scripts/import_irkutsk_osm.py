"""Build the game's road graph from a pinned OSM snapshot, without invented links.

python scripts/import_irkutsk_osm.py
python scripts/import_irkutsk_osm.py --prepare-source path/to/overpass.json [...]

The importer never merges nearby coordinates: graph connectivity uses original
OSM node IDs only. All original shape vertices survive in edge.geometry. Transit
relations supply ordered platform GPS points and preferred road members. Missing
or misordered relation members are repaired only by traversing connected source
roads, and every such road is listed in the import audit. No network is needed
to reproduce the checked-in generated city.js files.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import heapq
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "geography/source/irkutsk-osm-2026-11-11.json.gz"
ROUTE_CACHE = ROOT / "geography/source/verified-route-corridors.json.gz"
METERS_PER_UNIT = 7 / 3.6 / 60
LAT0, LON0, RADIUS = 52.28, 104.28, 6371008.8
ROUTES = {
    "480": [17321890, 17321889],
    "80": [17296020],
    "90": [17296834],
    "83": [17296773, 17296772],
    "33": [17288442, 17288443],
    "Т4": [11641249, 11641245],
}
NON_MOTOR = {"footway", "path", "cycleway", "steps", "pedestrian", "construction", "proposed", "platform", "bridleway", "corridor", "elevator"}


def normalize_name(name):
    name = re.sub(r"\(.*?\)", "", name.lower().replace("ё", "е"))
    name = re.sub(r"\b(улица|ул|микрорайон|м/р|поселок|пос|имени|им|площадь|пл)\b", "", name)
    return re.sub(r"[^а-яa-z0-9]", "", name)


def merge_elements(documents):
    merged = {}
    for document in documents:
        for element in document["elements"]:
            key = (element["type"], element["id"])
            previous = merged.get(key, {})
            merged[key] = {**previous, **element}
            if "tags" in previous or "tags" in element:
                merged[key]["tags"] = {**previous.get("tags", {}), **element.get("tags", {})}
    return [merged[key] for key in sorted(merged)]


def project_geo(lat, lon):
    return ((lon - LON0) * math.pi / 180 * RADIUS * math.cos(math.radians(LAT0)) / METERS_PER_UNIT,
            -(lat - LAT0) * math.pi / 180 * RADIUS / METERS_PER_UNIT)


def oneway(tags):
    value = tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no")
    return -1 if value == "-1" else 1 if value in ("yes", "true", "1") else 0


def bus_oneway(tags):
    value = tags.get("oneway:bus", tags.get("oneway:psv"))
    if value == "-1":
        return -1
    if value in ("yes", "true", "1"):
        return 1
    if value in ("no", "false", "0") or tags.get("busway", "").startswith("opposite"):
        return 0
    return oneway(tags)


def allows_bus(tags):
    if tags.get("highway") in NON_MOTOR or tags.get("area") == "yes":
        return False
    allowed = any(tags.get(key) in ("yes", "designated", "permissive") for key in ("bus", "psv", "trolleybus"))
    return allowed or not any(tags.get(key) in ("no", "private") for key in ("access", "vehicle", "motor_vehicle"))


class RoadGraph:
    def __init__(self, source):
        self.source = source
        self.evidence = json.loads((ROOT / "geography/source/authoritative_stop_order.json").read_text(encoding="utf-8"))
        self.aliases = {}
        groups = [*self.evidence["aliasGroups"],
                  ["Бакалея", 'Оптовый рынок "Бакалея"'], ["Кировская 3-я", "3-я Кировская"],
                  ["Контейнерная", "Контейнерная площадка"], ["Академическая", "станция Академическая"],
                  ["Библиотека им. Е.А. Евтушенко", "Библиотека им. Евтушенко"],
                  ["Библиотека им. Распутина (по требованию)", "Библитека им. Распутина"],
                  ["Парк Патриот", 'ВСЭМ / Парк "Патриот"'], ["Усадьба Сукачёва", "Музей-усадьба им. Сукачева"],
                  ["Луговое", 'ЖК "Луговое"']]
        for group in groups:
            canonical = self.aliases.get(normalize_name(group[0]), normalize_name(group[0]))
            for name in group:
                self.aliases[normalize_name(name)] = canonical
        self.stop_overrides = json.loads((ROOT / "geography/source/2gis_stop_platforms.json").read_text(encoding="utf-8"))["platforms"]
        self.raw = {(e["type"], e["id"]): e for e in source["elements"]}
        self.raw_nodes = {e["id"]: e for e in source["elements"] if e["type"] == "node"}
        self.relations = {e["id"]: e for e in source["elements"] if e["type"] == "relation" and e.get("tags", {}).get("type") == "route"}
        platform_ids = {m["ref"] for ids in ROUTES.values() for rid in ids for m in self.relations[rid]["members"]
                        if m["type"] == "node" and m["role"].startswith("platform")}
        self.platform_nodes = [node for node in self.raw_nodes.values() if node["id"] in platform_ids
                               or node.get("tags", {}).get("highway") == "bus_stop"
                               or node.get("tags", {}).get("public_transport") in ("platform", "stop_position")]
        required = {m["ref"] for ids in ROUTES.values() for rid in ids for m in self.relations[rid]["members"] if m["type"] == "way" and not m["role"].startswith("platform")}
        self.ways = {e["id"]: e for e in source["elements"] if e["type"] == "way" and "highway" in e.get("tags", {})
                     and (allows_bus(e.get("tags", {})) or e["id"] in required)}
        self.turn_rules = defaultdict(list)
        self.source_restrictions = []
        for element in source["elements"]:
            tags = element.get("tags", {})
            if element["type"] != "relation" or tags.get("type") != "restriction":
                continue
            self.source_restrictions.append(element)
            if set(tags.get("except", "").split(";")) & {"bus", "psv", "trolleybus"}:
                continue
            kind = tags.get("restriction:bus", tags.get("restriction:psv", tags.get("restriction", "")))
            via = [member["ref"] for member in element["members"] if member["role"] == "via" and member["type"] == "node"]
            from_ways = [member["ref"] for member in element["members"] if member["role"] == "from" and member["type"] == "way"]
            to_ways = [member["ref"] for member in element["members"] if member["role"] == "to" and member["type"] == "way"]
            if len(via) == 1 and kind.startswith(("no_", "only_")):
                for from_way in from_ways:
                    for to_way in to_ways:
                        self.turn_rules[via[0]].append({"fromWay": from_way, "toWay": to_way, "kind": kind, "osmRelationId": element["id"]})
        membership = defaultdict(set)
        for way in self.ways.values():
            for node in way["nodes"]:
                membership[node].add(way["id"])
        self.membership = membership
        split = {node for node, ways in membership.items() if len(ways) > 1}
        split.update(self.turn_rules)
        split.update(node for node, raw in self.raw_nodes.items()
                     if raw.get("tags", {}).get("highway") in ("traffic_signals", "crossing", "stop", "give_way"))
        for way in self.ways.values():
            split.update((way["nodes"][0], way["nodes"][-1]))
            if way["nodes"][0] == way["nodes"][-1]:
                split.add(way["nodes"][len(way["nodes"]) // 2])
        self.nodes = {}
        self.edges = {}
        self.adjacent = defaultdict(list)
        self.way_edges = defaultdict(list)
        for way_id, way in sorted(self.ways.items()):
            tags = way.get("tags", {})
            start = 0
            for index in range(1, len(way["nodes"])):
                if way["nodes"][index] not in split:
                    continue
                ids = way["nodes"][start:index + 1]
                start = index
                points = [project_geo(self.raw_nodes[node]["lat"], self.raw_nodes[node]["lon"]) for node in ids]
                distances = [0.0]
                for a, b in zip(points, points[1:]):
                    distances.append(distances[-1] + math.dist(a, b))
                if distances[-1] < .001:
                    continue
                for node in (ids[0], ids[-1]):
                    raw_node = self.raw_nodes[node]
                    xy = project_geo(raw_node["lat"], raw_node["lon"])
                    self.nodes[node] = {"id": f"osm-{node}", "osmId": node, "lat": raw_node["lat"], "lon": raw_node["lon"],
                                        "x": round(xy[0], 6), "y": round(xy[1], 6), "junction": len(membership[node]) > 2,
                                        "osmTags": raw_node.get("tags", {})}
                try:
                    osm_lanes = int(tags.get("lanes", "2").split(";")[0])
                except ValueError:
                    osm_lanes = 2
                eid = f"osm-way-{way_id}-{ids[0]}-{ids[-1]}"
                edge = {"id": eid, "from": f"osm-{ids[0]}", "to": f"osm-{ids[-1]}",
                        "street": tags.get("name", "Безымянный проезд"),
                        "lanes": min(6, max(2, math.ceil(osm_lanes / 2) * 2)),
                        "oneway": oneway(tags), "busOneway": bus_oneway(tags),
                        "geometry": [[round(x, 6), round(y, 6)] for x, y in points],
                        "osmWayIds": [way_id], "osmNodeIds": ids,
                        "osmTags": dict(tags)}
                controls = [{"osmId": node, "lat": self.raw_nodes[node]["lat"], "lon": self.raw_nodes[node]["lon"],
                             "osmTags": self.raw_nodes[node]["tags"]} for node in ids if self.raw_nodes[node].get("tags")]
                if controls:
                    edge["sourceControlNodes"] = controls
                self.edges[eid] = {**edge, "_points": points, "_distances": distances, "_length": distances[-1], "_from": ids[0], "_to": ids[-1]}
                self.way_edges[way_id].append(eid)
                if edge["busOneway"] != -1:
                    self.adjacent[ids[0]].append((ids[-1], eid, False))
                if edge["busOneway"] != 1:
                    self.adjacent[ids[-1]].append((ids[0], eid, True))

    def leg(self, edge_id, reverse=False):
        return {"edge": edge_id, "reverse": reverse}

    def origin(self, leg):
        edge = self.edges[leg["edge"]]
        return edge["_to"] if leg["reverse"] else edge["_from"]

    def end(self, leg):
        edge = self.edges[leg["edge"]]
        return edge["_from"] if leg["reverse"] else edge["_to"]

    def projection(self, edge, point):
        best = None
        for index, (a, b) in enumerate(zip(edge["_points"], edge["_points"][1:])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length2 = dx * dx + dy * dy
            t = 0 if not length2 else max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2))
            projected = (a[0] + t * dx, a[1] + t * dy)
            candidate = (math.dist(point, projected), edge["_distances"][index] + t * math.sqrt(length2))
            if best is None or candidate < best:
                best = candidate
        return best

    def can_turn(self, incoming, node, outgoing):
        if incoming is None:
            return True
        from_way = self.edges[incoming]["osmWayIds"][0]
        to_way = self.edges[outgoing]["osmWayIds"][0]
        rules = [rule for rule in self.turn_rules[node] if rule["fromWay"] == from_way]
        only = [rule for rule in rules if rule["kind"].startswith("only_")]
        def matches(rule):
            return rule["toWay"] == to_way and (rule["kind"] not in ("no_u_turn", "only_u_turn") or incoming == outgoing)
        return (not only or any(matches(rule) for rule in only)) and not any(matches(rule) for rule in rules if rule["kind"].startswith("no_"))

    def shortest_tree(self, start, preferred, incoming=None, radius_meters=None):
        initial = (start, incoming)
        distances, previous = {initial: 0.0}, {}
        pending = [(0.0, start, incoming or "")]
        by_node = defaultdict(list)
        center = (self.nodes[start]["x"], self.nodes[start]["y"])
        while pending:
            cost, node, incoming_id = heapq.heappop(pending)
            state = (node, incoming_id or None)
            if cost != distances[state]:
                continue
            if radius_meters is not None and math.dist(center, (self.nodes[node]["x"], self.nodes[node]["y"])) * METERS_PER_UNIT > radius_meters:
                continue
            by_node[node].append(state)
            for target, eid, reverse in self.adjacent[node]:
                if not self.can_turn(state[1], node, eid):
                    continue
                edge = self.edges[eid]
                weight = edge["_length"] * (1 if edge["osmWayIds"][0] in preferred else 2.5)
                new_cost = cost + weight
                next_state = (target, eid)
                if new_cost < distances.get(next_state, math.inf):
                    distances[next_state] = new_cost
                    previous[next_state] = (state, eid, reverse)
                    heapq.heappush(pending, (new_cost, target, eid))
        return distances, previous, by_node

    def route_relation(self, relation_id, number, direction_index):
        relation = self.relations[relation_id]
        preferred = {m["ref"] for m in relation["members"] if m["type"] == "way" and not m["role"].startswith("platform")}
        preferred_platform_ids = {m["ref"] for m in relation["members"] if m["type"] == "node" and m["role"].startswith("platform")}
        direction = self.evidence["routes"][number]["directions"][direction_index]
        platforms = []
        def canonical(name):
            return self.aliases.get(normalize_name(name), normalize_name(name))
        for ordinal, desired in enumerate(direction["stops"]):
            search_name = desired
            matches = [node for node in self.platform_nodes if canonical(node.get("tags", {}).get("name", "")) == canonical(search_name)]
            own_matches = [node for node in matches if node["id"] in preferred_platform_ids]
            if own_matches:
                matches = [node for node in matches if node in own_matches or
                           any(math.dist(project_geo(node["lat"], node["lon"]), project_geo(own["lat"], own["lon"])) * METERS_PER_UNIT < 100 for own in own_matches)]
            scoped_matches = []
            for override in self.stop_overrides:
                if canonical(override["name"]) != canonical(desired):
                    continue
                if override.get("route", number) != number or override.get("direction", direction["key"]) != direction["key"] or override.get("stopIndex", ordinal) != ordinal:
                    continue
                node = {"id": "2gis-" + override["id"], "lat": override["lat"], "lon": override["lon"],
                        "tags": {"name": override["name"]}, "source2gis": override}
                matches.append(node)
                if "stopIndex" in override:
                    scoped_matches.append(node)
            if scoped_matches:
                matches = scoped_matches
            if not matches:
                raise ValueError(f"No sourced GPS for 2GIS stop {number}/{direction['key']}: {desired}")
            platforms.append((desired, matches))
        trees = {}

        def connect(start, end, incoming, outgoing):
            if start == end and self.can_turn(incoming, start, outgoing):
                return 0.0, []
            direct = math.dist((self.nodes[start]["x"], self.nodes[start]["y"]), (self.nodes[end]["x"], self.nodes[end]["y"])) * METERS_PER_UNIT
            radius = max(1000, math.ceil((direct * 2.5 + 500) / 1000) * 1000)
            key = (start, incoming, radius)
            if key not in trees:
                trees[key] = self.shortest_tree(start, preferred, incoming, radius)
            costs, previous, by_node = trees[key]
            targets = [state for state in by_node[end] if self.can_turn(state[1], end, outgoing)]
            if not targets:
                return math.inf, []
            state, path = min(targets, key=lambda state: costs[state]), []
            cost = costs[state]
            while state != (start, incoming):
                state, eid, reverse = previous[state]
                path.append(self.leg(eid, reverse))
            return cost, list(reversed(path))

        states = []
        for ordinal, (desired_name, matches) in enumerate(platforms):
            trees.clear()
            candidates = []
            for platform in matches:
                point = project_geo(platform["lat"], platform["lon"])
                candidate_edges = self.edges.values() if "source2gis" in platform else (self.edges[eid] for way in preferred for eid in self.way_edges[way])
                for edge in candidate_edges:
                        eid = edge["id"]
                        distance, offset = self.projection(edge, point)
                        if distance * METERS_PER_UNIT > 60:
                            continue
                        for reverse in (False, True):
                            if edge["busOneway"] == (1 if reverse else -1):
                                continue
                            candidates.append({"leg": self.leg(eid, reverse), "offset": offset,
                                               "distance": distance, "platform": platform, "ordinal": ordinal, "name": desired_name,
                                               "platformPenalty": 0 if platform["id"] in preferred_platform_ids or "source2gis" in platform else 20 / METERS_PER_UNIT})
            candidates.sort(key=lambda candidate: candidate["distance"] + candidate["platformPenalty"])
            nearest = candidates[0]["distance"] if candidates else math.inf
            candidates = [candidate for candidate in candidates
                          if candidate["distance"] <= min(60 / METERS_PER_UNIT, nearest + 20 / METERS_PER_UNIT)][:16]
            if not candidates or candidates[0]["distance"] * METERS_PER_UNIT > 200:
                raise ValueError(f"Relation {relation_id}: 2GIS stop {desired_name} has no sourced platform within 60m of mapped roads")
            next_states = []
            for candidate in candidates:
                leg, edge = candidate["leg"], self.edges[candidate["leg"]["edge"]]
                progress = edge["_length"] - candidate["offset"] if leg["reverse"] else candidate["offset"]
                penalty = candidate["distance"] * 15 + candidate["platformPenalty"]
                if not states:
                    next_states.append({"cost": penalty, "candidate": candidate, "previous": None, "transition": [leg]})
                    continue
                best = None
                for state in states:
                    old = state["candidate"]
                    if old["name"] == candidate["name"] and old["platform"]["id"] == candidate["platform"]["id"]:
                        continue
                    old_edge = self.edges[old["leg"]["edge"]]
                    old_progress = old_edge["_length"] - old["offset"] if old["leg"]["reverse"] else old["offset"]
                    if old["leg"] == leg and progress >= old_progress:
                        cost, path = progress - old_progress, []
                    else:
                        cost, middle = connect(self.end(old["leg"]), self.origin(leg), old["leg"]["edge"], leg["edge"])
                        cost += old_edge["_length"] - old_progress + progress
                        path = [*middle, leg]
                    total = state["cost"] + cost + penalty
                    if best is None or total < best["cost"]:
                        best = {"cost": total, "candidate": candidate, "previous": state, "transition": path}
                if best and math.isfinite(best["cost"]):
                    next_states.append(best)
            states = sorted(next_states, key=lambda state: state["cost"])[:8]
            if not states:
                raise ValueError(f"Relation {relation_id}: no real directed road connection to 2GIS stop {desired_name}")
        chain = []
        state = min(states, key=lambda state: state["cost"])
        while state:
            chain.append(state)
            state = state["previous"]
        path, stops, gap_audit = [], [], []
        previous_candidate = None
        for state in reversed(chain):
            path.extend(state["transition"])
            candidate, platform = state["candidate"], state["candidate"]["platform"]
            edge = self.edges[candidate["leg"]["edge"]]
            stop = {"name": candidate["name"], "sourceName": platform.get("tags", {}).get("name"),
                          "edge": edge["id"], "reverse": candidate["leg"]["reverse"],
                          "at": round(candidate["offset"] / edge["_length"], 10), "pathIndex": len(path) - 1,
                          "lat": platform["lat"], "lon": platform["lon"],
                          "distanceToRoadMeters": round(candidate["distance"] * METERS_PER_UNIT, 3), "relationId": relation_id}
            if "source2gis" in platform:
                stop["source2gis"] = platform["source2gis"]
                stop["source2gisId"] = platform["source2gis"]["id"]
                stop["sourceURL"] = platform["source2gis"]["source"]
            else:
                stop["osmId"] = platform["id"]
            stops.append(stop)
            if previous_candidate:
                old = previous_candidate
                old_edge = self.edges[old["leg"]["edge"]]
                old_progress = old_edge["_length"] - old["offset"] if old["leg"]["reverse"] else old["offset"]
                progress = edge["_length"] - candidate["offset"] if candidate["leg"]["reverse"] else candidate["offset"]
                travelled = progress - old_progress if not state["transition"] else old_edge["_length"] - old_progress + sum(self.edges[leg["edge"]]["_length"] for leg in state["transition"][:-1]) + progress
                direct = math.dist(project_geo(old["platform"]["lat"], old["platform"]["lon"]), project_geo(platform["lat"], platform["lon"])) * METERS_PER_UNIT
                gap_audit.append({"from": old["name"], "to": candidate["name"], "meters": round(travelled * METERS_PER_UNIT, 2), "directMeters": round(direct, 2),
                                  "ways": list(dict.fromkeys(self.edges[leg["edge"]]["osmWayIds"][0] for leg in state["transition"])),
                                  "streets": list(dict.fromkeys(self.edges[leg["edge"]]["street"] for leg in state["transition"])),
                                  "criticalDetour": travelled * METERS_PER_UNIT > max(1500, direct * 4 + 500)})
            previous_candidate = candidate
        repairs = [leg for leg in path if self.edges[leg["edge"]]["osmWayIds"][0] not in preferred]
        audit = {"relationId": relation_id, "name": relation["tags"].get("name"), "stops": stops,
                 "pathEdges": len(path), "roadLengthMeters": round(sum(self.edges[leg["edge"]]["_length"] for leg in path) * METERS_PER_UNIT, 3),
                 "addedRoadWays": sorted({self.edges[leg["edge"]]["osmWayIds"][0] for leg in repairs}),
                 "gaps": gap_audit,
                 "maxStopDistanceMeters": max(stop["distanceToRoadMeters"] for stop in stops)}
        return path, stops, audit

    def connector(self, start, end, preferred, incoming, outgoing):
        if start == end and self.can_turn(incoming, start, outgoing):
            return []
        costs, previous, by_node = self.shortest_tree(start, preferred, incoming)
        targets = [state for state in by_node[end] if self.can_turn(state[1], end, outgoing)]
        if not targets:
            raise ValueError(f"No actual terminal connection from OSM node {start} to {end}")
        state, result = min(targets, key=lambda state: costs[state]), []
        while state != (start, incoming):
            state, eid, reverse = previous[state]
            result.append(self.leg(eid, reverse))
        return list(reversed(result))

    def remap_cached_route(self, route, old_edges):
        route = json.loads(json.dumps(route))
        for path_key, stops_key in (("path", "stops"), ("returnPath", "returnStops")):
            if path_key not in route:
                continue
            new_path, ranges = [], []
            for old_leg in route[path_key]:
                old = old_edges[old_leg["edge"]]
                way_id = old["osmWayIds"][0]
                wanted = list(reversed(old["osmNodeIds"])) if old_leg["reverse"] else old["osmNodeIds"]
                cursor, begin = 0, len(new_path)
                while cursor < len(wanted) - 1:
                    found = None
                    for eid in self.way_edges[way_id]:
                        edge = self.edges[eid]
                        for reverse in (False, True):
                            sequence = list(reversed(edge["osmNodeIds"])) if reverse else edge["osmNodeIds"]
                            if sequence == wanted[cursor:cursor + len(sequence)]:
                                found = self.leg(eid, reverse), len(sequence) - 1
                                break
                        if found:
                            break
                    if not found:
                        raise ValueError(f"Source way {way_id} changed since corridor snapshot; rebuild routes instead of inventing a connection")
                    new_path.append(found[0])
                    cursor += found[1]
                ranges.append((begin, len(new_path)))
            for stop in route.get(stops_key, []):
                begin, end = ranges[stop["pathIndex"]]
                point = project_geo(stop["lat"], stop["lon"])
                candidates = []
                for index in range(begin, end):
                    leg = new_path[index]
                    edge = self.edges[leg["edge"]]
                    distance, offset = self.projection(edge, point)
                    candidates.append((distance, index, offset, leg))
                distance, index, offset, leg = min(candidates, key=lambda value: (value[0], value[1]))
                stop.update(edge=leg["edge"], reverse=leg["reverse"], pathIndex=index,
                            at=round(offset / self.edges[leg["edge"]]["_length"], 10),
                            distanceToRoadMeters=round(distance * METERS_PER_UNIT, 3))
            route[path_key] = new_path
        return route

    def export(self, cache=None):
        routes, audit = {}, {"relations": [], "terminalConnectors": []}
        if cache:
            audit = json.loads(json.dumps(cache["audit"]))
            audit["corridorReuse"] = "Original verified OSM way/node paths re-split at additional city-road junctions; no re-routing or distance merging."
            old_edges = {edge["id"]: edge for edge in cache["edges"]}
        for number, ids in ROUTES.items():
            if cache:
                routes[number] = self.remap_cached_route(cache["routes"][number], old_edges)
                continue
            first = self.relations[ids[0]]["tags"]
            path, stops, info = self.route_relation(ids[0], number, 0)
            audit["relations"].append(info)
            route = {"title": f"{first.get('from')} — {first.get('to')}", "termini": [first.get("from"), first.get("to")],
                     "source": f"https://www.openstreetmap.org/relation/{ids[0]}", "relationIds": ids, "path": path, "stops": stops}
            if len(ids) == 1:
                route["loop"] = True
                connector = self.connector(self.end(path[-1]), self.origin(path[0]), {self.edges[leg["edge"]]["osmWayIds"][0] for leg in path}, path[-1]["edge"], path[0]["edge"])
                route["path"].extend(connector)
                audit["terminalConnectors"].append({"route": number, "end": "loop", "edges": connector})
            else:
                return_path, return_stops, info = self.route_relation(ids[1], number, 1)
                audit["relations"].append(info)
                preferred = {self.edges[leg["edge"]]["osmWayIds"][0] for leg in [*path, *return_path]}
                outward_connector = self.connector(self.end(path[-1]), self.origin(return_path[0]), preferred, path[-1]["edge"], return_path[0]["edge"])
                return_connector = self.connector(self.end(return_path[-1]), self.origin(path[0]), preferred, return_path[-1]["edge"], path[0]["edge"])
                route["path"].extend(outward_connector)
                route["returnPath"], route["returnStops"] = [*return_path, *return_connector], return_stops
                audit["terminalConnectors"].append({"route": number, "end": "outward", "edges": outward_connector})
                audit["terminalConnectors"].append({"route": number, "end": "return", "edges": return_connector})
            routes[number] = route
        if cache:
            for info in audit["relations"]:
                for number, ids in ROUTES.items():
                    if info["relationId"] not in ids:
                        continue
                    route = routes[number]
                    path = route["path"] if ids.index(info["relationId"]) == 0 else route["returnPath"]
                    stops = route["stops"] if ids.index(info["relationId"]) == 0 else route["returnStops"]
                    info["pathEdges"] = len(path)
                    info["roadLengthMeters"] = round(sum(self.edges[leg["edge"]]["_length"] for leg in path) * METERS_PER_UNIT, 3)
                    info["stops"] = stops
                    info["maxStopDistanceMeters"] = max(stop["distanceToRoadMeters"] for stop in stops)
        edges = [{key: value for key, value in edge.items() if not key.startswith("_")} for edge in self.edges.values()]
        restrictions = []
        for node, rules in self.turn_rules.items():
            for rule in rules:
                from_edges = [eid for eid in self.way_edges[rule["fromWay"]] if node in (self.edges[eid]["_from"], self.edges[eid]["_to"])]
                to_edges = [eid for eid in self.way_edges[rule["toWay"]] if node in (self.edges[eid]["_from"], self.edges[eid]["_to"])]
                for incoming in from_edges:
                    for outgoing in to_edges:
                        if rule["kind"] in ("no_u_turn", "only_u_turn") and incoming != outgoing:
                            continue
                        restrictions.append({"from": incoming, "via": f"osm-{node}", "to": outgoing,
                                             "only": rule["kind"].startswith("only_"), "kind": rule["kind"], "osmRelationId": rule["osmRelationId"]})
        for number, route in routes.items():
            for path_key, stops_key in (("path", "stops"), ("returnPath", "returnStops")):
                path = route.get(path_key, [])
                for stop in route.get(stops_key, []):
                    index = stop.get("pathIndex")
                    if not isinstance(index, int) or not 0 <= index < len(path):
                        raise ValueError(f"Route {number}: stop {stop['name']} has no exact path occurrence")
                    leg = path[index]
                    if leg["edge"] != stop["edge"] or leg["reverse"] != stop["reverse"] or not 0 <= stop["at"] <= 1:
                        raise ValueError(f"Route {number}: stop {stop['name']} changed its sourced road attachment")
                    if "osmId" in stop:
                        source = self.raw_nodes[stop["osmId"]]
                        if source["lat"] != stop["lat"] or source["lon"] != stop["lon"]:
                            raise ValueError(f"Route {number}: stop GPS changed from its original OSM platform")
                    elif not stop.get("source2gisId") or not stop.get("sourceURL", "").startswith("https://2gis.ru/"):
                        raise ValueError(f"Route {number}: stop {stop['name']} lacks a verified GPS source")
            all_legs = [*route["path"], *route.get("returnPath", [])]
            for previous, following in zip(all_legs, [*all_legs[1:], all_legs[0]]):
                node = self.end(previous)
                if node != self.origin(following):
                    raise ValueError(f"Route {number} has a disconnected source-road transition")
                if not self.can_turn(previous["edge"], node, following["edge"]):
                    raise ValueError(f"Route {number} violates a sourced turn restriction at OSM node {node}")
        data = {"metersPerUnit": METERS_PER_UNIT, "nodes": list(self.nodes.values()), "edges": edges, "routes": routes,
                "restrictions": restrictions, "sourceRestrictions": self.source_restrictions,
                "metadata": {"source": "OpenStreetMap", "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
                             "licenseUrl": "https://www.openstreetmap.org/copyright", "sourceSnapshot": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
                             "projection": {"type": "local-equirectangular", "originLat": LAT0, "originLon": LON0, "radius": RADIUS,
                                            "xAxis": "east", "yAxis": "south", "metersPerUnit": METERS_PER_UNIT},
                             "osmBaseTimestamp": self.source.get("osmBaseTimestamp"), "relationIds": [rid for ids in ROUTES.values() for rid in ids],
                             "area": {"south": min(node["lat"] for node in self.nodes.values()), "west": min(node["lon"] for node in self.nodes.values()),
                                      "north": max(node["lat"] for node in self.nodes.values()), "east": max(node["lon"] for node in self.nodes.values())},
                             "coverage": (self.source.get("coverage") or {}).get("scope", "OSM transit corridors and adjacent real roads; not a claim that every city road or marking is mapped."),
                             "roadCoverage": self.source.get("coverage"),
                             "sourceRoadWays": len(self.ways),
                             "routeCorridorSnapshot": str(ROUTE_CACHE.relative_to(ROOT)).replace("\\", "/") if cache else None,
                             "incompleteBoundaryRestrictions": self.source.get("incompleteBoundaryRestrictions", []),
                             "roadMarkings": "Original OSM tags retained verbatim where present. Lane display and traffic remain arcade mechanics; missing markings are unknown, not inferred.",
                             "stopOrderSource": "geography/source/authoritative_stop_order.json",
                             "routeReconstruction": "Ordered OSM platforms, connected source roads; relation-member ways preferred. Added ways are audited separately."}}
        audit["counts"] = {"nodes": len(data["nodes"]), "edges": len(edges), "routes": len(routes),
                           "stops": sum(len(route["stops"]) + len(route.get("returnStops", [])) for route in routes.values()),
                           "restrictions": len(restrictions), "sourceRestrictionRelations": len(self.source_restrictions)}
        return data, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--prepare-source", nargs="+", type=Path)
    parser.add_argument("--rebuild-routes", action="store_true", help="Reconstruct routes from source platforms instead of re-splitting the pinned verified road corridors")
    parser.add_argument("--output", type=Path, default=ROOT / "js/city.js")
    parser.add_argument("--mirror", type=Path, default=ROOT / "web/js/city.js")
    parser.add_argument("--report", type=Path, default=ROOT / "test-results/geography/import-report.json")
    args = parser.parse_args()
    if args.prepare_source:
        documents = [json.loads(gzip.decompress(filename.read_bytes()) if filename.suffix == ".gz" else filename.read_bytes()) for filename in args.prepare_source]
        snapshot = {"source": "OpenStreetMap public API / Overpass", "license": "ODbL-1.0",
                    "osmBaseTimestamp": max((document.get("osm3s", {}).get("timestamp_osm_base", "") for document in documents), default=""),
                    "elements": merge_elements(documents)}
        snapshot["coverage"] = next((document["coverage"] for document in documents if document.get("coverage", {}).get("complete")),
                                    next((document["coverage"] for document in documents if "coverage" in document), None))
        snapshot["incompleteBoundaryRestrictions"] = list({item["id"]: item for document in documents
                                                          for item in document.get("incompleteBoundaryRestrictions", [])}.values())
        args.source.parent.mkdir(parents=True, exist_ok=True)
        args.source.write_bytes(gzip.compress(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0))
    source = json.loads(gzip.decompress(args.source.read_bytes()))
    cache = None
    if ROUTE_CACHE.exists() and not args.rebuild_routes:
        cache = json.loads(gzip.decompress(ROUTE_CACHE.read_bytes()))
        for field, filename in (("evidenceSha256", "authoritative_stop_order.json"), ("gpsSha256", "2gis_stop_platforms.json")):
            if cache[field] != hashlib.sha256((ROOT / "geography/source" / filename).read_bytes()).hexdigest():
                raise ValueError(f"Stop evidence {filename} changed; rebuild verified corridors explicitly")
    data, audit = RoadGraph(source).export(cache)
    if args.rebuild_routes or not ROUTE_CACHE.exists():
        used = {leg["edge"] for route in data["routes"].values() for leg in route["path"] + route.get("returnPath", [])}
        verified = {"description": "Verified source OSM way/node paths, re-split when additional original city-road junctions are imported.",
                    "evidenceSha256": hashlib.sha256((ROOT / "geography/source/authoritative_stop_order.json").read_bytes()).hexdigest(),
                    "gpsSha256": hashlib.sha256((ROOT / "geography/source/2gis_stop_platforms.json").read_bytes()).hexdigest(),
                    "routes": data["routes"], "edges": [{key: edge[key] for key in ("id", "osmWayIds", "osmNodeIds")} for edge in data["edges"] if edge["id"] in used],
                    "audit": audit}
        ROUTE_CACHE.write_bytes(gzip.compress(json.dumps(verified, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0))
    content = "// Generated by scripts/import_irkutsk_osm.py. © OpenStreetMap contributors, ODbL-1.0.\n\"use strict\";\nconst IRKUTSK_CITY = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    for filename in (args.output, args.mirror):
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(content, encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(audit["counts"], ensure_ascii=False))
    for route in audit["relations"]:
        print(f"relation {route['relationId']}: {len(route['stops'])} platforms, {route['pathEdges']} edges, {route['roadLengthMeters']}m; added ways {route['addedRoadWays']}; max platform offset {route['maxStopDistanceMeters']}m")


if __name__ == "__main__":
    main()
