from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .assets import versioned_index
from .config import Settings
from .database import Database
from .middleware import SecurityMiddleware
from .models import ActionMessage, AuthMessage, CityPoseMessage, CreateRoom, Credentials, EmptyBody, InputMessage, PingMessage
from .city import CityRoom
from .rooms import Connection, RoomManager
from .security import RateLimiter, bounded_thread_work, hash_password, token_hash, verify_password

logger = logging.getLogger("marshrutka")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{40,128}\Z")
CODE_PATTERN = re.compile(r"[A-Z2-9]{6}\Z")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    limiter = RateLimiter()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.db = Database(settings.db_path)
        app.state.rooms = RoomManager(settings,app.state.db)
        app.state.manager = app.state.rooms
        app.state.store = app.state.db
        app.state.hash_slots = asyncio.Semaphore(2)
        app.state.hash_tasks = set()
        app.state.dummy_hash = await asyncio.to_thread(hash_password,secrets.token_urlsafe(24))
        app.state.pending_ws = {}
        app.state.rooms.task = asyncio.create_task(app.state.rooms.run(),name="authoritative-world")
        try:
            yield
        finally:
            await app.state.rooms.shutdown()
            if app.state.hash_tasks:
                await asyncio.shield(asyncio.gather(*app.state.hash_tasks,return_exceptions=True))

    app = FastAPI(title="Маршрутка 480",version="1.0.0",lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    app.state.settings = settings
    app.state.limiter = limiter
    app.add_middleware(SecurityMiddleware,settings=settings,limiter=limiter)
    app.add_middleware(CORSMiddleware,allow_origins=list(settings.allowed_origins),allow_credentials=False,allow_methods=["GET","POST","OPTIONS"],allow_headers=["Authorization","Content-Type"],max_age=600)
    app.add_middleware(TrustedHostMiddleware,allowed_hosts=list(settings.allowed_hosts))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Never echo a password, token, or complete untrusted message in errors/logs.
        fields = [{"field":".".join(map(str,e["loc"])),"message":e["msg"]} for e in exc.errors()]
        return JSONResponse(status_code=422,content={"detail":"Проверьте поля запроса","fields":fields})

    def ip(request: Request | WebSocket) -> str:
        return request.client.host if request.client else "unknown"

    def rate(key: str, limit: int, seconds: float=60) -> None:
        if not limiter.allow(key,limit,seconds):
            raise HTTPException(429,"Слишком много попыток. Попробуйте позже",headers={"Retry-After":str(int(seconds))})

    async def identity(request: Request) -> dict:
        header = request.headers.get("authorization","")
        scheme,_,token = header.partition(" ")
        if scheme.lower()!="bearer" or not TOKEN_PATTERN.fullmatch(token):
            raise HTTPException(401,"Требуется вход",headers={"WWW-Authenticate":"Bearer"})
        digest = token_hash(token)
        user = await asyncio.to_thread(app.state.db.session,digest)
        if not user:
            raise HTTPException(401,"Сессия истекла. Войдите снова",headers={"WWW-Authenticate":"Bearer"})
        return {**user,"digest":digest}

    async def password_work(fn,*args):
        try:
            return await bounded_thread_work(app.state.hash_slots,app.state.hash_tasks,fn,*args)
        except TimeoutError:
            raise HTTPException(503,"Сервер занят. Повторите вход через несколько секунд")

    async def issue(user: dict) -> dict:
        token = secrets.token_urlsafe(32)
        expires = int(time.time())+settings.session_seconds
        await asyncio.to_thread(app.state.db.create_session,token_hash(token),user["id"],expires)
        return {"token":token,"expires_at":expires,"user":{"id":user["id"],"username":user["username"]}}

    def code_value(code: str) -> str:
        code = code.upper()
        if not CODE_PATTERN.fullmatch(code):
            raise HTTPException(404,"Комната не найдена")
        return code

    @app.get("/api/health")
    async def health():
        return {"ok":True,"version":"2.1.2","protocol":1,"features":["original-city","world-poses","irkutsk-routes"]}

    @app.post("/api/auth/register",status_code=201)
    async def register(body: Credentials, request: Request):
        rate("register:"+ip(request),settings.register_limit,600)
        rate("auth:"+ip(request),settings.auth_limit)
        hashed = await password_work(hash_password,body.password)
        try:
            user = await asyncio.to_thread(app.state.db.create_user,body.username,hashed)
        except sqlite3.IntegrityError:
            raise HTTPException(409,"Это имя уже занято")
        return await issue(user)

    @app.post("/api/auth/login")
    async def login(body: Credentials, request: Request):
        rate("auth:"+ip(request),settings.auth_limit)
        rate("account:"+body.username.casefold(),max(20,settings.auth_limit*2))
        user = await asyncio.to_thread(app.state.db.user_for_login,body.username)
        valid = await password_work(verify_password,body.password,user["password_hash"] if user else app.state.dummy_hash)
        if not user or not valid:
            raise HTTPException(401,"Неверное имя или пароль")
        return await issue(user)

    @app.get("/api/auth/me")
    async def me(user=Depends(identity)):
        return {"user":{"id":user["id"],"username":user["username"]}}

    @app.post("/api/auth/logout")
    async def logout(user=Depends(identity)):
        await asyncio.to_thread(app.state.db.revoke_session,user["digest"])
        await app.state.rooms.revoke(user["digest"])
        return {"ok":True}

    @app.get("/api/leaderboard")
    async def leaderboard(limit: int=Query(default=20,ge=1,le=100)):
        return {"entries":await asyncio.to_thread(app.state.db.leaderboard,limit),"mode":"online"}

    @app.get("/api/rooms")
    async def rooms():
        return {"rooms":[r.info() for r in app.state.rooms.rooms.values() if r.public]}

    @app.post("/api/rooms",status_code=201)
    async def create_room(body: CreateRoom, user=Depends(identity)):
        rate("rooms:"+str(user["id"]),12)
        room = app.state.rooms.create(user,body.name,body.public,body.max_players,body.mode)
        return {"room":room.info()}

    @app.post("/api/rooms/{code}/join")
    async def join_room(code: str, body: EmptyBody, user=Depends(identity)):
        rate("join:"+str(user["id"]),20)
        room = app.state.rooms.join(user,code_value(code))
        return {"room":room.info()}

    @app.post("/api/rooms/{code}/leave")
    async def leave_room(code: str, body: EmptyBody, user=Depends(identity)):
        await app.state.rooms.leave(user["id"],code_value(code))
        return {"ok":True}

    async def read_message(ws: WebSocket,timeout: float) -> dict:
        event = await asyncio.wait_for(ws.receive(),timeout)
        if event["type"]=="websocket.disconnect":
            raise WebSocketDisconnect(event.get("code",1000))
        raw = event.get("text")
        if raw is None:
            await ws.close(code=1003,reason="Ожидается JSON-текст")
            raise WebSocketDisconnect(1003)
        if len(raw.encode("utf-8"))>settings.ws_limit:
            await ws.close(code=1009,reason="Сообщение слишком большое")
            raise WebSocketDisconnect(1009)
        value = json.loads(raw)
        if not isinstance(value,dict):
            raise ValueError("JSON object required")
        return value

    async def sender(conn: Connection):
        try:
            while True:
                message = await conn.queue.get()
                await asyncio.wait_for(conn.socket.send_json(message),timeout=2)
        except (WebSocketDisconnect,RuntimeError,TimeoutError):
            with contextlib.suppress(Exception):
                await conn.socket.close(code=4008,reason="Соединение слишком медленное")

    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        peer = ip(ws)
        if ws.headers.get("origin") not in settings.allowed_origins:
            await ws.close(code=4003)
            return
        if not limiter.allow("ws-open:"+peer,20):
            await ws.close(code=4008)
            return
        pending = app.state.pending_ws
        if pending.get(peer,0)>=4 or sum(pending.values())+len(app.state.rooms.connections)>=settings.max_connections:
            await ws.close(code=4008)
            return
        pending[peer] = pending.get(peer,0)+1
        conn = None
        write_task = None
        admitted = False
        try:
            await ws.accept()
            auth = AuthMessage.model_validate(await read_message(ws,5))
            digest = token_hash(auth.token)
            user = await asyncio.to_thread(app.state.db.session,digest)
            if not user:
                await ws.close(code=4001,reason="Требуется вход")
                return
            try:
                conn = app.state.rooms.connect(user,auth.room,digest,ws)
            except HTTPException as exc:
                await ws.send_json({"type":"error","detail":exc.detail})
                await ws.close(code=4009 if exc.status_code==409 else 4003)
                return
            pending[peer] -= 1
            if not pending[peer]:
                pending.pop(peer,None)
            admitted = True
            await ws.send_json({"type":"welcome","player_id":user["id"],"protocol":1})
            write_task = asyncio.create_task(sender(conn))
            conn.send(app.state.rooms.rooms[auth.room].snapshot())
            invalid = 0
            while True:
                message = await read_message(ws,35)
                if not limiter.allow("ws-msg:"+str(user["id"]),60,1):
                    await ws.close(code=4008,reason="Слишком много сообщений")
                    break
                # A removed/revoked socket must not perform actions during its close handshake.
                if app.state.rooms.connections.get(user["id"]) is not conn or user["expires_at"]<=time.time():
                    await ws.close(code=4001,reason="Сессия завершена")
                    break
                room = app.state.rooms.rooms.get(conn.room_code)
                if not room or app.state.rooms.memberships.get(conn.user_id)!=conn.room_code:
                    await ws.close(code=4004,reason="Комната закрыта")
                    break
                try:
                    if message.get("type")=="pose":
                        if not isinstance(room, CityRoom):
                            raise ValueError("City room required")
                        obj = CityPoseMessage.model_validate(message)
                        if obj.seq <= conn.seq:
                            raise ValueError("replayed pose sequence")
                        conn.seq = obj.seq
                        if not room.update_pose(conn.user_id, obj):
                            conn.send({"type":"correction","pose":room.players[conn.user_id].pose})
                    elif message.get("type")=="input":
                        obj = InputMessage.model_validate(message)
                        if obj.seq<=conn.seq:
                            raise ValueError("replayed input sequence")
                        conn.seq = obj.seq
                        p = room.players[conn.user_id]
                        p.keys = {key:getattr(obj,key) for key in ("up","down","left","right")}
                        p.input_age = 0.0
                    elif message.get("type")=="ping":
                        obj = PingMessage.model_validate(message)
                        conn.send({"type":"pong","t":obj.t})
                    else:
                        obj = ActionMessage.model_validate(message)
                        if obj.type=="start":
                            app.state.rooms.start_round(conn)
                        elif obj.type=="leave":
                            await app.state.rooms.leave(conn.user_id,conn.room_code)
                            break
                        elif obj.type=="horn":
                            now = time.monotonic()
                            if now-conn.last_horn>=2:
                                conn.last_horn = now
                                app.state.rooms.broadcast(conn.room_code,{"type":"horn","player_id":conn.user_id})
                        elif obj.type=="spawn":
                            if not isinstance(room, CityRoom):
                                raise ValueError("City room required")
                            if not room.spawn(conn.user_id):
                                conn.send({"type":"error","detail":"Подожди пару секунд перед новым рейсом"})
                except HTTPException as exc:
                    conn.send({"type":"error","detail":exc.detail})
                except (ValidationError,ValueError,TypeError):
                    invalid += 1
                    conn.send({"type":"error","detail":"Некорректное сообщение или повтор seq"})
                    if invalid>=3:
                        await ws.close(code=1008,reason="Нарушение протокола")
                        break
        except TimeoutError:
            with contextlib.suppress(Exception):
                await ws.close(code=4008,reason="Истекло время ожидания")
        except (ValidationError,ValueError,TypeError,RecursionError,json.JSONDecodeError):
            with contextlib.suppress(Exception):
                await ws.close(code=1008,reason="Некорректный протокол")
        except (WebSocketDisconnect,RuntimeError):
            pass
        finally:
            if not admitted:
                pending[peer] = max(0,pending.get(peer,1)-1)
                if not pending[peer]:
                    pending.pop(peer,None)
            if conn:
                app.state.rooms.disconnect(conn)
            if write_task:
                write_task.cancel()
                with contextlib.suppress(asyncio.CancelledError,Exception):
                    await write_task

    if Path(settings.web_path).is_dir():
        index_html = versioned_index(settings.web_path)

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        @app.api_route("/index.html", methods=["GET", "HEAD"], include_in_schema=False)
        async def index(request: Request):
            response = HTMLResponse(index_html, headers={"Cache-Control": "no-store"})
            if request.method == "HEAD":
                response.body = b""
            return response

        app.mount("/",StaticFiles(directory=settings.web_path,html=True),name="web")
    return app


app = create_app()
