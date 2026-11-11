// Маршрутка — частицы, всплывающий текст, монетки
"use strict";

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
