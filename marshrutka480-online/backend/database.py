from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class Database:
    """Short connections, parameterized SQL, WAL. Call IO through asyncio.to_thread."""
    def __init__(self, path: str) -> None:
        self.path = str(Path(path).resolve())
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users(
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL,
                    username_key TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions(
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS scores(
                    id INTEGER PRIMARY KEY,
                    round_id TEXT NOT NULL,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    score INTEGER NOT NULL CHECK(score >= 0),
                    stops INTEGER NOT NULL CHECK(stops >= 1),
                    distance REAL NOT NULL CHECK(distance >= 0),
                    completed_at INTEGER NOT NULL,
                    UNIQUE(round_id,user_id)
                );
                CREATE INDEX IF NOT EXISTS scores_best ON scores(user_id,score DESC,completed_at);
                PRAGMA user_version=1;
            """)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create_user(self, username: str, password_hash: str) -> dict:
        with self.connect() as db:
            cur = db.execute("INSERT INTO users(username,username_key,password_hash,created_at) VALUES(?,?,?,?)", (username, username.casefold(), password_hash, int(time.time())))
            return {"id": cur.lastrowid, "username": username}

    def user_for_login(self, username: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT id,username,password_hash FROM users WHERE username_key=?", (username.casefold(),)).fetchone()
            return dict(row) if row else None

    def create_session(self, digest: str, user_id: int, expires_at: int) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()),))
            # Prevent unbounded credential issuance; keep the last four older sessions.
            db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 4)", (user_id, user_id))
            db.execute("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", (digest,user_id,expires_at,int(time.time())))

    def session(self, digest: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT users.id,users.username,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?", (digest, int(time.time()))).fetchone()
            return dict(row) if row else None

    def revoke_session(self, digest: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))

    def save_results(self, round_id: str, results: list[dict]) -> None:
        completed = int(time.time())
        with self.connect() as db:
            for r in results:
                if r["qualified"]:
                    db.execute("INSERT OR IGNORE INTO scores(round_id,user_id,score,stops,distance,completed_at) VALUES(?,?,?,?,?,?)", (round_id,r["id"],r["score"],r["stops"],r["distance"],completed))

    def leaderboard(self, limit: int) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("""
                SELECT username,score,stops,distance,completed_at FROM (
                    SELECT users.username,scores.*,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY score DESC,stops DESC,completed_at ASC,scores.id ASC) AS own_rank
                    FROM scores JOIN users ON users.id=scores.user_id
                ) WHERE own_rank=1 ORDER BY score DESC,stops DESC,completed_at ASC,username ASC LIMIT ?
            """, (limit,)).fetchall()
            return [{"rank": i+1, **dict(row)} for i,row in enumerate(rows)]

