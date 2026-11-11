"""Small durable scene reports stored beside the configured shared game DB."""
from __future__ import annotations

import json
import math
import os
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import time
import uuid


# The pinned OSM importer uses this local equirectangular projection.
ORIGIN_LAT, ORIGIN_LON = 52.28, 104.28
EARTH_RADIUS = 6371008.8
METERS_PER_UNIT = 7 / 3.6 / 60
POSE_FIELDS = ("wx", "wy", "lateral", "angle", "speed", "route", "state", "edge")


class BugReportStore:
    def __init__(self, game_db_path: str) -> None:
        # Release directories are replaced during deploys; M480_DATABASE lives
        # in the persistent shared data directory, as does this separate DB.
        self.path = Path(game_db_path).resolve().with_name("bug-reports.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS bug_reports(
                id TEXT PRIMARY KEY,
                server_time REAL NOT NULL,
                user_id INTEGER NOT NULL,
                record_json TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS bug_reports_time ON bug_reports(server_time)")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA busy_timeout=5000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def add(self, user_id: int, report: dict, *, revision: str,
            room: str | None, server_pose: dict | None) -> str:
        report = dict(report)
        # GPS is derived by the server, rather than trusting optional client GPS.
        report["lat"] = ORIGIN_LAT - math.degrees(report["wy"] * METERS_PER_UNIT / EARTH_RADIUS)
        report["lon"] = ORIGIN_LON + math.degrees(report["wx"] * METERS_PER_UNIT /
                                              (EARTH_RADIUS * math.cos(math.radians(ORIGIN_LAT))))
        record_id, now = uuid.uuid4().hex, time.time()
        pose = {key: server_pose[key] for key in POSE_FIELDS if key in server_pose} if server_pose else None
        record = {"id": record_id, "server_time": now, "server_revision": revision,
                  "user_id": user_id, "room": room, "report": report, "server_pose": pose}
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self._connect() as db:
            db.execute("INSERT INTO bug_reports(id,server_time,user_id,record_json) VALUES(?,?,?,?)",
                       (record_id, now, user_id, encoded))
        return record_id
