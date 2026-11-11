// One immutable road surface in geographic coordinates. Graph edges are source
// geometry, never scenes: widths, markings and joins do not depend on the driver.
"use strict";
class CityMapGeometry {
    constructor(graph) {
        this.graph = graph;
        this.laneWidth = 74;
        this.sidewalk = 30;
        this.profiles = new Map();
        this.meshes = new Map();
        this.controls = new Map();
    }
    layer(edge) {
        const tags = edge.osmTags || {};
        if (tags.layer !== undefined && Number.isFinite(Number(tags.layer))) return Number(tags.layer);
        return (tags.bridge && tags.bridge !== "no" ? 1 : 0) - (tags.tunnel && tags.tunnel !== "no" ? 1 : 0);
    }
    profile(edge) {
        if (this.profiles.has(edge.id)) return this.profiles.get(edge.id);
        const graph = this.graph, radius = 600;
        const legs = [{ edge, reverse: false, start: 0, end: edge.length }];
        const seen = new Set([edge.id]);
        for (const side of [-1, 1]) {
            for (let count = 0; count < 96; count++) {
                const previous = side < 0 ? legs[0] : legs.at(-1);
                if (side < 0 ? previous.start <= -radius : previous.end >= edge.length + radius) break;
                const node = side < 0 ? graph.origin(previous.edge, previous.reverse) : graph.endpoint(previous.edge, previous.reverse);
                const adjacent = graph.adjacent.get(node) || [];
                let next = adjacent.length === 2 ? adjacent.find((item) => item.id !== previous.edge.id) : null;
                if (adjacent.length > 2) {
                    // A side driveway must not interrupt the taper of the
                    // through street. This continuation is fixed by geometry,
                    // never by a driver's selected outgoing edge or right of way.
                    const incoming = graph.direction(previous.edge, previous.edge.from === node,
                        previous.edge.from === node ? 0 : previous.edge.length);
                    const aligned = adjacent.filter((item) => item.id !== previous.edge.id).filter((item) => {
                        const same = item.osmWayIds?.some((id) => previous.edge.osmWayIds?.includes(id)) ||
                            (item.street === previous.edge.street && !/^безымян/i.test(item.street));
                        const direction = graph.direction(item, item.to === node);
                        return same && incoming[0]*direction[0]+incoming[1]*direction[1] > .94;
                    });
                    if (aligned.length === 1) next = aligned[0];
                }
                if (!next || seen.has(next.id) || this.layer(next) !== this.layer(previous.edge)) break;
                seen.add(next.id);
                if (side < 0) legs.unshift({ edge: next, reverse: next.from === node,
                    start: previous.start - next.length, end: previous.start });
                else legs.push({ edge: next, reverse: next.to === node,
                    start: previous.end, end: previous.end + next.length });
            }
        }
        this.profiles.set(edge.id, legs);
        if (this.profiles.size > 1024) this.profiles.delete(this.profiles.keys().next().value);
        return legs;
    }
    point(edge, offset) {
        const legs = this.profile(edge);
        const leg = legs.find((part) => offset >= part.start && offset <= part.end) ||
            (offset < legs[0].start ? legs[0] : legs.at(-1));
        const at = clamp(offset - leg.start, 0, leg.edge.length);
        return this.graph.position(leg.edge, leg.reverse ? leg.edge.length - at : at);
    }
    direction(edge, offset) {
        const a = this.point(edge, offset - 24), b = this.point(edge, offset + 24);
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return length > .001 ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : this.graph.direction(edge, false, offset);
    }
    halfWidth(edge, offset = edge.length / 2) {
        const radius = 600, legs = this.profile(edge);
        const cumulative = (value) => value <= -radius ? 0 : value >= radius ? 1
            : value < 0 ? (value + radius) ** 2 / (2 * radius ** 2) : 1 - (radius - value) ** 2 / (2 * radius ** 2);
        let width = 0;
        for (const leg of legs) width += leg.edge.lanes * this.laneWidth / 2 *
            (cumulative(leg.end - offset) - cumulative(leg.start - offset));
        width += legs[0].edge.lanes * this.laneWidth / 2 * cumulative(legs[0].start - offset);
        width += legs.at(-1).edge.lanes * this.laneWidth / 2 * (1 - cumulative(legs.at(-1).end - offset));
        return width;
    }
    maxHalfWidth(edge) {
        return Math.max(...this.profile(edge).map((leg) => leg.edge.lanes * this.laneWidth / 2));
    }
    mesh(edge) {
        if (this.meshes.has(edge.id)) return this.meshes.get(edge.id);
        const samples = new Set(edge.distances);
        for (let at = 0; at < edge.length; at += 60) samples.add(at);
        const points = [...samples].sort((a, b) => a - b).map((at) => {
            const [x, y] = this.graph.position(edge, at), dir = this.direction(edge, at);
            return { at, x, y, nx: -dir[1], ny: dir[0], width: this.halfWidth(edge, at) };
        });
        const outline = (extra) => {
            const path = new Path2D();
            points.forEach((p, i) => path[i ? "lineTo" : "moveTo"](p.x + p.nx * (p.width + extra), p.y + p.ny * (p.width + extra)));
            [...points].reverse().forEach((p) => path.lineTo(p.x - p.nx * (p.width + extra), p.y - p.ny * (p.width + extra)));
            path.closePath();
            for (const p of [points[0], points.at(-1)]) {
                path.moveTo(p.x + p.width + extra, p.y);
                path.arc(p.x, p.y, p.width + extra, 0, Math.PI * 2, true);
            }
            return path;
        };
        const mesh = { points, road: outline(0), sidewalk: outline(this.sidewalk), layer: this.layer(edge) };
        this.meshes.set(edge.id, mesh);
        if (this.meshes.size > 256) this.meshes.delete(this.meshes.keys().next().value);
        return mesh;
    }
    visibleEdges(bounds, margin = 280) {
        const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
        const radius = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2 + margin;
        return [...this.graph.nearbyEdges(cx, cy, radius)].filter(({ bounds: b }) =>
            b.maxX + margin >= bounds.minX && b.minX - margin <= bounds.maxX &&
            b.maxY + margin >= bounds.minY && b.minY - margin <= bounds.maxY);
    }
    junction(edge, reverse) {
        const key = `${edge.id}:${reverse}`;
        if (this.controls.has(key)) return this.controls.get(key);
        const nodeId = this.graph.endpoint(edge, reverse), node = this.graph.nodes.get(nodeId);
        const dir = this.graph.direction(edge, reverse, reverse ? 0 : edge.length);
        let width = 148;
        for (const other of this.graph.adjacent.get(nodeId) || []) {
            if (other.id === edge.id) continue;
            const outward = this.graph.direction(other, other.to === nodeId);
            if (Math.abs(dir[0] * outward[1] - dir[1] * outward[0]) > .35) width = Math.max(width, other.lanes * this.laneWidth);
        }
        const tags = node?.osmTags || {}, type = tags.highway;
        const signalSource = type === "traffic_signals" || tags.crossing === "traffic_signals" && tags["crossing:signals"] !== "no" || tags["crossing:signals"] === "yes";
        const feature = signalSource ? "traffic_signals" : type;
        const applies = String(tags[`${feature}:direction`] || tags.direction || "both").trim().toLowerCase();
        let directional = applies === "both" || (applies === "backward" ? reverse : applies === "forward" ? !reverse : false);
        if (!["both","forward","backward"].includes(applies)) {
            const compass = { n:0,ne:45,e:90,se:135,s:180,sw:225,w:270,nw:315 };
            const degrees = compass[applies] ?? Number(applies);
            if (Number.isFinite(degrees)) {
                const angle = degrees * Math.PI / 180;
                directional = Math.sin(angle)*dir[0]-Math.cos(angle)*dir[1] < -.5;
            }
        }
        let group = node, signalDir = dir, previous = edge, travelled = 0;
        const seen = new Set([edge.id]);
        while ((this.graph.adjacent.get(group.id) || []).length === 2) {
            const next = this.graph.adjacent.get(group.id).find((item) => item.id !== previous.id);
            if (!next || seen.has(next.id) || travelled + next.length > 600) break;
            seen.add(next.id); travelled += next.length;
            const reversed = next.to === group.id;
            group = this.graph.nodes.get(this.graph.endpoint(next, reversed));
            previous = next;
            if ((this.graph.adjacent.get(group.id) || []).length >= 3) {
                signalDir = this.graph.direction(next, reversed, reversed ? 0 : next.length);
                break;
            }
        }
        if ((this.graph.adjacent.get(group.id) || []).length < 3) group = node;
        if (signalSource && applies === "both" && (this.graph.adjacent.get(nodeId)||[]).length === 2) {
            // Both directions of one bidirectional crossing must use the same
            // signal group. Looking only forward chooses different junctions.
            const candidates=[];
            for(const first of this.graph.adjacent.get(nodeId)){
                let current=nodeId,road=first,distance=0;const visited=new Set();
                for(let step=0;step<96;step++){
                    if(visited.has(road.id)||distance+road.length>600)break;
                    visited.add(road.id);distance+=road.length;
                    const reverse=road.to===current;current=this.graph.endpoint(road,reverse);
                    const adjacent=this.graph.adjacent.get(current)||[];
                    if(adjacent.length>=3){candidates.push({distance,node:this.graph.nodes.get(current),dir:this.graph.direction(road,reverse,reverse?0:road.length)});break;}
                    if(adjacent.length!==2)break;
                    const next=adjacent.find(item=>item.id!==road.id);if(!next)break;road=next;
                }
            }
            candidates.sort((a,b)=>a.distance-b.distance||a.node.index-b.node.index);
            if(candidates.length){group=candidates[0].node;signalDir=candidates[0].dir;}
            else {group=node;signalDir=dir;}
        }
        const control = { nodeId, dir, width, stopLine: type === "crossing" ? 70 : width / 2 + 34, groupIndex: group.index, signalDir,
            signal: signalSource && directional,
            stop: type === "stop" && directional, yield: type === "give_way" && directional };
        this.controls.set(key, control);
        if (this.controls.size > 2048) this.controls.delete(this.controls.keys().next().value);
        return control;
    }
    signalPhase(control, session = null) {
        const frame = Math.floor((Date.now() + (session?.active ? session.clockOffset : 0)) / 1000 * 60);
        const direction = control.signalDir, index = control.groupIndex;
        const phase = mod(frame + Math.floor(hash(index, index * 7, session?.active ? session.state.seed : 0) * CYCLE) +
            (Math.abs(direction[1]) >= Math.abs(direction[0]) ? 0 : CYCLE / 2), CYCLE);
        return phase;
    }
    signalState(control, session = null) {
        const phase = this.signalPhase(control, session);
        return phase < GREEN_T ? "green" : phase < GREEN_T + YELLOW_T ? "yellow" : "red";
    }
    pedestrianGreen(control, session = null) {
        const phase = this.signalPhase(control, session);
        return phase >= GREEN_T + YELLOW_T && phase < GREEN_T + YELLOW_T + 75;
    }
}

class CityCamera {
    constructor() { this.scale = .8; this.heading = null; this.x = 0; this.y = 0; this.lastFrame = -1; }
    update(game) {
        const center = game.cityWorldPoint(0, 0), pose = game.cityWorldPose;
        if (this.heading === null) this.heading = pose.angle;
        if (this.lastFrame !== game.frame) {
            const angle = Math.atan2(Math.sin(pose.angle - this.heading), Math.cos(pose.angle - this.heading));
            const frames = clamp(game.frame - this.lastFrame, 1, 6);
            this.heading += clamp(angle * (1 - .9 ** frames), -.022 * frames, .022 * frames);
            this.lastFrame = game.frame;
        }
        this.x = center.x; this.y = center.y;
        this.anchorX = WIDTH / 2; this.anchorY = game.bus.centerY;
        this.cos = Math.cos(this.heading); this.sin = Math.sin(this.heading);
        const corners = [[-100,-100],[WIDTH+100,-100],[-100,HEIGHT+100],[WIDTH+100,HEIGHT+100]].map(([x,y]) => this.screenToWorld(x,y));
        this.bounds = { minX: Math.min(...corners.map((p) => p[0])), maxX: Math.max(...corners.map((p) => p[0])),
            minY: Math.min(...corners.map((p) => p[1])), maxY: Math.max(...corners.map((p) => p[1])) };
    }
    worldToScreen(x, y) {
        const dx = x - this.x, dy = y - this.y;
        return [this.anchorX + (this.cos * dx + this.sin * dy) * this.scale,
            this.anchorY + (-this.sin * dx + this.cos * dy) * this.scale];
    }
    screenToWorld(x, y) {
        const dx = (x - this.anchorX) / this.scale, dy = (y - this.anchorY) / this.scale;
        return [this.x + this.cos * dx - this.sin * dy, this.y + this.sin * dx + this.cos * dy];
    }
    apply(context) {
        context.translate(this.anchorX, this.anchorY); context.scale(this.scale, this.scale);
        context.rotate(-this.heading); context.translate(-this.x, -this.y);
    }
}
