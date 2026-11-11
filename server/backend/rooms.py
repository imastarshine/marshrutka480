from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import time
from dataclasses import dataclass, field

from fastapi import HTTPException, WebSocket

from .config import Settings
from .database import Database
from .simulation import Room
from .city import CityRoom

logger = logging.getLogger("marshrutka.rooms")
PUBLIC_CITY_CODE = "IRKUTK"


@dataclass
class Connection:
    user_id: int
    digest: str
    expires_at: int
    room_code: str
    socket: WebSocket
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=3))
    seq: int = -1
    last_horn: float = 0.0

    def send(self, message: dict | str) -> None:
        # A slow browser receives the latest world, never an unbounded backlog.
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        self.queue.put_nowait(message)


class RoomManager:
    def __init__(self, settings: Settings, db: Database) -> None:
        self.settings = settings
        self.db = db
        self.rooms: dict[str,Room | CityRoom] = {}
        self.memberships: dict[int,str] = {}
        self.connections: dict[int,Connection] = {}
        self.task: asyncio.Task | None = None
        self.closed = False

    def public_city(self) -> CityRoom:
        room = self.rooms.get(PUBLIC_CITY_CODE)
        if room is None:
            room = CityRoom(PUBLIC_CITY_CODE, "Общий Иркутск", True, None, 0, self.settings, shared=True)
            self.rooms[PUBLIC_CITY_CODE] = room
        return room

    def create(self, user: dict, name: str, public: bool, max_players: int, mode: str = "arcade") -> Room | CityRoom:
        if user["id"] in self.memberships:
            raise HTTPException(409,"Сначала покиньте текущую комнату")
        if sum(not getattr(room, "shared", False) for room in self.rooms.values()) >= self.settings.max_rooms:
            raise HTTPException(503,"Сервер заполнен. Попробуйте позже")
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        while code in self.rooms or code == PUBLIC_CITY_CODE:
            code = "".join(secrets.choice(alphabet) for _ in range(6))
        room_type = CityRoom if mode == "city" else Room
        room = room_type(code,name,public,max_players,user["id"],self.settings)
        room.add(user)
        self.rooms[code] = room
        self.memberships[user["id"]] = code
        return room

    def join(self, user: dict, code: str) -> Room | CityRoom:
        room = self.public_city() if code == PUBLIC_CITY_CODE else self.rooms.get(code)
        if not room:
            raise HTTPException(404,"Комната не найдена")
        current = self.memberships.get(user["id"])
        if current and current != code:
            raise HTTPException(409,"Сначала покиньте текущую комнату")
        if current == code:
            return room
        if not isinstance(room, CityRoom) and room.status not in {"waiting","finished"}:
            raise HTTPException(409,"Рейс уже начался. Дождитесь окончания")
        if room.max_players is not None and len([p for p in room.players.values() if not p.abandoned]) >= room.max_players:
            raise HTTPException(409,"В комнате нет свободных мест")
        room.add(user)
        self.memberships[user["id"]] = code
        return room

    def connect(self, user: dict, code: str, digest: str, socket: WebSocket) -> Connection:
        room = self.rooms.get(code)
        if not room or self.memberships.get(user["id"]) != code or user["id"] not in room.players:
            raise HTTPException(403,"Сначала войдите в комнату")
        if user["id"] in self.connections:
            raise HTTPException(409,"Этот аккаунт уже подключён в другом окне")
        if self.settings.max_connections and len(self.connections) >= self.settings.max_connections:
            raise HTTPException(503,"Сервер заполнен")
        p = room.players[user["id"]]
        if p.abandoned:
            raise HTTPException(403,"Время переподключения истекло")
        p.connected = True
        p.disconnected_at = None
        p.clear_input()
        room.last_active = time.monotonic()
        conn = Connection(user["id"],digest,user["expires_at"],code,socket)
        self.connections[user["id"]] = conn
        return conn

    def disconnect(self, conn: Connection) -> None:
        if self.connections.get(conn.user_id) is not conn:
            return
        self.connections.pop(conn.user_id,None)
        room = self.rooms.get(conn.room_code)
        if room and conn.user_id in room.players:
            p = room.players[conn.user_id]
            p.connected = False
            p.disconnected_at = time.monotonic()
            p.clear_input()
            self.transfer_host(room)

    def transfer_host(self, room: Room) -> None:
        if getattr(room, "shared", False):
            return
        host = room.players.get(room.host_id)
        if host and host.connected and not host.abandoned:
            return
        candidates = [p.id for p in room.players.values() if p.connected and not p.abandoned]
        if not candidates:
            candidates = [p.id for p in room.players.values() if not p.abandoned]
        if candidates:
            room.host_id = candidates[0]

    def remove(self, user_id: int, code: str) -> None:
        if self.memberships.get(user_id) != code:
            raise HTTPException(403,"Вы не участник этой комнаты")
        self.memberships.pop(user_id,None)
        room = self.rooms.get(code)
        if room:
            p = room.players.get(user_id)
            if p:
                p.connected = False
                p.clear_input()
                if isinstance(room, CityRoom):
                    room.players.pop(user_id, None)
                elif room.status in {"running","countdown"}:
                    p.abandoned = True
                else:
                    room.players.pop(user_id,None)
            self.transfer_host(room)
            if not getattr(room, "shared", False) and not any(not p.abandoned for p in room.players.values()):
                self.rooms.pop(code,None)

    async def leave(self, user_id: int, code: str) -> None:
        self.remove(user_id,code)
        conn = self.connections.get(user_id)
        if conn:
            self.disconnect(conn)
            with contextlib.suppress(Exception):
                await conn.socket.close(code=1000,reason="Вы покинули комнату")

    async def revoke(self, digest: str) -> None:
        for conn in list(self.connections.values()):
            if conn.digest == digest:
                self.disconnect(conn)
                with contextlib.suppress(Exception):
                    await conn.socket.close(code=4001,reason="Сессия завершена")

    def start_round(self, conn: Connection) -> None:
        room = self.rooms.get(conn.room_code)
        if not room:
            raise HTTPException(404,"Комната закрыта")
        if isinstance(room, CityRoom):
            return
        if room.host_id != conn.user_id:
            raise HTTPException(403,"Рейс запускает владелец комнаты")
        if room.status not in {"waiting","finished"}:
            raise HTTPException(409,"Рейс уже запущен")
        if room.status == "finished" and not room.persisted:
            raise HTTPException(409,"Результаты ещё сохраняются")
        room.start()

    def broadcast(self, code: str, message: dict) -> None:
        # Encode a shared world once, not once per connected driver.
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        for conn in list(self.connections.values()):
            if conn.room_code == code:
                conn.send(payload)

    def broadcast_city(self, room: CityRoom) -> None:
        # All drivers share one world tick. Only distant traffic is omitted from
        # an individual packet; overlapping views contain the same actor IDs.
        base = room.snapshot()
        base.pop("traffic")
        prefix = json.dumps(base, ensure_ascii=False, separators=(",", ":"))[:-1] + ',"traffic":'
        for conn in list(self.connections.values()):
            if conn.room_code == room.code:
                traffic = room.traffic.snapshot_for(room.players.get(conn.user_id))
                conn.send(prefix + json.dumps(traffic, ensure_ascii=False, separators=(",", ":")) + "}")

    async def run(self) -> None:
        tick = 0
        previous_tick = time.monotonic()
        while not self.closed:
            before = time.monotonic()
            city_dt = min(.25, max(.001, before - previous_tick))
            previous_tick = before
            tick += 1
            for room in list(self.rooms.values()):
                for p in list(room.players.values()):
                    if not p.connected and not p.abandoned and p.disconnected_at is not None and before-p.disconnected_at>self.settings.reconnect_seconds:
                        if self.memberships.get(p.id)==room.code:
                            self.remove(p.id,room.code)
                if room.code not in self.rooms:
                    continue
                room.step(city_dt if isinstance(room, CityRoom) else 0.05)
                if room.status=="finished" and not room.persisted:
                    try:
                        await asyncio.to_thread(self.db.save_results,room.round_id,room.results)
                        room.persisted = True
                    except Exception:
                        logger.exception("Could not persist completed round %s",room.round_id)
                if tick % 2 == 0:
                    if isinstance(room, CityRoom):
                        self.broadcast_city(room)
                    else:
                        self.broadcast(room.code,room.snapshot())
            if tick % 20 == 0:
                now = time.time()
                for conn in list(self.connections.values()):
                    if conn.expires_at<=now:
                        await self.revoke(conn.digest)
            if tick % 200 == 0:
                for conn in list(self.connections.values()):
                    if not await asyncio.to_thread(self.db.session,conn.digest):
                        await self.revoke(conn.digest)
            await asyncio.sleep(max(0.001,0.05-(time.monotonic()-before)))

    async def shutdown(self) -> None:
        self.closed = True
        for conn in list(self.connections.values()):
            with contextlib.suppress(Exception):
                await conn.socket.close(code=1012,reason="Сервер перезапускается")
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
