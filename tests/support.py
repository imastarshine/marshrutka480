"""Small test harness: isolated SQLite file and real ASGI lifespan per test."""

from pathlib import Path
import json
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


ORIGIN = "http://testserver"
PASSWORD = "Irkutsk-Test-Password-480!"


class AppCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="marshrutka-test-")
        self.addCleanup(self.temp.cleanup)
        self.db_path = str(Path(self.temp.name) / "test.sqlite3")
        self.settings = Settings(
            db_path=self.db_path,
            allowed_origins=(ORIGIN,),
            allowed_hosts=("testserver",),
            auth_limit=1000,
            register_limit=1000,
            http_limit=10000,
        )
        self.app = create_app(self.settings)
        self.client = TestClient(self.app, headers={"Origin": ORIGIN})
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def register(self, username="Driver480", password=PASSWORD):
        response = self.client.post(
            "/api/auth/register", json={"username": username, "password": password}
        )
        self.assertIn(response.status_code, (200, 201), response.text)
        return response.json()

    @staticmethod
    def auth(session):
        return {"Authorization": "Bearer " + session["token"]}

    def room(self, session, *, public=True, max_players=4, name="Иркутский рейс"):
        response = self.client.post(
            "/api/rooms",
            headers=self.auth(session),
            json={"name": name, "public": public, "max_players": max_players},
        )
        self.assertIn(response.status_code, (200, 201), response.text)
        return response.json()["room"]

    def join(self, session, room):
        return self.client.post(
            f"/api/rooms/{room['code']}/join",
            headers=self.auth(session),
            json={},
        )

    def ws_auth(self, ws, session, room):
        ws.send_json({"type": "auth", "token": session["token"], "room": room["code"]})
        response = self.receive_json(ws)
        self.assertEqual(response["type"], "welcome", response)
        self.assertEqual(response["player_id"], session["user"]["id"])
        return response

    @staticmethod
    def receive_json(ws, timeout=4):
        # Starlette's public receive_json has no timeout. A bounded portal receive
        # prevents a broken protocol from hanging the whole regression suite.
        future = ws.portal.start_task_soon(ws._send_rx.receive)
        try:
            message = future.result(timeout=timeout)
        except BaseException:
            future.cancel()
            raise
        ws._raise_on_close(message)
        return json.loads(message.get("text") or message["bytes"].decode("utf-8"))

    def receive_type(self, ws, kind, attempts=25):
        """Bound skipped state packets; protocol failures stay descriptive."""
        for _ in range(attempts):
            message = self.receive_json(ws)
            if message.get("type") == kind:
                return message
        self.fail(f"No {kind!r} packet among {attempts} packets")
