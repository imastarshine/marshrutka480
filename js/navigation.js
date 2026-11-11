// Навигация находится в DOM рядом с управлением, за пределами игрового холста.
"use strict";

class CityNavigationPanel {
    constructor(game) {
        this.game = game;
        this.root = document.getElementById("street-navigation");
        this.lastUpdate = -Infinity;
        if (!this.root) return;
        this.name = this.root.querySelector("[data-navigation-name]");
        this.detail = this.root.querySelector("[data-navigation-detail]");
        this.distance = this.root.querySelector("[data-navigation-distance]");
        this.actions = this.root.querySelector("[data-navigation-actions]");
        this.bugHelp = this.root.querySelector("[data-navigation-help]");
        this.bugButton = this.root.querySelector("[data-report-bug]");
        this.bugStatus = this.root.querySelector("[data-bug-report-status]");
        this.buttons = [...this.root.querySelectorAll("[data-navigation-step]")];
        for (const button of this.buttons) {
            button.addEventListener("click", () => {
                if (game.state !== "play" || game.mapOverview) return;
                game.cycleNavigationExit(Number(button.dataset.navigationStep));
                this.update(true);
            });
        }
        this.bugButton.addEventListener("click", () => {
            if (!this.canRecover()) return;
            game.recoverFromBug();
            this.update(true);
        });
        // Space/Enter activate the focused UI button instead of sounding the horn.
        for (const button of [...this.buttons, this.bugButton]) {
            button.addEventListener("keydown", (event) => {
                if (!["Space", "Enter", "NumpadEnter"].includes(event.code)) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) button.click();
            });
            button.addEventListener("keyup", (event) => {
                if (!["Space", "Enter", "NumpadEnter"].includes(event.code)) return;
                event.preventDefault();
                event.stopPropagation();
            });
        }
    }

    setText(element, value) {
        if (element.textContent !== value) element.textContent = value;
        if (element.title !== value) element.title = value;
    }

    canRecover() {
        return ["play", "boom", "offer"].includes(this.game.state) ||
            (this.game.state === "over" && this.game.result?.how === "crash");
    }

    update(force = false) {
        if (!this.root) return;
        const now = performance.now();
        if (!force && now - this.lastUpdate < 100) return;
        this.lastUpdate = now;
        const game = this.game;
        const active = !["intro", "menu", "over", "dialog"].includes(game.state);
        const target = active && typeof game.cityNavigationTarget === "function" ? game.cityNavigationTarget() : null;
        const selectable = Boolean(target?.canCycle);
        const choice = target?.choice;
        const street = selectable ? choice?.edge?.street || game.currentStreet() : game.currentStreet();
        const arrow = { left: "←", right: "→", straight: "↑", uturn: "↶" }[choice?.side] || "↑";
        const crashed = game.state === "over" && game.result?.how === "crash";
        const name = crashed ? "Рейс прерван" : !active ? "Навигация" : selectable ? target.name || "Ближайший перекрёсток" : `По улице ${street}`;
        const detail = crashed ? "Можно бесплатно восстановить рейс" : !active ? "Начните рейс — здесь появится маршрут" : selectable
            ? `${target.selected ? "Выбран" : target.options?.automatic ? "Далее" : "Выбери съезд"}: ${arrow} ${street}` : "Следуйте по дороге";
        const meters = Math.max(0, Number(target?.distanceMeters) || 0);
        const distance = meters < 10 ? "рядом" : meters >= 1000
            ? `${(meters / 1000).toFixed(1).replace(".", ",")} км` : `${Math.round(meters / 10) * 10} м`;
        this.setText(this.name, name);
        this.setText(this.detail, detail);
        this.setText(this.distance, distance);
        if (this.distance.hidden !== !selectable) this.distance.hidden = !selectable;
        if (this.actions.hidden !== !selectable) this.actions.hidden = !selectable;
        const disabled = game.state !== "play" || game.mapOverview;
        for (const button of this.buttons) if (button.disabled !== disabled) button.disabled = disabled;
        this.root.classList.toggle("has-choice", selectable);
        this.root.classList.toggle("has-selection", Boolean(target?.selected));
        const recovery = this.canRecover();
        if (this.bugHelp.hidden !== !recovery) this.bugHelp.hidden = !recovery;
        this.setText(this.bugStatus, String(game.bugReportStatus || ""));
    }
}
