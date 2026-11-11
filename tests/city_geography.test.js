"use strict";

// Independent source-data checks. Run: node tests/city_geography.test.js
// These assertions compare the playable graph with the saved public OSM
// snapshot and externally verified route checkpoints, not the import algorithm.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const ROOT = path.resolve(__dirname, "..");
const EXPECTED_ROUTES = ["33", "80", "83", "90", "480", "Т4"];

function load() {
    const canvas = { width: 640, height: 760, getContext: () => ({}) };
    const context = vm.createContext({ console, document: { getElementById: () => canvas, createElement: () => canvas }, window: {} });
    for (const name of ["config", "city", "utils"]) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, "js", `${name}.js`), "utf8"), context);
    }
    return {
        city: JSON.parse(vm.runInContext("JSON.stringify(IRKUTSK_CITY)", context)),
        run: code => vm.runInContext(code, context),
    };
}

function filesUnder(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(filename) : [filename];
    });
}

function sourceElements() {
    const filenames = filesUnder(path.join(ROOT, "geography", "source")).filter(file => /\.json(?:\.gz)?$/.test(file));
    assert.ok(filenames.length, "the public OSM snapshot is bundled for reproducible verification");
    const elements = [];
    for (const filename of filenames) {
        const content = fs.readFileSync(filename);
        const source = JSON.parse(/\.gz$/.test(filename) ? zlib.gunzipSync(content).toString("utf8") : content.toString("utf8"));
        if (Array.isArray(source.elements)) elements.push(...source.elements);
    }
    assert.ok(elements.some(element => element.type === "node"), "source snapshot includes actual GPS nodes");
    assert.ok(elements.some(element => element.type === "way"), "source snapshot includes source road ways");
    return elements;
}

function approximately(actual, expected, tolerance, label) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${label}: ${actual} differs from ${expected} by more than ${tolerance}`);
}

test("the six verified routes have public source relation provenance", () => {
    const { city } = load();
    assert.deepEqual(Object.keys(city.routes).sort(), [...EXPECTED_ROUTES].sort());
    for (const number of EXPECTED_ROUTES) {
        const route = city.routes[number];
        assert.ok(route.relationIds?.length, `${number}: original directional OSM route relation IDs`);
        for (const id of route.relationIds) assert.ok(Number.isSafeInteger(Number(id)) && Number(id) > 0, `${number}: valid relation ID`);
        assert.match(route.source, /^https:\/\/2gis\.ru\/irkutsk\/route\/\d+$/, `${number}: verified 2GIS reference`);
    }
});

test("all playable intersections retain one original OSM identity and GPS position", () => {
    const { city } = load();
    const source = new Map(sourceElements().filter(element => element.type === "node").map(element => [String(element.id), element]));
    const identities = new Set();
    const projection = city.metadata?.projection;
    assert.ok(projection && Number.isFinite(projection.originLat) && Number.isFinite(projection.originLon), "explicit projection origin");
    assert.ok(city.metersPerUnit > 0, "game units have a documented physical scale");
    for (const node of city.nodes) {
        const key = String(node.osmId);
        assert.ok(!identities.has(key), `${node.id}: an OSM intersection is not duplicated to disconnect a real junction`);
        identities.add(key);
        const original = source.get(key);
        assert.ok(original, `${node.id}: source node ${key} exists`);
        approximately(node.lat, original.lat, 1e-8, `${node.id}: latitude`);
        approximately(node.lon, original.lon, 1e-8, `${node.id}: longitude`);
        assert.ok(node.lat > 52.1 && node.lat < 52.5 && node.lon > 103.9 && node.lon < 104.5, `${node.id}: Irkutsk and its immediate suburbs`);
        const radians = Math.PI / 180, radius = projection.radius;
        const expectedX = (original.lon - projection.originLon) * radians * radius * Math.cos(projection.originLat * radians);
        const expectedY = -(original.lat - projection.originLat) * radians * radius;
        approximately(node.x * city.metersPerUnit, expectedX, 0.05, `${node.id}: projected east coordinate in metres`);
        approximately(node.y * city.metersPerUnit, expectedY, 0.05, `${node.id}: projected north coordinate in metres`);
    }
});

test("road polylines reproduce actual contiguous source way vertices without fabricated connectors", () => {
    const { city } = load();
    const elements = sourceElements();
    const sourceNodes = new Map(elements.filter(element => element.type === "node").map(element => [String(element.id), element]));
    const sourceWays = new Map(elements.filter(element => element.type === "way").map(element => [String(element.id), element]));
    const nodes = new Map(city.nodes.map(node => [node.id, node]));
    const projection = city.metadata.projection, radians = Math.PI / 180;
    const project = node => [
        (node.lon - projection.originLon) * radians * projection.radius * Math.cos(projection.originLat * radians) / city.metersPerUnit,
        -(node.lat - projection.originLat) * radians * projection.radius / city.metersPerUnit,
    ];
    let curved = 0;
    for (const edge of city.edges) {
        assert.ok(edge.osmWayIds?.length && edge.osmNodeIds?.length >= 2, `${edge.id}: source way and vertex provenance`);
        assert.equal(edge.geometry.length, edge.osmNodeIds.length, `${edge.id}: every source vertex is retained`);
        assert.equal(String(edge.osmNodeIds[0]), String(nodes.get(edge.from).osmId), `${edge.id}: start is its original shared OSM node`);
        assert.equal(String(edge.osmNodeIds.at(-1)), String(nodes.get(edge.to).osmId), `${edge.id}: end is its original shared OSM node`);
        const ways = edge.osmWayIds.map(id => {
            const way = sourceWays.get(String(id));
            assert.ok(way, `${edge.id}: source way ${id} exists`);
            return way;
        });
        for (let index = 0; index < edge.osmNodeIds.length; index++) {
            const original = sourceNodes.get(String(edge.osmNodeIds[index]));
            assert.ok(original, `${edge.id}: GPS vertex ${edge.osmNodeIds[index]} exists`);
            const expected = project(original);
            approximately(edge.geometry[index][0], expected[0], 0.05 / city.metersPerUnit, `${edge.id}/${index}: x`);
            approximately(edge.geometry[index][1], expected[1], 0.05 / city.metersPerUnit, `${edge.id}/${index}: y`);
            if (!index) continue;
            const previous = String(edge.osmNodeIds[index - 1]), current = String(edge.osmNodeIds[index]);
            assert.ok(ways.some(way => way.nodes.some((id, offset) => offset > 0 &&
                ((String(way.nodes[offset - 1]) === previous && String(id) === current) ||
                 (String(way.nodes[offset - 1]) === current && String(id) === previous)))),
                `${edge.id}: ${previous} → ${current} must be adjacent vertices on a real road way`);
        }
        if (edge.geometry.length > 2) curved++;
    }
    assert.ok(curved >= 10, "the city keeps measured bends instead of replacing streets with endpoint chords");
});

test("Chkalova reaches Stepan Razin through the actual interior OSM junction", () => {
    const { city } = load();
    // Independent inspection of the source ways found their shared vertex
    // inside way 642097008, not at the two old fabricated endpoint nodes.
    const junction = city.nodes.find(node => String(node.osmId) === "941318888");
    assert.ok(junction, "shared source node 941318888 remains a separate physical junction");
    const incident = city.edges.filter(edge => edge.from === junction.id || edge.to === junction.id);
    for (const way of ["642097008", "448245796"]) {
        assert.ok(incident.some(edge => edge.osmWayIds.map(String).includes(way)),
            `actual way ${way} must meet at the shared junction rather than a guessed nearby endpoint`);
    }
});

test("all route legs and turns follow legal directions at their shared source nodes", () => {
    const { city, run } = load();
    run("globalThis.geographyGraph = new CityGraph(IRKUTSK_CITY)");
    const edges = new Map(city.edges.map(edge => [edge.id, edge]));
    const allowed = (edge, reverse) => {
        const direction = edge.busOneway ?? edge.oneway ?? 0;
        return direction === 0 || (direction === -1 ? reverse : !reverse);
    };
    for (const number of EXPECTED_ROUTES) {
        const route = city.routes[number];
        assert.ok(route.loop || route.returnPath?.length, `${number}: one-way roads require an explicitly checked return trip`);
        const paths = [route.path, ...(route.loop ? [] : [route.returnPath])];
        const full = paths.flat();
        for (let index = 0; index < full.length; index++) {
            const leg = full[index], edge = edges.get(leg.edge);
            assert.ok(allowed(edge, Boolean(leg.reverse)), `${number}: ${edge.street} cannot be driven against its legal bus direction`);
            if (!index) continue;
            const before = full[index - 1], previous = edges.get(before.edge);
            const via = before.reverse ? previous.from : previous.to;
            assert.equal(via, leg.reverse ? edge.to : edge.from, `${number}: a turn must use the same real intersection ID`);
            assert.ok(run(`geographyGraph.canTurn(geographyGraph.edges.get(${JSON.stringify(previous.id)}),${JSON.stringify(via)},geographyGraph.edges.get(${JSON.stringify(edge.id)}),${Boolean(leg.reverse)})`),
                `${number}: a mapped trip must not ignore a prohibited turn`);
        }
    }
});

function normalized(name) {
    return name.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9]+/g, " ").trim()
        .replace(/^(?:улица|ул)\s+/, "");
}

test("all ten directional stop lists agree with the independently recorded 2GIS cards", () => {
    const { city } = load();
    const reference = JSON.parse(fs.readFileSync(path.join(ROOT, "geography", "source", "authoritative_stop_order.json"), "utf8"));
    const aliases = new Map();
    for (const group of reference.aliasGroups) {
        for (const name of group) aliases.set(normalized(name), normalized(group[0]));
    }
    const canonical = name => aliases.get(normalized(name)) || normalized(name);
    let directions = 0;
    for (const number of EXPECTED_ROUTES) {
        const route = city.routes[number];
        for (const direction of reference.routes[number].directions) {
            const actual = direction.key === "return" ? route.returnStops : route.stops;
            assert.deepEqual(actual.map(stop => canonical(stop.name)), direction.stops.map(canonical),
                `${number}/${direction.key}: preserve the published order and every repeated platform call`);
            directions++;
        }
    }
    assert.equal(directions, 10);
});

function orderedCheckpoints(stops, patterns, label) {
    let next = 0;
    for (const stop of stops) {
        if (patterns[next]?.test(normalized(stop.name))) next++;
    }
    assert.equal(next, patterns.length, `${label}: missing/out-of-order checkpoint ${patterns[next]} in ${stops.map(stop => stop.name).join(" → ")}`);
}

function measuredStopProgress(city, number, returning = false) {
    const route = city.routes[number], legs = returning ? route.returnPath : route.path;
    const declared = returning ? route.returnStops : route.stops;
    const edges = new Map(city.edges.map(edge => [edge.id, edge]));
    const lengths = legs.map(leg => {
        const geometry = edges.get(leg.edge).geometry;
        return geometry.slice(1).reduce((sum, point, index) => sum + Math.hypot(
            point[0] - geometry[index][0], point[1] - geometry[index][1]), 0);
    });
    const starts = [0];
    lengths.forEach(length => starts.push(starts.at(-1) + length));
    let previousIndex = 0, previousProgress = -1;
    return declared.map(stop => {
        let index = stop.pathIndex;
        if (index === undefined) {
            index = legs.findIndex((leg, candidate) => candidate >= previousIndex && leg.edge === stop.edge &&
                Boolean(leg.reverse) === Boolean(stop.reverse) &&
                starts[candidate] + lengths[candidate] * (leg.reverse ? 1 - stop.at : stop.at) >= previousProgress);
        }
        assert.ok(index >= 0 && index < legs.length, `${number}/${stop.name}: source stop occurs on this direction's path`);
        const leg = legs[index], offset = stop.offset ?? stop.at * lengths[index];
        const progress = starts[index] + (leg.reverse ? lengths[index] - offset : offset);
        assert.ok(progress >= previousProgress - 0.001, `${number}/${stop.name}: published stops cannot run backward along the trip`);
        previousIndex = index;
        previousProgress = progress;
        return { name: normalized(stop.name), originalName: stop.name, metres: progress * city.metersPerUnit };
    });
}

test("nearby stops do not take multi-kilometre detours through a different bridge or dam", () => {
    const { city } = load();
    const checks = [
        ["480", true, /маяковск/, /чкалов/, 2300],
        ["33", true, /маяковск/, /чкалов/, 2300],
        ["80", false, /челноков/, /чкалов/, 2300],
        ["80", false, /^южная$/, /энергетик/, 1600],
        ["80", false, /энергетик/, /микрохирург/, 1200],
    ];
    for (const [number, returning, from, to, limit] of checks) {
        const stops = measuredStopProgress(city, number, returning);
        const fromIndex = stops.findIndex(stop => from.test(stop.name));
        const end = stops.slice(fromIndex + 1).find(stop => to.test(stop.name));
        assert.ok(fromIndex >= 0 && end, `${number}: reference stop pair ${from} → ${to} exists`);
        const start = stops[fromIndex], gap = end.metres - start.metres;
        assert.ok(gap > 0 && gap < limit,
            `${number} ${returning ? "return" : "outbound"}: ${start.originalName} → ${end.originalName} is ${Math.round(gap)} m along the road; must be below ${limit} m`);
    }
    const outbound83 = city.routes["83"].stops;
    orderedCheckpoints(outbound83, [/академическая/, /академическ.*мост/, /4.*советск/, /центральный рынок/], "83 right-bank bridge exit");
    const bridges = outbound83.map((stop, index) => ({ name: normalized(stop.name), index })).filter(stop => /академическ.*мост/.test(stop.name));
    const market = outbound83.findIndex(stop => /центральный рынок/.test(normalized(stop.name)));
    assert.equal(bridges.length, 1, "83 calls the outbound bridge platform once");
    assert.ok(bridges[0].index < market, "the bridge platform cannot be appended after the terminal to satisfy a source relation");
});

test("route stops preserve the distinctive 2GIS trips rather than a common generic sequence", () => {
    const { city } = load();
    // Independent reference cards: 480/1548717962297568, 80/1548717962297499,
    // 90/1548717962297404, 83/1548718032689332, 33/1548717962297455,
    // trolleybus 4/1548717962297445. Aliases allow OSM spelling differences.
    const checkpoints = {
        "480": [/аэропорт/, /сукачева/, /центральный рынок/, /джамбул/, /курорт.*ангара/, /железнодорожн/, /институт мвд/, /юридическ/, /школа.*55/, /мельниковск/, /лугов/],
        "80": [/областн.*больниц/, /вокзал/, /аэропорт/, /лисих/, /центральный рынок/, /джамбул/, /областн.*больниц/],
        "90": [/аэропорт/, /сперанск/, /джамбул/, /госуниверситет/, /академгородок/, /дом кино/, /плотина/, /лисих/, /эталон/, /аэропорт/],
        "83": [/радужн/, /госуниверситет/, /академическ.*мост/, /4.*советск/, /трилиссер/, /театр кукол/, /центральный рынок/],
        "33": [/центральный рынок/, /джамбул/, /иркутн.*мост/, /трактов/, /подстанц/, /батарейн/],
        "Т4": [/сквер.*киров/, /музыкальн.*театр/, /эталон/, /1.*советск/, /ивату/, /аэропорт/],
    };
    for (const number of EXPECTED_ROUTES) orderedCheckpoints(city.routes[number].stops, checkpoints[number], number);
    orderedCheckpoints(city.routes["83"].returnStops,
        [/центральный рынок/, /130/, /академическ.*мост/, /госуниверситет/, /троллейбусн.*депо/, /радужн/], "83 return");
    orderedCheckpoints(city.routes["Т4"].returnStops,
        [/аэропорт/, /сукачева/, /театр кукол/, /музыкальн.*театр/, /сквер.*киров/], "Т4 return");
});

test("curved roads use arc length and local tangents, with exact on-road stop projection", () => {
    const { run } = load();
    run(`globalThis.curve = new CityGraph({nodes:[{id:'a',x:0,y:0},{id:'b',x:300,y:-400}],
        edges:[{id:'bend',from:'a',to:'b',street:'Measured bend',geometry:[[0,0],[0,-400],[300,-400]]}],routes:{}});
        globalThis.bend = curve.edges.get('bend');`);
    assert.equal(run("bend.length"), 700, "driving distance includes the bend, not the 500-unit chord");
    assert.deepEqual(JSON.parse(run("JSON.stringify(curve.position(bend,500))")), [100, -400]);
    assert.deepEqual(JSON.parse(run("JSON.stringify(curve.direction(bend,false,200))")), [0, -1]);
    assert.deepEqual(JSON.parse(run("JSON.stringify(curve.direction(bend,false,500))")), [1, 0]);
    const projected = JSON.parse(run("JSON.stringify(curve.project(bend,120,-430))"));
    assert.equal(projected.offset, 520);
    assert.equal(projected.distance, 30);
    assert.deepEqual(projected.point, [120, -400]);
});

test("close roads and grade-separated crossings do not become invented intersections", () => {
    const { run } = load();
    run(`globalThis.separate = new CityGraph({
        nodes:[{id:'a',osmId:1,x:0,y:0},{id:'b',osmId:2,x:100,y:0},
            {id:'c',osmId:3,x:100,y:0},{id:'d',osmId:4,x:100,y:100}],
        edges:[{id:'ground',from:'a',to:'b',street:'Ground road'},
            {id:'bridge',from:'c',to:'d',street:'Bridge above road'}],
        routes:{test:{path:[{edge:'ground'},{edge:'bridge'}],stops:[]}}});`);
    assert.deepEqual(JSON.parse(run("JSON.stringify(separate.adjacent.get('b').map(edge=>edge.id))")), ["ground"]);
    assert.throws(() => run("separate.itinerary('test')"), /Разрыв|disconnect/i,
        "identical XY does not authorize a connection between different source nodes");
});

test("one-way streets, bus exceptions and prohibited turns are enforced independently", () => {
    const { run } = load();
    run(`globalThis.directed = new CityGraph({
        nodes:[{id:'a',x:0,y:0},{id:'b',x:0,y:-100},{id:'c',x:100,y:-100}],
        edges:[{id:'one',from:'a',to:'b',street:'One-way',oneway:1},
            {id:'bus',from:'b',to:'c',street:'Bus contraflow',oneway:1,busOneway:0}],
        restrictions:[{from:'one',via:'b',to:'bus'}],routes:{}});`);
    assert.equal(run("directed.canTraverse(directed.edges.get('one'),false)"), true);
    assert.equal(run("directed.canTraverse(directed.edges.get('one'),true)"), false);
    assert.equal(run("directed.canTraverse(directed.edges.get('bus'),true)"), true);
    assert.equal(run("directed.canTurn(directed.edges.get('one'),'b',directed.edges.get('bus'),false)"), false);
    run("directed.data.routes.invalid = {path:[{edge:'one',reverse:false}],stops:[]}");
    assert.throws(() => run("directed.itinerary('invalid')"), /против движения|one.?way/i,
        "an omitted returnPath cannot fabricate a reverse trip on a one-way street");
});

test("a repeated street visit keeps its own ordered stop and does not clamp an endpoint platform", () => {
    const { run } = load();
    run(`globalThis.repeated = new CityGraph({
        nodes:[{id:'a',x:0,y:0},{id:'b',x:100,y:0},{id:'c',x:100,y:100}],
        edges:[{id:'ab',from:'a',to:'b',street:'Shared street'},
            {id:'bc',from:'b',to:'c',street:'Second street'},
            {id:'ca',from:'c',to:'a',street:'Third street'}],
        routes:{ring:{loop:true,path:['ab','bc','ca','ab','bc','ca'],stops:[
            {name:'First visit',edge:'ab',at:0.99,pathIndex:0},
            {name:'Second visit',edge:'ab',at:0.1,pathIndex:3}]}}});
        globalThis.repeatTrip = repeated.itinerary('ring');`);
    assert.deepEqual(JSON.parse(run("JSON.stringify(repeatTrip.legs.map(leg=>leg.stops.map(stop=>[stop.name,stop.at])))")),
        [[["First visit", 0.99]], [], [], [["Second visit", 0.1]], [], []]);
    assert.equal(run("repeatTrip.stopCount"), 2);
});
