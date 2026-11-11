from pathlib import Path

from tests.support import AppCase, PASSWORD


class AuthenticationTests(AppCase):
    def test_csp_disallows_inline_script_and_style_execution(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        csp = response.headers.get("content-security-policy", "")
        self.assertIn("script-src 'self'", csp)
        self.assertIn("style-src 'self'", csp)
        self.assertNotIn("'unsafe-inline'", csp)
        self.assertNotIn("'unsafe-eval'", csp)

    def test_register_login_me_logout(self):
        signup = self.register("Водитель480")
        self.assertGreaterEqual(len(signup["token"]), 32)
        self.assertIn("expires_at", signup)
        profile = self.client.get("/api/auth/me", headers=self.auth(signup))
        self.assertEqual(profile.status_code, 200)
        self.assertEqual(profile.json()["user"]["username"], "Водитель480")
        login = self.client.post(
            "/api/auth/login", json={"username": "Водитель480", "password": PASSWORD}
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.assertNotEqual(login.json()["token"], signup["token"])
        self.assertEqual(login.json()["user"]["id"], signup["user"]["id"])
        logout = self.client.post("/api/auth/logout", headers=self.auth(login.json()))
        self.assertEqual(logout.status_code, 200)
        self.assertEqual(
            self.client.get("/api/auth/me", headers=self.auth(login.json())).status_code,
            401,
        )

    def test_password_and_raw_token_are_not_stored(self):
        session = self.register()
        # Include SQLite WAL/journal files: secrets must never enter any database page.
        database_bytes = b"".join(
            path.read_bytes() for path in Path(self.temp.name).iterdir() if path.is_file()
        )
        self.assertNotIn(PASSWORD.encode(), database_bytes)
        self.assertNotIn(session["token"].encode(), database_bytes)
        self.assertNotIn("password", session["user"])
        self.assertNotIn("password_hash", session["user"])

    def test_wrong_password_and_unknown_user_have_same_error(self):
        self.register()
        wrong = self.client.post(
            "/api/auth/login",
            json={"username": "Driver480", "password": "wrong-password-480"},
        )
        absent = self.client.post(
            "/api/auth/login",
            json={"username": "Unknown480", "password": "wrong-password-480"},
        )
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(absent.status_code, 401)
        self.assertEqual(wrong.json(), absent.json())

    def test_duplicate_username_casefold_is_rejected(self):
        self.register("Driver480")
        duplicate = self.client.post(
            "/api/auth/register", json={"username": "driver480", "password": PASSWORD}
        )
        self.assertEqual(duplicate.status_code, 409, duplicate.text)

    def test_invalid_credentials_and_unknown_fields_are_rejected(self):
        payloads = [
            {"username": "ab", "password": PASSWORD},
            {"username": "x" * 25, "password": PASSWORD},
            {"username": "<script>alert(1)</script>", "password": PASSWORD},
            {"username": "'; DROP TABLE users;--", "password": PASSWORD},
            {"username": "Driver480", "password": "short"},
            {"username": "Driver480", "password": "x" * 129},
            {"username": "Driver480", "password": PASSWORD, "role": "admin"},
        ]
        for payload in payloads:
            with self.subTest(payload=payload["username"], extra=list(payload)):
                response = self.client.post("/api/auth/register", json=payload)
                self.assertEqual(response.status_code, 422, response.text)
        # Injection attempts must not damage the real table.
        self.register("Healthy480")

    def test_missing_and_fake_authorization_are_rejected(self):
        for headers in ({}, {"Authorization": "Bearer fabricated-token"}):
            for method, path, body in (
                ("get", "/api/auth/me", None),
                ("post", "/api/rooms", {"name": "Рейс", "public": True, "max_players": 4}),
                ("post", "/api/auth/logout", {}),
            ):
                with self.subTest(path=path, authorized=bool(headers)):
                    kwargs = {"headers": headers}
                    if body is not None:
                        kwargs["json"] = body
                    response = getattr(self.client, method)(path, **kwargs)
                    self.assertEqual(response.status_code, 401, response.text)

    def test_large_body_is_rejected_before_auth(self):
        response = self.client.post(
            "/api/auth/login",
            content='{"username":"x","password":"' + "x" * 100_000 + '"}',
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413, response.text[:200])

    def test_cors_uses_an_exact_allowlist(self):
        allowed = self.client.options(
            "/api/auth/login",
            headers={
                "Origin": "http://testserver",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "http://testserver")
        for origin in ("https://evil.example", "http://testserver.evil.example", "null"):
            with self.subTest(origin=origin):
                rejected = self.client.options(
                    "/api/auth/login",
                    headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
                )
                self.assertNotEqual(rejected.headers.get("access-control-allow-origin"), origin)
                self.assertIn(rejected.status_code, (400, 403))

    def test_client_cannot_submit_an_arbitrary_leaderboard_score(self):
        session = self.register()
        for path in ("/api/leaderboard", "/api/scores"):
            response = self.client.post(
                path, headers=self.auth(session), json={"score": 999999999, "stops": 9999}
            )
            self.assertIn(response.status_code, (404, 405))
        board = self.client.get("/api/leaderboard")
        self.assertEqual(board.status_code, 200)
        self.assertEqual(board.json()["entries"], [])


class RoomHttpTests(AppCase):
    def test_private_rooms_are_unlisted_and_joinable_by_code(self):
        owner = self.register("Host480")
        other = self.register("Friend480")
        private = self.room(owner, public=False)
        self.assertEqual(self.client.get("/api/rooms").json()["rooms"], [])
        joined = self.join(other, private)
        self.assertEqual(joined.status_code, 200, joined.text)
        ids = {p["id"] for p in joined.json()["room"]["players"]}
        self.assertEqual(ids, {owner["user"]["id"], other["user"]["id"]})

    def test_capacity_is_enforced_and_existing_join_is_idempotent(self):
        owner = self.register("Host480")
        other = self.register("Friend480")
        room = self.room(owner, max_players=1)
        self.assertEqual(self.join(owner, room).status_code, 200)
        rejected = self.join(other, room)
        self.assertIn(rejected.status_code, (403, 409), rejected.text)

    def test_room_fields_and_capacity_are_validated(self):
        owner = self.register("Host480")
        for payload in (
            {"name": "Рейс", "public": True, "max_players": 99},
            {"name": "Рейс", "public": True, "max_players": 0},
            {"name": "x" * 1000, "public": True, "max_players": 4},
            {"name": "Рейс", "public": True, "max_players": 4, "host_id": 999},
        ):
            response = self.client.post("/api/rooms", headers=self.auth(owner), json=payload)
            self.assertEqual(response.status_code, 422, response.text)

    def test_host_leave_transfers_ownership_and_empty_room_disappears(self):
        owner = self.register("Host480")
        other = self.register("Friend480")
        room = self.room(owner)
        self.assertEqual(self.join(other, room).status_code, 200)
        left = self.client.post(
            f"/api/rooms/{room['code']}/leave", headers=self.auth(owner), json={}
        )
        self.assertEqual(left.status_code, 200, left.text)
        listed = self.client.get("/api/rooms").json()["rooms"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["host_id"], other["user"]["id"])
        self.client.post(f"/api/rooms/{room['code']}/leave", headers=self.auth(other), json={})
        self.assertEqual(self.client.get("/api/rooms").json()["rooms"], [])
