"""Pure authoritative simulation: wall-clock tick size is chosen by the server.

No client-supplied coordinates, clocks, fares or scores enter this module.
Pixels use the original game's scale; multiplayer has a shared straight route.
"""
from __future__ import annotations

import math
import secrets
import time
from dataclasses import dataclass, field

from .config import Settings

STREETS = ("ул. Ленина", "ул. Карла Маркса", "ул. Байкальская", "ул. Дзержинского", "ул. Тимирязева", "ул. Седова", "ул. Декабрьских Событий", "ул. Карла Либкнехта")
STOP_NAMES = ("Сквер Кирова", "Художественный музей", "Драмтеатр", "130-й квартал", "Центральный рынок", "Музыкальный театр", "Танк «Иркутский комсомолец»", "Баргузин", "Декабристов", "Автовокзал", "Дом Европы", "Нижняя набережная")
COLORS = ("#f5c81e", "#59cbe8", "#e798ff", "#8fe388", "#ff9578", "#9daaff", "#f2a5c6", "#faf5dd")
CAR_COLORS = ("#c95d58", "#6b91bc", "#80a27a", "#bcbfb9", "#a38fba")
MAX_SPEED = 600.0
STOP_GAP = 1800.0
FIRST_STOP = 1000.0


@dataclass
class Player:
    id: int
    username: str
    color: str
    x: float = 411.0
    z: float = 0.0
    speed: float = 0.0
    score: int = 0
    stops: int = 0
    distance: float = 0.0
    connected: bool = False
    disconnected_at: float | None = None
    keys: dict[str, bool] = field(default_factory=lambda: dict(up=False,down=False,left=False,right=False))
    input_age: float = 1.0
    invulnerable: float = 0.0
    boarding: float = 0.0
    served: set[int] = field(default_factory=set)
    abandoned: bool = False

    def reset(self, index: int) -> None:
        self.x = 411.0 + (74.0 if index % 2 else 0.0)
        self.z = -(index // 2) * 150.0
        self.speed = self.distance = self.invulnerable = self.boarding = 0.0
        self.score = self.stops = 0
        self.served.clear()
        self.clear_input()

    def clear_input(self) -> None:
        self.keys = dict(up=False,down=False,left=False,right=False)
        self.input_age = 1.0

    def snapshot(self) -> dict:
        next_stop = max(0, math.ceil((self.z - 90 - FIRST_STOP) / STOP_GAP))
        while next_stop in self.served:
            next_stop += 1
        return {
            "id": self.id,"username": self.username,"color": self.color,
            "x": round(self.x,2),"z": round(self.z,2),"speed": round(self.speed,2),
            "score": self.score,"stops": self.stops,"distance": round(self.distance,2),
            "connected": self.connected,"invulnerable": self.invulnerable > 0,
            "boarding": round(min(1.0,self.boarding / 1.5),3),"next_stop": next_stop,
            "street": STREETS[int(max(0,self.z)/3600)%len(STREETS)],
        }


@dataclass
class Room:
    code: str
    name: str
    public: bool
    max_players: int
    host_id: int
    settings: Settings
    players: dict[int, Player] = field(default_factory=dict)
    status: str = "waiting"
    seed: int = field(default_factory=lambda: secrets.randbelow(1000000))
    elapsed: float = 0.0
    countdown: float = 0.0
    tick: int = 0
    round_id: str = ""
    results: list[dict] = field(default_factory=list)
    stop_remaining: dict[int,int] = field(default_factory=dict)
    last_active: float = field(default_factory=time.monotonic)
    persisted: bool = False
    finished_at: float | None = None

    def add(self, user: dict) -> Player:
        existing = self.players.get(user["id"])
        if existing and not existing.abandoned:
            return existing
        p = Player(user["id"],user["username"],COLORS[len(self.players) % len(COLORS)])
        p.disconnected_at = time.monotonic()
        p.reset(len(self.players))
        self.players[p.id] = p
        self.last_active = time.monotonic()
        return p

    def info(self) -> dict:
        return {"code":self.code,"name":self.name,"public":self.public,"max_players":self.max_players,"host_id":self.host_id,"status":self.status,"players":[{"id":p.id,"username":p.username,"connected":p.connected} for p in self.players.values() if not p.abandoned],"count":sum(not p.abandoned for p in self.players.values())}

    def start(self) -> None:
        self.round_id = secrets.token_hex(16)
        self.elapsed = 0.0
        self.tick = 0
        self.countdown = self.settings.countdown_seconds
        self.status = "countdown" if self.countdown > 0 else "running"
        self.results.clear()
        self.stop_remaining.clear()
        self.persisted = False
        self.finished_at = None
        # Disconnected users may reconnect during a running shift; abandoned users cannot.
        self.players = {uid:p for uid,p in self.players.items() if not p.abandoned}
        for index,p in enumerate(self.players.values()):
            p.reset(index)

    def waiting(self, stop_id: int) -> int:
        return self.stop_remaining.get(stop_id,7 + (self.seed + stop_id * 17) % 6)

    def stop(self, stop_id: int) -> dict:
        return {"id":stop_id,"name":STOP_NAMES[stop_id % len(STOP_NAMES)],"z":FIRST_STOP+stop_id*STOP_GAP,"waiting":self.waiting(stop_id),"street":STREETS[(stop_id // 2) % len(STREETS)]}

    def npcs(self) -> list[dict]:
        out: dict[str,dict] = {}
        for p in self.players.values():
            if p.abandoned:
                continue
            for lane,(x,speed) in enumerate(((189,-200),(263,-240),(337,185),(411,235),(485,155))):
                center = math.floor((p.z - speed*self.elapsed - 900 - lane*340) / 2200)
                for n in range(center-1,center+2):
                    z = n*2200 + 900 + lane*340 + speed*self.elapsed
                    if abs(z-p.z) <= 1500:
                        ident = f"{lane}:{n}"
                        out[ident] = {"id":ident,"x":x,"z":round(z,2),"speed":speed,"color":CAR_COLORS[lane]}
        return list(out.values())

    def step(self, dt: float) -> bool:
        """Advance by one server-selected step; return True on newly finished round."""
        self.tick += 1
        if self.status == "countdown":
            self.countdown = max(0.0,self.countdown-dt)
            if self.countdown <= 1e-6:
                self.status = "running"
            return False
        if self.status != "running":
            return False
        dt = min(dt,0.1)  # a delayed process must never jump physics forward
        self.elapsed = min(self.settings.round_seconds,self.elapsed+dt)
        cars = self.npcs()
        for p in self.players.values():
            if p.abandoned:
                continue
            p.input_age += dt
            p.invulnerable = max(0,p.invulnerable-dt)
            keys = p.keys if p.connected and p.input_age <= 0.5 else {}
            acceleration = 170 if keys.get("up") and not keys.get("down") else -65
            if keys.get("down") or not p.connected or p.input_age > 0.5:
                acceleration = -450
            p.speed = max(0.0,min(MAX_SPEED,p.speed+acceleration*dt))
            steer = int(keys.get("right",False))-int(keys.get("left",False))
            p.x = max(106.0,min(562.0,p.x+steer*220*dt))
            moved = p.speed*dt
            p.z += moved
            p.distance += moved
            if p.invulnerable <= 0 and p.speed > 2:
                for npc in cars:
                    if abs(p.x-npc["x"]) < 45 and abs(p.z-npc["z"]) < 91:
                        p.speed *= 0.15
                        p.score = max(0,p.score-90)
                        p.invulnerable = 2.5
                        break
            stop_id = max(0,round((p.z-FIRST_STOP)/STOP_GAP))
            stop_z = FIRST_STOP+stop_id*STOP_GAP
            eligible = p.connected and p.x >= 535 and p.speed <= 18 and abs(p.z-stop_z) <= 90 and stop_id not in p.served and self.waiting(stop_id)>0
            if eligible:
                p.boarding += dt
                if p.boarding + 1e-8 >= 1.5:
                    count = min(4,self.waiting(stop_id))
                    self.stop_remaining[stop_id] = self.waiting(stop_id)-count
                    p.score += 60*count+40
                    p.stops += 1
                    p.served.add(stop_id)
                    p.boarding = 0.0
            else:
                p.boarding = 0.0
        if self.elapsed + 1e-6 >= self.settings.round_seconds:
            self.status = "finished"
            self.finished_at = time.monotonic()
            self.results = sorted(({
                "id":p.id,"username":p.username,"score":p.score,"stops":p.stops,
                "distance":round(p.distance,2),"qualified":not p.abandoned and p.stops>=1,
            } for p in self.players.values()),key=lambda r:(-r["score"],-r["stops"],r["id"]))
            for p in self.players.values():
                p.speed = 0.0
                p.clear_input()
            return True
        return False

    def snapshot(self) -> dict:
        visible_stops: set[int] = set()
        positions = [p.z for p in self.players.values() if not p.abandoned]
        for z in positions:
            center = max(0,math.floor((z-FIRST_STOP)/STOP_GAP))
            visible_stops.update(range(max(0,center-1),center+3))
        return {"type":"state","room":self.info(),"tick":self.tick,
                "time_left":round(max(0,self.settings.round_seconds-self.elapsed),2),
                "countdown":round(self.countdown,2),
                "street":STREETS[int(max(positions,default=0)/3600)%len(STREETS)],
                "players":[p.snapshot() for p in self.players.values() if not p.abandoned],
                "npcs":self.npcs(),"stops":[self.stop(s) for s in sorted(visible_stops)],
                "results":self.results,"server_time":time.time()}
