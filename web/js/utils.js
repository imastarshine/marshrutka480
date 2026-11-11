// Маршрутка — общие утилиты и рисование примитивов
"use strict";

// ---------- утилиты ----------
const canvas = document.getElementById("game");
const screenCtx = canvas.getContext("2d");
// мир рисуется во внеэкранный холст, потом переносится полосками со сдвигом — так дорога изгибается
const worldCanvas = document.createElement("canvas");
worldCanvas.width = WIDTH + MARGIN * 2;
worldCanvas.height = HEIGHT;
const worldCtx = worldCanvas.getContext("2d");
let ctx = screenCtx;

// детерминированный генератор: застройка рисуется каждый кадр одинаково
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const smooth = (k) => k * k * (3 - 2 * k);

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

// --- дорога и карта города ---
function laneWidthFor(n) {
    return n === 2 ? 100 : n === 4 ? 90 : 74;
}

function roadWidthFor(n) {
    return n * laneWidthFor(n);
}

// base — сколько полос открыто в начале улицы (2/4/6)
function setRoad(base) {
    const n = 6;
    CLOSED = (n - base) / 2;
    LANES = n;
    LANE_W = laneWidthFor(n);
    ROAD_LEFT = Math.round(300 - (n * LANE_W) / 2);
    ROAD_RIGHT = ROAD_LEFT + n * LANE_W;
}

const ownFirst = () => LANES / 2;                  // первая полоса нашего направления
const roadMiddle = () => ROAD_LEFT + (LANES / 2) * LANE_W;   // двойная сплошная

function hash(a, b, c) {
    let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function approach(value, target, step) {
    if (Math.abs(target - value) <= step) return target;
    return value + (target > value ? step : -step);
}

// Общие узлы графа задают связи, geometry сохраняет все точки дороги между
// перекрёстками. Длины, остановки, движение и миникарта используют эту ломаную.
class CityGraph {
    constructor(data) {
        this.data = data;
        this.nodes = new Map(data.nodes.map((node, index) => [node.id, { ...node, index }]));
        this.edges = new Map();
        this.spatialCells = new Map();
        this.spatialWideEdges = [];
        this.spatialCellSize = 250 / (data.metersPerUnit || METERS_PER_PX);
        this.adjacent = new Map(data.nodes.map((node) => [node.id, []]));
        this.turnRuleIndex = new Map();
        for (const rule of data.restrictions || []) {
            if (!this.turnRuleIndex.has(rule.from)) this.turnRuleIndex.set(rule.from, new Map());
            const byNode = this.turnRuleIndex.get(rule.from);
            if (!byNode.has(rule.via)) byNode.set(rule.via, []);
            byNode.get(rule.via).push(rule);
        }
        data.edges.forEach((source, index) => {
            const from = this.nodes.get(source.from), to = this.nodes.get(source.to);
            if (!from || !to) throw new Error(`Неизвестный узел улицы ${source.id}`);
            const geometry = source.geometry?.length >= 2
                ? source.geometry.map((point) => Array.isArray(point) ? [...point] : [point.x, point.y])
                : [[from.x, from.y], [to.x, to.y]];
            if (geometry.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
                throw new Error(`Некорректная геометрия улицы ${source.id}`);
            }
            if (Math.hypot(geometry[0][0] - from.x, geometry[0][1] - from.y) > 0.01 ||
                Math.hypot(geometry.at(-1)[0] - to.x, geometry.at(-1)[1] - to.y) > 0.01) {
                throw new Error(`Геометрия не совпадает с узлами улицы ${source.id}`);
            }
            const distances = [0];
            for (let point = 1; point < geometry.length; point++) {
                distances.push(distances.at(-1) + Math.hypot(geometry[point][0] - geometry[point - 1][0],
                    geometry[point][1] - geometry[point - 1][1]));
            }
            const length = distances.at(-1);
            if (length < 0.001) throw new Error(`Нулевая длина улицы ${source.id}`);
            const bounds = geometry.reduce((box, point) => ({ minX: Math.min(box.minX, point[0]), maxX: Math.max(box.maxX, point[0]),
                minY: Math.min(box.minY, point[1]), maxY: Math.max(box.maxY, point[1]) }),
                { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
            const edge = { lanes: 4, ...source, index, length, geometry, distances, bounds,
                vector: [(to.x - from.x) / length, (to.y - from.y) / length] };
            this.edges.set(edge.id, edge);
            this.adjacent.get(edge.from).push(edge);
            this.adjacent.get(edge.to).push(edge);
            const box = edge.bounds, size = this.spatialCellSize;
            const x0 = Math.floor(box.minX / size), x1 = Math.floor(box.maxX / size);
            const y0 = Math.floor(box.minY / size), y1 = Math.floor(box.maxY / size);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 1024) this.spatialWideEdges.push(edge);
            else for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                const key = `${x}:${y}`;
                if (!this.spatialCells.has(key)) this.spatialCells.set(key, []);
                this.spatialCells.get(key).push(edge);
            }
        });
    }

    nearbyEdges(x, y, radius) {
        const size = this.spatialCellSize, result = new Set(this.spatialWideEdges);
        for (let cx = Math.floor((x - radius) / size); cx <= Math.floor((x + radius) / size); cx++) {
            for (let cy = Math.floor((y - radius) / size); cy <= Math.floor((y + radius) / size); cy++) {
                for (const edge of this.spatialCells.get(`${cx}:${cy}`) || []) result.add(edge);
            }
        }
        return result;
    }

    endpoint(edge, reverse) { return reverse ? edge.from : edge.to; }
    origin(edge, reverse) { return reverse ? edge.to : edge.from; }
    segment(edge, offset) {
        offset = clamp(offset, 0, edge.length);
        let lo = 0, hi = edge.distances.length - 1;
        while (lo + 1 < hi) {
            const middle = (lo + hi) >> 1;
            if (edge.distances[middle] <= offset) lo = middle;
            else hi = middle;
        }
        while (lo > 0 && edge.distances[lo + 1] === edge.distances[lo]) lo--;
        return lo;
    }
    direction(edge, reverse, offset = reverse ? edge.length : 0) {
        const index = this.segment(edge, reverse ? Math.max(0, offset - 1e-7) : offset);
        const a = edge.geometry[index], b = edge.geometry[index + 1];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const sign = reverse ? -1 : 1;
        return length ? [(b[0] - a[0]) / length * sign, (b[1] - a[1]) / length * sign] : [0, -sign];
    }
    fromNode(edge, node) {
        return { edge, reverse: edge.from === edge.to ? !this.canTraverse(edge, false) : edge.to === node };
    }
    outgoingFrom(node) {
        const choices = [], seen = new Set();
        for (const edge of this.adjacent.get(node) || []) {
            const directions = edge.from === edge.to ? [false, true] : [edge.to === node];
            for (const reverse of directions) {
                const key = `${edge.id}:${reverse}`;
                if (!seen.has(key) && this.canTraverse(edge, reverse)) {
                    seen.add(key);
                    choices.push({ edge, reverse });
                }
            }
        }
        return choices;
    }
    canTraverse(edge, reverse) {
        const oneway = edge.oneway;
        if (edge.busOneway !== undefined) return edge.busOneway === 0 || (edge.busOneway === -1) === reverse;
        if (oneway === true || oneway === 1 || oneway === "yes" || oneway === "1") return !reverse;
        if (oneway === -1 || oneway === "-1") return reverse;
        return true;
    }
    canTurn(from, via, to, reverse) {
        if ((from.from !== via && from.to !== via) || this.origin(to, reverse) !== via) return false;
        if (!this.canTraverse(to, reverse)) return false;
        const rules = this.turnRuleIndex.get(from.id)?.get(via) || [];
        if (rules.some((rule) => rule.only) && !rules.some((rule) => rule.only && rule.to === to.id)) return false;
        return !rules.some((rule) => !rule.only && rule.to === to.id);
    }
    position(edge, offset) {
        offset = clamp(offset, 0, edge.length);
        const index = this.segment(edge, offset), a = edge.geometry[index], b = edge.geometry[index + 1];
        const length = edge.distances[index + 1] - edge.distances[index];
        const t = length ? (offset - edge.distances[index]) / length : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    project(edge, x, y) {
        let best = { offset: 0, distance: Infinity, point: edge.geometry[0] };
        for (let index = 1; index < edge.geometry.length; index++) {
            const a = edge.geometry[index - 1], b = edge.geometry[index];
            const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
            const t = length2 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / length2, 0, 1) : 0;
            const point = [a[0] + dx * t, a[1] + dy * t], distance = Math.hypot(x - point[0], y - point[1]);
            if (distance < best.distance) best = { offset: edge.distances[index - 1] + Math.sqrt(length2) * t, distance, point };
        }
        return best;
    }

    itinerary(number) {
        const route = this.data.routes[number];
        if (!route?.path?.length) throw new Error(`Нет схемы маршрута ${number}`);
        let previous = null;
        const outward = route.path.map((item) => {
            const spec = typeof item === "string" ? { edge: item } : item;
            const edge = this.edges.get(spec.edge);
            if (!edge) throw new Error(`Неизвестный участок маршрута ${number}: ${spec.edge}`);
            const reverse = spec.reverse ?? (previous !== null && edge.to === previous);
            if (!this.canTraverse(edge, reverse)) throw new Error(`Маршрут ${number} против движения: ${edge.id}`);
            if (previous !== null && this.origin(edge, reverse) !== previous) {
                throw new Error(`Разрыв маршрута ${number}: ${edge.id}`);
            }
            previous = this.endpoint(edge, reverse);
            return { edge, reverse };
        });
        const returning = route.loop ? [] : route.returnPath?.length ? route.returnPath.map((item) => {
            const spec = typeof item === "string" ? { edge: item } : item;
            const edge = this.edges.get(spec.edge);
            if (!edge) throw new Error(`Неизвестный обратный участок маршрута ${number}: ${spec.edge}`);
            const reverse = spec.reverse ?? edge.to === previous;
            if (!this.canTraverse(edge, reverse)) throw new Error(`Обратный маршрут ${number} против движения: ${edge.id}`);
            if (this.origin(edge, reverse) !== previous) throw new Error(`Разрыв обратного маршрута ${number}`);
            previous = this.endpoint(edge, reverse);
            return { edge, reverse };
        }) : [...outward].reverse().map((leg) => ({ edge: leg.edge, reverse: !leg.reverse }));
        let sequence = 0;
        const used = new Set();
        const attach = (legs, stops, mirrored = false, stage = "out") => legs.map((leg, legIndex) => {
            const pathIndex = mirrored ? outward.length - 1 - legIndex : legIndex;
            const list = stops.filter((stop, index) => !used.has(`${stage}:${index}`) &&
                (stop.pathIndex === undefined || stop.pathIndex === pathIndex) && stop.edge === leg.edge.id &&
                (mirrored ? !(stop.reverse ?? false) : (stop.reverse ?? false)) === leg.reverse)
                .sort((a, b) => {
                    const aOffset = a.offset ?? a.at * leg.edge.length, bOffset = b.offset ?? b.at * leg.edge.length;
                    return leg.reverse ? bOffset - aOffset : aOffset - bOffset;
                })
                .map((stop) => {
                    used.add(`${stage}:${stops.indexOf(stop)}`);
                    const at = stop.offset !== undefined ? stop.offset / leg.edge.length : stop.at;
                    if (!Number.isFinite(at) || at < 0 || at > 1) throw new Error(`Остановка вне дороги: ${stop.name}`);
                    return { ...stop, at, sequence: sequence++ };
                });
            return { ...leg, stops: list };
        });
        const legs = [...attach(outward, route.stops || []),
            ...attach(returning, route.returnStops || route.stops || [], !route.returnStops, "return")];
        const expectedStops = (route.stops || []).length +
            (route.loop ? 0 : (route.returnStops || route.stops || []).length);
        if (sequence !== expectedStops) throw new Error(`Остановки не совпадают с путём маршрута ${number}`);
        for (let index = 0; index < legs.length; index++) {
            const leg = legs[index];
            if (!this.canTraverse(leg.edge, leg.reverse)) throw new Error(`Маршрут ${number} против движения: ${leg.edge.id}`);
            if (index) {
                const previous = legs[index - 1], via = this.origin(leg.edge, leg.reverse);
                if (!this.canTurn(previous.edge, via, leg.edge, leg.reverse)) {
                    throw new Error(`Запрещённый поворот маршрута ${number}: ${previous.edge.id} → ${leg.edge.id}`);
                }
            }
        }
        if (this.data.metadata?.source === "OpenStreetMap") {
            const first = legs[0], last = legs.at(-1), via = this.endpoint(last.edge, last.reverse);
            if (via !== this.origin(first.edge, first.reverse) || !this.canTurn(last.edge, via, first.edge, first.reverse)) {
                throw new Error(`Рейс маршрута ${number} не замыкается по разрешённым дорогам`);
            }
        }
        return { legs, stopCount: sequence };
    }
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

function rotatedHit(first, firstAngle, second, secondAngle) {
    const a = [Math.cos(firstAngle), Math.sin(firstAngle)], b = [Math.cos(secondAngle), Math.sin(secondAngle)];
    const dx = second.x + second.w / 2 - first.x - first.w / 2;
    const dy = second.y + second.h / 2 - first.y - first.h / 2;
    for (const axis of [a, [-a[1], a[0]], b, [-b[1], b[0]]]) {
        const ar = first.w / 2 * Math.abs(axis[0] * a[0] + axis[1] * a[1]) + first.h / 2 * Math.abs(-axis[0] * a[1] + axis[1] * a[0]);
        const br = second.w / 2 * Math.abs(axis[0] * b[0] + axis[1] * b[1]) + second.h / 2 * Math.abs(-axis[0] * b[1] + axis[1] * b[0]);
        if (Math.abs(dx * axis[0] + dy * axis[1]) >= ar + br) return false;
    }
    return true;
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
    const data = { wallet: 0, best: 0, rep: 50, story: 0, storySeen: -1, upgrades: {}, buses: ["gazel"], bus: "gazel", routes: ["480"], route: "480" };
    try {
        Object.assign(data, JSON.parse(localStorage.getItem(SAVE_KEY)) || {});
    } catch (e) { /* нет сохранения — начинаем с нуля */ }
    const replacedRoutes = { "10": "80", "112": "33" };
    const migrateRoute = (number) => replacedRoutes[String(number)] || String(number);
    data.routes = [...new Set(["480", ...(Array.isArray(data.routes) ? data.routes : []).map(migrateRoute)])]
        .filter((number) => ROUTES.some((route) => route.num === number));
    data.route = migrateRoute(data.route);
    if (!data.routes.includes(data.route)) data.route = "480";
    return data;
}

function ellipse(x, y, rx, ry, c, a = 1) {
    ctx.fillStyle = col(c, a);
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
    ctx.fill();
}

function tree(x, y, r, dark = false) {
    circle(x + 3, y + 4, r, [30, 50, 25], 0.5);
    circle(x, y, r, dark ? [35, 85, 40] : [45, 110, 45]);
    circle(x - r * 0.3, y - r * 0.3, r * 0.5, dark ? [55, 115, 55] : [75, 150, 65]);
}

function panel(x, y, w, h, alpha = 0.72, border = null) {
    fillRect(x, y, w, h, [12, 14, 20], alpha, 10);
    strokeRect(x + 0.5, y + 0.5, w - 1, h - 1, border || [255, 255, 255], 1, 10, border ? 0.9 : 0.12);
}

function writeSave(data) {
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) { /* приватный режим — просто не сохраняем */ }
}

// звук гудка: два «рычащих» тона; аудио создаётся при первом нажатии (так требуют браузеры)
let audioCtx = null;
function hornSound() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const t = audioCtx.currentTime, gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        gain.gain.setValueAtTime(0.18, t + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
        gain.connect(audioCtx.destination);
        for (const f of [392, 494]) {
            const osc = audioCtx.createOscillator();
            osc.type = "sawtooth";
            osc.frequency.value = f;
            osc.connect(gain);
            osc.start(t);
            osc.stop(t + 0.45);
        }
    } catch (e) { /* без звука — не страшно */ }
}

// минуты от полуночи -> "ЧЧ:ММ"
function hhmm(mins) {
    mins = Math.floor(mins);
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// пробег: до километра — в метрах, дальше — в км
function formatDistance(px) {
    const m = px * METERS_PER_PX;
    return m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(2)} км`;
}
