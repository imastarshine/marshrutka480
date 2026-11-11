"""A single room-owned escort column travelling on connected legal roads."""
import heapq
import math
from collections import defaultdict


KINDS = ("police", "police", "limousine", "limousine", "limousine", "ambulance", "police")
SIZES = {"police": (52.0, 96.0), "limousine": (54.0, 132.0), "ambulance": (58.0, 110.0)}


class WorldMotorcade:
    def __init__(self, traffic, npc_factory):
        self.traffic = traffic
        self.npc_factory = npc_factory
        self.next_at = 90 + traffic.random.random() * 45
        self.retry_at = 0.0
        self.last_step = 0.0
        self.active = None
        self.last_event = None
        self.serial = 0
        self.route_next = {}
        if not hasattr(traffic.graph,"edge_indices"):
            traffic.graph.edge_indices = {edge.id: index for index, edge in enumerate(traffic.graph.edges)}
        self.edge_index = traffic.graph.edge_indices

    def choices(self, incoming):
        traffic, graph = self.traffic, self.traffic.graph
        node = graph.end_node(*incoming)
        ordinary = [outgoing for outgoing in graph.adjacent.get(node, ())
                if outgoing[0] != incoming[0] and graph.can_turn(incoming[0], node, outgoing[0])
                and (traffic._turn(incoming, outgoing) <= 0 or graph.lanes(*incoming) == 1)]
        if ordinary:
            return ordinary
        return [outgoing for outgoing in graph.adjacent.get(node, ())
                if outgoing[0] == incoming[0] and outgoing[1] != incoming[1]
                and graph.can_turn(incoming[0], node, outgoing[0])]

    def choose(self, incoming):
        if incoming not in self.route_next:
            choices = self.choices(incoming)
            if not choices:
                return None
            self.route_next[incoming] = min(choices, key=lambda option: abs(self.traffic._turn(incoming, option)))
        return self.route_next[incoming]

    def route_to(self, first, target, point):
        """Route a left-lane column without asking seven cars to swap lanes."""
        graph = self.traffic.graph
        frontier, best, previous = [(0.0, 0.0, first)], {first: 0.0}, {}
        found = None
        for _ in range(3000):
            if not frontier:
                break
            _, distance, incoming = heapq.heappop(frontier)
            if distance != best.get(incoming):
                continue
            if incoming[0] == target:
                found = incoming
                break
            if distance > 18000:
                continue
            for following in self.choices(incoming):
                road = graph.edges[following[0]]
                cost = distance + road.length
                if cost >= best.get(following, math.inf):
                    continue
                x, y = graph.nodes[graph.end_node(*following)][:2]
                best[following], previous[following] = cost, incoming
                heapq.heappush(frontier, (cost + math.hypot(x - point[0], y - point[1]), cost, following))
        if found is None:
            return None
        route = [found]
        while route[-1] in previous:
            route.append(previous[route[-1]])
        route.reverse()
        distance = sum(graph.edges[index].length for index, _ in route)
        seen = set(route)
        while distance < 24000 and len(route) < 128:
            incoming = route[-1]
            choices = [option for option in self.choices(incoming) if option not in seen]
            if not choices:
                break
            road = graph.edges[incoming[0]]
            _, _, dx, dy = graph.position(incoming[0], 0 if incoming[1] else road.length, incoming[1])
            def score(option):
                candidate = graph.edges[option[0]]
                _, _, tx, ty = graph.position(option[0], candidate.length if option[1] else 0, option[1])
                return dx * tx + dy * ty + (1 if candidate.street == road.street else 0)
            following = max(choices, key=score)
            route.append(following)
            seen.add(following)
            distance += graph.edges[following[0]].length
        return route

    def step(self):
        traffic, graph = self.traffic, self.traffic.graph
        elapsed = max(0.0, traffic.elapsed - self.last_step)
        self.last_step = traffic.elapsed
        if not traffic._poses and self.active is None:
            self.next_at += elapsed
            self.retry_at += elapsed
            return
        if self.active:
            alive = [traffic.npcs[nid] for nid in self.active["vehicles"] if nid in traffic.npcs]
            if not alive:
                self.last_event = {"id": self.active["id"], "outcome": "passed"}
                self.active = None
                self.next_at = traffic.elapsed + 600 + traffic.random.random() * 240
            elif traffic.elapsed - self.active["started"] > 240 and all(car.speed < 1 for car in alive):
                # A parked player can block a column. End its exclusive status
                # without deleting vehicles or teleporting them out of view.
                for car in alive:
                    car.convoy_id = None
                for reservation in traffic._reservations.values():
                    if reservation.convoy_id == self.active["id"]:
                        reservation.convoy_id = None
                self.last_event = {"id": self.active["id"], "outcome": "cancelled"}
                self.active = None
                self.next_at = traffic.elapsed + 600
            return
        if traffic.elapsed < max(self.next_at, self.retry_at) or not traffic._poses or len(traffic.npcs) + 7 > traffic.max_npcs:
            return
        self.retry_at = traffic.elapsed + 12
        occupied = defaultdict(list)
        for other in traffic.npcs.values():
            x, y, _, _ = traffic._body(other)
            occupied[(math.floor(x / 800), math.floor(y / 800))].append((x, y, other.h))
        indices = list({index for cell in traffic._active_cells for index, _, _ in graph.cells.get(cell, ())
                        if graph.edges[index].length > 2100 and graph.edges[index].base_lanes >= 4})
        traffic.random.shuffle(indices)
        attempts = 0
        for index in indices[:100]:
            road = graph.edges[index]
            head = min(road.length - 500, max(1500.0, road.length * .65))
            for reverse in (False, True):
                if road.oneway == 1 and reverse or road.oneway == -1 and not reverse:
                    continue
                offset = road.length - head if reverse else head
                x, y, dx, dy = graph.lane_position(index, offset, reverse, 37.0)
                if traffic._near_observer(x, y, 2200):
                    continue
                observer = min(traffic._poses, key=lambda pose: math.hypot(pose["wx"] - x, pose["wy"] - y))
                px, py = traffic._observer_point(observer)
                distance = math.hypot(px - x, py - y)
                if distance > 6500 or (px - x) * dx + (py - y) * dy < distance * .15:
                    continue
                target = self.edge_index.get(observer.get("edge"))
                if target is None:
                    continue
                if attempts >= 8:
                    return
                attempts += 1
                route = self.route_to((index, reverse), target, (px, py))
                if not route:
                    if attempts >= 8:
                        return
                    continue
                cars, progress, previous_length = [], head, 0.0
                for number, kind in enumerate(KINDS):
                    width, length = SIZES[kind]
                    if number:
                        progress -= previous_length / 2 + length / 2 + 65
                    previous_length = length
                    if progress < 160:
                        break
                    offset = road.length - progress if reverse else progress
                    cx, cy, _, _ = graph.lane_position(index, offset, reverse, 37.0)
                    bx, by = math.floor(cx / 800), math.floor(cy / 800)
                    if traffic._near_observer(cx, cy, 2200) or any(math.hypot(cx - ox, cy - oy) < (length + other_h) / 2 + 45
                                                               for gx in range(bx - 1, bx + 2) for gy in range(by - 1, by + 2)
                                                               for ox, oy, other_h in occupied.get((gx, gy), ())):
                        break
                    cruise = min(road.limit * .95, 650.0)
                    car = self.npc_factory(f"n{traffic.seed:x}-{traffic._next_id + number + 1:x}", index, reverse, offset, 0,
                                           cruise * .65, cruise, (22, 25, 30) if kind == "limousine" else (235, 238, 240),
                                           traffic.elapsed, lateral=37.0, planned_edges=list(route[1:]), kind=kind, w=width, h=length)
                    car.next_edge = car.planned_edges[0] if car.planned_edges else None
                    remaining = offset if reverse else road.length - offset
                    if any(control.controlled and ahead < control.center_stop + length
                           for _, ahead, control in traffic._approaches(car, remaining)):
                        break
                    if any(math.hypot(cx - traffic._body(other)[0], cy - traffic._body(other)[1]) < (length + other.h) / 2 + 25 for other in cars):
                        break
                    cars.append(car)
                if len(cars) != len(KINDS):
                    continue
                self.serial += 1
                self.route_next = dict(zip(route, route[1:]))
                convoy_id = f"escort-{traffic.seed:x}-{self.serial}"
                for car in cars:
                    car.convoy_id = convoy_id
                    traffic.npcs[car.id] = car
                traffic._next_id += len(cars)
                self.active = {"id": convoy_id, "vehicles": [car.id for car in cars], "started": traffic.elapsed}
                return

    def snapshot(self):
        if not self.active:
            return {"phase": "scheduled", "starts_in": max(0, round(self.next_at - self.traffic.elapsed)), "closed_nodes": [], "last_event": self.last_event}
        graph, traffic = self.traffic.graph, self.traffic
        closed = {}
        for reservation in traffic._reservations.values():
            if reservation.convoy_id != self.active["id"]:
                continue
            node = reservation.node
            if len(graph.incident[node]) < 3:
                continue
            width = max(graph.edges[index].base_lanes * 74 for index in graph.incident[node])
            closed[node] = {"node": node, "wx": reservation.x, "wy": reservation.y, "width": width,
                            "angle": math.atan2(reservation.direction[0], -reservation.direction[1]),
                            "layer": min(graph.edges[index].layer for index in graph.incident[node])}
        return {"id": self.active["id"], "phase": "passing", "vehicles": self.active["vehicles"],
                "closed_nodes": list(closed.values())}
