// Маршрутка — маршрутка, машины, ДПС
"use strict";

// ---------- объекты ----------
class Bus {
    constructor(up, model, route) {
        this.model = model;
        this.route = route;
        this.w = model.w;
        this.h = model.h;
        this.x = laneCenter(LANES - 1 - CLOSED);
        this.bay = 0;
        this.closed = CLOSED * LANE_W;
        this.y = BUS_BOTTOM - this.h;
        this.vx = 0;
        this.speed = 0;
        this.braking = false;
        this.accelerating = false;
        this.reverseHold = 0;
        this.doorOpen = 0;       // 0 — закрыта, 1 — открыта
        this.air = 0;            // кадры в полёте
        this.airTotal = 1;
        this.invuln = 0;         // мигание после срабатывания подушки
        this.landing = 0;        // несколько кадров после приземления столкновения не считаются
        // характеристики с учётом улучшений
        this.maxSpeed = model.speed + (up.engine || 0);
        this.accel = ACCEL * model.accel * (1 + 0.15 * (up.engine || 0));
        this.brake = BRAKE + 0.12 * (up.brakes || 0);
        this.steerSpeed = STEER_SPEED + 0.8 * (up.steer || 0);
    }

    get rect() {
        return rect(this.x - this.w / 2, this.y, this.w, this.h);
    }

    get centerY() {
        return this.y + this.h / 2;
    }

    get doorPos() {
        return [this.x + this.w / 2, this.y + 34];
    }

    // все двери по правому борту: передняя, средняя, задняя
    get doorYs() {
        const n = this.model.doors;
        if (n === 1) return [21];
        return Array.from({ length: n }, (_, i) => 21 + ((this.h - 62) * i) / (n - 1));
    }

    get z() {
        if (!this.air) return 0;
        const k = 1 - this.air / this.airTotal;
        return Math.sin(k * Math.PI) * this.airTotal * 0.8;
    }

    get xLimits() {
        return [ROAD_LEFT + this.closed + this.w / 2 + 4, ROAD_RIGHT - this.closed - this.w / 2 - 4 + this.bay];
    }

    update(keys) {
        const up = keys.up, down = keys.down;
        let steer = keys.right - keys.left;
        this.accelerating = up && this.speed >= 0;
        this.braking = (down && this.speed > 0) || (up && this.speed < 0);
        this.invuln = Math.max(0, this.invuln - 1);
        this.landing = Math.max(0, this.landing - 1);

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

    draw(frame, pose = null) {
        if (this.invuln && Math.floor(frame / 4) % 2) return;
        const z = this.z, W = this.w, H = this.h, m = this.model;
        // pose — положение и угол во время поворота и на изгибах дороги
        const angle = (pose?.angle || 0) + (this.vx * 2.2 * Math.PI) / 180;
        const cx = pose ? pose.x : this.x, cy = pose ? pose.y : this.centerY;

        // тень (в полёте — отстаёт)
        ctx.save();
        ctx.translate(cx + 4 + z * 0.5, cy + 5 + z * 0.7);
        ctx.rotate(angle);
        fillRect(-W / 2 - 4, -H / 2 - 4, W + 8, H + 8, [0, 0, 0], z ? 0.24 : 0.32, 10);
        ctx.restore();

        ctx.save();
        ctx.translate(cx, cy - z * 0.3);
        ctx.rotate(angle);
        const s = 1 + z / 220;
        ctx.scale(s, s);
        const x = -W / 2, y = -H / 2, r = { x, y, right: x + W, bottom: y + H };
        const reversing = this.speed < 0;
        if (this.braking) for (const gx of [r.x + 9, r.right - 9]) circle(gx, r.bottom + 2, 9, [255, 40, 30], 0.35);
        if (reversing) for (const gx of [r.x + 9, r.right - 9]) circle(gx, r.bottom + 4, 10, [255, 255, 255], 0.45);
        fillRect(x, y, W, H, m.color, 1, 9);
        if (m.stripe) {
            fillRect(x, y + 34, 5, H - 50, m.stripe);
            fillRect(r.right - 5, y + 50, 5, H - 70, m.stripe);
        }
        strokeRect(x, y, W, H, BLACK, 2, 9);
        fillRect(x + 6, y + 9, W - 12, 20, GLASS, 1, 4);
        fillRect(x + 8, r.bottom - 17, W - 16, 10, GLASS, 1, 3);
        // крыша: люки, у больших автобусов — ещё и кондиционер
        fillRect(x + 12, y + 46, W - 24, 14, darker(m.color, 25), 1, 3);
        if (H > 140) fillRect(x + 10, y + H / 2, W - 20, 30, [210, 210, 215], 1, 4);
        if (H > 160) fillRect(x + 12, r.bottom - 50, W - 24, 14, darker(m.color, 25), 1, 3);
        // табло с номером маршрута
        fillRect(x + 8, y + 30, W - 16, 14, BLACK, 1, 3);
        text(this.route, 0, y + 37.5, [255, 170, 40], 12, { bold: true, align: "center", base: "middle" });
        const tail = reversing ? WHITE : this.braking ? [255, 60, 50] : [140, 30, 30];
        fillRect(x + 4, r.bottom - 5, 10, 4, tail);
        fillRect(r.right - 14, r.bottom - 5, 10, 4, tail);
        circle(x + 9, y + 3, 3, WHITE);
        circle(r.right - 9, y + 3, 3, WHITE);
        // двери справа: отъезжают назад при открытии
        for (const dy of this.doorYs) {
            fillRect(r.right - 4, y + dy, 5, 26, [40, 40, 45]);
            fillRect(r.right - 4, y + dy + this.doorOpen * 22, 5, 26, darker(m.color, 35));
        }
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
    constructor(lane, y, speed, dir = -1) {
        this.dir = dir;          // -1 — попутная (едет вверх), 1 — встречная
        this.lane = this.targetLane = lane;
        this.x = laneCenter(lane);
        this.y = y;
        this.baseSpeed = this.speed = speed;
        this.color = choice(CAR_COLORS);
        this.blink = 0;
        this.braking = false;
        this.nearDone = false;   // за эту машину уже дали «впритирку»
        this.cop = false;        // машина ДПС на блокпосту
        this.wreck = false;      // раздавлена приземлившейся маршруткой
    }

    get rect() {
        return rect(this.x - CAR_W / 2, this.y, CAR_W, CAR_H);
    }

    get changing() {
        return this.targetLane !== this.lane;
    }

    draw(frame) {
        // при перестроении машина плавно доворачивает кузов
        const dx = laneCenter(this.targetLane) - this.x;
        const tilt = this.changing && !this.blink ? clamp(dx / 300, -0.18, 0.18) : 0;
        ctx.save();
        ctx.translate(this.x, this.y + CAR_H / 2);
        ctx.rotate(tilt + (this.dir > 0 ? Math.PI : 0));
        const r = rect(-CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H);
        if (this.wreck) {
            // смятый кузов: темнее, ниже, разбитые стёкла
            const c = darker(this.color, 60);
            fillRect(r.x + 3, r.y + 4, r.w, r.h, [0, 0, 0], 0.3, 6);
            poly([[r.x + 2, r.y + 8], [r.x + r.w - 4, r.y + 2], [r.x + r.w, r.y + r.h - 10], [r.x + 6, r.y + r.h]], c);
            for (const [ax, ay, bx, by] of [[-14, -20, 10, -6], [-6, -30, 14, 4], [-16, 10, 12, 24], [4, 20, -10, 34]]) {
                line(ax, ay, bx, by, [200, 220, 240], 2);
            }
            ctx.restore();
            return;
        }
        if (this.cop) {
            fillRect(r.x, r.y, r.w, r.h, [235, 235, 240], 1, 11);
            fillRect(r.x, r.y + 38, r.w, 14, [30, 70, 170]);
            strokeRect(r.x, r.y, r.w, r.h, BLACK, 2, 11);
            fillRect(r.x + 6, r.y + 12, r.w - 12, 17, GLASS, 1, 4);
            const on = Math.floor(frame / 6) % 2 === 0;
            fillRect(r.x + 8, r.y + 32, 16, 6, on ? [255, 40, 40] : [110, 30, 30]);
            fillRect(r.x + r.w - 24, r.y + 32, 16, 6, !on ? [60, 120, 255] : [30, 40, 110]);
            circle(0, r.y + 35, 30, on ? [255, 40, 40] : [60, 120, 255], 0.22);
            ctx.restore();
            return;
        }
        drawCarBody(r, this.color, this.braking);
        if (this.changing && Math.floor(frame / 8) % 2 === 0) {
            const sx = this.targetLane > this.lane ? r.x + r.w - 3 : r.x + 3;
            circle(sx, r.y + 4, 5, ORANGE);
            circle(sx, r.y + r.h - 4, 5, ORANGE);
        }
        ctx.restore();
    }
}

class Helicopter {
    // вертолёт ДПС: висит над маршруткой и светит прожектором
    constructor(x) {
        this.x = x;
        this.y = -160;
        this.rotor = 0;
        this.leaving = false;
    }

    update(tx, ty, frame) {
        this.rotor += 0.55;
        if (this.leaving) ty = -400;
        this.x += (tx + Math.sin(frame * 0.013) * 60 - this.x) * 0.02;
        this.y += (ty + Math.cos(frame * 0.017) * 25 - this.y) * 0.025;
    }

    get gone() {
        return this.leaving && this.y < -300;
    }

    // прожектор рисуется на земле, под всем остальным
    drawLight(bx, by) {
        const g = ctx.createRadialGradient(bx, by, 10, bx, by, 110);
        g.addColorStop(0, "rgba(255,255,220,0.35)");
        g.addColorStop(1, "rgba(255,255,220,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, 110, 0, Math.PI * 2);
        ctx.fill();
    }

    draw() {
        const x = this.x, y = this.y;
        ellipse(x + 50, y + 90, 26, 40, [0, 0, 0], 0.25);                 // тень далеко внизу
        line(x, y + 20, x, y + 78, [30, 50, 110], 7);                       // хвостовая балка
        fillRect(x - 14, y + 72, 28, 6, [30, 50, 110], 1, 2);
        ellipse(x, y, 22, 34, [235, 235, 240]);
        fillRect(x - 22, y - 2, 44, 10, [30, 70, 170]);
        ellipse(x, y - 16, 14, 13, [120, 170, 210]);
        text("ДПС", x, y + 18, [30, 70, 170], 10, { bold: true, align: "center", base: "middle" });
        for (const a of [this.rotor, this.rotor + Math.PI / 2]) {           // несущий винт
            line(x - Math.cos(a) * 62, y - Math.sin(a) * 62, x + Math.cos(a) * 62, y + Math.sin(a) * 62, [40, 40, 45], 4, 0.75);
        }
        circle(x, y, 5, [40, 40, 45]);
        const t = this.rotor * 2;
        line(x - 10 * Math.cos(t), y + 75, x + 10 * Math.cos(t), y + 75, [40, 40, 45], 3);
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
