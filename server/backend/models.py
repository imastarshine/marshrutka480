from __future__ import annotations

import re
import math
import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Credentials(StrictModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=10, max_length=128)

    @field_validator("username")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = unicodedata.normalize("NFC", value)
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9_-]{3,24}", value):
            raise ValueError("Имя: 3–24 буквы, цифры, дефис или подчёркивание")
        return value


class CreateRoom(StrictModel):
    name: str = Field(default="Совместный рейс", min_length=1, max_length=40)
    public: bool = True
    max_players: int = Field(default=4, ge=1, le=8)
    mode: Literal["arcade", "city"] = "arcade"

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(unicodedata.category(c)[0] == "C" for c in value):
            raise ValueError("Название комнаты содержит недопустимые символы")
        return value


class EmptyBody(StrictModel):
    pass


class AuthMessage(StrictModel):
    type: Literal["auth"]
    token: str = Field(min_length=40, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    room: str = Field(pattern=r"^[A-Z2-9]{6}$")


class InputMessage(StrictModel):
    type: Literal["input"]
    seq: int = Field(ge=0, le=2147483647)
    up: bool = False
    down: bool = False
    left: bool = False
    right: bool = False


class ActionMessage(StrictModel):
    type: Literal["start", "leave", "horn", "spawn"]


class CityPoseMessage(StrictModel):
    type: Literal["pose"]
    seq: int = Field(ge=0, le=2147483647)
    wx: float = Field(ge=-1e7, le=1e7, allow_inf_nan=False)
    wy: float = Field(ge=-1e7, le=1e7, allow_inf_nan=False)
    lateral: float = Field(ge=-300, le=380, allow_inf_nan=False)
    angle: float = Field(ge=-math.pi, le=math.pi, allow_inf_nan=False)
    speed: float = Field(ge=-4, le=19, allow_inf_nan=False)
    jump: float = Field(ge=0, le=160, allow_inf_nan=False)
    door: float = Field(ge=0, le=1, allow_inf_nan=False)
    braking: bool
    bus: Literal["gazel", "transit", "paz", "sprinter", "liaz"]
    route: Literal["480", "10", "80", "83", "33", "112", "90", "Т4"]
    state: Literal["intro", "menu", "dialog", "play", "turning", "pause", "boom", "offer", "caught", "station", "over"]
    street: str = Field(max_length=60)
    edge: str = Field(default="", max_length=120)


class PingMessage(StrictModel):
    type: Literal["ping"]
    t: int | float = Field(ge=0, le=1e16, allow_inf_nan=False)


class BugReportNPC(StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    edge: str = Field(max_length=120, pattern=r"^[A-Za-z0-9_.:-]*$")
    reverse: bool
    wx: float = Field(ge=-1e7, le=1e7, allow_inf_nan=False)
    wy: float = Field(ge=-1e7, le=1e7, allow_inf_nan=False)
    speed: float = Field(ge=-4, le=19, allow_inf_nan=False)


class BugReportSignal(StrictModel):
    node: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")
    state: Literal["green", "yellow", "red"]
    distance: float = Field(ge=-1e5, le=1e5, allow_inf_nan=False)


class BugReport(StrictModel):
    """Bounded scene telemetry; never accept arbitrary logs or credentials."""

    version: str = Field(min_length=1, max_length=48, pattern=r"^[A-Za-z0-9_.+-]+$")
    route: Literal["480", "10", "80", "83", "33", "112", "90", "Т4"]
    edge: str = Field(max_length=120, pattern=r"^[A-Za-z0-9_.:-]*$")
    reverse: bool
    wx: float = Field(ge=-1e7, le=1e7, allow_inf_nan=False)
    wy: float = Field(ge=-1e7, le=1e7, allow_inf_nan=False)
    offset: float = Field(ge=0, le=1e8, allow_inf_nan=False)
    lateral: float = Field(ge=-500, le=500, allow_inf_nan=False)
    angle: float = Field(ge=-math.pi, le=math.pi, allow_inf_nan=False)
    speed: float = Field(ge=-4, le=19, allow_inf_nan=False)
    state: Literal["intro", "menu", "dialog", "play", "turning", "pause", "boom", "offer", "caught", "station", "over"]
    lat: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    lon: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    collision_id: str | None = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9_.:-]*$")
    nearby_npcs: list[BugReportNPC] = Field(default_factory=list, max_length=20)
    signals: list[BugReportSignal] = Field(default_factory=list, max_length=12)
