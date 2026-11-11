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
import heapq
import json
import math
from pathlib import Path
import random
import time

CELL = 4000.0
SNAPSHOT_INNER, SNAPSHOT_OUTER = 3000.0, 3800.0
SPAWN_GUARD, DELETE_GUARD = 2200.0, 5000.0
LANE_WIDTH = 74.0
CAR_WIDTH, CAR_LENGTH = 50.0, 92.0
STOP_LINE_GAP, BUMPER_GAP = 34.0, 6.0
LOOKAHEAD = 1200.0
SIGNAL_CYCLE, SIGNAL_GREEN, SIGNAL_HALF = 650, 290, 325
MAX_NPCS = 2048  # Simulation budget, independent from the player population.
COLORS = ((200, 40, 40), (40, 90, 200), (30, 140, 60), (120, 120, 130),
          (230, 230, 230), (35, 35, 40), (150, 60, 160), (220, 120, 30))
VISIBLE_STATES = {"play", "turning", "pause", "dialog", "caught", "escort", "station", "boom", "offer"}


def _hash(a, b, c):
    mask = 0xffffffff
    value = (a * 374761393 + b * 668265263 + c * 1274126177) & mask
    value = ((value ^ (value >> 13)) * 1274126177) & mask
    return ((value ^ (value >> 16)) & mask) / 4294967296


def _direction_applies(tags, feature, reverse, dx, dy):
    direction = str(tags.get(f"{feature}:direction", tags.get("direction", "both"))).strip()
    if direction in ("forward", "backward"):
        return (direction == "backward") == reverse
    if direction == "both":
        return True
    compass = {"N": 0, "NE": 45, "E": 90, "SE": 135, "S": 180, "SW": 225, "W": 270, "NW": 315}
    try:
        bearing = compass[direction.upper()] if direction.upper() in compass else float(direction)
    except ValueError:
        return False
    angle = math.radians(bearing)
    # Numeric/cardinal OSM direction is where the physical sign faces.
    return math.sin(angle) * dx - math.cos(angle) * dy < -.5


def _road_layer(tags):
    if "layer" in tags:
        try:
            layer = float(tags["layer"])
            if math.isfinite(layer):
                return layer
        except (TypeError, ValueError):
            pass
    return int(bool(tags.get("bridge")) and tags["bridge"] != "no") - int(bool(tags.get("tunnel")) and tags["tunnel"] != "no")


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
    base_lanes: int
    tags: dict
    layer: float


@dataclass(frozen=True, slots=True)
class Junction:
    node: int
    controlled: bool
    cross_width: float
    stop_line: float
    center_stop: float
    vertical: bool
    signal: bool
    stop: bool
    give_way: bool
    priority: int
    signal_group: int
    signal_vertical: bool


@dataclass(slots=True)
class Connector:
    outgoing: tuple
    out_offset: float
    out_lane: int
    out_lateral: float
    in_cut: float
    points: list
    distances: list
    length: float
    controls: tuple

    def position(self, distance):
        distance = min(self.length, max(0.0, distance))
        index = min(len(self.distances) - 2, max(0, bisect_right(self.distances, distance) - 1))
        length = self.distances[index + 1] - self.distances[index]
        fraction = (distance - self.distances[index]) / length if length else 0.0
        t = (index + fraction) / (len(self.points) - 1)
        a, b, c, d = self.controls
        s = 1 - t
        x = s ** 3 * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c[0] + t ** 3 * d[0]
        y = s ** 3 * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c[1] + t ** 3 * d[1]
        dx = 3 * s * s * (b[0] - a[0]) + 6 * s * t * (c[0] - b[0]) + 3 * t * t * (d[0] - c[0])
        dy = 3 * s * s * (b[1] - a[1]) + 6 * s * t * (c[1] - b[1]) + 3 * t * t * (d[1] - c[1])
        norm = math.hypot(dx, dy) or 1.0
        return x, y, dx / norm, dy / norm


@dataclass(slots=True)
class Reservation:
    node: int
    x: float
    y: float
    radius: float
    remaining: float


class TrafficGraph:
    def __init__(self, document):
        self.meters_per_unit = document["metersPerUnit"]
        self.nodes = document["nodes"]
        self.edges = []
        self.edge_layers = {}
        self.adjacent = defaultdict(list)
        self.incident = defaultdict(set)
        self.cells = defaultdict(list)
        self.rules = defaultdict(list)
        self.junctions = {}
        self.turns = {}
        self.local_connections = {}
        for via, from_way, to_way, only, uturn in document["restrictions"]:
            self.rules[(via, from_way)].append((to_way, only, uturn))
        for index, raw in enumerate(document["edges"]):
            eid, start, end, points, oneway, forward, backward, limit, allowed, way, street = raw[:11]
            base_lanes = raw[11] if len(raw) > 11 else max(forward, backward) * 2
            tags = raw[12] if len(raw) > 12 else {}
            distances = [0.0]
            for point in range(2, len(points), 2):
                distances.append(distances[-1] + math.hypot(points[point] - points[point - 2], points[point + 1] - points[point - 1]))
            edge = Edge(eid, start, end, points, distances, distances[-1], oneway,
                        forward, backward, limit / self.meters_per_unit, allowed, way, street, base_lanes, tags, _road_layer(tags))
            self.edges.append(edge)
            self.edge_layers[eid] = edge.layer
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

    def lane_position(self, index, offset, reverse, lateral):
        """Continuous body point through source polyline vertices."""
        edge = self.edges[index]
        x, y, _, _ = self.position(index, offset, reverse)
        ax, ay, _, _ = self.position(index, max(0, offset - 60), False)
        bx, by, _, _ = self.position(index, min(edge.length, offset + 60), False)
        length = math.hypot(bx - ax, by - ay)
        sign = -1 if reverse else 1
        if length:
            dx, dy = (bx - ax) / length * sign, (by - ay) / length * sign
        else:
            _, _, dx, dy = self.position(index, offset, reverse)
        return x - dy * lateral, y + dx * lateral, dx, dy

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

    def nearby_connected(self, start, end, limit):
        """Nearby GPS does not connect a bridge to the road underneath it."""
        if start == end:
            return True
        key = (min(start, end), max(start, end), math.ceil(limit / 100))
        if key in self.local_connections:
            return self.local_connections[key]
        limit = key[2] * 100.0
        queue, distances = [(0.0, start)], {start: 0.0}
        found = False
        while queue:
            distance, node = heapq.heappop(queue)
            if distance != distances[node]:
                continue
            if node == end:
                found = True
                break
            for index in self.incident.get(node, ()):
                edge = self.edges[index]
                other = edge.end if edge.start == node else edge.start
                total = distance + edge.length
                if total <= limit and total < distances.get(other, math.inf):
                    distances[other] = total
                    heapq.heappush(queue, (total, other))
        if len(self.local_connections) >= 32768:
            self.local_connections.clear()
        self.local_connections[key] = found
        return found

    def junction(self, index, reverse):
        key = (index, reverse)
        if key in self.junctions:
            return self.junctions[key]
        edge = self.edges[index]
        node = self.end_node(index, reverse)
        _, _, dx, dy = self.position(index, 0 if reverse else edge.length, reverse)
        cross_lanes = 0
        for neighbor in self.incident.get(node, ()):
            if neighbor == index:
                continue
            other = self.edges[neighbor]
            outward_reverse = other.end == node
            _, _, tx, ty = self.position(neighbor, other.length if outward_reverse else 0, outward_reverse)
            if abs(dx * ty - dy * tx) > .35:
                cross_lanes = max(cross_lanes, other.base_lanes)
        width = LANE_WIDTH * cross_lanes if cross_lanes else 148.0
        tags = self.nodes[node][3] if len(self.nodes[node]) > 3 else {}
        signal = tags.get("highway") == "traffic_signals" and _direction_applies(tags, "traffic_signals", reverse, dx, dy)
        stop = tags.get("highway") == "stop" and _direction_applies(tags, "stop", reverse, dx, dy)
        give_way = tags.get("highway") == "give_way" and _direction_applies(tags, "give_way", reverse, dx, dy)
        main_road_sign = any(sign.strip() in ("RU:2.1", "2.1") for sign in edge.tags.get("traffic_sign", "").split(";"))
        priority = 1 if edge.tags.get("priority_road") in ("yes", "designated") or main_road_sign else 0
        if edge.tags.get("junction") == "roundabout":
            priority = 2
        if stop or give_way:
            priority = -1
        controlled = len(self.incident.get(node, ())) >= 3 or signal or stop or give_way
        group, group_dx, group_dy = node, dx, dy
        if signal and len(self.incident.get(node, ())) == 2:
            walked, previous, current, visited = 0.0, index, node, {index}
            while len(self.incident.get(current, ())) == 2:
                options = [neighbor for neighbor in self.incident[current] if neighbor != previous]
                if len(options) != 1 or options[0] in visited:
                    break
                previous = options[0]
                visited.add(previous)
                following = self.edges[previous]
                walked += following.length
                if walked > 600:
                    break
                following_reverse = following.end == current
                current = self.end_node(previous, following_reverse)
                if len(self.incident.get(current, ())) >= 3:
                    group = current
                    _, _, group_dx, group_dy = self.position(previous, 0 if following_reverse else following.length, following_reverse)
                    break
        junction = Junction(node, controlled, width, width / 2 + STOP_LINE_GAP,
                            width / 2 + STOP_LINE_GAP + CAR_LENGTH / 2 + BUMPER_GAP,
                            abs(dy) >= abs(dx), signal, stop, give_way, priority,
                            group, abs(group_dy) >= abs(group_dx))
        self.junctions[key] = junction
        return junction

    def red(self, junction, seed, world_frame):
        # Same source group, hash and synthetic phase as the browser. Each half
        # has 290 green +25 yellow +10 all-red frames; no conflicting greens.
        # Source signal nodes only. An ordinary OSM branch is not a traffic light.
        if not junction.signal:
            return False
        phase = (world_frame + math.floor(_hash(junction.signal_group, junction.signal_group * 7, seed) * SIGNAL_CYCLE)
                 + (0 if junction.signal_vertical else SIGNAL_HALF)) % SIGNAL_CYCLE
        return phase >= SIGNAL_GREEN


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
    history_edges: list = field(default_factory=list)
    lane_wait: float = 0.0
    junction_clearance: float = 0.0
    connector: Connector | None = None
    connector_distance: float = 0.0
    stop_node: int | None = None
    stop_wait: float = 0.0
    gate_wait: float = 0.0
    heading: float | None = None
    yield_pending: bool = False
    signal_clearance_group: int | None = None


class SharedTraffic:
    version = 2

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
        self._reservations = {}
        self._reservation_cells = defaultdict(set)
        self._gate_requests = {}
        self._snapshot_members = {}
        self._snapshot_seen = {}

    def _body(self, npc):
        if npc.connector:
            return npc.connector.position(npc.connector_distance)
        return self.graph.lane_position(npc.edge, npc.offset, npc.reverse, npc.lateral)

    def _connector_cuts(self, incoming, outgoing):
        edge, other = self.graph.edges[incoming[0]], self.graph.edges[outgoing[0]]
        junction = self.graph.junction(*incoming)
        cut_in = min(edge.length * .45, max(16.0, junction.cross_width / 2 + 16.0))
        cut_out = min(other.length * .45, max(16.0, edge.base_lanes * LANE_WIDTH / 2 + 16.0))
        return cut_in, cut_out

    def _make_connector(self, npc):
        incoming, outgoing = (npc.edge, npc.reverse), npc.next_edge
        if outgoing is None:
            return None
        edge, other = self.graph.edges[npc.edge], self.graph.edges[outgoing[0]]
        cut_in, cut_out = self._connector_cuts(incoming, outgoing)
        start_offset = cut_in if npc.reverse else edge.length - cut_in
        out_offset = other.length - cut_out if outgoing[1] else cut_out
        lane = self._exit_lane(npc.lane, incoming, outgoing)
        lateral = LANE_WIDTH * (lane + .5) if self._turn(incoming, outgoing) else min(npc.lateral, LANE_WIDTH * (self.graph.lanes(*outgoing) - .5))
        ax, ay, dx, dy = self.graph.lane_position(npc.edge, start_offset, npc.reverse, npc.lateral)
        bx, by, tx, ty = self.graph.lane_position(outgoing[0], out_offset, outgoing[1], lateral)
        chord = math.hypot(bx - ax, by - ay)
        handle = max(1.0, min(max(cut_in, cut_out) * .7, chord * .65))
        controls = ((ax, ay), (ax + dx * handle, ay + dy * handle),
                    (bx - tx * handle, by - ty * handle), (bx, by))
        points, distances = [], [0.0]
        for index in range(33):
            t, s = index / 32, 1 - index / 32
            point = tuple(s ** 3 * controls[0][axis] + 3 * s * s * t * controls[1][axis]
                          + 3 * s * t * t * controls[2][axis] + t ** 3 * controls[3][axis] for axis in (0, 1))
            if points:
                distances.append(distances[-1] + math.dist(points[-1], point))
            points.append(point)
        return Connector(outgoing, out_offset, lane, lateral, cut_in, points, distances,
                         max(.001, distances[-1]), controls)

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

    @staticmethod
    def _observer_point(pose):
        angle, lateral = pose.get("angle", 0), pose.get("lateral", 0)
        return pose["wx"] + math.cos(angle) * lateral, pose["wy"] + math.sin(angle) * lateral

    def _near_observer(self, x, y, radius):
        cx, cy = math.floor(x / 1200), math.floor(y / 1200)
        span = math.ceil(radius / 1200)
        return any(math.hypot(x - px, y - py) < radius
                   for bx in range(cx - span, cx + span + 1) for by in range(cy - span, cy + span + 1)
                   for px, py in self._observer_cells.get((bx, by), {}).values())

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
        while distance < LOOKAHEAD and len(npc.planned_edges) < 24:
            previous = npc.planned_edges[-1] if npc.planned_edges else (npc.edge, npc.reverse)
            following = self._choose_from(*previous)
            if following is None:
                break
            npc.planned_edges.append(following)
            distance += self.graph.edges[following[0]].length
        npc.next_edge = npc.planned_edges[0] if npc.planned_edges else None

    def _approaches(self, npc, remaining):
        """Approach endpoints measured along the planned road, including splits."""
        incoming = (npc.edge, npc.reverse)
        distance = remaining
        yield incoming, distance, self.graph.junction(*incoming)
        for following in npc.planned_edges:
            distance += self.graph.edges[following[0]].length
            if distance > LOOKAHEAD:
                break
            yield following, distance, self.graph.junction(*following)

    def _turn(self, incoming, outgoing):
        graph = self.graph
        key = (*incoming, *outgoing)
        if key in graph.turns:
            return graph.turns[key]
        edge = graph.edges[incoming[0]]
        other = graph.edges[outgoing[0]]
        _, _, dx, dy = graph.position(incoming[0], 0 if incoming[1] else edge.length, incoming[1])
        _, _, tx, ty = graph.position(outgoing[0], other.length if outgoing[1] else 0, outgoing[1])
        angle = math.atan2(dx * ty - dy * tx, dx * tx + dy * ty)
        # A bend of the same physical road has no lane-changing instruction.
        if incoming[0] != outgoing[0] and len(graph.incident[graph.end_node(*incoming)]) < 3:
            turn = 0
        elif abs(angle) > math.radians(150):
            turn = -1
        else:
            turn = 1 if angle > math.radians(30) else -1 if angle < -math.radians(30) else 0
        graph.turns[key] = turn
        return turn

    def _exit_lane(self, lane, incoming, outgoing):
        count = self.graph.lanes(*outgoing)
        turn = self._turn(incoming, outgoing)
        return count - 1 if turn > 0 else 0 if turn < 0 else min(lane, count - 1)

    def _lane_intent(self, npc, remaining):
        """Merge on the approach, never towards the width of the road AFTER a turn."""
        graph = self.graph
        incoming = (npc.edge, npc.reverse)
        distance = remaining
        approach_lanes = graph.lanes(*incoming)
        for following in npc.planned_edges:
            if distance >= LOOKAHEAD:
                break
            turn = self._turn(incoming, following)
            if turn:
                desired = min(graph.lanes(npc.edge, npc.reverse), approach_lanes) - 1 if turn > 0 else 0
                return desired, distance - graph.junction(*incoming).center_stop, True
            next_lanes = graph.lanes(*following)
            if npc.lane >= next_lanes:
                return next_lanes - 1, distance - 700.0, False
            approach_lanes = next_lanes
            distance += graph.edges[following[0]].length
            incoming = following
        return min(npc.lane, graph.lanes(npc.edge, npc.reverse) - 1), math.inf, False

    def _compatible_exit(self, npc, remaining):
        """An NPC has no assigned destination: abandon an impossible merge.

        Two adjacent stopped cars must not wait forever to exchange lanes.
        Replan only through a legal exit reachable from the occupied lane;
        never move sideways through the other car or change this NPC's id.
        """
        graph = self.graph
        incoming = (npc.edge, npc.reverse)
        distance = remaining
        for index, following in enumerate(npc.planned_edges):
            if distance >= LOOKAHEAD:
                break
            if self._turn(incoming, following):
                node = graph.end_node(*incoming)
                count = graph.lanes(*incoming)
                compatible = []
                for outgoing in graph.adjacent.get(node, ()):
                    if outgoing[0] == incoming[0] or not graph.can_turn(incoming[0], node, outgoing[0]):
                        continue
                    turn = self._turn(incoming, outgoing)
                    if turn == 0 or turn > 0 and npc.lane == count - 1 or turn < 0 and npc.lane == 0:
                        compatible.append(outgoing)
                if not compatible:
                    return False
                straight = [option for option in compatible if self._turn(incoming, option) == 0]
                replacement = self.random.choice(straight or compatible)
                if replacement == following:
                    return False
                npc.planned_edges = npc.planned_edges[:index] + [replacement]
                npc.next_edge = npc.planned_edges[0]
                return True
            distance += graph.edges[following[0]].length
            incoming = following
        return False

    def _lane_clear(self, npc, lane, groups, remaining):
        """A source-way split must not hide the car immediately ahead or behind."""
        graph = self.graph
        progress = graph.edges[npc.edge].length - remaining
        clearance = CAR_LENGTH + 110.0
        for other_progress, other in groups.get((npc.edge, npc.reverse, lane), ()):
            if other.id != npc.id and abs(other_progress - progress) < clearance:
                return False
        distance = remaining
        incoming = (npc.edge, npc.reverse)
        future_lane = lane
        for following in npc.planned_edges:
            if distance >= clearance:
                break
            future_lane = self._exit_lane(future_lane, incoming, following)
            for other_progress, other in groups.get((*following, future_lane), ()):
                if other.id != npc.id and distance + other_progress < clearance:
                    return False
            distance += graph.edges[following[0]].length
            incoming = following
        distance = progress
        for previous in reversed(npc.history_edges):
            if distance >= clearance or lane >= graph.lanes(*previous):
                break
            previous_length = graph.edges[previous[0]].length
            for other_progress, other in groups.get((*previous, lane), ()):
                if other.id != npc.id and distance + previous_length - other_progress < clearance:
                    return False
            distance += previous_length
        return True

    def _gate_request(self, npc):
        if npc.connector:
            return None
        graph = self.graph
        remaining = npc.offset if npc.reverse else graph.edges[npc.edge].length - npc.offset
        path = [(npc.edge, npc.reverse), *npc.planned_edges]
        distance = remaining
        for index, incoming in enumerate(path):
            if distance > LOOKAHEAD or index + 1 >= len(path):
                break
            junction = graph.junction(*incoming)
            room = distance - junction.center_stop
            if junction.controlled and room >= -.01 and not self._clearing(npc, junction, room):
                edge = graph.edges[incoming[0]]
                _, _, dx, dy = graph.position(incoming[0], 0 if incoming[1] else edge.length, incoming[1])
                return {"npc": npc, "junction": junction, "incoming": incoming,
                        "outgoing": path[index + 1], "index": index, "path": path,
                        "distance": distance, "room": max(0, room), "direction": (dx, dy),
                        "priority": -1 if npc.yield_pending else junction.priority}
            distance += graph.edges[path[index + 1][0]].length
        return None

    @staticmethod
    def _clearing(npc, junction, room):
        if npc.junction_clearance <= 0 or room >= npc.junction_clearance:
            return False
        # A distinct sourced stop or independently controlled signal remains
        # binding. Only repeated nodes of the same crossing are coalesced.
        if junction.stop or junction.give_way:
            return False
        return not junction.signal or junction.signal_group == npc.signal_clearance_group

    def _refresh_clearance(self, npc):
        junction = self.graph.junction(npc.edge, npc.reverse)
        edge = self.graph.edges[npc.edge]
        remaining = npc.offset if npc.reverse else edge.length - npc.offset
        if junction.controlled and remaining < junction.center_stop - .01:
            npc.junction_clearance = max(npc.junction_clearance,
                                         remaining + junction.cross_width / 2 + CAR_LENGTH / 2)
            if junction.signal:
                npc.signal_clearance_group = junction.signal_group

    def _exit_clear(self, request, groups, obstacles):
        npc, graph = request["npc"], self.graph
        incoming, outgoing = request["incoming"], request["outgoing"]
        lane = self._exit_lane(npc.lane, incoming, outgoing)
        _, cut_out = self._connector_cuts(incoming, outgoing)
        required = max(CAR_LENGTH + 160, cut_out + CAR_LENGTH + 110)
        distance = 0.0
        for following in request["path"][request["index"] + 1:]:
            lane = self._exit_lane(lane, incoming, following)
            for progress, other in groups.get((*following, lane), ()):
                if other.id != npc.id and distance + progress < required:
                    return False
            distance += graph.edges[following[0]].length
            if distance >= required:
                break
            incoming = following
        edge = graph.edges[outgoing[0]]
        offset = edge.length - cut_out if outgoing[1] else cut_out
        x, y, _, _ = graph.lane_position(outgoing[0], offset, outgoing[1], LANE_WIDTH * (self._exit_lane(npc.lane, request["incoming"], outgoing) + .5))
        cx, cy = math.floor(x / 800), math.floor(y / 800)
        return not any((layer is None or layer == edge.layer) and math.hypot(x - ox, y - oy) < 210
                       for bx in range(cx - 1, cx + 2) for by in range(cy - 1, cy + 2)
                       for ox, oy, layer in obstacles.get((bx, by), {}).values())

    def _requests_conflict(self, a, b):
        ja, jb = a["junction"], b["junction"]
        ax, ay = self.graph.nodes[ja.node][:2]
        bx, by = self.graph.nodes[jb.node][:2]
        radius = self._junction_radius(a) + self._junction_radius(b)
        return math.hypot(ax - bx, ay - by) < radius and self.graph.nearby_connected(ja.node, jb.node, radius)

    def _junction_radius(self, request):
        return max(request["junction"].cross_width / 2,
                   self.graph.edges[request["incoming"][0]].base_lanes * LANE_WIDTH / 2,
                   self.graph.edges[request["outgoing"][0]].base_lanes * LANE_WIDTH / 2) + CAR_LENGTH * 1.5

    def _near_requests(self, request, cells):
        x, y = self.graph.nodes[request["junction"].node][:2]
        cx, cy = math.floor(x / 800), math.floor(y / 800)
        return (other for bx in range(cx - 1, cx + 2) for by in range(cy - 1, cy + 2)
                for other in cells.get((bx, by), ()))

    def _reservation_conflict(self, request):
        junction = request["junction"]
        x, y = self.graph.nodes[junction.node][:2]
        radius = self._junction_radius(request)
        cx, cy = math.floor(x / 800), math.floor(y / 800)
        nearby = (npc_id for bx in range(cx - 1, cx + 2) for by in range(cy - 1, cy + 2)
                  for npc_id in self._reservation_cells.get((bx, by), ()))
        for npc_id in nearby:
            if npc_id == request["npc"].id:
                continue
            reservation = self._reservations.get(npc_id)
            if reservation is None:
                continue
            reach = radius + reservation.radius
            if math.hypot(x - reservation.x, y - reservation.y) < reach and self.graph.nearby_connected(junction.node, reservation.node, reach):
                return True
        return False

    def _yields_to(self, request, other):
        a, b = request["junction"], other["junction"]
        if other["priority"] != request["priority"]:
            return other["priority"] > request["priority"]
        if a.stop and b.stop:
            return (other["npc"].gate_wait, other["npc"].id) > (request["npc"].gate_wait, request["npc"].id)
        ax, ay = request["direction"]
        bx, by = other["direction"]
        dot = ax * bx + ay * by
        turn, other_turn = self._turn(request["incoming"], request["outgoing"]), self._turn(other["incoming"], other["outgoing"])
        if dot < -.7:
            return turn < 0 and other_turn >= 0
        # At an unmarked equal-priority junction, yield to the approach on the
        # right. The other approach's outward vector is minus its heading.
        return ax * -by - ay * -bx > .35

    def _prepare_gates(self, dt, groups, obstacles, world_frame):
        requests = {}
        for npc in self.npcs.values():
            self._refresh_clearance(npc)
            if npc.connector:
                continue
            edge = self.graph.edges[npc.edge]
            self._plan_ahead(npc, npc.offset if npc.reverse else edge.length - npc.offset)
            request = self._gate_request(npc)
            if request is None:
                npc.stop_node, npc.stop_wait, npc.gate_wait = None, 0.0, 0.0
                continue
            junction = request["junction"]
            if npc.stop_node != junction.node:
                npc.stop_node, npc.stop_wait, npc.gate_wait = junction.node, 0.0, 0.0
            if request["room"] <= 6 and npc.speed < 8:
                npc.stop_wait += dt
            npc.gate_wait = npc.gate_wait + dt if request["room"] <= 200 and npc.speed < 30 else 0.0
            turn = self._turn(request["incoming"], request["outgoing"])
            required_lane = self.graph.lanes(*request["incoming"]) - 1 if turn > 0 else 0
            lane_ready = turn == 0 or abs(npc.lateral - LANE_WIDTH * (required_lane + .5)) < 2
            request["ready"] = (request["room"] <= 160 and lane_ready
                                and not self.graph.red(junction, self.seed, world_frame)
                                and (not junction.stop or npc.stop_wait >= 1.0)
                                and self._exit_clear(request, groups, obstacles))
            requests[npc.id] = request
        for npc_id in list(self._reservations):
            npc = self.npcs.get(npc_id)
            request = requests.get(npc_id)
            reservation = self._reservations[npc_id]
            expired = npc is None or reservation.remaining <= 0 and npc.connector is None
            if npc and not npc.connector:
                x, y, _, _ = self._body(npc)
                expired = expired or math.hypot(x - reservation.x, y - reservation.y) > reservation.radius + CAR_LENGTH
            red_before_entry = (request and reservation.node == request["junction"].node
                                and self.graph.red(request["junction"], self.seed, world_frame) and npc.connector is None)
            if expired or red_before_entry:
                self._reservations.pop(npc_id, None)
        self._reservation_cells.clear()
        for npc_id, reservation in self._reservations.items():
            self._reservation_cells[(math.floor(reservation.x / 800), math.floor(reservation.y / 800))].add(npc_id)
        ready = [request for request in requests.values() if request["ready"]
                 and (request["npc"].id not in self._reservations
                      or self._reservations[request["npc"].id].node != request["junction"].node)]
        ready.sort(key=lambda request: (-request["priority"], -request["npc"].gate_wait, request["npc"].id))
        ready_cells = defaultdict(list)
        for request in ready:
            x, y = self.graph.nodes[request["junction"].node][:2]
            ready_cells[(math.floor(x / 800), math.floor(y / 800))].append(request)
        for request in ready:
            if self._reservation_conflict(request):
                continue
            contenders = [other for other in self._near_requests(request, ready_cells) if other is not request and self._requests_conflict(request, other)]
            if any(self._yields_to(request, other) for other in contenders):
                continue
            self._reserve(request)
        # Four equal-priority stopped approaches can form a right-hand cycle.
        # One oldest fully stopped car proceeds under exclusive reservation.
        for request in ready:
            reservation = self._reservations.get(request["npc"].id)
            if reservation and reservation.node == request["junction"].node:
                continue
            if request["npc"].gate_wait >= 2 and not self._reservation_conflict(request):
                contenders = [other for other in self._near_requests(request, ready_cells) if self._requests_conflict(request, other)]
                if all(other["npc"].speed < 30 and other["priority"] <= request["priority"] for other in contenders):
                    self._reserve(request)
        self._gate_requests = requests

    def _reserve(self, request):
        junction = request["junction"]
        if junction.stop or junction.give_way:
            request["npc"].yield_pending = True
        x, y = self.graph.nodes[junction.node][:2]
        _, cut_out = self._connector_cuts(request["incoming"], request["outgoing"])
        self._reservations[request["npc"].id] = Reservation(junction.node, x, y,
                                                          self._junction_radius(request),
                                                          request["distance"] + cut_out + CAR_LENGTH * 2)
        self._reservation_cells[(math.floor(x / 800), math.floor(y / 800))].add(request["npc"].id)

    def _pose(self, npc):
        x, y, dx, dy = self._body(npc)
        return {"id": npc.id, "wx": round(x, 3), "wy": round(y, 3),
                "angle": round(math.atan2(dx, -dy) if npc.connector or npc.heading is None else npc.heading, 6), "lateral": 0, "pose_space": "world",
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
            x, y, _, _ = self.graph.lane_position(edge_id, offset, reverse, LANE_WIDTH * (lane + .5))
            # Spawn outside every observer's road scene, without a separate
            # random stream or separate car population for each observer.
            if self._near_observer(x, y, SPAWN_GUARD):
                continue
            if any(abs(previous - offset) < 240 for previous in self._occupancy[(edge_id, reverse, lane)]):
                continue
            cruise = min(edge.limit * self.random.uniform(.68, .9), 16 / self.graph.meters_per_unit)
            npc = NPC(f"n{self.seed:x}-{self._next_id + 1:x}", edge_id, reverse, offset, lane,
                      cruise * .7, cruise, self.random.choice(COLORS), self.elapsed,
                      lateral=LANE_WIDTH * (lane + .5))
            remaining = offset if reverse else edge.length - offset
            self._plan_ahead(npc, remaining)
            # Do not introduce a moving car inside an upstream stop-line on
            # either the current source way or a very short following way.
            if any(junction.controlled and distance < junction.center_stop + CAR_LENGTH
                   for _, distance, junction in self._approaches(npc, remaining)):
                continue
            npc.lane, _, _ = self._lane_intent(npc, remaining)
            npc.lateral = LANE_WIDTH * (npc.lane + .5)
            x, y, _, _ = self._body(npc)
            if self._near_observer(x, y, SPAWN_GUARD):
                continue
            if any(abs(previous - offset) < 240 for previous in self._occupancy[(edge_id, reverse, npc.lane)]):
                continue
            self._next_id += 1
            self.npcs[npc.id] = npc
            counts[cell] += 1
            self._occupancy[(edge_id, reverse, npc.lane)].append(offset)
            return True
        return False

    def _activate(self):
        active = set()
        for key in [candidate for candidate, seen in self._snapshot_seen.items() if self.elapsed - seen > 30]:
            self._snapshot_seen.pop(key, None)
            self._snapshot_members.pop(key, None)
        self._observer_cells.clear()
        for pose in self._poses:
            x, y = self._observer_point(pose)
            self._observer_cells[(math.floor(x / 1200), math.floor(y / 1200))][(round(x / 100), round(y / 100))] = (x, y)
            cx, cy = self._cell(x, y)
            for x in range(cx - 2, cx + 3):
                for y in range(cy - 2, cy + 3):
                    if (x, y) in self.graph.cells:
                        active.add((x, y))
        self._active_cells = active
        counts = defaultdict(int)
        self._occupancy.clear()
        for npc in self.npcs.values():
            x, y, _, _ = self._body(npc)
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

    def _advance(self, npc, distance):
        """Spend true world arclength on lanes and their cubic connectors."""
        remaining_distance = distance
        transitions = 0
        while remaining_distance > .000001 and transitions < 64:
            edge = self.graph.edges[npc.edge]
            if npc.connector:
                connector = npc.connector
                moved = min(remaining_distance, connector.length - npc.connector_distance)
                npc.connector_distance += moved
                remaining_distance -= moved
                ratio = npc.connector_distance / connector.length
                npc.offset = connector.in_cut * (1 - ratio) if npc.reverse else edge.length - connector.in_cut * (1 - ratio)
                if npc.connector_distance < connector.length - .000001:
                    break
                previous = (npc.edge, npc.reverse)
                if len(self.graph.incident[self.graph.end_node(*previous)]) >= 3:
                    npc.yield_pending = False
                npc.history_edges = (npc.history_edges + [previous])[-24:]
                npc.edge, npc.reverse = connector.outgoing
                npc.offset, npc.lane, npc.lateral = connector.out_offset, connector.out_lane, connector.out_lateral
                if npc.planned_edges and npc.planned_edges[0] == connector.outgoing:
                    npc.planned_edges.pop(0)
                npc.connector, npc.connector_distance = None, 0.0
                npc.next_edge = npc.planned_edges[0] if npc.planned_edges else self._choose_exit(npc)
                transitions += 1
                continue
            remaining = npc.offset if npc.reverse else edge.length - npc.offset
            cut_in = self._connector_cuts((npc.edge, npc.reverse), npc.next_edge)[0] if npc.next_edge else 0.0
            moved = min(remaining_distance, max(0.0, remaining - cut_in))
            npc.offset += -moved if npc.reverse else moved
            remaining_distance -= moved
            if remaining_distance <= .000001:
                break
            if not npc.next_edge:
                npc.speed = 0.0
                break
            npc.connector = self._make_connector(npc)
            npc.connector_distance = 0.0
            npc.stop_node, npc.stop_wait, npc.gate_wait = None, 0.0, 0.0
            transitions += 1
        traveled = distance - remaining_distance
        npc.junction_clearance = max(0.0, npc.junction_clearance - traveled)
        if npc.junction_clearance == 0:
            npc.signal_clearance_group = None
        reservation = self._reservations.get(npc.id)
        if reservation:
            reservation.remaining -= traveled
        return traveled

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
        for key, group in groups.items():
            group.sort(key=lambda item: item[0])
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
            layer = self.graph.edge_layers.get(pose.get("edge"))
            obstacles[(math.floor(x / 800), math.floor(y / 800))][(round(x / 100), round(y / 100), layer)] = (x, y, layer)
        remove = []
        world_frame = math.floor(time.time() * 60)
        acceleration = 3.0 / self.graph.meters_per_unit
        braking = 7.0 / self.graph.meters_per_unit
        self._prepare_gates(dt, groups, obstacles, world_frame)
        for npc in self.npcs.values():
            body_before = self._body(npc)
            edge = self.graph.edges[npc.edge]
            remaining = npc.offset if npc.reverse else edge.length - npc.offset
            self._plan_ahead(npc, remaining)
            desired_lane, lane_room, lane_turn = self._lane_intent(npc, remaining) if not npc.connector else (npc.lane, math.inf, False)
            merge_lane = npc.lane + (1 if desired_lane > npc.lane else -1 if desired_lane < npc.lane else 0)
            lane_clear = merge_lane == npc.lane or self._lane_clear(npc, merge_lane, groups, remaining)
            unfinished_lane = abs(npc.lateral - LANE_WIDTH * (desired_lane + .5)) > 1
            npc.lane_wait = npc.lane_wait + dt if unfinished_lane and lane_room < 250 and npc.speed < 30 else 0.0
            if npc.lane_wait >= 5.0 and lane_turn and self._compatible_exit(npc, remaining):
                npc.lane_wait = 0.0
                self._plan_ahead(npc, remaining)
                desired_lane, lane_room, lane_turn = self._lane_intent(npc, remaining)
                merge_lane = npc.lane + (1 if desired_lane > npc.lane else -1 if desired_lane < npc.lane else 0)
                lane_clear = merge_lane == npc.lane or self._lane_clear(npc, merge_lane, groups, remaining)
                self._reservations.pop(npc.id, None)
                self._gate_requests[npc.id] = self._gate_request(npc)
            target_lateral = LANE_WIDTH * (merge_lane + .5)
            x, y, dx, dy = self._body(npc)
            if self._cell(x, y) in self._active_cells:
                npc.last_active = self.elapsed
            elif self.elapsed - npc.last_active > 15 and not self._near_observer(x, y, DELETE_GUARD):
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
            # Follow the physical queue over all short OSM edges. A planned
            # loop can revisit this car's own edge: it must never lead itself.
            distance_ahead = remaining
            incoming = (npc.edge, npc.reverse)
            future_lanes = {lane for lane in range(self.graph.lanes(*incoming))
                            if abs(npc.lateral - LANE_WIDTH * (lane + .5)) < 62}
            for following in npc.planned_edges:
                if distance_ahead > LOOKAHEAD:
                    break
                future_lanes = {self._exit_lane(lane, incoming, following) for lane in future_lanes}
                for lane in future_lanes:
                    next_leader = next((item for item in groups.get((*following, lane), ()) if item[1].id != npc.id), None)
                    if next_leader:
                        gap = distance_ahead + next_leader[0] - CAR_LENGTH
                        target = min(target, max(0, next_leader[1].speed + (gap - 160) * 1.2))
                        max_move = min(max_move, max(0, gap - 45))
                distance_ahead += self.graph.edges[following[0]].length
                incoming = following
            if not npc.next_edge:
                room = max(0, remaining - CAR_LENGTH / 2 - BUMPER_GAP)
                target = min(target, math.sqrt(2 * braking * room))
                max_move = min(max_move, room)
            request = self._gate_requests.get(npc.id)
            reserved = self._reservations.get(npc.id)
            if request and (reserved is None or reserved.node != request["junction"].node):
                room = request["room"]
                target = min(target, math.sqrt(2 * braking * room))
                max_move = min(max_move, room)
            # A turn starts only after the approach lane is reached. If that
            # lane is occupied, wait before the line instead of crossing rows.
            if abs(npc.lateral - LANE_WIDTH * (desired_lane + .5)) > 1:
                # A blocked taper waits early. Once a gap opens, its reserved
                # 700px approach permits two forward-moving lane changes.
                room = max(0, lane_room + (608 if not lane_turn and lane_clear else 0))
                target = min(target, math.sqrt(2 * braking * room))
                max_move = min(max_move, room)
            self._refresh_clearance(npc)
            for _, distance_ahead, junction in self._approaches(npc, remaining):
                room = distance_ahead - junction.center_stop
                # Once the front has crossed a line, clear that junction even
                # if its light changes. At the stopping boundary keep waiting.
                if not npc.connector and room >= -.01 and not self._clearing(npc, junction, room) and self.graph.red(junction, self.seed, world_frame):
                    room = max(0, room)
                    target = min(target, math.sqrt(2 * braking * room))
                    max_move = min(max_move, room)
            px, py = x, y
            bx, by = math.floor(px / 800), math.floor(py / 800)
            for cx in range(bx - 1, bx + 2):
                for cy in range(by - 1, by + 2):
                    for ox, oy, obstacle_layer in obstacles.get((cx, cy), {}).values():
                        if obstacle_layer is not None and obstacle_layer != edge.layer:
                            continue
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
            if lane_clear and not npc.connector:
                # The body turns while moving forward, never strafes at rest.
                lateral_step = min(80 * dt, distance * .25)
                npc.lateral += max(-lateral_step, min(lateral_step, target_lateral - npc.lateral))
                if abs(npc.lateral - target_lateral) < .01:
                    npc.lane = merge_lane
            self._advance(npc, distance)
            after_x, after_y, after_dx, after_dy = self._body(npc)
            vx, vy = after_x - body_before[0], after_y - body_before[1]
            npc.heading = math.atan2(vx, -vy) if math.hypot(vx, vy) > .05 else math.atan2(after_dx, -after_dy)
        for npc_id in remove:
            self.npcs.pop(npc_id, None)
            self._reservations.pop(npc_id, None)
        self._snapshot_cells.clear()
        for npc in self.npcs.values():
            pose = self._pose(npc)
            self._snapshot_cells[self._cell(pose["wx"], pose["wy"])].append(pose)

    def snapshot(self):
        """One immutable-tick list for every recipient in this room."""
        return sorted((pose for poses in self._snapshot_cells.values() for pose in poses),
                      key=lambda pose: pose["id"])

    def snapshot_for(self, player):
        pose = self._player_pose(player)
        if pose is None:
            return []
        key = player.get("id", id(player)) if isinstance(player, dict) else getattr(player, "id", id(player))
        self._snapshot_seen[key] = self.elapsed
        x, y = self._observer_point(pose)
        cx, cy = self._cell(x, y)
        previous = self._snapshot_members.get(key, set())
        visible = [npc for bx in range(cx - 1, cx + 2) for by in range(cy - 1, cy + 2)
                   for npc in self._snapshot_cells.get((bx, by), ())
                   if math.hypot(npc["wx"] - x, npc["wy"] - y) <= (SNAPSHOT_OUTER if npc["id"] in previous else SNAPSHOT_INNER)]
        self._snapshot_members[key] = {npc["id"] for npc in visible}
        return visible
