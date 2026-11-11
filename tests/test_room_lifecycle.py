import asyncio
import time
import unittest

from fastapi import HTTPException

from backend.config import Settings
from backend.rooms import RoomManager


class DummyDatabase:
    def __init__(self):
        self.saved = []

    def save_results(self, round_id, results):
        self.saved.append((round_id, results))

    def session(self, digest):
        return {"id": 1}


class DummySocket:
    def __init__(self):
        self.closed = None

    async def close(self, code, reason=""):
        self.closed = code


def user(uid):
    return {"id": uid, "username": f"Driver{uid}", "expires_at": int(time.time()) + 3600}


class RoomLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.manager = RoomManager(Settings(countdown_seconds=0), DummyDatabase())

    def test_one_membership_per_account_and_room_limit(self):
        first = self.manager.create(user(1), "Первый", True, 2)
        second = self.manager.create(user(2), "Второй", True, 2)
        with self.assertRaises(HTTPException) as context:
            self.manager.join(user(1), second.code)
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(self.manager.memberships[1], first.code)
        bounded = RoomManager(Settings(max_rooms=1), DummyDatabase())
        bounded.create(user(1), "Первый", True, 2)
        with self.assertRaises(HTTPException) as context:
            bounded.create(user(2), "Второй", True, 2)
        self.assertEqual(context.exception.status_code, 503)

    def test_host_disconnect_transfers_to_connected_player(self):
        room = self.manager.create(user(1), "Рейс", True, 4)
        self.manager.join(user(2), room.code)
        host = self.manager.connect(user(1), room.code, "first-hash", DummySocket())
        self.manager.connect(user(2), room.code, "second-hash", DummySocket())
        self.manager.disconnect(host)
        self.assertEqual(room.host_id, 2)
        self.assertFalse(room.players[1].connected)
        self.assertIsNotNone(room.players[1].disconnected_at)

    def test_abandoned_player_can_join_after_finished_round(self):
        room = self.manager.create(user(1), "Рейс", True, 4)
        self.manager.join(user(2), room.code)
        room.start()
        self.manager.remove(2, room.code)
        self.assertTrue(room.players[2].abandoned)
        self.assertNotIn(2, self.manager.memberships)
        room.status = "finished"
        self.manager.join(user(2), room.code)
        self.assertFalse(room.players[2].abandoned)
        self.manager.connect(user(2), room.code, "second-hash", DummySocket())
        self.assertTrue(room.players[2].connected)

    def test_slow_consumer_queue_keeps_only_bounded_latest_state(self):
        room = self.manager.create(user(1), "Рейс", True, 4)
        conn = self.manager.connect(user(1), room.code, "hash", DummySocket())
        for tick in range(1000):
            conn.send({"type": "state", "tick": tick})
        self.assertLessEqual(conn.queue.qsize(), 3)
        messages = []
        while not conn.queue.empty():
            messages.append(conn.queue.get_nowait())
        self.assertEqual(messages[-1]["tick"], 999)


class RoomCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_grace_expiry_removes_empty_room(self):
        manager = RoomManager(Settings(reconnect_seconds=.01), DummyDatabase())
        room = manager.create(user(1), "Рейс", True, 4)
        room.players[1].disconnected_at = time.monotonic() - 1
        manager.task = asyncio.create_task(manager.run())
        try:
            await asyncio.sleep(.08)
            self.assertEqual(manager.rooms, {})
            self.assertEqual(manager.memberships, {})
        finally:
            await manager.shutdown()

    async def test_revoking_session_disconnects_only_its_socket(self):
        manager = RoomManager(Settings(), DummyDatabase())
        room = manager.create(user(1), "Рейс", True, 4)
        manager.join(user(2), room.code)
        first, second = DummySocket(), DummySocket()
        manager.connect(user(1), room.code, "first-hash", first)
        manager.connect(user(2), room.code, "second-hash", second)
        await manager.revoke("first-hash")
        self.assertEqual(first.closed, 4001)
        self.assertIsNone(second.closed)
        self.assertNotIn(1, manager.connections)
        self.assertIn(2, manager.connections)
        self.assertEqual(room.host_id, 2)
