import json
from unittest.mock import patch

from starlette.websockets import WebSocketDisconnect

from tests.support import AppCase, ORIGIN


class WebSocketTests(AppCase):
    def socket(self, **kwargs):
        return self.client.websocket_connect("/ws", headers={"Origin": ORIGIN}, **kwargs)

    def test_auth_and_ping_and_server_state(self):
        session = self.register()
        room = self.room(session)
        with self.socket() as ws:
            welcome = self.ws_auth(ws, session, room)
            self.assertEqual(welcome["protocol"], 1)
            state = self.receive_type(ws, "state")
            self.assertEqual(state["room"]["code"], room["code"])
            self.assertEqual(state["players"][0]["id"], session["user"]["id"])
            ws.send_json({"type": "ping", "t": 12345})
            self.assertEqual(self.receive_type(ws, "pong")["t"], 12345)

    def test_forbidden_origin_is_rejected_before_auth(self):
        for origin in ("https://evil.example", "http://testserver.evil.example", "null"):
            with self.subTest(origin=origin):
                with self.assertRaises(WebSocketDisconnect):
                    with self.client.websocket_connect("/ws", headers={"Origin": origin}) as ws:
                        self.receive_json(ws)

    def test_first_message_must_authenticate(self):
        with self.assertRaises(WebSocketDisconnect):
            with self.socket() as ws:
                ws.send_json({"type": "input", "seq": 1, "up": True})
                self.receive_json(ws)

    def test_fake_session_and_nonmember_room_are_rejected(self):
        owner = self.register("Owner480")
        outsider = self.register("Stranger480")
        room = self.room(owner)
        for token in ("a" * 43, outsider["token"]):
            with self.subTest(fake=token == "a" * 43):
                with self.assertRaises(WebSocketDisconnect):
                    with self.socket() as ws:
                        ws.send_json({"type": "auth", "token": token, "room": room["code"]})
                        for _ in range(3):
                            self.receive_json(ws)

    def test_duplicate_socket_is_rejected(self):
        session = self.register()
        room = self.room(session)
        with self.socket() as first:
            self.ws_auth(first, session, room)
            with self.assertRaises(WebSocketDisconnect) as closed:
                with self.socket() as duplicate:
                    duplicate.send_json({"type": "auth", "token": session["token"], "room": room["code"]})
                    for _ in range(3):
                        self.receive_json(duplicate)
            self.assertEqual(closed.exception.code, 4009)
            first.send_json({"type": "ping", "t": 9})
            self.assertEqual(self.receive_type(first, "pong")["t"], 9)

    def test_only_host_can_start_and_late_join_is_rejected(self):
        host, guest, late = self.register("Host480"), self.register("Guest480"), self.register("Late480")
        room = self.room(host)
        self.assertEqual(self.join(guest, room).status_code, 200)
        with self.socket() as host_ws, self.socket() as guest_ws:
            self.ws_auth(host_ws, host, room)
            self.ws_auth(guest_ws, guest, room)
            guest_ws.send_json({"type": "start"})
            refused = self.receive_type(guest_ws, "error")
            self.assertIn("detail", refused)
            self.assertEqual(self.receive_type(guest_ws, "state")["room"]["status"], "waiting")
            host_ws.send_json({"type": "start"})
            for _ in range(20):
                state = self.receive_type(host_ws, "state")
                if state["room"]["status"] != "waiting":
                    break
            self.assertEqual(state["room"]["status"], "countdown")
            self.assertIn(self.join(late, room).status_code, (403, 409))

    def test_client_coordinates_and_scores_are_not_accepted(self):
        session = self.register()
        room = self.room(session)
        with self.assertRaises(WebSocketDisconnect) as closed:
            with self.socket() as ws:
                self.ws_auth(ws, session, room)
                ws.send_json({"type": "input", "seq": 1, "up": True, "x": 550, "z": 1000, "score": 999999})
                self.assertIn("detail", self.receive_type(ws, "error"))
                state = self.receive_type(ws, "state")
                self.assertEqual(state["players"][0]["score"], 0)
                self.assertEqual(state["players"][0]["z"], 0)
                for seq in (2, 3):
                    ws.send_json({"type": "input", "seq": seq, "score": 999999})
                for _ in range(10):
                    self.receive_json(ws)
        self.assertEqual(closed.exception.code, 1008)
        self.assertEqual(self.client.get("/api/leaderboard").json()["entries"], [])

    def test_malformed_binary_and_oversized_messages_are_closed(self):
        session = self.register()
        room = self.room(session)
        for payload in ("{broken", b"\x00\xff", "x" * 4096):
            with self.subTest(kind=type(payload).__name__, size=len(payload)):
                with self.assertRaises(WebSocketDisconnect) as closed:
                    with self.socket() as ws:
                        self.ws_auth(ws, session, room)
                        if isinstance(payload, bytes):
                            ws.send_bytes(payload)
                        else:
                            ws.send_text(payload)
                        for _ in range(10):
                            self.receive_json(ws)
                self.assertIn(closed.exception.code, (1003, 1008, 1009))

    def test_repeated_sequence_number_is_rejected(self):
        session = self.register()
        room = self.room(session)
        with self.assertRaises(WebSocketDisconnect) as closed:
            with self.socket() as ws:
                self.ws_auth(ws, session, room)
                message = {"type": "input", "seq": 100, "up": True}
                ws.send_json(message)
                for _ in range(3):
                    ws.send_json(message)
                for _ in range(10):
                    self.receive_json(ws)
        self.assertEqual(closed.exception.code, 1008)

    def test_reconnect_keeps_player_and_room(self):
        session = self.register()
        room = self.room(session)
        with self.socket() as ws:
            self.ws_auth(ws, session, room)
            first = self.receive_type(ws, "state")
        with self.socket() as ws:
            self.ws_auth(ws, session, room)
            second = self.receive_type(ws, "state")
            self.assertEqual(second["players"][0]["id"], first["players"][0]["id"])
            self.assertEqual(second["players"][0]["z"], first["players"][0]["z"])
            self.assertEqual(second["room"]["code"], first["room"]["code"])
            self.assertTrue(second["players"][0]["connected"])

    def test_logout_closes_websocket_and_revokes_token(self):
        session = self.register()
        room = self.room(session)
        with self.assertRaises(WebSocketDisconnect) as closed:
            with self.socket() as ws:
                self.ws_auth(ws, session, room)
                response = self.client.post("/api/auth/logout", headers=self.auth(session))
                self.assertEqual(response.status_code, 200, response.text)
                for _ in range(10):
                    self.receive_json(ws)
        self.assertEqual(closed.exception.code, 4001)
        self.assertEqual(self.client.get("/api/auth/me", headers=self.auth(session)).status_code, 401)

    def test_room_state_isolation(self):
        first, second = self.register("First480"), self.register("Second480")
        room1, room2 = self.room(first), self.room(second)
        with self.socket() as socket1, self.socket() as socket2:
            self.ws_auth(socket1, first, room1)
            self.ws_auth(socket2, second, room2)
            state1, state2 = self.receive_type(socket1, "state"), self.receive_type(socket2, "state")
            self.assertEqual([p["id"] for p in state1["players"]], [first["user"]["id"]])
            self.assertEqual([p["id"] for p in state2["players"]], [second["user"]["id"]])
            self.assertNotEqual(state1["room"]["code"], state2["room"]["code"])

    def test_message_flood_is_closed(self):
        session = self.register()
        room = self.room(session)
        with self.assertRaises(WebSocketDisconnect) as closed:
            with self.socket() as ws:
                self.ws_auth(ws, session, room)
                for number in range(75):
                    ws.send_json({"type": "ping", "t": number})
                for _ in range(100):
                    self.receive_json(ws)
        self.assertEqual(closed.exception.code, 4008)

    def test_expired_session_closes_active_socket(self):
        session = self.register()
        room = self.room(session)
        with self.assertRaises(WebSocketDisconnect) as closed:
            with self.socket() as ws:
                self.ws_auth(ws, session, room)
                self.client.portal.call(
                    lambda: setattr(self.app.state.rooms.connections[session["user"]["id"]], "expires_at", 0)
                )
                for _ in range(20):
                    self.receive_json(ws)
        self.assertEqual(closed.exception.code, 4001)

    def test_json_parser_recursion_failure_closes_socket_without_server_error(self):
        session = self.register()
        room = self.room(session)
        payload = "[" * 1000 + "0" + "]" * 1000  # Below the 2048-byte frame limit.
        original_loads = json.loads

        def limited_parser(value, *args, **kwargs):
            # CPython builds have different C-stack limits. Inject the parser's
            # real failure category so this regression is deterministic everywhere.
            if value == payload:
                raise RecursionError("JSON nested too deeply")
            return original_loads(value, *args, **kwargs)

        with self.assertRaises(WebSocketDisconnect) as closed:
            with self.socket() as ws:
                self.ws_auth(ws, session, room)
                with patch("backend.main.json.loads", side_effect=limited_parser):
                    ws.send_text(payload)
                    for _ in range(10):
                        self.receive_json(ws)
        self.assertEqual(closed.exception.code, 1008)
        self.assertEqual(self.client.get("/api/health").status_code, 200)
