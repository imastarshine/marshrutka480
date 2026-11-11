from pathlib import Path
from contextlib import closing
import asyncio
import sqlite3
import tempfile
import threading
import time
import unittest

from backend.database import Database
from backend.security import RateLimiter, bounded_thread_work, hash_password, token_hash, verify_password


class PasswordTests(unittest.TestCase):
    def test_scrypt_hash_is_salted_and_verifies(self):
        first = hash_password("длинный-пароль-480!")
        second = hash_password("длинный-пароль-480!")
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("scrypt$"))
        self.assertTrue(verify_password("длинный-пароль-480!", first))
        self.assertFalse(verify_password("неправильный-пароль", first))
        self.assertFalse(verify_password("длинный-пароль-480!", "corrupted-hash"))

    def test_rate_limiter_rejects_burst_and_bounds_memory(self):
        limiter = RateLimiter(max_keys=5)
        self.assertTrue(limiter.allow("ip", 2))
        self.assertTrue(limiter.allow("ip", 2))
        self.assertFalse(limiter.allow("ip", 2))
        for i in range(20):
            limiter.allow(f"ip-{i}", 2)
        self.assertLessEqual(len(limiter.entries), 5)


class HashCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_requests_retain_permits_until_threads_finish(self):
        semaphore, pending = asyncio.Semaphore(2), set()
        started, release = threading.Event(), threading.Event()
        lock = threading.Lock()
        active = 0

        def slow_hash():
            nonlocal active
            with lock:
                active += 1
                if active == 2:
                    started.set()
            try:
                if not release.wait(3):
                    raise TimeoutError("Test did not release worker")
                return "hashed"
            finally:
                with lock:
                    active -= 1

        requests = [asyncio.create_task(bounded_thread_work(semaphore, pending, slow_hash)) for _ in range(2)]
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            for request in requests:
                request.cancel()
            await asyncio.gather(*requests, return_exceptions=True)
            self.assertTrue(semaphore.locked())
            self.assertEqual(len(pending), 2)
            # A cancelled HTTP request must not permit another still-running hash.
            with self.assertRaises(TimeoutError):
                await bounded_thread_work(semaphore, pending, lambda: "third")
            self.assertEqual(active, 2)
        finally:
            release.set()
            await asyncio.gather(*requests, return_exceptions=True)
            await asyncio.gather(*list(pending), return_exceptions=True)
        self.assertFalse(pending)
        self.assertFalse(semaphore.locked())
        self.assertEqual(await bounded_thread_work(semaphore, pending, lambda: "next"), "next")


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="marshrutka-storage-")
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "game.sqlite3")
        self.db = Database(self.path)
        # Password hashing is independently tested above; no expensive hashing needed here.
        self.alice = self.db.create_user("Алиса", "not-a-login-hash")
        self.boris = self.db.create_user("Борис", "not-a-login-hash")

    @staticmethod
    def result(user, score=500, stops=2, qualified=True):
        return {
            "id": user["id"], "username": user["username"], "score": score,
            "stops": stops, "distance": 3600.0, "qualified": qualified,
        }

    def test_leaderboard_best_per_user_and_round_idempotency(self):
        results = [self.result(self.alice, 500), self.result(self.boris, 700)]
        self.db.save_results("round-one", results)
        self.db.save_results("round-one", results)
        self.db.save_results("round-two", [self.result(self.alice, 900)])
        self.db.save_results("round-three", [self.result(self.alice, 100)])
        board = self.db.leaderboard(20)
        self.assertEqual([row["username"] for row in board], ["Алиса", "Борис"])
        self.assertEqual([row["score"] for row in board], [900, 700])
        self.assertEqual([row["rank"] for row in board], [1, 2])
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM scores").fetchone()[0], 4)
        self.assertEqual(len(self.db.leaderboard(1)), 1)

    def test_unqualified_round_does_not_enter_leaderboard(self):
        self.db.save_results("unfinished", [self.result(self.alice, 999999, qualified=False)])
        self.assertEqual(self.db.leaderboard(20), [])

    def test_sqlite_constraints_reject_invalid_score_and_missing_user(self):
        for result in (
            self.result(self.alice, score=-1),
            self.result(self.alice, stops=0),
            self.result({"id": 999999, "username": "Absent"}),
        ):
            try:
                self.db.save_results("invalid", [result])
            except sqlite3.IntegrityError:
                pass
        self.assertEqual(self.db.leaderboard(20), [])

    def test_sessions_expire_revoke_and_are_bounded(self):
        expired = token_hash("expired-token")
        valid = token_hash("valid-token")
        self.db.create_session(expired, self.alice["id"], int(time.time()) - 1)
        self.db.create_session(valid, self.alice["id"], int(time.time()) + 3600)
        self.assertIsNone(self.db.session(expired))
        self.assertEqual(self.db.session(valid)["id"], self.alice["id"])
        self.db.revoke_session(valid)
        self.assertIsNone(self.db.session(valid))
        for i in range(12):
            self.db.create_session(token_hash(f"session-{i}"), self.alice["id"], int(time.time()) + 3600)
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertLessEqual(conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 5)
