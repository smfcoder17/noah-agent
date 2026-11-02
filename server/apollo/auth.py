import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Cookie, HTTPException, Request, Response

from . import db
from .config import SESSION_DAYS

COOKIE = "apollo_session"
# Une session sert tant que l'appareil sert : chaque usage la prolonge (comme les apps compagnons de Home Assistant).
# Une session qu'on ne revoit pas pendant SESSION_DAYS expire ; l'utilisateur en révoque une dans Réglages > Appareils.
RENEW_AFTER = timedelta(days=1)
UNCLAIMED = timedelta(minutes=10)  # session d'appairage jamais utilisée : expire seule
SEEN_EVERY = timedelta(minutes=5)


def digest(token: str) -> str:
    """La base ne garde que l'empreinte des jetons : une copie volée de la base ne connecte personne."""
    return hashlib.sha256(token.encode()).hexdigest()


def hash_old_sessions() -> None:
    """Migration : les sessions d'avant étaient enregistrées en clair (64 caractères hexadécimaux = déjà une empreinte)."""
    with db.connect() as c:
        for (token,) in c.execute("SELECT token FROM sessions").fetchall():
            if len(token) != 64 or any(ch not in "0123456789abcdef" for ch in token):
                c.execute("UPDATE sessions SET token = ? WHERE token = ?", (digest(token), token))


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


def new_session(user_id: int, device: str = "", platform: str = "web", ip: str = "", version: str = "") -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with db.connect() as c:
        c.execute(
            "INSERT INTO sessions (token, user_id, expires_at, device, platform, created_at, last_seen, last_ip, version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (digest(token), user_id, (now + timedelta(days=SESSION_DAYS)).isoformat(), device[:80], platform[:20],
             now.isoformat(), now.isoformat(), ip[:64], version[:20]),
        )
    return token


def new_session_if_alive(parent: str, user_id: int, device: str = "", platform: str = "web", ip: str = "",
                         version: str = "") -> str | None:
    """Crée une session seulement si la session `parent` (empreinte) existe encore, dans la même instruction : une
    révocation de `parent` passe soit avant (rien n'est créé), soit après (la nouvelle session est alors listée et
    révocable avec les autres). Rend None si `parent` n'existe plus.

    Provisoire : elle expire après UNCLAIMED s'il ne s'en sert jamais (réponse du sondage perdue, app fermée avant de
    la ranger) ; sa première utilisation la prolonge comme les autres (voir current_user)."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with db.connect() as c:
        created = c.execute(
            "INSERT INTO sessions (token, user_id, expires_at, device, platform, created_at, last_seen, last_ip, version) "
            "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS "
            "(SELECT 1 FROM sessions WHERE token = ? AND user_id = ? AND expires_at > ?)",
            (digest(token), user_id, (now + UNCLAIMED).isoformat(), device[:80], platform[:20],
             now.isoformat(), None, ip[:64], version[:20], parent, user_id, now.isoformat()),
        ).rowcount
    return token if created else None


def drop_session(token: str) -> None:
    with db.connect() as c:
        c.execute("DELETE FROM sessions WHERE token = ?", (digest(token),))


def request_token(request: Request, cookie: str | None) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:] if header.lower().startswith("bearer ") else cookie


def current_user(request: Request, apollo_session: str | None = Cookie(None), response: Response = None) -> int:
    """Dépendance FastAPI : cookie pour le web, en-tête Bearer pour les apps mobile et desktop."""
    token = request_token(request, apollo_session)
    if not token:
        raise HTTPException(401, "Connexion requise")
    key = digest(token)
    with db.connect() as c:
        row = c.execute(
            "SELECT user_id, expires_at, last_seen, platform FROM sessions WHERE token = ?", (key,)
        ).fetchone()
        now = datetime.now(timezone.utc)
        if not row or datetime.fromisoformat(row["expires_at"]) < now:
            raise HTTPException(401, "Session expirée")
        seen = datetime.fromisoformat(row["last_seen"]) if row["last_seen"] else None
        if not seen or now - seen > SEEN_EVERY:
            expires = datetime.fromisoformat(row["expires_at"])
            if expires - now < timedelta(days=SESSION_DAYS) - RENEW_AFTER:
                expires = now + timedelta(days=SESSION_DAYS)
                # Le cookie du navigateur suit la session : sans ça, il expirerait au bout de 30 jours d'usage quotidien
                # alors que la session, elle, est prolongée. Pas celui des apps (fenêtre Android, bureau) : leur cookie
                # reste sans expiration, jamais écrit sur le disque ; la session y est gardée chiffrée par l'app.
                if response is not None and token == apollo_session and row["platform"] == "web":
                    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=SESSION_DAYS * 86400,
                                        secure=request.url.scheme == "https")
            ip = request.client.host if request.client else ""
            c.execute("UPDATE sessions SET last_seen = ?, expires_at = ?, last_ip = ? WHERE token = ?",
                      (now.isoformat(), expires.isoformat(), ip, key))
    return row["user_id"]


def still_valid(token: str) -> bool:
    """Pour les flux longs (chat, écran) : un appareil révoqué perd aussi ce qu'il a déjà ouvert."""
    with db.connect() as c:
        row = c.execute("SELECT expires_at FROM sessions WHERE token = ?", (digest(token),)).fetchone()
    return bool(row) and datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc)


async def revocable(stream, token: str | None, every: float = 5):
    """Relaie un flux tant que la session existe ; s'arrête dans les `every` secondes qui suivent sa révocation, même
    quand le flux se tait (le modèle réfléchit)."""
    import asyncio
    import time

    it = stream.__aiter__()
    pending = None
    checked = time.monotonic()
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(it.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=every)
            if token and time.monotonic() - checked >= every:
                checked = time.monotonic()
                if not await asyncio.to_thread(still_valid, token):
                    return
            if pending in done:
                try:
                    chunk = pending.result()
                except StopAsyncIteration:
                    return
                pending = None
                yield chunk
    finally:
        if pending is not None and not pending.done():
            pending.cancel()


def devices(user_id: int, current: str | None) -> list[dict]:
    with db.connect() as c:
        rows = c.execute(
            "SELECT rowid AS id, token, device, platform, created_at, last_seen, last_ip, version FROM sessions "
            "WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC",
            (user_id, datetime.now(timezone.utc).isoformat()),
        ).fetchall()
    mine = digest(current) if current else None
    return [{"id": r["id"], "nom": r["device"], "type": r["platform"], "depuis": r["created_at"], "vu": r["last_seen"],
             "ip": r["last_ip"] or "", "version": r["version"] or "", "actuel": r["token"] == mine} for r in rows]


def revoke_others(user_id: int, current: str) -> int:
    with db.connect() as c:
        return c.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, digest(current))).rowcount


def revoke_device(user_id: int, device_id: int) -> bool:
    with db.connect() as c:
        return c.execute("DELETE FROM sessions WHERE rowid = ? AND user_id = ?", (device_id, user_id)).rowcount > 0
