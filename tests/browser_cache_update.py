"""Real HTTP-cache regression for clients returning after the Irkutsk update.

Run from the repository root: python tests/browser_cache_update.py
Requires installed Google Chrome and requirements-browser.txt. No request
interception or cache-disabling DevTools command is used. A local server first
serves the actual 70ab315 client and gives utils.js a one-hour cache lifetime.
Other files revalidate, reproducing a partially cached deployment realistically.
The test demonstrates the unversioned failure, then verifies the current HTML's
versioned scripts recover on normal link navigation without clearing storage.
"""
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import subprocess
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
LEGACY_REVISION = "70ab315"
BROKEN_REVISION = "cf80612"
OUT = ROOT / "test-results"
STATE = {"stage": "legacy", "requests": []}
CAREER = {
    "wallet": 4321, "best": 7777, "rep": 64, "story": 0, "storySeen": 0,
    "upgrades": {"engine": 2, "fare": 1},
    "buses": ["gazel", "transit"], "bus": "transit",
    "routes": ["480", "83"], "route": "83",
}


@lru_cache(maxsize=None)
def legacy_file(relative, revision=LEGACY_REVISION):
    result = subprocess.run(
        ["git", "show", f"{revision}:{relative}"], cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    return result.stdout if result.returncode == 0 else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, body, content_type="text/html; charset=utf-8", cache="no-store", status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # Normal link navigation may cancel a pending favicon or image.
            pass

    def do_GET(self):
        request = urlsplit(self.path)
        stage = STATE["stage"]
        STATE["requests"].append({"stage": stage, "path": request.path, "query": request.query})
        if request.path in ("/api/health", "/online/api/health"):
            self.respond(b'{"ok":true,"features":["original-city","irkutsk-routes"]}', "application/json")
            return
        if request.path.startswith("/landing/"):
            mode = request.path.rsplit("/", 1)[-1]
            self.respond(f'<a href="/{mode}/">Return to the game</a>'.encode())
            return
        parts = request.path.lstrip("/").split("/", 1)
        if len(parts) != 2 or parts[0] not in ("online", "offline"):
            self.respond(b"Not found", "text/plain", status=404)
            return
        mode, asset = parts
        asset = asset or "index.html"
        base = ROOT / "web" if mode == "online" else ROOT
        target = (base / asset).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():
            self.respond(b"Not found", "text/plain", status=404)
            return
        relative = target.relative_to(ROOT).as_posix()
        body = legacy_file(relative) if stage == "legacy" else target.read_bytes()
        if body is None:
            self.respond(b"Not found in legacy revision", "text/plain", status=404)
            return
        if asset == "index.html" and stage == "unversioned":
            # The actual first Irkutsk release retained the legacy asset URLs.
            body = legacy_file(relative, BROKEN_REVISION)
            assert body is not None, f"Missing control revision {BROKEN_REVISION}:{relative}"
        is_html = asset.endswith(".html")
        content_type = "text/html; charset=utf-8" if is_html else mimetypes.guess_type(asset)[0] or "application/octet-stream"
        cache = "no-store" if is_html else "no-cache"
        if stage == "legacy" and asset == "js/utils.js":
            cache = "public, max-age=3600"
        self.respond(body, content_type, cache)


def return_normally(page, origin, mode):
    page.goto(f"{origin}/landing/{mode}", wait_until="load")
    page.locator("a").click()
    page.wait_for_load_state("domcontentloaded")


def canvas_click(page, x, y):
    box = page.locator("canvas").bounding_box()
    page.locator("canvas").click(position={"x": x * box["width"] / 640, "y": y * box["height"] / 760})


def check_mode(browser, origin, mode):
    STATE["stage"] = "legacy"
    STATE["requests"].clear()
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{origin}/{mode}/", wait_until="domcontentloaded")
    page.wait_for_function("typeof game !== 'undefined' && typeof Game === 'function'")
    assert page.evaluate("typeof game !== 'undefined' && typeof Game === 'function'"), "legacy game did not initialize"
    assert not errors, errors
    page.evaluate("career => localStorage.setItem(SAVE_KEY, JSON.stringify(career))", CAREER)
    assert any(item["path"] == f"/{mode}/js/utils.js" for item in STATE["requests"]), "legacy utils was not fetched"

    STATE["stage"] = "unversioned"
    return_normally(page, origin, mode)
    assert any("CityGraph is not defined" in message for message in errors), errors
    assert not any(item["stage"] == "unversioned" and item["path"] == f"/{mode}/js/utils.js"
                   for item in STATE["requests"]), "control did not retain cached legacy utils"
    cached = page.evaluate("""() => {
        const resource=performance.getEntriesByType('resource').find(item=>item.name.endsWith('/js/utils.js'));
        return resource && {transfer:resource.transferSize,decoded:resource.decodedBodySize};
    }""")
    assert cached and cached["transfer"] == 0 and cached["decoded"] > 0, cached
    failure = list(errors)
    print(f"PASS: {mode}: reproduced CityGraph failure with a real cached legacy utils.js", flush=True)

    errors.clear()
    STATE["stage"] = "fixed"
    return_normally(page, origin, mode)
    page.wait_for_function("typeof CityGraph === 'function' && typeof game !== 'undefined' && game.cityGraph.edges.size>0")
    assert not errors, errors
    fetched_utils = [item for item in STATE["requests"] if item["stage"] == "fixed" and item["path"] == f"/{mode}/js/utils.js"]
    assert fetched_utils and fetched_utils[-1]["query"], "fixed HTML must use a new versioned utils URL"
    save = page.evaluate("({wallet:game.save.wallet,best:game.save.best,rep:game.save.rep,upgrades:game.save.upgrades,bus:game.save.bus,routes:game.save.routes,route:game.save.route})")
    assert save["wallet"] == CAREER["wallet"] and save["best"] == CAREER["best"] and save["rep"] == CAREER["rep"], save
    assert save["upgrades"] == CAREER["upgrades"] and save["bus"] == "transit", save
    assert save["route"] == "80" and "80" in save["routes"], save
    canvas_click(page, 320, 380)
    page.wait_for_function("game.state === 'menu'")
    canvas_click(page, 320, 667)
    page.wait_for_function("game.state === 'play'")
    before = page.evaluate("[game.wx,game.wy]")
    page.keyboard.down("ArrowUp")
    page.wait_for_timeout(200)
    page.keyboard.up("ArrowUp")
    assert page.evaluate("before=>Math.hypot(game.wx-before[0],game.wy-before[1])>0", before), "game must drive after update"
    assert not errors, errors
    page.screenshot(path=str(OUT / f"cache-update-{mode}.png"))
    print(f"PASS: {mode}: versioned scripts recover without clearing cache or career; route 83 migrates to 80 and drives", flush=True)
    result = {"mode": mode, "legacy_failure": failure, "cached_utils": cached,
              "new_utils_url_query": fetched_utils[-1]["query"], "career": save, "errors_after_fix": errors}
    context.close()
    return result


def main():
    OUT.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            try:
                results = [check_mode(browser, origin, mode) for mode in ("online", "offline")]
                (OUT / "browser-cache-update-report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
    print("HTTP cache update checks complete.", flush=True)


if __name__ == "__main__":
    main()
