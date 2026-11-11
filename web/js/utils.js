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

// Конечный граф Иркутска. Координаты схематические, связи — конкретные улицы:
// название, ширина, остановки и миникарта используют одни и те же рёбра.
class CityGraph {
    constructor(data) {
        this.data = data;
        this.nodes = new Map(data.nodes.map((node, index) => [node.id, { ...node, index }]));
        this.edges = new Map();
        this.adjacent = new Map(data.nodes.map((node) => [node.id, []]));
        data.edges.forEach((source, index) => {
            const from = this.nodes.get(source.from), to = this.nodes.get(source.to);
            if (!from || !to) throw new Error(`Неизвестный узел улицы ${source.id}`);
            const length = Math.hypot(to.x - from.x, to.y - from.y);
            if (length < 1) throw new Error(`Нулевая длина улицы ${source.id}`);
            const edge = { lanes: 4, ...source, index, length,
                vector: [(to.x - from.x) / length, (to.y - from.y) / length] };
            this.edges.set(edge.id, edge);
            this.adjacent.get(edge.from).push(edge);
            this.adjacent.get(edge.to).push(edge);
        });
    }

    endpoint(edge, reverse) { return reverse ? edge.from : edge.to; }
    origin(edge, reverse) { return reverse ? edge.to : edge.from; }
    direction(edge, reverse) { return edge.vector.map((v) => reverse ? -v : v); }
    fromNode(edge, node) { return { edge, reverse: edge.to === node }; }
    position(edge, offset) {
        const from = this.nodes.get(edge.from);
        return [from.x + edge.vector[0] * offset, from.y + edge.vector[1] * offset];
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
            if (this.origin(edge, reverse) !== previous) throw new Error(`Разрыв обратного маршрута ${number}`);
            previous = this.endpoint(edge, reverse);
            return { edge, reverse };
        }) : [...outward].reverse().map((leg) => ({ edge: leg.edge, reverse: !leg.reverse }));
        let sequence = 0;
        const used = new Set();
        const attach = (legs, stops, mirrored = false, stage = "out") => legs.map((leg) => {
            const list = stops.filter((stop, index) => !used.has(`${stage}:${index}`) &&
                stop.edge === leg.edge.id && (mirrored ? !(stop.reverse ?? false) : (stop.reverse ?? false)) === leg.reverse)
                .sort((a, b) => leg.reverse ? b.at - a.at : a.at - b.at)
                .map((stop) => {
                    used.add(`${stage}:${stops.indexOf(stop)}`);
                    return { ...stop, at: clamp(stop.at, 0.08, 0.92), sequence: sequence++ };
                });
            return { ...leg, stops: list };
        });
        const legs = [...attach(outward, route.stops || []),
            ...attach(returning, route.returnStops || route.stops || [], !route.returnStops, "return")];
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
    const replacedRoutes = { "83": "80", "10": "80", "112": "33" };
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
