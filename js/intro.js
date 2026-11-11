// Маршрутка — заставка при запуске: нарисованные карточки-панели с крупными надписями
"use strict";

const INTRO_CARD = 150;        // кадров на карточку
const INTRO_FADE = 20;

function outlined(str, x, y, size, fill, angle = 0) {
    // крупная надпись с толстой обводкой
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = size / 6;
    ctx.strokeStyle = "#111";
    ctx.strokeText(str, 0, 0);
    ctx.fillStyle = col(fill);
    ctx.fillText(str, 0, 0);
    ctx.restore();
}

function halftone(x, y, w, h, c, a = 0.18) {
    for (let yy = y; yy < y + h; yy += 12) {
        for (let xx = x + ((yy / 12) % 2) * 6; xx < x + w; xx += 12) circle(xx, yy, 2.4, c, a);
    }
}

// панели: фон + рисунок; t — 0..1 внутри карточки (для медленного наезда камеры)
const INTRO_PANELS = [
    {
        title: "6:58 УТРА", sub: "Город ещё спит",
        bg: [[255, 170, 80], [120, 60, 120]],
        art(t) {
            circle(WIDTH * 0.7, 300, 90, [255, 220, 120]);
            for (let i = 0; i < 9; i++) {                       // силуэты домов
                const w = 50 + ((i * 37) % 40), h = 120 + ((i * 53) % 160), x = i * 75 - 20;
                fillRect(x, 520 - h, w, h + 200, [50, 30, 70]);
                for (let k = 0; k < 6; k++) if ((i + k) % 3) fillRect(x + 10 + (k % 2) * 20, 540 - h + Math.floor(k / 2) * 30, 8, 12, [255, 210, 120], 0.8);
            }
            fillRect(0, 520, WIDTH, 300, [40, 40, 50]);
            for (let x = -40 + ((t * 300) % 80); x < WIDTH; x += 80) fillRect(x, 600, 40, 8, [230, 230, 230]);
        },
    },
    {
        title: "СТАРАЯ ГАЗЕЛЬ", sub: "Заводится с третьего раза",
        bg: [[245, 200, 30], [200, 110, 20]],
        art(t) {
            halftone(0, 0, WIDTH, HEIGHT, [120, 60, 0], 0.25);
            ctx.save();
            ctx.translate(WIDTH / 2, 420);
            ctx.rotate(-0.12);
            ctx.scale(2.6 + t * 0.3, 2.6 + t * 0.3);
            fillRect(-58, -34, 116, 60, [245, 200, 30], 1, 10);       // маршрутка сбоку
            strokeRect(-58, -34, 116, 60, BLACK, 3, 10);
            for (let i = 0; i < 4; i++) fillRect(-48 + i * 24, -26, 18, 18, GLASS, 1, 3);
            fillRect(42, -26, 14, 24, GLASS, 1, 3);
            circle(-34, 28, 11, BLACK);
            circle(34, 28, 11, BLACK);
            circle(-34, 28, 4, [160, 160, 160]);
            circle(34, 28, 4, [160, 160, 160]);
            text("480", -10, 8, BLACK, 14, { bold: true, align: "center", base: "middle" });
            ctx.restore();
            for (let i = 0; i < 6; i++) circle(150 - i * 22 - t * 60, 470 + Math.sin(i + t * 6) * 8, 10 + i * 3, [90, 90, 90], 0.5 - i * 0.07);
        },
    },
    {
        title: "ДПС НЕ ДРЕМЛЕТ", sub: "Каждое нарушение — звезда",
        bg: [[20, 30, 80], [10, 10, 30]],
        art(t) {
            const on = Math.floor(t * 20) % 2;
            circle(WIDTH * 0.3, 360, 220, on ? [255, 40, 40] : [60, 120, 255], 0.25);
            circle(WIDTH * 0.7, 360, 220, on ? [60, 120, 255] : [255, 40, 40], 0.25);
            ctx.save();
            ctx.translate(WIDTH / 2, 380);
            ctx.scale(2.2 + t * 0.4, 2.2 + t * 0.4);
            fillRect(-50, -26, 100, 52, [235, 235, 240], 1, 10);
            fillRect(-50, -2, 100, 12, [30, 70, 170]);
            fillRect(-30, -38, 26, 10, on ? [255, 40, 40] : [110, 30, 30], 1, 3);
            fillRect(4, -38, 26, 10, !on ? [60, 120, 255] : [30, 40, 110], 1, 3);
            text("ДПС", 0, 4, WHITE, 11, { bold: true, align: "center", base: "middle" });
            ctx.restore();
            for (let i = 0; i < MAX_STARS; i++) outlined("★", WIDTH / 2 - 120 + i * 60, 560, 46, i < 1 + Math.floor(t * 5) ? [255, 210, 40] : [70, 72, 84]);
        },
    },
    {
        title: "МАРШРУТКА", sub: "Развози людей. Не нарушай. Почти.",
        bg: [[60, 160, 90], [20, 70, 50]],
        art(t, game) {
            halftone(0, 0, WIDTH, HEIGHT, [0, 40, 20], 0.3);
            ctx.save();
            ctx.translate(WIDTH / 2, 400);
            ctx.scale(1 + t * 0.15, 1 + t * 0.15);
            fillRect(-110, -80, 220, 160, YELLOW, 1, 18);
            strokeRect(-110, -80, 220, 160, BLACK, 6, 18);
            outlined(game.save.route, 0, 6, 96, [20, 20, 20]);
            ctx.restore();
        },
    },
];

function drawIntro(game) {
    const total = INTRO_PANELS.length * INTRO_CARD;
    const f = Math.min(game.introT, total - 1);
    const idx = Math.floor(f / INTRO_CARD), t = (f % INTRO_CARD) / INTRO_CARD;
    const p = INTRO_PANELS[idx];
    const g = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    g.addColorStop(0, col(p.bg[0]));
    g.addColorStop(1, col(p.bg[1]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.save();
    // медленный наезд камеры
    const z = 1 + t * 0.06;
    ctx.translate(WIDTH / 2, HEIGHT / 2);
    ctx.scale(z, z);
    ctx.translate(-WIDTH / 2, -HEIGHT / 2);
    p.art(t, game);
    ctx.restore();
    // рамка панели и надписи: заголовок въезжает сбоку
    strokeRect(14, 14, WIDTH - 28, HEIGHT - 28, BLACK, 10, 6);
    const slide = (1 - smooth(Math.min(1, t * 4))) * 400;
    outlined(p.title, WIDTH / 2 - slide, 130, p.title.length > 10 ? 52 : 64, WHITE, -0.05);
    outlined(p.sub, WIDTH / 2 + slide, 200, 22, [255, 230, 120], -0.05);
    text("любая клавиша или клик — пропустить", WIDTH / 2, HEIGHT - 40, WHITE, 13, { align: "center", base: "middle", alpha: 0.7 });
    // переход между карточками через затемнение
    const edge = Math.min(f % INTRO_CARD, INTRO_CARD - (f % INTRO_CARD));
    if (edge < INTRO_FADE) fillRect(0, 0, WIDTH, HEIGHT, BLACK, 1 - edge / INTRO_FADE);
    return game.introT >= total;
}
