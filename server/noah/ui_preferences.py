"""Préférences d'interface par compte, jamais par appareil (A7)."""
import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import auth, db

router = APIRouter()
TABS = ("chat", "activity", "tasks", "files", "computer", "connections", "competences", "memory")


def defaults() -> dict:
    return {"tabs": list(TABS[:5]), "masquer_sensibles": True, "theme": "system", "texte": "normal"}


def read(user: int) -> dict:
    raw = db.get_setting(f"ui:{user}")
    return {**defaults(), **(json.loads(raw) if raw else {})}


class Preferences(BaseModel):
    tabs: list[str] | None = Field(default=None, min_length=1, max_length=8)
    masquer_sensibles: bool | None = None
    theme: str | None = Field(default=None, pattern="^(light|dark|system)$")
    texte: str | None = Field(default=None, pattern="^(petit|normal|grand)$")


@router.get("/api/me/interface")
def get_preferences(user: int = Depends(auth.current_user)):
    return read(user)


@router.put("/api/me/interface")
def put_preferences(body: Preferences, user: int = Depends(auth.current_user)):
    from fastapi import HTTPException
    if body.tabs is not None and (len(set(body.tabs)) != len(body.tabs) or "chat" not in body.tabs or any(t not in TABS for t in body.tabs)):
        raise HTTPException(400, "Garde Discussion et choisis chaque onglet une seule fois.")
    # Le verrou d'écriture précède la lecture : deux appareils fusionnent chacun
    # leur patch avec la dernière version, jamais avec une copie devenue ancienne.
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT value FROM settings WHERE key = ?", (f"ui:{user}",)).fetchone()
        result = {**defaults(), **(json.loads(row["value"]) if row else {}), **body.model_dump(exclude_none=True)}
        c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (f"ui:{user}", json.dumps(result)))
    return result
