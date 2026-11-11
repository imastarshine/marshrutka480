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

// координата k-й вертикальной (axis "x") или горизонтальной ("y") улицы: кварталы разной длины
function gridPos(axis, k) {
    return k * BLOCK + (hash(axis === "x" ? 1 : 2, k, 7) - 0.5) * BLOCK * 0.62;
}

function streetLanes(vertical, k) {
    if (vertical && k === 0) return 4;            // стартовая улица
    const r = hash(vertical ? 3 : 4, k, 11);
    return r < 0.3 ? 2 : r < 0.8 ? 4 : 6;
}

// есть ли кусок улицы между поперечными seg и seg+1. Проспекты (4–6 полос) непрерывны,
// а узкая улица может обрываться между двумя проспектами — получаются Т-перекрёстки и тупики
function segExists(vertical, k, seg) {
    if (streetLanes(vertical, k) >= 4) return true;
    if (streetLanes(!vertical, seg) < 4 || streetLanes(!vertical, seg + 1) < 4) return true;
    return hash(vertical ? 5 : 6, k, seg) < 0.5;
}

// узел (i — вертикальная улица, j — горизонтальная): есть ли улица в сторону [x, y]
function armExists(i, j, [x, y]) {
    if (y < 0) return segExists(true, i, j - 1);
    if (y > 0) return segExists(true, i, j);
    if (x > 0) return segExists(false, j, i);
    return segExists(false, j, i - 1);
}

function approach(value, target, step) {
    if (Math.abs(target - value) <= step) return target;
    return value + (target > value ? step : -step);
}

function streetName(vertical, k) {
    const names = vertical ? STREETS_V : STREETS_H;
    return names[mod(k, names.length)];
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
    const data = { wallet: 0, best: 0, rep: 50, upgrades: {}, buses: ["gazel"], bus: "gazel", routes: ["480"], route: "480" };
    try {
        Object.assign(data, JSON.parse(localStorage.getItem(SAVE_KEY)) || {});
    } catch (e) { /* нет сохранения — начинаем с нуля */ }
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

// пробег: до километра — в метрах, дальше — в км
function formatDistance(px) {
    const m = px * METERS_PER_PX;
    return m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(2)} км`;
}
