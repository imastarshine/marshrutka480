"""Room-owned pedestrians at sourced OSM crossings; no client random walkers."""
from collections import defaultdict
from dataclasses import dataclass, field
import math


CELL = 4000.0
CURB = 28.0
COLORS = ((73, 119, 170), (190, 91, 72), (99, 145, 93), (177, 143, 76), (142, 104, 163))


@dataclass(frozen=True, slots=True)
class Crossing:
    node: int
    edge: int
    x: float
    y: float
    dx: float
    dy: float
    width: float
    layer: float
    control: object


@dataclass(slots=True)
class Walker:
    id: str
    side: int
    row: float
    speed: float
    progress: float = 0.0
    walking: bool = False
    moving: bool = False
    color: tuple = COLORS[0]


@dataclass(slots=True)
class CrossingState:
    crossing: Crossing
    next_spawn: float
    serial: int = 0
    walkers: list = field(default_factory=list)


class PedestrianWorld:
    def __init__(self, graph, seed, hash_function):
        self.graph, self.seed, self.hash = graph, seed, hash_function
        self.crossings = {}
        self.cells = defaultdict(list)
        self.states = {}
        self.serials = {}
        self.active = set()
        self.blocked = defaultdict(list)
        self.blocked_nodes = set()
        self.vehicles = defaultdict(list)
        self.elapsed = 0.0
        cached = getattr(graph, "pedestrian_crossings", None)
        if cached is not None:
            self.crossings, self.cells = cached
        else:
            for node, raw in enumerate(graph.nodes):
                tags = raw[3] if len(raw) > 3 else {}
                if tags.get("foot") == "no" or tags.get("crossing") == "no" or tags.get("highway") != "crossing":
                    continue
                roads = sorted(graph.incident.get(node, ()), key=lambda index: (-graph.edges[index].base_lanes, graph.edges[index].id))
                if not roads:
                    continue
                index = roads[0]
                edge = graph.edges[index]
                offset = 0 if edge.start == node else edge.length
                _, _, dx, dy = graph.position(index, offset, False)
                control = graph.junction(index, edge.start == node)
                for road in roads:
                    candidate = graph.edges[road]
                    _, _, tx, ty = graph.position(road, 0 if candidate.start == node else candidate.length, False)
                    signal = graph.junction(road, candidate.start == node)
                    if signal.signal and abs(dx * tx + dy * ty) > .7:
                        control = signal
                        break
                crossing = Crossing(node, index, raw[0], raw[1], dx, dy, edge.base_lanes * 37,
                                    edge.layer, control)
                self.crossings[node] = crossing
                self.cells[self.cell(crossing.x, crossing.y)].append(node)

            graph.pedestrian_crossings = (self.crossings, self.cells)

    @staticmethod
    def cell(x, y):
        return math.floor(x / CELL), math.floor(y / CELL)

    def nearby_vehicles(self, crossing):
        cx, cy = self.cell(crossing.x, crossing.y)
        return (vehicle for x in range(cx - 1, cx + 2) for y in range(cy - 1, cy + 2)
                for vehicle in self.vehicles.get((x, y), ())
                if vehicle[5] is None or vehicle[5] == crossing.layer)

    @staticmethod
    def position(crossing, walker):
        distance = (crossing.width + CURB) * (1 - 2 * walker.progress) * walker.side
        return (crossing.x - crossing.dy * distance + crossing.dx * walker.row,
                crossing.y + crossing.dx * distance + crossing.dy * walker.row)

    def road_clear(self, crossing):
        for x, y, speed, w, h, _ in self.nearby_vehicles(crossing):
            dx, dy = x - crossing.x, y - crossing.y
            along = abs(dx * crossing.dx + dy * crossing.dy)
            across = abs(-crossing.dy * dx + crossing.dx * dy)
            # A moving approaching vehicle gets time to stop before a person
            # leaves the curb. Stopped vehicles behind the line allow crossing.
            if across < crossing.width + w / 2 and along < max(h / 2 + 40, speed * .8):
                return False
        return True

    def step(self, dt, players, vehicles, world_frame):
        self.elapsed += dt
        self.vehicles.clear()
        for vehicle in vehicles:
            self.vehicles[self.cell(vehicle[0], vehicle[1])].append(vehicle)
        active = set()
        for pose in players:
            angle, lateral = pose.get("angle", 0), pose.get("lateral", 0)
            x, y = pose["wx"] + math.cos(angle) * lateral, pose["wy"] + math.sin(angle) * lateral
            cx, cy = self.cell(x, y)
            for bx in range(cx - 1, cx + 2):
                for by in range(cy - 1, cy + 2):
                    active.update(self.cells.get((bx, by), ()))
        self.active = active
        for node in active:
            if node not in self.states:
                self.states[node] = CrossingState(self.crossings[node], self.elapsed + 2 + self.hash(node, 11, self.seed) * 10, serial=self.serials.get(node, 0))
        self.blocked.clear()
        self.blocked_nodes.clear()
        for node, state in list(self.states.items()):
            crossing = state.crossing
            if node in active and not state.walkers and self.elapsed >= state.next_spawn:
                state.serial += 1
                self.serials[node] = state.serial
                count = 1 + int(self.hash(node, state.serial, self.seed) > .6)
                state.walkers = [Walker(f"p{self.seed:x}-{node}-{state.serial}-{i}",
                                        1 if self.hash(node, state.serial * 7 + i, self.seed) > .5 else -1,
                                        (i - (count - 1) / 2) * 18,
                                        (1.15 + self.hash(node, state.serial * 13 + i, self.seed) * .35) / self.graph.meters_per_unit,
                                        color=COLORS[(node + state.serial + i) % len(COLORS)]) for i in range(count)]
            walk_phase = not crossing.control.signal or self.graph.pedestrian_green(crossing.control, self.seed, world_frame)
            clear = self.road_clear(crossing) if state.walkers and walk_phase else False
            for walker in state.walkers:
                walker.moving = False
                if not walker.walking and walk_phase and clear:
                    walker.walking = True
                if not walker.walking:
                    continue
                proposed = min(1.0, walker.progress + walker.speed * dt / (2 * (crossing.width + CURB)))
                previous = walker.progress
                walker.progress = proposed
                px, py = self.position(crossing, walker)
                # A player can stop on the crossing; people wait instead of
                # stepping through that bus. NPCs yield before reaching it.
                if any(math.hypot(px - vx, py - vy) < max(w, h) / 2 + 12
                       for vx, vy, _, w, h, _ in self.nearby_vehicles(crossing)):
                    walker.progress = previous
                walker.moving = walker.progress > previous
            had_walkers = bool(state.walkers)
            state.walkers = [walker for walker in state.walkers if walker.progress < 1.0]
            if had_walkers and not state.walkers:
                state.next_spawn = self.elapsed + 25 + self.hash(node, state.serial * 17, self.seed) * 25
            waiting = walk_phase and any(not w.walking for w in state.walkers)
            on_road = any(w.walking and (1 - w.progress) * 2 * (crossing.width + CURB) > CURB for w in state.walkers)
            if waiting or on_road:
                self.blocked_nodes.add(node)
                self.blocked[self.cell(crossing.x, crossing.y)].append(crossing)
            if node not in active and not state.walkers:
                del self.states[node]

    def stop_room(self, x, y, dx, dy, layer, half_length=46):
        cx, cy = self.cell(x, y)
        room = math.inf
        for bx in range(cx - 1, cx + 2):
            for by in range(cy - 1, cy + 2):
                for crossing in self.blocked.get((bx, by), ()):
                    if crossing.layer != layer or abs(dx * crossing.dx + dy * crossing.dy) < .65:
                        continue
                    vx, vy = crossing.x - x, crossing.y - y
                    ahead, side = vx * dx + vy * dy, abs(-dy * vx + dx * vy)
                    # Vehicles already over the line must clear the crossing;
                    # stopping them on the stripes deadlocks the waiting group.
                    gap = ahead - 70 - half_length - 6
                    if gap >= -.01 and side < crossing.width + 30 and ahead < 1400:
                        room = min(room, max(0.0, gap))
        return room

    def snapshot(self):
        poses = []
        for state in self.states.values():
            crossing = state.crossing
            for walker in state.walkers:
                x, y = self.position(crossing, walker)
                dx, dy = crossing.dy * walker.side, -crossing.dx * walker.side
                poses.append({"id": walker.id, "crossing": crossing.node, "wx": round(x, 3), "wy": round(y, 3),
                              "angle": round(math.atan2(dx, -dy), 6), "walking": walker.walking, "moving": walker.moving,
                              "color": walker.color, "layer": crossing.layer})
        return sorted(poses, key=lambda pose: pose["id"])
