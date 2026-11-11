// Маршрутка — объекты на дороге
"use strict";

// ---------- люди, остановки, перекрёстки, переходы, мосты ----------
class Walker {
    // Человечек: идёт от остановки к двери (посадка) или от двери на тротуар (высадка)
    constructor(x, y, kind, stop, dest = null) {
        Object.assign(this, { x, y, kind, stop, dest });
        this.color = choice(PEOPLE_COLORS);
        this.phase = Math.random() * 6;
        this.returning = false;
        this.fade = 1;
        this.done = false;
        if (kind === "out") {
            this.tx = stop.edge + BAY_W + 30 + randint(-6, 6);
            this.ty = this.y + randint(20, 60);
        }
    }

    draw() {
        const step = Math.sin(this.phase) * 3;
        const a = Math.max(0, this.fade);
        const x = this.x, y = this.y;
        line(x - 2, y + 6, x - 2 - step, y + 14, BLACK, 3, a);
        line(x + 2, y + 6, x + 2 + step, y + 14, BLACK, 3, a);
        fillRect(x - 6, y - 7, 12, 15, this.color, a, 4);
        circle(x, y - 11, 6, SKIN, a);
        // значок: зелёная стрелка вверх — садится, оранжевая вниз — выходит
        if (this.kind === "in" && !this.returning) poly([[x, y - 30], [x - 6, y - 22], [x + 6, y - 22]], GREEN);
        else if (this.kind === "out") poly([[x, y - 20], [x - 6, y - 28], [x + 6, y - 28]], ORANGE, a);
    }
}

class BusStop {
    // отдельный карман у тротуара: маршрутка заезжает в него и не занимает полосу
    static HEIGHT = 300;
    static TAPER = 60;

    constructor(id, y, route, rep = 50, definition = null) {
        this.id = id;                         // null — чужая остановка
        this.ours = id !== null;
        this.route = definition?.route || (this.ours ? route.num : OTHER_ROUTES.find((number) => number !== route.num));
        this.name = definition?.name || STOP_NAMES[(id || 0) % STOP_NAMES.length];
        this.y = y;
        this.waiting = Math.max(0, randint(...route.wait) + (rep >= 75 ? 1 : rep < 25 ? -1 : 0));
        this.edge = ROAD_RIGHT;               // правый край открытой дороги у остановки
        this.colors = Array.from({ length: 10 }, () => choice(PEOPLE_COLORS));
        this.visited = false;
        this.exited = 0;
        this.boarded = 0;
    }

    get centerY() {
        return this.y + BusStop.HEIGHT / 2;
    }

    get shelterPos() {
        return [this.edge + BAY_W + 33, this.y + BusStop.TAPER + 40];
    }

    draw(frame, active) {
        const y = this.y, H = BusStop.HEIGHT, T = BusStop.TAPER, R = this.edge, B = R + BAY_W;
        fillRect(R, y - 20, Math.max(BAY_W + 80, ROAD_RIGHT + 40 - R), H + 40, SIDEWALK, 1, 10);   // площадка
        poly([[R, y], [B, y + T], [B, y + H - T], [R, y + H]], ASPHALT);      // карман со скосами
        line(B, y + T, B, y + H - T, [120, 120, 112], 3);
        line(R, y, B, y + T, [120, 120, 112], 3);
        line(R, y + H, B, y + H - T, [120, 120, 112], 3);
        const bx = R + 6, bw = BAY_W - 12, by = y + T, bh = H - 2 * T;
        if (this.ours) {
            const c = active ? GREEN : YELLOW;
            strokeRect(bx, by, bw, bh, c, 3);
            for (let i = by + 10; i < by + bh - 16; i += 22) line(bx + 6, i + 12, bx + bw - 6, i, c, 2);
            text("A", bx + bw / 2, by - 18, c, 16, { bold: true, align: "center", base: "middle" });
        } else {
            // чужой карман: красный пунктир и номер чужого маршрута на асфальте
            for (let i = by; i < by + bh; i += 16) {
                line(bx, i, bx, i + 8, [220, 60, 50], 3);
                line(bx + bw, i, bx + bw, i + 8, [220, 60, 50], 3);
            }
            text(this.route, bx + bw / 2, by + bh / 2, [230, 230, 230], 14, { align: "center", base: "middle" });
        }
        // павильон
        const x = B + 8, sy = y + T + 10, sh = H - 2 * T - 20;
        fillRect(x + 4, sy + 6, 50, sh, [0, 0, 0], 0.24, 5);
        fillRect(x, sy, 50, sh, this.ours ? [80, 100, 135] : [110, 90, 90], 1, 5);
        strokeRect(x + 4, sy + 4, 42, sh - 8, [190, 215, 240], 2, 3);
        const pulse = this.ours && !this.visited ? 2 + 2 * Math.sin(frame * 0.15) : 0;
        const px0 = x + 25, py0 = sy - 4;
        line(px0, py0, px0, py0 - 16, [60, 60, 60], 3);
        circle(px0, py0 - 24, 12 + pulse, WHITE);
        ring(px0, py0 - 24, 12 + pulse, [30, 90, 200], 2);
        text("А", px0, py0 - 24, [30, 90, 200], 14, { align: "center", base: "middle" });
        // табличка с номером маршрута
        const pw = textWidth(this.route, 14) + 8;
        fillRect(px0 - pw / 2, py0 - 9, pw, 18, this.ours ? YELLOW : [190, 50, 45], 1, 3);
        text(this.route, px0, py0, this.ours ? BLACK : WHITE, 14, { align: "center", base: "middle" });
        for (let i = 0; i < Math.min(this.waiting, 12); i++) {
            const px = x + 13 + (i % 2) * 24;
            const py = sy + 18 + Math.floor(i / 2) * 24 + Math.sin(frame * 0.1 + i) * 1.5;
            circle(px, py, 6, SKIN);
            fillRect(px - 6, py + 6, 12, 14, this.colors[i % this.colors.length], 1, 4);
        }
    }
}

class Intersection {
    // Перекрёсток со светофором. Ширина = ширина поперечной улицы (2/4/6 полос).
    // arms: есть ли улица налево / направо / прямо (нет прямо — тупик, нужно повернуть)
    constructor(y, k, name, lanes, arms) {
        this.y = y;                 // верх поперечной улицы
        this.k = k;                 // номер поперечной улицы на карте
        this.name = name;
        this.lanes = lanes;
        this.h = roadWidthFor(lanes);
        this.arms = arms;
        this.t = randint(0, CYCLE);
        this.passed = false;        // маршрутка уже пересекла стоп-линию
        this.crossCars = [];        // {x, offset, dir, color}
        this.peds = new PedLane();  // пешеходы на ближней зебре
        this.closed = CLOSED;       // сколько полос на сторону закрыто у этого перекрёстка
    }

    get zebraTop() {
        return this.y + this.h + 2;
    }

    get stopLine() {
        return this.y + this.h + 34;
    }

    get farStopLine() {             // стоп-линия встречки (над перекрёстком)
        return this.y - 34;
    }

    get phase() {
        return this.t % CYCLE;
    }

    get state() {
        if (this.phase < GREEN_T) return "green";
        if (this.phase < GREEN_T + YELLOW_T) return "yellow";
        return "red";
    }

    update(scroll, busClose, bus) {
        this.y += scroll;
        this.t += 1;
        const redLeft = CYCLE - this.phase;
        this.peds.update(this.state === "red" && redLeft > 160, 1.6, busClose || this.state === "green", bus, this.zebraTop);
        // поперечные машины едут, пока у нас красный (и не в самом его конце)
        const through = this.arms.left && this.arms.right;
        if (through && this.state === "red" && redLeft > 110 && this.y > -this.h && this.y < HEIGHT && Math.random() < 0.02 * this.lanes) {
            const lane = randint(0, this.lanes - 1), dir = lane < this.lanes / 2 ? -1 : 1;
            const lw = this.h / this.lanes, offset = lane * lw + (lw - CAR_W) / 2;
            const x = dir > 0 ? -MARGIN - CAR_H : WIDTH + MARGIN;
            if (this.crossCars.every((c) => Math.abs(c.x - x) > CAR_H * 2 || c.offset !== offset)) {
                this.crossCars.push({ x, offset, dir, color: choice(CAR_COLORS) });
            }
        }
        for (const c of this.crossCars) c.x += c.dir * 6;
        this.crossCars = this.crossCars.filter((c) => c.x > -MARGIN - CAR_H - 40 && c.x < WIDTH + MARGIN + 40);
    }

    crossRect(c) {
        return rect(c.x, this.y + c.offset, CAR_H, CAR_W);
    }

    contains(y) {
        return y > this.y + 10 && y < this.y + this.h - 10;
    }

    drawRoad() {
        const y = this.y, h = this.h, { left, right, straight } = this.arms;
        const L = -MARGIN, R = WIDTH + MARGIN;
        // поперечная улица только в те стороны, куда она идёт
        const x0 = left ? L : ROAD_LEFT - 38, x1 = right ? R : ROAD_RIGHT + 40;
        fillRect(x0, y - 30, x1 - x0, h + 60, SIDEWALK);
        fillRect(left ? L : ROAD_LEFT, y, (right ? R : ROAD_RIGHT) - (left ? L : ROAD_LEFT), h, ASPHALT);
        if (!straight) {
            // тупик: дальше дома и газон, Т-образный перекрёсток
            fillRect(ROAD_LEFT - 40, y - 900, ROAD_RIGHT - ROAD_LEFT + 80, 870, [92, 128, 78]);
            fillRect(ROAD_LEFT + 20, y - 230, ROAD_RIGHT - ROAD_LEFT - 40, 170, [150, 140, 130], 1, 4);
            strokeRect(ROAD_LEFT + 28, y - 222, ROAD_RIGHT - ROAD_LEFT - 56, 154, [120, 110, 100], 3, 3);
            for (let x = ROAD_LEFT; x < ROAD_RIGHT; x += 46) tree(x + 10, y - 45, 13);
        }
        // разметка поперечной улицы: двойная сплошная и пунктир между полосами
        const lw = h / this.lanes;
        for (let i = 1; i < this.lanes; i++) {
            const ly = y + i * lw, mid = i === this.lanes / 2;
            for (const [a, b] of [[left ? L : ROAD_LEFT, ROAD_LEFT], [ROAD_RIGHT, right ? R : ROAD_RIGHT]]) {
                if (b <= a) continue;
                if (mid) {
                    line(a, ly - 3, b, ly - 3, WHITE, 2);
                    line(a, ly + 3, b, ly + 3, WHITE, 2);
                } else for (let x = a; x < b; x += 50) line(x, ly, Math.min(b, x + 26), ly, WHITE, 3);
            }
        }
        const zw = this.closed * LANE_W;
        for (let x = ROAD_LEFT + zw + 6; x < ROAD_RIGHT - zw - 10; x += 22) {
            fillRect(x, y + h + 2, 12, 26, WHITE);
            if (straight) fillRect(x, y - 28, 12, 26, WHITE);
        }
        const cw = this.closed * LANE_W;
        line(roadMiddle(), this.stopLine, ROAD_RIGHT - cw, this.stopLine, WHITE, 5);
        if (straight) line(ROAD_LEFT + cw, this.farStopLine, roadMiddle(), this.farStopLine, WHITE, 5);
        // стрелки на своих полосах: куда отсюда можно
        const ay = this.stopLine + 60;
        const last = LANES - 1 - this.closed;
        for (let lane = ownFirst(); lane <= last; lane++) {
            const cx = laneCenter(lane), kinds = [];
            if (lane === ownFirst() && left) kinds.push(-1);
            if (lane === last && right) kinds.push(1);
            if (straight && (kinds.length === 0 || last === ownFirst())) kinds.push(0);
            line(cx, ay + 30, cx, ay, WHITE, 4);
            for (const k of kinds) {
                if (k === 0) poly([[cx, ay - 14], [cx - 8, ay - 2], [cx + 8, ay - 2]], WHITE);
                else {
                    line(cx, ay, cx + k * 18, ay, WHITE, 4);
                    poly([[cx + k * 28, ay], [cx + k * 16, ay - 8], [cx + k * 16, ay + 8]], WHITE);
                }
            }
        }
        const w = textWidth(this.name, 14) + 8, sx = left ? 2 : ROAD_LEFT - 38 - w;
        fillRect(sx, y - 28, w, 20, [30, 90, 160], 1, 3);
        text(this.name, sx + 4, y - 18, WHITE, 14, { base: "middle" });
        if (!straight) {
            fillRect(roadMiddle() - 60, y - 60, 120, 24, [30, 90, 200], 1, 4);
            text("ТУПИК: поворот", roadMiddle(), y - 48, WHITE, 13, { bold: true, align: "center", base: "middle" });
        }
    }

    drawLights(frame) {
        const state = this.state, ln = this.stopLine;
        const lamps = [["red", [255, 50, 40]], ["yellow", [255, 200, 30]], ["green", [60, 230, 90]]];
        for (const x of [ROAD_LEFT + this.closed * LANE_W - 18, ROAD_RIGHT - this.closed * LANE_W + 18]) {
            line(x, ln + 10, x, ln - 8, [50, 50, 55], 4);
            fillRect(x - 10, ln - 2, 20, 54, [25, 25, 28], 1, 5);
            lamps.forEach(([name, c], i) => {
                const lit = name === state && !(state === "yellow" && Math.floor(frame / 10) % 2);
                const cy = ln + 8 + i * 17;
                if (lit) circle(x, cy, 13, c, 0.32);
                circle(x, cy, 6, lit ? c : c.map((v) => Math.floor(v / 5)));
            });
        }
    }

    drawCars() {
        this.peds.draw(this.zebraTop);
        for (const c of this.crossCars) {
            const r = this.crossRect(c);
            fillRect(r.x + 4, r.y + 5, r.w, r.h, [0, 0, 0], 0.27, 11);
            fillRect(r.x, r.y, r.w, r.h, c.color, 1, 11);
            strokeRect(r.x, r.y, r.w, r.h, BLACK, 2, 11);
            const front = c.dir > 0 ? r.x + r.w - 31 : r.x + 14;
            const back = c.dir > 0 ? r.x + 13 : r.x + r.w - 25;
            fillRect(front, r.y + 6, 17, r.h - 12, GLASS, 1, 4);
            fillRect(back, r.y + 7, 12, r.h - 14, GLASS, 1, 4);
        }
    }
}

// пешеходы на зебре: переходят дорогу поперёк, ждут у бордюра, если маршрутка несётся
class PedLane {
    constructor() {
        this.peds = [];
        this.cool = randint(20, 160);
    }

    update(canSpawn, rate, busClose, bus = null, top = 0) {
        // пешеход сам в маршрутку не лезет: если она стоит на зебре — ждёт или обходит позже
        const busRect = bus && !bus.air ? inflate(bus.rect, 14, 14) : null;
        if (canSpawn && --this.cool <= 0) {
            this.cool = Math.floor(randint(90, 280) / rate);
            if (this.peds.length < 5) {
                const dir = choice([-1, 1]);
                this.peds.push({
                    x: dir > 0 ? ROAD_LEFT - 26 : ROAD_RIGHT + 26, dir, dy: rand(6, 24), speed: rand(0.9, 1.5),
                    color: choice(PEOPLE_COLORS), phase: rand(0, 6), jump: 0, hit: false,
                });
            }
        }
        for (const p of this.peds) {
            if (p.jump > 0) {                       // отпрыгнул от маршрутки
                p.jump -= 1;
                p.x += p.dir * 4;
                continue;
            }
            const atCurb = p.dir > 0 ? p.x < ROAD_LEFT + 2 && p.x > ROAD_LEFT - 12 : p.x > ROAD_RIGHT - 2 && p.x < ROAD_RIGHT + 12;
            if (atCurb && busClose) continue;      // ждёт у бордюра
            if (busRect && hit(this.rect({ ...p, x: p.x + p.dir * p.speed * 4 }, top), busRect)) continue;
            p.x += p.dir * p.speed;
            p.phase += 0.3;
        }
        this.peds = this.peds.filter((p) => p.x > ROAD_LEFT - 60 && p.x < ROAD_RIGHT + 60);
    }

    get onRoad() {
        return this.peds.some((p) => !p.jump && p.x > ROAD_LEFT - 4 && p.x < ROAD_RIGHT + 4);
    }

    blocks(x) {
        // есть ли пешеход на полосе x или вот-вот на неё шагнёт
        return this.peds.some((p) => !p.jump && p.x > ROAD_LEFT - 8 && p.x < ROAD_RIGHT + 8 && Math.abs(p.x - x) < 70);
    }

    rect(p, top) {
        return rect(p.x - 7, top + p.dy - 17, 14, 30);
    }

    draw(top) {
        for (const p of this.peds) {
            const x = p.x, y = top + p.dy, step = Math.sin(p.phase) * 4;
            ellipse(x + 2, y + 3, 9, 6, [0, 0, 0], 0.25);
            line(x - 3, y, x - 3 + step, y + 8, BLACK, 3);
            line(x + 3, y, x + 3 - step, y + 8, BLACK, 3);
            fillRect(x - 7, y - 9, 14, 13, p.color, 1, 5);
            circle(x, y - 12, 5.5, SKIN);
            circle(x, y - 14, 4, [70, 50, 35]);
            if (p.jump) text("Ай!", x, y - 28, WHITE, 13, { bold: true, align: "center", base: "middle", shadow: true });
        }
    }
}

class Crosswalk {
    // нерегулируемый пешеходный переход посреди квартала
    static H = 34;

    constructor(y, rate) {
        this.y = y;
        this.rate = rate;
        this.peds = new PedLane();
        this.polite = false;
    }

    get bottom() {
        return this.y + Crosswalk.H;
    }

    draw(cw = 0) {
        // зебра только по проезжей части; cw — ширина тротуара-плитки на месте закрытых полос
        const y = this.y, L = ROAD_LEFT + cw, R = ROAD_RIGHT - cw;
        for (let x = L + 8; x < R - 10; x += 24) fillRect(x, y, 13, Crosswalk.H, WHITE, 0.92);
        line(L, y + Crosswalk.H + 26, R, y + Crosswalk.H + 26, WHITE, 2, 0.5);
        for (const [sx, sy] of [[L - 18, y + 46], [R + 18, y - 20]]) {
            line(sx, sy + 10, sx, sy + 24, [60, 60, 60], 3);
            fillRect(sx - 11, sy - 11, 22, 22, [30, 90, 200], 1, 3);
            poly([[sx, sy - 8], [sx - 9, sy + 8], [sx + 9, sy + 8]], WHITE);
            circle(sx, sy - 1, 2, BLACK);
            line(sx, sy + 1, sx, sy + 6, BLACK, 2);
        }
    }
}

class Bridge {
    // мост через реку: вода во всю ширину, у дороги перила
    constructor(y, h) {
        this.y = y;
        this.h = h;
    }

    drawWater(frame) {
        const y = this.y, h = this.h, x0 = -MARGIN, w = WIDTH + MARGIN * 2;
        fillRect(x0, y - 14, w, h + 28, [150, 145, 132]);
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, "rgb(55,110,165)");
        g.addColorStop(0.5, "rgb(65,130,185)");
        g.addColorStop(1, "rgb(50,105,160)");
        ctx.fillStyle = g;
        ctx.fillRect(x0, y, w, h);
        for (let i = 0; i < 14; i++) {
            const wy = y + 12 + ((i * 37) % (h - 24));
            const wx = x0 + ((i * 131 + frame * (0.4 + (i % 3) * 0.2)) % w);
            line(wx, wy, wx + 30, wy, [150, 200, 240], 2, 0.5);
        }
        const bx = (frame * 0.3) % (w + 200) - 100 + x0;   // плывёт лодочка
        ellipse(bx, y + h * 0.3, 20, 8, [140, 80, 50]);
        ellipse(bx, y + h * 0.3, 14, 5, [200, 160, 110]);
    }

    drawDeck() {
        const y = this.y, h = this.h;
        for (const x of [ROAD_LEFT - 22, ROAD_RIGHT]) {
            fillRect(x, y - 14, 22, h + 28, [165, 165, 160]);
            line(x + (x < ROAD_LEFT ? 3 : 19), y - 14, x + (x < ROAD_LEFT ? 3 : 19), y + h + 14, [70, 70, 75], 4);
            for (let ry = y - 10; ry < y + h + 10; ry += 18) circle(x + (x < ROAD_LEFT ? 3 : 19), ry, 3, [90, 90, 95]);
        }
    }
}

class LaneShift {
    // смена ширины дороги: ниже y открыто from полос на сторону, выше — to; между ними плавный скос
    static TAPER = 260;

    constructor(y, from, to, style) {
        this.y = y;
        this.from = from;
        this.to = to;
        this.style = style;         // выше смены: "tiles" — сплошная плитка, "parking" — у дороги парковка
    }
}

class Ramp {
    static W = 74;
    static H = 56;

    constructor(lane, y) {
        this.x = laneCenter(lane);
        this.y = y;
    }

    get rect() {
        return rect(this.x - Ramp.W / 2, this.y, Ramp.W, Ramp.H);
    }

    draw() {
        const r = this.rect;
        fillRect(r.x + 5, r.y + 6, r.w, r.h, [0, 0, 0], 0.31, 4);
        const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);   // верх выше и светлее
        g.addColorStop(0, "rgb(220,220,200)");
        g.addColorStop(1, "rgb(120,120,100)");
        ctx.fillStyle = g;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        for (let i = 0; i < r.w; i += 16) {
            poly([[r.x + i, r.y + r.h], [r.x + i + 8, r.y + r.h], [r.x + i + 14, r.y + r.h - 10], [r.x + i + 6, r.y + r.h - 10]], YELLOW);
        }
        strokeRect(r.x, r.y, r.w, r.h, BLACK, 2, 4);
        poly([[r.x + r.w / 2, r.y + 8], [r.x + r.w / 2 - 12, r.y + 26], [r.x + r.w / 2 + 12, r.y + 26]], [250, 250, 250]);
    }
}

class PoliceStation {
    // отдел полиции у дороги: если проезжаешь мимо в розыске — оттуда выезжает погоня
    static HEIGHT = 300;

    constructor(y, edge) {
        this.y = y;
        this.edge = edge;           // правый край открытой дороги
        this.checked = false;
    }

    draw(frame) {
        const y = this.y, H = PoliceStation.HEIGHT, e = this.edge;
        fillRect(e, y - 20, WIDTH + MARGIN - e, H + 40, SIDEWALK);
        fillRect(e + 6, y + 10, 76, H - 20, [80, 80, 86], 1, 6);               // стоянка служебных машин
        for (let i = 0; i < 3; i++) {
            const cy = y + 22 + i * 90;
            line(e + 10, cy - 8, e + 78, cy - 8, WHITE, 2, 0.6);
            fillRect(e + 22, cy, 44, 74, [235, 235, 240], 1, 9);
            fillRect(e + 22, cy + 30, 44, 11, [30, 70, 170]);
            fillRect(e + 27, cy + 8, 34, 14, GLASS, 1, 3);
            const on = (Math.floor(frame / 8) + i) % 2;
            fillRect(e + 28, cy + 24, 14, 5, on ? [255, 40, 40] : [110, 30, 30]);
            fillRect(e + 46, cy + 24, 14, 5, !on ? [60, 120, 255] : [30, 40, 110]);
        }
        const bx = e + 96, bw = 190;
        shadow(bx, y + 20, bw, H - 40, 12);
        fillRect(bx, y + 20, bw, H - 40, [165, 172, 185], 1, 4);              // здание
        strokeRect(bx + 6, y + 26, bw - 12, H - 52, [130, 138, 150], 3, 3);
        fillRect(bx, y + H / 2 - 16, bw, 32, [30, 70, 170]);
        text("ПОЛИЦИЯ", bx + bw / 2, y + H / 2, WHITE, 18, { bold: true, align: "center", base: "middle" });
        line(bx - 8, y + 30, bx - 8, y + 70, [200, 200, 200], 3);              // флагшток
        fillRect(bx - 8, y + 30, 20, 12, [235, 235, 240]);
        fillRect(bx - 8, y + 36, 20, 6, [40, 80, 190]);
    }
}

class PolicePost {
    static HEIGHT = 90;

    constructor(y) {
        this.y = y;
        this.checked = false;
    }

    draw(frame) {
        const x = ROAD_RIGHT + 10, y = this.y;
        fillRect(ROAD_RIGHT, y - 10, 90, 110, SIDEWALK, 1, 8);
        const sx = ROAD_LEFT - 15, sy = y + 330;   // знак ограничения скорости заранее
        line(sx, sy + 12, sx, sy + 30, [60, 60, 60], 3);
        circle(sx, sy, 14, WHITE);
        ring(sx, sy, 12, [220, 30, 30], 4);
        text(String(SPEED_LIMIT), sx, sy, BLACK, 11, { bold: true, align: "center", base: "middle" });
        fillRect(x + 4, y + 6, 40, 50, [0, 0, 0], 0.27);
        fillRect(x, y, 40, 50, [230, 230, 235], 1, 4);
        fillRect(x, y + 18, 40, 12, [30, 70, 170]);
        text("ДПС", x + 20, y + 24, WHITE, 11, { bold: true, align: "center", base: "middle" });
        const px = x + 52, py = y + 64;            // инспектор с жезлом
        fillRect(px - 7, py, 14, 18, [60, 90, 60], 1, 4);
        circle(px, py - 6, 7, SKIN);
        ring(px, py - 9, 6, [40, 60, 40], 3);
        const a = Math.sin(frame * 0.12) * 0.6;
        const ex = px - 6 - Math.cos(a) * 18, ey = py + 4 + Math.sin(a) * 18;
        line(px - 6, py + 4, ex, ey, WHITE, 4);
        line(px - 6, py + 4, (px - 6 + ex) / 2, (py + 4 + ey) / 2, BLACK, 4);
        if (!this.checked) {                       // луч радара
            poly([[x, y + 40], [ROAD_RIGHT - LANE_W * 2, y + 140], [ROAD_RIGHT - LANE_W * 2, y - 60]],
                [255, 60, 60], (40 + 20 * Math.sin(frame * 0.2)) / 255);
        }
    }
}
