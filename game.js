// Маршрутка 480 — веб-версия (форк игры на pygame).
//
// Управление:
//   ← / →   руль; на перекрёстке прижмись к краю и рули дальше — поворот
//   ↑       газ (на заднем ходу — тормоз)
//   ↓       тормоз; если стоишь и держишь — задний ход
//   P / Esc пауза
// Лобби: ↑ ↓ — выбрать улучшение, Enter (или клик) — купить, Пробел — в рейс.

"use strict";

// ---------- настройки ----------
const WIDTH = 640, HEIGHT = 760;
const HUD_H = 70;

const ROAD_LEFT = 130, ROAD_RIGHT = 530;
const LANES = 4;
const LANE_W = (ROAD_RIGHT - ROAD_LEFT) / LANES;

const BUS_W = 56, BUS_H = 116;
const CAR_W = 50, CAR_H = 92;

const MAX_SPEED = 13, MAX_REVERSE = 4;
const ACCEL = 0.13, BRAKE = 0.4, FRICTION = 0.03, STEER_SPEED = 4.5;
const KMH = 7;                 // пикселей/кадр -> км/ч на спидометре

const CAPACITY = 15, FARE = 60;
const COMPLAINT_FINE = 20, POLICE_FINE = 500, WRONG_STOP_FINE = 150;
const MAX_COMPLAINTS = 10, SPEED_LIMIT = 70;

const BLOCK = 3000;            // длина квартала (расстояние между перекрёстками)
const CROSS_H = 120;           // ширина поперечной улицы
const GREEN_T = 300, YELLOW_T = 70, RED_T = 280;
const CYCLE = GREEN_T + YELLOW_T + RED_T;
const COMBO_TIME = 240;
const MAX_COMBO = 5;
const SLALOM_COOLDOWN = 300;
const TURN_FRAMES = 36;
const SAVE_KEY = "marshrutka480";

// улучшения: ключ, название, описание, цены по уровням
const UPGRADES = [
    ["engine", "Мотор", "+скорость и разгон", [300, 700, 1500]],
    ["brakes", "Тормоза", "тормозит резче", [200, 500, 1000]],
    ["steer", "Руль", "быстрее перестраивается", [200, 500, 1000]],
    ["seats", "Салон", "+3 места", [400, 900, 1800]],
    ["fare", "Тариф", "+10 руб. за проезд", [500, 1200, 2500]],
    ["airbag", "Подушка", "переживёт 1 аварию за рейс", [800, 2000, 4000]],
    ["blat", "Блат в ДПС", "штраф меньше, погоня короче", [400, 900, 1800]],
];

const STOP_NAMES = [
    "Рынок", "Школа №5", "Больница", "Площадь", "Вокзал", "Парк",
    "Завод", "Библиотека", "Стадион", "ТЦ «Радуга»", "Почта",
    "Улица Садовая", "Микрорайон", "Мост", "Конечная",
];
const OTHER_ROUTES = ["12", "37", "105", "7", "64", "Тр.3"];
const STREETS_V = ["ул. Ленина", "ул. Гагарина", "пр. Мира", "ул. Пушкина",
    "ул. Садовая", "ул. Советская", "ул. Лесная", "ул. Школьная"];
const STREETS_H = ["ул. Победы", "ул. Кирова", "ул. Набережная", "пр. Строителей",
    "ул. Чехова", "ул. Заводская", "ул. Молодёжная", "ул. Центральная"];

const CAR_COLORS = [
    [200, 40, 40], [40, 90, 200], [30, 140, 60], [120, 120, 130],
    [230, 230, 230], [35, 35, 40], [150, 60, 160], [220, 120, 30],
];
const PEOPLE_COLORS = [
    [60, 80, 160], [170, 50, 60], [50, 130, 80], [200, 150, 40],
    [110, 70, 150], [40, 140, 160], [90, 90, 90],
];
const ROOF_COLORS = [
    [120, 110, 100], [150, 90, 80], [95, 105, 120], [140, 135, 120],
    [110, 80, 70], [85, 95, 90], [160, 150, 140],
];

// цвета
const GROUND = [85, 90, 85];
const ASPHALT = [60, 60, 65];
const SIDEWALK = [170, 170, 160];
const WHITE = [240, 240, 240];
const YELLOW = [245, 200, 30];
const ORANGE = [255, 150, 30];
const BLACK = [15, 15, 15];
const GLASS = [120, 170, 210];
const HUD_BG = [25, 25, 30];
const GREEN = [110, 230, 110];
const RED = [255, 100, 90];
const BLUE = [140, 200, 255];
const PINK = [255, 120, 220];
const SKIN = [240, 200, 160];

const FONT = "Arial, Helvetica, sans-serif";

// ---------- утилиты ----------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const rand = (a, b) => a + Math.random() * (b - a);
const randint = (a, b) => Math.floor(rand(a, b + 1));
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mod = (a, n) => ((a % n) + n) % n;
const col = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const darker = (c, d) => c.map((v) => Math.max(0, v - d));

function laneCenter(lane) {
    return ROAD_LEFT + LANE_W * lane + LANE_W / 2;
}

function approach(value, target, step) {
    if (Math.abs(target - value) <= step) return target;
    return value + (target > value ? step : -step);
}

function streetName(vertical, k) {
    const names = vertical ? STREETS_V : STREETS_H;
    return names[mod(k, names.length)];
}

function rect(x, y, w, h) {
    return { x, y, w, h };
}

function inflate(r, dx, dy) {
    return rect(r.x - dx / 2, r.y - dy / 2, r.w + dx, r.h + dy);
}

function hit(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function fillRect(x, y, w, h, c, a = 1, radius = 0) {
    ctx.fillStyle = col(c, a);
    if (radius) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
        ctx.fill();
    } else {
        ctx.fillRect(x, y, w, h);
    }
}

function strokeRect(x, y, w, h, c, width = 2, radius = 0, a = 1) {
    ctx.strokeStyle = col(c, a);
    ctx.lineWidth = width;
    ctx.beginPath();
    if (radius) ctx.roundRect(x, y, w, h, radius);
    else ctx.rect(x, y, w, h);
    ctx.stroke();
}

function circle(x, y, r, c, a = 1) {
    ctx.fillStyle = col(c, a);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
}

function ring(x, y, r, c, width = 2) {
    ctx.strokeStyle = col(c);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
}

function line(x1, y1, x2, y2, c, width = 2, a = 1) {
    ctx.strokeStyle = col(c, a);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
}

function poly(points, c, a = 1) {
    ctx.fillStyle = col(c, a);
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
}

function text(str, x, y, c, size = 14, opts = {}) {
    ctx.font = `${opts.bold ? "bold " : ""}${size}px ${FONT}`;
    ctx.textAlign = opts.align || "left";
    ctx.textBaseline = opts.base || "top";
    if (opts.shadow) {
        ctx.fillStyle = col(BLACK, opts.alpha ?? 1);
        ctx.fillText(str, x + 2, y + 2);
    }
    ctx.fillStyle = col(c, opts.alpha ?? 1);
    ctx.fillText(str, x, y);
}

function textWidth(str, size = 14, bold = false) {
    ctx.font = `${bold ? "bold " : ""}${size}px ${FONT}`;
    return ctx.measureText(str).width;
}

function loadSave() {
    const data = { wallet: 0, best: 0, upgrades: {} };
    try {
        Object.assign(data, JSON.parse(localStorage.getItem(SAVE_KEY)) || {});
    } catch (e) { /* нет сохранения — начинаем с нуля */ }
    return data;
}

function writeSave(data) {
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) { /* приватный режим — просто не сохраняем */ }
}

// ---------- эффекты ----------
class Particle {
    constructor(x, y, vx, vy, life, color, size, grow = 0, world = true, gravity = 0) {
        Object.assign(this, { x, y, vx, vy, life, color, size, grow, world, gravity });
        this.maxLife = life;
    }

    update(scroll) {
        this.x += this.vx;
        this.y += this.vy + (this.world ? scroll : 0);
        this.vy += this.gravity;
        this.vx *= 0.97;
        this.size += this.grow;
        this.life -= 1;
    }

    draw() {
        circle(this.x, this.y, this.size, this.color, this.life / this.maxLife);
    }
}

class FloatText {
    constructor(str, x, y, color, big = false) {
        Object.assign(this, { str, x, y, color, big });
        this.life = this.maxLife = big ? 80 : 70;
    }

    update(scroll) {
        this.y += scroll - 1;
        this.life -= 1;
    }

    draw() {
        const size = this.big ? 24 : 18;
        const w = textWidth(this.str, size, true);
        const x = clamp(this.x, 4 + w / 2, WIDTH - 4 - w / 2);
        const y = clamp(this.y, HUD_H + size, HEIGHT - size);
        const alpha = Math.min(1, (this.life / this.maxLife) * 1.6);
        text(this.str, x, y, this.color, size, { bold: true, align: "center", base: "middle", shadow: true, alpha });
    }
}

class Coin {
    constructor(x, y) {
        this.x = this.sx = x;
        this.y = this.sy = y;
        this.t = 0;
    }

    update() {
        this.t += 0.03;
        const k = 1 - (1 - Math.min(1, this.t)) ** 3;
        this.x = this.sx + (26 - this.sx) * k;
        this.y = this.sy + (20 - this.sy) * k - Math.sin(k * Math.PI) * 80;
    }

    get done() {
        return this.t >= 1;
    }

    draw() {
        const w = Math.max(2, 14 * Math.abs(Math.cos(this.t * 12)));
        ctx.fillStyle = col([255, 210, 40]);
        ctx.strokeStyle = col([180, 130, 10]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(this.x, this.y, w / 2, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
}

// ---------- город (полосы домов/деревьев, зациклены — работают и при заднем ходе) ----------
class Strip {
    static LENGTH = 1600;

    constructor(x, w, kind) {
        Object.assign(this, { x, w, kind });
        this.items = [];
        let y = 0;
        while (y < Strip.LENGTH) {
            if (kind === "houses") {
                const h = randint(90, 220);
                const details = [];
                for (let i = randint(1, 3); i > 0; i--) {
                    details.push([randint(6, Math.max(7, w - 20)), randint(8, h - 24), randint(8, 16)]);
                }
                this.items.push({ start: y, h, color: choice(ROOF_COLORS), details });
                y += h + randint(6, 16);
            } else {
                this.items.push({ start: y, h: 0 });
                y += randint(70, 140);
            }
        }
    }

    draw(offset) {
        for (const it of this.items) {
            const y = Math.floor(mod(it.start + offset, Strip.LENGTH)) - 300;
            if (y > HEIGHT || y + it.h < -40) continue;
            if (this.kind === "houses") {
                fillRect(this.x + 5, y + 6, this.w, it.h, [50, 50, 55]);
                fillRect(this.x, y, this.w, it.h, it.color);
                const dark = darker(it.color, 35);
                strokeRect(this.x + 1.5, y + 1.5, this.w - 3, it.h - 3, dark, 3);
                line(this.x + 3, y + it.h / 2, this.x + this.w - 3, y + it.h / 2, dark, 2);
                for (const [dx, dy, size] of it.details) {   // кондиционеры, люки на крыше
                    fillRect(this.x + dx, y + dy, size, size, [200, 200, 205]);
                    strokeRect(this.x + dx, y + dy, size, size, [110, 110, 115], 1);
                }
            } else if (this.kind === "trees") {
                circle(this.x + 3, y + 4, 15, [40, 70, 35]);
                circle(this.x, y, 15, [45, 110, 45]);
                circle(this.x - 4, y - 4, 7, [75, 150, 65]);
            } else {   // фонари
                circle(this.x, y, 5, [80, 80, 85]);
                line(this.x, y, this.x - 24, y, [80, 80, 85], 3);
                circle(this.x - 24, y, 4, [255, 240, 180]);
            }
        }
    }
}

// ---------- объекты ----------
class Bus {
    constructor(up) {
        this.x = laneCenter(1);
        this.y = HEIGHT - 190;
        this.vx = 0;
        this.speed = 0;
        this.braking = false;
        this.accelerating = false;
        this.reverseHold = 0;
        this.doorOpen = 0;       // 0 — закрыта, 1 — открыта
        this.air = 0;            // кадры в полёте
        this.airTotal = 1;
        this.invuln = 0;         // мигание после срабатывания подушки
        // характеристики с учётом улучшений
        this.maxSpeed = MAX_SPEED + (up.engine || 0);
        this.accel = ACCEL * (1 + 0.15 * (up.engine || 0));
        this.brake = BRAKE + 0.12 * (up.brakes || 0);
        this.steerSpeed = STEER_SPEED + 0.8 * (up.steer || 0);
    }

    get rect() {
        return rect(this.x - BUS_W / 2, this.y, BUS_W, BUS_H);
    }

    get centerY() {
        return this.y + BUS_H / 2;
    }

    get doorPos() {
        return [this.x + BUS_W / 2, this.y + 34];
    }

    get z() {
        if (!this.air) return 0;
        const k = 1 - this.air / this.airTotal;
        return Math.sin(k * Math.PI) * this.airTotal * 0.8;
    }

    get xLimits() {
        return [ROAD_LEFT + BUS_W / 2 + 4, ROAD_RIGHT - BUS_W / 2 - 4];
    }

    update(keys) {
        const up = keys.up, down = keys.down;
        let steer = keys.right - keys.left;
        this.accelerating = up && this.speed >= 0;
        this.braking = (down && this.speed > 0) || (up && this.speed < 0);
        this.invuln = Math.max(0, this.invuln - 1);

        if (this.air) {
            this.air -= 1;
            steer *= 0.4;            // в воздухе руль почти не слушается
        } else if (this.speed > 0 || (this.speed === 0 && up)) {
            if (up) this.speed += this.accel * (1.2 - (this.speed / this.maxSpeed) * 0.6);
            else if (down) this.speed -= this.brake;
            else this.speed -= FRICTION;
            this.speed = clamp(this.speed, 0, this.maxSpeed);
            this.reverseHold = 0;
        } else if (down) {           // стоим или едем назад
            this.reverseHold += 1;
            if (this.reverseHold > 20) this.speed = Math.max(-MAX_REVERSE, this.speed - 0.08);
        } else {
            this.reverseHold = 0;
            this.speed = approach(this.speed, 0, up ? this.brake : FRICTION * 2);
        }

        this.vx += (steer * this.steerSpeed - this.vx) * 0.18;
        this.x += this.vx;
        const [left, right] = this.xLimits;
        if (this.x < left || this.x > right) {
            this.x = clamp(this.x, left, right);
            this.vx = 0;
        }
    }

    draw(frame) {
        if (this.invuln && Math.floor(frame / 4) % 2) return;
        const z = this.z;
        const angle = (this.vx * 2.2 * Math.PI) / 180;
        const cx = this.x, cy = this.centerY;

        // тень (в полёте — отстаёт)
        ctx.save();
        ctx.translate(cx + 4 + z * 0.5, cy + 5 + z * 0.7);
        ctx.rotate(angle);
        fillRect(-BUS_W / 2 - 4, -BUS_H / 2 - 4, BUS_W + 8, BUS_H + 8, [0, 0, 0], z ? 0.24 : 0.32, 10);
        ctx.restore();

        ctx.save();
        ctx.translate(cx, cy - z * 0.3);
        ctx.rotate(angle);
        const s = 1 + z / 220;
        ctx.scale(s, s);
        const x = -BUS_W / 2, y = -BUS_H / 2, r = { x, y, right: x + BUS_W, bottom: y + BUS_H };
        const reversing = this.speed < 0;
        if (this.braking) for (const gx of [r.x + 9, r.right - 9]) circle(gx, r.bottom + 2, 9, [255, 40, 30], 0.35);
        if (reversing) for (const gx of [r.x + 9, r.right - 9]) circle(gx, r.bottom + 4, 10, [255, 255, 255], 0.45);
        fillRect(x, y, BUS_W, BUS_H, YELLOW, 1, 9);
        strokeRect(x, y, BUS_W, BUS_H, BLACK, 2, 9);
        fillRect(x + 6, y + 9, BUS_W - 12, 20, GLASS, 1, 4);
        fillRect(x + 8, r.bottom - 17, BUS_W - 16, 10, GLASS, 1, 3);
        for (let i = 0; i < BUS_W - 8; i += 8) fillRect(x + 4 + i, y + 34 + ((i / 8) % 2) * 4, 4, 4, BLACK);
        text("480", 0, 10, BLACK, 18, { bold: true, align: "center", base: "middle" });
        const tail = reversing ? WHITE : this.braking ? [255, 60, 50] : [140, 30, 30];
        fillRect(x + 4, r.bottom - 5, 10, 4, tail);
        fillRect(r.right - 14, r.bottom - 5, 10, 4, tail);
        circle(x + 9, y + 3, 3, WHITE);
        circle(r.right - 9, y + 3, 3, WHITE);
        // дверь справа: отъезжает назад при открытии
        fillRect(r.right - 4, y + 21, 5, 26, [40, 40, 45]);
        fillRect(r.right - 4, y + 21 + this.doorOpen * 22, 5, 26, [215, 175, 20]);
        if (this.doorOpen > 0.5) circle(r.right - 10, y + 14, 3, [90, 230, 90]);
        ctx.restore();
    }
}

function drawCarBody(r, color, braking) {
    fillRect(r.x + 4, r.y + 5, r.w, r.h, [0, 0, 0], 0.27, 11);
    fillRect(r.x, r.y, r.w, r.h, color, 1, 11);
    strokeRect(r.x, r.y, r.w, r.h, BLACK, 2, 11);
    fillRect(r.x + 6, r.y + 14, r.w - 12, 17, GLASS, 1, 4);
    fillRect(r.x + 7, r.y + r.h - 25, r.w - 14, 12, GLASS, 1, 4);
    const tail = braking ? [255, 50, 40] : [170, 30, 30];
    circle(r.x + 7, r.y + r.h - 3, 4, tail);
    circle(r.x + r.w - 7, r.y + r.h - 3, 4, tail);
}

class Car {
    constructor(lane, y, speed) {
        this.lane = this.targetLane = lane;
        this.x = laneCenter(lane);
        this.y = y;
        this.baseSpeed = this.speed = speed;
        this.color = choice(CAR_COLORS);
        this.blink = 0;
        this.braking = false;
        this.nearDone = false;   // за эту машину уже дали «впритирку»
    }

    get rect() {
        return rect(this.x - CAR_W / 2, this.y, CAR_W, CAR_H);
    }

    get changing() {
        return this.targetLane !== this.lane;
    }

    draw(frame) {
        const r = this.rect;
        drawCarBody(r, this.color, this.braking);
        if (this.changing && Math.floor(frame / 8) % 2 === 0) {
            const sx = this.targetLane > this.lane ? r.x + r.w - 3 : r.x + 3;
            circle(sx, r.y + 4, 5, ORANGE);
            circle(sx, r.y + r.h - 4, 5, ORANGE);
        }
    }
}

class Police {
    static W = 52;
    static H = 96;

    constructor(x, speed) {
        this.x = x;
        this.y = HEIGHT + 60;
        this.speed = speed;
        this.leaving = false;
        this.touch = 0;
        this.timer = 0;
    }

    get rect() {
        return rect(this.x - Police.W / 2, this.y, Police.W, Police.H);
    }

    draw(frame) {
        const r = this.rect;
        fillRect(r.x + 4, r.y + 5, r.w, r.h, [0, 0, 0], 0.27, 11);
        fillRect(r.x, r.y, r.w, r.h, [235, 235, 240], 1, 11);
        fillRect(r.x, r.y + 38, r.w, 14, [30, 70, 170]);
        strokeRect(r.x, r.y, r.w, r.h, BLACK, 2, 11);
        fillRect(r.x + 6, r.y + 12, r.w - 12, 17, GLASS, 1, 4);
        fillRect(r.x + 7, r.y + r.h - 25, r.w - 14, 12, GLASS, 1, 4);
        const on = Math.floor(frame / 6) % 2 === 0 && !this.leaving;
        fillRect(r.x + 8, r.y + 32, 16, 6, on ? [255, 40, 40] : [110, 30, 30]);
        fillRect(r.x + r.w - 24, r.y + 32, 16, 6, !on ? [60, 120, 255] : [30, 40, 110]);
        if (!this.leaving) circle(r.x + r.w / 2, r.y + 35, 34, on ? [255, 40, 40] : [60, 120, 255], 0.27);
    }
}

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
            this.tx = ROAD_RIGHT + 50 + randint(-6, 6);
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
    static HEIGHT = 140;

    constructor(id, y) {
        this.id = id;                         // null — чужая остановка
        this.ours = id !== null;
        this.route = this.ours ? "480" : choice(OTHER_ROUTES);
        this.name = this.ours ? STOP_NAMES[id % STOP_NAMES.length] : choice(STOP_NAMES);
        this.y = y;
        this.waiting = randint(1, 7);
        this.colors = Array.from({ length: 10 }, () => choice(PEOPLE_COLORS));
        this.visited = false;
        this.exited = 0;
        this.boarded = 0;
    }

    get centerY() {
        return this.y + BusStop.HEIGHT / 2;
    }

    get shelterPos() {
        return [ROAD_RIGHT + 40, this.y + 40];
    }

    draw(frame, active) {
        const x = ROAD_RIGHT + 8, y = this.y, H = BusStop.HEIGHT;
        const bay = rect(ROAD_RIGHT - LANE_W + 6, y, LANE_W - 12, H);
        if (this.ours) {
            const c = active ? GREEN : YELLOW;
            strokeRect(bay.x, bay.y, bay.w, bay.h, c, 3);
            for (let i = bay.y + 10; i < bay.y + bay.h - 10; i += 22) line(bay.x + 6, i + 12, bay.x + bay.w - 6, i, c, 2);
        } else {
            // чужой карман: красный пунктир и номер чужого маршрута на асфальте
            for (let i = bay.y; i < bay.y + bay.h; i += 16) {
                line(bay.x, i, bay.x, i + 8, [220, 60, 50], 3);
                line(bay.x + bay.w, i, bay.x + bay.w, i + 8, [220, 60, 50], 3);
            }
            text(this.route, bay.x + bay.w / 2, bay.y + bay.h / 2, [230, 230, 230], 14, { align: "center", base: "middle" });
        }
        fillRect(x + 4, y + 6, 64, H - 20, [0, 0, 0], 0.24, 5);
        fillRect(x, y, 64, H - 20, this.ours ? [80, 100, 135] : [110, 90, 90], 1, 5);
        strokeRect(x + 4, y + 4, 56, H - 28, [190, 215, 240], 2, 3);
        const pulse = this.ours && !this.visited ? 2 + 2 * Math.sin(frame * 0.15) : 0;
        line(x + 32, y - 4, x + 32, y - 20, [60, 60, 60], 3);
        circle(x + 32, y - 28, 12 + pulse, WHITE);
        ring(x + 32, y - 28, 12 + pulse, [30, 90, 200], 2);
        text("А", x + 32, y - 28, [30, 90, 200], 14, { align: "center", base: "middle" });
        // табличка с номером маршрута
        const pw = textWidth(this.route, 14) + 8;
        fillRect(x + 32 - pw / 2, y - 13, pw, 18, this.ours ? YELLOW : [190, 50, 45], 1, 3);
        text(this.route, x + 32, y - 4, this.ours ? BLACK : WHITE, 14, { align: "center", base: "middle" });
        for (let i = 0; i < Math.min(this.waiting, 10); i++) {
            const px = x + 14 + (i % 3) * 18;
            const py = y + 26 + Math.floor(i / 3) * 28 + Math.sin(frame * 0.1 + i) * 1.5;
            circle(px, py, 6, SKIN);
            fillRect(px - 6, py + 6, 12, 14, this.colors[i], 1, 4);
        }
    }
}

class Intersection {
    // Перекрёсток со светофором и поперечным движением
    static HEIGHT = CROSS_H + 70;

    constructor(y, lineCoord, name) {
        this.y = y;                 // верх поперечной улицы
        this.line = lineCoord;      // координата перекрёстка вдоль улицы
        this.name = name;           // название поперечной улицы
        this.t = randint(0, CYCLE);
        this.passed = false;        // маршрутка уже пересекла стоп-линию
        this.crossCars = [];        // {x, offset, dir, color}
    }

    get stopLine() {
        return this.y + CROSS_H + 34;
    }

    get phase() {
        return this.t % CYCLE;
    }

    get state() {
        if (this.phase < GREEN_T) return "green";
        if (this.phase < GREEN_T + YELLOW_T) return "yellow";
        return "red";
    }

    update(scroll) {
        this.y += scroll;
        this.t += 1;
        const redLeft = CYCLE - this.phase;
        // поперечные машины едут, пока у нас красный (и не в самом его конце)
        if (this.state === "red" && redLeft > 110 && this.y > -CROSS_H && this.y < HEIGHT && Math.random() < 0.035) {
            const dir = choice([-1, 1]);
            const offset = dir < 0 ? 6 : CROSS_H - 6 - CAR_W;
            const x = dir > 0 ? -CAR_H - 10 : WIDTH + 10;
            if (this.crossCars.every((c) => Math.abs(c.x - x) > CAR_H * 2 || c.dir !== dir)) {
                this.crossCars.push({ x, offset, dir, color: choice(CAR_COLORS) });
            }
        }
        for (const c of this.crossCars) c.x += c.dir * 6;
        this.crossCars = this.crossCars.filter((c) => c.x > -CAR_H - 40 && c.x < WIDTH + 40);
    }

    crossRect(c) {
        return rect(c.x, this.y + c.offset, CAR_H, CAR_W);
    }

    contains(y) {
        return y > this.y + 10 && y < this.y + CROSS_H - 10;
    }

    drawRoad() {
        const y = this.y;
        fillRect(0, y, WIDTH, CROSS_H, ASPHALT);
        for (let x = 0; x < WIDTH; x += 50) {
            if (!(x > ROAD_LEFT && x < ROAD_RIGHT)) line(x, y + CROSS_H / 2, x + 26, y + CROSS_H / 2, WHITE, 3);
        }
        for (const zy of [y - 28, y + CROSS_H + 2]) {
            for (let x = ROAD_LEFT + 6; x < ROAD_RIGHT - 10; x += 22) fillRect(x, zy, 12, 26, WHITE);
        }
        line(ROAD_LEFT, this.stopLine, ROAD_RIGHT, this.stopLine, WHITE, 5);
        // стрелки поворотов на крайних полосах и табличка улицы
        for (const [lane, sign] of [[0, -1], [LANES - 1, 1]]) {
            const cx = laneCenter(lane), ay = this.stopLine + 60;
            line(cx, ay + 30, cx, ay, WHITE, 4);
            line(cx, ay, cx + sign * 18, ay, WHITE, 4);
            poly([[cx + sign * 28, ay], [cx + sign * 16, ay - 8], [cx + sign * 16, ay + 8]], WHITE);
        }
        const w = textWidth(this.name, 14) + 8;
        fillRect(2, y - 28, w, 20, [30, 90, 160], 1, 3);
        text(this.name, 6, y - 18, WHITE, 14, { base: "middle" });
    }

    drawLights(frame) {
        const state = this.state, ln = this.stopLine;
        const lamps = [["red", [255, 50, 40]], ["yellow", [255, 200, 30]], ["green", [60, 230, 90]]];
        for (const x of [ROAD_LEFT - 18, ROAD_RIGHT + 18]) {
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

class PolicePost {
    static HEIGHT = 90;

    constructor(y) {
        this.y = y;
        this.checked = false;
    }

    draw(frame) {
        const x = ROAD_RIGHT + 10, y = this.y;
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

// ---------- игра ----------
class Game {
    constructor() {
        this.save = loadSave();
        this.state = "menu";
        this.shopIndex = 0;
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
        const up = this.save.upgrades;
        this.bus = new Bus(up);
        this.capacity = CAPACITY + 3 * (up.seats || 0);
        this.fare = FARE + 10 * (up.fare || 0);
        this.airbags = up.airbag || 0;
        this.policeFine = Math.round(POLICE_FINE * (1 - 0.3 * (up.blat || 0)));
        this.chaseTime = 1500 - 300 * (up.blat || 0);

        this.cars = [];
        this.stops = [];
        this.inters = [];
        this.ramps = [];
        this.posts = [];
        this.police = null;
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
        this.nextIn = { stop: 700, ramp: 2600, post: 4500 };
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
        this.wx = 0;
        this.wy = BLOCK * 0.4;
        this.dir = [0, -1];
        this.trail = [[this.wx, this.wy]];
        this.spawnedLines = new Set();
        this.turnT = 0;
        this.turnSign = 0;
    }

    newStrips() {
        this.strips = [
            new Strip(0, 92, "houses"),
            new Strip(ROAD_RIGHT + 84, WIDTH - ROAD_RIGHT - 84, "houses"),
            new Strip(110, 0, "trees"),
            new Strip(WIDTH - 40, 0, "lamps"),
        ];
    }

    // --- карта города ---
    get along() {
        return this.wx * this.dir[0] + this.wy * this.dir[1];
    }

    get vertical() {
        return this.dir[0] === 0;
    }

    currentStreet() {
        return this.vertical ? streetName(true, Math.round(this.wx / BLOCK)) : streetName(false, Math.round(this.wy / BLOCK));
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
        this.showBanner(`${why} Жалоб: ${this.complaints}/${MAX_COMPLAINTS}`, RED);
        this.floatText(`Жалоба x${n}!`, this.bus.x, this.bus.y - 10, RED, true);
        this.shake = Math.max(this.shake, 6);
        if (this.complaints >= MAX_COMPLAINTS) this.finish("fired");
    }

    stopNearBus() {
        // Остановка, у которой маршрутка сейчас стоит (своя или чужая)
        const bus = this.bus, r = bus.rect;
        if (Math.abs(bus.speed) > 0.3 || bus.air || r.x + r.w < ROAD_RIGHT - 32) return null;
        return this.stops.find((s) => Math.abs(s.centerY - bus.centerY) < 50) || null;
    }

    currentStop() {
        const s = this.stopNearBus();
        return s && s.ours ? s : null;
    }

    boardingCount() {
        return this.walkers.filter((w) => w.kind === "in" && !w.returning).length;
    }

    startChase(reason) {
        if (this.police) return;
        this.police = new Police(this.bus.x, Math.max(this.bus.speed, 0) + 2);
        this.showBanner(`ДПС: ${reason}! Погоня!`, [120, 170, 255]);
        this.floatText("ДПС!", this.bus.x, this.bus.y + BUS_H + 20, [120, 170, 255], true);
    }

    // --- спавн ---
    laneBlockedByBus(lane) {
        return Math.abs(this.bus.x - laneCenter(lane)) < (LANE_W + BUS_W) / 2;
    }

    areaFree(top, height) {
        // Нет ли рядом остановки/перекрёстка/поста/трамплина
        const things = [
            ...this.stops.map((s) => [s.y - 40, BusStop.HEIGHT + 40]),
            ...this.inters.map((i) => [i.y - 40, Intersection.HEIGHT + 160]),
            ...this.posts.map((p) => [p.y, 380]),
            ...this.ramps.map((r) => [r.y, Ramp.H]),
        ];
        return things.every(([y, h]) => top + height + 120 < y || y + h + 120 < top);
    }

    spawnObjects() {
        // перекрёстки стоят строго по сетке города
        const ln = (Math.floor(this.along / BLOCK) + 1) * BLOCK;
        if (!this.spawnedLines.has(ln) && ln - this.along < this.bus.centerY + 900) {
            this.spawnedLines.add(ln);
            const y = this.bus.centerY - (ln - this.along) - CROSS_H / 2;
            const coord = ln * (this.dir[0] + this.dir[1]);
            this.inters.push(new Intersection(y, ln, streetName(!this.vertical, Math.round(coord / BLOCK))));
        }

        const s = this.bus.speed;
        for (const k in this.nextIn) this.nextIn[k] -= s;
        if (this.nextIn.stop <= 0) {
            const y = -BusStop.HEIGHT - 60;
            if (this.areaFree(y, BusStop.HEIGHT)) {
                if (Math.random() < 0.72) this.stops.push(new BusStop(this.nextStopId++, y));
                else this.stops.push(new BusStop(null, y));
                this.nextIn.stop = rand(1600, 2600);
            } else this.nextIn.stop = 200;
        }
        if (this.nextIn.ramp <= 0) {
            const y = -Ramp.H - 60;
            if (this.areaFree(y, Ramp.H)) {
                this.ramps.push(new Ramp(randint(0, LANES - 1), y));
                this.nextIn.ramp = rand(3000, 5500);
            } else this.nextIn.ramp = 200;
        }
        if (this.nextIn.post <= 0) {
            const y = -PolicePost.HEIGHT - 60;
            if (this.areaFree(y, 380) && !this.police) {
                this.posts.push(new PolicePost(y));
                this.nextIn.post = rand(6000, 9000);
            } else this.nextIn.post = 300;
        }
    }

    spawnCar() {
        const lane = randint(0, LANES - 1);
        const speed = rand(3, 8);
        let y;
        if (this.bus.speed > speed) y = -CAR_H - 20;
        else {
            if (this.laneBlockedByBus(lane)) return;
            y = HEIGHT + 20;
        }
        for (const c of this.cars) {
            if ((c.lane === lane || c.targetLane === lane) && Math.abs(c.y - y) < CAR_H * 2.2) return;
        }
        this.cars.push(new Car(lane, y, speed));
    }

    // --- поворот на перекрёстке ---
    tryTurn() {
        const bus = this.bus;
        const steer = this.keys.right - this.keys.left;
        if (!steer || bus.air || bus.speed < 0.5) return;
        const [left, right] = bus.xLimits;
        const atEdge = steer < 0 ? bus.x <= left + 1 : bus.x >= right - 1;
        if (!atEdge) return;
        const inter = this.inters.find((i) => i.contains(bus.centerY));
        if (inter) this.startTurn(steer, inter);
    }

    startTurn(sign, inter) {
        const bus = this.bus;
        // снимок старой улицы — его повернём на 90°
        this.drawWorld(false);
        this.snapshot.getContext("2d").drawImage(canvas, 0, 0);
        this.turnT = TURN_FRAMES;
        this.turnSign = sign;
        this.state = "turning";
        const drift = bus.speed > 8;
        const oldStreet = this.currentStreet();

        // встаём ровно в узел сетки и меняем направление
        if (this.dir[0]) this.wx = inter.line * this.dir[0];
        else this.wy = inter.line * this.dir[1];
        const [dx, dy] = this.dir;
        this.dir = sign > 0 ? [-dy, dx] : [dy, -dx];
        this.trail.push([this.wx, this.wy]);
        this.turns += 1;

        // новая улица: свои непройденные остановки переносим на неё
        const unvisited = this.stops.filter((s) => s.ours && !s.visited).map((s) => s.id);
        if (unvisited.length) this.nextStopId = Math.min(...unvisited);
        this.cars = [];
        this.stops = [];
        this.ramps = [];
        this.posts = [];
        this.walkers = [];
        this.skids = [];
        this.particles = this.particles.filter((p) => !p.world);
        this.texts = [];
        this.newStrips();
        // перекрёсток, на котором стоим: старая улица теперь поперечная
        const ln = Math.round(this.along / BLOCK) * BLOCK;
        this.spawnedLines = new Set([ln]);
        const ni = new Intersection(bus.centerY - CROSS_H / 2, ln, oldStreet);
        ni.t = 0;
        ni.passed = true;
        this.inters = [ni];
        this.nextIn = { stop: 900, ramp: rand(1500, 3500), post: rand(2500, 6000) };
        if (this.police) {
            this.police.y = HEIGHT + 120;
            this.police.x = bus.x;
        }
        bus.x = laneCenter(sign > 0 ? LANES - 1 : 0);
        bus.vx = 0;
        this.showBanner(`Поворот ${sign > 0 ? "направо" : "налево"}: ${this.currentStreet()}`, BLUE);
        if (drift) this.stunt("Дрифт-поворот!", 120);
    }

    // --- обновление ---
    updateCars() {
        const bus = this.bus;
        for (const car of this.cars) {
            if (!car.changing && car.y > 60 && car.y < HEIGHT - 150 && Math.random() < 0.004) {
                const target = car.lane + choice([-1, 1]);
                if (target >= 0 && target < LANES && this.laneFreeFor(car, target)) {
                    car.targetLane = target;
                    car.blink = 50;
                }
            }
            if (car.changing) {
                if (car.blink > 0) car.blink -= 1;
                else {
                    car.x = approach(car.x, laneCenter(car.targetLane), 1.6);
                    if (car.x === laneCenter(car.targetLane)) car.lane = car.targetLane;
                }
            }

            // ближайшее препятствие впереди: машины, маршрутка, ДПС, красный свет
            let aheadGap = null, aheadSpeed = 0;
            const obstacles = this.cars.filter((o) => o !== car).map((o) => [o.x, o.y, CAR_W, CAR_H, o.speed]);
            if (!bus.air) obstacles.push([bus.x, bus.y, BUS_W, BUS_H, bus.speed]);
            if (this.police) obstacles.push([this.police.x, this.police.y, Police.W, Police.H, this.police.speed]);
            for (const [ox, oy, ow, oh, os] of obstacles) {
                if (oy < car.y && Math.abs(ox - car.x) < (CAR_W + ow) / 2 + 4) {
                    const gap = car.y - (oy + oh);
                    if (aheadGap === null || gap < aheadGap) [aheadGap, aheadSpeed] = [gap, os];
                }
            }
            for (const inter of this.inters) {
                const gap = car.y - inter.stopLine, st = inter.state;
                if (gap >= 0 && gap < 160 && st !== "green" && !(st === "yellow" && gap < 40)) {
                    if (aheadGap === null || gap < aheadGap) [aheadGap, aheadSpeed] = [gap, 0];
                }
            }
            if (aheadGap !== null && aheadGap < 80) {
                const ns = Math.min(car.baseSpeed, aheadSpeed - (aheadGap < 30 ? 0.6 : 0));
                car.braking = ns < car.speed - 0.05;
                car.speed = Math.max(0, ns);
            } else {
                car.braking = false;
                car.speed = Math.min(car.baseSpeed, car.speed + 0.05);
            }

            const prev = car.y + CAR_H / 2 - bus.centerY;
            car.y += bus.speed - car.speed;
            const now = car.y + CAR_H / 2 - bus.centerY;
            // «впритирку»: машина проходит рядом с маршруткой на большой скорости
            if (!car.nearDone && prev < 0 && now >= 0 && bus.speed > 7 && !bus.air) {
                const sideGap = Math.abs(car.x - bus.x) - (CAR_W + BUS_W) / 2;
                if (sideGap > 0 && sideGap < 16) {
                    car.nearDone = true;
                    this.stunt("Впритирку!", 40);
                }
            }
        }
        this.cars = this.cars.filter((c) => c.y > -400 && c.y < HEIGHT + 400);
    }

    laneFreeFor(car, lane) {
        for (const o of this.cars) {
            if (o !== car && (o.lane === lane || o.targetLane === lane) && Math.abs(o.y - car.y) < CAR_H * 1.9) return false;
        }
        return !(this.laneBlockedByBus(lane) && Math.abs(this.bus.y - car.y) < 230);
    }

    updatePolice() {
        const p = this.police;
        if (!p) return;
        const bus = this.bus;
        p.timer += 1;
        if (p.leaving) p.speed = approach(p.speed, 0, 0.15);
        else {
            const top = Math.max(14, bus.maxSpeed + 0.5);
            let targetX = bus.x, limit = top;
            for (const car of this.cars) {          // объезжаем машины впереди
                if (car.y < p.y && p.y - (car.y + CAR_H) < 140 && Math.abs(car.x - p.x) < (CAR_W + Police.W) / 2 + 6) {
                    limit = Math.min(limit, car.speed);
                    const lane = Math.floor((p.x - ROAD_LEFT) / LANE_W);
                    for (const cand of [lane - 1, lane + 1]) {
                        if (cand >= 0 && cand < LANES && this.cars.every((c) =>
                            Math.abs(c.x - laneCenter(cand)) > LANE_W / 2 || !(p.y - c.y > -60 && p.y - c.y < 220))) {
                            targetX = laneCenter(cand);
                            limit = top;
                            break;
                        }
                    }
                }
            }
            const gap = p.y - (bus.y + BUS_H);
            const desired = bus.speed + (gap > 60 ? 3 : 0.8);
            p.speed = approach(p.speed, clamp(desired, 0, limit), 0.25);
            p.x = approach(p.x, clamp(targetX, ROAD_LEFT + 30, ROAD_RIGHT - 30), 3);
            if (!bus.air && hit(inflate(p.rect, 16, 16), bus.rect)) p.touch += 1;
            else p.touch = Math.max(0, p.touch - 1);
            if (p.touch > 25) {
                p.leaving = true;
                this.money -= this.policeFine;
                this.comboTimer = 0;
                this.showBanner(`Остановлен ДПС! Штраф ${this.policeFine} руб.`, RED);
                this.floatText(`-${this.policeFine} руб.`, bus.x, bus.y - 30, RED, true);
                this.shake = 8;
            } else if (p.timer > this.chaseTime || p.y > HEIGHT + 450) {
                p.leaving = true;
                this.stunt("Ушёл от ДПС!", 300);
                this.showBanner("Ушёл от погони!", PINK);
            }
        }
        p.y += bus.speed - p.speed;
        if (p.leaving && (p.y > HEIGHT + 300 || p.y < -400)) this.police = null;
    }

    updateStops() {
        for (const s of this.stops) s.y += this.bus.speed;
        for (const stop of this.stops.filter((s) => s.y > HEIGHT + 40)) {
            this.stops.splice(this.stops.indexOf(stop), 1);
            if (!stop.ours) continue;
            const missed = this.passengers.filter((p) => p === stop.id).length;
            if (missed) {
                this.passengers = this.passengers.map((p) => (p === stop.id ? p + 1 : p));
                this.addComplaints(missed, `Проехал «${stop.name}»!`);
            } else if (!stop.visited && stop.waiting) {
                this.showBanner(`Проехал «${stop.name}» — ${stop.waiting} чел. остались ждать`, [230, 230, 150]);
            }
        }
        this.walkers = this.walkers.filter((w) => this.stops.includes(w.stop));
    }

    updateWorldObjects() {
        const bus = this.bus, s = bus.speed;
        for (const inter of this.inters) {
            inter.update(s);
            if (!inter.passed && bus.y < inter.stopLine && !bus.air) {
                inter.passed = true;
                if (inter.state === "red" && bus.speed > 0) {
                    this.stunt("Проскочил на красный!", 80);
                    this.startChase("проезд на красный");
                }
            }
            if (inter.passed && bus.y > inter.stopLine + 20) inter.passed = false;   // сдали назад
        }
        this.inters = this.inters.filter((i) => i.y > -1000 && i.y < HEIGHT + 300);

        for (const ramp of this.ramps) {
            ramp.y += s;
            if (!bus.air && hit(ramp.rect, inflate(bus.rect, -20, -BUS_H + 20))) {
                if (bus.speed > 6) {
                    bus.airTotal = bus.air = Math.floor(bus.speed * 6);
                    this.jumped = new Set();
                    this.floatText("Трамплин!", bus.x, bus.y - 10, YELLOW, true);
                    if (this.passengers.length) this.floatText("Ааааа!!!", bus.x + 60, bus.y + 40, WHITE);
                } else if (bus.speed > 1 && this.frame % 20 === 0) this.shake = 3;
            }
        }
        this.ramps = this.ramps.filter((r) => r.y > -600 && r.y < HEIGHT + 300);

        for (const post of this.posts) {
            post.y += s;
            if (!post.checked && post.y + 40 > bus.centerY) {
                post.checked = true;
                const kmh = Math.floor(bus.speed * KMH);
                if (kmh > SPEED_LIMIT) {
                    this.floatText(`Радар: ${kmh} км/ч!`, ROAD_RIGHT - 60, post.y, RED, true);
                    this.startChase(`превышение ${kmh} км/ч`);
                } else this.floatText("ДПС: счастливого пути", ROAD_RIGHT - 80, post.y, GREEN);
            }
        }
        this.posts = this.posts.filter((p) => p.y > -600 && p.y < HEIGHT + 400);
    }

    serviceStop() {
        const bus = this.bus;
        const near = this.stopNearBus();
        if (near && !near.ours && !near.visited) {     // встал на чужой остановке
            near.visited = true;
            this.money -= WRONG_STOP_FINE;
            this.showBanner(`Это остановка маршрута ${near.route}! Штраф ${WRONG_STOP_FINE} руб.`, RED);
            this.floatText(`Не твоя остановка! -${WRONG_STOP_FINE}`, bus.x, bus.y - 20, RED, true);
            this.shake = 6;
        }
        const stop = this.currentStop();
        bus.doorOpen = approach(bus.doorOpen, stop ? 1 : 0, 0.08);
        if (!stop) {
            this.serviceTimer = 0;
            return;
        }
        if (!stop.visited) {
            stop.visited = true;
            this.stopsServed += 1;
            this.showBanner(`Остановка «${stop.name}». Двери открываются!`, YELLOW);
            this.floatText("Остановка!", bus.x, bus.y - 20, YELLOW, true);
        }
        if (bus.doorOpen < 1) return;
        this.serviceTimer += 1;
        if (this.serviceTimer < 22) return;
        this.serviceTimer = 0;
        const [dx, dy] = bus.doorPos;
        const idx = this.passengers.indexOf(stop.id);
        if (idx >= 0) {
            this.passengers.splice(idx, 1);
            stop.exited += 1;
            this.walkers.push(new Walker(dx + 8, dy, "out", stop));
            this.floatText("Вышел", dx + 40, dy + 70, ORANGE);
            this.burst(dx, dy, [255, 190, 90], 10, 2.5, 3, 25);
        } else if (stop.waiting > 0 && this.passengers.length + this.boardingCount() < this.capacity) {
            stop.waiting -= 1;
            const [sx, sy] = stop.shelterPos;
            this.walkers.push(new Walker(sx, sy + randint(-10, 30), "in", stop, stop.id + randint(1, 4)));
        } else if (stop.waiting > 0 && this.frame % 120 < 22) {
            this.floatText("Мест нет!", dx, dy - 30, RED);
        }
    }

    updateWalkers() {
        const bus = this.bus, here = this.currentStop();
        for (const w of this.walkers) {
            w.y += bus.speed;
            w.phase += 0.35;
            if (w.kind === "in") {
                if (!w.returning && here !== w.stop) w.returning = true;
                const [tx, ty] = w.returning ? w.stop.shelterPos : bus.doorPos;
                w.x = approach(w.x, tx, 2.2);
                w.y = approach(w.y, ty, 2.2);
                if (w.x === tx && w.y === ty) {
                    w.done = true;
                    if (w.returning) w.stop.waiting += 1;
                    else {
                        this.passengers.push(w.dest);
                        w.stop.boarded += 1;
                        this.money += this.fare;
                        this.coins.push(new Coin(tx, ty));
                        this.floatText(`Зашёл  +${this.fare} руб.`, bus.x, bus.y - 20, GREEN);
                        this.burst(tx, ty, [120, 255, 120], 14, 3, 3, 30);
                    }
                }
            } else {
                w.x = approach(w.x, w.tx, 1.8);
                w.y = approach(w.y, w.ty, 1.8);
                if (w.x === w.tx && w.y === w.ty) {
                    w.ty += 40;
                    w.fade -= 0.25;
                    if (w.fade <= 0) w.done = true;
                }
            }
        }
        this.walkers = this.walkers.filter((w) => !w.done);
    }

    checkSlalom() {
        const steer = this.keys.right - this.keys.left;
        if (steer && steer !== this.lastSteer && this.bus.speed > 9) this.steerLog.push(this.frame);
        if (steer) this.lastSteer = steer;
        this.steerLog = this.steerLog.filter((f) => this.frame - f < 150);
        if (this.steerLog.length >= 5 && this.frame >= this.slalomReady) {
            this.steerLog = [];
            this.slalomReady = this.frame + SLALOM_COOLDOWN;
            this.stunt("Слалом!", 60);
        }
    }

    updateAir() {
        const bus = this.bus;
        if (!bus.air) return;
        for (const car of this.cars) if (hit(car.rect, bus.rect)) this.jumped.add(car);
        if (bus.air === 1) {                   // приземление
            this.burst(bus.x, bus.y + BUS_H, [190, 180, 160], 30, 4, 6, 35);
            this.shake = 10;
            const n = this.jumped.size;
            this.stunt(n === 0 ? "Полёт!" : `Перелетел ${n} маш.!`, 100 + 80 * n);
        }
    }

    updateEffects() {
        const bus = this.bus, s = bus.speed, r = bus.rect;
        if (bus.accelerating && this.frame % 3 === 0 && !bus.air) {
            this.particles.push(new Particle(bus.x - BUS_W / 2 + 10, bus.y + BUS_H + 2,
                rand(-0.4, 0.4), rand(0.5, 1.5), 40, [120, 120, 120], 3, 0.25));
        }
        if (bus.braking && s > 4 && !bus.air) {
            for (const wx of [bus.x - BUS_W / 2 + 8, bus.x + BUS_W / 2 - 8]) {
                this.skids.push({ x: wx, y: bus.y + BUS_H - 10, life: 240 });
                if (Math.random() < 0.4) {
                    this.particles.push(new Particle(wx, bus.y + BUS_H, rand(-0.6, 0.6), 0.5, 35, [200, 200, 200], 4, 0.3));
                }
            }
        }
        const atLeft = r.x <= ROAD_LEFT + 6, atRight = r.x + r.w >= ROAD_RIGHT - 6;
        if ((atLeft || atRight) && Math.abs(s) > 3 && Math.random() < 0.5 && !bus.air) {
            this.particles.push(new Particle(atLeft ? r.x : r.x + r.w, bus.y + rand(10, BUS_H), 0, 1, 25, [190, 170, 120], 3, 0.2));
        }

        for (const sk of this.skids) {
            sk.y += s;
            sk.life -= 1;
        }
        this.skids = this.skids.filter((sk) => sk.life > 0 && sk.y > -20 && sk.y < HEIGHT + 10);
        for (const p of this.particles) p.update(s);
        this.particles = this.particles.filter((p) => p.life > 0);
        for (const t of this.texts) t.update(s);
        this.texts = this.texts.filter((t) => t.life > 0);
        for (const c of this.coins) c.update();
        if (this.coins.some((c) => c.done)) this.burst(26, 20, [255, 220, 60], 8, 2, 3, 20, false);
        this.coins = this.coins.filter((c) => !c.done);
        if (this.banner && --this.banner.frames <= 0) this.banner = null;
        this.comboTimer = Math.max(0, this.comboTimer - 1);
        if (this.comboTimer === 0) this.combo = 0;
        this.moneyShown += (this.money - this.moneyShown) * 0.15;
        this.shake = Math.max(0, this.shake - 1);
        this.flash = Math.max(0, this.flash - 12);
    }

    explode(r, big = true) {
        const b = this.bus.rect;
        const cx = (b.x + b.w / 2 + r.x + r.w / 2) / 2, cy = (b.y + b.h / 2 + r.y + r.h / 2) / 2;
        this.burst(cx, cy, [255, 200, 50], big ? 40 : 20, 7, 6, 45, false);
        this.burst(cx, cy, [255, 100, 20], big ? 40 : 20, 5, 8, 55, false);
        this.burst(cx, cy, [80, 80, 80], 30, 3, 10, 80, false);
        for (let i = 0; i < 25; i++) {
            this.particles.push(new Particle(cx, cy, rand(-6, 6), rand(-8, -2), randint(30, 60), [255, 240, 150], 2, 0, false, 0.3));
        }
        return [cx, cy];
    }

    crash(r, car = null) {
        const bus = this.bus;
        if (this.airbags > 0) {                // подушка: спасает один раз
            this.airbags -= 1;
            this.explode(r, false);
            if (car) this.cars = this.cars.filter((c) => c !== car);
            bus.speed *= 0.3;
            bus.invuln = 120;
            this.shake = 14;
            this.flash = 120;
            this.showBanner(`Подушка сработала! Осталось: ${this.airbags}`, ORANGE);
            return;
        }
        const [cx, cy] = this.explode(r);
        this.floatText("БАБАХ!", cx, cy - 40, RED, true);
        this.shake = 30;
        this.flash = 220;
        bus.speed = 0;
        bus.air = 0;
        for (const c of this.cars) c.speed = c.baseSpeed = 0;
        if (this.police) {
            this.police.speed = 0;
            this.police.leaving = true;
        }
        this.state = "boom";
        this.boomTimer = 80;
    }

    checkCollisions() {
        const bus = this.bus;
        if (bus.air || bus.invuln) return;
        const hb = inflate(bus.rect, -8, -8);
        for (const car of this.cars) {
            if (hit(hb, inflate(car.rect, -6, -6))) {
                this.crash(car.rect, car);
                return;
            }
        }
        for (const inter of this.inters) {
            for (const c of inter.crossCars) {
                const r = inter.crossRect(c);
                if (hit(hb, inflate(r, -6, -6))) {
                    this.crash(r);
                    if (this.state === "play") inter.crossCars = inter.crossCars.filter((o) => o !== c);
                    return;
                }
            }
        }
    }

    finish(how) {
        // Конец рейса: деньги в кошелёк (если не уволили), сохранение
        const earned = how === "crash" || this.money < 0 ? this.money : 0;
        this.save.wallet = Math.max(0, this.save.wallet + earned);
        this.save.best = Math.max(this.save.best, this.money);
        writeSave(this.save);
        this.result = {
            how, money: this.money, earned, km: this.distance / 1000, stops: this.stopsServed,
            stunts: this.stunts, complaints: this.complaints, turns: this.turns,
        };
        this.state = "over";
    }

    update() {
        this.frame += 1;
        if (this.state === "turning") {
            this.turnT -= 1;
            this.updateEffects();
            if (this.turnT <= 0) this.state = "play";
            return;
        }
        if (this.state === "boom") {
            this.bus.speed = 0;
            this.updateEffects();
            this.boomTimer -= 1;
            if (this.frame % 4 === 0) {
                const b = this.bus;
                this.particles.push(new Particle(b.x + rand(-15, 15), b.y + 10, rand(-0.5, 0.5), -1.2, 70, [60, 60, 60], 6, 0.4, false));
            }
            if (this.boomTimer <= 0) this.finish("crash");
            return;
        }

        const bus = this.bus;
        bus.update(this.keys);
        this.checkSlalom();

        this.distance += Math.abs(bus.speed);
        this.scroll += bus.speed;
        this.wx += this.dir[0] * bus.speed;
        this.wy += this.dir[1] * bus.speed;
        if (this.frame % 20 === 0) {
            this.trail.push([this.wx, this.wy]);
            this.trail = this.trail.slice(-300);
        }
        this.spawnObjects();

        if (--this.spawnTimer <= 0) {
            this.spawnCar();
            const hard = Math.min(1, this.distance / 60000);
            this.spawnTimer = randint(Math.floor(22 - 8 * hard), Math.floor(60 - 25 * hard));
        }

        this.updateCars();
        this.updatePolice();
        this.updateWorldObjects();
        this.updateStops();
        if (this.state !== "play") return;
        this.serviceStop();
        this.updateWalkers();
        this.updateAir();
        this.updateEffects();
        this.checkCollisions();
        if (this.state === "play") this.tryTurn();
    }

    // --- отрисовка ---
    drawRoad() {
        fillRect(0, 0, WIDTH, HEIGHT, GROUND);
        this.strips[0].draw(this.scroll);
        this.strips[1].draw(this.scroll);
        fillRect(ROAD_LEFT - 38, 0, 38, HEIGHT, SIDEWALK);
        fillRect(ROAD_RIGHT, 0, 84, HEIGHT, SIDEWALK);
        const off = mod(this.scroll, 30);
        for (let i = -1; i < HEIGHT / 30 + 1; i++) {
            const y = i * 30 + off;
            line(ROAD_RIGHT, y, ROAD_RIGHT + 84, y, [150, 150, 140], 1);
            line(ROAD_LEFT - 38, y, ROAD_LEFT, y, [150, 150, 140], 1);
        }
        this.strips[2].draw(this.scroll);
        this.strips[3].draw(this.scroll);
        fillRect(ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, HEIGHT, ASPHALT);
        line(ROAD_LEFT + 3, 0, ROAD_LEFT + 3, HEIGHT, WHITE, 3);
        line(ROAD_RIGHT - 3, 0, ROAD_RIGHT - 3, HEIGHT, WHITE, 3);
        const off2 = mod(this.scroll, 60);
        for (let i = 1; i < LANES; i++) {
            const x = ROAD_LEFT + LANE_W * i;
            for (let y = -60 + off2; y < HEIGHT; y += 60) line(x, y, x, y + 30, WHITE, 3);
        }
        for (const inter of this.inters) inter.drawRoad();
    }

    drawWorld(withBus = true) {
        this.drawRoad();
        for (const sk of this.skids) fillRect(sk.x - 3, sk.y, 6, 8, [20, 20, 20], Math.min(150, sk.life) / 255);
        for (const r of this.ramps) r.draw();
        for (const p of this.posts) p.draw(this.frame);
        const here = this.currentStop();
        for (const s of this.stops) s.draw(this.frame, s === here);
        for (const w of this.walkers) w.draw();
        for (const c of this.cars) c.draw(this.frame);
        for (const i of this.inters) i.drawCars();
        if (this.police) this.police.draw(this.frame);
        for (const i of this.inters) i.drawLights(this.frame);
        if (withBus) this.bus.draw(this.frame);

        if (this.bus.speed > 9 && this.state === "play") {      // линии скорости
            const k = (this.bus.speed - 9) / (this.bus.maxSpeed - 9);
            for (let i = 0; i < Math.floor(10 * k); i++) {
                const x = rand(0, WIDTH), y = rand(HUD_H, HEIGHT);
                line(x, y, x, y + 60 * k + 20, [255, 255, 255], 2, 0.27);
            }
        }
        for (const p of this.particles) if (p.world) p.draw();
        if (this.bus.speed < 0 && Math.floor(this.frame / 15) % 2 === 0) {
            text("ЗАДНИЙ ХОД", this.bus.x, this.bus.y + BUS_H + 16, WHITE, 14, { align: "center", base: "middle" });
        }
        for (const t of this.texts) t.draw();
    }

    drawTurning() {
        // Старая улица поворачивается вокруг маршрутки, потом проявляется новая
        let k = 1 - this.turnT / TURN_FRAMES;
        k = k * k * (3 - 2 * k);
        const bx = this.bus.x, by = this.bus.centerY;
        if (k > 0.7) this.drawWorld(false);
        else fillRect(0, 0, WIDTH, HEIGHT, GROUND);
        ctx.save();
        ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
        ctx.translate(bx, by);
        ctx.rotate((-Math.PI / 2) * k * this.turnSign);
        ctx.translate(-bx, -by);
        ctx.drawImage(this.snapshot, 0, 0);
        ctx.restore();
        this.bus.draw(this.frame);
    }

    drawMinimap() {
        const size = 120, bx = 6, by = HEIGHT - size - 26;
        fillRect(bx, by, size, size, [15, 20, 25], 0.82);
        const scale = 40 / BLOCK, cx = bx + size / 2, cy = by + size / 2;
        const toMap = (x, y) => [cx + (x - this.wx) * scale, cy + (y - this.wy) * scale];

        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, size, size);
        ctx.clip();
        let k0 = Math.floor((this.wx - size / scale) / BLOCK);
        for (let k = k0; k < k0 + 8; k++) {
            const [x] = toMap(k * BLOCK, 0);
            line(x, by, x, by + size, [90, 95, 100], 3);
        }
        k0 = Math.floor((this.wy - size / scale) / BLOCK);
        for (let k = k0; k < k0 + 8; k++) {
            const [, y] = toMap(0, k * BLOCK);
            line(bx, y, bx + size, y, [90, 95, 100], 3);
        }
        const pts = [...this.trail, [this.wx, this.wy]].map(([x, y]) => toMap(x, y));
        ctx.strokeStyle = col([200, 160, 40]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        for (const s of this.stops) {
            const [px, py] = toMap(...this.screenToWorld(s.centerY));
            circle(px, py, 3, s.ours ? YELLOW : [220, 70, 60]);
        }
        for (const p of this.posts) {
            const [px, py] = toMap(...this.screenToWorld(p.y));
            circle(px, py, 3, [80, 140, 255]);
        }
        if (this.police && !this.police.leaving && Math.floor(this.frame / 8) % 2) {
            const [px, py] = toMap(...this.screenToWorld(this.police.y));
            circle(px, py, 4, [255, 60, 60]);
        }
        const [dx, dy] = this.dir;
        poly([[cx + dx * 8, cy + dy * 8], [cx - dx * 5 - dy * 5, cy - dy * 5 + dx * 5],
            [cx - dx * 5 + dy * 5, cy - dy * 5 - dx * 5]], YELLOW);
        ctx.restore();
        strokeRect(bx, by, size, size, [200, 200, 200], 1);
        text("С", bx + size - 12, by + 3, RED, 11, { bold: true });
        text(`${this.currentStreet()}, на ${this.compass()}`, bx, by + size + 5, WHITE, 11, { bold: true });
    }

    drawHud() {
        if (this.police && !this.police.leaving) {     // мигалка по краям экрана
            const c = Math.floor(this.frame / 8) % 2 ? [255, 40, 40] : [60, 120, 255];
            strokeRect(7, 7, WIDTH - 14, HEIGHT - 14, c, 14, 0, 0.35);
        }
        fillRect(0, 0, WIDTH, HUD_H, HUD_BG);
        line(0, HUD_H, WIDTH, HUD_H, YELLOW, 2);
        circle(26, 20, 10, [255, 210, 40]);
        ring(26, 20, 9, [180, 130, 10], 2);
        text(`${Math.round(this.moneyShown)} руб.`, 42, 10, this.money < 0 ? RED : WHITE, 18, { bold: true });
        text(`Пробег: ${(this.distance / 1000).toFixed(2)} км`, 14, 42, WHITE, 14);
        text(`Остановок: ${this.stopsServed}`, 160, 42, WHITE, 14);
        text(`Трюков: ${this.stunts}`, 270, 42, PINK, 14);
        const danger = this.complaints >= MAX_COMPLAINTS - 3;
        const cc = danger && Math.floor(this.frame / 10) % 2 ? RED : this.complaints ? [230, 150, 140] : [150, 150, 160];
        text(`Жалобы: ${this.complaints}/${MAX_COMPLAINTS}`, 160, 13, cc, 14);
        if (this.airbags) text(`Подушки: ${this.airbags}`, 280, 13, ORANGE, 14);
        text(`Пассажиры ${this.passengers.length}/${this.capacity}`, 400, 9, WHITE, 14);
        const big = this.capacity <= 16, perRow = big ? 8 : 12, cell = big ? 28 : 19;
        for (let i = 0; i < this.capacity; i++) {
            const x = 400 + (i % perRow) * cell, y = 28 + Math.floor(i / perRow) * (big ? 19 : 13);
            fillRect(x, y, cell - 6, big ? 15 : 10, i < this.passengers.length ? [90, 200, 90] : [60, 60, 70], 1, 3);
        }

        this.drawStopPanel();
        this.drawCombo();
        this.drawMinimap();
        this.drawSpeedometer();
        if (this.police && !this.police.leaving) {
            const left = Math.max(0, Math.floor((this.chaseTime - this.police.timer) / 60));
            text(`ПОГОНЯ!  продержись ${left} с`, WIDTH / 2, HEIGHT - 30,
                Math.floor(this.frame / 8) % 2 ? RED : [120, 170, 255], 18, { bold: true, align: "center", base: "middle" });
        }
        if (this.banner) {
            const { str, color, frames } = this.banner;
            const w = textWidth(str, 18, true) + 24;
            fillRect(WIDTH / 2 - w / 2, HUD_H + 100, w, 26, [0, 0, 0], Math.min(180, frames * 6) / 255);
            text(str, WIDTH / 2, HUD_H + 113, color, 18,
                { bold: true, align: "center", base: "middle", alpha: Math.min(1, (frames * 8) / 255) });
        }
        for (const p of this.particles) if (!p.world) p.draw();
        for (const c of this.coins) c.draw();
    }

    drawCombo() {
        if (this.combo < 1 || this.comboTimer <= 0) return;
        const x = WIDTH - 150, y = HUD_H + 10;
        fillRect(x, y, 140, 44, [0, 0, 0], 0.6);
        const s = this.combo > 1 ? 1 + 0.15 * Math.sin(this.frame * 0.3) : 1;
        ctx.save();
        ctx.translate(x + 70, y + 18);
        ctx.scale(s, s);
        text(`КОМБО x${this.combo}`, 0, 0, PINK, 22, { bold: true, align: "center", base: "middle" });
        ctx.restore();
        fillRect(x + 8, y + 36, 124, 4, [80, 40, 70]);
        fillRect(x + 8, y + 36, (124 * this.comboTimer) / COMBO_TIME, 4, PINK);
    }

    drawStopPanel() {
        const here = this.currentStop();
        let lines;
        if (here) {
            const busy = this.passengers.includes(here.id) || this.walkers.length;
            const canBoard = here.waiting && this.passengers.length + this.boardingCount() < this.capacity;
            lines = [
                [`Остановка «${here.name}»`, YELLOW],
                [`Вышло: ${here.exited}    Зашло: ${here.boarded}`, WHITE],
                busy || canBoard ? ["Посадка-высадка... подожди", BLUE] : ["Готово! Можно ехать (газ)", GREEN],
            ];
        } else {
            const ahead = this.stops.find((s) => !s.visited && s.y < this.bus.y);
            if (!ahead) return;
            lines = ahead.ours ? [
                [`Впереди «${ahead.name}» (480)`, YELLOW],
                [`Ждут: ${ahead.waiting}   Выходят: ${this.passengers.filter((p) => p === ahead.id).length}`, WHITE],
                ["Прижмись вправо и остановись", [200, 200, 200]],
            ] : [
                [`Впереди остановка маршрута ${ahead.route}`, RED],
                ["Не твоя! Не останавливайся — штраф", [230, 180, 170]],
            ];
        }
        const w = Math.max(...lines.map(([t]) => textWidth(t, 14))) + 20;
        fillRect(8, HUD_H + 8, w, lines.length * 20 + 10, [0, 0, 0], 0.6);
        lines.forEach(([t, c], i) => text(t, 18, HUD_H + 14 + i * 20, c, 14));
    }

    drawSpeedometer() {
        const cx = WIDTH - 52, cy = HEIGHT - 20, r = 40;
        circle(cx, cy, r + 4, [20, 20, 25]);
        for (let i = 0; i < 9; i++) {
            const a = Math.PI + (Math.PI * i) / 8;
            line(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6), cx + Math.cos(a) * r, cy + Math.sin(a) * r,
                i >= 7 ? RED : WHITE, 2);
        }
        const a = Math.PI + Math.PI * Math.min(1, Math.abs(this.bus.speed) / this.bus.maxSpeed);
        line(cx, cy, cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8), ORANGE, 3);
        circle(cx, cy, 4, ORANGE);
        const kmh = Math.trunc(this.bus.speed * KMH);
        text(kmh < 0 ? `R ${-kmh} км/ч` : `${kmh} км/ч`, cx, cy - 14, kmh > SPEED_LIMIT ? RED : WHITE, 14,
            { align: "center", base: "middle" });
    }

    drawShade(alpha = 0.72) {
        fillRect(0, 0, WIDTH, HEIGHT, [0, 0, 0], alpha);
    }

    drawCenter(title, lines, color = WHITE) {
        this.drawShade();
        const bob = Math.sin(this.frame * 0.06) * 4;
        text(title, WIDTH / 2, HEIGHT / 2 - 160 + bob, color, 42, { bold: true, align: "center", base: "middle" });
        lines.forEach((l, i) => text(l, WIDTH / 2, HEIGHT / 2 - 90 + i * 28, WHITE, 18, { bold: true, align: "center", base: "middle" }));
    }

    shopRow(i) {
        return rect(30, 208 + i * 56, WIDTH - 60, 50);
    }

    drawLobby() {
        this.drawShade(0.78);
        const bob = Math.sin(this.frame * 0.06) * 4;
        text("МАРШРУТКА 480", WIDTH / 2, 50 + bob, YELLOW, 42, { bold: true, align: "center", base: "middle" });
        text(`Кошелёк: ${this.save.wallet} руб.     Рекорд за рейс: ${this.save.best}`, WIDTH / 2, 100, WHITE, 18,
            { bold: true, align: "center", base: "middle" });
        if (this.result) {
            const r = this.result;
            const [head, c] = r.how === "fired"
                ? ["УВОЛЕН! Слишком много жалоб — зарплату не выдали", RED]
                : [`Авария. За рейс: ${r.money} руб. — в кошелёк`, ORANGE];
            text(head, 40, 120, c, 14);
            text(`${r.km.toFixed(2)} км · остановок ${r.stops} · трюков ${r.stunts} · поворотов ${r.turns} · жалоб ${r.complaints}`,
                40, 140, [200, 200, 200], 14);
        }
        text("Гараж — улучшения", 40, 170, WHITE, 24, { bold: true });
        UPGRADES.forEach(([key, name, desc, prices], i) => {
            const lvl = this.level(key), sel = i === this.shopIndex, row = this.shopRow(i);
            fillRect(row.x, row.y, row.w, row.h, sel ? [245, 200, 30] : [255, 255, 255], sel ? 0.24 : 0.07);
            if (sel) strokeRect(row.x, row.y, row.w, row.h, YELLOW, 2, 4);
            text(name, row.x + 12, row.y + 7, sel ? YELLOW : WHITE, 18, { bold: true });
            text(desc, row.x + 12, row.y + 30, [190, 190, 190], 14);
            prices.forEach((_, p) => fillRect(row.x + 300 + p * 22, row.y + 18, 16, 16, p < lvl ? GREEN : [70, 70, 80], 1, 3));
            let label, c;
            if (lvl >= prices.length) [label, c] = ["МАКС", GREEN];
            else {
                label = `${prices[lvl]} руб.`;
                c = this.save.wallet >= prices[lvl] ? WHITE : [150, 110, 110];
            }
            text(label, row.x + row.w - 12, row.y + row.h / 2, c, 18, { bold: true, align: "right", base: "middle" });
        });
        const hints = [
            document.body.classList.contains("touch")
                ? "Нажми на улучшение — купить.  Нажми сюда — в рейс!"
                : "↑ ↓ — выбрать,  Enter или клик — купить,  Пробел или клик ниже — в рейс",
            "В рейсе: ← → руль, ↑ газ, ↓ тормоз/назад, P пауза.",
            "На перекрёстке: прижмись к краю и рули дальше — поворот.",
        ];
        hints.forEach((h, i) => text(h, WIDTH / 2, HEIGHT - 70 + i * 20, [210, 210, 210], 14, { align: "center", base: "middle" }));
    }

    buy() {
        const [key, , , prices] = UPGRADES[this.shopIndex];
        const lvl = this.level(key);
        if (lvl >= prices.length || this.save.wallet < prices[lvl]) return;
        this.save.wallet -= prices[lvl];
        this.save.upgrades[key] = lvl + 1;
        writeSave(this.save);
        this.burst(WIDTH - 100, 230 + this.shopIndex * 56, YELLOW, 20, 4, 4, 30, false);
    }

    startRun() {
        this.reset();
        this.state = "play";
    }

    draw() {
        if (this.state === "turning") this.drawTurning();
        else {
            ctx.save();
            if (this.shake) {   // тряска мира
                ctx.translate(randint(-this.shake, this.shake) / 2, randint(-this.shake, this.shake) / 2);
            }
            this.drawWorld();
            ctx.restore();
        }
        if (this.state !== "menu") this.drawHud();
        if (this.flash) fillRect(0, 0, WIDTH, HEIGHT, [255, 255, 230], this.flash / 255);

        if (this.state === "menu") {
            this.drawLobby();
            for (const p of this.particles) p.draw();
        } else if (this.state === "pause") {
            this.drawCenter("ПАУЗА", ["P или нажми на экран — продолжить", "Esc — в лобби (рейс не засчитается)"]);
        } else if (this.state === "over") {
            const r = this.result;
            this.drawCenter(r.how === "fired" ? "УВОЛЕН!" : "АВАРИЯ!", [
                `За рейс: ${r.money} руб.`,
                r.how === "fired" && r.money > 0 ? "Зарплату не выдали!" : `В кошелёк: ${r.earned} руб.`,
                `Пробег: ${r.km.toFixed(2)} км   Остановок: ${r.stops}`,
                `Трюков: ${r.stunts}   Жалоб: ${r.complaints}`,
                "",
                "Enter или клик — в гараж (лобби)",
            ], RED);
        }
    }

    tick() {
        if (this.state === "play" || this.state === "boom" || this.state === "turning") this.update();
        else {
            this.frame += 1;
            for (const p of this.particles) p.update(0);
            this.particles = this.particles.filter((p) => p.life > 0);
        }
    }

    // --- ввод ---
    onKey(code, down) {
        const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right" };
        if (map[code]) this.keys[map[code]] = down;
        if (!down) return;
        if (this.state === "menu") {
            if (code === "ArrowUp" || code === "KeyW") this.shopIndex = mod(this.shopIndex - 1, UPGRADES.length);
            else if (code === "ArrowDown" || code === "KeyS") this.shopIndex = mod(this.shopIndex + 1, UPGRADES.length);
            else if (code === "Enter" || code === "NumpadEnter") this.buy();
            else if (code === "Space") this.startRun();
        } else if (this.state === "over") {
            if (["Enter", "NumpadEnter", "Escape", "Space"].includes(code)) {
                this.reset();
                this.state = "menu";
            }
        } else if ((code === "KeyP" || code === "Escape") && this.state === "play") {
            this.state = "pause";
        } else if (code === "KeyP" && this.state === "pause") {
            this.state = "play";
        } else if (code === "Escape" && this.state === "pause") {
            this.reset();
            this.state = "menu";
        }
    }

    onClick(x, y) {
        if (this.state === "menu") {
            const i = UPGRADES.findIndex((_, k) => hit(rect(x, y, 1, 1), this.shopRow(k)));
            if (i >= 0) {
                this.shopIndex = i;
                this.buy();
            } else if (y > HEIGHT - 120) this.startRun();
        } else if (this.state === "over") {
            this.reset();
            this.state = "menu";
        } else if (this.state === "pause") {
            this.state = "play";
        }
    }

    togglePause() {
        if (this.state === "play") this.state = "pause";
        else if (this.state === "pause") this.state = "play";
    }
}

// ---------- запуск ----------
const game = new Game();

window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    game.onKey(e.code, true);
});
window.addEventListener("keyup", (e) => game.onKey(e.code, false));
window.addEventListener("blur", () => Object.keys(game.keys).forEach((k) => (game.keys[k] = false)));
// кнопки для телефона: держишь — нажато, отпустил — отпущено
if (matchMedia("(pointer: coarse)").matches || "ontouchstart" in window || location.search.includes("touch")) {
    document.body.classList.add("touch");
}
document.querySelectorAll("[data-key]").forEach((btn) => {
    const set = (on) => (e) => {
        e.preventDefault();
        game.keys[btn.dataset.key] = on;
        btn.classList.toggle("on", on);
    };
    btn.addEventListener("pointerdown", set(true));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, set(false));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
});
document.querySelector("[data-action=pause]")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    game.togglePause();
});
canvas.addEventListener("click", (e) => {
    const b = canvas.getBoundingClientRect();
    game.onClick(((e.clientX - b.left) * WIDTH) / b.width, ((e.clientY - b.top) * HEIGHT) / b.height);
});

// фиксированные 60 обновлений в секунду, даже на мониторах 120/144 Гц
const STEP = 1000 / 60;
let last = performance.now(), acc = 0;
function loop(now) {
    acc = Math.min(acc + (now - last), 250);
    last = now;
    while (acc >= STEP) {
        game.tick();
        acc -= STEP;
    }
    game.draw();
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
