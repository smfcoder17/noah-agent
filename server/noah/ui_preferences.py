"""Préférences d'interface par compte, jamais par appareil (A7)."""
import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import auth, db

router = APIRouter()
TABS = ("chat", "activity", "tasks", "files", "computer", "connections", "competences", "memory")


def read(user: int) -> dict:
    raw = db.get_setting(f"ui:{user}")
    return json.loads(raw) if raw else {"tabs": list(TABS[:5]), "masquer_sensibles": True, "theme": "system", "texte": "normal"}


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
    result = {**read(user), **body.model_dump(exclude_none=True)}
    db.set_setting(f"ui:{user}", json.dumps(result))
    return result
