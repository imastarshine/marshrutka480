// Маршрутка — запуск, кнопки, игровой цикл
"use strict";

// ---------- запуск ----------
const game = new Game();

window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    game.onKey(e.code, true);
});
window.addEventListener("keyup", (e) => game.onKey(e.code, false));
window.addEventListener("blur", () => Object.keys(game.keys).forEach((k) => (game.keys[k] = false)));
// кнопки для телефона: держишь — нажато, отпустил — отпущено
if (matchMedia("(pointer: coarse)").matches || "ontouchstart" in window || location.search.includes("touch")) {
    document.body.classList.add("touch");
}
document.querySelectorAll("[data-key]").forEach((btn) => {
    const set = (on) => (e) => {
        e.preventDefault();
        game.keys[btn.dataset.key] = on;
        btn.classList.toggle("on", on);
    };
    btn.addEventListener("pointerdown", set(true));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, set(false));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
});
const hornBtn = document.querySelector("[data-action=horn]");
hornBtn?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    hornBtn.classList.add("on");
    game.honk();
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) hornBtn?.addEventListener(ev, () => hornBtn.classList.remove("on"));
document.querySelector("[data-action=pause]")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    game.togglePause();
});
canvas.addEventListener("click", (e) => {
    const b = canvas.getBoundingClientRect();
    game.onClick(((e.clientX - b.left) * WIDTH) / b.width, ((e.clientY - b.top) * HEIGHT) / b.height);
});

// фиксированные 60 обновлений в секунду, даже на мониторах 120/144 Гц
const STEP = 1000 / 60;
let last = performance.now(), acc = 0;
function loop(now) {
    acc = Math.min(acc + (now - last), 250);
    last = now;
    while (acc >= STEP) {
        game.tick();
        acc -= STEP;
    }
    game.draw();
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
