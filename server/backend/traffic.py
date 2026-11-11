"""One authoritative NPC traffic state per city, on the pinned OSM road graph.

The immutable compact graph is shared by all rooms. Physics runs on the server;
clients only interpolate poses. Active road cells are the union around players,
so overlapping recipients always see the same NPC identities and positions.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
import gzip
import json
import math
from pathlib import Path
import random
import time

CELL = 4000.0
VIEW_RADIUS = 2000.0
LANE_WIDTH = 74.0
CAR_WIDTH, CAR_LENGTH = 50.0, 92.0
MAX_NPCS = 2048  # Simulation budget, independent from the player population.
COLORS = ((200, 40, 40), (40, 90, 200), (30, 140, 60), (120, 120, 130),
          (230, 230, 230), (35, 35, 40), (150, 60, 160), (220, 120, 30))
VISIBLE_STATES = {"play", "turning", "pause", "dialog", "caught", "escort", "station", "boom", "offer"}


def _hash(a, b, c):
    mask = 0xffffffff
    value = (a * 374761393 + b * 668265263 + c * 1274126177) & mask
    value = ((value ^ (value >> 13)) * 1274126177) & mask
    return ((value ^ (value >> 16)) & mask) / 4294967296


@dataclass(slots=True)
class Edge:
    id: str
    start: int
    end: int
    points: list
    distances: list
    length: float
    oneway: int
    forward_lanes: int
    backward_lanes: int
    limit: float
    allowed: bool
    way: int
    street: int


class TrafficGraph:
    def __init__(self, document):
        self.meters_per_unit = document["metersPerUnit"]
        self.nodes = document["nodes"]
        self.edges = []
        self.adjacent = defaultdict(list)
        self.incident = defaultdict(set)
        self.cells = defaultdict(list)
        self.rules = defaultdict(list)
        for via, from_way, to_way, only, uturn in document["restrictions"]:
            self.rules[(via, from_way)].append((to_way, only, uturn))
        for index, raw in enumerate(document["edges"]):
            eid, start, end, points, oneway, forward, backward, limit, allowed, way, street = raw
            distances = [0.0]
            for point in range(2, len(points), 2):
                distances.append(distances[-1] + math.hypot(points[point] - points[point - 2], points[point + 1] - points[point - 1]))
            edge = Edge(eid, start, end, points, distances, distances[-1], oneway,
                        forward, backward, limit / self.meters_per_unit, allowed, way, street)
            self.edges.append(edge)
            self.incident[start].add(index)
            self.incident[end].add(index)
            if not allowed:
                continue
            if oneway != -1:
                self.adjacent[start].append((index, False))
            if oneway != 1:
                self.adjacent[end].append((index, True))
            # Store actual arclength intervals inside cells, rather than a
            # bounding box that could spawn a car on another part of a curve.
            intervals = defaultdict(list)
            for point in range(1, len(distances)):
                begin, end_offset = distances[point - 1], distances[point]
                pieces = max(1, math.ceil((end_offset - begin) / (CELL / 2)))
                for piece in range(pieces):
                    low = begin + (end_offset - begin) * piece / pieces
                    high = begin + (end_offset - begin) * (piece + 1) / pieces
                    x, y, _, _ = self.position(index, (low + high) / 2, False)
                    key = (math.floor(x / CELL), math.floor(y / CELL))
                    values = intervals[key]
                    if values and abs(values[-1][1] - low) < .001:
                        values[-1] = (values[-1][0], high)
                    else:
                        values.append((low, high))
            for cell, ranges in intervals.items():
                self.cells[cell].extend((index, low, high) for low, high in ranges if high - low > 50)

    def position(self, index, offset, reverse):
        edge = self.edges[index]
        offset = min(edge.length, max(0.0, offset))
        segment = max(0, min(len(edge.distances) - 2, bisect_right(edge.distances, offset) - 1))
        while segment > 0 and edge.distances[segment + 1] <= edge.distances[segment]:
            segment -= 1
        start, end = edge.distances[segment], edge.distances[segment + 1]
        point = segment * 2
        ax, ay, bx, by = edge.points[point:point + 4]
        length = end - start
        fraction = (offset - start) / length if length else 0
        sign = -1 if reverse else 1
        dx, dy = ((bx - ax) / length * sign, (by - ay) / length * sign) if length else (0.0, -float(sign))
        return ax + (bx - ax) * fraction, ay + (by - ay) * fraction, dx, dy

    def end_node(self, index, reverse):
        edge = self.edges[index]
        return edge.start if reverse else edge.end

    def lanes(self, index, reverse):
        edge = self.edges[index]
        return edge.backward_lanes if reverse else edge.forward_lanes

    def can_turn(self, incoming, via, outgoing):
        rules = self.rules.get((via, self.edges[incoming].way), ())
        target = self.edges[outgoing].way
        only = [rule for rule in rules if rule[1]]
        def matches(rule):
            return rule[0] == target and (not rule[2] or incoming == outgoing)
        return (not only or any(matches(rule) for rule in only)) and not any(matches(rule) for rule in rules if not rule[1])

    def red(self, node, dx, dy, seed, world_frame):
        # Same node indices, integer hash and 650-frame cycle as the browser.
        # The current arcade draws lights at branch intersections; source
        # signal tags are also retained for a future stricter signal renderer.
        if len(self.incident.get(node, ())) < 3 and not self.nodes[node][2]:
            return False
        phase = (world_frame + math.floor(_hash(node, node * 7, seed) * 650)
                 + (0 if abs(dy) >= abs(dx) else 370)) % 650
        return phase >= 300


@lru_cache(maxsize=1)
def load_graph():
    """Can be warmed with await asyncio.to_thread(load_graph) at startup."""
    filename = Path(__file__).resolve().parents[1] / "assets/irkutsk-traffic.json.gz"
    with gzip.open(filename, "rt", encoding="utf-8") as source:
        return TrafficGraph(json.load(source))


@dataclass(slots=True)
class NPC:
    id: str
    edge: int
    reverse: bool
    offset: float
    lane: int
    speed: float
    cruise: float
    color: tuple
    last_active: float
    lateral: float = LANE_WIDTH / 2
    braking: bool = False
    next_edge: tuple | None = None
    planned_edges: list = field(default_factory=list)


class SharedTraffic:
    version = 1

    def __init__(self, seed, *, max_npcs=MAX_NPCS):
        self.graph = load_graph()
        self.seed = int(seed)
        self.random = random.Random(self.seed)
        self.max_npcs = max(0, int(max_npcs))
        self.npcs = {}
        self.elapsed = 0.0
        self._next_id = 0
        self._activation_at = 0.0
        self._active_cells = set()
        self._poses = []
        self._snapshot_cells = defaultdict(list)
        self._occupancy = defaultdict(list)
        self._observer_cells = defaultdict(dict)

    @staticmethod
    def _player_pose(player):
        if player is None:
            return None
        if not isinstance(player, dict) and not getattr(player, "connected", True):
            return None
        pose = player.get("pose", player) if isinstance(player, dict) else getattr(player, "pose", None)
        if not pose or pose.get("state") not in VISIBLE_STATES:
            return None
        if not all(isinstance(pose.get(key), (int, float)) and math.isfinite(pose[key]) for key in ("wx", "wy")):
            return None
        return pose

    def _cell(self, x, y):
        return math.floor(x / CELL), math.floor(y / CELL)

    def _choose_exit(self, npc):
        return self._choose_from(npc.edge, npc.reverse)

    def _choose_from(self, incoming_id, incoming_reverse):
        graph = self.graph
        node = graph.end_node(incoming_id, incoming_reverse)
        options = [(edge, reverse) for edge, reverse in graph.adjacent.get(node, ())
                   if graph.can_turn(incoming_id, node, edge)]
        forward = [option for option in options if option[0] != incoming_id]
        if forward:
            options = forward
        if not options:
            return None
        incoming = graph.edges[incoming_id]
        _, _, dx, dy = graph.position(incoming_id, 0 if incoming_reverse else incoming.length, incoming_reverse)
        weights = []
        for edge_id, reverse in options:
            edge = graph.edges[edge_id]
            _, _, tx, ty = graph.position(edge_id, edge.length if reverse else 0, reverse)
            straight = max(0.0, dx * tx + dy * ty)
            weights.append(1 + straight * 3 + (3 if edge.street == incoming.street else 0))
        return self.random.choices(options, weights=weights, k=1)[0]

    def _plan_ahead(self, npc, remaining):
        if not npc.planned_edges and npc.next_edge:
            npc.planned_edges.append(npc.next_edge)
        distance = remaining + sum(self.graph.edges[edge].length for edge, _ in npc.planned_edges)
        while distance < 1200 and len(npc.planned_edges) < 24:
            previous = npc.planned_edges[-1] if npc.planned_edges else (npc.edge, npc.reverse)
            following = self._choose_from(*previous)
            if following is None:
                break
            npc.planned_edges.append(following)
            distance += self.graph.edges[following[0]].length
        npc.next_edge = npc.planned_edges[0] if npc.planned_edges else None

    def _pose(self, npc):
        x, y, dx, dy = self.graph.position(npc.edge, npc.offset, npc.reverse)
        return {"id": npc.id, "wx": round(x, 3), "wy": round(y, 3),
                "angle": round(math.atan2(dx, -dy), 6), "lateral": round(npc.lateral, 3),
                "speed": round(npc.speed / 60, 3), "color": npc.color, "braking": npc.braking,
                "w": CAR_WIDTH, "h": CAR_LENGTH, "edge": self.graph.edges[npc.edge].id, "reverse": npc.reverse}

    def _spawn(self, cell, counts):
        ranges = self.graph.cells.get(cell, ())
        if not ranges or len(self.npcs) >= self.max_npcs:
            return False
        for _ in range(12):
            edge_id, low, high = self.random.choice(ranges)
            edge = self.graph.edges[edge_id]
            low, high = max(low, 160), min(high, edge.length - 160)
            if high <= low:
                continue
            offset = self.random.uniform(low, high)
            reverse = edge.oneway == -1 or edge.oneway == 0 and self.random.random() < .5
            lane = self.random.randrange(self.graph.lanes(edge_id, reverse))
            x, y, _, _ = self.graph.position(edge_id, offset, reverse)
            # Spawn outside every observer's road scene, without a separate
            # random stream or separate car population for each observer.
            cx, cy = math.floor(x / 1200), math.floor(y / 1200)
            if any(math.hypot(x - px, y - py) < 1300 for bx in range(cx - 2, cx + 3) for by in range(cy - 2, cy + 3)
                   for px, py in self._observer_cells.get((bx, by), {}).values()):
                continue
            if any(abs(previous - offset) < 240 for previous in self._occupancy[(edge_id, reverse, lane)]):
                continue
            self._next_id += 1
            cruise = min(edge.limit * self.random.uniform(.68, .9), 16 / self.graph.meters_per_unit)
            npc = NPC(f"n{self.seed:x}-{self._next_id:x}", edge_id, reverse, offset, lane,
                      cruise * .7, cruise, self.random.choice(COLORS), self.elapsed,
                      lateral=LANE_WIDTH * (lane + .5))
            npc.next_edge = self._choose_exit(npc)
            self.npcs[npc.id] = npc
            counts[cell] += 1
            self._occupancy[(edge_id, reverse, lane)].append(offset)
            return True
        return False

    def _activate(self):
        active = set()
        self._observer_cells.clear()
        for pose in self._poses:
            x, y = pose["wx"], pose["wy"]
            self._observer_cells[(math.floor(x / 1200), math.floor(y / 1200))][(round(x / 100), round(y / 100))] = (x, y)
            cx, cy = self._cell(pose["wx"], pose["wy"])
            for x in range(cx - 1, cx + 2):
                for y in range(cy - 1, cy + 2):
                    if (x, y) in self.graph.cells:
                        active.add((x, y))
        self._active_cells = active
        counts = defaultdict(int)
        self._occupancy.clear()
        for npc in self.npcs.values():
            x, y, _, _ = self.graph.position(npc.edge, npc.offset, npc.reverse)
            counts[self._cell(x, y)] += 1
            self._occupancy[(npc.edge, npc.reverse, npc.lane)].append(npc.offset)
        budget = min(32, self.max_npcs - len(self.npcs))
        cells = sorted(active)
        self.random.shuffle(cells)
        for cell in cells:
            target = min(8, max(2, len(self.graph.cells[cell]) // 3))
            while counts[cell] < target and budget > 0:
                if not self._spawn(cell, counts):
                    break
                budget -= 1
            if budget <= 0:
                break

    def step(self, dt, players):
        dt = min(.25, max(0.0, float(dt)))
        self.elapsed += dt
        self._poses = [pose for player in players if (pose := self._player_pose(player))]
        if self.elapsed >= self._activation_at:
            self._activate()
            self._activation_at = self.elapsed + .5
        groups = defaultdict(list)
        for npc in self.npcs.values():
            length = self.graph.edges[npc.edge].length
            progress = length - npc.offset if npc.reverse else npc.offset
            # A merging body occupies both lanes until it clears their border.
            # Queue membership follows its physical lateral position, rather
            # than treating the old lane number as an invisible reservation.
            for lane in range(self.graph.lanes(npc.edge, npc.reverse)):
                if abs(npc.lateral - LANE_WIDTH * (lane + .5)) < 62:
                    groups[(npc.edge, npc.reverse, lane)].append((progress, npc))
        leaders = {}
        first_in_lane = {}
        for key, group in groups.items():
            group.sort(key=lambda item: item[0])
            first_in_lane[key] = group[0]
            for index in range(len(group) - 1):
                npc_id = group[index][1].id
                if npc_id not in leaders or group[index + 1][0] < leaders[npc_id][0]:
                    leaders[npc_id] = group[index + 1]
        obstacles = defaultdict(dict)
        for pose in self._poses:
            angle = pose.get("angle", 0)
            lateral = pose.get("lateral", 0)
            x = pose["wx"] + math.cos(angle) * lateral
            y = pose["wy"] + math.sin(angle) * lateral
            # Coalesce overlapping accepted bus poses for traffic avoidance;
            # this bounds work in a crowd without limiting the player count.
            obstacles[(math.floor(x / 800), math.floor(y / 800))][(round(x / 100), round(y / 100))] = (x, y)
        remove = []
        world_frame = math.floor(time.time() * 60)
        acceleration = 3.0 / self.graph.meters_per_unit
        braking = 7.0 / self.graph.meters_per_unit
        for npc in self.npcs.values():
            edge = self.graph.edges[npc.edge]
            remaining = npc.offset if npc.reverse else edge.length - npc.offset
            self._plan_ahead(npc, remaining)
            target_lateral = LANE_WIDTH * (npc.lane + .5)
            distance_ahead = remaining
            for next_id, next_reverse in npc.planned_edges:
                if distance_ahead >= 1200:
                    break
                next_lane = min(npc.lane, self.graph.lanes(next_id, next_reverse) - 1)
                target_lateral = min(target_lateral, LANE_WIDTH * (next_lane + .5))
                distance_ahead += self.graph.edges[next_id].length
            npc.lateral += max(-80 * dt, min(80 * dt, target_lateral - npc.lateral))
            x, y, dx, dy = self.graph.position(npc.edge, npc.offset, npc.reverse)
            if self._cell(x, y) in self._active_cells:
                npc.last_active = self.elapsed
            elif self.elapsed - npc.last_active > 15:
                remove.append(npc.id)
                continue
            target = min(npc.cruise, edge.limit * .9)
            max_move = math.inf
            leader = leaders.get(npc.id)
            progress = edge.length - npc.offset if npc.reverse else npc.offset
            if leader:
                gap = leader[0] - progress - CAR_LENGTH
                target = min(target, max(0, leader[1].speed + (gap - 160) * 1.2))
                max_move = max(0, gap - 45)
            if npc.next_edge is None:
                npc.next_edge = self._choose_exit(npc)
            if npc.next_edge:
                next_id, next_reverse = npc.next_edge
                physical_lane = max(0, round(npc.lateral / LANE_WIDTH - .5))
                next_lane = min(physical_lane, self.graph.lanes(next_id, next_reverse) - 1)
                next_leader = first_in_lane.get((next_id, next_reverse, next_lane))
                if next_leader:
                    gap = remaining + next_leader[0] - CAR_LENGTH
                    target = min(target, max(0, next_leader[1].speed + (gap - 160) * 1.2))
                    max_move = min(max_move, max(0, gap - 45))
            else:
                target = min(target, math.sqrt(2 * braking * max(0, remaining - 70)))
                max_move = min(max_move, max(0, remaining - 70))
            node = self.graph.end_node(npc.edge, npc.reverse)
            if self.graph.red(node, dx, dy, self.seed, world_frame) and remaining > 55:
                room = max(0, remaining - 70)
                target = min(target, math.sqrt(2 * braking * room))
                max_move = min(max_move, room)
            lateral = npc.lateral
            px, py = x - dy * lateral, y + dx * lateral
            bx, by = math.floor(px / 800), math.floor(py / 800)
            for cx in range(bx - 1, bx + 2):
                for cy in range(by - 1, by + 2):
                    for ox, oy in obstacles.get((cx, cy), {}).values():
                        forward = (ox - px) * dx + (oy - py) * dy
                        side = abs(-(ox - px) * dy + (oy - py) * dx)
                        if 0 <= forward < 1200 and side < 70:
                            gap = max(0, forward - 180)
                            target = min(target, math.sqrt(2 * braking * gap))
                            max_move = min(max_move, gap)
            previous_speed = npc.speed
            if target < npc.speed:
                npc.speed = max(target, npc.speed - braking * dt)
            else:
                npc.speed = min(target, npc.speed + acceleration * dt)
            npc.braking = npc.speed + .05 < previous_speed or target < npc.cruise * .6
            distance = min(npc.speed * dt, max_move)
            if distance < npc.speed * dt:
                npc.speed = distance / dt if dt else 0
            transitions = 0
            while distance > 0 and transitions < 32:
                edge = self.graph.edges[npc.edge]
                remaining = npc.offset if npc.reverse else edge.length - npc.offset
                moved = min(distance, remaining)
                npc.offset += -moved if npc.reverse else moved
                distance -= moved
                if distance <= 0:
                    break
                if not npc.next_edge:
                    npc.speed = 0
                    break
                npc.edge, npc.reverse = npc.next_edge
                if npc.planned_edges and npc.planned_edges[0] == npc.next_edge:
                    npc.planned_edges.pop(0)
                edge = self.graph.edges[npc.edge]
                npc.offset = edge.length if npc.reverse else 0.0
                npc.lane = min(npc.lane, self.graph.lanes(npc.edge, npc.reverse) - 1)
                npc.next_edge = npc.planned_edges[0] if npc.planned_edges else self._choose_exit(npc)
                transitions += 1
        for npc_id in remove:
            self.npcs.pop(npc_id, None)
        self._snapshot_cells.clear()
        for npc in self.npcs.values():
            pose = self._pose(npc)
            self._snapshot_cells[self._cell(pose["wx"], pose["wy"])].append(pose)

    def snapshot_for(self, player):
        pose = self._player_pose(player)
        if pose is None:
            return []
        x, y = pose["wx"], pose["wy"]
        cx, cy = self._cell(x, y)
        return [npc for bx in range(cx - 1, cx + 2) for by in range(cy - 1, cy + 2)
                for npc in self._snapshot_cells.get((bx, by), ())
                if math.hypot(npc["wx"] - x, npc["wy"] - y) <= VIEW_RADIUS + 200]
