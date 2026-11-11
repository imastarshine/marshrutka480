// Маршрутка — ядро игры: состояние рейса, карта, спавн, поворот.
// Методы дописываются наследниками: GameUpdate (update.js) → GameRender (render.js) → Game (lobby.js)
"use strict";

// ---------- игра ----------
class GameCore {
    constructor() {
        this.save = loadSave();
        this.state = "intro";         // при запуске — заставка
        this.introT = 0;
        this.shopIndex = 0;
        this.tab = 0;
        this.result = null;          // итог последнего рейса для лобби
        this.frame = 0;
        this.keys = { up: false, down: false, left: false, right: false };
        this.snapshot = document.createElement("canvas");
        this.snapshot.width = WIDTH;
        this.snapshot.height = HEIGHT;
        this.reset();
    }

    level(key) {
        return this.save.upgrades[key] || 0;
    }

    reset() {
        window.citySession?.onReset();
        const up = this.save.upgrades;
        this.model = BUS_MODELS.find((m) => m.key === this.save.bus) || BUS_MODELS[0];
        this.route = ROUTES.find((r) => r.num === this.save.route) || ROUTES[0];
        if (this.cityGraph?.data !== IRKUTSK_CITY) this.cityGraph = new CityGraph(IRKUTSK_CITY);
        this.cityItinerary = this.cityGraph.itinerary(this.route.num);
        this.cityLegIndex = 0;
        this.cityLap = 0;
        this.cityOffRoute = false;
        this.spawnedCityStops = new Set();
        const firstLeg = this.cityItinerary.legs[0];
        this.cityEdge = firstLeg.edge;
        this.cityReverse = firstLeg.reverse;
        const start = Math.min(40, firstLeg.edge.length * 0.02);
        this.cityOffset = firstLeg.reverse ? firstLeg.edge.length - start : start;
        this.cityTravel = 0;
        this.cityPendingTurn = null;
        this.cityExitSelection = null;
        this.cityRejoinGuide = null;
        this.cityGeometryHistory = [];
        this.cityGeometryCache = null;
        this.cityRouteDirections = new Set(this.cityItinerary.legs.map((leg) => `${leg.edge.id}:${leg.reverse}`));
        this.cityRouteEdges = new Set(this.cityItinerary.legs.map((leg) => leg.edge.id));
        this.mapOverview = false;
        this.mapPausedRun = false;
        this.dir = this.cityGraph.direction(this.cityEdge, this.cityReverse, this.cityOffset);
        this.cameraDir = [...this.dir];
        [this.wx, this.wy] = this.cityGraph.position(this.cityEdge, this.cityOffset);
        this.streetK = this.cityEdge.index;
        setRoad(this.cityEdge.lanes);
        this.bus = new Bus(up, this.model, this.route.num);
        this.capacity = this.model.cap + 3 * (up.seats || 0);
        // репутация: уважаемому водителю платят больше (±15%), к нему приходят люди, ДПС к нему мягче
        this.rep = this.save.rep;
        this.repDelta = 0;
        this.repPopup = null;
        this.notice = null;              // большая надпись по центру: «Круг пройден!» и т.п.
        this.fare = Math.round((this.route.fare + this.model.fare + 10 * (up.fare || 0)) * (0.85 + 0.3 * this.rep / 100));
        // сколько человек обслуживается за раз: двери + касса
        this.perTick = this.model.doors + (up.cashbox || 0);
        this.serviceDelay = Math.max(10, 22 - 3 * (up.cashbox || 0));
        this.district = this.cityEdge.district || this.route.districts[0];
        this.scenery = new Scenery(this);
        this.crosswalks = [];
        this.bridges = [];
        this.airbags = up.airbag || 0;
        this.policeFine = Math.round(POLICE_FINE * (1 - 0.3 * (up.blat || 0)));
        this.chaseTime = 1500 - 300 * (up.blat || 0);

        this.cars = [];
        this.serverCars = [];
        this.serverWorldEnabled = false;
        this.stops = [];
        this.inters = [];
        this.ramps = [];
        this.posts = [];
        this.police = null;
        this.wanted = 0;                 // уровень розыска 0..5 (звёзды), дробный — гаснет постепенно
        this.policeReturn = 0;           // через сколько кадров ДПС снова сядет на хвост
        this.walkers = [];
        this.passengers = [];        // id остановок, где каждый пассажир выходит
        this.particles = [];
        this.texts = [];
        this.coins = [];
        this.skids = [];
        this.newStrips();
        this.money = 0;
        this.moneyShown = 0;
        this.distance = 0;
        this.scroll = 0;
        this.stopsServed = 0;
        this.complaints = 0;
        this.stunts = 0;
        this.turns = 0;
        this.combo = 0;
        this.comboTimer = 0;
        this.nextStopId = 0;
        this.nextIn = { stop: 700, ramp: 2600, post: 4500, cross: 1400, bridge: 2500, zone: 1500, station: rand(6000, 14000) };
        this.shifts = [];
        this.stations = [];
        this.openBelow = LANES / 2 - CLOSED;     // открыто полос на сторону ниже всех смен ширины
        this.styleBelow = choice(["tiles", "parking"]);
        this.heli = null;
        this.roadblockIn = 0;
        this.spawnTimer = 60;
        this.serviceTimer = 0;
        this.steerLog = [];
        this.lastSteer = 0;
        this.slalomReady = 0;
        this.jumped = new Set();
        this.shake = 0;
        this.flash = 0;
        this.boomTimer = 0;
        this.banner = null;
        // карта города: позиция маршрутки и направление (север = вверх)
        this.trail = [[this.wx, this.wy]];
        this.wrongWay = 0;
        this.clock = SHIFT_START * FRAMES_PER_MIN;
        this.repairs = 0;
        this.hornT = 0;
        this.hornCool = 0;
        this.honks = [];        // кадры недавних сигналов — за спам жалуются
        // кортеж: раз за смену в случайное время всё перекрывают
        this.motorcade = null;
        this.motorcadeAt = randint(9 * 60, 16 * 60);
        this.motorcadeAnnounced = false;
        // ?kortezh в адресе — кортеж почти сразу (чтобы посмотреть)
        if (typeof location !== "undefined" && /kortezh/.test(location.search)) this.motorcadeAt = SHIFT_START + 3;
        this.spawnedLines = new Set();
        this.turnT = 0;
        this.turnTotal = 1;
        this.turnSign = 0;
    }

    newStrips() {
        this.strips = [new Strip(ROAD_LEFT - 20, "trees", this), new Strip(ROAD_RIGHT + 30, "lamps", this)];
    }

    get serverTrafficActive() { return Boolean(window.citySession?.authoritativeTraffic); }

    prepareSharedWorld() {
        if (this.serverWorldEnabled) return;
        this.serverWorldEnabled = true;
        this.cars = []; this.serverCars = []; this.ramps = []; this.posts = []; this.stations = [];
        this.crosswalks = []; this.shifts = []; this.police = null; this.heli = null;
        this.motorcade = null; this.motorcadeAt = null; this.wanted = 0;
        this.openBelow = LANES / 2 - CLOSED; this.styleBelow = "tiles";
        for (const inter of this.inters) { inter.crossCars = []; inter.peds.peds = []; }
        if (this.state === "station" || this.state === "caught") { this.state = "play"; this.station = null; this.caught = null; }
    }

    // Изгиб дороги следует импортированной геометрии. Случайного виляния нет.
    bendAt(along) {
        const [x, y] = this.cityGeometryAt(along - this.along).position;
        const camera = this.cameraDir || this.dir;
        return (x - this.wx) * -camera[1] + (y - this.wy) * camera[0];
    }

    // сдвиг строки экрана y относительно маршрутки (она всегда в центре)
    bendOffset(y) {
        const a = this.along + (this.bus.centerY - y);
        return clamp(this.bendAt(a), -MARGIN + 20, MARGIN - 20);
    }

    bendAngle() {
        const camera = this.cameraDir || this.dir;
        return Math.atan2(camera[0] * this.dir[1] - camera[1] * this.dir[0], camera[0] * this.dir[0] + camera[1] * this.dir[1]);
    }

    updateCameraDirection() {
        if (this.state === "turning") return;
        const camera = this.cameraDir || this.dir;
        const before = this.cityGeometryAt(-100).position, ahead = this.cityGeometryAt(100).position;
        const dx = ahead[0] - before[0], dy = ahead[1] - before[1];
        const current = Math.atan2(camera[1], camera[0]);
        const desired = Math.hypot(dx, dy) > 0.01 ? Math.atan2(dy, dx) : Math.atan2(this.dir[1], this.dir[0]);
        const difference = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
        const angle = current + difference * 0.22;
        this.cameraDir = [Math.cos(angle), Math.sin(angle)];
    }

    // поперечные улицы: k и их координата вдоль нашего движения
    crossAlong(k) {
        if (k === this.cityEdge.from) return this.cityReverse ? this.cityOffset : -this.cityOffset;
        if (k === this.cityEdge.to) return this.cityReverse ? -(this.cityEdge.length - this.cityOffset) : this.cityEdge.length - this.cityOffset;
        return 0;
    }

    crossNear(along) {
        return [this.cityEdge.from, this.cityEdge.to].map((k) => ({ k, a: this.along + this.crossAlong(k) }));
    }

    nearestCross(along) {
        return this.crossNear(along).reduce((b, c) => (Math.abs(c.a - along) < Math.abs(b.a - along) ? c : b));
    }

    nextCross() {
        const k = this.cityGraph.endpoint(this.cityEdge, this.cityReverse);
        return { k, a: this.along + this.crossAlong(k) };
    }

    // узел карты для перекрёстка с поперечной улицей k
    node(k) {
        const node = this.cityGraph.nodes.get(k);
        return node ? [node.index, node.index * 7] : [0, 0];
    }

    arms(k) {
        const options = this.cityOptions(k);
        return {
            straight: Boolean(options.straight),
            left: Boolean(options.left),
            right: Boolean(options.right),
            deadEnd: options.deadEnd,
            physicalEnd: options.physicalEnd,
            requiresChoice: options.requiresChoice,
        };
    }

    // --- карта города ---
    get along() {
        return this.cityReverse ? -this.cityOffset : this.cityOffset;
    }

    get vertical() {
        return Math.abs(this.dir[1]) >= Math.abs(this.dir[0]);
    }

    currentStreet() {
        return this.cityEdge.street;
    }

    compass() {
        const [dx, dy] = this.dir;
        return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "восток" : "запад" : dy < 0 ? "север" : "юг";
    }

    screenToWorld(screenY) {
        const ahead = this.bus.centerY - screenY;
        return this.cityGeometryAt(ahead).position;
    }

    // Только исходящие рёбра настоящего узла; ожидаемая улица маршрута имеет
    // приоритет, если несколько близких съездов оказываются с одной стороны.
    cityOptions(nodeId = this.nextCross().k) {
        const result = { left: null, right: null, straight: null };
        const choices = [];
        Object.defineProperty(result, "choices", { value: choices });
        const nextLeg = this.cityItinerary.legs[(this.cityLegIndex + 1) % this.cityItinerary.legs.length];
        const guide = this.cityOffRoute && this.cityRejoinGuide?.key === this.cityExitKey() ? this.cityRejoinGuide : null;
        const preferred = guide?.edge || nextLeg.edge.id;
        const exits = this.cityOrdinaryExits(this.cityEdge, this.cityReverse, nodeId)
            .sort((a, b) => Number(b.edge.id === preferred) - Number(a.edge.id === preferred));
        const automatic = this.cityAutomaticExit(this.cityEdge, this.cityReverse, exits, nodeId);
        const incoming = this.cityGraph.direction(this.cityEdge, this.cityReverse,
            nodeId === this.cityEdge.to ? this.cityEdge.length : 0);
        for (const option of exits) {
            const edge = option.edge;
            if (!this.cityGraph.canTurn(this.cityEdge, nodeId, edge, option.reverse)) continue;
            const direction = this.cityGraph.direction(edge, option.reverse);
            const dot = incoming[0] * direction[0] + incoming[1] * direction[1];
            const cross = incoming[0] * direction[1] - incoming[1] * direction[0];
            const continuation = exits.length === 1;
            const isAutomatic = automatic?.edge.id === edge.id && automatic.reverse === option.reverse;
            const side = isAutomatic ? "straight" : cross < 0 ? "left" : "right";
            const choice = { ...option, direction, node: nodeId, side,
                continuation, angle: Math.atan2(cross, dot) };
            choices.push(choice);
            if (!result[side]) result[side] = choice;
        }
        if (!choices.some((choice) => choice.edge.id === this.cityEdge.id && choice.reverse !== this.cityReverse) &&
            this.cityGraph.canTurn(this.cityEdge, nodeId, this.cityEdge, !this.cityReverse)) {
            choices.push({ edge: this.cityEdge, reverse: !this.cityReverse, node: nodeId,
                direction: incoming.map((value) => -value), side: "uturn", angle: Math.PI, continuation: false });
        }
        Object.defineProperties(result, {
            automatic: { value: result.straight },
            deadEnd: { value: exits.length === 0 },
            physicalEnd: { value: !(this.cityGraph.adjacent.get(nodeId) || []).some((edge) => edge.id !== this.cityEdge.id) },
            requiresChoice: { value: exits.length > 0 && !result.straight },
        });
        return result;
    }

    cityOrdinaryExits(edge, reverse, nodeId = this.cityGraph.endpoint(edge, reverse)) {
        return this.cityGraph.outgoingFrom(nodeId).filter((option) =>
            (option.edge.id !== edge.id || (edge.from === edge.to && option.reverse === reverse)) &&
            this.cityGraph.canTurn(edge, nodeId, option.edge, option.reverse));
    }

    cityAutomaticExit(edge, reverse, exits = this.cityOrdinaryExits(edge, reverse), nodeId = this.cityGraph.endpoint(edge, reverse)) {
        if (exits.length === 1) return exits[0];
        if (!exits.length) return null;
        const incoming = this.cityGraph.direction(edge, reverse, nodeId === edge.to ? edge.length : 0);
        const aligned = exits.map((option) => {
            const direction = this.cityGraph.direction(option.edge, option.reverse);
            const angle = Math.abs(Math.atan2(incoming[0] * direction[1] - incoming[1] * direction[0],
                incoming[0] * direction[0] + incoming[1] * direction[1]));
            return { option, angle, sameRoad: this.citySameRoad(edge, option.edge) };
        }).sort((a, b) => a.angle - b.angle || Number(b.sameRoad) - Number(a.sameRoad));
        const first = aligned[0], second = aligned[1];
        if (first.angle > Math.PI / 9) return null;
        if (second && second.angle - first.angle < 0.12 && !(first.sameRoad && !second.sameRoad)) return null;
        return first.option;
    }

    cityExitKey() { return `${this.cityEdge.id}:${this.cityReverse}:${this.nextCross().k}`; }

    selectedCityExit(options = this.cityOptions()) {
        const selection = this.cityExitSelection;
        if (selection?.key !== this.cityExitKey()) return null;
        return options.choices.find((choice) => choice.edge.id === selection.edge && choice.reverse === selection.reverse) || null;
    }

    cycleCityExit(step = 1) {
        const options = this.cityOptions(), choices = [...options.choices].sort((a, b) => a.angle - b.angle ||
            String(a.edge.id).localeCompare(String(b.edge.id)));
        if (!choices.length) {
            this.showBanner("Нет разрешённого выезда. M — карта города", ORANGE);
            return false;
        }
        const explicit = this.selectedCityExit(options);
        const next = this.cityItinerary.legs[(this.cityLegIndex + 1) % this.cityItinerary.legs.length];
        const current = explicit || choices.find((choice) => choice.edge.id === next.edge.id && choice.reverse === next.reverse) ||
            options.straight || choices[0];
        const index = choices.findIndex((choice) => choice.edge.id === current.edge.id && choice.reverse === current.reverse);
        const choice = choices[mod(index + step, choices.length)];
        this.cityExitSelection = { key: this.cityExitKey(), edge: choice.edge.id, reverse: choice.reverse };
        this.cityPendingTurn = null;
        this.showBanner(`Выбран съезд: ${choice.edge.street}. Езжай к перекрёстку`, BLUE, 140);
        return true;
    }

    exitSelectorRect() {
        const map = this.minimapRect();
        return rect(map.x + 4, map.y + map.h - 44, map.w - 8, 40);
    }

    cityRouteExit() {
        const key = this.cityExitKey();
        if (this.cityRejoinGuide?.key === key) return this.cityRejoinGuide;
        const queue = [], seen = new Set([`${this.cityEdge.id}:${this.cityReverse}`]);
        const add = (incoming, reverse, first) => {
            const node = this.cityGraph.endpoint(incoming, reverse);
            for (const option of this.cityGraph.outgoingFrom(node)) {
                const edge = option.edge, state = `${edge.id}:${option.reverse}`;
                if (seen.has(state) || !this.cityGraph.canTurn(incoming, node, edge, option.reverse)) continue;
                seen.add(state);
                queue.push({ ...option, first: first || option });
            }
        };
        add(this.cityEdge, this.cityReverse, null);
        for (let index = 0; index < queue.length && index < 30000; index++) {
            const option = queue[index];
            if (this.cityRouteDirections.has(`${option.edge.id}:${option.reverse}`)) {
                return this.cityRejoinGuide = { key, edge: option.first.edge.id, reverse: option.first.reverse };
            }
            add(option.edge, option.reverse, option.first);
        }
        return this.cityRejoinGuide = { key, edge: null };
    }

    // A visible road can cross many short source edges. Sample the same
    // connected ribbon on either side of a junction instead of clamping the
    // horizon to the current edge and redrawing it on the next frame.
    cityGeometryAt(distanceAhead = 0) {
        const graph = this.cityGraph, current = this.cityEdge;
        let cache = this.cityGeometryCache;
        if (!cache || cache.edge !== current || cache.reverse !== this.cityReverse ||
            cache.offset !== this.cityOffset || cache.selection !== this.cityExitSelection ||
            cache.pending !== this.cityPendingTurn) {
            const progress = this.cityReverse ? current.length - this.cityOffset : this.cityOffset;
            const segments = [{ edge: current, reverse: this.cityReverse, start: -progress, end: current.length - progress }];
            const history = this.cityGeometryHistory || [];
            for (let index = history.length - 1; index >= 0 && segments[0].start > -3000; index--) {
                const leg = history[index], next = segments[0];
                if (graph.endpoint(leg.edge, leg.reverse) !== graph.origin(next.edge, next.reverse)) break;
                segments.unshift({ ...leg, start: next.start - leg.edge.length, end: next.start });
            }
            let legIndex = this.cityOffRoute ? -1 : this.cityLegIndex;
            for (let step = 0; step < 256 && segments.at(-1).end < 3000; step++) {
                const leg = segments.at(-1), node = graph.endpoint(leg.edge, leg.reverse);
                const expectedIndex = legIndex < 0 ? -1 : (legIndex + 1) % this.cityItinerary.legs.length;
                const expected = expectedIndex < 0 ? null : this.cityItinerary.legs[expectedIndex];
                let option;
                if (step === 0) {
                    const options = this.cityOptions(node), selected = this.selectedCityExit(options);
                    const pending = this.cityPendingTurn?.node === node
                        ? options.choices.find((candidate) => candidate.edge.id === this.cityPendingTurn.edge && candidate.reverse === this.cityPendingTurn.reverse)
                        : null;
                    option = pending || selected || options.automatic;
                } else {
                    // Exactly the same mandatory-bend / unambiguous-forward
                    // policy used when the bus actually reaches this node.
                    option = this.cityAutomaticExit(leg.edge, leg.reverse);
                }
                if (!option || !this.cityCanContinue(leg.edge, leg.reverse, option)) break;
                segments.push({ edge: option.edge, reverse: option.reverse, start: leg.end, end: leg.end + option.edge.length });
                legIndex = expected && option.edge.id === expected.edge.id && option.reverse === expected.reverse ? expectedIndex : -1;
            }
            cache = this.cityGeometryCache = { edge: current, reverse: this.cityReverse, offset: this.cityOffset,
                selection: this.cityExitSelection, pending: this.cityPendingTurn, segments };
        }
        const segments = cache.segments;
        let lo = 0, hi = segments.length - 1;
        while (lo < hi) {
            const middle = (lo + hi) >> 1;
            if (segments[middle].end < distanceAhead) lo = middle + 1;
            else hi = middle;
        }
        const leg = segments[lo], travelled = clamp(distanceAhead - leg.start, 0, leg.edge.length);
        const offset = leg.reverse ? leg.edge.length - travelled : travelled;
        return { edge: leg.edge, reverse: leg.reverse, offset, start: leg.start, end: leg.end,
            position: graph.position(leg.edge, offset), dir: graph.direction(leg.edge, leg.reverse, offset) };
    }

    cityEnter(option, nodeId) {
        const history = this.cityGeometryHistory || (this.cityGeometryHistory = []);
        history.push({ edge: this.cityEdge, reverse: this.cityReverse });
        let retained = 0, first = history.length - 1;
        while (first >= 0 && retained < 8000) retained += history[first--].edge.length;
        if (first >= 0) history.splice(0, first + 1);
        this.cityGeometryCache = null;
        const legs = this.cityItinerary.legs;
        const nextIndex = (this.cityLegIndex + 1) % legs.length;
        const matches = (leg) => leg.edge.id === option.edge.id && leg.reverse === option.reverse;
        let index = matches(legs[nextIndex]) ? nextIndex : -1;
        if (index < 0) {
            for (let step = 0; step < legs.length; step++) {
                const candidate = (this.cityLegIndex + step) % legs.length;
                if (matches(legs[candidate])) { index = candidate; break; }
            }
        }
        this.cityOffRoute = index < 0;
        if (index >= 0) {
            if (index < this.cityLegIndex) this.cityLap++;
            this.cityLegIndex = index;
        }
        this.cityEdge = option.edge;
        this.cityReverse = option.reverse;
        this.cityOffset = option.reverse ? option.edge.length : 0;
        this.dir = this.cityGraph.direction(option.edge, option.reverse, this.cityOffset);
        [this.wx, this.wy] = this.cityGraph.position(this.cityEdge, this.cityOffset);
        this.streetK = this.cityEdge.index;
        if (this.cityEdge.district && DISTRICTS[this.cityEdge.district]) this.district = this.cityEdge.district;
        this.spawnedLines = new Set([nodeId]);
        this.trail.push([this.wx, this.wy]);
        this.cityPendingTurn = null;
        this.cityExitSelection = null;
        this.cityRejoinGuide = null;
    }

    cityTurnaround() {
        if (this.cityOffRoute) return false;
        const next = this.cityItinerary.legs[(this.cityLegIndex + 1) % this.cityItinerary.legs.length];
        return next.edge.id === this.cityEdge.id && next.reverse !== this.cityReverse &&
            this.cityOrdinaryExits(this.cityEdge, this.cityReverse).length === 0;
    }

    citySameRoad(first, second) {
        return (first.street === second.street && !/^безымян/i.test(first.street || "")) ||
            (first.osmWayIds || []).some((id) => (second.osmWayIds || []).includes(id));
    }

    cityCanContinue(edge, reverse, next) {
        const nodeId = this.cityGraph.endpoint(edge, reverse);
        if (!next || this.cityGraph.origin(next.edge, next.reverse) !== nodeId ||
            !this.cityGraph.canTurn(edge, nodeId, next.edge, next.reverse)) return false;
        const automatic = this.cityAutomaticExit(edge, reverse);
        return automatic?.edge.id === next.edge.id && automatic.reverse === next.reverse;
    }

    cityContinue(option, nodeId) {
        this.cityEnter(option, nodeId);
        // Последняя остановка за автобусом остаётся до конца проезда, чтобы
        // не пропустить высадку/штраф. Впереди старого ребра объектов нет.
        this.stops = this.stops.filter((stop) => stop.cityTravel !== undefined || stop.centerY >= this.bus.centerY);
        this.inters = this.inters.filter((inter) => inter.y + inter.h >= this.bus.centerY);
        for (const key of ["ramps", "posts", "crosswalks", "bridges", "stations"]) {
            this[key] = this[key].filter((object) => object.y >= this.bus.centerY);
        }
        setRoad(this.cityEdge.lanes);
        for (const stop of this.stops) stop.edge = ROAD_RIGHT - this.closedW(stop.centerY);
    }

    // Общая точка движения для обычной езды и конвоя: нельзя выехать за
    // конец ребра или оказаться на другой улице без общего перекрёстка.
    advanceCity(distance) {
        if (distance < 0) {
            const room = this.cityReverse ? this.cityEdge.length - this.cityOffset : this.cityOffset;
            const moved = Math.max(distance, -room);
            this.cityOffset += this.cityReverse ? -moved : moved;
            this.cityTravel += moved;
            [this.wx, this.wy] = this.cityGraph.position(this.cityEdge, this.cityOffset);
            this.dir = this.cityGraph.direction(this.cityEdge, this.cityReverse, this.cityOffset);
            if (moved !== distance) this.bus.speed = moved;
            return moved;
        }
        let remaining = distance, moved = 0;
        // Несколько коротких OSM-участков могут уместиться в один физический
        // шаг. Проходим их итеративно, не теряя остаток пути и остановки.
        for (let step = 0; step < 10000 && remaining > 0; step++) {
            this.spawnCityStops();
            const room = this.cityReverse ? this.cityOffset : this.cityEdge.length - this.cityOffset;
            const amount = Math.min(remaining, room);
            this.cityOffset += this.cityReverse ? -amount : amount;
            this.cityTravel += amount;
            moved += amount;
            remaining -= amount;
            [this.wx, this.wy] = this.cityGraph.position(this.cityEdge, this.cityOffset);
            this.dir = this.cityGraph.direction(this.cityEdge, this.cityReverse, this.cityOffset);
            if (amount < room) break;
            const nodeId = this.nextCross().k, options = this.cityOptions(nodeId);
            const pending = this.cityPendingTurn;
            if (pending?.node === nodeId) {
                const inter = this.inters.find((item) => item.k === nodeId) || pending.inter;
                const choice = options.choices.find((item) => item.edge.id === pending.edge && item.reverse === pending.reverse);
                if (choice && this.startTurn(pending.sign, inter, choice)) break;
                this.cityPendingTurn = null;
            }
            const selected = this.selectedCityExit(options);
            if (selected) {
                if (selected.side === "straight") { this.cityContinue(selected, nodeId); continue; }
                const inter = this.inters.find((item) => item.k === nodeId) ||
                    new Intersection(this.bus.centerY - 100, nodeId, selected.edge.street, selected.edge.lanes, this.arms(nodeId));
                this.startTurn(selected.angle < 0 ? -1 : 1, inter, selected);
                break;
            }
            if (options.automatic) {
                this.cityContinue(options.automatic, nodeId);
                continue;
            }
            const turnaround = options.choices.find((choice) => choice.side === "uturn");
            if (options.deadEnd && turnaround) {
                const terminal = this.inters.find((inter) => inter.k === nodeId) ||
                    new Intersection(this.bus.centerY - 100, nodeId, this.currentStreet(), 2,
                        { left: false, right: true, straight: false });
                this.startTurn(1, terminal, turnaround);
                this.showBanner("Конец разрешённого проезда. Разворот", YELLOW);
            } else {
                this.bus.speed = 0;
                if (!options.choices.length && this.frame % 90 === 0) {
                    this.showBanner("Дальше нет разрешённой дороги. M — карта, Esc — меню", ORANGE);
                }
            }
            break;
        }
        return moved;
    }

    cityNavigation() {
        const legs = this.cityItinerary.legs, next = legs[(this.cityLegIndex + 1) % legs.length];
        const guide = this.cityOffRoute ? this.cityRouteExit() : null;
        const options = this.cityOptions(), selected = this.selectedCityExit(options);
        const expected = options.choices.find((choice) => choice.edge.id === (guide?.edge || next.edge.id) &&
            choice.reverse === (guide?.edge ? guide.reverse : next.reverse));
        const choice = selected || expected;
        if (!choice) return options.choices.length ? "Q/E или нажми на подсказку — выбери выезд" : "Нет разрешённого выезда · M: карта";
        const arrow = { left: "←", right: "→", straight: "↑", uturn: "↶" }[choice.side];
        const distance = Math.max(0, this.nextCross().a - this.along);
        const prefix = selected ? "Выбран: " : this.cityOffRoute ? "К маршруту: " : "";
        return `${prefix}${arrow} ${choice.edge.street} · ${Math.round(distance * METERS_PER_PX)} м`;
    }

    spawnCityStops() {
        const legs = this.cityItinerary.legs;
        const progress = this.cityReverse ? this.cityEdge.length - this.cityOffset : this.cityOffset;
        const visible = [{ edge: this.cityEdge, reverse: this.cityReverse, start: -progress,
            leg: this.cityOffRoute ? null : legs[this.cityLegIndex], index: this.cityLegIndex, lap: this.cityLap }];
        // Короткое ребро не скрывает остановку до въезда в него. Смотрим по
        // продолжению улицы, но не рисуем за углом ещё не выбранного поворота.
        if (!this.cityOffRoute) for (let count = 1; count <= legs.length; count++) {
            const previous = visible.at(-1), index = (this.cityLegIndex + count) % legs.length;
            const leg = legs[index], start = previous.start + previous.edge.length;
            if (start > this.bus.centerY + 800 || !this.cityCanContinue(previous.edge, previous.reverse, leg)) break;
            visible.push({ edge: leg.edge, reverse: leg.reverse, start, leg, index,
                lap: this.cityLap + Math.floor((this.cityLegIndex + count) / legs.length) });
        }
        const definitions = [];
        for (const segment of visible) {
            if (segment.leg) for (const stop of segment.leg.stops) {
                const id = segment.lap * this.cityItinerary.stopCount + stop.sequence;
                definitions.push({ ...stop, id, key: `ours:${id}`, route: this.route.num, segment });
            }
            for (const [number, route] of Object.entries(this.cityGraph.data.routes)) {
                if (number === this.route.num) continue;
                for (const [index, stop] of [...(route.stops || []), ...(route.returnStops || [])].entries()) {
                    if (stop.edge === segment.edge.id && (stop.reverse ?? false) === segment.reverse &&
                        !definitions.some((own) => own.segment === segment && own.name === stop.name && Math.abs(own.at - stop.at) < 0.04)) {
                        definitions.push({ ...stop, id: null, segment,
                            key: `other:${number}:${index}:${segment.lap}:${segment.index}`, route: number });
                    }
                }
            }
        }
        for (const definition of definitions) {
            if (this.spawnedCityStops.has(definition.key)) continue;
            const segment = definition.segment;
            const offset = definition.offset ?? definition.at * segment.edge.length;
            const ahead = segment.start + (segment.reverse ? segment.edge.length - offset : offset);
            if (ahead < -BusStop.HEIGHT || ahead > this.bus.centerY + 500) continue;
            const y = this.bus.centerY - ahead - BusStop.HEIGHT / 2;
            // В отличие от случайного спавна остановка не переезжает дальше
            // из-за поста/трамплина: необязательные объекты уступают её месту.
            this.ramps = this.ramps.filter((ramp) => Math.abs(ramp.y - y) > 500);
            this.posts = this.posts.filter((post) => Math.abs(post.y - y) > 600);
            this.crosswalks = this.crosswalks.filter((crosswalk) => Math.abs(crosswalk.y - y) > 400);
            const stop = new BusStop(definition.id, y, this.route, this.rep, definition);
            stop.edge = ROAD_RIGHT - this.closedW(stop.centerY);
            stop.cityEdge = segment.edge.id;
            stop.cityOffset = offset;
            stop.cityTravel = this.cityTravel + ahead;
            this.stops.push(stop);
            this.spawnedCityStops.add(definition.key);
            if (definition.id !== null) this.nextStopId = Math.max(this.nextStopId, definition.id + 1);
        }
    }

    spawnCityBridge() {
        if (!/мост/i.test(this.cityEdge.street) || this.bridges.some((bridge) => bridge.cityEdge === this.cityEdge.id)) return;
        const h = Math.max(500, this.cityEdge.length - 900);
        const offset = this.cityEdge.length / 2;
        const ahead = (offset - this.cityOffset) * (this.cityReverse ? -1 : 1);
        if (ahead > h / 2 + this.bus.centerY + 1000 || ahead < -h / 2 - 500) return;
        const bridge = new Bridge(this.bus.centerY - ahead - h / 2, h);
        bridge.cityEdge = this.cityEdge.id;
        this.bridges.push(bridge);
    }

    // --- вспомогательное ---
    showBanner(str, color = WHITE, frames = 150) {
        this.banner = { str, color, frames };
    }

    floatText(str, x, y, color, big = false) {
        this.texts.push(new FloatText(str, x, y, color, big));
    }

    burst(x, y, color, count, speed = 3, size = 4, life = 40, world = true, gravity = 0) {
        for (let i = 0; i < count; i++) {
            const a = rand(0, Math.PI * 2), v = rand(0.3, 1) * speed;
            this.particles.push(new Particle(x, y, Math.cos(a) * v, Math.sin(a) * v,
                randint(Math.floor(life / 2), life), color, rand(size * 0.5, size), 0, world, gravity));
        }
    }

    stunt(name, base) {
        // Трюк: деньги с множителем комбо
        this.combo = this.comboTimer > 0 ? Math.min(MAX_COMBO, this.combo + 1) : 1;
        this.comboTimer = COMBO_TIME;
        const amount = base * this.combo;
        this.money += amount;
        this.stunts += 1;
        const bus = this.bus;
        this.floatText(`${name}  +${amount}` + (this.combo > 1 ? `  x${this.combo}` : ""), bus.x, bus.y - 40, PINK, true);
        this.burst(bus.x, bus.centerY, PINK, 18, 5, 4, 35);
        this.coins.push(new Coin(bus.x, bus.y));
    }

    addComplaints(n, why) {
        this.complaints += n;
        this.money -= COMPLAINT_FINE * n;
        this.addRep(-n);
        this.showBanner(`${why} Жалоб: ${this.complaints}/${MAX_COMPLAINTS}`, RED);
        this.floatText(`Жалоба x${n}!`, this.bus.x, this.bus.y - 10, RED, true);
        this.shake = Math.max(this.shake, 6);
        if (this.complaints >= MAX_COMPLAINTS) this.finish("fired");
    }

    stopNearBus() {
        // Остановка, у которой маршрутка сейчас стоит (своя или чужая)
        // маршрутка должна целиком заехать в карман
        const bus = this.bus, r = bus.rect;
        if (Math.abs(bus.speed) > 0.3 || bus.air) return null;
        return this.stops.find((s) => r.x + r.w >= s.edge + BAY_W - 18 &&
            bus.y > s.y + 20 && bus.y + bus.h < s.y + BusStop.HEIGHT - 20) || null;
    }

    // --- ширина дороги по ходу улицы: сколько пикселей с каждого края занято парковкой ---
    closedW(y) {
        return (LANES / 2 - this.openAt(y)) * LANE_W;
    }

    // как оформлены закрытые полосы на высоте y: плитка или парковка у дороги
    styleAt(y) {
        let val = this.styleBelow;
        for (const t of [...this.shifts].sort((a, b) => b.y - a.y)) {
            if (y > t.y) return val;
            val = t.style;
        }
        return val;
    }

    // сколько полос на сторону открыто на высоте y (дробно — на скосе)
    openAt(y) {
        const distance = this.bus.centerY - y, radius = 900;
        this.cityGeometryAt(distance);
        const legs = this.cityGeometryCache.segments;
        // Convolve source lane counts over a 58m ribbon. Even very short OSM
        // fragments blend continuously rather than replacing the road width.
        const cumulative = (value) => value <= -radius ? 0 : value >= radius ? 1
            : value < 0 ? (value + radius) ** 2 / (2 * radius ** 2)
                : 1 - (radius - value) ** 2 / (2 * radius ** 2);
        let result = 0;
        for (const leg of legs) {
            if (leg.end < distance - radius || leg.start > distance + radius) continue;
            result += leg.edge.lanes / 2 * (cumulative(leg.end - distance) - cumulative(leg.start - distance));
        }
        result += legs[0].edge.lanes / 2 * cumulative(legs[0].start - distance);
        result += legs.at(-1).edge.lanes / 2 * (1 - cumulative(legs.at(-1).end - distance));
        return clamp(result, 1, LANES / 2);
    }

    closedLanesAt(y) {
        return Math.ceil(this.closedW(y) / LANE_W - 0.05);
    }

    laneOpen(lane, y0, y1 = y0) {
        for (let y = Math.min(y0, y1); ; y += 40) {
            const c = this.closedLanesAt(Math.min(y, Math.max(y0, y1)));
            if (lane < c || lane >= LANES - c) return false;
            if (y >= Math.max(y0, y1)) return true;
        }
    }

    // самая широкая «закрытость» вдоль маршрутки — от неё зависят границы руля
    busClosed() {
        const bus = this.bus;
        return Math.max(this.closedW(bus.y + 4), this.closedW(bus.centerY), this.closedW(bus.y + bus.h - 4));
    }

    // насколько маршрутке можно заехать вправо за край дороги (в карман остановки)
    bayExtra() {
        const bus = this.bus;
        const at = (y) => Math.max(0, ...this.stops.map((s) => BAY_W * clamp(Math.min(y - s.y, s.y + BusStop.HEIGHT - y) / BusStop.TAPER, 0, 1)));
        return Math.min(at(bus.y + 4), at(bus.y + bus.h - 4));
    }

    currentStop() {
        const s = this.stopNearBus();
        return s && s.ours ? s : null;
    }

    boardingCount() {
        return this.walkers.filter((w) => w.kind === "in" && !w.returning).length;
    }

    // гудок: машина впереди уступает полосу или ускоряется, пешеходы на зебре торопятся.
    // если сигналить без конца — пассажиры жалуются
    honk() {
        if (this.state !== "play" || this.hornCool > 0) return;
        this.hornCool = 20;
        this.hornT = 26;
        hornSound();
        const bus = this.bus;
        this.floatText("БИП!", bus.x, bus.y - 24, [255, 180, 80]);
        for (const car of this.cars) {
            const gap = bus.y - (car.y + CAR_H);
            if (car.dir > 0 || car.cop || car.wreck || gap < -20 || gap > 360 || Math.abs(car.x - bus.x) > LANE_W * 0.8) continue;
            car.hurry = 150;
            if (car.changing) continue;
            for (const target of [car.lane + 1, car.lane - 1]) {
                if (target < ownFirst() || target >= LANES || !this.laneOpen(target, car.y - 300, car.y + CAR_H)) continue;
                if (!this.laneFreeFor(car, target)) continue;
                car.targetLane = target;
                car.blink = 10;
                break;
            }
        }
        for (const lane of [...this.crosswalks.map((c) => c.peds), ...this.inters.map((i) => i.peds)]) {
            for (const p of lane.peds) p.speed = Math.max(p.speed, 2.6);
        }
        this.honks = (this.honks || []).filter((f) => this.frame - f < 600);
        this.honks.push(this.frame);
        if (this.honks.length >= 6 && this.passengers.length) {
            this.honks = [];
            this.addComplaints(1, "Пассажиры: хватит сигналить!");
        }
    }

    // задание выполнено: большая надпись по центру, премия и репутация
    missionComplete(title, money = 0, rep = 0) {
        this.money += money;
        if (rep) {
            this.repDelta += rep;
            this.repPopup = null;
        }
        this.notice = { title, money, rep, frames: 200 };
        if (money) this.coins.push(new Coin(WIDTH / 2, HEIGHT / 2));
    }

    // изменение репутации за рейс; всплывает табличка «Репутация +N» под звёздами
    addRep(n) {
        this.repDelta += n;
        if (this.repPopup && this.repPopup.frames > 30 && Math.sign(this.repPopup.n) === Math.sign(n)) this.repPopup.n += n;
        else this.repPopup = { n, frames: 0 };
        this.repPopup.frames = 150;
    }

    removeComplaint(why) {
        this.addRep(1);
        if (!this.complaints) return;
        this.complaints -= 1;
        this.floatText(`−1 жалоба: ${why}`, this.bus.x, this.bus.y - 50, GREEN, true);
    }

    get stars() {
        return Math.ceil(this.wanted - 0.001);
    }

    // нарушение: ДПС замечает его с шансом chance (блат снижает шанс) и добавляет звёзды розыска
    startChase(reason, chance = 1, stars = 1) {
        if (this.serverTrafficActive) return;
        if (Math.random() > chance * (1 - 0.12 * this.level("blat")) * (1.15 - 0.3 * this.rep / 100)) {
            this.floatText("ДПС не заметили...", this.bus.x, this.bus.y + this.bus.h + 10, BLUE);
            return;
        }
        this.wanted = Math.min(MAX_STARS, Math.ceil(this.wanted - 0.001) + stars);
        this.addRep(-stars);
        this.showBanner(`ДПС: ${reason}! Розыск ${"★".repeat(this.stars)}`, [120, 170, 255]);
        if (this.police && !this.police.leaving) return;
        this.spawnPolice();
    }

    // поймали: дать взятку (если хватает денег рейса); честный инспектор не возьмёт — тогда в отдел
    payBribe() {
        const c = this.caught;
        if (this.state !== "caught" || this.money < c.bribe) return;
        if (Math.random() < HONEST_COP) {
            this.showBanner("Инспектор оказался честным! Едем в отдел", RED, 200);
            this.addRep(-1);
            this.goToStation(true);
            return;
        }
        this.money -= c.bribe;
        this.wanted = 0;
        this.addRep(-1);
        this.floatText(`Взятка -${c.bribe} ₽`, this.bus.x, this.bus.y - 30, ORANGE, true);
        this.showBanner("«Езжайте, и чтобы я вас больше не видел»", [230, 230, 150]);
        this.caught = null;
        this.state = "play";
    }

    // отдел полиции: полный штраф, протокол и полтора часа смены; на 5★ — лишение прав
    goToStation(attempted = false) {
        const c = this.caught;
        if (this.state !== "caught") return;
        this.wanted = 0;
        const fine = c.fine * (attempted ? 2 : 1);           // попытка взятки — штраф вдвойне
        this.money -= fine;
        if (c.stars >= MAX_STARS) {
            this.finish("arrested");
            return;
        }
        this.complaints += 1;
        this.addRep(-1);
        // сначала едем за машиной ДПС (если впереди не тупик), потом сцена в отделе; часы крутятся там
        const deadEnd = this.inters.some((i) => !i.arms.straight && i.y > -900);
        this.station = { t: 0, escort: deadEnd ? 0 : ESCORT_FRAMES, fine, from: this.clock };
        if (!this.police) this.spawnPolice();
        this.police.leaving = false;
        this.caught = null;
        this.state = "station";
        if (!deadEnd) this.showBanner("Едем в отдел за машиной ДПС...", [120, 170, 255], ESCORT_FRAMES);
    }

    spawnPolice() {
        if (this.serverTrafficActive) return;
        this.police = new Police(this.bus.x, Math.max(this.bus.speed, 0) + 2);
        this.floatText("ДПС!", this.bus.x, this.bus.y + this.bus.h + 20, [120, 170, 255], true);
    }

    // ушёл от погони: минус звезда; если звёзд ещё много — ДПС вернётся
    escapePolice(name) {
        if (this.stars >= 3) this.missionComplete("ОТОРВАЛСЯ!");
        this.police.leaving = true;
        this.wanted = Math.max(0, Math.ceil(this.wanted - 0.001) - 1);
        this.policeReturn = this.heli ? 60 * 5 : POLICE_RETURN;    // с вертолёта видно — вернутся быстро
        this.stunt(name, 50);
        this.showBanner(this.stars ? `Оторвался, но розыск ${"★".repeat(this.stars)} — не нарушай` : "Ушёл от погони!", PINK);
    }

    // розыск гаснет, пока ДПС не на хвосте и ты не превышаешь; при 2+ звёздах ДПС возвращается
    updateWanted() {
        if (this.serverTrafficActive) return;
        const bus = this.bus, stars = this.stars;
        // 3★ — вертолёт: за углом не скрыться, розыск не гаснет, пока он висит над тобой
        if (stars >= 3 && !this.heli) {
            this.heli = new Helicopter(bus.x);
            this.showBanner("Вертолёт ДПС в воздухе!", [120, 170, 255]);
        }
        if (this.heli) {
            if (stars < 3) this.heli.leaving = true;
            // висит впереди и сбоку, чтобы не закрывать маршрутку; прожектор всё равно на ней
            this.heli.update(bus.x + (bus.x < 300 ? 150 : -150), bus.y - 170, this.frame);
            if (this.heli.gone) this.heli = null;
        }
        // 4★ — блокпосты впереди: машины ДПС поперёк дороги, свободна одна полоса
        if (stars >= 4 && --this.roadblockIn <= 0) this.spawnRoadblock();
        const chasing = this.police && !this.police.leaving;
        if (chasing || !this.wanted) return;
        if (!this.heli && bus.speed * KMH <= SPEED_LIMIT && this.wrongWay === 0) this.wanted = Math.max(0, this.wanted - 1 / STAR_DECAY);
        if (!this.police && this.stars >= 2 && --this.policeReturn <= 0) {
            this.spawnPolice();
            this.showBanner(`ДПС снова на хвосте! ${"★".repeat(this.stars)}`, [120, 170, 255]);
        }
    }

    spawnRoadblock() {
        if (this.serverTrafficActive) return;
        this.roadblockIn = 60 * 9;
        const y = -CAR_H - 60;
        if (!this.areaFree(y, CAR_H) || this.inters.some((i) => i.y < 200)) {
            this.roadblockIn = 60;
            return;
        }
        const c = this.closedLanesAt(y), lanes = [];
        for (let l = c; l < LANES - c; l++) lanes.push(l);
        const gap = randint(ownFirst(), LANES - 1 - c);
        for (const l of lanes) {
            if (l === gap) continue;
            const car = new Car(l, y, 0, -1);
            car.cop = true;
            this.cars.push(car);
        }
        this.cars = this.cars.filter((o) => o.cop || Math.abs(o.y - y) > CAR_H * 1.5);
        this.showBanner("Блокпост ДПС впереди! Ищи свободную полосу", RED);
    }

    // --- спавн ---
    laneBlockedByBus(lane) {
        return Math.abs(this.bus.x - laneCenter(lane)) < (LANE_W + this.bus.w) / 2;
    }

    areaFree(top, height) {
        // Нет ли рядом остановки/перекрёстка/поста/трамплина
        const things = [
            ...this.stops.map((s) => [s.y - 40, BusStop.HEIGHT + 40]),
            ...this.inters.map((i) => [i.y - 40, i.h + 230]),
            ...this.posts.map((p) => [p.y, 380]),
            ...this.ramps.map((r) => [r.y, Ramp.H]),
            ...this.crosswalks.map((c) => [c.y - 20, Crosswalk.H + 60]),
            ...this.bridges.map((b) => [b.y - 30, b.h + 60]),
            // на скосах сужений ничего не ставим, внутри участка — можно
            ...this.shifts.map((t) => [t.y - LaneShift.TAPER / 2 - 20, LaneShift.TAPER + 40]),
            ...this.stations.map((st) => [st.y - 20, PoliceStation.HEIGHT + 40]),
        ];
        return things.every(([y, h]) => top + height + 120 < y || y + h + 120 < top);
    }

    spawnObjects() {
        // Перекрёстки и остановки привязаны к графу, а не к случайной сетке.
        const nx = this.nextCross();
        if (!this.spawnedLines.has(nx.k) && nx.a - this.along < this.bus.centerY + 900) {
            this.spawnedLines.add(nx.k);
            const arms = this.arms(nx.k);
            const options = this.cityOptions(nx.k);
            const sourceSignal = this.cityGraph.nodes.get(nx.k)?.osmTags?.highway === "traffic_signals";
            if (arms.left || arms.right || !arms.straight || sourceSignal) {
                const cross = options.left || options.right;
                const lanes = cross?.edge.lanes || 2, h = roadWidthFor(lanes);
                const y = this.bus.centerY - (nx.a - this.along) - h / 2;
                const name = cross?.edge.street || options.automatic?.edge.street || (options.deadEnd ? "Конец проезда" : "Перекрёсток");
                const inter = new Intersection(y, nx.k, name, lanes, arms);
                inter.cityTravel = this.cityTravel + (nx.a - this.along);
                inter.closed = this.closedLanesAt(y + h / 2);
                this.inters.push(inter);
            }
        }
        this.spawnCityStops();
        this.spawnCityBridge();
        if (this.serverTrafficActive) return;
        if (this.inters.some((i) => !i.arms.straight && i.y > -200)) {
            // впереди тупик: за ним ничего не появляется
            for (const k in this.nextIn) this.nextIn[k] = Math.max(this.nextIn[k], 300);
        }

        const s = this.bus.speed, route = this.route;
        for (const k in this.nextIn) this.nextIn[k] -= s;
        if (this.nextIn.cross <= 0) {
            const y = -Crosswalk.H - 80;
            if (this.areaFree(y, Crosswalk.H)) {
                this.crosswalks.push(new Crosswalk(y, route.traffic));
                this.nextIn.cross = rand(1800, 3200) / route.traffic;
            } else this.nextIn.cross = 200;
        }
        if (this.nextIn.station <= 0) {
            const y = -PoliceStation.HEIGHT - 80;
            if (this.areaFree(y, PoliceStation.HEIGHT)) {
                this.stations.push(new PoliceStation(y, ROAD_RIGHT - this.closedW(y + PoliceStation.HEIGHT / 2)));
                this.nextIn.station = rand(12000, 22000);
            } else this.nextIn.station = 300;
        }
        if (this.nextIn.ramp <= 0) {
            const y = -Ramp.H - 60;
            if (this.areaFree(y, Ramp.H)) {
                const c = this.closedLanesAt(y);
                this.ramps.push(new Ramp(randint(ownFirst(), LANES - 1 - c), y));
                this.nextIn.ramp = rand(3000, 5500);
            } else this.nextIn.ramp = 200;
        }
        if (this.nextIn.post <= 0) {
            const y = -PolicePost.HEIGHT - 60;
            if (this.areaFree(y, 380) && !this.police) {
                this.posts.push(new PolicePost(y));
                this.nextIn.post = rand(6000, 9000) / route.post;
            } else this.nextIn.post = 300;
        }
    }

    spawnCar() {
        if (this.serverTrafficActive) return;
        const oncoming = this.cityGraph.canTraverse(this.cityEdge, !this.cityReverse) && Math.random() < 0.45;
        const lane = oncoming ? randint(0, ownFirst() - 1) : randint(ownFirst(), LANES - 1);
        const speed = rand(3, 8);
        let y;
        if (oncoming) {
            // встречка едет навстречу — появляется сверху (если впереди не тупик)
            if (this.inters.some((i) => !i.arms.straight && i.y + i.h > -CAR_H)) return;
            y = -CAR_H - 20;
        } else if (this.bus.speed > speed) y = -CAR_H - 20;
        else {
            if (this.laneBlockedByBus(lane)) return;
            y = HEIGHT + 20;
        }
        if (!this.laneOpen(lane, y, y + CAR_H)) return;        // полоса тут занята парковкой
        for (const c of this.cars) {
            if ((c.lane === lane || c.targetLane === lane) && Math.abs(c.y - y) < CAR_H * 2.2) return;
        }
        this.cars.push(new Car(lane, y, speed, oncoming ? 1 : -1));
    }

    // --- поворот на перекрёстке ---
    tryTurn() {
        const bus = this.bus;
        const steer = this.keys.right - this.keys.left;
        if (bus.air || bus.speed < 0) return;
        const nodeId = this.nextCross().k, options = this.cityOptions(nodeId);
        const selected = this.selectedCityExit(options);
        const inter = this.inters.find((item) => item.k === nodeId && item.contains(bus.centerY));
        if (!inter) return;
        if (!steer && selected && selected.side !== "straight") {
            this.startTurn(selected.angle < 0 ? -1 : 1, inter, selected);
            return;
        }
        if (!steer) return;
        // направо — прижавшись к правому краю, налево — из левой своей полосы (или со встречки)
        const [, right] = bus.xLimits;
        const ready = steer < 0 ? bus.x <= laneCenter(ownFirst()) + 6 : bus.x >= right - 1;
        if (!ready) return;
        const side = steer > 0 ? "right" : "left";
        const choice = selected?.side === side || selected?.side === "uturn" ? selected : options[side];
        if (choice) this.startTurn(steer, inter, choice);
    }

    startTurn(sign, inter, terminalOption = null) {
        const bus = this.bus;
        const nodeId = this.nextCross().k;
        const options = this.cityOptions(nodeId);
        const option = terminalOption || options[sign > 0 ? "right" : "left"];
        const remaining = this.cityReverse ? this.cityOffset : this.cityEdge.length - this.cityOffset;
        if (!option || inter.k !== nodeId ||
            !options.choices.some((choice) => choice.edge.id === option.edge.id && choice.reverse === option.reverse) ||
            this.cityGraph.origin(option.edge, option.reverse) !== nodeId ||
            !this.cityGraph.canTurn(this.cityEdge, nodeId, option.edge, option.reverse) ||
            remaining > Math.max(inter.h / 2 + 30, 240)) return false;
        if (remaining > 0.001) {
            this.cityPendingTurn = { sign, node: nodeId, inter, edge: option.edge.id, reverse: option.reverse };
            return true;
        }
        window.citySession?.captureTurn(this);
        // снимок старой улицы: во время поворота камера плавно доворачивает с неё на новую
        this.drawWorld(false);
        this.snapshot.getContext("2d").drawImage(canvas, 0, 0);
        this.turnStart = [bus.x, bus.centerY];
        this.turnTotal = this.turnT = Math.round(clamp(300 / Math.max(bus.speed, 3), 34, 80));
        this.turnSign = sign;
        this.turnAngle = option.angle;
        this.state = "turning";
        const drift = bus.speed > 8;
        const oldStreet = this.currentStreet(), oldLanes = LANES;
        // ДПС далеко позади — потеряли маршрутку за углом
        const lost = !this.heli && this.police && !this.police.leaving && this.police.y > bus.y + bus.h + 100 + 60 * this.stars;

        // Обе улицы сходятся именно в этом узле: координаты не перескакивают
        // на улицу с тем же индексом в другом конце бесконечной сетки.
        this.cityEnter(option, nodeId);
        this.cameraDir = [...this.dir];
        setRoad(this.cityEdge.lanes);
        this.turns += 1;

        // Остановки остаются на своих улицах. На новой улице появятся только
        // закреплённые за её ребром остановки текущего направления рейса.
        this.cars = [];
        this.stops = this.stops.filter((stop) => stop.cityTravel !== undefined && stop.cityTravel <= this.cityTravel);
        this.ramps = [];
        this.posts = [];
        this.crosswalks = [];
        this.bridges = [];
        this.walkers = [];
        this.skids = [];
        this.particles = this.particles.filter((p) => !p.world);
        this.texts = [];
        this.newStrips();
        this.scenery = new Scenery(this);
        // перекрёсток, с которого съехали: старая улица теперь поперечная, она позади маршрутки
        this.spawnedLines = new Set([nodeId]);
        const ni = new Intersection(bus.centerY + 40, nodeId, oldStreet, oldLanes, this.arms(nodeId));
        ni.cityTravel = this.cityTravel;
        ni.t = 0;
        ni.passed = true;
        this.inters = [ni];
        this.nextIn = { stop: 900, ramp: rand(1500, 3500), post: rand(2500, 6000), cross: rand(900, 2000), bridge: 1500, zone: rand(800, 2500), station: rand(4000, 12000) };
        this.stations = [];
        this.shifts = [];
        this.openBelow = LANES / 2 - CLOSED;
        this.styleBelow = this.serverTrafficActive ? "tiles" : choice(["tiles", "parking"]);
        if (this.motorcade) {              // свернул — перекрытие осталось на старой улице
            this.motorcade = null;
            this.showBanner("Объехал перекрытие!", GREEN);
        }
        ni.closed = CLOSED;
        bus.vx = 0;
        if (this.police) {
            this.police.y = HEIGHT + 120;
            this.police.x = bus.x;
            if (lost) this.escapePolice("Скрылся за углом!");
        }
        this.showBanner(`Поворот ${sign > 0 ? "направо" : "налево"}: ${this.currentStreet()}`, BLUE);
        if (drift) this.stunt("Дрифт-поворот!", 120);
        return true;
    }

}
