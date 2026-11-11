from __future__ import annotations

import re
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
    type: Literal["start", "leave", "horn"]


class PingMessage(StrictModel):
    type: Literal["ping"]
    t: int | float = Field(ge=0, le=1e16, allow_inf_nan=False)
