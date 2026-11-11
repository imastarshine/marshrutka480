"""Browser regression for the original game plus city multiplayer.

Run from the repository root after installing requirements-browser.txt:
    python tests/browser_smoke.py
Uses an isolated SQLite database, two Chrome contexts and port 18882.
"""
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

import uvicorn
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"server"))
from backend.config import Settings
from backend.main import create_app

BASE="http://127.0.0.1:18882"
OUT=ROOT/"test-results"
OUT.mkdir(exist_ok=True)
errors=[]
checks=[]

def mark(label):
    checks.append(label)
    print("PASS:",label,flush=True)

def wait(page,expression,timeout=10000):
    deadline=time.monotonic()+timeout/1000
    while time.monotonic()<deadline:
        if page.evaluate('() => Boolean('+expression+')'):return
        page.wait_for_timeout(40)
    page.screenshot(path=str(OUT/'city-failure.png'))
    raise AssertionError('Timed out: '+expression+'; '+str(page.evaluate('({state:game.state,auth:document.querySelector("#auth-status").textContent,room:document.querySelector("#room-status").textContent})')))

def attach(page):
    page.on("pageerror",lambda error:errors.append(str(error)))
    page.on("console",lambda msg:errors.append(msg.text) if msg.type=="error" and "Failed to load resource" not in msg.text else None)

def register(page,name):
    page.goto(BASE,wait_until="networkidle")
    page.locator("#online-mode").click()
    page.locator("#show-register").click()
    page.locator("#username").fill(name)
    page.locator("#password").fill("City-Test-Password-480!")
    page.locator("#auth-submit").click()
    wait(page,"app.user !== null")

def canvas_click(page,x,y,touch=False):
    box=page.locator("canvas").bounding_box()
    position={"x":x*box["width"]/640,"y":y*box["height"]/760}
    if touch:page.locator("canvas").tap(position=position)
    else:page.locator("canvas").click(position=position)

def original_menu(page,touch=False):
    if page.evaluate("game.state")=="intro":canvas_click(page,320,380,touch)
    wait(page,"game.state === 'menu'")
    for tab in (1,2,0):
        canvas_click(page,95+150*tab,167,touch)
        assert page.evaluate("game.tab")==tab

def original_start(page,touch=False):
    canvas_click(page,320,667,touch)
    for _ in range(20):
        if page.evaluate("game.state")!="dialog":break
        page.wait_for_timeout(160)
        canvas_click(page,320,600,touch)
    wait(page,"game.state === 'play'")

def drive(page):
    page.locator("#room-drive").click()
    original_menu(page)
    original_start(page)

with tempfile.TemporaryDirectory(prefix="m480-city-browser-") as temp:
    settings=Settings(db_path=str(Path(temp)/"test.sqlite3"),allowed_origins=(BASE,),allowed_hosts=("127.0.0.1",),auth_limit=1000,register_limit=1000,http_limit=10000)
    server=uvicorn.Server(uvicorn.Config(create_app(settings),host="127.0.0.1",port=18882,log_level="warning",ws="websockets"))
    worker=threading.Thread(target=server.run,daemon=True);worker.start()
    deadline=time.monotonic()+10
    while not server.started and time.monotonic()<deadline:time.sleep(.05)
    assert server.started
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel="chrome",headless=True,args=["--disable-background-timer-throttling","--disable-renderer-backgrounding","--disable-backgrounding-occluded-windows"])
            contexts=[browser.new_context(viewport={"width":1440,"height":1000}) for _ in range(2)]
            first,second=[c.new_page() for c in contexts]
            attach(first);attach(second)
            register(first,"Driver_City_A")
            first.locator("#create-room-form button").click()
            wait(first,"app.socketReady && citySession.active")
            code=first.evaluate("app.room.code")
            register(second,"Driver_City_B")
            second.locator("#room-code").fill(code)
            second.locator("#join-room-form button").click()
            wait(second,"app.socketReady && citySession.active")
            wait(first,"app.room.count === 2")
            assert first.locator(".main-nav button").count()==2
            assert first.locator("#online-mode").get_attribute("aria-pressed")=="true"
            drive(first);drive(second)
            wait(first,"citySession.mapMarkersCount === 1")
            wait(second,"citySession.mapMarkersCount === 1")
            assert first.evaluate("game instanceof Game && Boolean(game.storyFlags) && typeof game.tryTurn === 'function'")
            assert first.evaluate("Math.abs(canvas.getBoundingClientRect().height-innerHeight) < 2")
            assert first.evaluate("Math.abs(canvas.getBoundingClientRect().x + canvas.getBoundingClientRect().width/2-innerWidth/2) < 2")
            mark("two UI registrations, join running city, original story/engine, full-height centred desktop canvas")

            # Pose transport is delayed by 350 ms. Own physics must respond on
            # the next local frames, well before any delayed packet is delivered.
            result=first.evaluate("""async () => {
                window.originalSend=app.send.bind(app);
                app.send=m=>{if(m.type==='pose'){setTimeout(()=>originalSend(m),350);return true;}return originalSend(m);};
                canvas.focus();const before=[game.wx,game.wy],start=performance.now();
                window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',bubbles:true}));
                await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
                const result={elapsed:performance.now()-start,speed:game.bus.speed,moved:Math.hypot(game.wx-before[0],game.wy-before[1])>0};
                window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',bubbles:true}));
                return result;
            }""")
            assert result["moved"] and result["speed"]>0 and result["elapsed"]<150,result
            first.wait_for_timeout(800)
            # Drain delayed poses before restoring immediate transmission, so
            # this test transport cannot manufacture out-of-order sequences.
            first.evaluate("() => { app.send=m=>m.type==='pose'?true:window.originalSend(m); }")
            first.wait_for_timeout(450)
            first.evaluate("() => { app.send=window.originalSend; }")
            first.wait_for_timeout(500)
            assert first.evaluate("app.socketReady && app.room !== null")
            mark("own bus responds before 350 ms of simulated network delay: "+str(round(result["elapsed"]))+" ms")

            first.locator("canvas").focus()
            first.keyboard.down("ArrowUp");first.wait_for_timeout(1400);first.keyboard.up("ArrowUp")
            first.keyboard.down("ArrowDown");first.wait_for_timeout(700);first.keyboard.up("ArrowDown")
            wait(second,"citySession.players().some(p=>p.username==='Driver_City_A' && Math.hypot(p.wx-game.wx,p.wy-game.wy)>20)")
            wait(second,"citySession.drawnPlayers === 1")
            assert first.evaluate("citySession.mapMarkersCount === 1")
            second.screenshot(path=str(OUT/"city-desktop.png"))
            mark("remote bus moves in the original road scene; labelled player appears on the original minimap")

            # Exercise the actual turning animation and world-space packet,
            # without spending a full shift driving to a particular junction.
            turn=first.evaluate("""() => {
                game.bus.invuln=600;game.cars=[];game.inters=[];game.bus.speed=6;
                let chosen=null;
                for(let index=0;index<game.cityItinerary.legs.length;index++){
                    const leg=game.cityItinerary.legs[index];
                    game.cityLegIndex=index;game.cityEdge=leg.edge;game.cityReverse=leg.reverse;
                    game.dir=game.cityGraph.direction(leg.edge,leg.reverse);
                    const options=game.cityOptions(),next=game.cityItinerary.legs[(index+1)%game.cityItinerary.legs.length];
                    for(const [side,sign] of [['right',1],['left',-1]]){
                        const option=options[side];
                        if(option?.edge.id===next.edge.id&&option.reverse===next.reverse){chosen={leg,sign};break;}
                    }
                    if(chosen)break;
                }
                if(!chosen)throw new Error('Real route has no turn to exercise');
                game.cityOffset=game.cityReverse?80:game.cityEdge.length-80;
                [game.wx,game.wy]=game.cityGraph.position(game.cityEdge,game.cityOffset);
                game.streetK=game.cityEdge.index;setRoad(game.cityEdge.lanes);
                const k=game.nextCross().k,node=game.cityGraph.nodes.get(k);
                const inter=new Intersection(game.bus.centerY-100,k,'Перекрёсток маршрута',4,game.arms(k));
                citySession.pendingSpawn=true;
                if(!game.startTurn(chosen.sign,inter))throw new Error('Connected nearby turn was rejected');
                if(Math.hypot(game.wx-node.x,game.wy-node.y)>.01)throw new Error('Turn left its shared intersection');
                return {angle:Math.atan2(game.dir[0],-game.dir[1]),street:game.currentStreet()};
            }""")
            wait(second,"citySession.players().some(p=>p.username==='Driver_City_A' && p.state==='turning')")
            wait(first,"game.state === 'play'")
            wait(second,f"citySession.players().some(p=>p.username==='Driver_City_A' && Math.cos(p.angle-({turn['angle']}))>.99 && p.street==={json.dumps(turn['street'])})")
            assert first.evaluate("app.socketReady")
            mark("original intersection turn, rotation, world coordinates and minimap survive a change of street")

            # A disconnected transport must not stop or replace the original game.
            first.evaluate("app.ws.close(4000,'browser reconnect check')")
            wait(first,"app.socketReady",timeout=10000)
            wait(second,"app.room.count===2")
            assert first.evaluate("game.state==='play'")
            mark("bounded reconnect keeps the original run and two-player membership")

            first.locator("#online-mode").click()
            first.screenshot(path=str(OUT/"city-dispatch.png"))
            before=first.evaluate("({wx:game.wx,wy:game.wy,wallet:game.save.wallet})")
            first.locator("#close-panel").click()
            first.evaluate("() => { window.runningBus=game.bus; }")
            first.locator("#solo-mode").click()
            wait(first,"app.room === null && !citySession.active")
            wait(second,"app.room.count===1")
            assert first.evaluate("game.state==='play' && game.bus===window.runningBus")
            assert first.evaluate("game.save.wallet")==before["wallet"]
            assert first.locator("#solo-mode").get_attribute("aria-pressed")=="true"
            mark("solo mode disconnects multiplayer without restarting the bus or original career")

            mobile=browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,device_scale_factor=2)
            mp=mobile.new_page();attach(mp);mp.goto(BASE,wait_until="networkidle")
            mp.locator("#solo-mode").click()
            assert not mp.locator("#dispatch-panel").is_visible()
            assert mp.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert mp.locator("#account-button").is_visible()
            assert mp.locator(".controls").is_visible()
            original_menu(mp,touch=True)
            mp.screenshot(path=str(OUT/"city-mobile-solo.png"),full_page=True)
            original_start(mp,touch=True)
            mp.locator("[data-action=pause]").tap()
            wait(mp,"game.state==='pause'")
            canvas_click(mp,320,380,touch=True)
            wait(mp,"game.state==='play'")
            mp.locator("#online-mode").click()
            assert mp.evaluate("document.documentElement.scrollHeight > innerHeight + 500")
            mp.screenshot(path=str(OUT/"city-mobile.png"),full_page=True)
            mp.locator("#account-button").click()
            mp.locator("#username").fill("Mobile_Name")
            assert mp.evaluate("game.keys.up === false && game.keys.left === false")
            mp.locator("#close-panel").click()
            assert mp.evaluate("game.state==='play'")
            mark("original touch garage/routes/start/pause, two modes, scrolling network panel and header profile")

            # Rotate/resize without replacing the game or losing the session.
            mp.set_viewport_size({"width":844,"height":390})
            assert mp.evaluate("document.documentElement.scrollWidth <= innerWidth")
            second.set_viewport_size({"width":1280,"height":1024})
            wait(second,"app.mobileLayout")
            assert second.evaluate("document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight > innerHeight")
            mark("mobile landscape and tall tablet layouts stay horizontally contained")
            browser.close()
        assert not errors,errors
        (OUT/"city-browser-report.json").write_text(json.dumps({"checks":checks,"latency_ms":result["elapsed"],"errors":errors},ensure_ascii=False,indent=2))
    finally:
        server.should_exit=True;worker.join(timeout=8)
print("Browser checks complete.",flush=True)
