// Маршрутка — сюжет: главы с диалогами, цели в рейсе, прогресс в сохранении (save.story)
"use strict";

// персонажи: имя и как рисовать портрет
const CAST = {
    boss: { name: "Михалыч, хозяин автопарка", color: [255, 210, 80] },
    cop: { name: "Сержант Сидоренко", color: [120, 170, 255] },
    rival: { name: "Жора, «Экспресс-Плюс»", color: [255, 110, 100] },
    granny: { name: "Бабушка Зина", color: [150, 230, 150] },
};

// главы: intro — диалог перед рейсом, goal — цель, check — выполнена ли, progress — строка в HUD
const STORY = [
    {
        title: "Первый рейс",
        intro: [
            ["boss", "Ну здравствуй, новичок. Я Михалыч, это мой автопарк."],
            ["boss", "Вот тебе ГАЗель: старая, но живая. Маршрут 480."],
            ["boss", "Для начала обслужи 3 остановки. Заезжай в карман, открывай двери, собирай деньги."],
        ],
        goal: "Обслужи 3 остановки",
        check: (g) => g.stopsServed >= 3,
        progress: (g) => `${g.stopsServed}/3 остановок`,
        reward: 300,
    },
    {
        title: "Долг",
        intro: [
            ["boss", "Плохие новости: автопарк задолжал за аренду гаража."],
            ["boss", "Нужно 1500 ₽ за один рейс. Крутись!"],
        ],
        goal: "Заработай 1500 ₽ за рейс",
        check: (g) => g.money >= 1500,
        progress: (g) => `${Math.max(0, Math.round(g.money))}/1500 ₽`,
        reward: 500,
    },
    {
        title: "Инспектор",
        intro: [
            ["cop", "Сержант Сидоренко. Мне сказали, ты любишь погонять."],
            ["cop", "На моём районе — 70 км/ч. Проедешь мой пост без превышения — поговорим."],
        ],
        goal: "Проедь пост ДПС не быстрее 70 км/ч",
        check: (g) => g.storyFlags.radarOk,
        progress: () => "ищи пост ДПС",
        reward: 300,
    },
    {
        title: "Конкуренты",
        intro: [
            ["rival", "Слышь, 480-й. Эта линия теперь наша."],
            ["rival", "У «Экспресс-Плюса» маршрутки быстрее, а водители злее. Уходи по-хорошему."],
            ["boss", "Не слушай Жору. Докажи, что людям нужен 480-й: 6 остановок и меньше 3 жалоб."],
        ],
        goal: "Обслужи 6 остановок, жалоб меньше 3",
        check: (g) => g.stopsServed >= 6 && g.complaints < 3,
        progress: (g) => `${g.stopsServed}/6 остановок · жалоб ${g.complaints}`,
        reward: 600,
    },
    {
        title: "Кортеж",
        intro: [
            ["boss", "Сегодня в городе важные гости, будет перекрытие."],
            ["boss", "Не вздумай лезть: Жора только и ждёт, чтобы на нас настучать."],
        ],
        goal: "Дождись кортежа, не нарушая",
        start: (g) => { g.motorcadeAt = SHIFT_START + 50; },
        check: (g) => g.storyFlags.motorcadeOk,
        progress: (g) => (g.motorcadeAt ? `перекрытие около ${hhmm(g.motorcadeAt)}` : "стой и смотри"),
        reward: 500,
    },
    {
        title: "Подстава",
        intro: [
            ["rival", "Ну что, 480-й, как тебе ориентировка? Я позвонил куда надо."],
            ["cop", "На вашу маршрутку поступил сигнал. Всем постам — задержать!"],
            ["boss", "Это Жора тебя сдал! Не попадись, пока всё не уляжется."],
        ],
        goal: "Сбрось розыск и не попадись",
        start: (g) => { g.wanted = 2; g.spawnPolice(); },
        check: (g) => g.frame > 0 && g.stars === 0 && !g.storyFlags.caught && g.storyFlags.started > 120,
        progress: (g) => `розыск ${"★".repeat(g.stars) || "снят"}`,
        reward: 700,
    },
    {
        title: "Новая машина",
        intro: [
            ["boss", "Жора пересел на новенькие Спринтеры. На ГАЗели мы его не догоним."],
            ["boss", "Купи в «Автопарке» любую новую маршрутку — и поехали."],
        ],
        goal: "Купи новую маршрутку в Автопарке",
        check: (g) => g.save.buses.length > 1,
        progress: () => "лобби → Автопарк",
        reward: 1000,
    },
    {
        title: "Легенда района",
        intro: [
            ["granny", "Сынок, ты один нормально возишь. Весь район за тебя!"],
            ["boss", "Последний рывок: отработай смену до конца, и линия наша навсегда."],
        ],
        goal: "Отработай смену до 19:00",
        check: (g) => g.storyFlags.shiftDone,
        progress: (g) => `до конца смены ${hhmm(SHIFT_END - g.clock / FRAMES_PER_MIN)}`,
        reward: 1500,
        ending: [
            ["rival", "Ладно, 480-й... Твоя взяла. Линия ваша."],
            ["cop", "А ты, оказывается, нормальный водитель. Но превышать всё равно не советую."],
            ["boss", "Горжусь тобой. Теперь ты легенда района! Дальше — свободное плавание."],
        ],
    },
];

const storyChapter = (g) => STORY[g.save.story] || null;

// начало рейса: показать диалог главы (один раз), подготовить её условия
function storyStart(g) {
    g.storyFlags = { radarOk: false, motorcadeOk: false, caught: false, shiftDone: false, started: 0 };
    g.storyDone = false;
    const ch = storyChapter(g);
    if (!ch) return;
    if (ch.start) ch.start(g);
    if (g.save.storySeen < g.save.story) {
        g.save.storySeen = g.save.story;
        writeSave(g.save);
        openDialog(g, ch.intro, "play", `Глава ${g.save.story + 1}. ${ch.title}`);
    }
}

// каждый кадр в рейсе: выполнена ли цель главы
function storyCheck(g) {
    const ch = storyChapter(g);
    if (!ch || g.storyDone || !g.storyFlags) return;
    g.storyFlags.started += 1;
    if (!ch.check(g)) return;
    g.storyDone = true;
    const n = g.save.story + 1;
    g.save.story += 1;
    g.save.wallet += ch.reward;            // премия за главу — сразу в кошелёк
    writeSave(g.save);
    g.missionComplete(`ГЛАВА ${n} ПРОЙДЕНА!`, 0, 2);
    g.notice.money = ch.reward;
    if (ch.ending) g.pendingDialog = { lines: ch.ending, title: "Финал" };
}

function storyGoalText(g) {
    const ch = storyChapter(g);
    if (!ch || g.storyDone) return null;
    return `Глава ${g.save.story + 1}: ${ch.goal} — ${ch.progress(g)}`;
}

// --- диалоги ---
function openDialog(g, lines, then, title = "") {
    g.dialog = { lines, i: 0, then, title, t: 0 };
    g.state = "dialog";
}

function nextDialog(g) {
    const d = g.dialog;
    if (d.t < 8) return;                   // защита от случайного двойного нажатия
    if (d.t * 1.5 < d.lines[d.i][1].length) {   // фраза ещё печатается — сначала показать её целиком
        d.t = 1e4;
        return;
    }
    d.i += 1;
    d.t = 0;
    if (d.i < d.lines.length) return;
    g.dialog = null;
    g.state = d.then;
}

function wrapText(str, maxW, size) {
    const words = str.split(" "), lines = [];
    let cur = "";
    for (const w of words) {
        const next = cur ? `${cur} ${w}` : w;
        if (textWidth(next, size) > maxW && cur) {
            lines.push(cur);
            cur = w;
        } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
}

function drawPortrait(who, cx, cy, r) {
    circle(cx, cy, r + 6, [20, 22, 30]);
    circle(cx, cy, r, CAST[who].color, 0.35);
    const s = r / 50;
    ctx.save();
    ctx.translate(cx, cy + 6 * s);
    ctx.scale(s, s);
    fillRect(-34, 30, 68, 40, who === "cop" ? [50, 80, 60] : who === "rival" ? [30, 30, 36] : who === "granny" ? [120, 70, 110] : [70, 80, 110], 1, 14);
    circle(0, 0, 30, SKIN);                                   // лицо
    circle(-10, -4, 3.5, BLACK);
    circle(10, -4, 3.5, BLACK);
    if (who === "boss") {
        fillRect(-14, 8, 28, 7, [150, 150, 150], 1, 3);       // усы
        fillRect(-32, -30, 64, 14, [60, 60, 70], 1, 6);       // кепка
        fillRect(-36, -20, 50, 6, [50, 50, 60], 1, 3);
    } else if (who === "cop") {
        line(-8, 14, 8, 14, [120, 60, 50], 3);
        fillRect(-34, -34, 68, 16, [40, 70, 140], 1, 6);      // фуражка
        fillRect(-40, -22, 80, 6, [30, 30, 40], 1, 3);
        circle(0, -26, 5, [230, 190, 60]);
    } else if (who === "rival") {
        fillRect(-22, -10, 18, 10, BLACK, 1, 3);              // тёмные очки
        fillRect(4, -10, 18, 10, BLACK, 1, 3);
        line(-4, -6, 4, -6, BLACK, 3);
        fillRect(-28, -32, 56, 8, [50, 40, 30], 1, 4);        // ёжик
        line(-6, 14, 8, 12, [120, 60, 50], 3);                // ухмылка
        for (let i = -3; i <= 3; i++) circle(i * 6, 34 + Math.abs(i) * -1, 2.5, [230, 190, 60]);   // цепь
    } else {
        ctx.fillStyle = col([200, 50, 60]);                    // платок
        ctx.beginPath();
        ctx.arc(0, -4, 34, Math.PI * 1.05, Math.PI * 1.95);
        ctx.lineTo(24, 26);
        ctx.lineTo(-24, 26);
        ctx.closePath();
        ctx.fill();
        circle(0, 0, 24, SKIN);
        circle(-9, -2, 3, BLACK);
        circle(9, -2, 3, BLACK);
        for (const [x, y] of [[-20, -22], [0, -30], [20, -22]]) circle(x, y, 3, WHITE);
        line(-8, 12, 8, 12, [150, 70, 60], 3);
    }
    ctx.restore();
}

function drawDialog(g) {
    const d = g.dialog;
    const [who, str] = d.lines[d.i];
    fillRect(0, 0, WIDTH, HEIGHT, BLACK, 0.45);
    if (d.title) outlined(d.title, WIDTH / 2, 150, 38, [255, 210, 80]);
    const y = HEIGHT - 260, h = 230;
    panel(16, y, WIDTH - 32, h, 0.9, CAST[who].color);
    drawPortrait(who, 90, y + 90, 52);
    text(CAST[who].name, 165, y + 22, CAST[who].color, 18, { bold: true });
    const shown = str.slice(0, Math.floor(d.t * 1.5));          // текст печатается
    wrapText(shown, WIDTH - 210, 17).forEach((l, i) => text(l, 165, y + 56 + i * 26, WHITE, 17));
    text(`${d.i + 1}/${d.lines.length}   Enter, пробел или клик — дальше`, WIDTH - 36, y + h - 22, [170, 175, 190], 12, { align: "right" });
}
