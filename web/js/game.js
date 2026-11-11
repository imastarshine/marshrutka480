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
        setRoad(streetLanes(true, 0));
        this.model = BUS_MODELS.find((m) => m.key === this.save.bus) || BUS_MODELS[0];
        this.route = ROUTES.find((r) => r.num === this.save.route) || ROUTES[0];
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
        this.district = choice(this.route.districts);
        this.districtLeft = rand(3500, 5500);
        this.scenery = new Scenery(this);
        this.crosswalks = [];
        this.bridges = [];
        this.airbags = up.airbag || 0;
        this.policeFine = Math.round(POLICE_FINE * (1 - 0.3 * (up.blat || 0)));
        this.chaseTime = 1500 - 300 * (up.blat || 0);

        this.cars = [];
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
        this.streetK = 0;                       // номер улицы, по которой едем
        this.wx = gridPos("x", 0);
        this.wy = gridPos("y", 0) + BLOCK * 0.4;
        this.dir = [0, -1];
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
        this.strips = [new Strip(ROAD_LEFT - 20, "trees"), new Strip(ROAD_RIGHT + 30, "lamps")];
    }

    // --- изгибы дороги: некоторые улицы плавно виляют между перекрёстками ---
    bendAt(along) {
        const amp = hash(this.vertical ? 8 : 9, this.streetK, 3) < 0.35 ? 0 : 42;
        if (!amp) return 0;
        const edge = Math.abs(along - this.nearestCross(along).a);
        const fade = smooth(clamp((edge - 380) / 600, 0, 1));    // у перекрёстков дорога прямая
        return fade * amp * Math.sin(along / 950 + this.streetK * 1.7);
    }

    // сдвиг строки экрана y относительно маршрутки (она всегда в центре)
    bendOffset(y) {
        const a = this.along + (this.bus.centerY - y);
        return this.bendAt(a) - this.bendAt(this.along);
    }

    bendAngle() {
        const a = this.along;
        return Math.atan2(this.bendAt(a + 30) - this.bendAt(a - 30), 60);
    }

    // поперечные улицы: k и их координата вдоль нашего движения
    crossAlong(k) {
        const sgn = this.vertical ? this.dir[1] : this.dir[0];
        return gridPos(this.vertical ? "y" : "x", k) * sgn;
    }

    crossNear(along) {
        const sgn = this.vertical ? this.dir[1] : this.dir[0];
        const k0 = Math.round((along * sgn) / BLOCK), out = [];
        for (let k = k0 - 2; k <= k0 + 2; k++) out.push({ k, a: this.crossAlong(k) });
        return out;
    }

    nearestCross(along) {
        return this.crossNear(along).reduce((b, c) => (Math.abs(c.a - along) < Math.abs(b.a - along) ? c : b));
    }

    nextCross() {
        return this.crossNear(this.along).filter((c) => c.a > this.along).reduce((b, c) => (c.a < b.a ? c : b));
    }

    // узел карты для перекрёстка с поперечной улицей k
    node(k) {
        return this.vertical ? [this.streetK, k] : [k, this.streetK];
    }

    arms(k) {
        const [dx, dy] = this.dir, [i, j] = this.node(k);
        return {
            straight: armExists(i, j, this.dir),
            left: armExists(i, j, [dy, -dx]),
            right: armExists(i, j, [-dy, dx]),
        };
    }

    // --- карта города ---
    get along() {
        return this.wx * this.dir[0] + this.wy * this.dir[1];
    }

    get vertical() {
        return this.dir[0] === 0;
    }

    currentStreet() {
        return streetName(this.vertical, this.streetK);
    }

    compass() {
        const [dx, dy] = this.dir;
        if (dy < 0) return "север";
        if (dx > 0) return "восток";
        if (dy > 0) return "юг";
        return "запад";
    }

    screenToWorld(screenY) {
        const ahead = this.bus.centerY - screenY;
        return [this.wx + this.dir[0] * ahead, this.wy + this.dir[1] * ahead];
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
        const T = LaneShift.TAPER;
        let val = this.openBelow;
        for (const t of [...this.shifts].sort((a, b) => b.y - a.y)) {
            if (y > t.y + T / 2) return val;
            if (y > t.y - T / 2) return t.from + (t.to - t.from) * smooth((t.y + T / 2 - y) / T);
            val = t.to;
        }
        return val;
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
        window.app?.broadcastHorn();
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
        // перекрёстки стоят по (неровной) сетке города; если поперечная улица сюда не доходит — едем дальше
        const nx = this.nextCross();
        if (!this.spawnedLines.has(nx.k) && nx.a - this.along < this.bus.centerY + 900) {
            this.spawnedLines.add(nx.k);
            const arms = this.arms(nx.k);
            if (arms.left || arms.right) {
                const lanes = streetLanes(!this.vertical, nx.k), h = roadWidthFor(lanes);
                const y = this.bus.centerY - (nx.a - this.along) - h / 2;
                const inter = new Intersection(y, nx.k, streetName(!this.vertical, nx.k), lanes, arms);
                inter.closed = this.closedLanesAt(y + h / 2);
                this.inters.push(inter);
            }
        }
        if (this.inters.some((i) => !i.arms.straight && i.y > -200)) {
            // впереди тупик: за ним ничего не появляется
            for (const k in this.nextIn) this.nextIn[k] = Math.max(this.nextIn[k], 300);
        }

        const s = this.bus.speed, route = this.route;
        for (const k in this.nextIn) this.nextIn[k] -= s;
        // смена района
        this.districtLeft -= Math.max(0, s);
        if (this.districtLeft <= 0) {
            const options = route.districts.filter((d) => d !== this.district);
            this.district = choice(options.length ? options : route.districts);
            this.districtLeft = rand(3500, 6000);
            this.showBanner(`Район: ${DISTRICTS[this.district].name}`, [180, 230, 180], 120);
        }
        if (this.nextIn.stop <= 0) {
            const y = -BusStop.HEIGHT - 60;
            if (this.areaFree(y, BusStop.HEIGHT)) {
                const stop = new BusStop(Math.random() < 0.72 ? this.nextStopId++ : null, y, route, this.rep);
                stop.edge = ROAD_RIGHT - this.closedW(y + BusStop.HEIGHT / 2);   // карман у открытого края
                this.stops.push(stop);
                this.nextIn.stop = rand(...route.stopGap);
            } else this.nextIn.stop = 200;
        }
        if (this.nextIn.cross <= 0) {
            const y = -Crosswalk.H - 80;
            if (this.areaFree(y, Crosswalk.H)) {
                this.crosswalks.push(new Crosswalk(y, route.traffic));
                this.nextIn.cross = rand(1800, 3200) / route.traffic;
            } else this.nextIn.cross = 200;
        }
        if (this.nextIn.zone <= 0) {
            // улица меняет ширину надолго: 3 полосы на сторону → 2 → 1 → 3 ...
            const T = LaneShift.TAPER, y = -T;
            const at = this.along + this.bus.centerY - y;
            const nearLine = this.crossNear(at).some((c) => Math.abs(c.a - at) < T + 450);
            if (this.areaFree(y - T / 2, T) && !nearLine) {
                const from = Math.round(this.openAt(y - T));
                this.shifts.push(new LaneShift(y, from, choice([1, 2, 3].filter((n) => n !== from)), choice(["tiles", "parking"])));
                this.nextIn.zone = rand(2500, 6000);
            } else this.nextIn.zone = 300;
        }
        if (this.nextIn.station <= 0) {
            const y = -PoliceStation.HEIGHT - 80;
            if (this.areaFree(y, PoliceStation.HEIGHT)) {
                this.stations.push(new PoliceStation(y, ROAD_RIGHT - this.closedW(y + PoliceStation.HEIGHT / 2)));
                this.nextIn.station = rand(12000, 22000);
            } else this.nextIn.station = 300;
        }
        if (this.nextIn.bridge <= 0) {
            const h = randint(220, 360), y = -h - 80;
            // мост не должен налезать на перекрёсток
            const from = this.along + this.bus.centerY - (y + h);
            const nearLine = this.crossNear(from).some((c) => c.a > from - 500 && c.a < from + h + 500);
            if (this.areaFree(y, h) && !nearLine && Math.random() < DISTRICTS[this.district].bridge) {
                this.bridges.push(new Bridge(y, h));
                this.nextIn.bridge = rand(3000, 6000);
            } else this.nextIn.bridge = 400;
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
        const oncoming = Math.random() < 0.45;
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
        if (!steer || bus.air || bus.speed < 0.5) return;
        // направо — прижавшись к правому краю, налево — из левой своей полосы (или со встречки)
        const [, right] = bus.xLimits;
        const ready = steer < 0 ? bus.x <= laneCenter(ownFirst()) + 6 : bus.x >= right - 1;
        if (!ready) return;
        const inter = this.inters.find((i) => i.contains(bus.centerY));
        if (inter && (steer < 0 ? inter.arms.left : inter.arms.right)) this.startTurn(steer, inter);
    }

    startTurn(sign, inter) {
        const bus = this.bus;
        window.citySession?.captureTurn(this);
        // снимок старой улицы: во время поворота камера плавно доворачивает с неё на новую
        this.drawWorld(false);
        this.snapshot.getContext("2d").drawImage(canvas, 0, 0);
        this.turnStart = [bus.x, bus.centerY];
        this.turnTotal = this.turnT = Math.round(clamp(300 / Math.max(bus.speed, 3), 34, 80));
        this.turnSign = sign;
        this.state = "turning";
        const drift = bus.speed > 8;
        const oldStreet = this.currentStreet(), oldK = this.streetK, oldLanes = LANES;
        // ДПС далеко позади — потеряли маршрутку за углом
        const lost = !this.heli && this.police && !this.police.leaving && this.police.y > bus.y + bus.h + 100 + 60 * this.stars;

        // встаём ровно в узел сетки и меняем направление
        if (this.vertical) this.wy = gridPos("y", inter.k);
        else this.wx = gridPos("x", inter.k);
        const [dx, dy] = this.dir;
        this.dir = sign > 0 ? [-dy, dx] : [dy, -dx];
        this.streetK = inter.k;
        setRoad(streetLanes(this.vertical, this.streetK));
        this.trail.push([this.wx, this.wy]);
        this.turns += 1;

        // новая улица: свои непройденные остановки переносим на неё
        const unvisited = this.stops.filter((s) => s.ours && !s.visited).map((s) => s.id);
        if (unvisited.length) this.nextStopId = Math.min(...unvisited);
        this.cars = [];
        this.stops = [];
        this.ramps = [];
        this.posts = [];
        this.crosswalks = [];
        this.bridges = [];
        this.walkers = [];
        this.skids = [];
        this.particles = this.particles.filter((p) => !p.world);
        this.texts = [];
        if (Math.random() < 0.5) this.district = choice(this.route.districts);
        this.newStrips();
        this.scenery = new Scenery(this);
        // перекрёсток, с которого съехали: старая улица теперь поперечная, она позади маршрутки
        this.spawnedLines = new Set([oldK]);
        const ni = new Intersection(bus.centerY + 40, oldK, oldStreet, oldLanes, this.arms(oldK));
        ni.t = 0;
        ni.passed = true;
        this.inters = [ni];
        this.nextIn = { stop: 900, ramp: rand(1500, 3500), post: rand(2500, 6000), cross: rand(900, 2000), bridge: 1500, zone: rand(800, 2500), station: rand(4000, 12000) };
        this.stations = [];
        this.shifts = [];
        this.openBelow = LANES / 2 - CLOSED;
        this.styleBelow = choice(["tiles", "parking"]);
        if (this.motorcade) {              // свернул — перекрытие осталось на старой улице
            this.motorcade = null;
            this.showBanner("Объехал перекрытие!", GREEN);
        }
        ni.closed = CLOSED;
        bus.x = laneCenter(sign > 0 ? LANES - 1 - CLOSED : ownFirst());
        bus.vx = 0;
        if (this.police) {
            this.police.y = HEIGHT + 120;
            this.police.x = bus.x;
            if (lost) this.escapePolice("Скрылся за углом!");
        }
        this.showBanner(`Поворот ${sign > 0 ? "направо" : "налево"}: ${this.currentStreet()}`, BLUE);
        if (drift) this.stunt("Дрифт-поворот!", 120);
    }

}
