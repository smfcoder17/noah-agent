import hashlib
import secrets
import time
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Cookie, Depends, HTTPException, Request, Response

from . import db
from .config import SESSION_DAYS

COOKIE = "noah_session"
# Une session sert tant que l'appareil sert : chaque usage la prolonge (comme les apps compagnons de Home Assistant).
# Une session qu'on ne revoit pas pendant SESSION_DAYS expire ; l'utilisateur en révoque une dans Réglages > Appareils.
RENEW_AFTER = timedelta(days=1)
UNCLAIMED = timedelta(minutes=10)  # session d'appairage jamais utilisée : expire seule
SEEN_EVERY = timedelta(minutes=5)
# Session de fenêtre : ce que la WebView de l'app reçoit à la place du jeton d'appareil, qu'elle écrirait en clair sur le
# disque (Cookies, même sans durée de vie). 2 h sans usage, et 24 h au plus : une copie du fichier, même utilisée sans arrêt,
# finit par tomber. L'app en demande une nouvelle à chaque ouverture, sans bruit ; ce délai ne se voit donc jamais.
WINDOW_IDLE = timedelta(hours=2)
WINDOW_LONGEST = timedelta(hours=24)
# Un navigateur où le mot de passe vient d'être saisi peut accorder un nouvel appareil sans le redemander. Rien d'autre n'a
# cette dispense : une session d'appareil vit des mois, et son jeton volé ne doit pas pouvoir se fabriquer un autre accès.
PROOF_SECONDS = 15 * 60
WINDOW_REFUSED = "Pas depuis l'app : pour cette action, ouvre Noah dans un navigateur où tu es connecté."
# Mot de passe temporaire : tant qu'il n'est pas remplacé, seules ces routes répondent à une session de ce compte, même par jeton.
# Toutes les routes à session passent par current_user (tests/install/comptes_test.py les parcourt une à une).
TEMPORARY_ROUTES = ("/api/me", "/api/me/password", "/api/devices/self/fenetre")
TEMPORARY_REFUSED = "Choisis d'abord ton nouveau mot de passe : celui-ci est temporaire."


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


def hash_password(password: str) -> bytes:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt())


def create_user(username: str, password: str, role: str | None = None, temporary: bool = False) -> int:
    """Sans rôle donné : le tout premier compte est le propriétaire de l'installation, les suivants des profils.
    `temporary` : le mot de passe est à changer à la première connexion."""
    pw_hash = hash_password(password)
    with db.connect() as c:
        first = c.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None
        cur = c.execute(
            "INSERT INTO users (username, pw_hash, role, a_changer) VALUES (?, ?, ?, ?)",
            (username, pw_hash, role or ("owner" if first else "member"), int(temporary)),
        )
        return cur.lastrowid


def set_password(user_id: int, password: str, keep: str | None = None, temporary: bool = False) -> None:
    """Change le mot de passe et coupe les sessions du compte, sauf `keep` (empreinte) s'il est donné."""
    pw_hash = hash_password(password)
    with db.connect() as c:
        c.execute("UPDATE users SET pw_hash = ?, a_changer = ? WHERE id = ?", (pw_hash, int(temporary), user_id))
        c.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, keep or ""))


def must_change(user_id: int) -> bool:
    with db.connect() as c:
        row = c.execute("SELECT a_changer FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row["a_changer"])


def check_password(username: str, password: str) -> int | None:
    with db.connect() as c:
        row = c.execute(
            "SELECT id, pw_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
    if row and bcrypt.checkpw(password.encode(), row["pw_hash"]):
        return row["id"]
    return None


def new_session(user_id: int, device: str = "", platform: str = "web", ip: str = "", version: str = "",
                proven: bool = False) -> str:
    """`proven` : ouverte par le mot de passe, à l'instant."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with db.connect() as c:
        c.execute(
            "INSERT INTO sessions (token, user_id, expires_at, device, platform, created_at, last_seen, last_ip, version, mdp_a) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (digest(token), user_id, (now + timedelta(days=SESSION_DAYS)).isoformat(), device[:80], platform[:20],
             now.isoformat(), now.isoformat(), ip[:64], version[:20], time.time() if proven else None),
        )
    return token


def proven_recently(key: str) -> bool:
    """Session de navigateur (empreinte `key`) dont le mot de passe a été vérifié il y a moins de PROOF_SECONDS."""
    with db.connect() as c:
        row = c.execute("SELECT platform, mdp_a FROM sessions WHERE token = ?", (key,)).fetchone()
    return bool(row and row["platform"] == "web" and row["mdp_a"] and time.time() - row["mdp_a"] < PROOF_SECONDS)


def mark_proven(key: str) -> None:
    with db.connect() as c:
        c.execute("UPDATE sessions SET mdp_a = ? WHERE token = ? AND platform = 'web'", (time.time(), key))


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


def new_window(device_token: str) -> str | None:
    """Session de fenêtre rattachée à la session `device_token`, seulement si celle-ci existe et vit encore, en une seule
    écriture (voir new_session_if_alive). Une session de fenêtre n'est pas dans `sessions` : elle n'en crée pas d'autre."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with db.connect() as c:
        c.execute("DELETE FROM window_sessions WHERE expires_at <= ?", (now.isoformat(),))
        created = c.execute(
            "INSERT INTO window_sessions (token, parent, expires_at, created_at, last_seen) SELECT ?, ?, ?, ?, ? "
            "WHERE EXISTS (SELECT 1 FROM sessions WHERE token = ? AND expires_at > ?)",
            (digest(token), digest(device_token), (now + WINDOW_IDLE).isoformat(), now.isoformat(), now.isoformat(),
             digest(device_token), now.isoformat()),
        ).rowcount
    return token if created else None


def _use_window(c, key: str):
    """La session de fenêtre `key` si elle et son appareil sont encore valables, prolongée de la durée courte. La
    jointure la fait tomber avec son appareil, quel que soit le chemin qui l'a supprimé ou laissé expirer."""
    now = datetime.now(timezone.utc)
    row = c.execute(
        "SELECT w.expires_at, w.created_at, w.last_seen, s.user_id FROM window_sessions w "
        "JOIN sessions s ON s.token = w.parent WHERE w.token = ? AND s.expires_at > ?", (key, now.isoformat())).fetchone()
    if not row:
        return None
    ceiling = datetime.fromisoformat(row["created_at"]) + WINDOW_LONGEST
    if datetime.fromisoformat(row["expires_at"]) <= now or ceiling <= now:
        return None
    if now - datetime.fromisoformat(row["last_seen"]) > SEEN_EVERY:
        c.execute("UPDATE window_sessions SET last_seen = ?, expires_at = ? WHERE token = ?",
                  (now.isoformat(), min(now + WINDOW_IDLE, ceiling).isoformat(), key))
    return row


def is_window(token: str | None) -> bool:
    with db.connect() as c:
        return c.execute("SELECT 1 FROM window_sessions WHERE token = ?", (digest(token or ""),)).fetchone() is not None


def session_key(token: str | None) -> str:
    """Empreinte de la session qui dure derrière ce jeton : celle de l'appareil pour une session de fenêtre. C'est à elle
    que s'attache ce qui doit survivre au renouvellement (abonnement aux notifications, appareil « actuel »)."""
    key = digest(token or "")
    with db.connect() as c:
        row = c.execute("SELECT parent FROM window_sessions WHERE token = ?", (key,)).fetchone()
    return row["parent"] if row else key


def drop_session(token: str) -> None:
    """Depuis une session de fenêtre, c'est l'appareil qui part (et ses fenêtres avec) : sinon l'app rouvrirait la session
    toute seule, et se déconnecter ne servirait à rien."""
    key = session_key(token)
    with db.connect() as c:
        c.execute("DELETE FROM sessions WHERE token = ?", (key,))


def request_token(request: Request, cookie: str | None) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:] if header.lower().startswith("bearer ") else cookie


def _temporary_refused(c, user_id: int, connection) -> None:
    if connection.url.path in TEMPORARY_ROUTES:
        return
    row = c.execute("SELECT a_changer FROM users WHERE id = ?", (user_id,)).fetchone()
    if row and row["a_changer"]:
        raise HTTPException(403, TEMPORARY_REFUSED, headers={"X-Noah-Mot-De-Passe": "a-changer"})


def current_user(request: Request, noah_session: str | None = Cookie(None), response: Response = None) -> int:
    """Dépendance FastAPI : cookie pour le web, en-tête Bearer pour les apps mobile et desktop."""
    token = request_token(request, noah_session)
    if not token:
        raise HTTPException(401, "Connexion requise")
    key = digest(token)
    with db.connect() as c:
        row = c.execute(
            "SELECT user_id, expires_at, last_seen, platform FROM sessions WHERE token = ?", (key,)
        ).fetchone()
        now = datetime.now(timezone.utc)
        if not row:
            window = _use_window(c, key)  # jamais la prolongation à SESSION_DAYS ci-dessous : elle ne vaut que pour `sessions`
            if not window:
                raise HTTPException(401, "Session expirée")
            _temporary_refused(c, window["user_id"], request)
            return window["user_id"]
        if datetime.fromisoformat(row["expires_at"]) < now:
            raise HTTPException(401, "Session expirée")
        _temporary_refused(c, row["user_id"], request)
        seen = datetime.fromisoformat(row["last_seen"]) if row["last_seen"] else None
        if not seen or now - seen > SEEN_EVERY:
            expires = datetime.fromisoformat(row["expires_at"])
            if expires - now < timedelta(days=SESSION_DAYS) - RENEW_AFTER:
                expires = now + timedelta(days=SESSION_DAYS)
                # Le cookie du navigateur suit la session : sans ça, il expirerait au bout de 30 jours d'usage quotidien
                # alors que la session, elle, est prolongée. Pas celui des apps : au bureau, un cookie sans expiration n'est
                # pas écrit sur le disque ; sous Android, la fenêtre n'a qu'une session de fenêtre (voir WINDOW_IDLE).
                if response is not None and token == noah_session and row["platform"] == "web":
                    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=SESSION_DAYS * 86400,
                                        secure=request.url.scheme == "https")
            ip = request.client.host if request.client else ""
            c.execute("UPDATE sessions SET last_seen = ?, expires_at = ?, last_ip = ? WHERE token = ?",
                      (now.isoformat(), expires.isoformat(), ip, key))
    return row["user_id"]


def owner_of(token: str | None) -> int | None:
    """Le compte de ce jeton s'il vit encore, sans le prolonger : pour savoir à qui appartient un cookie déjà là."""
    if not token:
        return None
    key = digest(token)
    with db.connect() as c:
        row = c.execute("SELECT user_id, expires_at FROM sessions WHERE token = ?", (key,)).fetchone()
        if not row:
            window = _use_window(c, key)
            return window["user_id"] if window else None
    return row["user_id"] if datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc) else None


def session_alive(key: str) -> bool:
    """La session d'empreinte `key` existe encore (ni déconnectée, ni révoquée, ni expirée)."""
    with db.connect() as c:
        return c.execute("SELECT 1 FROM sessions WHERE token = ? AND expires_at > ?",
                         (key, datetime.now(timezone.utc).isoformat())).fetchone() is not None


def full_session(request: Request, noah_session: str | None = Cookie(None), user: int = Depends(current_user)) -> int:
    """Pour ce qui donne un accès durable (appairer un appareil, créer un compte) : une copie du cookie de la fenêtre doit
    mourir avec elle, sans avoir pu se fabriquer un autre accès."""
    if is_window(request_token(request, noah_session)):
        raise HTTPException(403, WINDOW_REFUSED)
    return user


def still_valid(token: str) -> bool:
    """Pour les flux longs (chat, écran) : un appareil révoqué perd aussi ce qu'il a déjà ouvert. Une session de fenêtre
    reste vivante tant qu'un flux s'en sert, même si l'app en a demandé une nouvelle pour le reste de la page."""
    key = digest(token)
    with db.connect() as c:
        row = c.execute("SELECT expires_at FROM sessions WHERE token = ?", (key,)).fetchone()
        if not row:
            return _use_window(c, key) is not None
    return datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc)


REVOKE_EVERY = 2  # secondes entre deux contrôles d'un flux ouvert : la révocation doit le couper en 5 s au plus


async def revocable(stream, token: str | None, every: float = REVOKE_EVERY, allowed=None):
    """Relaie un flux tant que la session existe et que `allowed()` (droit sur l'agent) reste vrai ; s'arrête dans les
    `every` secondes qui suivent, même quand le flux se tait (le modèle réfléchit) et même quand il parle sans arrêt."""
    import asyncio
    import time

    it = stream.__aiter__()
    pending = None
    checked = time.monotonic()
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(it.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=max(0, every - (time.monotonic() - checked)))
            if time.monotonic() - checked >= every:
                checked = time.monotonic()
                if token and not await asyncio.to_thread(still_valid, token):
                    return
                if allowed and not await asyncio.to_thread(allowed):
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


def device_id(token_digest: str) -> str:
    """Identifiant public d'un appareil : dérivé de sa session, donc jamais réutilisé par un autre (contrairement au
    rowid SQLite). Une ancienne liste ne peut pas déconnecter un appareil arrivé depuis."""
    return hashlib.sha256(("noah-device:" + token_digest).encode()).hexdigest()[:20]


def devices(user_id: int, current: str | None) -> list[dict]:
    with db.connect() as c:
        rows = c.execute(
            "SELECT token, device, platform, created_at, last_seen, last_ip, version FROM sessions "
            "WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC",
            (user_id, datetime.now(timezone.utc).isoformat()),
        ).fetchall()
    mine = session_key(current) if current else None
    return [{"id": device_id(r["token"]), "nom": r["device"], "type": r["platform"], "depuis": r["created_at"], "vu": r["last_seen"],
             "ip": r["last_ip"] or "", "version": r["version"] or "", "actuel": r["token"] == mine} for r in rows]


def revoke_others(user_id: int, current: str) -> int:
    with db.connect() as c:
        return c.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, session_key(current))).rowcount


def revoke_device(user_id: int, public_id: str) -> bool:
    with db.connect() as c:
        tokens = [r["token"] for r in c.execute("SELECT token FROM sessions WHERE user_id = ?", (user_id,))]
        match = [t for t in tokens if device_id(t) == public_id]
        return bool(match) and c.execute("DELETE FROM sessions WHERE token = ? AND user_id = ?",
                                         (match[0], user_id)).rowcount > 0
