"""Presence for the original city game; local career earnings are never ranked.

The browser runs the original driving simulation at 60 Hz. This room relays
bounded world-space poses, so its own steering never waits for a round trip.
The old ranked simulation remains available to protocol-v1 clients only.
"""
from __future__ import annotations

import math
import secrets
import time
from dataclasses import dataclass, field

from .config import Settings

COLORS = ("#f5c81e", "#59cbe8", "#e798ff", "#8fe388", "#ff9578", "#9daaff", "#f2a5c6", "#faf5dd")


@dataclass
class CityPlayer:
    id: int
    username: str
    color: str
    number: int
    connected: bool = False
    abandoned: bool = False
    disconnected_at: float | None = field(default_factory=time.monotonic)
    pose: dict | None = None
    pose_at: float = 0.0
    last_spawn: float = 0.0
    keys: dict = field(default_factory=dict)
    input_age: float = 0.0

    def clear_input(self):
        self.keys.clear()

    def snapshot(self):
        return {"id": self.id, "username": self.username, "color": self.color,
                "number": self.number, "connected": self.connected,
                **(self.pose or {"state": "menu"})}


class CityRoom:
    mode = "city"

    def __init__(self, code: str, name: str, public: bool, max_players: int, host_id: int, settings: Settings):
        self.code, self.name, self.public = code, name, public
        self.max_players, self.host_id, self.settings = max_players, host_id, settings
        self.players: dict[int, CityPlayer] = {}
        self.status = "running"
        self.round_id = secrets.token_hex(12)
        self.seed = secrets.randbelow(2**31)
        self.started_at = time.time()
        self.last_active = time.monotonic()
        self.persisted, self.results, self.tick = True, [], 0

    def add(self, user):
        occupied = {p.number for p in self.players.values() if not p.abandoned}
        number = next(n for n in range(1, 9) if n not in occupied)
        self.players[user["id"]] = CityPlayer(user["id"], user["username"], COLORS[number - 1], number)

    def info(self):
        players = [p.snapshot() for p in self.players.values() if not p.abandoned]
        return {"code": self.code, "name": self.name, "public": self.public,
                "mode": self.mode, "max_players": self.max_players, "host_id": self.host_id,
                "status": self.status, "count": len(players), "players": players}

    def step(self, dt):
        self.tick += 1

    def snapshot(self):
        return {"type": "state", "room": self.info(), "players": self.info()["players"],
                "seed": self.seed, "server_time": time.time(), "started_at": self.started_at,
                "tick": self.tick, "results": [], "ranked": False}

    def spawn(self, user_id):
        player = self.players[user_id]
        now = time.monotonic()
        if now - player.last_spawn < 2:
            return False
        player.last_spawn = now
        player.pose = None
        player.pose_at = now
        return True

    def update_pose(self, user_id, message):
        player = self.players[user_id]
        now = time.monotonic()
        pose = message.model_dump(exclude={"type", "seq"})
        if player.pose:
            elapsed = min(30.0, max(0.0, now - player.pose_at))
            distance = math.hypot(pose["wx"] - player.pose["wx"], pose["wy"] - player.pose["wy"])
            # Original buses reach 18.5 px/frame. Turns snap their road centre
            # to an intersection; allow that bounded transition, not teleports.
            turning = pose["state"] == "turning" or player.pose["state"] == "turning"
            allowance = 650 if turning else 100
            if distance > 1200 * elapsed + allowance:
                return False
        player.pose, player.pose_at = pose, now
        self.last_active = now
        return True
