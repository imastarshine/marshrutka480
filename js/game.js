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
        this.unifiedWorld = true;
        if (this.cityMapGeometry?.graph !== this.cityGraph) this.cityMapGeometry = new CityMapGeometry(this.cityGraph);
        if (this.localTraffic?.graph !== this.cityGraph || this.localTraffic?.geometry !== this.cityMapGeometry) {
            this.localTraffic = new LocalCityTraffic(this.cityGraph, this.cityMapGeometry);
        }
        if (this.cityCrossings?.graph !== this.cityGraph) this.cityCrossings = new CityCrossings(this.cityGraph,this.cityMapGeometry);
        if(this.cityEvents?.graph!==this.cityGraph)this.cityEvents=new CityRoadEvents(this.cityGraph,this.cityMapGeometry);
        this.cityEvents.resetShift();
        this.cityCamera = new CityCamera();
        this.cityActorFrame = -1; this.cityActors = [];
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
        this.cityPlannedSelections = new Map();
        this.cityWorldCommitted = new Map();
        this.cityPlanRevision = 0;
        this.cityRejoinGuide = null;
        this.cityGeometryHistory = [];
        this.cityGeometryCache = null;
        this.cityDrivingCache = null;
        this.cityNavigationCache = null;
        this.cityRouteDirections = new Set(this.cityItinerary.legs.map((leg) => `${leg.edge.id}:${leg.reverse}`));
        this.cityRouteEdges = new Set(this.cityItinerary.legs.map((leg) => leg.edge.id));
        this.mapOverview = false;
        this.mapPausedRun = false;
        this.dir = this.cityGraph.direction(this.cityEdge, this.cityReverse, this.cityOffset);
        this.cameraDir = [...this.dir];
        [this.wx, this.wy] = this.cityGraph.position(this.cityEdge, this.cityOffset);
        this.lastGoodRoadPose = { edge: this.cityEdge.id, reverse: this.cityReverse, offset: this.cityOffset,
            travel: this.cityTravel, wx: this.wx, wy: this.wy };
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
        this.lastCollision = null;
        this.bugReportStatus = "";
        this.finishedCrashSave = null;
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
        this.motorcadeAt = this.unifiedWorld ? null : randint(9 * 60, 16 * 60);
        this.motorcadeAnnounced = false;
        // ?kortezh в адресе — кортеж почти сразу (чтобы посмотреть)
        if (!this.unifiedWorld && typeof location !== "undefined" && /kortezh/.test(location.search)) this.motorcadeAt = SHIFT_START + 3;
        this.spawnedLines = new Set();
        this.turnT = 0;
        this.turnTotal = 1;
        this.turnSign = 0;
    }

    newStrips() {
        this.strips = [new Strip(ROAD_LEFT - 20, "trees", this), new Strip(ROAD_RIGHT + 30, "lamps", this)];
    }

    get networkTrafficRequired() { return Boolean(window.citySession?.requiresServerTraffic); }

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
        const limit = MARGIN - 20;
        return limit * Math.tanh(this.bendAt(a) / limit);
    }

    bendAngle() {
        const y = this.bus.centerY;
        return Math.atan2(this.bendOffset(y - 18) - this.bendOffset(y + 18), 36);
    }

    updateCameraDirection() {
        const camera = this.cameraDir || this.dir;
        const before = this.cityGeometryAt(-100).position, ahead = this.cityGeometryAt(100).position;
        const dx = ahead[0] - before[0], dy = ahead[1] - before[1];
        const current = Math.atan2(camera[1], camera[0]);
        const desired = Math.hypot(dx, dy) > 0.01 ? Math.atan2(dy, dx) : Math.atan2(this.dir[1], this.dir[0]);
        const difference = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
        const angle = current + clamp(difference * 0.12, -0.025, 0.025);
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
        return this.cityOptionsFor(this.cityEdge, this.cityReverse, nodeId);
    }

    cityOptionsFor(edge, reverse, nodeId = this.cityGraph.endpoint(edge, reverse), routeHint = undefined) {
        const result = { left: null, right: null, straight: null };
        const choices = [];
        Object.defineProperty(result, "choices", { value: choices });
        const nextLeg = routeHint === undefined ? this.cityExpectedLegAfter(edge, reverse) : routeHint;
        const key = this.citySelectionKey(edge, reverse, nodeId);
        const guide = this.cityOffRoute && this.cityRejoinGuide?.key === key ? this.cityRejoinGuide : null;
        const preferred = guide?.edge || nextLeg?.edge.id;
        const exits = this.cityOrdinaryExits(edge, reverse, nodeId)
            .sort((a, b) => Number(b.edge.id === preferred) - Number(a.edge.id === preferred));
        const automatic = this.cityAutomaticExit(edge, reverse, exits, nodeId);
        const incoming = this.cityGraph.direction(edge, reverse, nodeId === edge.to ? edge.length : 0);
        for (const option of exits) {
            const outgoing = option.edge;
            if (!this.cityGraph.canTurn(edge, nodeId, outgoing, option.reverse)) continue;
            const direction = this.cityGraph.direction(outgoing, option.reverse);
            const dot = incoming[0] * direction[0] + incoming[1] * direction[1];
            const cross = incoming[0] * direction[1] - incoming[1] * direction[0];
            const continuation = exits.length === 1;
            const isAutomatic = automatic?.edge.id === outgoing.id && automatic.reverse === option.reverse;
            const side = isAutomatic ? "straight" : cross < 0 ? "left" : "right";
            const choice = { ...option, direction, node: nodeId, side,
                continuation, angle: Math.atan2(cross, dot) };
            choices.push(choice);
            if (!result[side]) result[side] = choice;
        }
        if (!choices.some((choice) => choice.edge.id === edge.id && choice.reverse !== reverse) &&
            this.cityGraph.canTurn(edge, nodeId, edge, !reverse)) {
            choices.push({ edge, reverse: !reverse, node: nodeId,
                direction: incoming.map((value) => -value), side: "uturn", angle: Math.PI, continuation: false });
        }
        Object.defineProperties(result, {
            automatic: { value: result.straight },
            deadEnd: { value: exits.length === 0 },
            physicalEnd: { value: !(this.cityGraph.adjacent.get(nodeId) || []).some((candidate) => candidate.id !== edge.id) },
            requiresChoice: { value: exits.length > 0 && !result.straight },
        });
        return result;
    }

    cityExpectedLegAfter(edge, reverse, startIndex = this.cityLegIndex) {
        const legs = this.cityItinerary.legs;
        for (let step = 0; step < legs.length; step++) {
            const index = (startIndex + step) % legs.length, leg = legs[index];
            if (leg.edge.id === edge.id && leg.reverse === reverse) return legs[(index + 1) % legs.length];
        }
        return null;
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

    citySelectionKey(edge, reverse, nodeId = this.cityGraph.endpoint(edge, reverse)) {
        return `${edge.id}:${reverse}:${nodeId}`;
    }

    cityExitKey() { return this.citySelectionKey(this.cityEdge, this.cityReverse); }

    citySelectedExit(edge, reverse, nodeId = this.cityGraph.endpoint(edge, reverse), options = undefined) {
        const key = this.citySelectionKey(edge, reverse, nodeId);
        const selection = this.cityPlannedSelections?.get(key) ||
            (this.cityExitSelection?.key === key ? this.cityExitSelection : null);
        if (!selection) return null;
        const available = options || this.cityOptionsFor(edge, reverse, nodeId);
        return available.choices.find((choice) => choice.edge.id === selection.edge && choice.reverse === selection.reverse) || null;
    }

    selectedCityExit(options = this.cityOptions()) {
        return this.citySelectedExit(this.cityEdge, this.cityReverse, this.nextCross().k, options);
    }

    cityNavigationTarget() {
        const cache = this.cityNavigationCache;
        if (cache?.edge === this.cityEdge && cache.reverse === this.cityReverse && cache.offset === this.cityOffset &&
            cache.route === this.route.num && cache.index === this.cityLegIndex && cache.offRoute === this.cityOffRoute &&
            cache.plans === this.cityPlannedSelections && cache.revision === (this.cityPlanRevision || 0) &&
            cache.legacy === this.cityExitSelection && cache.pending === this.cityPendingTurn) return cache.target;
        const legs = this.cityItinerary.legs, seen = new Set();
        let edge = this.cityEdge, reverse = this.cityReverse, index = this.cityOffRoute ? -1 : this.cityLegIndex;
        let distance = reverse ? this.cityOffset : edge.length - this.cityOffset, target = null;
        for (let count = 0; count < 4096; count++) {
            const nodeId = this.cityGraph.endpoint(edge, reverse), key = this.citySelectionKey(edge, reverse, nodeId);
            if (seen.has(key)) break;
            seen.add(key);
            const nextIndex = index < 0 ? -1 : (index + 1) % legs.length;
            const expected = nextIndex < 0 ? null : legs[nextIndex];
            const options = this.cityOptionsFor(edge, reverse, nodeId, expected);
            const selected = this.citySelectedExit(edge, reverse, nodeId, options);
            const ordinary = options.choices.filter((choice) => choice.side !== "uturn");
            const recommended = expected && options.choices.find((choice) =>
                choice.edge.id === expected.edge.id && choice.reverse === expected.reverse);
            const choice = this.cityDrivingExit(edge, reverse, nodeId, options, expected);
            const terminal = recommended?.side === "uturn";
            const node = this.cityGraph.nodes.get(nodeId);
            const names = [...new Set([edge.street, choice?.edge.street]
                .filter((name) => name && !/^безымян/i.test(name)))].slice(0, 2);
            target = { key, nodeId, edge, reverse, name: node?.osmTags?.name || names.join(" × ") || node?.name || "Перекрёсток",
                distanceMeters: Math.max(0, distance) * (this.cityGraph.data.metersPerUnit || METERS_PER_PX),
                choices: options.choices, selected, choice, options, terminal,
                canCycle: options.choices.length > 1 && (ordinary.length > 1 || terminal || selected?.side === "uturn") };
            if (ordinary.length > 1 || terminal || selected?.side === "uturn" || !options.automatic || distance >= 200000) break;
            const continuation = choice;
            if (!continuation) break;
            index = expected && continuation.edge.id === expected.edge.id && continuation.reverse === expected.reverse ? nextIndex : -1;
            edge = continuation.edge; reverse = continuation.reverse; distance += edge.length;
        }
        this.cityNavigationCache = { edge: this.cityEdge, reverse: this.cityReverse, offset: this.cityOffset,
            route: this.route.num, index: this.cityLegIndex, offRoute: this.cityOffRoute,
            plans: this.cityPlannedSelections, revision: this.cityPlanRevision || 0,
            legacy: this.cityExitSelection, pending: this.cityPendingTurn, target };
        return target;
    }

    cycleNavigationExit(step = 1) {
        const target = this.cityNavigationTarget(), choices = [...(target?.choices || [])].sort((a, b) => a.angle - b.angle ||
            String(a.edge.id).localeCompare(String(b.edge.id)));
        if (!choices.length) {
            this.showBanner("Нет разрешённого выезда. M — карта города", ORANGE);
            return false;
        }
        const current = target.selected || target.choice || choices[0];
        const index = choices.findIndex((choice) => choice.edge.id === current.edge.id && choice.reverse === current.reverse);
        const choice = choices[mod(index + step, choices.length)];
        this.cityPlannedSelections ||= new Map();
        this.cityPlannedSelections.set(target.key, { key: target.key, edge: choice.edge.id, reverse: choice.reverse });
        this.cityPlanRevision = (this.cityPlanRevision || 0) + 1;
        if (target.key === this.cityExitKey()) { this.cityPendingTurn = null; this.cityExitSelection = null; }
        this.cityGeometryCache = null; this.cityNavigationCache = null;
        this.showBanner(`Выбран съезд: ${choice.edge.street}. Газ — продолжить`, BLUE, 140);
        return true;
    }

    cycleCityExit(step = 1) { return this.cycleNavigationExit(step); }

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
            cache.pending !== this.cityPendingTurn || cache.revision !== this.cityPlanRevision) {
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
                const options = this.cityOptionsFor(leg.edge, leg.reverse, node, expected);
                const option = this.cityDrivingExit(leg.edge, leg.reverse, node, options, expected);
                // A selected turn is already part of the visible continuous
                // road. Crossing its source-node boundary never swaps scenes.
                if (!option || graph.origin(option.edge, option.reverse) !== node ||
                    !graph.canTurn(leg.edge, node, option.edge, option.reverse)) break;
                segments.push({ edge: option.edge, reverse: option.reverse, start: leg.end, end: leg.end + option.edge.length });
                legIndex = expected && option.edge.id === expected.edge.id && option.reverse === expected.reverse ? expectedIndex : -1;
            }
            cache = this.cityGeometryCache = { edge: current, reverse: this.cityReverse, offset: this.cityOffset,
                selection: this.cityExitSelection, pending: this.cityPendingTurn, revision: this.cityPlanRevision, segments };
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
        const consumedKey = this.citySelectionKey(this.cityEdge, this.cityReverse, nodeId);
        this.cityPlannedSelections.delete(consumedKey);
        this.cityWorldCommitted.delete(consumedKey);
        const history = this.cityGeometryHistory || (this.cityGeometryHistory = []);
        history.push({ edge: this.cityEdge, reverse: this.cityReverse,
            legIndex: this.cityLegIndex, lap: this.cityLap, offRoute: this.cityOffRoute });
        if (history.length > 10000) history.splice(0, history.length - 10000);
        this.cityGeometryCache = null;
        this.cityDrivingCache = null; this.cityNavigationCache = null;
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
        const options = this.cityOptionsFor(edge, reverse, nodeId, next);
        const selected = this.cityDrivingExit(edge, reverse, nodeId, options, next);
        return Boolean(selected && selected.edge.id === next.edge.id && selected.reverse === next.reverse);
    }

    cityContinue(option, nodeId) {
        this.cityEnter(option, nodeId);
        // Source edges are geometry fragments, not separate levels. Cars,
        // scenery and intersections keep their identity and world position.
        setRoad(this.cityEdge.lanes);
        for (const stop of this.stops) {
            const edge = this.cityGraph.edges.get(stop.cityEdge);
            if (edge) stop.edge = roadMiddle() + this.cityMapGeometry.halfWidth(edge, stop.cityOffset);
        }
    }

    // Общая точка движения для обычной езды и конвоя: нельзя выехать за
    // конец ребра или оказаться на другой улице без общего перекрёстка.
    advanceCity(distance) {
        if (distance < 0) {
            let remaining = -distance, moved = 0;
            for (let step = 0; step < 10000 && remaining > 1e-7; step++) {
                const room = this.cityReverse ? this.cityEdge.length - this.cityOffset : this.cityOffset;
                const amount = Math.min(remaining, room);
                this.cityOffset += this.cityReverse ? amount : -amount;
                this.cityTravel -= amount; moved -= amount; remaining -= amount;
                if (remaining <= 1e-7) break;
                const previous = this.cityGeometryHistory.at(-1), outgoing = this.cityEdge, outgoingReverse = this.cityReverse;
                const node = this.cityGraph.origin(outgoing, outgoingReverse);
                if (!previous || this.cityGraph.endpoint(previous.edge, previous.reverse) !== node) break;
                const options = this.cityOptionsFor(previous.edge, previous.reverse, node, null);
                const retrace = options.choices.find((choice) => choice.edge.id === outgoing.id && choice.reverse === outgoingReverse);
                if (!retrace) break;
                this.cityGeometryHistory.pop();
                this.cityEdge = previous.edge; this.cityReverse = previous.reverse;
                this.cityOffset = previous.reverse ? 0 : previous.edge.length;
                if (Number.isInteger(previous.legIndex)) {
                    this.cityLegIndex = previous.legIndex; this.cityLap = previous.lap; this.cityOffRoute = previous.offRoute;
                } else {
                    const legs = this.cityItinerary.legs;
                    let index = -1;
                    for (let back = 1; back <= legs.length; back++) {
                        const candidate = mod(this.cityLegIndex - back, legs.length), leg = legs[candidate];
                        if (leg.edge.id === previous.edge.id && leg.reverse === previous.reverse) { index = candidate; break; }
                    }
                    this.cityOffRoute = index < 0;
                    if (index >= 0) {
                        if (index > this.cityLegIndex) this.cityLap = Math.max(0, this.cityLap - 1);
                        this.cityLegIndex = index;
                    }
                }
                // Reversing consumes the real driving history, not a new
                // forward transition. Keep the road we just backed out of in
                // the future trace so its rounded connector cannot change.
                const key = this.citySelectionKey(previous.edge, previous.reverse, node);
                this.cityPlannedSelections.set(key, { edge: outgoing.id, reverse: outgoingReverse });
                this.cityWorldCommitted.set(key, { ...retrace, reversedHistory: true });
                this.cityPendingTurn = null; this.cityExitSelection = null; this.cityRejoinGuide = null;
                this.cityPlanRevision += 1;
                this.streetK = this.cityEdge.index;
                if (this.cityEdge.district && DISTRICTS[this.cityEdge.district]) this.district = this.cityEdge.district;
                setRoad(this.cityEdge.lanes);
            }
            [this.wx, this.wy] = this.cityGraph.position(this.cityEdge, this.cityOffset);
            this.dir = this.cityGraph.direction(this.cityEdge, this.cityReverse, this.cityOffset);
            this.cityGeometryCache = null; this.cityNavigationCache = null; this.cityDrivingCache = null;
            this.cityCommitPath();
            this.cityGeometryAt(0);
            let unlocked = false;
            for (const leg of this.cityGeometryCache.segments) {
                const key = this.citySelectionKey(leg.edge, leg.reverse);
                const locked = this.cityWorldCommitted.get(key);
                const lockStart = Number.isFinite(locked?.lockStartTravel) ? locked.lockStartTravel
                    : this.cityTravel + leg.end - this.cityWorldTurnRadius;
                if (locked?.reversedHistory && this.cityTravel < lockStart) {
                    this.cityWorldCommitted.delete(key); unlocked = true;
                }
            }
            if (unlocked) {
                this.cityPlanRevision += 1;
                this.cityGeometryCache = null; this.cityNavigationCache = null; this.cityDrivingCache = null;
            }
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
            const expected = this.cityOffRoute ? null : this.cityItinerary.legs[(this.cityLegIndex + 1) % this.cityItinerary.legs.length];
            const selected = this.cityDrivingExit(this.cityEdge, this.cityReverse, nodeId, options, expected);
            if (selected) {
                if (selected.side !== "straight") this.turns += 1;
                this.cityContinue(selected, nodeId);
                continue;
            }
            const turnaround = options.choices.find((choice) => choice.side === "uturn");
            if (options.deadEnd && turnaround) {
                this.cityContinue(turnaround, nodeId);
                this.turns += 1;
                this.showBanner("Конец разрешённого проезда. Разворот", YELLOW);
                continue;
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
        this.cityGeometryAt(0);
        const visibleRoads = new Set(this.cityGeometryCache.segments.map((leg) => `${leg.edge.id}:${leg.reverse}`));
        this.stops = this.stops.filter((stop) => {
            if (stop.cityTravel <= this.cityTravel || !stop.citySpawnKey ||
                visibleRoads.has(`${stop.cityEdge}:${stop.cityReverse}`)) return true;
            this.spawnedCityStops.delete(stop.citySpawnKey);
            return false;
        });
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
            stop.edge = roadMiddle() + this.cityMapGeometry.halfWidth(segment.edge, offset);
            stop.cityEdge = segment.edge.id;
            stop.cityReverse = segment.reverse;
            stop.citySpawnKey = definition.key;
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
        if (this.unifiedWorld) return this.stops.find((stop) => {
            const point = this.cityStopPlacement(stop);
            return point && Math.abs(point.along) + bus.h / 2 < BusStop.HEIGHT / 2 - 20 &&
                point.lateral + bus.w / 2 >= point.width + BAY_W - 18 &&
                point.lateral + bus.w / 2 <= point.width + BAY_W + 12;
        }) || null;
        return this.stops.find((s) => r.x + r.w >= s.edge + BAY_W - 18 &&
            bus.y > s.y + 20 && bus.y + bus.h < s.y + BusStop.HEIGHT - 20) || null;
    }

    cityStopPlacement(stop) {
        const edge = this.cityGraph.edges.get(stop.cityEdge);
        if (!edge || !this.cityMapGeometry.profile(edge).some((leg) => leg.edge.id === this.cityEdge.id)) return null;
        const pose = this.cityWorldPose, direction = this.cityGraph.direction(edge, stop.cityReverse, stop.cityOffset);
        const heading = [Math.sin(pose.angle), -Math.cos(pose.angle)];
        if (direction[0] * heading[0] + direction[1] * heading[1] < 0.75) return null;
        const [x, y] = this.cityGraph.position(edge, stop.cityOffset), dx = pose.wx - x, dy = pose.wy - y;
        const along = dx * direction[0] + dy * direction[1];
        if (Math.abs(along) > BusStop.HEIGHT / 2 + this.bus.h) return null;
        return { along, lateral: -direction[1] * dx + direction[0] * dy,
            width: this.cityMapGeometry.halfWidth(edge, stop.cityOffset) };
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
        const point = this.cityGeometryAt(this.bus.centerY - y);
        // One immutable physical width profile is shared by every observer.
        // A different route or a selected exit never reshapes a city street.
        return clamp(this.cityMapGeometry.halfWidth(point.edge, point.offset) / LANE_W, 1, LANES / 2);
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
        if (this.unifiedWorld) return Math.max(0, ...this.stops.map((stop) => {
            const point = this.cityStopPlacement(stop);
            return point ? BAY_W * clamp((BusStop.HEIGHT / 2 - Math.abs(point.along) - bus.h / 2) / BusStop.TAPER, 0, 1) : 0;
        }));
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
        if (this.unifiedWorld || this.serverTrafficActive) return;
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
        if (this.unifiedWorld || this.serverTrafficActive) return;
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
        if (this.unifiedWorld || this.serverTrafficActive) return;
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
        if (this.unifiedWorld || this.serverTrafficActive) return;
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
    cityJunction(edge, reverse, nodeId = this.cityGraph.endpoint(edge, reverse)) {
        const graph = this.cityGraph, node = graph.nodes.get(nodeId);
        const adjacent = graph.adjacent.get(nodeId) || [];
        const incoming = graph.direction(edge, reverse, reverse ? 0 : edge.length);
        const sides = { left: false, right: false, straight: false };
        let lanes = 2, crossStreet = null;
        for (const other of adjacent) {
            if (other.id === edge.id) continue;
            const outward = graph.direction(other, other.to === nodeId);
            const cross = incoming[0] * outward[1] - incoming[1] * outward[0];
            const dot = incoming[0] * outward[0] + incoming[1] * outward[1];
            if (Math.abs(cross) > 0.35) {
                sides[cross < 0 ? "left" : "right"] = true;
                if (!crossStreet || other.lanes > lanes) crossStreet = other.street;
                lanes = Math.max(lanes, other.lanes);
            }
            if (dot > 0.64) sides.straight = true;
        }
        const control = this.cityMapGeometry.junction(edge, reverse);
        const signal = control.signal;
        const options = this.cityOptionsFor(edge, reverse, nodeId);
        return { lanes: control.width / LANE_W, direction: incoming, signal, control,
            stop: control.stop, yield: control.yield, stopLine: control.stopLine, name: crossStreet || edge.street,
            arms: { ...sides, deadEnd: options.deadEnd, physicalEnd: options.physicalEnd,
                requiresChoice: options.requiresChoice } };
    }

    spawnCityJunctions() {
        this.cityGeometryAt(0);
        const visible = new Set();
        for (const leg of this.cityGeometryCache.segments) {
            if (leg.end < -500 || leg.end > this.bus.centerY + 900) continue;
            const nodeId = this.cityGraph.endpoint(leg.edge, leg.reverse);
            const layout = this.cityJunction(leg.edge, leg.reverse, nodeId);
            if (!layout.signal && !layout.stop && !layout.yield && !layout.arms.deadEnd && !layout.arms.requiresChoice) continue;
            const key = this.citySelectionKey(leg.edge, leg.reverse, nodeId);
            const travel = this.cityTravel + leg.end;
            visible.add(key);
            let inter = this.inters.find((item) => item.cityKey === key && Math.abs(item.cityTravel - travel) < 1);
            if (!inter) {
                const y = this.bus.centerY - leg.end - layout.lanes * LANE_W / 2;
                inter = new Intersection(y, nodeId, layout.name, layout.lanes, layout.arms);
                inter.cityKey = key;
                inter.cityTravel = travel;
                inter.cityIncoming = leg.edge.id;
                inter.cityReverse = leg.reverse;
                inter.signalDirection = layout.direction;
                inter.control = layout.control;
                inter.hasSignal = layout.signal;
                inter.hasStop = layout.stop;
                inter.hasYield = layout.yield;
                inter.closed = this.closedLanesAt(y + inter.h / 2);
                inter.passed = leg.end < 0;
                this.inters.push(inter);
            }
        }
        // A changed exit affects only unvisited future branches. Already passed
        // junctions keep their objects and continue scrolling behind the bus.
        this.inters = this.inters.filter((inter) => !inter.cityKey || inter.cityTravel <= this.cityTravel || visible.has(inter.cityKey));
    }

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
        this.spawnCityJunctions();
        this.spawnCityStops();
        if (this.unifiedWorld || this.serverTrafficActive) return;
        this.spawnCityBridge();
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
        if (this.unifiedWorld || this.serverTrafficActive) return;
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
        const key = this.citySelectionKey(this.cityEdge, this.cityReverse, nodeId);
        const locked = this.cityWorldCommitted.get(key);
        if (locked && (locked.edge.id !== option.edge.id || locked.reverse !== option.reverse)) {
            this.showBanner("Выезд уже начат", YELLOW, 100);
            return false;
        }
        // Steering selects the same connected path as Q/E. The next edge is
        // visible before the node and advanceCity consumes it without a frozen
        // screenshot, a new scenery instance or a respawn of local traffic.
        this.cityPlannedSelections.set(key,
            { edge: option.edge.id, reverse: option.reverse });
        this.cityPendingTurn = { sign, node: nodeId, inter, edge: option.edge.id, reverse: option.reverse };
        this.cityPlanRevision += 1;
        this.cityGeometryCache = null; this.cityDrivingCache = null; this.cityNavigationCache = null;
        return true;
    }

}
