// Physical bus poses on the selected connected OSM path. Roads and stops keep
// their original geometry; this rounds only the vehicle's driving trajectory.
"use strict";

(() => {
    const RADIUS = 180, TURN_RADIUS = 300, EPSILON = 1e-7;
    const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
    const unit = (x, y, fallback = [0, -1]) => {
        const length = Math.hypot(x, y);
        return length > EPSILON ? [x / length, y / length] : [...fallback];
    };

    function pathFor(game) {
        game.cityGeometryAt(0);
        const trace = game.cityGeometryCache;
        if (game.cityDrivingCache?.trace === trace) return game.cityDrivingCache;
        const lines = [];
        for (const leg of trace.segments) {
            const edge = leg.edge, points = edge.geometry, distances = edge.distances;
            for (let step = 0; step < points.length - 1; step++) {
                const index = leg.reverse ? points.length - 2 - step : step;
                const low = distances[index], high = distances[index + 1], length = high - low;
                if (length <= EPSILON) continue;
                const a = points[leg.reverse ? index + 1 : index], b = points[leg.reverse ? index : index + 1];
                const start = leg.start + (leg.reverse ? edge.length - high : low);
                lines.push({ edge, start, end: start + length, x: a[0], y: a[1],
                    dx: (b[0] - a[0]) / length, dy: (b[1] - a[1]) / length });
            }
        }
        const cusps = [], turns = [];
        for (let index = 1; index < lines.length; index++) {
            const before = lines[index - 1], after = lines[index];
            const dot = before.dx * after.dx + before.dy * after.dy;
            const cross = before.dx * after.dy - before.dy * after.dx;
            const s = after.start;
            if (dot <= -Math.cos(Math.PI / 6)) {
                if (!cusps.length || Math.abs(cusps.at(-1).s - s) >= EPSILON) {
                    cusps.push({ s, x: after.x, y: after.y, radius: RADIUS, side: cross > 1e-5 ? -1 : 1 });
                }
            } else if (dot < Math.cos(Math.PI / 6)) {
                const angle = Math.atan2(cross, dot);
                const halfWidth = Math.max(before.edge.lanes, after.edge.lanes) * 37;
                const radius = Math.min(1000, Math.max(TURN_RADIUS, (halfWidth + BAY_W + 45) * Math.abs(Math.tan(angle / 2))));
                turns.push({ low: s - radius, high: s + radius, s, angle, first: s, last: s });
            }
        }
        // Rare adjacent hairpins get disjoint windows, rather than switching
        // abruptly between two different rounding functions in their overlap.
        for (let index = 0; index < cusps.length; index++) {
            const previous = cusps[index - 1], next = cusps[index + 1], cusp = cusps[index];
            cusp.radius = Math.min(RADIUS, previous ? (cusp.s - previous.s) / 2 : RADIUS,
                next ? (next.s - cusp.s) / 2 : RADIUS);
        }
        // Independent fixed windows are split at the midpoint between source
        // vertices. A newly visible distant bend cannot extend an active curve.
        const curves = turns;
        const windows = [...curves, ...cusps.map((cusp) => ({ s: cusp.s, low: cusp.s - cusp.radius, high: cusp.s + cusp.radius, cusp }))]
            .sort((a, b) => a.s - b.s);
        for (let index = 1; index < windows.length; index++) {
            const previous = windows[index - 1], next = windows[index];
            if (previous.high <= next.low) continue;
            const boundary = (previous.s + next.s) / 2;
            previous.high = Math.min(previous.high, boundary); next.low = Math.max(next.low, boundary);
        }
        for (const window of windows) if (window.cusp) {
            window.cusp.radius = Math.min(window.cusp.radius, window.cusp.s - window.low, window.high - window.cusp.s);
        }
        return game.cityDrivingCache = { trace, lines, cusps, curves, windows };
    }

    function lineAt(path, s) {
        let low = 0, high = path.lines.length - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (path.lines[middle].end < s) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    // Integrals of the triangular kernel and u*kernel, respectively. Exact
    // segment integration avoids tangent jumps from a fixed number of samples.
    function weight(u, radius) {
        if (u <= -radius) return 0;
        if (u >= radius) return 1;
        return u < 0 ? (u + radius) ** 2 / (2 * radius ** 2)
            : 1 - (radius - u) ** 2 / (2 * radius ** 2);
    }

    function moment(u, radius) {
        if (u <= -radius || u >= radius) return 0;
        return -radius / 6 + (radius * u * u / 2 - Math.abs(u) ** 3 / 3) / radius ** 2;
    }

    function smoothed(path, s, radius = RADIUS) {
        const lines = path.lines, first = lines[0], last = lines.at(-1);
        let x = 0, y = 0, dx = 0, dy = 0;
        const integrate = (line, low, high) => {
            if (high <= low) return;
            const amount = weight(high - s, radius) - weight(low - s, radius);
            const m = moment(high - s, radius) - moment(low - s, radius);
            x += (line.x + line.dx * (s - line.start)) * amount + line.dx * m;
            y += (line.y + line.dy * (s - line.start)) * amount + line.dy * m;
            dx += line.dx * amount; dy += line.dy * amount;
        };
        const low = s - radius, high = s + radius;
        // Missing history or an unselected future branch supplies a tangent
        // boundary condition, never a new graph connection or driving exit.
        if (low < first.start) integrate(first, low, Math.min(high, first.start));
        for (let index = lineAt(path, low); index < lines.length && lines[index].start < high; index++) {
            const line = lines[index];
            integrate(line, Math.max(low, line.start), Math.min(high, line.end));
        }
        if (high > last.end) integrate(last, Math.max(low, last.end), high);
        const fallback = lines[lineAt(path, s)];
        return { x, y, dir: unit(dx, dy, [fallback.dx, fallback.dy]) };
    }

    function offset(point, lateral) {
        return { x: point.x - point.dir[1] * lateral, y: point.y + point.dir[0] * lateral, dir: point.dir };
    }

    function bezier(a, b, c, d, t) {
        const u = 1 - t;
        const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
        const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y;
        const dx = 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x);
        const dy = 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y);
        const fallback = t < 0.5 ? a.dir : d.dir;
        return { x, y, dir: unit(dx, dy, fallback || [0, -1]) };
    }

    function hairpin(path, cusp, s, lateral) {
        const radius = cusp.radius;
        const before = offset(smoothed(path, cusp.s - radius), lateral);
        const after = offset(smoothed(path, cusp.s + radius), lateral);
        const sign = cusp.side;
        const middle = { x: cusp.x, y: cusp.y };
        const midDir = [before.dir[1] * sign, -before.dir[0] * sign];
        const handle = radius / 3;
        if (s <= cusp.s) {
            return bezier(before,
                { x: before.x + before.dir[0] * handle, y: before.y + before.dir[1] * handle },
                { x: middle.x - midDir[0] * handle, y: middle.y - midDir[1] * handle },
                middle, Math.max(0, Math.min(1, (s - cusp.s + radius) / radius)));
        }
        return bezier(middle,
            { x: middle.x + midDir[0] * handle, y: middle.y + midDir[1] * handle },
            { x: after.x - after.dir[0] * handle, y: after.y - after.dir[1] * handle },
            after, Math.max(0, Math.min(1, (s - cusp.s) / radius)));
    }

    function roundedTurn(path, curve, s, lateral) {
        const a = offset(smoothed(path, curve.low), lateral), d = offset(smoothed(path, curve.high), lateral);
        const span = curve.high - curve.low, length = Math.hypot(d.x - a.x, d.y - a.y);
        if (span <= EPSILON || length <= EPSILON) return offset(smoothed(path, s), lateral);
        const chord = [(d.x - a.x) / length, (d.y - a.y) / length];
        const incoming = a.dir[0] * chord[0] + a.dir[1] * chord[1];
        const outgoing = d.dir[0] * chord[0] + d.dir[1] * chord[1];
        // All control-polygon points advance along the chord. Thus even a
        // constrained pair of close junctions cannot produce a loop or fold.
        const first = incoming > EPSILON ? Math.min(span / 3, length / (3 * incoming)) : 0;
        const last = outgoing > EPSILON ? Math.min(span / 3, length / (3 * outgoing)) : 0;
        return bezier(a, { x: a.x + a.dir[0] * first, y: a.y + a.dir[1] * first },
            { x: d.x - d.dir[0] * last, y: d.y - d.dir[1] * last }, d,
            Math.max(0, Math.min(1, (s - curve.low) / span)));
    }

    GameCore.prototype.cityWorldTurnRadius = TURN_RADIUS;

    GameCore.prototype.cityDrivingExit = function (edge, reverse, nodeId = this.cityGraph.endpoint(edge, reverse), options, routeHint) {
        const available = options || this.cityOptionsFor(edge, reverse, nodeId, routeHint);
        const key = this.citySelectionKey(edge, reverse, nodeId);
        const match = (choice) => {
            if (!choice) return null;
            const id = typeof choice.edge === "string" ? choice.edge : choice.edge?.id;
            return available.choices.find((candidate) => candidate.edge.id === id && candidate.reverse === choice.reverse) || null;
        };
        const committed = match(this.cityWorldCommitted?.get(key));
        if (committed) return committed;
        const selected = this.citySelectedExit(edge, reverse, nodeId, available);
        if (selected) return selected;
        if (edge === this.cityEdge && reverse === this.cityReverse && this.cityPendingTurn?.node === nodeId) {
            const pending = match(this.cityPendingTurn);
            if (pending) return pending;
        }
        const expected = routeHint !== undefined ? routeHint
            : !this.cityOffRoute ? this.cityExpectedLegAfter(edge, reverse) : null;
        const scheduled = match(expected);
        return scheduled || available.automatic || available.recommended ||
            available.choices.find((choice) => choice.side !== "uturn") ||
            (available.deadEnd ? available.choices.find((choice) => choice.side === "uturn") : null) || null;
    };

    GameCore.prototype.cityCommitPath = function () {
        const committed = this.cityWorldCommitted || (this.cityWorldCommitted = new Map());
        const path = pathFor(this);
        const segments = this.cityGeometryCache.segments;
        let changed = false;
        for (let index = 0; index < segments.length; index++) {
            const leg = segments[index];
            const window = path.windows.find((item) => item.low <= 0 && item.high >= leg.end && item.low <= leg.end);
            if (leg.end < -EPSILON || leg.end > TURN_RADIUS && !window) continue;
            const node = this.cityGraph.endpoint(leg.edge, leg.reverse);
            const key = this.citySelectionKey(leg.edge, leg.reverse, node);
            if (committed.has(key)) {
                const previous = committed.get(key);
                if (previous.reversedHistory && window && !Number.isFinite(previous.lockStartTravel)) {
                    committed.set(key, { ...previous, lockStartTravel: this.cityTravel + window.low });
                }
                continue;
            }
            const options = this.cityOptionsFor(leg.edge, leg.reverse, node);
            const following = segments[index + 1];
            const choice = following ? options.choices.find((candidate) =>
                candidate.edge.id === following.edge.id && candidate.reverse === following.reverse)
                : this.cityDrivingExit(leg.edge, leg.reverse, node, options);
            if (!choice) continue;
            committed.set(key, { ...choice, lockStartTravel: this.cityTravel + (window?.low ?? leg.end - TURN_RADIUS) });
            changed = true;
        }
        if (changed) {
            this.cityPlanRevision = (this.cityPlanRevision || 0) + 1;
            this.cityGeometryCache = null; this.cityNavigationCache = null; this.cityDrivingCache = null;
        }
        return changed;
    };

    function applySelection(game, mutate) {
        const center = game.cityWorldPoint(0, 0), body = game.cityWorldPose;
        const plans = new Map(game.cityPlannedSelections), pending = game.cityPendingTurn;
        const legacy = game.cityExitSelection, revision = game.cityPlanRevision;
        const result = mutate();
        if (!result) return result;
        game.cityGeometryCache = null; game.cityDrivingCache = null; game.cityNavigationCache = null;
        const nextCenter = game.cityWorldPoint(0, 0), nextBody = game.cityWorldPose;
        const angle = Math.atan2(Math.sin(nextBody.angle - body.angle), Math.cos(nextBody.angle - body.angle));
        if (Math.hypot(nextCenter.x - center.x, nextCenter.y - center.y) > .01 ||
            Math.hypot(nextBody.wx - body.wx, nextBody.wy - body.wy) > .01 || Math.abs(angle) > .0001) {
            game.cityPlannedSelections = plans; game.cityPendingTurn = pending;
            game.cityExitSelection = legacy; game.cityPlanRevision = revision;
            game.cityGeometryCache = null; game.cityDrivingCache = null; game.cityNavigationCache = null;
            game.showBanner("Выезд уже начат", YELLOW, 100);
            return null;
        }
        return result;
    }

    const cycleExit = GameCore.prototype.cycleNavigationExit;
    GameCore.prototype.cycleNavigationExit = function (step = 1) {
        const target = this.cityNavigationTarget();
        if (target && this.cityWorldCommitted?.has(target.key)) {
            this.showBanner("Выезд уже начат", YELLOW, 100);
            return null;
        }
        return applySelection(this, () => cycleExit.call(this, step));
    };

    const startTurn = GameCore.prototype.startTurn;
    GameCore.prototype.startTurn = function (...args) {
        return applySelection(this, () => startTurn.apply(this, args));
    };

    // The caller commits a legal outgoing edge before entering its rounding
    // window and retains that choice until cityEnter consumes it. Source-road
    // objects must use cityGraph.position(edge, offset), not this vehicle path.
    GameCore.prototype.cityWorldPoint = function (ahead = 0, lateral = 0) {
        const path = pathFor(this);
        if (!path.lines.length) {
            return { x: finite(this.wx), y: finite(this.wy), dir: unit(...(this.dir || [0, -1])) };
        }
        const s = Math.max(path.lines[0].start, Math.min(path.lines.at(-1).end, finite(ahead)));
        const side = finite(lateral);
        const cusp = path.cusps.find((candidate) => candidate.radius > EPSILON && Math.abs(s - candidate.s) < candidate.radius);
        if (cusp) return hairpin(path, cusp, s, side);
        const curve = path.curves.find((candidate) => s >= candidate.low && s <= candidate.high);
        return curve ? roundedTurn(path, curve, s, side) : offset(smoothed(path, s), side);
    };

    Object.defineProperty(GameCore.prototype, "cityWorldPose", {
        configurable: true,
        get() {
            const lateral = finite(this.bus?.x, roadMiddle()) - roadMiddle();
            const point = this.cityWorldPoint(0, lateral);
            return { wx: point.x, wy: point.y, angle: Math.atan2(point.dir[0], -point.dir[1]), lateral: 0 };
        },
    });

    Object.defineProperty(GameCore.prototype, "cityWorldSpeed", {
        configurable: true,
        get() {
            const lateral = finite(this.bus?.x, roadMiddle()) - roadMiddle();
            const a = this.cityWorldPoint(-0.5, lateral), b = this.cityWorldPoint(0.5, lateral);
            return Math.hypot(b.x - a.x, b.y - a.y) * finite(this.bus?.speed);
        },
    });
})();
