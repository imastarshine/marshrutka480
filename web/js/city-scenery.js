// Decorative city objects, not surveyed building footprints. All addresses are
// fixed world cells; the current road, route, camera and room never reseed them.
"use strict";

class CitySceneryWorld {
    constructor(graph, options = {}) {
        this.graph = graph;
        this.cellSize = 700;
        this.seed = Number.isFinite(options.seed) ? options.seed >>> 0 : 1548718;
        this.sidewalk = Number.isFinite(options.sidewalkWidth) ? Math.max(0, options.sidewalkWidth) : 30;
        this.roadHalfWidth = options.roadHalfWidth;
        this.cells = new Map();
        this.widths = new Map();
        this.maxCells = 300;
        this.maxRoadWidth = Math.max(222, ...new Set([...graph.edges.values()].map(edge => (edge.lanes || 2) * 37)));
    }

    hash(x, y, salt = 0) {
        let value = this.seed ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ salt;
        value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
        value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
        return (value ^ (value >>> 16)) >>> 0;
    }

    random(seed) {
        let value = seed >>> 0;
        return () => {
            value = (value + 0x6d2b79f5) >>> 0;
            let mixed = Math.imul(value ^ (value >>> 15), value | 1);
            mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
            return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
        };
    }

    width(edge) {
        if (this.widths.has(edge.id)) return this.widths.get(edge.id);
        let width = (edge.lanes || 2) * 37;
        if (typeof this.roadHalfWidth === "function") {
            const supplied = this.roadHalfWidth(edge);
            if (Number.isFinite(supplied)) width = Math.max(width, supplied);
        } else {
            for (const node of [edge.from, edge.to]) {
                for (const adjacent of this.graph.adjacent.get(node) || []) width = Math.max(width, (adjacent.lanes || 2) * 37);
            }
        }
        this.widths.set(edge.id, width);
        return width;
    }

    intersects(a, b, margin = 0) {
        return a.maxX + margin >= b.minX && a.minX - margin <= b.maxX &&
            a.maxY + margin >= b.minY && a.minY - margin <= b.maxY;
    }

    segmentHitsBox(a, b, box, padding) {
        const minX = box.minX - padding, maxX = box.maxX + padding;
        const minY = box.minY - padding, maxY = box.maxY + padding;
        if (Math.max(a[0], b[0]) < minX || Math.min(a[0], b[0]) > maxX ||
            Math.max(a[1], b[1]) < minY || Math.min(a[1], b[1]) > maxY) return false;
        let from = 0, to = 1;
        for (const [origin, delta, lo, hi] of [[a[0], b[0] - a[0], minX, maxX], [a[1], b[1] - a[1], minY, maxY]]) {
            if (Math.abs(delta) < 1e-10) { if (origin < lo || origin > hi) return false; continue; }
            const first = (lo - origin) / delta, second = (hi - origin) / delta;
            from = Math.max(from, Math.min(first, second));
            to = Math.min(to, Math.max(first, second));
            if (from > to) return false;
        }
        return true;
    }

    clearOfRoads(bounds, roads) {
        for (const edge of roads) {
            const clearance = this.width(edge) + this.sidewalk + 18;
            if (!this.intersects(bounds, edge.bounds, clearance)) continue;
            for (let index = 1; index < edge.geometry.length; index++) {
                if (this.segmentHitsBox(edge.geometry[index - 1], edge.geometry[index], bounds, clearance)) return false;
            }
        }
        return true;
    }

    landRoadsNear(x, y, roads) {
        const radius = 1400;
        return roads.some(edge => {
            const tags = edge.osmTags || {};
            if ((tags.bridge && tags.bridge !== "no") || (tags.tunnel && tags.tunnel !== "no")) return false;
            const point = { minX: x, maxX: x, minY: y, maxY: y };
            return this.intersects(point, edge.bounds, radius) && this.graph.project(edge, x, y).distance < radius;
        });
    }

    cell(cx, cy) {
        const key = `${cx}:${cy}`;
        if (this.cells.has(key)) {
            const cell = this.cells.get(key);
            this.cells.delete(key); this.cells.set(key, cell);
            return cell;
        }
        const left = cx * this.cellSize, top = cy * this.cellSize;
        const random = this.random(this.hash(cx, cy)), objects = [];
        const neighborhood = { minX: left - 1700, minY: top - 1700,
            maxX: left + this.cellSize + 1700, maxY: top + this.cellSize + 1700 };
        const roads = [...this.graph.nearbyEdges(left + this.cellSize / 2, top + this.cellSize / 2,
            this.cellSize / 2 + 1700 + this.maxRoadWidth)].filter(edge => this.intersects(edge.bounds, neighborhood));
        // One parcel per cell leaves a stable gap between neighboring parcels.
        // Placement rejection cannot shift any later cell or alter its seed.
        const building = {
            kind: ["panel", "office", "oldhouse", "garages"][Math.floor(random() * 4)],
            x: left + 350 + (random() - .5) * 110, y: top + 350 + (random() - .5) * 110,
            w: 240 + random() * 180, h: 230 + random() * 210,
            angle: Math.floor(random() * 4) * Math.PI / 2, seed: this.hash(cx, cy, 0x4255494c),
            color: Math.floor(random() * 5),
        };
        const turned = Math.abs(Math.sin(building.angle)) > .5;
        const halfW = (turned ? building.h : building.w) / 2 + 16;
        const halfH = (turned ? building.w : building.h) / 2 + 16;
        building.bounds = { minX: building.x - halfW, maxX: building.x + halfW,
            minY: building.y - halfH, maxY: building.y + halfH };
        const details = this.random(building.seed);
        building.roofUnits = Array.from({ length: 2 + Math.floor(details() * 3) }, () => ({
            x: 35 + details() * (building.w - 100), y: 35 + details() * (building.h - 90),
        }));
        if (random() < .8 && this.landRoadsNear(building.x, building.y, roads) && this.clearOfRoads(building.bounds, roads)) objects.push(building);
        const count = 3 + Math.floor(random() * 5);
        for (let index = 0; index < count; index++) {
            const x = left + 48 + random() * 604, y = top + 48 + random() * 604;
            const radius = 17 + random() * 18, tone = Math.floor(random() * 3);
            const bounds = { minX: x - radius - 8, maxX: x + radius + 8,
                minY: y - radius - 8, maxY: y + radius + 8 };
            if (objects.some(object => this.intersects(bounds, object.bounds, 12)) ||
                !this.landRoadsNear(x, y, roads) || !this.clearOfRoads(bounds, roads)) continue;
            objects.push({ kind: "tree", x, y, radius, tone, bounds });
        }
        this.cells.set(key, objects);
        while (this.cells.size > this.maxCells) this.cells.delete(this.cells.keys().next().value);
        return objects;
    }

    drawWorld(context, bounds) {
        if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return;
        const minX = Math.floor(bounds.minX / this.cellSize), maxX = Math.floor(bounds.maxX / this.cellSize);
        const minY = Math.floor(bounds.minY / this.cellSize), maxY = Math.floor(bounds.maxY / this.cellSize);
        // A city overview needs roads and markers; roof details at that zoom
        // would be subpixel. Do not generate an entire city's cells in one frame.
        if (maxX < minX || maxY < minY || (maxX - minX + 1) * (maxY - minY + 1) > 900) return;
        context.save();
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            for (const object of this.cell(x, y)) {
                if (!this.intersects(object.bounds, bounds)) continue;
                if (object.kind === "tree") this.drawTree(context, object);
                else this.drawBuilding(context, object);
            }
        }
        context.restore();
    }

    drawTree(context, object) {
        const { x, y, radius } = object;
        const circle = (px, py, r, color) => {
            context.fillStyle = color; context.beginPath(); context.arc(px, py, r, 0, Math.PI * 2); context.fill();
        };
        circle(x + 6, y + 7, radius, "#243c2866");
        circle(x, y, radius, ["#427146", "#39704b", "#526f3b"][object.tone]);
        circle(x - radius * .28, y - radius * .25, radius * .63, ["#629156", "#589268", "#7b9552"][object.tone]);
    }

    drawBuilding(context, object) {
        const { w, h } = object, x = -w / 2, y = -h / 2;
        const roof = ["#777f82", "#929184", "#747f76", "#85858f", "#a08274"][object.color];
        context.save(); context.translate(object.x, object.y); context.rotate(object.angle);
        context.fillStyle = "#10191655"; context.fillRect(x + 11, y + 13, w, h);
        if (object.kind === "oldhouse") {
            context.fillStyle = ["#8e6045", "#677c86", "#719477", "#8f7e6a", "#887787"][object.color];
            context.fillRect(x, y, w, h);
            context.fillStyle = ["#af7161", "#8493a0", "#879a78", "#a69577", "#a7868f"][object.color];
            context.fillRect(x + 5, y + 5, w / 2 - 5, h - 10);
            context.strokeStyle = "#534c47"; context.lineWidth = 5;
            context.beginPath(); context.moveTo(0, y); context.lineTo(0, y + h); context.stroke();
            context.fillStyle = "#d6c8b2";
            for (let offset = 24; offset < h - 15; offset += 49) {
                context.fillRect(x + 5, y + offset, 13, 24); context.fillRect(w / 2 - 18, y + offset, 13, 24);
            }
            context.fillStyle = "#5c5047"; context.fillRect(w / 2 - 53, y + 24, 22, 33);
        } else if (object.kind === "garages") {
            context.fillStyle = "#a29b88"; context.fillRect(x, y, w, h);
            const bay = (w - 24) / 4;
            for (let index = 0; index < 4; index++) {
                context.fillStyle = index % 2 ? "#7b8580" : roof;
                context.fillRect(x + 10 + index * bay, y + 9, bay - 5, h * .34);
                context.fillRect(x + 10 + index * bay, y + h * .66, bay - 5, h * .31);
                context.fillStyle = "#474f4b";
                context.fillRect(x + 13 + index * bay, y + h * .32, bay - 11, 13);
                context.fillRect(x + 13 + index * bay, y + h * .64, bay - 11, 13);
            }
        } else {
            context.fillStyle = object.kind === "office" ? "#77838b" : "#a6aaa2";
            context.fillRect(x, y, w, h);
            context.fillStyle = roof; context.fillRect(x + 9, y + 9, w - 18, h - 18);
            context.strokeStyle = "#b2b7ae"; context.lineWidth = 3;
            context.strokeRect(x + 12, y + 12, w - 24, h - 24);
            context.fillStyle = "#a4bac1";
            for (let offset = 23; offset < w - 18; offset += 39) {
                context.fillRect(x + offset, y + 2, 22, 10); context.fillRect(x + offset, h / 2 - 12, 22, 10);
            }
            for (let offset = 26; offset < h - 19; offset += 43) {
                context.fillRect(x + 2, y + offset, 10, 24); context.fillRect(w / 2 - 12, y + offset, 10, 24);
            }
            for (const unit of object.roofUnits) {
                const px = x + unit.x, py = y + unit.y;
                context.fillStyle = "#4c5657"; context.fillRect(px + 4, py + 5, 32, 24);
                context.fillStyle = "#bec4bc"; context.fillRect(px, py, 32, 24);
                context.strokeStyle = "#7c8781"; context.lineWidth = 2; context.strokeRect(px + 4, py + 4, 24, 16);
            }
        }
        context.strokeStyle = "#48534e"; context.lineWidth = 3; context.strokeRect(x, y, w, h);
        context.restore();
    }
}
