// Маршрутка — отрисовка: дорога с изгибами, поворот, HUD
"use strict";

class GameRender extends GameUpdate {
    // --- отрисовка ---
    drawRoad() {
        fillRect(-MARGIN, 0, WIDTH + MARGIN * 2, HEIGHT, GROUND);
        this.scenery.draw(this.frame);
        fillRect(ROAD_LEFT - 38, 0, 38, HEIGHT, SIDEWALK);
        fillRect(ROAD_RIGHT, 0, 40, HEIGHT, SIDEWALK);
        const off = mod(this.scroll, 30);
        for (let i = -1; i < HEIGHT / 30 + 1; i++) {
            const y = i * 30 + off;
            line(ROAD_RIGHT, y, ROAD_RIGHT + 40, y, [150, 150, 140], 1);
            line(ROAD_LEFT - 38, y, ROAD_LEFT, y, [150, 150, 140], 1);
        }
        line(ROAD_LEFT - 38, 0, ROAD_LEFT - 38, HEIGHT, [120, 120, 112], 3);
        line(ROAD_RIGHT + 40, 0, ROAD_RIGHT + 40, HEIGHT, [120, 120, 112], 3);
        this.strips[0].draw(this.scroll);
        this.strips[1].draw(this.scroll);
        for (const b of this.bridges) b.drawWater(this.frame);
        fillRect(ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, HEIGHT, ASPHALT);
        line(ROAD_LEFT + 3, 0, ROAD_LEFT + 3, HEIGHT, WHITE, 3);
        line(ROAD_RIGHT - 3, 0, ROAD_RIGHT - 3, HEIGHT, WHITE, 3);
        const off2 = mod(this.scroll, 60);
        for (let i = 1; i < LANES; i++) {
            const x = ROAD_LEFT + LANE_W * i;
            if (i === LANES / 2) {   // двойная сплошная: слева встречка
                line(x - 3, 0, x - 3, HEIGHT, [235, 235, 235], 2);
                line(x + 3, 0, x + 3, HEIGHT, [235, 235, 235], 2);
                continue;
            }
            for (let y = -60 + off2; y < HEIGHT; y += 60) line(x, y, x, y + 30, WHITE, 3);
        }
        this.drawClosedLanes();
        for (const b of this.bridges) b.drawDeck();
        for (const c of this.crosswalks) c.draw(this.closedW(c.y + Crosswalk.H / 2));
        for (const inter of this.inters) inter.drawRoad();
    }

    // у переходов, перекрёстков, остановок, постов и мостов деревьев на тротуаре не ставим
    parkingFree(y0, y1) {
        const busy = [
            ...this.crosswalks.map((c) => [c.y - 40, c.bottom + 40]),
            ...this.inters.map((i) => [i.y - 60, i.y + i.h + 60]),
            ...this.stops.map((st) => [st.y - 30, st.y + BusStop.HEIGHT + 30]),
            ...this.posts.map((p) => [p.y - 30, p.y + 120]),
            ...this.stations.map((st) => [st.y - 30, st.y + PoliceStation.HEIGHT + 30]),
            ...this.bridges.map((b) => [b.y - 30, b.y + b.h + 30]),
        ];
        return busy.every(([a, b]) => y1 < a || y0 > b);
    }

    drawClosedLanes() {
        // закрытые полосы — это продолжение тротуара: плитка, бордюр, у новой кромки — белая линия.
        // разновидность — парковка у дороги (рисуется поверх плитки ниже)
        const pts = [];
        for (let y = -20; y <= HEIGHT + 20; y += 8) pts.push([y, this.closedW(y)]);
        if (pts.every(([, w]) => w < 1)) return;
        const off = mod(this.scroll, 30);
        for (const side of [-1, 1]) {
            const edge = (w) => (side < 0 ? ROAD_LEFT + w : ROAD_RIGHT - w);
            const base = side < 0 ? ROAD_LEFT - 2 : ROAD_RIGHT + 2;
            const outline = [[base, -20], ...pts.map(([y, w]) => [edge(w), y]), [base, HEIGHT + 20]];
            poly(outline, SIDEWALK);
            ctx.save();
            ctx.beginPath();
            outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.closePath();
            ctx.clip();
            // плитка: швы по рядам, каждый второй ряд со сдвигом — как у обычного тротуара, только шире
            const x0 = side < 0 ? ROAD_LEFT : ROAD_RIGHT - 3 * LANE_W, x1 = x0 + 3 * LANE_W;
            for (let i = -1; i < HEIGHT / 30 + 1; i++) {
                const y = i * 30 + off;
                line(x0, y, x1, y, [150, 150, 140], 1);
                const row = Math.round((y - this.scroll) / 30);
                for (let x = x0 + (mod(row, 2) ? 15 : 0); x < x1; x += 30) line(x, y, x, y + 30, [158, 158, 148], 1);
            }
            ctx.restore();
            // бордюр и разметка края проезжей части
            for (const [c, wdt, inset] of [[[120, 120, 112], 4, 0], [WHITE, 3, side * -6]]) {
                ctx.strokeStyle = col(c);
                ctx.lineWidth = wdt;
                ctx.beginPath();
                pts.forEach(([y, w], i) => (i ? ctx.lineTo(edge(w) - inset, y) : ctx.moveTo(edge(w) - inset, y)));
                ctx.stroke();
            }
        }
        // вариант «парковка»: ближняя к дороге закрытая полоса — асфальт с разметкой и машинами
        for (let y = -20; y < HEIGHT + 20; y += 4) {
            const w = this.closedW(y);
            if (w < 30 || this.styleAt(y) !== "parking") continue;
            const pw = Math.min(w, LANE_W) - 4;
            fillRect(ROAD_LEFT + w - pw, y, pw, 4.5, [92, 92, 98]);
            fillRect(ROAD_RIGHT - w, y, pw, 4.5, [92, 92, 98]);
        }
        const PSTEP = 115, poff = mod(this.scroll, PSTEP);
        for (let py = poff - PSTEP; py < HEIGHT + PSTEP; py += PSTEP) {
            const n = Math.floor(this.closedW(py) / LANE_W + 0.02);
            if (!n || this.styleAt(py) !== "parking" || this.styleAt(py + CAR_H) !== "parking") continue;
            // только там, где ширина постоянная (не на скосе)
            if (Math.abs(this.closedW(py - 10) - this.closedW(py + CAR_H + 10)) > 2 || !this.parkingFree(py, py + CAR_H)) continue;
            const slot = Math.round((py - this.scroll) / PSTEP);
            for (const lane of [n - 1, LANES - n]) {
                line(laneCenter(lane) - LANE_W / 2 + 4, py - 8, laneCenter(lane) + LANE_W / 2 - 4, py - 8, WHITE, 2, 0.6);
                if (hash(slot, lane, this.turns) < 0.3) continue;
                const c = CAR_COLORS[Math.floor(hash(slot, lane, 5) * CAR_COLORS.length)];
                drawCarBody(rect(laneCenter(lane) - CAR_W / 2, py, CAR_W, CAR_H - 8), c, false);
            }
        }
        // на широком тротуаре — редкие деревья в кадках
        const STEP = 160, toff = mod(this.scroll, STEP);
        for (let py = toff - STEP; py < HEIGHT + STEP; py += STEP) {
            const n = Math.floor(this.closedW(py) / LANE_W + 0.02);
            if (n < 2 || this.closedW(py + 40) < n * LANE_W - 1 || !this.parkingFree(py - 20, py + 40)) continue;
            for (const x of [laneCenter(0), laneCenter(LANES - 1)]) {
                circle(x, py + 10, 18, [120, 110, 100]);
                tree(x, py + 10, 15);
            }
        }
    }

    drawMotorcade() {
        const m = this.motorcade;
        if (!m) return;
        const flash = Math.floor(this.frame / 6) % 2;
        // регулировщики ДПС у кромки дороги
        for (const o of m.officers) {
            if (o.y < -40 || o.y > HEIGHT + 40) continue;
            const cw = this.closedW(o.y), x = o.side < 0 ? ROAD_LEFT + cw + 14 : ROAD_RIGHT - cw - 14, y = o.y;   // у кромки проезжей части
            fillRect(x - 7, y, 14, 18, [60, 90, 60], 1, 4);
            fillRect(x - 7, y + 4, 14, 4, [230, 230, 60]);
            circle(x, y - 6, 7, SKIN);
            ring(x, y - 9, 6, [40, 60, 40], 3);
            const a = Math.sin(this.frame * 0.15 + o.y) * 0.7;
            line(x, y + 6, x - o.side * Math.cos(a) * 20, y + 6 + Math.sin(a) * 20, WHITE, 4);
        }
        // колонна едет по встречке навстречу (вниз по экрану)
        for (const v of m.convoy) {
            if (v.y > HEIGHT + 50 || v.y + v.len < -50) continue;
            ctx.save();
            ctx.translate(v.x, v.y + v.len / 2);
            ctx.rotate(Math.PI);
            const w = 54, h = v.len, x = -w / 2, y = -h / 2;
            fillRect(x + 4, y + 6, w, h, [0, 0, 0], 0.3, 12);
            if (v.kind === "limo") {
                fillRect(x, y, w, h, [18, 18, 22], 1, 12);
                strokeRect(x, y, w, h, [70, 70, 80], 2, 12);
                fillRect(x + 6, y + 14, w - 12, 18, [45, 55, 70], 1, 4);
                fillRect(x + 6, y + h - 28, w - 12, 14, [45, 55, 70], 1, 4);
                fillRect(x + 8, y + 40, w - 16, h - 80, [30, 30, 36], 1, 4);
                for (const fx of [x + 4, x + w - 4]) {               // флажки на крыльях
                    line(fx, y + 4, fx, y - 10, [200, 200, 200], 2);
                    fillRect(fx - (fx < 0 ? 0 : 12), y - 14, 12, 8, [235, 235, 240]);
                    fillRect(fx - (fx < 0 ? 0 : 12), y - 10, 12, 4, [40, 80, 190]);
                }
            } else if (v.kind === "ambulance") {
                fillRect(x, y, w, h, [245, 245, 245], 1, 10);
                strokeRect(x, y, w, h, BLACK, 2, 10);
                fillRect(x, y + h / 2 - 6, w, 12, [230, 60, 50]);
                fillRect(-5, y + 50, 10, 30, [230, 60, 50]);
                fillRect(-15, y + 60, 30, 10, [230, 60, 50]);
                fillRect(x + 6, y + 10, w - 12, 16, GLASS, 1, 4);
                fillRect(x + 8, y + 32, w - 16, 6, flash ? [60, 120, 255] : [30, 40, 110]);
            } else {
                fillRect(x, y, w, h, [235, 235, 240], 1, 11);
                fillRect(x, y + 38, w, 14, [30, 70, 170]);
                strokeRect(x, y, w, h, BLACK, 2, 11);
                fillRect(x + 6, y + 12, w - 12, 17, GLASS, 1, 4);
                fillRect(x + 8, y + 32, 16, 6, flash ? [255, 40, 40] : [110, 30, 30]);
                fillRect(x + w - 24, y + 32, 16, 6, !flash ? [60, 120, 255] : [30, 40, 110]);
                circle(0, y + 35, 34, flash ? [255, 40, 40] : [60, 120, 255], 0.25);
            }
            circle(x + 10, y + 2, 4, [255, 250, 210]);                // фары
            circle(x + w - 10, y + 2, 4, [255, 250, 210]);
            ctx.restore();
        }
    }

    drawWorld(withBus = true) {
        // 1) всё рисуем во внеэкранный холст (шире экрана на MARGIN с каждой стороны)
        ctx = worldCtx;
        ctx.setTransform(1, 0, 0, 1, MARGIN, 0);
        this.drawRoad();
        for (const sk of this.skids) fillRect(sk.x - 3, sk.y, 6, 8, [20, 20, 20], Math.min(150, sk.life) / 255);
        for (const r of this.ramps) r.draw();
        for (const p of this.posts) p.draw(this.frame);
        for (const st of this.stations) st.draw(this.frame);
        const here = this.currentStop();
        for (const s of this.stops) s.draw(this.frame, s === here);
        for (const c of this.crosswalks) c.peds.draw(c.y + 2);
        for (const w of this.walkers) w.draw();
        for (const c of this.cars) c.draw(this.frame);
        for (const i of this.inters) i.drawCars();
        this.drawMotorcade();
        if (this.police) this.police.draw(this.frame);
        for (const i of this.inters) i.drawLights(this.frame);
        for (const p of this.particles) if (p.world) p.draw();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx = screenCtx;

        // 2) переносим на экран полосками, каждая со своим сдвигом — дорога изгибается
        const SLICE = 4;
        for (let y = 0; y < HEIGHT; y += SLICE) {
            const dx = this.bendOffset(y + SLICE / 2);
            ctx.drawImage(worldCanvas, 0, y, worldCanvas.width, SLICE, dx - MARGIN, y, worldCanvas.width, SLICE + 0.5);
        }
        if (this.heli) this.heli.drawLight(this.bus.x, this.bus.centerY);
        if (withBus) this.bus.draw(this.frame, { x: this.bus.x, y: this.bus.centerY, angle: this.bendAngle() });
        if (this.heli && withBus) this.heli.draw();
        if (this.hornT && withBus) {                      // звуковые волны перед маршруткой
            for (let i = 0; i < 3; i++) {
                const k = (26 - this.hornT) / 26 + i * 0.25;
                if (k > 1) continue;
                ctx.strokeStyle = col([255, 200, 120], (1 - k) * 0.8);
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.arc(this.bus.x, this.bus.y + 10, 20 + k * 90, -Math.PI * 0.8, -Math.PI * 0.2);
                ctx.stroke();
            }
        }

        if (this.bus.speed > 9 && this.state === "play") {      // линии скорости
            const k = (this.bus.speed - 9) / (this.bus.maxSpeed - 9);
            for (let i = 0; i < Math.floor(10 * k); i++) {
                const x = rand(0, WIDTH), y = rand(HUD_H, HEIGHT);
                line(x, y, x, y + 60 * k + 20, [255, 255, 255], 2, 0.27);
            }
        }
        if (this.bus.speed < 0 && Math.floor(this.frame / 15) % 2 === 0) {
            text("ЗАДНИЙ ХОД", this.bus.x, this.bus.y + this.bus.h + 16, WHITE, 14, { align: "center", base: "middle" });
        }
        for (const t of this.texts) t.draw();
    }

    drawTurning() {
        // Маршрутка едет по дуге, камера плавно доворачивает за ней; старая улица растворяется в новой
        const u = 1 - this.turnT / this.turnTotal, k = smooth(u);
        const sign = this.turnSign, theta = (sign * Math.PI) / 2, phi = theta * k;
        const [sx, sy] = this.turnStart;
        // позиция и курс маршрутки в координатах старой улицы
        const a = (u * Math.PI) / 2;
        const B = [sx + sign * TURN_RADIUS * (1 - Math.cos(a)), sy - TURN_RADIUS * Math.sin(a)];
        const E = [sx + sign * TURN_RADIUS, sy - TURN_RADIUS];
        const E2 = [this.bus.x, this.bus.centerY];                   // та же точка на новой улице
        const target = [sx + (E2[0] - sx) * k, sy + (E2[1] - sy) * k];

        fillRect(0, 0, WIDTH, HEIGHT, GROUND);
        ctx.save();
        ctx.translate(target[0], target[1]);
        ctx.rotate(-phi);
        ctx.translate(-B[0], -B[1]);
        // новая улица: повёрнута на 90° относительно старой
        ctx.save();
        ctx.translate(E[0], E[1]);
        ctx.rotate(theta);
        ctx.translate(-E2[0], -E2[1]);
        this.drawWorld(false);
        ctx.restore();
        ctx.globalAlpha = 1 - smooth(clamp(u * 1.4 - 0.2, 0, 1));
        ctx.drawImage(this.snapshot, 0, 0);
        ctx.globalAlpha = 1;
        // маршрутка чуть опережает камеру — видно, как её заносит в поворот
        this.bus.draw(this.frame, { x: B[0], y: B[1], angle: sign * a - this.bus.vx * 0.04 });
        ctx.restore();
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
        // неровная сетка: проспекты толще, узкие улицы местами обрываются
        const i0 = Math.round(this.wx / BLOCK), j0 = Math.round(this.wy / BLOCK);
        for (let i = i0 - 3; i <= i0 + 3; i++) {
            for (let j = j0 - 3; j <= j0 + 3; j++) {
                const [x, y] = toMap(gridPos("x", i), gridPos("y", j));
                if (segExists(true, i, j)) {
                    const [, y2] = toMap(0, gridPos("y", j + 1));
                    line(x, y, x, y2, [90, 95, 100], streetLanes(true, i));
                }
                if (segExists(false, j, i)) {
                    const [x2] = toMap(gridPos("x", i + 1), 0);
                    line(x, y, x2, y, [90, 95, 100], streetLanes(false, j));
                }
            }
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
        const chase = this.police && !this.police.leaving && this.state !== "station";
        if (chase) {     // мигалка по краям экрана
            const c = Math.floor(this.frame / 8) % 2 ? [255, 40, 40] : [60, 120, 255];
            strokeRect(7, 7, WIDTH - 14, HEIGHT - 14, c, 14, 0, 0.35);
        }
        const g = ctx.createLinearGradient(0, 0, 0, HUD_H);
        g.addColorStop(0, "rgb(34,36,46)");
        g.addColorStop(1, "rgb(18,19,26)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, WIDTH, HUD_H);
        line(0, HUD_H, WIDTH, HUD_H, YELLOW, 2);

        // номер маршрута как на табличке
        fillRect(10, 10, 62, 50, YELLOW, 1, 8);
        text(this.route.num, 41, 29, BLACK, 24, { bold: true, align: "center", base: "middle" });
        text(this.model.name, 41, 51, [60, 50, 10], 10, { bold: true, align: "center", base: "middle" });

        // деньги
        circle(92, 22, 10, [255, 210, 40]);
        ring(92, 22, 8, [180, 130, 10], 2);
        text(`${Math.round(this.moneyShown)} ₽`, 108, 12, this.money < 0 ? RED : WHITE, 20, { bold: true });
        text(`${formatDistance(this.distance)} · ост. ${this.stopsServed} · трюки ${this.stunts}`, 84, 42, [170, 175, 190], 12);

        // жалобы: 10 точек
        const danger = this.complaints >= MAX_COMPLAINTS - 3 && Math.floor(this.frame / 10) % 2;
        text("Жалобы", 268, 12, danger ? RED : [170, 175, 190], 12, { bold: true });
        for (let i = 0; i < MAX_COMPLAINTS; i++) {
            circle(272 + i * 11, 34, 4, i < this.complaints ? RED : [60, 62, 74]);
        }
        if (this.airbags) text(`Подушки: ${this.airbags}`, 268, 46, ORANGE, 12, { bold: true });

        // пассажиры: полоска заполнения
        const n = this.passengers.length, full = n >= this.capacity;
        text(`Пассажиры ${n}/${this.capacity}`, 410, 12, full ? ORANGE : WHITE, 14, { bold: true });
        // часы смены: под вечер краснеют
        const mins = Math.floor(this.clock / FRAMES_PER_MIN), late = SHIFT_END - mins < 60;
        text(hhmm(mins), 626, 12, late && Math.floor(this.frame / 20) % 2 ? RED : [255, 220, 120], 15, { bold: true, align: "right" });
        fillRect(410, 34, 216, 12, [50, 52, 64], 1, 6);
        if (n) fillRect(410, 34, (216 * n) / this.capacity, 12, full ? ORANGE : [90, 200, 90], 1, 6);
        text(`${this.fare} ₽ за проезд · ${this.perTick} чел. за раз`, 410, 50, [150, 155, 170], 11);

        this.drawStopPanel();
        const goal = storyGoalText(this);
        if (goal && this.state !== "station") {             // цель главы сюжета
            const w = Math.min(WIDTH - 280, textWidth(goal, 12, true) + 20);
            panel(WIDTH / 2 - w / 2, HEIGHT - 92, w, 24, 0.75, [255, 210, 80]);
            ctx.save();
            ctx.beginPath();
            ctx.rect(WIDTH / 2 - w / 2 + 6, HEIGHT - 92, w - 12, 24);
            ctx.clip();
            text(goal, WIDTH / 2, HEIGHT - 80, [255, 220, 120], 12, { bold: true, align: "center", base: "middle" });
            ctx.restore();
        }
        if (this.motorcadeAt && this.motorcadeAnnounced) {
            text(`Кортеж ~${hhmm(this.motorcadeAt)}`, WIDTH - 12, HEIGHT - 96, [255, 210, 80], 13, { bold: true, align: "right", base: "middle", shadow: true });
        }
        this.drawStars();
        this.drawRepPopup();
        this.drawNotice();
        this.drawCombo();
        this.drawMinimap();
        this.drawSpeedometer();
        if (chase) {
            // отрыв: насколько ДПС отстала (вылетит за экран — погоня окончена)
            const p = this.police, bus = this.bus;
            const k = clamp((p.y - bus.y - bus.h) / (HEIGHT + 380 - bus.y - bus.h), 0, 1);
            const left = Math.max(0, Math.floor((this.chaseTime * (0.6 + 0.4 * this.stars) - p.timer) / 60));
            const bx = WIDTH / 2 - 120, by = HEIGHT - 58;
            panel(bx, by, 240, 46, 0.75, Math.floor(this.frame / 8) % 2 ? [255, 60, 60] : [80, 140, 255]);
            text(`ПОГОНЯ!  ещё ${left} с или оторвись`, WIDTH / 2, by + 13, WHITE, 13, { bold: true, align: "center", base: "middle" });
            fillRect(bx + 12, by + 28, 216, 8, [60, 40, 50], 1, 4);
            fillRect(bx + 12, by + 28, 216 * k, 8, k > 0.7 ? GREEN : [120, 170, 255], 1, 4);
        }
        if (this.banner) {
            const { str, color, frames } = this.banner;
            const w = textWidth(str, 17, true) + 30, a = Math.min(1, frames / 20);
            fillRect(WIDTH / 2 - w / 2, HUD_H + 100, w, 30, [10, 12, 18], 0.75 * a, 15);
            text(str, WIDTH / 2, HUD_H + 115, color, 17, { bold: true, align: "center", base: "middle", alpha: a });
        }
        for (const p of this.particles) if (!p.world) p.draw();
        for (const c of this.coins) c.draw();
    }

    drawNotice() {
        // большая надпись: выезжает с увеличения, держится, гаснет; ниже — премия и репутация
        const n = this.notice;
        if (!n) return;
        const age = 200 - n.frames, a = Math.min(1, n.frames / 30, age / 10);
        const s = 1 + Math.max(0, 1 - age / 14) * 0.8;
        ctx.save();
        ctx.globalAlpha = a;
        fillRect(0, HEIGHT / 2 - 95, WIDTH, 150, [0, 0, 0], 0.35);
        ctx.translate(WIDTH / 2, HEIGHT / 2 - 50);
        ctx.scale(s, s);
        outlined(n.title, 0, 0, 50, [255, 200, 40]);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = a * Math.min(1, Math.max(0, (age - 18) / 12));
        if (n.money) outlined(`+${n.money} ₽`, WIDTH / 2, HEIGHT / 2 + 4, 30, WHITE);
        if (n.rep) outlined(`РЕПУТАЦИЯ +${n.rep}`, WIDTH / 2, HEIGHT / 2 + (n.money ? 40 : 4), 22, [120, 240, 120]);
        ctx.restore();
    }

    drawRepPopup() {
        // всплывающая табличка «РЕПУТАЦИЯ +N» под звёздами
        const p = this.repPopup;
        if (!p) return;
        const a = Math.min(1, p.frames / 25), s = 1 + Math.max(0, p.frames - 135) * 0.03;
        const str = `РЕПУТАЦИЯ ${p.n > 0 ? "+" : ""}${p.n}`;
        ctx.save();
        ctx.translate(WIDTH - 12, HUD_H + 50);
        ctx.scale(s, s);
        text(str, 0, 0, p.n > 0 ? [120, 240, 120] : [255, 110, 100], 17, { bold: true, align: "right", base: "middle", shadow: true, alpha: a });
        ctx.restore();
    }

    drawStars() {
        // звёзды розыска: горят по уровню; пока гаснут — верхняя мигает
        const chasing = this.police && !this.police.leaving, n = this.stars;
        const fading = n && !chasing && Math.floor(this.frame / 15) % 2;
        for (let i = 0; i < MAX_STARS; i++) {
            const cx = WIDTH - 22 - (MAX_STARS - 1 - i) * 26, cy = HUD_H + 20;
            const on = i < n && !(fading && i === n - 1);
            const pts = [];
            for (let k = 0; k < 10; k++) {
                const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 5 : 11;
                pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
            }
            poly(pts.map(([x, y]) => [x + 1.5, y + 2]), BLACK, 0.5);
            poly(pts, on ? (chasing && Math.floor(this.frame / 8) % 2 ? [255, 255, 255] : [255, 210, 40]) : [70, 72, 84], on ? 1 : 0.7);
        }
    }

    drawCombo() {
        if (this.combo < 1 || this.comboTimer <= 0) return;
        const x = WIDTH - 150, y = HUD_H + 70;
        panel(x, y, 140, 46, 0.7, PINK);
        const s = this.combo > 1 ? 1 + 0.15 * Math.sin(this.frame * 0.3) : 1;
        ctx.save();
        ctx.translate(x + 70, y + 18);
        ctx.scale(s, s);
        text(`КОМБО x${this.combo}`, 0, 0, PINK, 22, { bold: true, align: "center", base: "middle" });
        ctx.restore();
        fillRect(x + 10, y + 35, 120, 5, [80, 40, 70], 1, 2);
        fillRect(x + 10, y + 35, (120 * this.comboTimer) / COMBO_TIME, 5, PINK, 1, 2);
    }

    drawStopPanel() {
        const here = this.currentStop();
        let lines;
        if (here) {
            const busy = this.passengers.includes(here.id) || this.walkers.length;
            const canBoard = here.waiting && this.passengers.length + this.boardingCount() < this.capacity;
            lines = [
                [`Остановка «${here.name}»`, YELLOW],
                [`Вышло: ${here.exited}    Зашло: ${here.boarded}    Ждут: ${here.waiting}`, WHITE],
                busy || canBoard ? ["Посадка-высадка... подожди", BLUE] : ["Готово! Можно ехать (газ)", GREEN],
            ];
        } else {
            const ahead = this.stops.find((s) => !s.visited && s.y < this.bus.y);
            if (!ahead) return;
            lines = ahead.ours ? [
                [`Впереди «${ahead.name}» (${this.route.num})`, YELLOW],
                [`Ждут: ${ahead.waiting}   Выходят: ${this.passengers.filter((p) => p === ahead.id).length}`, WHITE],
                ["Прижмись вправо и остановись", [200, 200, 200]],
            ] : [
                [`Впереди остановка маршрута ${ahead.route}`, RED],
                ["Не твоя! Не останавливайся — штраф", [230, 180, 170]],
            ];
        }
        const w = Math.max(...lines.map(([t]) => textWidth(t, 14))) + 26;
        panel(8, HUD_H + 8, w, lines.length * 20 + 12, 0.7, lines[0][1]);
        lines.forEach(([t, c], i) => text(t, 20, HUD_H + 15 + i * 20, c, 14, { bold: i === 0 }));
    }

    drawSpeedometer() {
        const cx = WIDTH - 62, cy = HEIGHT - 26, r = 48;
        ctx.fillStyle = col([14, 16, 22], 0.85);
        ctx.beginPath();
        ctx.arc(cx, cy, r + 8, Math.PI, 0);
        ctx.closePath();
        ctx.fill();
        const k = Math.min(1, Math.abs(this.bus.speed) / this.bus.maxSpeed);
        const limitK = SPEED_LIMIT / (this.bus.maxSpeed * KMH);
        ctx.lineCap = "round";
        for (const [from, to, c, wdt] of [[0, 1, [50, 54, 66], 8], [limitK, 1, [120, 40, 40], 8], [0, k, k > limitK ? RED : ORANGE, 8]]) {
            if (to <= from) continue;
            ctx.strokeStyle = col(c);
            ctx.lineWidth = wdt;
            ctx.beginPath();
            ctx.arc(cx, cy, r - 4, Math.PI + Math.PI * from, Math.PI + Math.PI * to);
            ctx.stroke();
        }
        ctx.lineCap = "butt";
        const kmh = Math.trunc(this.bus.speed * KMH);
        text(kmh < 0 ? `R${-kmh}` : String(kmh), cx, cy - 18, kmh > SPEED_LIMIT ? RED : WHITE, 24, { bold: true, align: "center", base: "middle" });
        text("км/ч", cx, cy - 2, [150, 155, 170], 11, { align: "center", base: "middle" });
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

}
