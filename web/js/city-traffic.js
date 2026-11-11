// Offline traffic on the immutable geographic road graph. Vehicles keep their
// identity across source edges; no screen-space spawning or per-road reset.
"use strict";

class LocalCityTraffic {
    constructor(graph, mapGeometry) {
        this.graph = graph;
        this.geometry = mapGeometry;
        this.cars = new Map();
        this.reservations = new Map();
        this.arrivals = new Map();
        this.controlCache = new Map();
        this.zoneCache = new Map();
        this.nodeIndices = new Map([...graph.nodes.values()].map(node => [node.index, node]));
        this.carRules = new Map();
        this.elapsed = 0;
        this.serial = 0;
        this.sequence = 0x49524b;
        this.spawnCredit = 24;
        this.spawnPool = [];
        this.poolCenter = null;
        this.cap = 80;
        for (const relation of graph.data.sourceRestrictions || []) {
            const tags = relation.tags || {}, except = (tags.except || "").split(";");
            if (except.some(value => ["motorcar", "motor_vehicle", "vehicle"].includes(value))) continue;
            const kind = tags["restriction:motorcar"] || tags["restriction:motor_vehicle"] || tags.restriction;
            if (!kind || !/^(no_|only_)/.test(kind)) continue;
            const via = relation.members.filter(member => member.type === "node" && member.role === "via");
            const from = relation.members.filter(member => member.type === "way" && member.role === "from").map(member => member.ref);
            const to = relation.members.filter(member => member.type === "way" && member.role === "to").map(member => member.ref);
            if (via.length !== 1 || !from.length || !to.length) continue;
            const node = `osm-${via[0].ref}`;
            if (!this.carRules.has(node)) this.carRules.set(node, []);
            this.carRules.get(node).push({ kind, from, to });
        }
    }

    random() {
        let value = this.sequence = (this.sequence + 0x6d2b79f5) >>> 0;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    }

    canDrive(edge, reverse) {
        const tags = edge.osmTags || {};
        let allowed = tags.highway !== "busway";
        for (const name of ["motorcar", "motor_vehicle", "vehicle", "access"]) {
            if (["no", "private", "destination", "customers", "delivery"].includes(tags[name])) { allowed = false; break; }
            if (["yes", "designated", "permissive"].includes(tags[name])) { allowed = true; break; }
        }
        if (!allowed) return false;
        let oneway = edge.oneway;
        for (const name of ["oneway:motorcar", "oneway:motor_vehicle", "oneway:vehicle"]) {
            if (["-1", "yes", "true", "1", "no", "false", "0"].includes(String(tags[name]))) {
                oneway = tags[name] === "-1" ? -1 : ["no", "false", "0"].includes(String(tags[name])) ? 0 : 1;
                break;
            }
        }
        if (oneway === true || oneway === 1 || oneway === "yes" || oneway === "1") return !reverse;
        if (oneway === -1 || oneway === "-1") return reverse;
        return true;
    }

    canTurn(from, reverse, option) {
        const node = this.graph.endpoint(from, reverse), to = option.edge;
        if (!this.canDrive(to, option.reverse) || this.graph.origin(to, option.reverse) !== node) return false;
        const applicable = (this.carRules.get(node) || []).filter(rule =>
            from.osmWayIds?.some(id => rule.from.includes(id)));
        const matches = rule => to.osmWayIds?.some(id => rule.to.includes(id)) &&
            (!rule.kind.endsWith("u_turn") || from.id === to.id);
        const only = applicable.filter(rule => rule.kind.startsWith("only_"));
        return (!only.length || only.some(matches)) && !applicable.some(rule => rule.kind.startsWith("no_") && matches(rule));
    }

    exits(edge, reverse) {
        const node = this.graph.endpoint(edge, reverse);
        const choices = this.physicalExits(node).filter(option => this.canTurn(edge, reverse, option));
        const ordinary = choices.filter(option => option.edge.id !== edge.id || option.reverse === reverse);
        return ordinary.length ? ordinary : choices;
    }

    physicalExits(node) {
        const result = [], seen = new Set();
        for (const edge of this.graph.adjacent.get(node) || []) {
            for (const reverse of edge.from === edge.to ? [false, true] : [edge.to === node]) {
                const key = this.key(edge, reverse);
                if (!seen.has(key) && this.canDrive(edge, reverse)) { seen.add(key); result.push({ edge, reverse }); }
            }
        }
        return result;
    }

    progress(car) { return car.reverse ? car.edge.length - car.offset : car.offset; }
    key(edge, reverse) { return `${edge.id}:${reverse}`; }

    laneCount(edge, reverse) {
        const tags = edge.osmTags || {}, directed = Number(tags[reverse ? "lanes:backward" : "lanes:forward"]);
        const oneWay = !this.canDrive(edge, !reverse);
        const normalized = Math.max(1, Math.min(3, Math.floor(edge.lanes / 2)));
        const sourced = oneWay ? Number(tags.lanes) : directed;
        return Math.max(1, Math.min(normalized, Math.floor(sourced || normalized)));
    }

    lateral(edge, reverse, lane, progress) {
        const count = this.laneCount(edge, reverse), width = this.geometry.laneWidth || 74;
        const offset = reverse ? edge.length - progress : progress;
        const half = Math.max(30, this.geometry.halfWidth(edge, offset) - 31);
        const index = Math.max(0, Math.min(count - 1, lane));
        const value = (index + .5) * width;
        return Math.max(-half, Math.min(half, value));
    }

    lanePosition(edge, reverse, progress, lateral) {
        const offset = Math.max(0, Math.min(edge.length, reverse ? edge.length - progress : progress));
        const point = this.graph.position(edge, offset);
        const a = this.graph.position(edge, Math.max(0, offset - 60)), b = this.graph.position(edge, Math.min(edge.length, offset + 60));
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]), sign = reverse ? -1 : 1;
        const dir = length > 1e-7 ? [(b[0] - a[0]) / length * sign, (b[1] - a[1]) / length * sign]
            : this.graph.direction(edge, reverse, offset);
        return { x: point[0] - dir[1] * lateral, y: point[1] + dir[0] * lateral, dir };
    }

    control(edge, reverse) {
        const key = this.key(edge, reverse);
        if (!this.controlCache.has(key)) this.controlCache.set(key, this.geometry.junction(edge, reverse));
        return this.controlCache.get(key);
    }

    signalState(control, now = Date.now()) {
        if (!control.signal) return "none";
        const index = Number.isFinite(control.groupIndex) ? control.groupIndex : this.graph.nodes.get(control.nodeId)?.index || 0;
        let value = (Math.imul(index, 374761393) + Math.imul(index * 7, 668265263)) | 0;
        value = Math.imul(value ^ (value >>> 13), 1274126177);
        const fraction = ((value ^ (value >>> 16)) >>> 0) / 4294967296;
        const green = typeof GREEN_T === "number" ? GREEN_T : 290;
        const yellow = typeof YELLOW_T === "number" ? YELLOW_T : 25;
        const cycle = typeof CYCLE === "number" ? CYCLE : 650;
        const dir = control.signalDir || control.dir;
        const phase = ((Math.floor(now * 60 / 1000) + Math.floor(fraction * cycle) +
            (Math.abs(dir[1]) >= Math.abs(dir[0]) ? 0 : cycle / 2)) % cycle + cycle) % cycle;
        return phase < green ? "green" : phase < green + yellow ? "yellow" : "red";
    }

    plan(car, forced = null) {
        const key = this.key(car.edge, car.reverse);
        const preserveLane = plan => {
            if (!plan.laneTurn) plan.lane = plan.incomingLane = Math.min(car.lane, this.laneCount(plan.edge, plan.reverse) - 1);
            return plan;
        };
        if (!forced && car.next) return preserveLane(car.next);
        if (!forced && car.plans?.has(key)) { car.next = car.plans.get(key); return preserveLane(car.next); }
        const choices = this.exits(car.edge, car.reverse), incoming = this.graph.direction(car.edge, car.reverse,
            car.reverse ? 0 : car.edge.length);
        if (!choices.length) return null;
        const escaping = choices.filter(option => this.exits(option.edge, option.reverse).length > 0);
        const back = this.physicalExits(this.graph.endpoint(car.edge, car.reverse)).find(option =>
            option.edge.id === car.edge.id && option.reverse !== car.reverse && this.canTurn(car.edge, car.reverse, option));
        const available = escaping.length ? escaping : back ? [back] : choices;
        const scored = available.map(option => {
            const dir = this.graph.direction(option.edge, option.reverse);
            const angle = Math.atan2(incoming[0] * dir[1] - incoming[1] * dir[0], incoming[0] * dir[0] + incoming[1] * dir[1]);
            const same = (car.edge.osmWayIds || []).some(id => option.edge.osmWayIds?.includes(id));
            return { ...option, angle, weight: (Math.abs(angle) < .35 ? 4 : Math.abs(angle) > 2.6 ? .15 : 1) * (same ? 1.4 : 1) };
        });
        let pick = this.random() * scored.reduce((sum, option) => sum + option.weight, 0), next = scored.at(-1);
        for (const option of scored) { pick -= option.weight; if (pick <= 0) { next = option; break; } }
        if (forced) {
            const dir = this.graph.direction(forced.edge, forced.reverse);
            next = { ...forced, angle: Math.atan2(incoming[0] * dir[1] - incoming[1] * dir[0], incoming[0] * dir[0] + incoming[1] * dir[1]) };
        }
        const control = this.control(car.edge, car.reverse), nextCount = this.laneCount(next.edge, next.reverse);
        const count = this.laneCount(car.edge, car.reverse), turn = Math.abs(next.angle) > .35;
        const uturn = next.edge.id === car.edge.id && next.reverse !== car.reverse;
        const laneTurn = turn && (choices.length > 1 || uturn);
        const lane = !laneTurn ? Math.min(nextCount - 1, car.lane) : next.angle < 0 || uturn ? 0 : nextCount - 1;
        const incomingLane = !laneTurn ? Math.min(car.lane, nextCount - 1) : next.angle < 0 || uturn ? 0 : count - 1;
        const cutIn = Math.min(car.edge.length * .45, 180, Math.max(16, control.width / 2 + 16));
        const cutOut = Math.min(next.edge.length * .45, 180, Math.max(16, car.edge.lanes * 37 + 16));
        const node = this.graph.nodes.get(control.nodeId);
        const groupNode = this.nodeIndices.get(control.groupIndex) || node;
        const reservation = (this.graph.adjacent.get(control.nodeId)?.length || 0) > 2 ||
            control.signal || control.stop || control.yield || next.edge.id === car.edge.id;
        car.next = { ...next, lane, incomingLane, laneTurn, control, cutIn, cutOut,
            entry: car.edge.length - cutIn, group: groupNode?.id || control.nodeId, reservation };
        car.plans?.set(key, car.next);
        return car.next;
    }

    laneIntent(car) {
        let subject = car, distance = -this.progress(car), next = this.plan(subject);
        const seen = new Set();
        for (let count = 0; next && count < 24 && distance < 1600; count++) {
            const key = this.key(subject.edge, subject.reverse);
            if (seen.has(key)) break;
            seen.add(key);
            const at = distance + next.entry;
            if (next.laneTurn || next.incomingLane !== subject.lane ||
                this.exits(subject.edge, subject.reverse).length > 1) {
                return { lane: Math.min(this.laneCount(car.edge, car.reverse) - 1, next.incomingLane),
                    distance: Math.max(0, at), turn: next.laneTurn };
            }
            distance += subject.edge.length;
            subject = { ...car, edge: next.edge, reverse: next.reverse, lane: next.lane, next: null };
            next = this.plan(subject);
        }
        return { lane: car.lane, distance: Infinity, turn: false };
    }

    laneGap(car, lane) {
        const progress = this.progress(car), lateral = this.lateral(car.edge, car.reverse, lane, progress);
        const target = this.lanePosition(car.edge, car.reverse, progress, lateral);
        for (const other of this.cars.values()) {
            if (other === car || this.geometry.layer(other.edge) !== this.geometry.layer(car.edge)) continue;
            const dx = other.pose.x - target.x, dy = other.pose.y - target.y;
            const along = dx * target.dir[0] + dy * target.dir[1], side = -target.dir[1] * dx + target.dir[0] * dy;
            if (Math.abs(side) < 60 && along > -140 - other.speed * 16 && along < 150 + car.speed * 18) return false;
        }
        return true;
    }

    compatibleExit(car) {
        const incoming = this.graph.direction(car.edge, car.reverse, car.reverse ? 0 : car.edge.length);
        const count = this.laneCount(car.edge, car.reverse);
        return this.physicalExits(this.graph.endpoint(car.edge, car.reverse)).filter(option => {
            if (!this.canTurn(car.edge, car.reverse, option)) return false;
            const dir = this.graph.direction(option.edge, option.reverse);
            const angle = Math.atan2(incoming[0] * dir[1] - incoming[1] * dir[0], incoming[0] * dir[0] + incoming[1] * dir[1]);
            const required = Math.abs(angle) < .35 ? Math.min(car.lane, this.laneCount(option.edge, option.reverse) - 1)
                : angle < 0 || option.edge.id === car.edge.id ? 0 : count - 1;
            return required === car.lane && Math.abs(car.lateral - this.lateral(car.edge, car.reverse, required, this.progress(car))) < 8;
        }).sort((a, b) => Number(a.edge.id === car.edge.id) - Number(b.edge.id === car.edge.id))[0] || null;
    }

    curvePoint(arc, t) {
        const u = 1 - t, [a, b, c, d] = arc.points;
        const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
        const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y;
        const dx = 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x);
        const dy = 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y);
        const length = Math.hypot(dx, dy);
        return { x, y, dir: length > 1e-7 ? [dx / length, dy / length] : d.dir };
    }

    makeArc(car, next) {
        const endLateral = !next.laneTurn
            ? Math.max(-this.geometry.halfWidth(next.edge, next.reverse ? next.edge.length - next.cutOut : next.cutOut) + 31,
                Math.min(this.geometry.halfWidth(next.edge, next.reverse ? next.edge.length - next.cutOut : next.cutOut) - 31, car.lateral))
            : this.lateral(next.edge, next.reverse, next.lane, next.cutOut);
        const a = this.lanePosition(car.edge, car.reverse, next.entry, car.lateral);
        const d = this.lanePosition(next.edge, next.reverse, next.cutOut, endLateral);
        const handle = Math.max(1, Math.min(Math.max(next.cutIn, next.cutOut) * .7, Math.hypot(d.x - a.x, d.y - a.y) * .65));
        const arc = { next, at: 0, endLateral, endLane: next.lane, length: 0, distances: [0],
            points: [a, { x: a.x + a.dir[0] * handle, y: a.y + a.dir[1] * handle },
                { x: d.x - d.dir[0] * handle, y: d.y - d.dir[1] * handle }, d] };
        let previous = a;
        for (let index = 1; index <= 32; index++) {
            const point = this.curvePoint(arc, index / 32);
            arc.length += Math.hypot(point.x - previous.x, point.y - previous.y);
            arc.distances.push(arc.length); previous = point;
        }
        return arc;
    }

    point(car) {
        if (!car.arc) return this.lanePosition(car.edge, car.reverse, this.progress(car), car.lateral);
        const arc = car.arc;
        let index = 1;
        while (index < 32 && arc.distances[index] < arc.at) index++;
        const span = arc.distances[index] - arc.distances[index - 1];
        const t = (index - 1 + (span > 1e-7 ? (arc.at - arc.distances[index - 1]) / span : 0)) / 32;
        return this.curvePoint(arc, Math.max(0, Math.min(1, t)));
    }

    controlAhead(car) {
        let edge = car.edge, reverse = car.reverse, distance = edge.length - this.progress(car);
        for (let step = 0; step < 20 && distance < 1400; step++) {
            const control = this.control(edge, reverse);
            if (control.signal || control.stop || control.yield) return { control, distance, key: this.key(edge, reverse) };
            const exits = this.exits(edge, reverse);
            if (exits.length !== 1 || exits[0].edge.id === edge.id) break;
            edge = exits[0].edge; reverse = exits[0].reverse; distance += edge.length;
        }
        return null;
    }

    spawn(game, center) {
        if (!this.poolCenter || Math.hypot(center.x - this.poolCenter.x, center.y - this.poolCenter.y) > 650) {
            this.spawnPool = [...this.graph.nearbyEdges(center.x, center.y, 5000)].filter(edge =>
                edge.length > 220 && (this.canDrive(edge, false) || this.canDrive(edge, true)));
            this.poolCenter = { ...center };
        }
        if (!this.spawnPool.length) return false;
        for (let attempt = 0; attempt < 28; attempt++) {
            const edge = this.spawnPool[Math.floor(this.random() * this.spawnPool.length)];
            let reverse = this.random() < .5;
            if (!this.canDrive(edge, reverse)) reverse = !reverse;
            if (!this.exits(edge, reverse).length) continue;
            const progress = edge.length * .12 + this.random() * Math.max(1, edge.length * .43 - 120);
            const control = this.control(edge, reverse);
            if ((control.signal || control.stop) && progress > edge.length - control.stopLine - 80) continue;
            const lane = Math.floor(this.random() * this.laneCount(edge, reverse));
            const lateral = this.lateral(edge, reverse, lane, progress);
            const point = this.lanePosition(edge, reverse, progress, lateral);
            const distance = Math.hypot(point.x - center.x, point.y - center.y);
            if (distance < 2200 || distance > 4800 || [...this.cars.values()].some(car => {
                const other = car.pose; return Math.hypot(other.x - point.x, other.y - point.y) < 200;
            })) continue;
            const id = `local-npc-${++this.serial}`;
            const colors = [[200, 64, 49], [59, 108, 170], [64, 137, 84], [202, 202, 190], [65, 70, 77], [173, 119, 64], [142, 99, 150]];
            const car = { id, edge, reverse, offset: reverse ? edge.length - progress : progress,
                lane, lateral, speed: 3 + this.random() * 2, cruise: 4.3 + this.random() * 2.5,
                color: colors[Math.floor(this.random() * colors.length)], pose: point, travel: 0, age: 0, far: 0,
                stopped: new Set(), committed: new Set(), stopWait: new Map(), plans: new Map(), changing: null, yieldPending: false,
                braking: false, next: null, arc: null };
            this.plan(car);
            const intent = this.laneIntent(car);
            if (intent.distance < Math.abs(intent.lane - car.lane) * 240 + 140) {
                car.lane = intent.lane;
                car.lateral = this.lateral(edge, reverse, car.lane, progress);
                car.pose = this.lanePosition(edge, reverse, progress, car.lateral);
                if (Math.hypot(car.pose.x - center.x, car.pose.y - center.y) < 2200 || [...this.cars.values()].some(other =>
                    Math.hypot(other.pose.x - car.pose.x, other.pose.y - car.pose.y) < 200)) continue;
            }
            this.cars.set(id, car);
            return true;
        }
        return false;
    }

    exitSpace(car, next) {
        const point = this.lanePosition(next.edge, next.reverse, next.cutOut, this.lateral(next.edge, next.reverse, next.lane, next.cutOut));
        for (const other of this.cars.values()) {
            if (other === car) continue;
            if (other.edge.id === next.edge.id && other.reverse === next.reverse &&
                Math.abs(other.lateral - this.lateral(next.edge, next.reverse, next.lane, next.cutOut)) < 55) {
                const distance = this.progress(other) - next.cutOut;
                if (distance > -100 && distance < 180) return false;
            }
            if (other.arc && other.arc.next.edge.id === next.edge.id && other.arc.next.reverse === next.reverse &&
                other.arc.next.lane === next.lane) return false;
            const dx = other.pose.x - point.x, dy = other.pose.y - point.y;
            const along = dx * point.dir[0] + dy * point.dir[1];
            const side = -point.dir[1] * dx + point.dir[0] * dy;
            if (Math.abs(side) < 58 && along > -92 && along < 140) return false;
        }
        return true;
    }

    reservationIntent(car) {
        let subject = car, distance = -this.progress(car);
        const seen = new Set();
        for (let count = 0; count < 24 && distance < 700; count++) {
            const next = this.plan(subject), key = this.key(subject.edge, subject.reverse);
            if (!next || seen.has(key)) return null;
            seen.add(key);
            if (next.reservation) return { subject, next, distance: distance + next.entry,
                waitDistance: distance + subject.edge.length - next.control.stopLine - 52, key };
            distance += subject.edge.length;
            subject = { ...car, edge: next.edge, reverse: next.reverse, lane: next.lane, next: null };
        }
        return null;
    }

    zonesOverlap(a, b) {
        if (a.node === b.node) return true;
        const first = this.graph.nodes.get(a.node), last = this.graph.nodes.get(b.node), radius = a.radius + b.radius;
        if (!first || !last || Math.hypot(first.x - last.x, first.y - last.y) > radius) return false;
        const key = `${[a.node, b.node].sort().join("|")}:${Math.ceil(radius)}`;
        if (this.zoneCache.has(key)) return this.zoneCache.get(key);
        let connected = false;
        for (const start of this.graph.adjacent.get(a.node) || []) {
            let edge = start, node = a.node, length = 0;
            const seen = new Set();
            for (let count = 0; count < 32 && length <= radius; count++) {
                if (seen.has(edge.id)) break;
                seen.add(edge.id); length += edge.length; node = edge.from === node ? edge.to : edge.from;
                if (length > radius) break;
                if (node === b.node) { connected = true; break; }
                const adjacent = this.graph.adjacent.get(node) || [];
                if (adjacent.length !== 2) break;
                edge = adjacent.find(candidate => candidate.id !== edge.id);
                if (!edge) break;
            }
            if (connected) break;
        }
        this.zoneCache.set(key, connected);
        return connected;
    }

    requests(now) {
        const groups = new Map(), seen = new Set();
        for (const car of this.cars.values()) {
            if (car.arc) continue;
            const intent = this.reservationIntent(car), next = intent?.next;
            if (!next || intent.distance > 420) continue;
            const key = `${next.group}:${car.id}`; seen.add(key);
            if (!this.arrivals.has(key)) this.arrivals.set(key, this.elapsed);
            if (!groups.has(next.group)) groups.set(next.group, []);
            const control = next.control, ready = !control.signal || this.signalState(control, now) === "green" || car.committed.has(intent.key);
            const served = !control.stop || car.stopped.has(intent.key);
            const lane = Math.min(this.laneCount(car.edge, car.reverse) - 1, next.incomingLane);
            const laneReady = (!next.laneTurn || !car.changing) && car.lane === lane &&
                Math.abs(car.lateral - this.lateral(car.edge, car.reverse, lane, this.progress(car))) < 8;
            const priority = control.stop || control.yield || car.yieldPending ? -1 : car.edge.osmTags?.priority_road === "designated" ||
                car.edge.osmTags?.junction === "roundabout" ? 1 : 0;
            groups.get(next.group).push({ car, next, intent, since: this.arrivals.get(key), priority,
                eligible: ready && served && laneReady && this.exitSpace(car, next), dir: next.control.dir });
        }
        for (const key of this.arrivals.keys()) if (!seen.has(key)) this.arrivals.delete(key);
        for (const [group, requests] of groups) {
            if (this.reservations.has(group)) continue;
            const eligible = requests.filter(request => request.eligible).sort((a, b) => a.since - b.since || a.car.id.localeCompare(b.car.id));
            const oldest = eligible[0];
            if (!oldest) continue;
            const highestPriority = Math.max(...eligible.map(request => request.priority));
            const fair = eligible.find(request => request.priority === highestPriority && this.elapsed - request.since >= 3);
            let winner = fair && requests.every(request => request.car.speed < .1) ? fair : eligible.find(request => !eligible.some(other => {
                if (request === other) return false;
                if (other.priority !== request.priority) return other.priority > request.priority;
                const onRight = -request.dir[1] * -other.dir[0] + request.dir[0] * -other.dir[1] > .4;
                const opposing = request.dir[0] * other.dir[0] + request.dir[1] * other.dir[1] < -.5;
                return onRight || (request.next.angle < -.35 && opposing && other.next.angle >= -.35);
            }));
            if (!winner) continue;
            const zone = { node: group, radius: winner.next.control.width / 2 + 140 };
            if ([...this.reservations.values()].some(reservation => reservation.owner !== winner.car.id && this.zonesOverlap(zone, reservation.zone))) continue;
            const arc = this.makeArc(winner.intent.subject, winner.next);
            this.reservations.set(group, { owner: winner.car.id, acquired: this.elapsed, entered: false,
                control: winner.next.control, controlKey: winner.intent.key, zone,
                releaseAt: winner.car.travel + Math.max(0, winner.intent.distance) + arc.length + 100 });
        }
    }

    releaseReservations() {
        for (const [group, reservation] of this.reservations) {
            const owner = this.cars.get(reservation.owner);
            const red = owner && !reservation.entered && reservation.control.signal &&
                this.signalState(reservation.control) !== "green" && !owner.committed.has(reservation.controlKey);
            if (!owner || owner.travel >= reservation.releaseAt || red || (!reservation.entered && this.elapsed - reservation.acquired > 5)) {
                this.reservations.delete(group);
            }
        }
    }

    following(car, player) {
        let target = Infinity, space = Infinity;
        const consider = (point, speed, width = 50, height = 92) => {
            const dx = point.x - car.pose.x, dy = point.y - car.pose.y;
            const along = dx * car.pose.dir[0] + dy * car.pose.dir[1];
            const side = -car.pose.dir[1] * dx + car.pose.dir[0] * dy;
            if (along <= 0 || along > 650 || Math.abs(side) > (50 + width) / 2 + 5) return;
            if (point.dir && car.pose.dir[0] * point.dir[0] + car.pose.dir[1] * point.dir[1] < .35 && along > 150) return;
            const gap = along - (92 + height) / 2;
            space = Math.min(space, Math.max(0, gap - 22));
            target = Math.min(target, Math.max(0, speed + (gap - 55 - car.speed * 11) * .045));
        };
        for (const other of this.cars.values()) {
            if (other === car || this.geometry.layer(other.edge) !== this.geometry.layer(car.edge)) continue;
            consider(other.pose, other.speed);
        }
        if (player && player.layer === this.geometry.layer(car.edge)) consider(player, player.speed, player.w, player.h);
        return { target, space };
    }

    move(car, distance) {
        let left = distance;
        for (let count = 0; count < 64 && left > 1e-7; count++) {
            if (car.arc) {
                const amount = Math.min(left, car.arc.length - car.arc.at);
                car.arc.at += amount; car.travel += amount; left -= amount;
                if (car.arc.at + 1e-7 < car.arc.length) break;
                const next = car.arc.next;
                car.stopped.delete(this.key(car.edge, car.reverse)); car.committed.delete(this.key(car.edge, car.reverse));
                car.stopWait.delete(this.key(car.edge, car.reverse)); car.plans.delete(this.key(car.edge, car.reverse));
                if ((this.graph.adjacent.get(this.graph.endpoint(car.edge, car.reverse))?.length || 0) > 2) car.yieldPending = false;
                car.edge = next.edge; car.reverse = next.reverse; car.lane = car.arc.endLane;
                car.offset = car.reverse ? car.edge.length - next.cutOut : next.cutOut;
                car.lateral = car.arc.endLateral; car.arc = null; car.next = null;
                continue;
            }
            const next = this.plan(car);
            if (!next) break;
            const room = Math.max(0, next.entry - this.progress(car)), amount = Math.min(left, room);
            car.offset += car.reverse ? -amount : amount; car.travel += amount; left -= amount;
            if (amount + 1e-7 < room) break;
            const reservation = this.reservations.get(next.group);
            if (next.reservation && reservation?.owner !== car.id) break;
            if (next.laneTurn && (car.lane !== next.incomingLane || car.changing ||
                Math.abs(car.lateral - this.lateral(car.edge, car.reverse, next.incomingLane, this.progress(car))) > 8)) break;
            car.arc = this.makeArc(car, next);
            if (reservation?.owner === car.id) {
                reservation.entered = true; reservation.releaseAt = car.travel + car.arc.length + 100;
            }
            const ahead = this.controlAhead(car);
            const line = ahead ? ahead.distance - ahead.control.stopLine - 46 : Infinity;
            if (ahead?.control.signal && line >= -2 && line <= next.cutIn + next.cutOut &&
                this.signalState(ahead.control) === "green") car.committed.add(ahead.key);
        }
        car.pose = this.point(car);
        return distance - left;
    }

    update(game, dt = 1 / 60) {
        if (!Number.isFinite(dt) || dt <= 0 || game.serverTrafficActive || !["play", "boom", "offer"].includes(game.state)) return;
        dt = Math.min(.1, dt); this.elapsed += dt;
        const world = game.cityWorldPose || { wx: game.wx, wy: game.wy, angle: Math.atan2(game.dir[0], -game.dir[1]) };
        const center = { x: world.wx, y: world.wy };
        if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
        const now = Date.now(), player = { ...center, dir: [Math.sin(world.angle), -Math.cos(world.angle)],
            speed: Math.max(0, game.bus.speed), w: game.bus.w, h: game.bus.h, layer: this.geometry.layer(game.cityEdge) };
        for (const [id, car] of this.cars) {
            car.age += dt;
            const distance = Math.hypot(car.pose.x - center.x, car.pose.y - center.y);
            car.far = distance > 5500 ? car.far + dt : 0;
            if (distance > 5500 && (car.far > 8 || car.age > 180)) this.cars.delete(id);
        }
        this.releaseReservations(); this.requests(now);
        for (const car of this.cars.values()) {
            let next = this.plan(car);
            const following = this.following(car, player);
            const limit = Number.parseFloat(car.edge.osmTags?.maxspeed) / 7;
            let target = Math.min(car.cruise, Number.isFinite(limit) && limit > 0 ? limit : 7, following.target);
            let maxMove = following.space;
            if (!next && !car.arc) { target = 0; maxMove = 0; }
            if (!car.arc && next) {
                const entryDistance = Math.max(0, next.entry - this.progress(car));
                if (car.changing && Math.abs(car.lateral - this.lateral(car.edge, car.reverse, car.changing.lane, this.progress(car))) < 1) {
                    car.lane = car.changing.lane; car.changing = null;
                }
                const intent = this.laneIntent(car), difference = intent.lane - car.lane;
                const runway = Math.abs(difference) * 240 + 100;
                if (difference && !car.changing) {
                    const neighbor = car.lane + Math.sign(difference);
                    const need = Math.abs(car.lateral - this.lateral(car.edge, car.reverse, intent.lane, this.progress(car))) / .35 + 90;
                    const compatible = next.laneTurn && entryDistance < 350 && intent.distance < need ? this.compatibleExit(car) : null;
                    if (compatible) { car.plans.clear(); car.next = null; next = this.plan(car, compatible); }
                    else if (this.laneGap(car, neighbor)) car.changing = { lane: neighbor };
                    else if (intent.distance < runway) {
                        const room = Math.max(0, intent.distance - runway);
                        maxMove = Math.min(maxMove, room);
                        target = Math.min(target, Math.sqrt(2 * .2 * room));
                    }
                }
                if (car.changing) {
                    target = Math.min(target, 1.8);
                    if (!this.laneGap(car, car.changing.lane)) {
                        const need = Math.abs(car.lateral - this.lateral(car.edge, car.reverse, car.changing.lane, this.progress(car))) / .35 + 90;
                        const room = Math.max(0, intent.distance - need);
                        maxMove = Math.min(maxMove, room); target = Math.min(target, Math.sqrt(2 * .2 * room));
                    }
                }
                if (Math.abs(next.angle) > .35) target = Math.min(target, 2.4 + entryDistance * .015);
                const junction = this.reservationIntent(car);
                const reservation = junction ? this.reservations.get(junction.next.group) : null;
                if (junction && reservation?.owner !== car.id) {
                    let room = Math.max(0, junction.waitDistance);
                    if (room < entryDistance + next.cutIn + next.cutOut) room = Math.min(room, entryDistance);
                    maxMove = Math.min(maxMove, room);
                    target = Math.min(target, Math.sqrt(Math.max(0, 2 * .2 * room)));
                }
                const ahead = this.controlAhead(car);
                if (ahead) {
                    const control = ahead.control, distance = ahead.distance - control.stopLine - 46;
                    if (control.stop || control.yield) car.yieldPending = true;
                    const phase = this.signalState(control, now);
                    if (control.signal && phase === "green" && distance < Math.max(22, car.speed * 2)) car.committed.add(ahead.key);
                    const red = control.signal && phase !== "green" && !car.committed.has(ahead.key);
                    const stop = control.stop && !car.stopped.has(ahead.key);
                    if (red || stop) {
                        let stopDistance = Math.max(0, distance);
                        // A mapped control can sit on a tiny following fragment.
                        // Stop before its connector rather than crossing its line
                        // inside an arc or snapping backwards to that short edge.
                        const beforeArc = distance < entryDistance + next.cutIn + next.cutOut + 120;
                        if (beforeArc) stopDistance = Math.min(stopDistance, entryDistance);
                        maxMove = Math.min(maxMove, stopDistance);
                        target = Math.min(target, Math.sqrt(Math.max(0, 2 * .2 * stopDistance)));
                        if (stop && stopDistance < 3 && car.speed < .1) {
                            const held = (car.stopWait.get(ahead.key) || 0) + dt; car.stopWait.set(ahead.key, held);
                            if (held >= .7) car.stopped.add(ahead.key);
                        }
                    }
                }
            } else if (car.arc) target = Math.min(target, Math.abs(car.arc.next.angle) > .35 ? 2.4 : car.cruise);
            const oldSpeed = car.speed;
            car.speed += Math.max(-dt * 14, Math.min(dt * 5.5, target - car.speed));
            car.speed = Math.max(0, Math.min(car.speed, maxMove / (dt * 60)));
            const wanted = car.speed * dt * 60;
            const laneTravel = !car.arc && next ? Math.min(wanted, Math.max(0, next.entry - this.progress(car))) : 0;
            if (!car.arc && car.changing && laneTravel > .01 && this.laneGap(car, car.changing.lane)) {
                const lateral = this.lateral(car.edge, car.reverse, car.changing.lane, this.progress(car));
                const amount = Math.min(dt * 85, laneTravel * .35);
                car.lateral += Math.max(-amount, Math.min(amount, lateral - car.lateral));
                if (Math.abs(lateral - car.lateral) < 1) { car.lane = car.changing.lane; car.changing = null; }
            }
            const moved = this.move(car, Math.max(0, wanted));
            car.speed = Math.min(car.speed, moved / (dt * 60));
            car.braking = car.speed < oldSpeed - .025 || target < .15;
        }
        this.spawnCredit = Math.min(24, this.spawnCredit + dt * 8);
        let attempts = 0;
        while (this.cars.size < this.cap && this.spawnCredit >= 1 && attempts++ < 8) {
            this.spawnCredit -= 1;
            if (!this.spawn(game, center)) break;
        }
    }

    poses() {
        return [...this.cars.values()].map(car => {
            const outgoing = car.arc && car.arc.at > car.arc.length / 2 ? car.arc.next : null;
            return { id: car.id, wx: car.pose.x, wy: car.pose.y, angle: Math.atan2(car.pose.dir[0], -car.pose.dir[1]),
                lateral: 0, pose_space: "world", edge: outgoing?.edge.id || car.edge.id,
                reverse: outgoing ? outgoing.reverse : car.reverse, w: 50, h: 92, color: car.color,
                speed: car.speed, braking: car.braking, alpha: 1, collidable: true };
        });
    }
}
