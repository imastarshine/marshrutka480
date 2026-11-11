import hashlib
import html
import re
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.assets import versioned_index
from backend.config import Settings
from backend.main import create_app


class AssetVersionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="marshrutka-assets-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "js").mkdir()
        (self.root / "js" / "game.js").write_text("const release = 1;", encoding="utf-8")
        (self.root / "styles.css").write_text("body{color:red}", encoding="utf-8")
        (self.root / "index.html").write_text(
            '<!doctype html><link rel="stylesheet" href="styles.css?v=old">'
            '<script src="js/game.js?language=ru&amp;v=old#entry"></script>'
            '<script src="https://example.com/external.js?v=external"></script>', encoding="utf-8")

    def app(self):
        return create_app(Settings(web_path=str(self.root), db_path=str(self.root / "test.sqlite3")))

    @staticmethod
    def script_url(source):
        return html.unescape(re.search(r'<script src="([^"]+)"', source)[1])

    def test_content_changes_version_even_when_size_and_timestamp_match(self):
        asset = self.root / "js" / "game.js"
        first = versioned_index(self.root)
        timestamp = asset.stat().st_mtime_ns
        asset.write_text("const release = 2;", encoding="utf-8")
        import os
        os.utime(asset, ns=(timestamp, timestamp))
        second = versioned_index(self.root)
        self.assertNotEqual(self.script_url(first), self.script_url(second))
        self.assertIn("v=" + hashlib.sha256(asset.read_bytes()).hexdigest(), second)
        self.assertIn("language=ru&amp;v=", second)
        self.assertIn("#entry", second)
        self.assertIn('https://example.com/external.js?v=external', second)
        self.assertIn("styles.css?v=" + hashlib.sha256((self.root / "styles.css").read_bytes()).hexdigest(), second)

    def test_both_html_routes_and_head_are_uncacheable_and_assets_still_resolve(self):
        with TestClient(self.app()) as client:
            root = client.get("/")
            self.assertEqual(root.status_code, 200)
            for path in ("/", "/index.html"):
                with self.subTest(path=path):
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.text, root.text)
                    self.assertIn("no-store", response.headers["cache-control"])
                    self.assertTrue(response.headers["content-type"].startswith("text/html"))
                    head = client.head(path)
                    self.assertEqual(head.status_code, 200)
                    self.assertEqual(head.content, b"")
                    self.assertEqual(head.headers["content-length"], response.headers["content-length"])
                    self.assertIn("no-store", head.headers["cache-control"])
            asset = client.get("/" + self.script_url(root.text))
            self.assertEqual(asset.status_code, 200)
            self.assertEqual(asset.text, "const release = 1;")
            self.assertEqual(client.get("/js/missing.js?v=anything").status_code, 404)

    def test_missing_local_asset_or_index_fails_release_setup(self):
        (self.root / "js" / "game.js").unlink()
        with self.assertRaises(FileNotFoundError):
            self.app()
        (self.root / "index.html").unlink()
        with self.assertRaises(FileNotFoundError):
            versioned_index(self.root)
