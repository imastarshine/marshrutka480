// Маршрутка — город: деревья, фонари и застройка по районам
"use strict";

// ---------- деревья и фонари вдоль тротуаров (зациклены — работают и при заднем ходе) ----------
class Strip {
    static LENGTH = 1600;

    constructor(x, kind) {
        Object.assign(this, { x, kind });
        this.items = [];
        for (let y = 0; y < Strip.LENGTH; y += randint(70, 140)) this.items.push(y);
    }

    draw(offset) {
        for (const start of this.items) {
            const y = Math.floor(mod(start + offset, Strip.LENGTH)) - 300;
            if (y > HEIGHT + 20 || y < -40) continue;
            if (this.kind === "trees") tree(this.x, y, 15);
            else {   // фонари
                circle(this.x, y, 5, [80, 80, 85]);
                line(this.x, y, this.x - 24, y, [80, 80, 85], 3);
                circle(this.x - 24, y, 4, [255, 240, 180]);
            }
        }
    }
}

// ---------- застройка по районам: куски разной высоты слева и справа, едут вместе с дорогой ----------
const sideX = (side) => (side === "L" ? [-MARGIN, ROAD_LEFT - 38] : [ROAD_RIGHT + 40, WIDTH + MARGIN]);
const SEG_H = {
    tower: [150, 260], office: [120, 200], plaza: [140, 200], lot: [110, 170], panel: [220, 340],
    yard: [130, 190], garages: [100, 160], park: [180, 300], hill: [200, 300], forest: [160, 280],
    pond: [170, 240], market: [130, 200], oldhouse: [100, 160], church: [170, 230], factory: [200, 320],
    containers: [120, 180], house: [90, 130], field: [200, 320],
};
const ROOFS = [[70, 75, 85], [95, 92, 100], [60, 72, 82], [112, 102, 95], [80, 84, 78]];
const TENTS = [[220, 60, 50], [40, 110, 200], [240, 190, 40], [60, 160, 90], [230, 120, 40]];

function shadow(x, y, w, h, d = 6) {
    fillRect(x + d, y + d * 1.2, w, h, [0, 0, 0], 0.3, 3);
}

function pitched(x, y, w, h, c) {
    // скатная крыша сверху: две половины разного тона и конёк
    shadow(x, y, w, h, 5);
    fillRect(x, y, w, h, c, 1, 2);
    if (w >= h) {
        fillRect(x, y + h / 2, w, h / 2, darker(c, 30), 1, 2);
        line(x + 2, y + h / 2, x + w - 2, y + h / 2, darker(c, 60), 2);
    } else {
        fillRect(x + w / 2, y, w / 2, h, darker(c, 30), 1, 2);
        line(x + w / 2, y + 2, x + w / 2, y + h - 2, darker(c, 60), 2);
    }
}

function miniCar(x, y, c, horizontal = false) {
    const w = horizontal ? 26 : 14, h = horizontal ? 14 : 26;
    fillRect(x - w / 2 + 2, y - h / 2 + 2, w, h, [0, 0, 0], 0.3, 4);
    fillRect(x - w / 2, y - h / 2, w, h, c, 1, 4);
    if (horizontal) fillRect(x - 4, y - h / 2 + 2, 8, h - 4, GLASS, 1, 2);
    else fillRect(x - w / 2 + 2, y - 4, w - 4, 8, GLASS, 1, 2);
}

class Scenery {
    constructor(game) {
        this.game = game;
        this.segs = [];
        this.fill();
    }

    make(side, edge, above) {
        const kinds = DISTRICTS[this.game.district].kinds;
        const kind = choice(kinds);
        const [a, b] = SEG_H[kind];
        const h = randint(a, b);
        return { side, kind, h, y: above ? edge - h : edge, seed: randint(1, 1e9), district: this.game.district };
    }

    fill() {
        for (const side of ["L", "R"]) {
            const mine = this.segs.filter((s) => s.side === side);
            let top = mine.length ? Math.min(...mine.map((s) => s.y)) : HEIGHT + 400;
            let bottom = mine.length ? Math.max(...mine.map((s) => s.y + s.h)) : HEIGHT + 400;
            while (top > -500) {
                const s = this.make(side, top, true);
                this.segs.push(s);
                top = s.y;
            }
            while (bottom < HEIGHT + 400) {
                const s = this.make(side, bottom, false);
                this.segs.push(s);
                bottom = s.y + s.h;
            }
        }
    }

    update(scroll) {
        for (const s of this.segs) s.y += scroll;
        this.segs = this.segs.filter((s) => s.y < HEIGHT + 700 && s.y + s.h > -900);
        this.fill();
    }

    draw(frame) {
        for (const s of this.segs) if (s.y < HEIGHT && s.y + s.h > 0) this.drawSeg(s, frame);
    }

    drawSeg(s, frame) {
        const [x0, x1] = sideX(s.side), w = x1 - x0, y = s.y, h = s.h;
        const L = s.side === "L";
        const r = seeded(s.seed);
        const pick = (arr) => arr[Math.floor(r() * arr.length)];
        // x здания шириной bw с отступом sb от тротуара
        const bx = (bw, sb) => (L ? x1 - sb - bw : x0 + sb);
        const ground = DISTRICTS[s.district].ground;
        fillRect(x0, y, w, h, ground);
        const grass = [ground[0] - 8, ground[1] + 12, ground[2] - 8];

        switch (s.kind) {
        case "tower":
        case "office": {
            fillRect(x0, y, w, h, [108, 108, 112]);
            const bw = 100 + r() * 70, b = bx(bw, 10 + r() * 20), by = y + 12, bh = h - 24;
            shadow(b, by, bw, bh, s.kind === "tower" ? 16 : 9);
            if (s.kind === "tower") {
                const c = pick(ROOFS);
                fillRect(b, by, bw, bh, c, 1, 4);
                strokeRect(b + 7, by + 7, bw - 14, bh - 14, darker(c, 25), 3, 3);
                if (r() < 0.5) {
                    circle(b + bw / 2, by + bh / 2, 20, [55, 55, 60]);
                    ring(b + bw / 2, by + bh / 2, 17, YELLOW, 2);
                    text("H", b + bw / 2, by + bh / 2, YELLOW, 16, { bold: true, align: "center", base: "middle" });
                } else {
                    for (let i = 0; i < 4; i++) {
                        fillRect(b + 14 + (i % 2) * 30, by + 16 + Math.floor(i / 2) * 26, 18, 16, [200, 200, 205]);
                    }
                }
                circle(b + bw - 16, by + 16, 3, frame % 60 < 30 ? [255, 60, 50] : [90, 30, 30]);
            } else {
                fillRect(b, by, bw, bh, [95, 135, 170], 1, 3);
                for (let gx = b + 12; gx < b + bw; gx += 16) line(gx, by + 2, gx, by + bh - 2, [140, 180, 210], 1);
                for (let gy = by + 12; gy < by + bh; gy += 16) line(b + 2, gy, b + bw - 2, gy, [140, 180, 210], 1);
                fillRect(b + 8, by + 8, bw * 0.3, bh * 0.25, [255, 255, 255], 0.15);
            }
            break;
        }
        case "plaza": {
            fillRect(x0, y, w, h, [188, 182, 170]);
            for (let gy = y; gy < y + h; gy += 20) line(x0, gy, x1, gy, [170, 165, 152], 1);
            for (let gx = x0; gx < x1; gx += 20) line(gx, y, gx, y + h, [170, 165, 152], 1);
            const fx = (x0 + x1) / 2, fy = y + h / 2;
            circle(fx, fy, 34, [150, 150, 145]);
            circle(fx, fy, 29, [70, 140, 200]);
            ring(fx, fy, 8 + ((frame * 0.3) % 18), [200, 230, 255], 2);
            circle(fx, fy, 6, [220, 240, 255]);
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2;
                circle(fx + Math.cos(a) * 52, fy + Math.sin(a) * 52, 7, pick(TENTS));
            }
            fillRect(fx - 60, y + 12, 26, 7, [120, 80, 50]);
            fillRect(fx + 34, y + h - 20, 26, 7, [120, 80, 50]);
            break;
        }
        case "lot": {
            const lw = Math.min(w - 20, 170), lx = bx(lw, 8);
            fillRect(lx, y + 8, lw, h - 16, [72, 72, 78], 1, 4);
            for (let gy = y + 14; gy < y + h - 30; gy += 30) {
                for (let gx = lx + 6; gx < lx + lw - 30; gx += 34) {
                    line(gx, gy, gx + 28, gy, WHITE, 1, 0.6);
                    if (r() < 0.6) miniCar(gx + 14, gy + 15, pick(CAR_COLORS), true);
                }
            }
            break;
        }
        case "panel": {
            const bw = 72 + r() * 22, b = bx(bw, 12 + r() * 14), by = y + 15, bh = h - 30;
            shadow(b, by, bw, bh, 11);
            const c = pick([[178, 175, 168], [165, 170, 175], [185, 170, 160]]);
            fillRect(b, by, bw, bh, c, 1, 2);
            strokeRect(b + 2, by + 2, bw - 4, bh - 4, darker(c, 30), 2, 2);
            for (let gy = by + 24; gy < by + bh - 10; gy += 52) {
                fillRect(b + bw / 2 - 7, gy, 14, 12, [90, 90, 95]);                 // выходы на крышу
                fillRect(L ? b + bw : b - 8, gy - 4, 8, 20, [120, 110, 100]);    // козырьки подъездов
            }
            const free = L ? b - x0 : x1 - (b + bw);
            if (free > 70) {
                const px = L ? x0 + free / 2 : b + bw + free / 2;
                fillRect(px - 28, y + h / 2 - 22, 56, 44, [210, 190, 130], 1, 6);
                circle(px - 10, y + h / 2, 5, [220, 60, 60]);
                circle(px + 12, y + h / 2 - 8, 5, [60, 110, 220]);
                for (let i = 0; i < 4; i++) tree(px + (r() - 0.5) * (free - 30), y + 20 + r() * (h - 40), 12 + r() * 6);
            }
            break;
        }
        case "yard": {
            fillRect(x0, y, w, h, grass);
            const cx = (x0 + x1) / 2, cy = y + h / 2;
            fillRect(cx - 40, cy - 30, 80, 60, [215, 195, 135], 1, 8);
            line(cx - 20, cy - 14, cx + 20, cy - 14, [90, 90, 100], 3);
            circle(cx - 10, cy + 8, 7, [220, 70, 60]);
            fillRect(cx + 6, cy + 2, 20, 20, [230, 210, 160], 1, 2);
            for (let i = 0; i < 6; i++) tree(x0 + 15 + r() * (w - 30), y + 15 + r() * (h - 30), 11 + r() * 8);
            for (let gy = y + 20; gy < y + h - 20; gy += 32) if (r() < 0.6) miniCar(L ? x1 - 14 : x0 + 14, gy, pick(CAR_COLORS));
            break;
        }
        case "garages": {
            fillRect(x0, y, w, h, [128, 122, 108]);
            const gw = 38;
            for (const row of [0, 1]) {
                const rx = L ? x1 - 10 - gw - row * (gw + 34) : x0 + 10 + row * (gw + 34);
                for (let gy = y + 6; gy < y + h - 24; gy += 25) {
                    const c = pick([[120, 90, 70], [100, 105, 110], [140, 110, 80], [90, 110, 100], [150, 80, 60]]);
                    shadow(rx, gy, gw, 23, 3);
                    fillRect(rx, gy, gw, 23, c);
                    line(rx, gy + 1, rx + gw, gy + 1, darker(c, 40), 2);
                    fillRect(L === !row ? rx + gw - 4 : rx, gy + 4, 4, 15, [60, 60, 65]);
                }
            }
            break;
        }
        case "park":
        case "pond":
        case "hill":
        case "forest": {
            if (s.kind === "forest") fillRect(x0, y, w, h, [55, 98, 50]);
            else fillRect(x0, y, w, h, [78, 140, 68]);
            if (s.kind === "hill") {
                const cx = x0 + w * (0.35 + r() * 0.3), cy = y + h / 2;
                for (let i = 0; i < 5; i++) {
                    ellipse(cx, cy, w * 0.5 - i * 18, h * 0.45 - i * 16, [78 + i * 12, 140 + i * 9, 68 + i * 6]);
                }
                ellipse(cx - 14, cy - 12, 22, 16, [255, 255, 230], 0.12);
            }
            if (s.kind === "pond") {
                const cx = (x0 + x1) / 2, cy = y + h / 2;
                ellipse(cx, cy, w * 0.36, h * 0.34, [120, 150, 90]);
                ellipse(cx, cy, w * 0.32, h * 0.3, [60, 125, 185]);
                ellipse(cx - 12, cy - 10, w * 0.18, h * 0.12, [120, 175, 220], 0.5);
                for (let i = 0; i < 3; i++) {
                    const a = frame * 0.01 + i * 2.1;
                    circle(cx + Math.cos(a) * w * 0.18, cy + Math.sin(a) * h * 0.15, 3, WHITE);
                }
            }
            if (s.kind === "park" || s.kind === "hill") {
                ctx.strokeStyle = col([205, 190, 150]);
                ctx.lineWidth = 7;
                ctx.beginPath();
                ctx.moveTo(x0 + r() * w, y);
                ctx.bezierCurveTo(x0 + r() * w, y + h * 0.3, x0 + r() * w, y + h * 0.7, x0 + r() * w, y + h);
                ctx.stroke();
            }
            const n = s.kind === "forest" ? 22 : s.kind === "pond" ? 5 : 9;
            for (let i = 0; i < n; i++) {
                const tx = x0 + 12 + r() * (w - 24), ty = y + 12 + r() * (h - 24);
                if (s.kind === "pond" && Math.abs(tx - (x0 + x1) / 2) < w * 0.4 && Math.abs(ty - y - h / 2) < h * 0.38) continue;
                tree(tx, ty, (s.kind === "forest" ? 14 : 11) + r() * 9, s.kind === "forest");
            }
            break;
        }
        case "market": {
            fillRect(x0, y, w, h, [160, 150, 128]);
            for (let gy = y + 10; gy < y + h - 34; gy += 42) {
                for (let gx = x0 + 10; gx < x1 - 34; gx += 42) {
                    if (r() < 0.2) continue;
                    const c = pick(TENTS);
                    shadow(gx, gy, 34, 34, 3);
                    fillRect(gx, gy, 34, 34, c, 1, 2);
                    for (let k = 0; k < 34; k += 10) fillRect(gx + k, gy, 5, 34, WHITE, 0.35);
                    circle(gx + 40, gy + 38, 3, pick(PEOPLE_COLORS));
                }
            }
            break;
        }
        case "oldhouse": {
            fillRect(x0, y, w, h, [140, 125, 108]);
            for (let gy = y + 8; gy < y + h - 40; gy += 62) {
                const hw = 60 + r() * 50, hh = 44 + r() * 14;
                const c = pick([[170, 80, 60], [150, 70, 55], [185, 100, 70], [120, 90, 80]]);
                pitched(bx(hw, 6 + r() * 10), gy, hw, hh, c);
            }
            break;
        }
        case "church": {
            fillRect(x0, y, w, h, grass);
            const bw = 80, b = bx(bw, 25), by = y + 30, bh = h - 60;
            shadow(b, by, bw, bh, 10);
            fillRect(b, by, bw, bh, [240, 236, 225], 1, 4);
            const cx = b + bw / 2, cy = by + bh / 2;
            for (const [dx, dy] of [[-24, -40], [24, -40], [-24, 40], [24, 40]]) {
                circle(cx + dx, cy + dy, 10, [215, 170, 40]);
                circle(cx + dx - 3, cy + dy - 3, 4, [255, 230, 120]);
            }
            circle(cx, cy, 22, [225, 180, 40]);
            circle(cx - 6, cy - 6, 9, [255, 235, 140]);
            line(cx, cy - 12, cx, cy + 12, [120, 90, 20], 2);
            line(cx - 7, cy - 4, cx + 7, cy - 4, [120, 90, 20], 2);
            for (let i = 0; i < 4; i++) tree(x0 + 15 + r() * (w - 30), y + 12 + r() * 20 + (i % 2) * (h - 40), 12);
            break;
        }
        case "factory":
        case "containers": {
            fillRect(x0, y, w, h, [120, 117, 108]);
            for (let gy = y; gy < y + h; gy += 14) line(L ? x1 - 4 : x0 + 4, gy, L ? x1 - 4 : x0 + 4, gy + 8, [80, 80, 80], 2);
            if (s.kind === "factory") {
                const bw = 120 + r() * 50, b = bx(bw, 16), by = y + 14, bh = h - 28;
                shadow(b, by, bw, bh, 10);
                fillRect(b, by, bw, bh, [150, 155, 160]);
                for (let gx = b + 4; gx < b + bw; gx += 7) line(gx, by, gx, by + bh, [125, 130, 135], 2);
                const cx = L ? b - 22 : b + bw + 22, cy = y + 40 + r() * (h - 80);
                if (cx > x0 + 10 && cx < x1 - 10) {
                    for (let i = 0; i < 5; i++) {
                        const t = (frame * 0.6 + i * 22) % 110;
                        circle(cx + t * 0.4, cy - t * 0.9, 6 + t * 0.15, [190, 190, 190], 0.45 * (1 - t / 110));
                    }
                    circle(cx, cy, 13, [140, 70, 60]);
                    circle(cx, cy, 8, [40, 40, 40]);
                }
                line(b + 10, by + bh / 2, L ? x0 : x1, by + bh / 2, [90, 120, 150], 6);
            } else {
                for (let gy = y + 10; gy < y + h - 22; gy += 24) {
                    for (let gx = x0 + 10; gx < x1 - 56; gx += 58) {
                        if (r() < 0.25) continue;
                        const c = pick([[180, 60, 40], [40, 90, 160], [60, 130, 70], [200, 150, 40], [130, 130, 140]]);
                        shadow(gx, gy, 54, 20, 3);
                        fillRect(gx, gy, 54, 20, c);
                        for (let k = 4; k < 54; k += 6) line(gx + k, gy, gx + k, gy + 20, darker(c, 30), 1);
                    }
                }
            }
            break;
        }
        case "house": {
            fillRect(x0, y, w, h, grass);
            const fx = x0 + 6, fw = w - 12;
            strokeRect(fx, y + 4, fw, h - 8, [130, 95, 60], 2);
            const hw = 44 + r() * 18, hx = bx(hw, 20);
            pitched(hx, y + 14, hw, hw * 0.85, pick([[160, 70, 55], [70, 110, 150], [120, 120, 125], [90, 130, 80], [150, 110, 60]]));
            const gx = L ? x0 + 14 : x1 - 90;
            for (let k = 0; k < 4; k++) {
                fillRect(gx, y + h - 46 + k * 9, 76, 5, [110, 80, 50]);
                for (let d = 4; d < 76; d += 9) circle(gx + d, y + h - 44 + k * 9, 2, [80, 170, 70]);
            }
            tree(L ? x0 + 40 : x1 - 40, y + 30, 14);
            if (r() < 0.5) miniCar(L ? x1 - 12 : x0 + 12, y + h - 26, pick(CAR_COLORS));
            break;
        }
        case "field": {
            const c1 = pick([[200, 180, 80], [150, 170, 70], [170, 130, 80]]);
            for (let gy = y; gy < y + h; gy += 10) fillRect(x0, gy, w, 6, c1);
            for (let gy = y + 6; gy < y + h; gy += 10) fillRect(x0, gy, w, 4, darker(c1, 25));
            if (r() < 0.5) for (let i = 0; i < 4; i++) circle(x0 + 20 + r() * (w - 40), y + 20 + r() * (h - 40), 7, [220, 200, 110]);
            for (let gy = y; gy < y + h; gy += 22) tree(L ? x1 - 8 : x0 + 8, gy + 8, 8);
            break;
        }
        }
    }
}
