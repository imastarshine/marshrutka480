"""Optional browser integration QA. Install requirements-browser.txt and Chromium first.

Run: python tests/browser_smoke.py
Temporary DBs only. Screenshots/results are written to ignored test-results/.
Ports18880 and18881 must be free. Test round22s; production remains180s.
"""
import json
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlsplit
from pathlib import Path

import uvicorn
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.main import create_app
from backend.config import Settings

BASE = "http://127.0.0.1:18880"
OUT = ROOT / "test-results"
OUT.mkdir(exist_ok=True)
issues = []
checks = []

def mark(label):
    checks.append(label)
    print("OK:", label, flush=True)

def wait_js(page, expression, timeout=10000):
    deadline=time.monotonic()+timeout/1000
    while time.monotonic()<deadline:
        if page.evaluate("() => Boolean("+expression+")"):
            return
        time.sleep(.05)
    raise AssertionError("Timed out: "+expression+"; status: "+page.locator("body").inner_text()[-1600:])

def attach(page):
    page.on("pageerror", lambda err: issues.append(str(err)))
    page.on("console", lambda msg: issues.append(msg.text) if msg.type == "error" else None)

def register(page, username, base=BASE):
    page.goto(base, wait_until="networkidle")
    page.locator("#show-register").click()
    page.locator("#username").fill(username)
    page.locator("#password").fill("Irkutsk-test-480!")
    page.locator("#auth-submit").click()
    page.locator("#driver-name").get_by_text(username, exact=True).wait_for()
    page.locator('[data-mode="online"]').click()

def self_value(page, field):
    return page.evaluate(f"onlineView.state?.players.find(p => p.id === app.user.id)?.{field}")

def board_first_stop(page):
    page.locator("canvas").focus()
    page.keyboard.down("ArrowRight")
    wait_js(page,"onlineView.state.players.find(p=>p.id===app.user.id).x>=550")
    page.keyboard.up("ArrowRight")
    page.keyboard.down("ArrowUp")
    wait_js(page,"onlineView.state.players.find(p=>p.id===app.user.id).z>=620", timeout=7000)
    page.keyboard.up("ArrowUp")
    page.keyboard.down("ArrowDown")
    wait_js(page,"onlineView.state.players.find(p=>p.id===app.user.id).speed===0", timeout=4000)
    z = self_value(page, "z")
    if z < 910:
        page.keyboard.up("ArrowDown")
        page.keyboard.down("ArrowUp")
        wait_js(page,"onlineView.state.players.find(p=>p.id===app.user.id).z>=915", timeout=4000)
        page.keyboard.up("ArrowUp")
        page.keyboard.down("ArrowDown")
    wait_js(page,"onlineView.state.players.find(p=>p.id===app.user.id).stops>=1", timeout=5000)
    page.keyboard.up("ArrowDown")
    return {key: self_value(page,key) for key in ("x","z","speed","score","stops")}

with tempfile.TemporaryDirectory(prefix="m480-e2e-") as temp:
    settings = Settings(db_path=str(Path(temp)/"test.sqlite3"), allowed_origins=(BASE,"http://127.0.0.1:18881"), allowed_hosts=("127.0.0.1",), round_seconds=22, countdown_seconds=0.5)
    app_server = create_app(settings)
    server = uvicorn.Server(uvicorn.Config(app_server, host="127.0.0.1", port=18880, log_level="warning", ws="websockets", ws_max_size=2048, ws_per_message_deflate=False))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic()+10
    while not server.started and time.monotonic()<deadline:
        time.sleep(.05)
    assert server.started
    class FrontendHandler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):
            super().__init__(*args,directory=str(ROOT/"web"),**kwargs)
        def log_message(self,*args):
            pass
        def do_GET(self):
            if urlsplit(self.path).path=="/config/runtime.js":
                body=("window.MARSHRUTKA_CONFIG=Object.freeze({API_BASE:"+json.dumps(BASE)+"});").encode()
                self.send_response(200);self.send_header("Content-Type","text/javascript");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
            else:
                super().do_GET()
    frontend_server=ThreadingHTTPServer(("127.0.0.1",18881),FrontendHandler)
    threading.Thread(target=frontend_server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
            first_context=browser.new_context(viewport={"width":1365,"height":1000})
            second_context=browser.new_context(viewport={"width":1365,"height":1000})
            first=first_context.new_page(); second=second_context.new_page()
            attach(first); attach(second)
            register(first,"Иркутск_1"); register(second,"Байкал_2")
            mark("two independent registrations through the browser UI")
            first.screenshot(path=str(OUT/"online-home.png"), full_page=True)
            first.locator("#create-room-form button").click()
            wait_js(first,"app.socketReady && app.room")
            code=first.locator("#active-room-code").inner_text()
            second.locator("#room-code").fill(code)
            second.locator("#join-room-form button").click()
            wait_js(second,"app.socketReady && onlineView.state.players.length===2")
            wait_js(first,"onlineView.state.players.length===2")
            assert not second.locator("#room-start").is_visible()
            mark("shared room, two live clients, start button only for host")
            first.screenshot(path=str(OUT/"room-lobby.png"), full_page=True)
            first.locator("#room-start").click()
            wait_js(first,"app.room.status==='running'")
            result_one = board_first_stop(first)
            assert result_one["score"]==280 and result_one["stops"]==1, result_one
            mark("real keys: accelerate, steer, brake, dwell; server awards 280 ₽")
            wait_js(second,"onlineView.state.players.find(p=>p.username==='Иркутск_1').score===280")
            assert first.evaluate("onlineView.state.stops.find(s=>s.id===0).waiting") == second.evaluate("onlineView.state.stops.find(s=>s.id===0).waiting")
            mark("other client sees identical player position, earnings and passenger pool")
            first.screenshot(path=str(OUT/"online-driving.png"),full_page=True)
            first.evaluate("app.ws.close(4000,'simulated connection loss')")
            time.sleep(.2)
            wait_js(first,"app.socketReady && onlineView.state.players.find(p=>p.id===app.user.id).connected",timeout=8000)
            assert self_value(first,"score")==280
            mark("automatic reconnect preserves earned score")
            result_two = board_first_stop(second)
            assert result_two["score"] > 0 and result_two["stops"]==1, result_two
            mark("second driver independently serves same shared stop")
            wait_js(first,"app.room.status==='finished'",timeout=25000)
            first.locator('[data-mode="leaders"]').click()
            first.locator("#leaderboard-table").wait_for(state="visible")
            assert first.locator("#leaderboard-body tr").count()==2
            first.screenshot(path=str(OUT/"leaderboard.png"),full_page=True)
            mark("completed shift persisted; both qualified drivers appear in leaderboard")
            assert first.evaluate("localStorage.getItem('token')") is None
            assert first.evaluate("Object.keys(sessionStorage).length") == 0
            mark("auth token not persisted in browser storage")
            first.locator('[data-mode="solo"]').click()
            first.locator("#solo-start").click()
            for _ in range(30):
                if first.evaluate("game.state") == "play":
                    break
                first.keyboard.press("Enter")
                first.wait_for_timeout(40)
            assert first.evaluate("game.state") == "play", first.evaluate("game.state")
            first.keyboard.down("ArrowUp")
            first.wait_for_timeout(900)
            first.keyboard.up("ArrowUp")
            assert first.evaluate("game.distance") > 0
            first.screenshot(path=str(OUT/"solo-driving.png"),full_page=True)
            mark("original solo story and driving still operate")
            mobile_context=browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,device_scale_factor=1)
            mobile=mobile_context.new_page();attach(mobile)
            mobile.goto(BASE, wait_until="networkidle")
            mobile.locator('[data-mode="online"]').click()
            assert mobile.locator(".controls").is_visible()
            assert mobile.evaluate("document.documentElement.scrollWidth <= innerWidth")
            mobile.screenshot(path=str(OUT/"mobile.png"),full_page=True)
            mark("390x844 touch layout: controls available, no horizontal overflow")
            second.locator("#logout").click()
            second.locator("#auth-guest").wait_for(state="visible")
            assert second.evaluate("app.token") is None
            mark("logout clears authenticated client and room")
            cross_context=browser.new_context(viewport={"width":1365,"height":900})
            cross=cross_context.new_page();attach(cross)
            register(cross,"Иркутск_3","http://127.0.0.1:18881")
            cross.locator("#create-room-form button").click()
            wait_js(cross,"app.socketReady && onlineView.state.players.length===1")
            assert cross.evaluate("app.base") == BASE
            mark("separate frontend origin: browser CORS registration, rooms and WebSocket auth work")
            browser.close()
    finally:
        frontend_server.shutdown();frontend_server.server_close()
        server.should_exit=True
        thread.join(timeout=5)

report={"checks":checks,"errors":issues}
(OUT/"browser-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
assert not issues, issues
