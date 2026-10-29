import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Cookie, HTTPException, Request

from . import db
from .config import SESSION_DAYS

COOKIE = "apollo_session"


def has_users() -> bool:
    with db.connect() as c:
        return c.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None


def create_user(username: str, password: str) -> int:
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt())
    with db.connect() as c:
        cur = c.execute(
            "INSERT INTO users (username, pw_hash) VALUES (?, ?)", (username, pw_hash)
        )
        return cur.lastrowid


def check_password(username: str, password: str) -> int | None:
    with db.connect() as c:
        row = c.execute(
            "SELECT id, pw_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
    if row and bcrypt.checkpw(password.encode(), row["pw_hash"]):
        return row["id"]
    return None


def new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with db.connect() as c:
        c.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, expires.isoformat()),
        )
    return token


def drop_session(token: str) -> None:
    with db.connect() as c:
        c.execute("DELETE FROM sessions WHERE token = ?", (token,))


def current_user(request: Request, apollo_session: str | None = Cookie(None)) -> int:
    """Dépendance FastAPI : cookie pour le web, en-tête Bearer pour les apps mobile et desktop."""
    token = apollo_session
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:]
    if not token:
        raise HTTPException(401, "Connexion requise")
    with db.connect() as c:
        row = c.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token = ?", (token,)
        ).fetchone()
    if not row or datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        raise HTTPException(401, "Session expirée")
    return row["user_id"]
