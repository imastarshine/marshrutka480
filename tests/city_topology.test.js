"use strict";

// Run with node tests/city_topology.test.js. No browser or npm packages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SHARED = ["config", "city", "utils", "effects", "scenery", "vehicles", "world", "game", "update", "render", "lobby", "story", "intro"];

function loadClient(prefix = "") {
    const drawing = new Proxy({ measureText: value => ({ width: String(value).length * 8 }) }, {
        get(target, key) { return key in target ? target[key] : () => {}; },
    });
    const makeCanvas = () => ({ width: 640, height: 760, getContext: () => drawing });
    const storage = new Map();
    const context = vm.createContext({
        console,
        document: { getElementById: () => makeCanvas(), createElement: () => makeCanvas() },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        location: { search: "" },
        window: {},
    });
    for (const name of SHARED) {
        const filename = path.join(ROOT, prefix, "js", `${name}.js`);
        vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
    }
    return { context, run: source => vm.runInContext(source, context) };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function routeLeg(edge, reverse = false) {
    return { from: reverse ? edge.to : edge.from, to: reverse ? edge.from : edge.to };
}

test("offline and multiplayer use the same Irkutsk world and driving engine", () => {
    for (const name of SHARED) {
        assert.equal(fs.readFileSync(path.join(ROOT, "js", `${name}.js`), "utf8"),
            fs.readFileSync(path.join(ROOT, "web", "js", `${name}.js`), "utf8"), name);
    }
    for (const prefix of ["", "web"]) {
        const html = fs.readFileSync(path.join(ROOT, prefix, "index.html"), "utf8");
        assert.ok(html.indexOf('src="js/config.js') < html.indexOf('src="js/city.js'), `${prefix}: config before city`);
        assert.ok(html.indexOf('src="js/city.js') < html.indexOf('src="js/utils.js'), `${prefix}: city before engine`);
    }
});

test("the city is one finite connected road graph with real street labels", () => {
    const { run } = loadClient();
    const city = plain(run("IRKUTSK_CITY"));
    const nodes = new Map(city.nodes.map(node => [node.id, node]));
    const edges = new Map(city.edges.map(edge => [edge.id, edge]));
    assert.equal(nodes.size, city.nodes.length, "unique intersection IDs");
    assert.equal(edges.size, city.edges.length, "unique road segment IDs");
    assert.ok(nodes.size >= 10 && edges.size >= 10, "a city network, not a single fabricated street");
    const neighbors = new Map([...nodes.keys()].map(id => [id, []]));
    for (const node of nodes.values()) {
        assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `coordinates: ${node.id}`);
    }
    for (const edge of edges.values()) {
        assert.ok(nodes.has(edge.from) && nodes.has(edge.to), `existing endpoints: ${edge.id}`);
        assert.notEqual(edge.from, edge.to, `no zero-length loop: ${edge.id}`);
        const from = nodes.get(edge.from), to = nodes.get(edge.to);
        assert.ok(Math.hypot(to.x - from.x, to.y - from.y) > 0, `positive road length: ${edge.id}`);
        assert.ok([2, 4, 6].includes(edge.lanes), `supported lane count: ${edge.id}`);
        assert.ok(typeof edge.street === "string" && edge.street.length > 3, `street name: ${edge.id}`);
        neighbors.get(edge.from).push(edge.to);
        neighbors.get(edge.to).push(edge.from);
    }
    const seen = new Set(), pending = [city.nodes[0].id];
    while (pending.length) {
        const id = pending.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...neighbors.get(id).filter(next => !seen.has(next)));
    }
    assert.equal(seen.size, nodes.size, "every mapped street is reachable through intersections");
});

test("each selectable route has a connected directional path and ordered real stops", () => {
    const { run } = loadClient();
    const city = plain(run("IRKUTSK_CITY"));
    const routes = plain(run("ROUTES"));
    const edges = new Map(city.edges.map(edge => [edge.id, edge]));
    for (const { num } of routes) {
        const route = city.routes[num];
        assert.ok(route, `mapped route ${num}`);
        assert.ok(route.path.length >= 2 && route.stops.length >= 3, `route ${num} has a real trip`);
        for (let index = 0; index < route.path.length; index++) {
            const leg = route.path[index];
            assert.ok(edges.has(leg.edge), `${num}: known path edge ${leg.edge}`);
            if (index) {
                const previous = route.path[index - 1];
                assert.equal(routeLeg(edges.get(previous.edge), previous.reverse).to,
                    routeLeg(edges.get(leg.edge), leg.reverse).from, `${num}: no teleport between path legs ${index - 1} and ${index}`);
            }
        }
        let legIndex = 0, previousProgress = -1;
        for (const stop of route.stops) {
            assert.ok(typeof stop.name === "string" && stop.name.trim().length > 1, `${num}: stop has a name`);
            assert.ok(Number.isFinite(stop.at) && stop.at >= 0 && stop.at <= 1, `${num}/${stop.name}: position on segment`);
            const progress = stop.reverse ? 1 - stop.at : stop.at;
            while (legIndex < route.path.length) {
                const leg = route.path[legIndex];
                if (leg.edge === stop.edge && Boolean(leg.reverse) === Boolean(stop.reverse) && progress >= previousProgress) break;
                legIndex++;
                previousProgress = -1;
            }
            assert.ok(legIndex < route.path.length, `${num}/${stop.name}: stops follow path order and direction`);
            previousProgress = progress;
        }
        const itinerary = plain(run(`new CityGraph(IRKUTSK_CITY).itinerary(${JSON.stringify(num)})`));
        const expectedStops = route.stops.length + (route.loop ? 0 : (route.returnStops || route.stops).length);
        assert.equal(itinerary.stopCount, expectedStops, `${num}: every direction-specific stop is attached exactly once`);
        assert.deepEqual(itinerary.legs.slice(0, route.path.length).flatMap(leg => leg.stops.map(stop => stop.name)),
            route.stops.map(stop => stop.name), `${num}: the driven outbound stop order matches the published trip`);
        if (route.returnStops) {
            assert.deepEqual(itinerary.legs.slice(route.path.length).flatMap(leg => leg.stops.map(stop => stop.name)),
                route.returnStops.map(stop => stop.name), `${num}: the driven return stop order matches the published trip`);
        }
        const firstLeg = itinerary.legs[0], lastLeg = itinerary.legs.at(-1);
        assert.equal(routeLeg(lastLeg.edge, lastLeg.reverse).to,
            routeLeg(firstLeg.edge, firstLeg.reverse).from, `${num}: the trip returns to its first terminal`);
        if (route.loop) assert.equal(itinerary.legs.length, route.path.length, `${num}: ring has no fabricated reverse half`);
    }
});

test("every route starts on its own first mapped street in both clients", () => {
    for (const prefix of ["", "web"]) {
        const { run } = loadClient(prefix);
        const numbers = plain(run("ROUTES.map(route => route.num)"));
        for (const num of numbers) {
            run(`globalThis.subject = new Game(); subject.save.route = ${JSON.stringify(num)}; subject.reset();`);
            const result = plain(run("({street: subject.currentStreet(), edge: subject.cityEdge, reverse:subject.cityReverse, x:subject.wx, y:subject.wy, first:IRKUTSK_CITY.routes[subject.route.num].path[0]})"));
            const edgeId = typeof result.edge === "object" ? result.edge.id : result.edge;
            assert.equal(edgeId, result.first.edge, `${prefix}/${num}: first road segment`);
            assert.equal(Boolean(result.reverse), Boolean(result.first.reverse), `${prefix}/${num}: initial direction`);
            assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y), `${prefix}/${num}: finite world position`);
            assert.ok(result.street.length > 3, `${prefix}/${num}: named first street`);
        }
    }
});

test("the route menu uses the verified Irkutsk termini and preserves purchased legacy routes", () => {
    const { run } = loadClient();
    assert.deepEqual(plain(run("Object.fromEntries(Object.entries(IRKUTSK_CITY.routes).map(([number,route])=>[number,route.termini]))")), {
        "33": ["Центральный рынок", "Батарейная"],
        "80": ["Областная больница", "Областная больница"],
        "83": ["Радужный микрорайон", "Центральный рынок"],
        "90": ["Аэропорт", "Аэропорт"],
        "480": ["Аэропорт", "Луговое"],
        "Т4": ["Сквер им. Кирова", "Аэропорт"],
    });
    for (const [oldNumber, replacement] of [["10", "80"], ["83", "83"], ["112", "33"]]) {
        run(`localStorage.setItem(SAVE_KEY, JSON.stringify({wallet:1234,route:${JSON.stringify(oldNumber)},routes:['480',${JSON.stringify(oldNumber)}],upgrades:{engine:2},buses:['gazel','transit'],bus:'transit'}))`);
        const save = plain(run("loadSave()"));
        assert.equal(save.route, replacement);
        assert.ok(save.routes.includes(replacement), `${oldNumber}: purchased replacement stays unlocked`);
        assert.equal(save.wallet, 1234);
        assert.equal(save.upgrades.engine, 2);
        assert.equal(save.bus, "transit");
    }
});

test("route construction rejects disconnected roads and keeps outbound/return stop directions", () => {
    const { run } = loadClient();
    run(`globalThis.fixture = {
        nodes: [{id:'a',x:0,y:0},{id:'b',x:0,y:-3000},{id:'c',x:3000,y:-3000},{id:'d',x:6000,y:0}],
        edges: [
            {id:'north',from:'a',to:'b',street:'ул. Ленина',lanes:4},
            {id:'east',from:'b',to:'c',street:'ул. Карла Маркса',lanes:4},
            {id:'remote',from:'c',to:'d',street:'ул. Советская',lanes:4}
        ],
        routes: {'test':{path:[{edge:'north'},{edge:'east'}],stops:[
            {name:'Сквер',edge:'north',at:0.25},
            {name:'Площадь',edge:'north',at:0.75},
            {name:'Музей',edge:'east',at:0.5}
        ]}}
    };`);
    const itinerary = plain(run("new CityGraph(fixture).itinerary('test')"));
    assert.deepEqual(itinerary.legs.map(leg => [leg.edge.id, leg.reverse]), [
        ["north", false], ["east", false], ["east", true], ["north", true],
    ]);
    assert.deepEqual(itinerary.legs.flatMap(leg => leg.stops.map(stop => stop.name)),
        ["Сквер", "Площадь", "Музей", "Музей", "Площадь", "Сквер"]);
    assert.equal(itinerary.stopCount, 6);
    run("fixture.routes.test.path = [{edge:'north'}, {edge:'remote'}]");
    assert.throws(() => run("new CityGraph(fixture).itinerary('test')"), /Разрыв|disconnect/i);
    run("fixture.edges[0].to = 'missing'");
    assert.throws(() => run("new CityGraph(fixture)"), /Неизвестный|unknown/i);
});

function cornerGame() {
    const client = loadClient();
    client.run(`globalThis.fixture = {
        nodes:[{id:'a',x:0,y:0},{id:'b',x:0,y:-3000},{id:'c',x:3000,y:-3000},{id:'d',x:8000,y:8000}],
        edges:[
            {id:'north',from:'a',to:'b',street:'ул. Ленина',lanes:4},
            {id:'east',from:'b',to:'c',street:'ул. Карла Маркса',lanes:4},
            {id:'remote',from:'c',to:'d',street:'ул. Советская',lanes:4},
            {id:'branch',from:'b',to:'d',street:'ул. Седова',lanes:4}
        ],
        routes:{'480':{path:[{edge:'north'},{edge:'east'}],stops:[
            {name:'Сквер',edge:'north',at:0.5},
            {name:'Музей',edge:'east',at:0.5}
        ]}}
    };
    globalThis.subject = new Game();
    subject.drawWorld = () => {};
    subject.cityGraph = new CityGraph(fixture);
    subject.cityItinerary = subject.cityGraph.itinerary('480');
    subject.cityLegIndex = 0;
    subject.cityLap = 0;
    subject.cityOffRoute = false;
    subject.spawnedCityStops.clear();
    subject.stops = [];
    globalThis.place = (id, offset, reverse=false) => {
        subject.cityEdge = subject.cityGraph.edges.get(id);
        subject.cityReverse = reverse;
        subject.cityOffset = offset;
        subject.dir = subject.cityGraph.direction(subject.cityEdge, reverse);
        [subject.wx,subject.wy] = subject.cityGraph.position(subject.cityEdge,offset);
        subject.state = 'play';
        subject.bus.speed = 6;
    };
    globalThis.junction = id => new Intersection(subject.bus.centerY-100,id,'ул. Карла Маркса',4,subject.arms(id));
    place('north',40);`);
    return client;
}

test("a turn requires the nearby connected intersection and preserves its exact world position", () => {
    const { run } = cornerGame();
    const initial = plain(run("({edge:subject.cityEdge.id,x:subject.wx,y:subject.wy})"));
    assert.equal(run("subject.startTurn(1,junction('b'))"), false, "cannot turn from kilometers before the intersection");
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,x:subject.wx,y:subject.wy})")), initial);
    run("place('north',3000)");
    assert.equal(run("subject.startTurn(1,junction('d'))"), false, "cannot forge a remote intersection");
    assert.equal(run("subject.startTurn(-1,junction('b'))"), false, "no invented left branch");
    assert.equal(run("subject.startTurn(1,junction('b'))"), true);
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,x:subject.wx,y:subject.wy,reverse:subject.cityReverse})")),
        { edge: "east", x: 0, y: -3000, reverse: false });
    assert.equal(run("subject.cityLegIndex"), 1, "the actual neighboring street advances the route");
});

test("steering before a junction queues a turn without teleporting the bus", () => {
    const { run } = cornerGame();
    run("place('north',2840)");
    assert.equal(run("subject.startTurn(1,junction('b'))"), true);
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,x:subject.wx,y:subject.wy})")),
        { edge: "north", x: 0, y: -2840 }, "steering cannot skip the last 160 units of the approach");
    assert.equal(run("subject.advanceCity(100)"), 100);
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,x:subject.wx,y:subject.wy})")),
        { edge: "north", x: 0, y: -2940 });
    run("subject.advanceCity(60)");
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,x:subject.wx,y:subject.wy})")),
        { edge: "east", x: 0, y: -3000 }, "the turn starts at the shared physical junction");
});

test("driving stops at a required turn and reverse cannot leave the mapped road", () => {
    const { run } = cornerGame();
    run("place('north',2800); subject.advanceCity(1000)");
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,offset:subject.cityOffset,x:subject.wx,y:subject.wy,speed:subject.bus.speed})")),
        { edge: "north", offset: 3000, x: 0, y: -3000, speed: 0 });
    run("place('north',40); subject.advanceCity(-500)");
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,offset:subject.cityOffset,x:subject.wx,y:subject.wy})")),
        { edge: "north", offset: 0, x: 0, y: 0 });
});

test("crossing a connected straight segment retains the full movement and speed", () => {
    const { run } = cornerGame();
    run(`fixture.nodes.find(node=>node.id==='c').x=0;
        fixture.nodes.find(node=>node.id==='c').y=-6000;
        subject.cityGraph=new CityGraph(fixture);
        subject.cityItinerary=subject.cityGraph.itinerary('480');
        place('north',2800);`);
    assert.equal(run("subject.advanceCity(1000)"), 1000, "distance includes both sides of the intersection");
    assert.deepEqual(plain(run("({edge:subject.cityEdge.id,offset:subject.cityOffset,x:subject.wx,y:subject.wy})")),
        { edge: "east", offset: 800, x: 0, y: -3800 });
});

test("stops stay on their street instead of being carried around the corner", () => {
    const { run } = cornerGame();
    run("place('north',700); subject.spawnCityStops()");
    assert.deepEqual(plain(run("subject.stops.filter(stop=>stop.ours).map(stop=>[stop.name,stop.cityEdge,stop.cityOffset])")),
        [["Сквер", "north", 1500]]);
    run("subject.spawnCityStops()");
    assert.equal(run("subject.stops.filter(stop=>stop.ours).length"), 1, "a fixed stop is not generated twice");
    run("place('north',3000); subject.startTurn(1,junction('b')); subject.advanceCity(700); subject.spawnCityStops()");
    assert.deepEqual(plain(run("subject.stops.filter(stop=>stop.ours).map(stop=>[stop.name,stop.cityEdge,stop.cityOffset])")),
        [["Музей", "east", 1500]]);
});

test("the actual driving loop can follow the mapped junctions of all six real routes", () => {
    const { run } = loadClient();
    const result = plain(run(`(() => {
        const failures = [];
        let transitions = 0;
        for (const route of ROUTES) {
            const game = new Game();
            game.save.route = route.num;
            game.reset();
            game.drawWorld = () => {};
            // Traffic and police do not determine map reachability.
            for (const method of ['updateCars','updatePolice','updateWanted','checkCollisions','checkSlalom','updateMotorcade','spawnCar']) game[method] = () => {};
            const legs = game.cityItinerary.legs;
            for (let index = 0; index < legs.length; index++) {
                const leg = legs[index], nextIndex = (index + 1) % legs.length, next = legs[nextIndex];
                game.state = 'play';
                game.cityLegIndex = index;
                game.cityEdge = leg.edge;
                game.cityReverse = leg.reverse;
                game.cityOffset = leg.reverse ? Math.min(1000,leg.edge.length / 2) : leg.edge.length - Math.min(1000,leg.edge.length / 2);
                game.dir = game.cityGraph.direction(leg.edge,leg.reverse,game.cityOffset);
                [game.wx,game.wy] = game.cityGraph.position(leg.edge,game.cityOffset);
                game.cityPendingTurn = null;
                game.cityOffRoute = false;
                game.cityTravel = 0;
                game.streetK = leg.edge.index;
                setRoad(leg.edge.lanes);
                game.inters = [];
                game.stops = [];
                game.spawnedLines.clear();
                game.spawnedCityStops.clear();
                game.shifts = [];
                game.openBelow = LANES / 2 - CLOSED;
                game.bus.x = laneCenter(LANES - 1 - CLOSED);
                game.bus.invuln = 100000;
                game.bus.speed = 6;
                game.districtLeft = Infinity;
                for (const key in game.nextIn) game.nextIn[key] = Infinity;
                const options = game.cityOptions();
                const side = Object.keys(options).find(key => options[key]?.edge.id === next.edge.id && options[key].reverse === next.reverse);
                game.keys.up = true;
                game.keys.left = side === 'left';
                game.keys.right = side === 'right';
                if (side === 'left') game.bus.x = laneCenter(ownFirst());
                if (side === 'right') game.bus.x = game.bus.xLimits[1];
                let steps = 0;
                while (game.cityLegIndex === index && steps++ < 350) {
                    game.clock = SHIFT_START * FRAMES_PER_MIN;
                    game.passengers = [];
                    game.complaints = 0;
                    game.bus.invuln = 100000;
                    game.update();
                }
                if (game.cityLegIndex !== nextIndex) failures.push({route:route.num,leg:leg.edge.id,next:next.edge.id,side,actual:game.cityEdge.id,state:game.state,offset:game.cityOffset});
                else transitions++;
            }
        }
        return {failures,transitions};
    })()`));
    assert.deepEqual(result.failures, []);
    assert.ok(result.transitions >= 100, `all ${result.transitions} mapped street transitions driven`);
});
