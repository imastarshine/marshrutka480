from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import OrderedDict

SCRYPT_N, SCRYPT_R, SCRYPT_P = 32768, 8, 3


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024, dklen=32)
    return "scrypt$%d$%d$%d$%s$%s" % (SCRYPT_N, SCRYPT_R, SCRYPT_P, base64.b64encode(salt).decode(), base64.b64encode(digest).decode())


def verify_password(password: str, encoded: str) -> bool:
    try:
        alg, n, r, p, salt, expected = encoded.split("$")
        if alg != "scrypt" or (int(n), int(r), int(p)) != (SCRYPT_N, SCRYPT_R, SCRYPT_P):
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), maxmem=64 * 1024 * 1024, dklen=32)
        return hmac.compare_digest(actual, base64.b64decode(expected))
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


async def bounded_thread_work(semaphore: asyncio.Semaphore, pending: set[asyncio.Task], fn, *args):
    """Retain a hashing permit until the actual thread finishes, even after cancellation.

    Cancelling asyncio.to_thread does not stop its OS thread. A shielded task and
    completion callback therefore own the permit, rather than the HTTP request.
    The pending set keeps workers alive and allows orderly application shutdown.
    """
    async with asyncio.timeout(0.1):
        await semaphore.acquire()
    try:
        worker = asyncio.create_task(asyncio.to_thread(fn,*args))
    except BaseException:
        semaphore.release()
        raise
    pending.add(worker)

    def finished(done: asyncio.Task) -> None:
        pending.discard(done)
        semaphore.release()
        # Consume errors also when the requesting HTTP task has disconnected.
        if not done.cancelled():
            done.exception()

    worker.add_done_callback(finished)
    return await asyncio.shield(worker)


class RateLimiter:
    """Bounded sliding-window counters; process-local, deliberately one worker."""
    def __init__(self, max_keys: int = 10000) -> None:
        self.entries: OrderedDict[str, tuple[float, int]] = OrderedDict()
        self.max_keys = max_keys
        self.lock = threading.Lock()

    def allow(self, key: str, limit: int, seconds: float = 60.0) -> bool:
        now = time.monotonic()
        with self.lock:
            start, count = self.entries.get(key, (now, 0))
            if now - start >= seconds:
                start, count = now, 0
            self.entries[key] = (start, count + 1)
            self.entries.move_to_end(key)
            while len(self.entries) > self.max_keys:
                self.entries.popitem(last=False)
            return count < limit

