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
    page.locator("#friends-tab").click()
    page.locator("#show-register").click()
    page.locator("#username").fill(name)
    page.locator("#password").fill("City-Test-Password-480!")
    page.locator("#auth-submit").click()
    wait(page,"app.user !== null")

def drive(page):
    page.locator("#room-drive").click()
    page.locator("canvas").focus()
    for _ in range(20):
        if page.evaluate("game.state")!="dialog":break
        page.wait_for_timeout(160)
        page.keyboard.press("Enter")
    wait(page,"game.state === 'play'")

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
                canvas.focus();const before=game.wy,start=performance.now();
                window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',bubbles:true}));
                await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
                const result={elapsed:performance.now()-start,speed:game.bus.speed,moved:game.wy!==before};
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
            wait(second,"citySession.players().some(p=>p.username==='Driver_City_A' && Math.abs(p.wy-game.wy)>20)")
            wait(second,"citySession.drawnPlayers === 1")
            assert first.evaluate("citySession.mapMarkersCount === 1")
            second.screenshot(path=str(OUT/"city-desktop.png"))
            mark("remote bus moves in the original road scene; labelled player appears on the original minimap")

            # Exercise the actual turning animation and world-space packet,
            # without spending a full shift driving to a particular junction.
            first.evaluate("""() => {
                game.bus.invuln=600;game.cars=[];game.bus.speed=6;
                const k=game.nearestCross(game.along).k;
                const inter=new Intersection(game.bus.centerY-100,k,streetName(!game.vertical,k),4,{left:true,right:true,straight:true});
                game.startTurn(1,inter);
            }""")
            wait(second,"citySession.players().some(p=>p.username==='Driver_City_A' && p.state==='turning')")
            wait(first,"game.state === 'play'")
            wait(second,"citySession.players().some(p=>p.username==='Driver_City_A' && Math.abs(p.angle)>1.5)")
            assert first.evaluate("app.socketReady")
            mark("original intersection turn, rotation, world coordinates and minimap survive a change of street")

            # A disconnected transport must not stop or replace the original game.
            first.evaluate("app.ws.close(4000,'browser reconnect check')")
            wait(first,"app.socketReady",timeout=10000)
            wait(second,"app.room.count===2")
            assert first.evaluate("game.state==='play'")
            mark("bounded reconnect keeps the original run and two-player membership")

            first.locator("#friends-tab").click()
            first.screenshot(path=str(OUT/"city-dispatch.png"))
            before=first.evaluate("({wx:game.wx,wy:game.wy,wallet:game.save.wallet})")
            first.locator("#room-leave").click()
            wait(first,"app.room === null")
            first.locator("#close-panel").click()
            assert first.evaluate("game.state==='play'")
            assert first.evaluate("game.save.wallet")==before["wallet"]
            mark("leaving multiplayer preserves the current original career run")

            mobile=browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,device_scale_factor=2)
            mp=mobile.new_page();attach(mp);mp.goto(BASE,wait_until="networkidle")
            mp.locator("#play-tab").click()
            assert mp.evaluate("document.documentElement.scrollHeight > innerHeight + 500")
            assert mp.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert mp.locator("#account-button").is_visible()
            assert mp.locator(".controls").is_visible()
            mp.screenshot(path=str(OUT/"city-mobile.png"),full_page=True)
            mp.locator("#account-button").click()
            mp.locator("#username").fill("Mobile_Name")
            assert mp.evaluate("game.keys.up === false && game.keys.left === false")
            mark("mobile scrolling layout, full-width game, touch controls and header profile")

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
