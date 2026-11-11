from __future__ import annotations

import asyncio
import json

from .config import Settings
from .security import RateLimiter


class SecurityMiddleware:
    """Enforce actual body bytes (also chunked bodies), origin and bounded requests."""
    def __init__(self, app, settings: Settings, limiter: RateLimiter) -> None:
        self.app, self.settings, self.limiter = app,settings,limiter

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope,receive,send)
        headers = dict(scope.get("headers",[]))
        origin = headers.get(b"origin",b"").decode("latin-1")
        path = scope.get("path","")
        api = path.startswith("/api/")
        if origin and origin not in self.settings.allowed_origins and api:
            return await self.reject(send,403,"Источник запроса запрещён")
        ip = (scope.get("client") or ("unknown",0))[0]
        if api and not self.limiter.allow("http:"+ip,self.settings.http_limit):
            return await self.reject(send,429,"Слишком много запросов. Подождите минуту")
        if api:
            try:
                declared = int(headers.get(b"content-length",b"0"))
            except ValueError:
                return await self.reject(send,400,"Некорректная длина запроса")
            if declared<0 or declared>self.settings.body_limit:
                return await self.reject(send,413,"Запрос слишком большой")
            chunks, size = [],0
            try:
                async with asyncio.timeout(10):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        chunk = message.get("body",b"")
                        size += len(chunk)
                        if size>self.settings.body_limit:
                            return await self.reject(send,413,"Запрос слишком большой")
                        chunks.append(chunk)
                        if not message.get("more_body",False):
                            break
            except TimeoutError:
                return await self.reject(send,408,"Истекло время передачи запроса")
            body = b"".join(chunks)
            if body and scope["method"] in {"POST","PUT","PATCH"} and headers.get(b"content-type",b"").split(b";")[0].strip().lower()!=b"application/json":
                return await self.reject(send,415,"Нужен Content-Type: application/json")
            consumed = False
            original_receive = receive
            async def body_receive():
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return {"type":"http.request","body":body,"more_body":False}
                return await original_receive()
            receive = body_receive

        async def secured_send(message):
            if message["type"]=="http.response.start":
                additional = [
                    (b"x-content-type-options",b"nosniff"),
                    (b"x-frame-options",b"DENY"),
                    (b"referrer-policy",b"no-referrer"),
                    (b"permissions-policy",b"camera=(), microphone=(), geolocation=()"),
                    (b"content-security-policy",b"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
                ]
                if api:
                    additional.append((b"cache-control",b"no-store"))
                elif not any(key.lower() == b"cache-control" for key, _ in message.get("headers", [])):
                    # Revalidate static resources after a deploy. HTML supplies
                    # content-versioned URLs, including for previously cached JS.
                    additional.append((b"cache-control",b"no-cache, max-age=0, must-revalidate"))
                if self.settings.environment=="production":
                    additional.append((b"strict-transport-security",b"max-age=31536000"))
                message["headers"] = list(message.get("headers",[]))+additional
            await send(message)
        await self.app(scope,receive,secured_send)

    @staticmethod
    async def reject(send,status: int,detail: str):
        body = json.dumps({"detail":detail},ensure_ascii=False).encode()
        headers = [(b"content-type",b"application/json; charset=utf-8"),(b"content-length",str(len(body)).encode()),(b"cache-control",b"no-store"),(b"x-content-type-options",b"nosniff")]
        if status==429:
            headers.append((b"retry-after",b"60"))
        await send({"type":"http.response.start","status":status,"headers":headers})
        await send({"type":"http.response.body","body":body})
