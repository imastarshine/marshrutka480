"""Export compact server-only traffic geometry from the generated OSM city.

python scripts/export_traffic_graph.py
No network or game execution. The server never parses the large browser asset.
"""
import argparse
import gzip
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def number(tags, key, default):
    match = re.match(r"^\s*(\d+(?:\.\d+)?)", str(tags.get(key, "")))
    return float(match[1]) if match else default


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "js/city.js")
    parser.add_argument("--output", type=Path, default=ROOT / "server/assets/irkutsk-traffic.json.gz")
    args = parser.parse_args()
    text = args.source.read_text(encoding="utf-8")
    city = json.loads(text.split("const IRKUTSK_CITY = ", 1)[1].rsplit(";", 1)[0])
    node_indices = {node["id"]: index for index, node in enumerate(city["nodes"])}
    way_members = {}
    names = sorted({edge["street"] for edge in city["edges"]})
    name_indices = {name: index for index, name in enumerate(names)}
    nodes = []
    for node in city["nodes"]:
        tags = node.get("osmTags", {})
        nodes.append([node["x"], node["y"], bool(tags.get("highway") == "traffic_signals" or node.get("junction"))])
    edges = []
    for index, edge in enumerate(city["edges"]):
        tags = edge.get("osmTags", {})
        car_allowed = not any(tags.get(key) in ("no", "private") for key in ("access", "vehicle", "motor_vehicle", "motorcar"))
        if tags.get("motorcar") in ("yes", "designated", "permissive"):
            car_allowed = True
        oneway = edge.get("oneway", 0)
        lanes = max(1, round(number(tags, "lanes", edge.get("lanes", 2))))
        # The arcade renderer retains a six-slot cross-section and opens half
        # of edge.lanes in the travel direction, including one-way roads. Keep
        # NPCs inside that rendered carriageway; exact OSM lane tags remain in
        # the browser/source dataset rather than pretending this is a lane sim.
        visible_lanes = max(1, min(3, edge.get("lanes", 2) // 2))
        forward = min(visible_lanes, max(1, round(number(tags, "lanes:forward", lanes if oneway else lanes / 2))))
        backward = min(visible_lanes, max(1, round(number(tags, "lanes:backward", lanes if oneway else lanes / 2))))
        speed_mps = number(tags, "maxspeed", 50) / 3.6
        points = [round(coordinate, 3) for point in edge["geometry"] for coordinate in point]
        way_id = edge["osmWayIds"][0]
        way_members.setdefault(way_id, []).append(index)
        edges.append([edge["id"], node_indices[edge["from"]], node_indices[edge["to"]], points,
                      oneway, forward, backward, round(speed_mps, 3), car_allowed, way_id, name_indices[edge["street"]]])
    restrictions = []
    for relation in city.get("sourceRestrictions", []):
        tags = relation.get("tags", {})
        if set(tags.get("except", "").split(";")) & {"motorcar", "motor_vehicle", "vehicle"}:
            continue
        kind = tags.get("restriction:motorcar", tags.get("restriction:motor_vehicle", tags.get("restriction", "")))
        via = [member["ref"] for member in relation["members"] if member["role"] == "via" and member["type"] == "node"]
        from_ways = [member["ref"] for member in relation["members"] if member["role"] == "from" and member["type"] == "way"]
        to_ways = [member["ref"] for member in relation["members"] if member["role"] == "to" and member["type"] == "way"]
        if len(via) != 1 or f"osm-{via[0]}" not in node_indices or not kind.startswith(("no_", "only_")):
            continue
        for from_way in from_ways:
            for to_way in to_ways:
                restrictions.append([node_indices[f"osm-{via[0]}"], from_way, to_way,
                                     kind.startswith("only_"), kind in ("no_u_turn", "only_u_turn")])
    output = {"version": 1, "metersPerUnit": city["metersPerUnit"], "nodes": nodes, "edges": edges,
              "streets": names, "restrictions": restrictions,
              "source": "OpenStreetMap", "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(gzip.compress(json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0))
    print(f"Traffic graph: {len(nodes)} nodes, {len(edges)} edges, {len(restrictions)} car turn rules, {args.output.stat().st_size} bytes gzip")


if __name__ == "__main__":
    main()
