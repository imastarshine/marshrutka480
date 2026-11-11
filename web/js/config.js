// Маршрутка — настройки: константы, улучшения, автопарк, маршруты, районы.
//
// Код разбит на обычные <script> (без сборки, работает и через file://). Порядок подключения
// в index.html важен: config → utils → effects → scenery → vehicles → world → game → update → render → lobby → main.

"use strict";

// ---------- настройки ----------
const WIDTH = 640, HEIGHT = 760;
const GAME_VERSION = "2.2.0-beta.4";
const HUD_H = 70;

// дорога зависит от улицы: 2, 4 или 6 полос (левая половина — встречка); меняет setRoad()
let LANES = 4, LANE_W = 90, ROAD_LEFT = 120, ROAD_RIGHT = 480;
// дорога физически всегда на 6 полос (по 3 в каждую сторону); открыто от 1 до 3 на сторону, остальное —
// парковка и бульвар. CLOSED — сколько полос на сторону закрыто в начале улицы; дальше ширину меняют LaneShift
let CLOSED = 0;
const BAY_W = 64;              // ширина кармана остановки справа от дороги

const CAR_W = 50, CAR_H = 92;

const MAX_SPEED = 13, MAX_REVERSE = 4;
const ACCEL = 0.13, BRAKE = 0.4, FRICTION = 0.03, STEER_SPEED = 4.5;
const KMH = 7;                 // пикселей/кадр -> км/ч на спидометре
const METERS_PER_PX = KMH / 3.6 / 60;   // пробег согласован со спидометром: 60 км/ч = 1 км за минуту езды

const COMPLAINT_FINE = 20, POLICE_FINE = 500, WRONG_STOP_FINE = 150, PED_FINE = 300;
const MAX_COMPLAINTS = 10, SPEED_LIMIT = 70;
const SHIFT_START = 7 * 60, SHIFT_END = 19 * 60, FRAMES_PER_MIN = 360;  // смена 7:00–19:00: 72 реальных минуты для настоящих расстояний
const REPAIR_COST = 300;
// репутация водителя 0..100 копится между рейсами: звания и что она даёт
const REP_TITLES = [[80, "Легенда района"], [60, "Уважаемый"], [40, "Обычный водитель"], [20, "Лихач"], [0, "Позор маршрута"]];
const repTitle = (r) => REP_TITLES.find(([min]) => r >= min)[1];
// розыск: звёзды гаснут по одной за STAR_DECAY кадров, если не нарушаешь и ДПС не на хвосте
const MAX_STARS = 5, STAR_DECAY = 60 * 12, POLICE_RETURN = 60 * 14;
// поймали: взятка (дешевле штрафа, но инспектор может оказаться честным) или отдел (штраф и потеря времени)
const BRIBE_RATE = 0.6, HONEST_COP = 0.2, STATION_MINUTES = 90;
const ESCORT_FRAMES = 160, STATION_CARD = 220;   // конвой за машиной ДПС, затем сцена в отделе

const BLOCK = 3000;            // масштаб миникарты в игровых пикселях
const GREEN_T = 300, YELLOW_T = 70, RED_T = 280;
const CYCLE = GREEN_T + YELLOW_T + RED_T;
const COMBO_TIME = 240;
const MAX_COMBO = 5;
const SLALOM_COOLDOWN = 300;
const TURN_RADIUS = 90;
const MARGIN = 120;            // мир рисуется шире экрана — дорога изгибается
const BUS_BOTTOM = HEIGHT - 74;
const SAVE_KEY = "marshrutka480";

// улучшения: ключ, название, описание, цены по уровням
const UPGRADES = [
    ["engine", "Мотор", "+скорость и разгон", [300, 700, 1500]],
    ["brakes", "Тормоза", "тормозит резче", [200, 500, 1000]],
    ["steer", "Руль", "быстрее перестраивается", [200, 500, 1000]],
    ["seats", "Салон", "+3 места", [400, 900, 1800]],
    ["fare", "Тариф", "+10 руб. за проезд", [500, 1200, 2500]],
    ["cashbox", "Касса", "быстрее посадка, +1 человек за раз", [600, 1500, 3000]],
    ["airbag", "Подушка", "переживёт 1 аварию за рейс", [800, 2000, 4000]],
    ["blat", "Блат в ДПС", "штраф меньше, погоня короче", [400, 900, 1800]],
];

// автопарк: размеры, вместимость, скорость, сколько людей садится одновременно (двери)
const BUS_MODELS = [
    { key: "gazel", name: "ГАЗель", price: 0, w: 56, h: 116, cap: 15, speed: 13, accel: 1, doors: 1, fare: 0,
        color: [245, 200, 30], stripe: null, desc: "Старая добрая. 15 мест, 1 дверь" },
    { key: "transit", name: "Транзит", price: 3000, w: 58, h: 126, cap: 19, speed: 14, accel: 1.12, doors: 1, fare: 10,
        color: [240, 240, 236], stripe: [40, 90, 200], desc: "19 мест, быстрее, +10 руб. за комфорт" },
    { key: "paz", name: "ПАЗик", price: 5500, w: 64, h: 150, cap: 30, speed: 11.5, accel: 0.82, doors: 2, fare: 0,
        color: [235, 130, 40], stripe: [250, 240, 220], desc: "30 мест, 2 двери — садятся по двое" },
    { key: "sprinter", name: "Спринтер", price: 8000, w: 58, h: 134, cap: 22, speed: 15.5, accel: 1.3, doors: 2, fare: 20,
        color: [205, 215, 228], stripe: [200, 40, 40], desc: "22 места, 2 двери, самый быстрый" },
    { key: "liaz", name: "ЛиАЗ", price: 14000, w: 66, h: 178, cap: 45, speed: 11, accel: 0.72, doors: 3, fare: 0,
        color: [50, 150, 90], stripe: [235, 235, 235], desc: "45 мест, 3 двери — касса не успевает" },
];

// Реальные линии Иркутска; тарифы и цены открытия — игровая экономика.
// География, связанные улицы и остановки каждого направления — в city.js.
const ROUTES = [
    { num: "480", price: 0, fare: 60, traffic: 1, wait: [1, 7], stopGap: [1600, 2600], post: 1,
        districts: ["center", "khrush", "park", "market"], desc: "Аэропорт — Луговое" },
    { num: "80", price: 2500, fare: 70, traffic: 1.2, wait: [2, 9], stopGap: [1700, 2800], post: 0.8,
        districts: ["center", "khrush", "river", "market"], desc: "Областная больница · кольцевой" },
    { num: "33", price: 4000, fare: 85, traffic: 0.7, wait: [1, 6], stopGap: [2200, 3400], post: 0.7,
        districts: ["private", "industrial", "river", "center"], desc: "Батарейная — Центральный рынок" },
    { num: "83", price: 3000, fare: 70, traffic: 1.1, wait: [2, 8], stopGap: [1600, 2600], post: 0.8,
        districts: ["khrush", "river", "center", "market"], desc: "Радужный — Центральный рынок" },
    { num: "90", price: 4500, fare: 80, traffic: 1.2, wait: [2, 9], stopGap: [1800, 2800], post: 0.8,
        districts: ["center", "river", "khrush", "park"], desc: "Аэропорт · кольцевой через ГЭС" },
    { num: "Т4", price: 3500, fare: 65, traffic: 1, wait: [2, 8], stopGap: [1600, 2600], post: 0.7,
        districts: ["center", "old", "khrush"], desc: "Сквер Кирова — Аэропорт" },
];

// районы города: из каких кусков застройки состоят
const DISTRICTS = {
    center: { name: "Центр", kinds: ["tower", "office", "plaza", "tower", "lot"], ground: [100, 100, 104], bridge: 0.1 },
    khrush: { name: "Спальный район", kinds: ["panel", "panel", "yard", "garages", "panel"], ground: [88, 118, 78], bridge: 0.15 },
    park: { name: "Парк", kinds: ["park", "park", "hill", "forest", "pond"], ground: [78, 135, 68], bridge: 0.3 },
    market: { name: "Рынок", kinds: ["market", "market", "oldhouse", "lot"], ground: [150, 140, 120], bridge: 0.05 },
    old: { name: "Старый город", kinds: ["oldhouse", "church", "oldhouse", "plaza"], ground: [130, 115, 100], bridge: 0.2 },
    industrial: { name: "Промзона", kinds: ["factory", "factory", "containers", "garages"], ground: [118, 115, 105], bridge: 0.25 },
    garages: { name: "Гаражи", kinds: ["garages", "garages", "lot", "forest"], ground: [120, 118, 100], bridge: 0.1 },
    river: { name: "Набережная", kinds: ["park", "hill", "forest", "yard"], ground: [80, 128, 72], bridge: 0.8 },
    private: { name: "Частный сектор", kinds: ["house", "house", "house", "field", "forest"], ground: [92, 140, 70], bridge: 0.2 },
    outskirts: { name: "Окраина", kinds: ["field", "forest", "hill", "field", "house"], ground: [110, 145, 70], bridge: 0.35 },
};

// Резервные подписи для сюжетных объектов; маршрутные остановки берутся из графа.
const STOP_NAMES = ["Центральный рынок", "Театр кукол", "Технический университет",
    "Жуковского", "Свердловский рынок", "Аэропорт", "Курорт Ангара", "Луговое"];
const OTHER_ROUTES = ["3", "7к", "18", "40", "67", "80", "83", "90", "480", "33", "Т4"];

const CAR_COLORS = [
    [200, 40, 40], [40, 90, 200], [30, 140, 60], [120, 120, 130],
    [230, 230, 230], [35, 35, 40], [150, 60, 160], [220, 120, 30],
];
const PEOPLE_COLORS = [
    [60, 80, 160], [170, 50, 60], [50, 130, 80], [200, 150, 40],
    [110, 70, 150], [40, 140, 160], [90, 90, 90],
];

// цвета
const GROUND = [85, 90, 85];
const ASPHALT = [60, 60, 65];
const SIDEWALK = [170, 170, 160];
const WHITE = [240, 240, 240];
const YELLOW = [245, 200, 30];
const ORANGE = [255, 150, 30];
const BLACK = [15, 15, 15];
const GLASS = [120, 170, 210];
const HUD_BG = [25, 25, 30];
const GREEN = [110, 230, 110];
const RED = [255, 100, 90];
const BLUE = [140, 200, 255];
const PINK = [255, 120, 220];
const SKIN = [240, 200, 160];

const FONT = "Arial, Helvetica, sans-serif";
