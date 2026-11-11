// Маршрутка — лобби (гараж, автопарк, маршруты) и ввод
"use strict";

class Game extends GameRender {
    // --- лобби: вкладки «Гараж», «Автопарк», «Маршруты» ---
    shopItems() {
        const sv = this.save;
        if (this.tab === 0) {
            return UPGRADES.map(([key, name, desc, prices]) => {
                const lvl = this.level(key);
                return { name, desc, levels: [lvl, prices.length], price: lvl < prices.length ? prices[lvl] : null };
            });
        }
        if (this.tab === 1) {
            return BUS_MODELS.map((m) => ({
                name: m.name, desc: m.desc, color: m.color,
                stats: `мест ${m.cap} · скорость ${Math.round(m.speed * KMH)} · двери ${m.doors}`,
                owned: sv.buses.includes(m.key), active: sv.bus === m.key, price: m.price,
            }));
        }
        if (this.tab === 3) {
            return STORY.map((ch, i) => ({
                name: `${i + 1}. ${ch.title}`, stats: ch.goal,
                label: i < sv.story ? ["✓ смотреть", GREEN] : i === sv.story ? ["СЕЙЧАС", YELLOW] : ["🔒", [120, 120, 130]],
            }));
        }
        return ROUTES.map((r) => ({
            name: `№ ${r.num}`, badge: r.num, desc: r.desc,
            stats: `${r.fare} ₽ · ${r.districts.map((d) => DISTRICTS[d].name).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(", ")}`,
            owned: sv.routes.includes(r.num), active: sv.route === r.num, price: r.price,
        }));
    }

    shopRow(i) {
        return rect(24, 198 + i * 54, WIDTH - 48, 48);
    }

    tabRect(i) {
        return rect(24 + i * 150, 148, 142, 38);
    }

    startRect() {
        return rect(WIDTH / 2 - 130, 642, 260, 50);
    }

    drawLobby() {
        this.drawShade(0.8);
        const bob = Math.sin(this.frame * 0.06) * 3;
        fillRect(WIDTH / 2 - 150, 18 + bob, 300, 52, YELLOW, 1, 12);
        text(`МАРШРУТКА ${this.save.route}`, WIDTH / 2, 44 + bob, BLACK, 32, { bold: true, align: "center", base: "middle" });
        text(`Кошелёк: ${this.save.wallet} ₽     Рекорд за рейс: ${this.save.best} ₽`, WIDTH / 2, 84, WHITE, 16,
            { bold: true, align: "center", base: "middle" });
        // репутация: полоска и звание
        const rep = this.save.rep, rc = rep >= 60 ? GREEN : rep >= 40 ? YELLOW : RED;
        text(`Репутация ${rep} · ${repTitle(rep)}`, WIDTH / 2 - 10, 104, rc, 13, { bold: true, align: "right", base: "middle" });
        fillRect(WIDTH / 2, 99, 150, 10, [50, 52, 64], 1, 5);
        fillRect(WIDTH / 2, 99, 1.5 * rep, 10, rc, 1, 5);
        if (this.result) {
            const r = this.result;
            const [head, c] = r.how === "fired"
                ? ["УВОЛЕН! Слишком много жалоб — зарплату не выдали", RED]
                : r.how === "arrested" ? ["ЛИШЁН ПРАВ! Пойман с 5 звёздами — заработок сгорел", RED]
                : r.how === "shift" ? [`Смена окончена! За день: ${r.money} ₽ — в кошелёк`, GREEN]
                    : [`Авария. За рейс: ${r.money} ₽ — в кошелёк`, ORANGE];
            text(head + (r.rep ? `  (репутация ${r.rep > 0 ? "+" : ""}${r.rep})` : ""), WIDTH / 2, 122, c, 12, { align: "center", base: "middle" });
            text(`${r.km.toFixed(2)} км · остановок ${r.stops} · трюков ${r.stunts} · поворотов ${r.turns} · жалоб ${r.complaints}`,
                WIDTH / 2, 137, [190, 190, 200], 11, { align: "center", base: "middle" });
        }
        ["Гараж", "Автопарк", "Маршруты", "Сюжет"].forEach((name, i) => {
            const t = this.tabRect(i), on = i === this.tab;
            fillRect(t.x, t.y, t.w, t.h, on ? YELLOW : [255, 255, 255], on ? 1 : 0.08, 10);
            text(name, t.x + t.w / 2, t.y + t.h / 2, on ? BLACK : WHITE, 17, { bold: true, align: "center", base: "middle" });
        });

        this.shopItems().forEach((it, i) => {
            const sel = i === this.shopIndex, row = this.shopRow(i);
            fillRect(row.x, row.y, row.w, row.h, sel ? [245, 200, 30] : [255, 255, 255], sel ? 0.2 : 0.06, 10);
            if (sel || it.active) strokeRect(row.x, row.y, row.w, row.h, it.active ? GREEN : YELLOW, 2, 10);
            let tx = row.x + 14;
            if (it.color) {                       // мини-маршрутка в цвет модели
                fillRect(tx, row.y + 10, 16, 28, it.color, 1, 4);
                fillRect(tx + 2, row.y + 13, 12, 6, GLASS, 1, 2);
                tx += 28;
            } else if (it.badge) {
                fillRect(tx, row.y + 9, 46, 30, YELLOW, 1, 6);
                text(it.badge, tx + 23, row.y + 24, BLACK, 16, { bold: true, align: "center", base: "middle" });
                tx += 58;
            }
            text(it.badge ? it.desc : it.name, tx, row.y + 6, sel ? YELLOW : WHITE, 17, { bold: true });
            text(it.stats || it.desc, tx, row.y + 28, [185, 185, 195], 13);
            let label, c;
            if (it.label) [label, c] = it.label;
            else if (it.levels) {
                const [lvl, max] = it.levels;
                for (let p = 0; p < max; p++) fillRect(row.x + 330 + p * 22, row.y + 16, 16, 16, p < lvl ? GREEN : [70, 70, 80], 1, 4);
                [label, c] = it.price === null ? ["МАКС", GREEN] : [`${it.price} ₽`, this.save.wallet >= it.price ? WHITE : [150, 110, 110]];
            } else if (it.active) [label, c] = ["✓ ВЫБРАН", GREEN];
            else if (it.owned) [label, c] = ["Выбрать", WHITE];
            else [label, c] = [`${it.price} ₽`, this.save.wallet >= it.price ? WHITE : [150, 110, 110]];
            text(label, row.x + row.w - 14, row.y + row.h / 2, c, 17, { bold: true, align: "right", base: "middle" });
        });

        const b = this.startRect(), pulse = 1 + 0.03 * Math.sin(this.frame * 0.12);
        ctx.save();
        ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
        ctx.scale(pulse, pulse);
        fillRect(-b.w / 2, -b.h / 2, b.w, b.h, [70, 190, 90], 1, 14);
        text("В РЕЙС  ▶", 0, 0, WHITE, 22, { bold: true, align: "center", base: "middle", shadow: true });
        ctx.restore();
        const touch = document.body.classList.contains("touch");
        const hints = [
            touch ? "Нажми на вкладку и строку — купить или выбрать"
                : "← → вкладки,  ↑ ↓ выбор,  Enter купить/выбрать,  Пробел — в рейс",
            "Направо — прижмись к правому краю, налево — из левой своей полосы. Слева — встречка!",
        ];
        hints.forEach((h, i) => text(h, WIDTH / 2, 712 + i * 20, [200, 200, 210], 12, { align: "center", base: "middle" }));
    }

    buy() {
        const sv = this.save, i = this.shopIndex, row = this.shopRow(i);
        if (this.tab === 3) {                      // пересмотреть диалог пройденной или текущей главы
            if (i <= sv.story && STORY[i]) openDialog(this, STORY[i].intro, "menu", `Глава ${i + 1}. ${STORY[i].title}`);
            return;
        }
        if (this.tab === 0) {
            const [key, , , prices] = UPGRADES[i];
            const lvl = this.level(key);
            if (lvl >= prices.length || sv.wallet < prices[lvl]) return;
            sv.wallet -= prices[lvl];
            sv.upgrades[key] = lvl + 1;
        } else {
            const isBus = this.tab === 1;
            const item = isBus ? BUS_MODELS[i] : ROUTES[i];
            const id = isBus ? item.key : item.num, owned = isBus ? sv.buses : sv.routes;
            if (!owned.includes(id)) {
                if (sv.wallet < item.price) return;
                sv.wallet -= item.price;
                owned.push(id);
            }
            if (isBus) sv.bus = id;
            else sv.route = id;
        }
        writeSave(sv);
        this.burst(WIDTH - 90, row.y + row.h / 2, YELLOW, 20, 4, 4, 30, false);
    }

    startRun() {
        this.reset();
        this.state = "play";
        storyStart(this);
    }

    // из итогов рейса — в лобби (если сюжет закончился — сначала финальный диалог)
    toLobby() {
        this.reset();
        this.state = "menu";
        if (this.pendingDialog) {
            openDialog(this, this.pendingDialog.lines, "menu", this.pendingDialog.title);
            this.pendingDialog = null;
        }
    }

    draw() {
        if (this.state === "intro") {
            if (drawIntro(this)) this.state = "menu";
            return;
        }
        if (this.mapOverview && this.state !== "menu") {
            this.drawRouteOverview();
            return;
        }
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
        } else if (this.state === "dialog") {
            drawDialog(this);
        } else if (this.state === "caught") {
            const c = this.caught, can = this.money >= c.bribe;
            this.drawCenter("ПОПАЛСЯ!", [
                `Розыск ${"★".repeat(c.stars)} · штраф ${c.fine} ₽`,
                c.stars >= MAX_STARS ? "В отделе лишат прав!" : `В отделе: штраф, протокол и −${STATION_MINUTES / 60} ч смены`,
            ], [120, 170, 255]);
            const [pay, quit] = this.offerRects();
            fillRect(pay.x, pay.y, pay.w, pay.h, can ? [200, 150, 40] : [90, 80, 60], 1, 12);
            text(can ? `Взятка ${c.bribe} ₽ (Enter)` : `Взятка ${c.bribe} ₽ — нет денег`, pay.x + pay.w / 2, pay.y + pay.h / 2, WHITE, 15,
                { bold: true, align: "center", base: "middle" });
            fillRect(quit.x, quit.y, quit.w, quit.h, [60, 80, 140], 1, 12);
            text("В отдел (Esc)", quit.x + quit.w / 2, quit.y + quit.h / 2, WHITE, 17, { bold: true, align: "center", base: "middle" });
        } else if (this.state === "station") {
            this.drawStationScene();
        } else if (this.state === "offer") {
            this.drawCenter("АВАРИЯ!", [
                `Ремонт: ${this.repairCost} ₽  (за рейс заработано ${this.money} ₽)`,
                "Заплатить и ехать дальше?",
            ], RED);
            const [pay, quit] = this.offerRects();
            fillRect(pay.x, pay.y, pay.w, pay.h, [70, 190, 90], 1, 12);
            text("Заплатить (Enter)", pay.x + pay.w / 2, pay.y + pay.h / 2, WHITE, 17, { bold: true, align: "center", base: "middle" });
            fillRect(quit.x, quit.y, quit.w, quit.h, [120, 60, 60], 1, 12);
            text("Закончить (Esc)", quit.x + quit.w / 2, quit.y + quit.h / 2, WHITE, 17, { bold: true, align: "center", base: "middle" });
        } else if (this.state === "over") {
            const r = this.result;
            const title = { fired: "УВОЛЕН!", shift: "СМЕНА ОКОНЧЕНА", arrested: "ЛИШЁН ПРАВ!" }[r.how] || "АВАРИЯ!";
            this.drawCenter(title, [
                `За рейс: ${r.money} ₽` + (r.bonus ? `  (премия ${r.bonus} ₽)` : ""),
                (r.how === "fired" || r.how === "arrested") && r.money > 0 ? "Заработок сгорел!" : `В кошелёк: ${r.earned} ₽`,
                `Пробег: ${r.km.toFixed(2)} км   Остановок: ${r.stops}`,
                `Трюков: ${r.stunts}   Жалоб: ${r.complaints}`,
                `Репутация: ${r.rep > 0 ? "+" : ""}${r.rep}  →  ${this.save.rep} (${repTitle(this.save.rep)})`,
                "",
                "Enter или клик — в гараж (лобби)",
            ], r.how === "shift" ? GREEN : RED);
        }
    }

    drawStationScene() {
        const st = this.station, t = st.t - st.escort;
        if (t < 0) {                                   // конец конвоя — затемнение
            const left = -t;
            if (left < 30) fillRect(0, 0, WIDTH, HEIGHT, BLACK, 1 - left / 30);
            return;
        }
        const a = Math.min(1, t / 25, (STATION_CARD - t) / 25);
        fillRect(0, 0, WIDTH, HEIGHT, BLACK);
        ctx.save();
        ctx.globalAlpha = a;
        const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
        g.addColorStop(0, "rgb(20,28,60)");
        g.addColorStop(1, "rgb(8,10,24)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        // здание отдела крупно, у входа — наша маршрутка под конвоем
        ctx.save();
        ctx.translate(40, 250);
        ctx.scale(1.35, 1.35);
        new PoliceStation(0, 0).draw(this.frame);
        ctx.restore();
        this.bus.draw(this.frame, { x: 520, y: 470, angle: Math.PI / 2 });
        outlined("ОТДЕЛ ПОЛИЦИИ", WIDTH / 2, 110, 46, [120, 170, 255]);
        outlined(`Протокол и штраф ${st.fine} ₽`, WIDTH / 2, 170, 22, WHITE);
        panel(WIDTH / 2 - 90, 640, 180, 60, 0.8, [255, 220, 120]);
        text(hhmm(this.clock / FRAMES_PER_MIN), WIDTH / 2, 670, [255, 220, 120], 34, { bold: true, align: "center", base: "middle" });
        ctx.restore();
    }

    offerRects() {
        return [rect(WIDTH / 2 - 230, HEIGHT / 2 - 10, 220, 50), rect(WIDTH / 2 + 10, HEIGHT / 2 - 10, 220, 50)];
    }

    tick() {
        if (this.state === "intro") this.introT += 1;
        if (this.state === "dialog") this.dialog.t += 1;   // текст диалога печатается
        if (this.state === "station") {
            const st = this.station;
            st.t += 1;
            this.frame += 1;
            if (st.t <= st.escort) this.updateEscort();
            else {
                this.bus.speed = 0;
                // в отделе часы крутятся: полтора часа за пару секунд
                const k = clamp((st.t - st.escort - 30) / (STATION_CARD - 70), 0, 1);
                this.clock = st.from + k * STATION_MINUTES * FRAMES_PER_MIN;
            }
            if (st.t < st.escort + STATION_CARD) return;
            this.police = null;
            this.station = null;
            this.showBanner("Отпустили. Смена продолжается", WHITE);
            this.state = "play";
        }
        if (this.state === "play" || this.state === "boom" || this.state === "turning") this.update();
        else {
            this.frame += 1;
            for (const p of this.particles) p.update(0);
            this.particles = this.particles.filter((p) => p.life > 0);
        }
    }

    // --- ввод ---
    onKey(code, down) {
        if (code === "KeyQ" || code === "KeyE") {
            this.exitKeysHeld ||= {};
            if (!down) { this.exitKeysHeld[code] = false; return; }
            if (this.exitKeysHeld[code]) return;
            this.exitKeysHeld[code] = true;
            if (!this.mapOverview && this.state === "play") this.cycleCityExit(code === "KeyQ" ? -1 : 1);
            return;
        }
        if (code === "KeyM") {
            if (!down) { this.mapKeyHeld = false; return; }
            if (this.mapKeyHeld) return;
            this.mapKeyHeld = true;
        }
        const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right" };
        if (map[code]) this.keys[map[code]] = down;
        if (!down) return;
        if (this.mapOverview) {
            if (["KeyM", "Escape", "Enter", "Space"].includes(code)) this.toggleRouteMap();
            return;
        }
        if (code === "KeyM" && ["play", "pause"].includes(this.state)) {
            this.toggleRouteMap();
            return;
        }
        if (this.state === "intro") {
            this.state = "menu";
            return;
        }
        if (this.state === "dialog") {
            if (["Enter", "NumpadEnter", "Space", "Escape"].includes(code)) nextDialog(this);
            return;
        }
        if (this.state === "menu") {
            const n = this.shopItems().length;
            if (code === "ArrowUp" || code === "KeyW") this.shopIndex = mod(this.shopIndex - 1, n);
            else if (code === "ArrowDown" || code === "KeyS") this.shopIndex = mod(this.shopIndex + 1, n);
            else if (code === "ArrowLeft" || code === "KeyA" || code === "ArrowRight" || code === "KeyD") {
                this.tab = mod(this.tab + (code === "ArrowLeft" || code === "KeyA" ? -1 : 1), 4);
                this.shopIndex = 0;
            } else if (code === "Enter" || code === "NumpadEnter") this.buy();
            else if (code === "Space") this.startRun();
        } else if (this.state === "caught") {
            if (code === "Enter" || code === "NumpadEnter" || code === "KeyY") this.payBribe();
            else if (code === "Escape" || code === "KeyN") this.goToStation();
        } else if (this.state === "offer") {
            if (code === "Enter" || code === "NumpadEnter" || code === "KeyY") this.payRepair();
            else if (code === "Escape" || code === "KeyN") this.finish("crash");
        } else if (this.state === "over") {
            if (["Enter", "NumpadEnter", "Escape", "Space"].includes(code)) this.toLobby();
        } else if ((code === "Space" || code === "KeyH") && this.state === "play") {
            this.honk();
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
        if (this.mapOverview) { this.toggleRouteMap(); return; }
        if (this.state === "play" && hit(rect(x, y, 1, 1), this.exitSelectorRect())) {
            this.cycleCityExit(1);
            return;
        }
        if (["play", "pause"].includes(this.state) && hit(rect(x, y, 1, 1), this.minimapRect())) {
            this.toggleRouteMap();
            return;
        }
        if (this.state === "intro") {
            this.state = "menu";
            return;
        }
        if (this.state === "dialog") {
            nextDialog(this);
            return;
        }
        if (this.state === "menu") {
            const pt = rect(x, y, 1, 1);
            const t = [0, 1, 2, 3].find((k) => hit(pt, this.tabRect(k)));
            const i = this.shopItems().findIndex((_, k) => hit(pt, this.shopRow(k)));
            if (t !== undefined) {
                this.tab = t;
                this.shopIndex = 0;
            } else if (i >= 0) {
                this.shopIndex = i;
                this.buy();
            } else if (hit(pt, inflate(this.startRect(), 20, 20))) this.startRun();
        } else if (this.state === "caught") {
            const [pay, quit] = this.offerRects(), pt = rect(x, y, 1, 1);
            if (hit(pt, pay)) this.payBribe();
            else if (hit(pt, quit)) this.goToStation();
        } else if (this.state === "offer") {
            const [pay, quit] = this.offerRects(), pt = rect(x, y, 1, 1);
            if (hit(pt, pay)) this.payRepair();
            else if (hit(pt, quit)) this.finish("crash");
        } else if (this.state === "over") {
            this.toLobby();
        } else if (this.state === "pause") {
            this.state = "play";
        }
    }

    togglePause() {
        if (this.mapOverview) { this.toggleRouteMap(); return; }
        if (this.state === "play") this.state = "pause";
        else if (this.state === "pause") this.state = "play";
    }

    toggleRouteMap() {
        if (this.mapOverview) {
            this.mapOverview = false;
            if (this.mapPausedRun && this.state === "pause") this.state = "play";
            this.mapPausedRun = false;
        } else {
            if (!["play", "pause"].includes(this.state)) return false;
            this.mapPausedRun = this.state === "play";
            if (this.mapPausedRun) this.state = "pause";
            this.mapOverview = true;
        }
        Object.keys(this.keys).forEach((key) => { this.keys[key] = false; });
        return true;
    }
}
