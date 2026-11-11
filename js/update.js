// Маршрутка — логика рейса: машины, ДПС, остановки, пешеходы, столкновения
"use strict";

class GameUpdate extends GameCore {
    // --- обновление ---
    updateCars() {
        if (this.serverTrafficActive) {
            this.serverCars = window.citySession.trafficProxies(this);
            return;
        }
        this.serverCars = [];
        const bus = this.bus;
        // маршрутка в кармане остановки: правая полоса за ней пропускает её на выезд
        const rightLane = LANES - 1 - this.closedLanesAt(bus.centerY);
        const inBay = bus.bay > 0 && !bus.air && Math.abs(bus.speed) < 3 && bus.x > laneCenter(rightLane) + LANE_W / 2 - 8;
        for (const car of this.cars) {
            const oldX = car.x, d = car.dir;
            // перестраиваемся только в полосы своего направления
            const [lo, hi] = d < 0 ? [ownFirst(), LANES - 1] : [0, ownFirst() - 1];
            // впереди полоса сужается — заранее перестраиваемся к центру
            const look = d < 0 ? [car.y - 600, car.y] : [car.y + CAR_H, car.y + CAR_H + 600];
            const parked = car.cop || car.wreck;         // блокпост и обломки стоят на месте
            const mustMerge = !parked && !this.laneOpen(car.targetLane, ...look);
            car.yieldTo = null;
            if (!car.changing && mustMerge) {
                const target = car.lane + (car.lane < ownFirst() ? 1 : -1);
                if (target >= lo && target <= hi && this.laneFreeFor(car, target, true)) {
                    car.targetLane = target;
                    car.blink = 12;
                    car.merging = true;
                } else {
                    // рядом в нужной полосе кто-то едет — сбрасываем скорость и встаём за ним
                    const near = (y, h) => y < car.y + CAR_H + 20 && y + h > car.y - 20;
                    const side = this.cars.filter((o) => o !== car && o.lane === target && near(o.y, CAR_H)).map((o) => o.speed);
                    if (!bus.air && this.laneBlockedByBus(target) && near(bus.y, bus.h)) side.push(Math.abs(bus.speed));
                    if (side.length) car.yieldTo = Math.min(...side);
                }
            } else if (!parked && !this.motorcade && !car.changing && car.y > 60 && car.y < HEIGHT - 150 && Math.random() < 0.004) {
                const target = car.lane + choice([-1, 1]);
                if (target >= lo && target <= hi && this.laneOpen(target, ...look) && this.laneFreeFor(car, target)) {
                    car.targetLane = target;
                    car.blink = 50;
                }
            }
            if (!car.changing && car.x !== laneCenter(car.lane)) {
                car.x = approach(car.x, laneCenter(car.lane), 1.6);   // передумал перестраиваться — возвращается в свою полосу
            } else if (car.changing) {
                if (car.blink > 0) car.blink -= 1;
                else {
                    car.x = approach(car.x, laneCenter(car.targetLane), car.merging ? 2.4 : 1.6);
                    if (car.x === laneCenter(car.targetLane)) {
                        car.lane = car.targetLane;
                        car.merging = false;
                    }
                    // в целевой полосе кто-то оказался рядом — передумал и вернулся
                    // (при вынужденном перестроении — только если реально впритык)
                    const pad = car.merging ? [2, 6] : [10, 30];
                    if (this.cars.some((o) => o !== car && hit(inflate(o.rect, ...pad), car.rect))) {
                        car.targetLane = car.lane;
                        car.merging = false;
                        car.x = oldX;
                    }
                }
            }

            // ближайшее препятствие впереди по ходу машины: машины, маршрутка, ДПС, светофор, пешеходы.
            // скорость препятствия — «вверх по экрану относительно земли»; для встречки знак обратный
            let aheadGap = null, aheadSpeed = 0;
            const consider = (gap, speedUp) => {
                if (gap >= 0 && (aheadGap === null || gap < aheadGap)) [aheadGap, aheadSpeed] = [gap, Math.max(0, -d * speedUp)];
            };
            const overlapX = (ox, ow) => Math.abs(ox - car.x) < (CAR_W + ow) / 2 + 4 ||
                (car.changing && Math.abs(ox - laneCenter(car.targetLane)) < (CAR_W + ow) / 2 + 4);
            // кто перестраивается к нам перед сужением — пропускаем, как будто он уже в нашей полосе
            const obstacles = this.cars.filter((o) => o !== car).map((o) =>
                [o.merging && o.targetLane === car.lane ? car.x : o.x, o.y, CAR_W, CAR_H, -o.dir * o.speed]);
            if (!bus.air) obstacles.push([bus.x, bus.y, bus.w, bus.h, bus.speed]);
            if (this.police) obstacles.push([this.police.x, this.police.y, Police.W, Police.H, this.police.speed]);
            for (const [ox, oy, ow, oh, os] of obstacles) {
                if (!overlapX(ox, ow)) continue;
                if (d < 0 && oy < car.y) consider(car.y - (oy + oh), os);
                if (d > 0 && oy > car.y) consider(oy - (car.y + CAR_H), os);
            }
            for (const inter of this.inters) {
                const st = inter.state, stop = st !== "green";
                if (d < 0) {
                    const gap = car.y - inter.stopLine;
                    if (gap < 160 && (inter.peds.blocks(car.x) || (stop && !(st === "yellow" && gap < 40)))) consider(gap, 0);
                } else {
                    const gap = inter.farStopLine - (car.y + CAR_H);
                    if (gap < 160 && stop && !(st === "yellow" && gap < 40)) consider(gap, 0);
                }
            }
            if (mustMerge && !car.changing) {         // не успел перестроиться — ждёт перед сужением
                for (let k = 0; k <= 380; k += 20) {
                    const yy = d < 0 ? car.y - k : car.y + CAR_H + k;
                    if (!this.laneOpen(car.lane, yy)) {
                        consider(Math.max(0, k - 30), 0);
                        break;
                    }
                }
            }
            if (inBay && d < 0 && (car.lane === rightLane || car.targetLane === rightLane) && car.y > bus.y + bus.h / 2) {
                consider(car.y - (bus.y + bus.h) - 30, 0);
            }
            for (const cw of this.crosswalks) {        // пропускаем пешеходов
                const gap = d < 0 ? car.y - cw.bottom - 20 : cw.y - 20 - (car.y + CAR_H);
                if (gap < 160 && cw.peds.blocks(car.x)) consider(gap, 0);
            }
            if (car.yieldTo !== null) {
                car.speed = Math.max(0, Math.min(car.speed, car.yieldTo - 1.5));
                car.braking = true;
            } else if (parked) {
                car.speed = 0;
                aheadGap = null;
                if (car.wreck && this.frame % 9 === 0) {
                    this.particles.push(new Particle(car.x + rand(-10, 10), car.y + 30, rand(-0.3, 0.3), -0.8, 50, [70, 70, 70], 5, 0.3));
                }
            } else if (aheadGap !== null && aheadGap < 80) {
                const ns = Math.min(car.baseSpeed, aheadSpeed - (aheadGap < 30 ? 0.6 : 0));
                car.braking = ns < car.speed - 0.05;
                car.speed = Math.max(0, ns);
            } else {
                if (!parked) {
                    car.braking = false;
                    // посигналили — какое-то время едет быстрее
                    car.speed = Math.min(car.baseSpeed + (car.hurry > 0 ? 3 : 0), car.speed + (car.hurry > 0 ? 0.15 : 0.05));
                }
            }

            // перекрытие: попутные машины встают в пробку
            if (this.motorcade && d < 0 && !parked) {
                car.speed = approach(car.speed, 0, 0.2);
                car.braking = car.speed > 0;
            }
            const prev = car.y + CAR_H / 2 - bus.centerY;
            const oldY = car.y;
            car.y += bus.speed + d * car.speed;
            // машина сама не врезается в маршрутку: если она подъезжает сзади или
            // перестраивается в неё (особенно когда стоим на красном) — тормозит и возвращается
            // встречка в лоб виновата только если сама перестраивается в тебя: лобовое — авария
            // задом в машину — виновата маршрутка: машина не отъезжает, будет авария
            const fault = car.changing || (d < 0 && bus.speed >= 0 && (bus.speed < 1.5 || car.y > bus.y + bus.h / 2));
            if (fault && !parked && !bus.air && hit(inflate(car.rect, 6, 10), bus.rect)) {
                if (car.changing) {
                    car.targetLane = car.lane;      // передумал перестраиваться
                    car.x = oldX;
                }
                car.y = car.y > bus.y ? Math.max(oldY, car.y) : Math.min(oldY, car.y);
                car.speed = 0;
            }
            // в тупике попутные машины сворачивают на поперечную улицу
            for (const inter of this.inters) {
                if (!inter.arms.straight && d < 0 && car.y < inter.y + inter.h / 2) car.gone = true;
            }
            const now = car.y + CAR_H / 2 - bus.centerY;
            // «впритирку»: машина проходит рядом с маршруткой на большой скорости
            if (!car.nearDone && prev < 0 && now >= 0 && bus.speed > 7 && !bus.air) {
                const sideGap = Math.abs(car.x - bus.x) - (CAR_W + bus.w) / 2;
                if (sideGap > 0 && sideGap < 16) {
                    car.nearDone = true;
                    this.stunt(d > 0 ? "Впритирку со встречкой!" : "Впритирку!", d > 0 ? 70 : 40);
                }
            }
        }
        // за экраном машина в закрытой полосе (участок появился поверх неё) просто исчезает
        for (const c of this.cars) {
            if ((c.y < -CAR_H || c.y > HEIGHT) && !c.changing && !this.laneOpen(c.lane, c.y + CAR_H / 2)) c.gone = true;
        }
        this.cars = this.cars.filter((c) => !c.gone && c.y > -400 && c.y < HEIGHT + 400);
    }

    laneFreeFor(car, lane, merging = false) {
        // в целевой полосе должно быть свободно с запасом — тем больше, чем больше разница скоростей.
        // перед сужением («молния») хватает просвета чуть длиннее машины
        for (const o of this.cars) {
            if (o === car || (o.lane !== lane && o.targetLane !== lane)) continue;
            const need = merging ? CAR_H * 1.3 : CAR_H * 2.4 + Math.abs(o.speed - car.speed) * 45;
            if (Math.abs(o.y - car.y) < need) return false;
        }
        const bus = this.bus, reach = merging ? 20 : Math.abs(bus.speed) < 2 ? 420 : 230;
        return !(this.laneBlockedByBus(lane) && car.y > bus.y - reach && car.y < bus.y + bus.h + reach);
    }

    updatePolice() {
        if (this.serverTrafficActive) return;
        const p = this.police;
        if (!p) return;
        const bus = this.bus;
        p.timer += 1;
        if (p.leaving) p.speed = approach(p.speed, 0, 0.15);
        else {
            // на 1★ ДПС медленнее маршрутки, с 3★ — быстрее: уйти можно только поворотами и пробками
            const top = bus.maxSpeed * (0.86 + 0.06 * this.stars - 0.02 * this.level("blat"));
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
            const gap = p.y - (bus.y + bus.h);
            const desired = bus.speed + (gap > 60 ? 3 : 0.8);
            p.speed = approach(p.speed, clamp(desired, 0, limit), 0.25);
            const cw = this.closedW(p.y + Police.H / 2);
            p.x = approach(p.x, clamp(targetX, ROAD_LEFT + cw + 30, ROAD_RIGHT - cw - 30), 3);
            if (!bus.air && hit(inflate(p.rect, 16, 16), bus.rect)) p.touch += 1;
            else p.touch = Math.max(0, p.touch - 1);
            if (p.touch > 25) {
                // поймали: выбор — взятка или отдел (см. payBribe / goToStation)
                const stars = Math.max(1, this.stars), fine = this.policeFine * stars;
                const bribe = Math.round((fine * (stars >= MAX_STARS ? 1.5 : BRIBE_RATE)) / 50) * 50;
                p.leaving = true;
                bus.speed = 0;
                this.comboTimer = 0;
                this.shake = 8;
                this.caught = { stars, fine, bribe };
                if (this.storyFlags) this.storyFlags.caught = true;
                this.state = "caught";
                return;
            } else if (p.timer > this.chaseTime * (0.6 + 0.4 * this.stars) || p.y > HEIGHT + 380) {
                this.escapePolice("Ушёл от ДПС!");
            }
        }
        p.y += bus.speed - p.speed;
        if (p.leaving && (p.y > HEIGHT + 300 || p.y < -400)) this.police = null;
    }

    updateStops() {
        for (const stop of this.stops) {
            const edge = this.cityGraph.edges.get(stop.cityEdge);
            if (stop.cityTravel !== undefined) {
                stop.y = this.bus.centerY - (stop.cityTravel - this.cityTravel) - BusStop.HEIGHT / 2;
            } else if (edge) {
                const [x, y] = this.cityGraph.position(edge, stop.cityOffset);
                const ahead = (x - this.wx) * this.dir[0] + (y - this.wy) * this.dir[1];
                stop.y = this.bus.centerY - ahead - BusStop.HEIGHT / 2;
            } else stop.y += this.bus.speed;
        }
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

    checkPeds(lane, top) {
        // не пропустил пешехода: он отпрыгивает, а маршрутке — штраф, жалобы и ДПС
        const bus = this.bus;
        if (bus.air || Math.abs(bus.speed) < 1) return;     // стоишь — пешеход сам виноват, штрафа нет
        for (const p of lane.peds) {
            if (p.hit || !hit(lane.rect(p, top), inflate(bus.rect, 4, 4))) continue;
            p.hit = true;
            p.jump = 26;
            p.dir = p.x < bus.x ? -1 : 1;
            this.money -= PED_FINE;
            this.shake = Math.max(this.shake, 8);
            this.floatText(`Пешеход! -${PED_FINE}`, bus.x, bus.y - 30, RED, true);
            this.addRep(-3);
            this.addComplaints(2, "Не пропустил пешехода!");
            this.startChase("не пропустил пешехода", 0.7, 2);
        }
    }

    updateWorldObjects() {
        const bus = this.bus, s = bus.speed;
        // маршрутка близко и едет быстро — пешеходы у бордюра ждут
        const busClose = (top) => bus.speed > 3 && bus.y - top > -bus.h && bus.y - top < 60 + bus.speed * 22;
        this.scenery.update(s);
        for (const b of this.bridges) b.y += s;
        for (const t of this.shifts) t.y += s;
        // смена ширины ушла далеко назад — её «верхнее» значение становится основным
        for (const t of this.shifts.filter((t) => t.y > HEIGHT + 700)) {
            this.openBelow = t.to;
            this.styleBelow = t.style;
        }
        this.shifts = this.shifts.filter((t) => t.y <= HEIGHT + 700);
        this.bridges = this.bridges.filter((b) => b.y + b.h > -1200 && b.y < HEIGHT + 400);
        for (const cw of this.crosswalks) {
            cw.y += s;
            const visible = cw.y > -200 && cw.y < HEIGHT;
            cw.peds.update(visible, cw.rate, busClose(cw.y), bus, cw.y + 2);
            this.checkPeds(cw.peds, cw.y);
            // остановился перед переходом и пропустил людей — пассажиры довольны
            if (!cw.polite && cw.peds.onRoad && Math.abs(bus.speed) < 0.3 && bus.y - cw.bottom > 0 && bus.y - cw.bottom < 170) {
                cw.polite = true;
                this.money += 30;
                this.floatText("Пропустил пешеходов  +30", bus.x, bus.y - 30, GREEN);
                this.removeComplaint("вежливый водитель");
            }
        }
        this.crosswalks = this.crosswalks.filter((c) => c.y > -800 && c.y < HEIGHT + 300);
        for (const inter of this.inters) {
            const node = this.cityGraph.nodes.get(inter.k);
            if (inter.cityTravel !== undefined) {
                inter.y = bus.centerY - (inter.cityTravel - this.cityTravel) - inter.h / 2;
            } else if (node) {
                const ahead = (node.x - this.wx) * this.dir[0] + (node.y - this.wy) * this.dir[1];
                inter.y = bus.centerY - ahead - inter.h / 2;
            }
            inter.update(node || inter.cityTravel !== undefined ? 0 : s, busClose(inter.zebraTop), bus);

            this.checkPeds(inter.peds, inter.zebraTop);
            if (!inter.passed && bus.y < inter.stopLine && !bus.air) {
                inter.passed = true;
                if (inter.state === "red" && bus.speed > 0) {
                    // награда за дерзость — только пока не в розыске
                    if (!this.stars) this.stunt("Проскочил на красный!", 40);
                    this.startChase("проезд на красный", 0.55);
                }
            }
            if (inter.passed && bus.y > inter.stopLine + 20) inter.passed = false;   // сдали назад
        }
        this.inters = this.inters.filter((i) => i.y > -1600 && i.y < HEIGHT + 300);   // новые появляются на ~-1100 (широкие улицы)

        for (const ramp of this.ramps) {
            ramp.y += s;
            if (!bus.air && hit(ramp.rect, inflate(bus.rect, -20, -bus.h + 20))) {
                if (bus.speed > 6) {
                    bus.airTotal = bus.air = Math.floor(bus.speed * 6);
                    this.jumped = new Set();
                    this.floatText("Трамплин!", bus.x, bus.y - 10, YELLOW, true);
                    if (this.passengers.length) this.floatText("Ааааа!!!", bus.x + 60, bus.y + 40, WHITE);
                } else if (bus.speed > 1 && this.frame % 20 === 0) this.shake = 3;
            }
        }
        this.ramps = this.ramps.filter((r) => r.y > -600 && r.y < HEIGHT + 300);

        for (const st of this.stations) {
            st.y += s;
            if (!st.checked && st.y + PoliceStation.HEIGHT / 2 > bus.centerY) {
                st.checked = true;
                if (this.stars) this.startChase("заметили у отдела полиции", 0.85, 0);
                else this.floatText("Отдел полиции — тут лучше не нарушать", ROAD_RIGHT - 120, st.y + 40, BLUE);
            }
        }
        this.stations = this.stations.filter((st) => st.y > -800 && st.y < HEIGHT + 400);
        for (const post of this.posts) {
            post.y += s;
            if (!post.checked && post.y + 40 > bus.centerY) {
                post.checked = true;
                if (bus.air) {                          // над радаром в прыжке — не засекли
                    this.stunt("Перелетел радар!", 60);
                    continue;
                }
                const kmh = Math.floor(bus.speed * KMH);
                if (kmh > SPEED_LIMIT) {
                    this.floatText(`Радар: ${kmh} км/ч!`, ROAD_RIGHT - 60, post.y, RED, true);
                    this.startChase(`превышение ${kmh} км/ч`, 0.85, kmh > SPEED_LIMIT + 30 ? 2 : 1);
                } else {
                    this.floatText("ДПС: счастливого пути", ROAD_RIGHT - 80, post.y, GREEN);
                    if (this.storyFlags) this.storyFlags.radarOk = true;
                }
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
            if (this.stopsServed % 5 === 0) {
                const lap = this.stopsServed / 5;
                this.missionComplete("5 ОСТАНОВОК!", 100 + 50 * lap, 2);
            }
            this.showBanner(`Остановка «${stop.name}». Двери открываются!`, YELLOW);
            this.floatText("Остановка!", bus.x, bus.y - 20, YELLOW, true);
        }
        if (bus.doorOpen < 1) return;
        // всех высадил и всех забрал — пассажиры довольны
        if (!stop.thanked && !stop.waiting && !this.passengers.includes(stop.id) && !this.walkers.length) {
            stop.thanked = true;
            this.money += 20;
            this.removeComplaint("всех обслужил");
        }
        this.serviceTimer += 1;
        if (this.serviceTimer < this.serviceDelay) return;
        this.serviceTimer = 0;
        const doors = bus.doorYs;
        // за раз обслуживаем столько людей, сколько дверей (+ касса)
        for (let n = 0; n < this.perTick; n++) {
            const door = n % doors.length;
            const dx = bus.x + bus.w / 2, dy = bus.y + doors[door] + 13;
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
                const w = new Walker(sx, sy + randint(-10, 30), "in", stop, stop.id + randint(1, 4));
                w.door = door;
                this.walkers.push(w);
            } else {
                if (stop.waiting > 0 && n === 0 && this.frame % 120 < this.serviceDelay) this.floatText("Мест нет!", dx, dy - 30, RED);
                break;
            }
        }
    }

    updateWalkers() {
        const bus = this.bus, here = this.currentStop();
        for (const w of this.walkers) {
            w.y += bus.speed;
            w.phase += 0.35;
            if (w.kind === "in") {
                if (!w.returning && here !== w.stop) w.returning = true;
                const doorY = bus.doorYs[Math.min(w.door || 0, bus.doorYs.length - 1)];
                const [tx, ty] = w.returning ? w.stop.shelterPos : [bus.x + bus.w / 2, bus.y + doorY + 13];
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
        for (const car of this.serverCars || []) if (hit(car.rect, bus.rect)) this.jumped.add(`server:${car.id}`);
        for (const car of this.cars) if (hit(car.rect, bus.rect)) this.jumped.add(car);
        if (bus.air === 1) {                   // приземление
            this.burst(bus.x, bus.y + bus.h, [190, 180, 160], 30, 4, 6, 35);
            this.shake = 10;
            const n = this.jumped.size;
            // приземлился на машину — её сминает, маршрутке ничего
            const under = this.cars.filter((c) => !c.wreck && hit(inflate(bus.rect, 10, 10), c.rect));
            for (const c of under) {
                c.wreck = true;
                c.speed = c.baseSpeed = 0;
                c.targetLane = c.lane;
                this.burst(c.x, c.y + CAR_H / 2, [255, 200, 60], 24, 5, 5, 35);
                this.burst(c.x, c.y + CAR_H / 2, [200, 220, 240], 14, 4, 3, 30);
            }
            for (const inter of this.inters) {
                inter.crossCars = inter.crossCars.filter((c) => {
                    const r = inter.crossRect(c);
                    if (!hit(inflate(bus.rect, 10, 10), r)) return true;
                    this.burst(r.x + r.w / 2, r.y + r.h / 2, [255, 200, 60], 24, 5, 5, 35);
                    under.push(c);
                    return false;
                });
            }
            bus.landing = 20;
            if (under.length) {
                this.shake = 18;
                this.stunt(under.length > 1 ? `Раздавил ${under.length} маш.!` : "Раздавил машину!", 150 * under.length + 80 * n);
            } else this.stunt(n === 0 ? "Полёт!" : `Перелетел ${n} маш.!`, 100 + 80 * n);
        }
    }

    updateEffects() {
        const bus = this.bus, s = bus.speed, r = bus.rect;
        if (bus.accelerating && this.frame % 3 === 0 && !bus.air) {
            this.particles.push(new Particle(bus.x - bus.w / 2 + 10, bus.y + bus.h + 2,
                rand(-0.4, 0.4), rand(0.5, 1.5), 40, [120, 120, 120], 3, 0.25));
        }
        if (bus.braking && s > 4 && !bus.air) {
            for (const wx of [bus.x - bus.w / 2 + 8, bus.x + bus.w / 2 - 8]) {
                this.skids.push({ x: wx, y: bus.y + bus.h - 10, life: 240 });
                if (Math.random() < 0.4) {
                    this.particles.push(new Particle(wx, bus.y + bus.h, rand(-0.6, 0.6), 0.5, 35, [200, 200, 200], 4, 0.3));
                }
            }
        }
        const atLeft = r.x <= ROAD_LEFT + 6, atRight = r.x + r.w >= ROAD_RIGHT - 6;
        if ((atLeft || atRight) && Math.abs(s) > 3 && Math.random() < 0.5 && !bus.air) {
            this.particles.push(new Particle(atLeft ? r.x : r.x + r.w, bus.y + rand(10, bus.h), 0, 1, 25, [190, 170, 120], 3, 0.2));
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
        if (this.repPopup && --this.repPopup.frames <= 0) this.repPopup = null;
        if (this.notice && --this.notice.frames <= 0) this.notice = null;
        this.comboTimer = Math.max(0, this.comboTimer - 1);
        if (this.comboTimer === 0) this.combo = 0;
        this.moneyShown += (this.money - this.moneyShown) * 0.15;
        this.shake = Math.max(0, this.shake - 1);
        this.flash = Math.max(0, this.flash - 12);
        this.hornT = Math.max(0, this.hornT - 1);
        this.hornCool = Math.max(0, this.hornCool - 1);
        for (const c of this.cars) if (c.hurry > 0) c.hurry -= 1;
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
        this.addRep(-3);
        this.shake = 30;
        this.flash = 220;
        bus.speed = 0;
        bus.air = 0;
        for (const c of this.cars) c.speed = 0;
        if (this.police) {
            this.police.speed = 0;
            this.police.leaving = true;
        }
        this.state = "boom";
        this.boomTimer = 80;
    }

    // конвой в отдел: маршрутка сама едет за машиной ДПС, остальные уступают
    updateEscort() {
        const bus = this.bus, p = this.police, s = 5;
        bus.speed = s;
        bus.vx = 0;
        bus.doorOpen = 0;
        bus.invuln = 0;
        this.scroll += s;
        this.distance += s;
        this.advanceCity(s);
        if (this.state === "turning") return;
        this.scenery.update(s);
        for (const list of [this.stops, this.ramps, this.posts, this.crosswalks, this.bridges, this.stations, this.shifts, this.inters, this.skids]) {
            for (const o of list) o.y += s;
        }
        if (this.motorcade) for (const o of this.motorcade.officers) o.y += s;
        this.cars = this.cars.filter((c) => !(Math.abs(c.x - bus.x) < LANE_W && c.y < bus.y + bus.h + 40 && c.y > -300));
        for (const c of this.cars) c.y += s + c.dir * c.speed;
        // машина ДПС обгоняет по соседней полосе и встаёт впереди
        const ahead = bus.y - Police.H - 50, passing = p.y > ahead + 20;
        p.x = approach(p.x, bus.x + (passing ? (bus.x > roadMiddle() + LANE_W ? -LANE_W : LANE_W) : 0), 4);
        p.y = approach(p.y, ahead, 6);
        p.leaving = false;
        p.speed = s;
        this.updateEffects();
    }

    updateMotorcade() {
        if (this.serverTrafficActive) return;
        const bus = this.bus, mins = Math.floor(this.clock / FRAMES_PER_MIN);
        // за час до кортежа — объявление
        if (this.motorcadeAt && !this.motorcadeAnnounced && mins >= this.motorcadeAt - 60) {
            this.motorcadeAnnounced = true;
            this.showBanner(`Около ${hhmm(this.motorcadeAt)} перекроют дорогу: поедет кортеж`, [255, 210, 80], 240);
        }
        if (!this.motorcade && this.motorcadeAt && mins >= this.motorcadeAt) {
            // ждём спокойного места: без погони и без перекрёстка на экране
            if (this.police || this.inters.some((i) => i.y > -500 && i.y < HEIGHT)) {
                this.motorcadeAt = mins + 1;
                return;
            }
            this.motorcadeAt = null;
            const officers = [];
            for (const y of [140, 400, 660]) officers.push({ y, side: -1 }, { y: y - 70, side: 1 });
            this.motorcade = { phase: "closing", t: 0, convoy: [], officers, violated: false };
            this.showBanner("Перекрытие! Едет кортеж — остановись", [255, 210, 80], 300);
        }
        const m = this.motorcade;
        if (!m) return;
        m.t += 1;
        for (const o of m.officers) o.y += bus.speed;
        // не остановился во время перекрытия
        if (!m.violated && m.t > 150 && bus.speed * KMH > 20) {
            m.violated = true;
            this.startChase("не остановился перед кортежем", 0.9, 2);
        }
        if (m.phase === "closing" && m.t > 360) {
            m.phase = "passing";
            const x = laneCenter(ownFirst() - 1);
            this.cars = this.cars.filter((c) => !(c.dir > 0 && Math.abs(c.x - x) < LANE_W));   // встречка прижалась к обочине
            let y = -150;
            for (const kind of ["cop", "cop", "limo", "limo", "limo", "ambulance", "cop"]) {
                const len = kind === "limo" ? 132 : kind === "ambulance" ? 110 : 96;
                y -= len;
                m.convoy.push({ kind, x, y, len });
                y -= 36;
            }
            this.showBanner("Кортеж!", [255, 210, 80], 120);
        }
        if (m.phase === "passing") {
            for (const v of m.convoy) v.y += bus.speed + 15;
            if (m.convoy.every((v) => v.y > HEIGHT + 150)) {
                this.motorcade = null;
                this.showBanner("Перекрытие снято, движение открыто", GREEN);
                if (!m.violated) {
                    this.missionComplete("КОРТЕЖ ПРОЕХАЛ!", 0, 1);
                    if (this.storyFlags) this.storyFlags.motorcadeOk = true;
                }
            }
        }
    }

    checkCollisions() {
        const bus = this.bus;
        if (bus.air || bus.invuln || bus.landing) return;
        const hb = inflate(bus.rect, -8, -8);
        for (const car of this.serverCars || []) {
            const body = rect(car.x - car.w / 2 + 3, car.y - car.h / 2 + 3, car.w - 6, car.h - 6);
            if (car.collidable && car.alpha > 0.25 && hit(hb, car.rect) && rotatedHit(hb, this.bendAngle(), body, car.angle)) {
                this.crash(car.rect);
                return;
            }
        }
        for (const v of this.motorcade ? this.motorcade.convoy : []) {   // влез на встречку перед кортежем
            const r = rect(v.x - 27, v.y, 54, v.len);
            if (hit(hb, inflate(r, -6, -6))) {
                this.crash(r);
                return;
            }
        }
        for (const car of this.serverTrafficActive ? [] : this.cars) {
            if (!car.wreck && hit(hb, inflate(car.rect, -6, -6))) {     // по обломкам проезжаем
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

    get repairCost() {
        return REPAIR_COST * (this.repairs + 1);
    }

    // после ДТП: заплатить за ремонт из денег рейса и ехать дальше
    payRepair() {
        if (this.state !== "offer" || this.money < this.repairCost) return;
        this.money -= this.repairCost;
        this.repairs += 1;
        const bus = this.bus;
        this.cars = this.cars.filter((c) => Math.abs(c.y - bus.y) > 300);
        for (const i of this.inters) i.crossCars = [];
        bus.invuln = 150;
        this.flash = 120;
        this.showBanner("Отремонтировались. Поехали!", GREEN);
        this.state = "play";
    }

    finish(how) {
        if (how === "shift" && this.storyFlags) {          // глава «отработай смену»
            this.storyFlags.shiftDone = true;
            storyCheck(this);
        }
        // Конец рейса: деньги в кошелёк (если не уволили), сохранение. Конец смены — с премией
        this.bonus = how === "shift" ? 300 + 30 * this.stopsServed + (this.complaints === 0 ? 500 : 0) : 0;
        if (how === "shift") this.money += this.bonus;
        // уволили или лишили прав — заработок сгорает (долги остаются)
        const earned = how === "crash" || how === "shift" || this.money < 0 ? this.money : 0;
        const repEnd = { shift: 5 + (this.complaints === 0 ? 3 : 0), arrested: -10, fired: -8 }[how] || 0;
        this.repDelta += repEnd;
        this.save.rep = clamp(Math.round(this.save.rep + this.repDelta), 0, 100);
        this.save.wallet = Math.max(0, this.save.wallet + earned);
        this.save.best = Math.max(this.save.best, this.money);
        writeSave(this.save);
        this.result = {
            how, money: this.money, earned, bonus: this.bonus, rep: Math.round(this.repDelta), km: (this.distance * METERS_PER_PX) / 1000, stops: this.stopsServed,
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
            if (this.boomTimer <= 0) {
                if (this.money >= this.repairCost) this.state = "offer";
                else this.finish("crash");
            }
            return;
        }

        const bus = this.bus;
        bus.bay = this.bayExtra();
        bus.closed = approach(bus.closed, this.busClosed(), 0.75);
        bus.update(this.keys);
        // При нескольких боковых выездах ждём выбора улицы. Единственный
        // разрешённый изгиб проходит автоматически, это не тупик.
        for (const inter of this.inters) {
            if (inter.k !== this.nextCross().k) continue;
            const room = bus.y - (inter.y + 6);
            const options = this.cityOptions(inter.k);
            if (!this.cityPendingTurn && !this.selectedCityExit(options) && options.requiresChoice &&
                bus.speed > room && room > -200) {
                bus.speed = Math.max(0, room);
                if (this.frame % 90 === 0) this.showBanner("Перекрёсток: выбери улицу Q/E или рулём", BLUE, 80);
            }
        }
        this.checkSlalom();
        // часы смены
        this.clock += 1;
        if (this.clock >= SHIFT_END * FRAMES_PER_MIN) {
            this.showBanner("Конец рабочего дня!", YELLOW);
            this.finish("shift");
            return;
        }
        // долго едешь по встречке — ДПС может заметить
        if (bus.x < roadMiddle() - 6 && bus.speed > 3) {
            if (++this.wrongWay === 90) this.startChase("выезд на встречку", 0.4);
        } else this.wrongWay = 0;

        const travelled = this.advanceCity(bus.speed);
        this.updateCameraDirection();
        this.distance += Math.abs(travelled);
        this.scroll += travelled;
        if (this.state === "turning") return;
        bus.speed = travelled;
        if (this.frame % 20 === 0) {
            this.trail.push([this.wx, this.wy]);
            this.trail = this.trail.slice(-300);
        }
        this.spawnObjects();

        if (!this.serverTrafficActive && --this.spawnTimer <= 0 && !this.motorcade) {      // при перекрытии новых машин нет
            this.spawnCar();
            // больше полос — больше машин
            const hard = Math.min(1, this.distance / 60000), k = (4 / LANES) / this.route.traffic;
            this.spawnTimer = Math.max(6, Math.round(randint(Math.floor(22 - 8 * hard), Math.floor(60 - 25 * hard)) * k * 0.8));
        }

        this.updateCars();
        this.updateMotorcade();
        this.updatePolice();
        if (this.state !== "play") return;
        this.updateWanted();
        storyCheck(this);
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

}
