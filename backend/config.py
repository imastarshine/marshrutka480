from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    db_path: str = "data/marshrutka.sqlite3"
    allowed_origins: tuple[str, ...] = ("http://localhost:8000", "http://127.0.0.1:8000", "http://testserver")
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "testserver")
    environment: str = "development"
    round_seconds: int = 180
    countdown_seconds: float = 3.0
    reconnect_seconds: float = 20.0
    session_seconds: int = 28800
    auth_limit: int = 10
    register_limit: int = 5
    http_limit: int = 120
    max_rooms: int = 64
    max_connections: int = 128
    body_limit: int = 8192
    ws_limit: int = 2048
    web_path: str = field(default_factory=lambda: str(Path(__file__).resolve().parents[1] / "web"))

    def __post_init__(self) -> None:
        if self.environment not in {"development", "production"}:
            raise ValueError("M480_ENV must be development or production")
        if not self.allowed_origins or not self.allowed_hosts:
            raise ValueError("M480_ORIGINS and M480_HOSTS must not be empty")
        for origin in self.allowed_origins:
            p = urlsplit(origin)
            if p.scheme not in {"http", "https"} or not p.netloc or p.path or p.query or p.fragment or p.username:
                raise ValueError("Origins must be exact scheme://host[:port] values, without paths or wildcards")
            if "*" in origin:
                raise ValueError("Wildcard origins are forbidden")
            if self.environment == "production" and p.scheme != "https":
                raise ValueError("Production origins must use HTTPS")
        if any("*" in host or "/" in host for host in self.allowed_hosts):
            raise ValueError("Trusted hosts must be exact host names")
        if not 1 <= self.round_seconds <= 3600 or self.session_seconds < 1:
            raise ValueError("Invalid time settings")

    @classmethod
    def from_env(cls) -> "Settings":
        def csv(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
            return tuple(v.strip() for v in os.getenv(name, ",".join(default)).split(",") if v.strip())
        return cls(
            db_path=os.getenv("M480_DATABASE", cls.db_path),
            allowed_origins=csv("M480_ORIGINS", cls.allowed_origins),
            allowed_hosts=csv("M480_HOSTS", cls.allowed_hosts),
            environment=os.getenv("M480_ENV", "development"),
        )
