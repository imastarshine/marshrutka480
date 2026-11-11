// Маршрутка — отрисовка: дорога с изгибами, поворот, HUD
"use strict";

class GameRender extends GameUpdate {
    // Geographic world rendering lives in CityWorldRenderer.
    drawWorld(withBus = true) {
        if (!this.cityRenderer || this.cityRenderer.graph !== this.cityGraph) {
            this.cityRenderer = new CityWorldRenderer(this.cityGraph, this.cityMapGeometry);
        }
        this.cityRenderer.draw(this, withBus);
    }

    updateNavigationPanel() {
        if (!this.navigationPanel && typeof CityNavigationPanel === "function") this.navigationPanel = new CityNavigationPanel(this);
        this.navigationPanel?.update();
    }

    minimapRect() {
        const size = window.citySession?.active ? 154 : 120;
        return rect(6, HEIGHT - size - 26, size, size);
    }

    drawMinimap() {
        const { x: bx, y: by, w: size } = this.minimapRect();
        fillRect(bx, by, size, size, [15, 20, 25], 0.82);
        const scale = 40 / BLOCK, cx = bx + size / 2, cy = by + size / 2;
        const pose = this.cityWorldPose;
        const toMap = (x, y) => [cx + (x - pose.wx) * scale, cy + (y - pose.wy) * scale];

        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, size, size);
        ctx.clip();
        const routeEdges = this.cityRouteEdges;
        const radius = size / scale / 2 + 20;
        for (const edge of this.cityGraph.nearbyEdges(this.wx, this.wy, radius)) {
            if (edge.bounds.minX > this.wx + radius || edge.bounds.maxX < this.wx - radius ||
                edge.bounds.minY > this.wy + radius || edge.bounds.maxY < this.wy - radius) continue;
            for (let index = 1; index < edge.geometry.length; index++) {
                const [x, y] = toMap(...edge.geometry[index - 1]), [x2, y2] = toMap(...edge.geometry[index]);
                line(x, y, x2, y2, routeEdges.has(edge.id) ? [65, 130, 140] : [90, 95, 100], Math.max(2, edge.lanes / 2));
            }
        }
        const pts = [...this.trail, [this.wx, this.wy]].map(([x, y]) => toMap(x, y));
        ctx.strokeStyle = col([200, 160, 40]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        for (const s of this.stops) {
            const edge = this.cityGraph.edges.get(s.cityEdge);
            const position = edge ? this.cityGraph.position(edge, s.cityOffset) : this.screenToWorld(s.centerY);
            const [px, py] = toMap(...position);
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
        window.citySession?.drawMinimap(this, {bx,by,size,toMap,cx,cy});
        const [dx, dy] = [Math.sin(pose.angle), -Math.cos(pose.angle)];
        poly([[cx + dx * 8, cy + dy * 8], [cx - dx * 5 - dy * 5, cy - dy * 5 + dx * 5],
            [cx - dx * 5 + dy * 5, cy - dy * 5 - dx * 5]], YELLOW);
        ctx.restore();
        strokeRect(bx, by, size, size, [200, 200, 200], 1);
        text("С", bx + size - 12, by + 3, RED, 11, { bold: true });
        text("M · карта", bx + 6, by + 5, [180, 200, 210], 10);
        text(this.fitMinimapText(`${this.currentStreet()}, на ${this.compass()}`, size, 11),
            bx, by + size + 5, WHITE, 11, { bold: true });
    }

    fitMinimapText(value, width, size = 11) {
        const label = String(value);
        if (textWidth(label, size, true) <= width) return label;
        let lo = 0, hi = label.length;
        while (lo < hi) {
            const middle = Math.ceil((lo + hi) / 2);
            if (textWidth(`${label.slice(0, middle)}…`, size, true) <= width) lo = middle;
            else hi = middle - 1;
        }
        return `${label.slice(0, lo).trimEnd()}…`;
    }

    drawRouteOverview() {
        const cached = this.routeOverviewCache;
        if (cached?.graph === this.cityGraph && cached.route === this.route.num &&
            cached.x === this.wx && cached.y === this.wy) {
            ctx.drawImage(cached.canvas, 0, 0);
            this.drawRouteOverviewPlayers(cached.view);
            return;
        }
        const target = ctx, mapCanvas = document.createElement("canvas");
        mapCanvas.width = WIDTH;
        mapCanvas.height = HEIGHT;
        ctx = mapCanvas.getContext("2d");
        const palette = [[226, 142, 104], [92, 206, 163], [122, 174, 255], [235, 135, 175], [200, 164, 245], [90, 210, 225]];
        const routes = Object.entries(this.cityGraph.data.routes);
        const area = rect(22, 116, WIDTH - 44, 414);
        const points = [...this.cityGraph.nodes.values()];
        const bounds = points.reduce((box, point) => ({
            minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x),
            minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y),
        }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
        const { minX, maxX, minY, maxY } = bounds;
        const scale = Math.min((area.w - 30) / Math.max(1, maxX - minX), (area.h - 30) / Math.max(1, maxY - minY));
        const toMap = (x, y) => [area.x + area.w / 2 + (x - (minX + maxX) / 2) * scale,
            area.y + area.h / 2 + (y - (minY + maxY) / 2) * scale];
        const drawEdge = (edge, color, width, alpha = 1) => {
            for (let index = 1; index < edge.geometry.length; index++) {
                const a = toMap(...edge.geometry[index - 1]), b = toMap(...edge.geometry[index]);
                line(...a, ...b, color, width, alpha);
            }
        };
        fillRect(0, 0, WIDTH, HEIGHT, [11, 20, 28], 0.99);
        text("ИРКУТСК", 24, 27, [236, 242, 244], 27, { bold: true });
        text("Маршруты города", 25, 63, [143, 167, 181], 14);
        text("M / нажми, чтобы закрыть", WIDTH - 24, 34, [160, 182, 194], 12, { align: "right" });
        const current = this.cityGraph.data.routes[this.route.num];
        const title = `№ ${this.route.num}  ${current.title || current.termini?.join(" — ") || this.currentStreet()}`;
        text(title, 25, 88, YELLOW, Math.min(15, (WIDTH - 50) / Math.max(1, textWidth(title, 15, true)) * 15), { bold: true });
        fillRect(area.x, area.y, area.w, area.h, [18, 31, 42], 1, 10);
        ctx.save();
        ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip();
        for (const edge of this.cityGraph.edges.values()) drawEdge(edge, [88, 112, 128], 1, 0.4);
        const ordered = routes.map((entry, index) => ({ number: entry[0], route: entry[1], color: palette[index % palette.length] }))
            .sort((a, b) => Number(a.number === this.route.num) - Number(b.number === this.route.num));
        for (const item of ordered) {
            const selected = item.number === this.route.num;
            const edgeIds = new Set([...(item.route.path || []), ...(item.route.returnPath || [])]
                .map((leg) => typeof leg === "string" ? leg : leg.edge));
            for (const id of edgeIds) {
                const edge = this.cityGraph.edges.get(id);
                if (edge) drawEdge(edge, selected ? YELLOW : item.color, selected ? 3 : 1.5, selected ? 1 : 0.62);
            }
        }
        ctx.restore();
        const metersPerUnit = this.cityGraph.data.metersPerUnit || METERS_PER_PX;
        const barMeters = [200, 500, 1000, 2000, 5000, 10000].find((meters) => meters / metersPerUnit * scale >= 60) || 10000;
        const barWidth = barMeters / metersPerUnit * scale;
        line(area.x + 14, area.y + area.h - 18, area.x + 14 + barWidth, area.y + area.h - 18, [197, 215, 225], 2);
        text(barMeters >= 1000 ? `${barMeters / 1000} км` : `${barMeters} м`, area.x + 14, area.y + area.h - 36, [197, 215, 225], 10);
        text("© OpenStreetMap contributors", area.x + area.w - 12, area.y + area.h - 15, [145, 168, 182], 9, { align: "right" });
        routes.forEach(([number, route], index) => {
            const x = 24 + index % 2 * 305, y = 553 + Math.floor(index / 2) * 48;
            const selected = number === this.route.num, color = selected ? YELLOW : palette[index % palette.length];
            line(x, y + 9, x + 20, y + 9, color, selected ? 4 : 2);
            text(`№ ${number}${selected ? " · ваш маршрут" : ""}`, x + 29, y, selected ? YELLOW : WHITE, 13, { bold: true });
            const label = route.termini?.join(" — ") || route.title || "";
            text(label, x + 29, y + 20, [145, 168, 182], Math.min(10, 260 / Math.max(1, textWidth(label, 10)) * 10));
        });
        text("Жёлтая линия — ваш маршрут · остальные линии — городские рейсы", 24, 711, [145, 168, 182], 11);
        text("Рейс на паузе. M или нажатие — вернуться за руль", 24, 733, [204, 216, 225], 12);
        ctx = target;
        this.routeOverviewCache = { graph: this.cityGraph, route: this.route.num, x: this.wx, y: this.wy, canvas: mapCanvas, view: { area, toMap } };
        ctx.drawImage(mapCanvas, 0, 0);
        this.drawRouteOverviewPlayers(this.routeOverviewCache.view);
    }

    drawRouteOverviewPlayers(view) {
        if (!view) return;
        window.citySession?.drawOverview(this, view);
        const { area, toMap } = view;
        const pose = this.cityWorldPose;
        const [px, py] = toMap(pose.wx, pose.wy), [dx, dy] = [Math.sin(pose.angle), -Math.cos(pose.angle)];
        circle(px, py, 9, [5, 15, 22], 0.9);
        poly([[px + dx * 8, py + dy * 8], [px - dx * 5 - dy * 5, py - dy * 5 + dx * 5],
            [px - dx * 5 + dy * 5, py - dy * 5 - dx * 5]], YELLOW);
        const labelX = clamp(px + 12, area.x + 8, area.x + area.w - 84), labelY = clamp(py - 22, area.y + 8, area.y + area.h - 22);
        fillRect(labelX - 4, labelY - 3, 78, 20, [7, 18, 26], 0.94, 4);
        text("Вы здесь", labelX, labelY, WHITE, 12, { bold: true });
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
