"""Notifications Web Push vers les appareils reliés (navigateur, app installée), sans service tiers à configurer.

Le serveur signe ses envois avec sa propre clé VAPID (RFC 8292) et chiffre chaque message pour l'appareil
(RFC 8291, aes128gcm) : le service de push du navigateur (Google, Mozilla, Apple) transporte un message qu'il ne peut
pas lire. Un abonnement est rattaché à la session de l'appareil : déconnecter l'appareil coupe ses notifications.
"""
import asyncio
import base64
import email.utils
import hashlib
import json
import logging
import os
import re
import struct
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, db, public

router = APIRouter()
log = logging.getLogger("uvicorn.error")
RECORD = 4096  # taille d'enregistrement annoncée ; un message tient toujours dans un seul
# Services de push des navigateurs. Le serveur n'envoie qu'à eux : un abonnement ne peut pas lui faire appeler une
# adresse interne (SSRF). Chrome, Edge, Firefox, Safari, Opera, Samsung Internet.
PUSH_HOSTS = re.compile(r"^(fcm\.googleapis\.com|android\.googleapis\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com"
                        r"|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com"
                        r"|ntfy\.sh)$")  # + app Android par UnifiedPush : ntfy (Sunup passe par Mozilla, déjà là)


def allowed_host(host: str) -> bool:
    """Service de push connu, ou serveur UnifiedPush auto-hébergé que l'administrateur a ajouté lui-même
    (NOAH_PUSH_HOSTS=ntfy.exemple.org,… dans la configuration du VPS)."""
    extra = {h.strip().lower() for h in os.environ.get("NOAH_PUSH_HOSTS", "").split(",") if h.strip()}
    return bool(PUSH_HOSTS.match(host)) or host.lower() in extra


_key_lock = threading.Lock()
TTL = 24 * 3600   # durée de vie d'un message chez le service de push
LEASE = 300       # un envoi de la file réservé puis interrompu (arrêt du serveur) redevient dû après 5 minutes
MAX_WAIT = TTL    # Retry-After respecté jusqu'à cette limite (attendre plus longtemps n'aurait plus de sens)
RETRIES = (2, 10)  # secondes d'attente avant de réessayer après une erreur passagère (429, 5xx, réseau)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _vapid_key() -> ec.EllipticCurvePrivateKey:
    """Clé du serveur, créée une fois (sous verrou : deux premiers appels simultanés ne créent pas deux clés) et gardée
    chiffrée dans les réglages."""
    pem = db.get_setting("vapid_key", secret=True)
    if not pem:
        with _key_lock:
            pem = db.get_setting("vapid_key", secret=True)
            if not pem:
                key = ec.generate_private_key(ec.SECP256R1())
                pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                        serialization.NoEncryption()).decode()
                db.set_setting("vapid_key", pem, secret=True)
    return serialization.load_pem_private_key(pem.encode(), None)


def public_key() -> str:
    return _b64(_point(_vapid_key().public_key()))


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(hashes.SHA256(), length, salt, info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth_secret: str) -> bytes:
    """Corps aes128gcm (RFC 8188 + RFC 8291) lisible par le seul appareil abonné."""
    ua_public = _unb64(p256dh)
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    mine = ec.generate_private_key(ec.SECP256R1())
    as_public = _point(mine.public_key())
    shared = mine.exchange(ec.ECDH(), peer)
    ikm = _hkdf(_unb64(auth_secret), shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    if len(payload) > RECORD - 17 - 103:
        raise ValueError("message trop long pour une notification")
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)  # \x02 : dernier (et seul) enregistrement
    return salt + struct.pack("!IB", RECORD, len(as_public)) + as_public + body


def vapid_header(endpoint: str, now: float | None = None) -> str:
    """En-tête Authorization VAPID : jeton ES256 limité au service de push visé, valable 12 h."""
    key = _vapid_key()
    parts = urlsplit(endpoint)
    site = public.main_url() or "https://noah.invalid"
    claims = {"aud": f"{parts.scheme}://{parts.netloc}", "exp": int((now or time.time()) + 12 * 3600), "sub": site}
    head = _b64(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(claims, separators=(",", ":")).encode())
    r, s = decode_dss_signature(key.sign(f"{head}.{body}".encode(), ec.ECDSA(hashes.SHA256())))
    token = f"{head}.{body}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return f"vapid t={token}, k={public_key()}"


transport: httpx.AsyncBaseTransport | None = None  # remplacé par les tests


def _retry_after(value: str, default: float) -> float:
    """Retry-After en secondes ou en date HTTP (RFC 9110), plafonné à 5 minutes : la notification attend dans une tâche
    de fond, pas dans une requête."""
    value = value.strip()
    if value.isdigit():
        return min(int(value), MAX_WAIT)
    if value:
        try:
            when = email.utils.parsedate_to_datetime(value)
            return max(0.0, min((when - datetime.now(timezone.utc)).total_seconds(), MAX_WAIT))
        except (TypeError, ValueError):
            pass
    return default


def session_tag(session: str) -> str:
    """Identité courte (non secrète, dérivée de l'empreinte) de la session à qui un message est destiné."""
    return hashlib.sha256(("noah-push:" + session).encode()).hexdigest()[:16]


def _payload(message: dict, session: str) -> bytes:
    return json.dumps({**message, "pour": session_tag(session)}, ensure_ascii=False).encode()


def _still_subscribed(sub) -> bool:
    """Le même abonnement (même appareil, même session, mêmes clés) existe toujours : un autre compte connecté depuis
    le même navigateur entre-temps a une autre session, son abonnement ne reçoit pas les messages du précédent."""
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as c:
        return bool(c.execute("SELECT 1 FROM push_subscriptions p JOIN sessions s ON s.token = p.session "
                              "WHERE p.endpoint = ? AND p.session = ? AND p.p256dh = ? AND p.auth = ? AND s.expires_at > ?",
                              (sub["endpoint"], sub["session"], sub["p256dh"], sub["auth"], now)).fetchone())


def _defer(sub, payload: bytes, urgent: bool, delay: float, tries: int, created: float) -> None:
    """Envoi repris plus tard, gardé en base : un redémarrage du serveur pendant l'attente ne le perd pas. L'heure de
    création d'origine est gardée : un message reporté plusieurs fois ne vit pas plus de 24 heures en tout."""
    with db.connect() as c:
        c.execute("INSERT INTO push_queue (endpoint, session, p256dh, auth, payload, urgent, not_before, tries, created) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  (sub["endpoint"], sub["session"], sub["p256dh"], sub["auth"], payload, int(urgent),
                   time.time() + delay, tries, created))


async def run_queue(every: float = 30) -> None:
    """Boucle de fond : reprend les envois différés quand leur heure est venue (Retry-After, service indisponible)."""
    while True:
        try:
            await flush_queue()
        except Exception as e:  # une erreur de base ne doit pas arrêter la boucle
            log.warning("push : file d'attente : %s", e)
        await asyncio.sleep(every)


async def flush_queue() -> int:
    now = time.time()
    with db.connect() as c:
        c.execute("DELETE FROM push_queue WHERE created < ?", (now - TTL,))  # périmé chez le service de toute façon
        due = c.execute("SELECT * FROM push_queue WHERE not_before <= ?", (now,)).fetchall()
        # Réservés, pas supprimés : un arrêt du serveur pendant l'envoi les rend de nouveau dus après le bail.
        c.executemany("UPDATE push_queue SET not_before = ? WHERE id = ?", [(now + LEASE, r["id"]) for r in due])
    async with httpx.AsyncClient(timeout=15, transport=transport) as client:
        for r in due:
            outcome = await _send_one(client, r, r["payload"], bool(r["urgent"]), tries=r["tries"], created=r["created"])
            with db.connect() as c:  # traité (livré, refusé, ou de nouveau différé sous une autre ligne)
                c.execute("DELETE FROM push_queue WHERE id = ?", (r["id"],))
                if outcome == "mort":  # l'abonnement exact n'existe plus chez le service de push
                    c.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND session = ? AND p256dh = ? AND auth = ?",
                              (r["endpoint"], r["session"], r["p256dh"], r["auth"]))
    return len(due)


async def _send_one(client: httpx.AsyncClient, sub, payload: bytes, urgent: bool, tries: int = 0,
                    created: float | None = None) -> str:
    """« livre » (accepté par le service de push), « mort » (désinstallé, permission retirée, appareil déconnecté :
    rien ne part), « differe » (erreur passagère : repris plus tard depuis la base) ou « echec » (refusé)."""
    host = urlsplit(sub["endpoint"]).netloc
    created = time.time() if created is None else created
    if not allowed_host(urlsplit(sub["endpoint"]).hostname or ""):
        return "echec"  # service retiré de NOAH_PUSH_HOSTS depuis la mise en file
    for wait in (*RETRIES, None):
        if not _still_subscribed(sub):
            return "parti"  # appareil déconnecté ou désabonné pendant l'attente : rien ne part, rien à supprimer
        left = int(created + TTL - time.time())  # vie restante : 24 h depuis la création du message, pas depuis l'envoi
        if left <= 0:
            return "echec"
        headers = {
            "Authorization": vapid_header(sub["endpoint"]), "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream", "TTL": str(left), "Urgency": "high" if urgent else "normal",
        }
        if (urlsplit(sub["endpoint"]).hostname or "").endswith(".notify.windows.com"):
            headers["X-WNS-Type"] = "wns/raw"  # exigé par WNS (Edge sous Windows), comme le fait pywebpush
        try:
            r = await client.post(sub["endpoint"], content=encrypt(payload, sub["p256dh"], sub["auth"]), headers=headers)
        except httpx.HTTPError as e:
            log.warning("push : %s injoignable (%s)", host, e)
            r = None
        if r is not None and r.status_code < 300:
            return "livre"
        if r is not None and r.status_code in (404, 410):
            return "mort"
        transient = r is None or r.status_code == 429 or r.status_code >= 500
        if r is not None:
            log.warning("push : %s a refusé (%s) %s", host, r.status_code, r.text[:200])
        if not transient:
            return "echec"
        delay = _retry_after(r.headers.get("retry-after", "") if r is not None else "", wait if wait is not None else 60 * 2 ** tries)
        if wait is None or delay > 30:
            # Longue attente (Retry-After) ou essais rapides épuisés : la suite se fait depuis la base, pas en mémoire.
            if tries >= 6:
                return "echec"
            if created + TTL <= time.time() + delay:
                return "echec"  # serait périmé avant la reprise
            _defer(sub, payload, urgent, delay, tries + 1, created)
            return "differe"
        await asyncio.sleep(delay)
    return "echec"


async def send(title: str, text: str, url: str = "/", urgent: bool = False, user_id: int | None = None,
               session: str | None = None) -> dict:
    """Envoie à chaque appareil abonné dont la session est encore valable (ou à la seule session donnée, par son
    empreinte). Rend {livres, echecs, morts, differes}."""
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as c:
        c.execute("DELETE FROM push_subscriptions WHERE session NOT IN (SELECT token FROM sessions WHERE expires_at > ?)", (now,))
        rows = c.execute("SELECT p.* FROM push_subscriptions p JOIN sessions s ON s.token = p.session WHERE 1 = 1"
                         + (" AND s.user_id = ?" if user_id is not None else "")
                         + (" AND p.session = ?" if session is not None else ""),
                         tuple(v for v in (user_id, session) if v is not None)).fetchall()
        # Abonnements vers autre chose qu'un service de push de navigateur (enregistrés avant la liste) : supprimés.
        stray = [r["endpoint"] for r in rows if not allowed_host(urlsplit(r["endpoint"]).hostname or "")]
        if stray:
            c.executemany("DELETE FROM push_subscriptions WHERE endpoint = ?", [(e,) for e in stray])
            rows = [r for r in rows if r["endpoint"] not in stray]
    if not rows:
        return {"livres": 0, "echecs": 0, "morts": 0, "differes": 0}
    message = {"titre": title[:120], "texte": text[:400], "url": url}
    async with httpx.AsyncClient(timeout=15, transport=transport) as client:
        outcome = await asyncio.gather(*(_send_one(client, r, _payload(message, r["session"]), urgent) for r in rows))
    dead = [r for r, o in zip(rows, outcome) if o == "mort"]
    if dead:
        with db.connect() as c:  # l'abonnement exact : un autre compte a pu s'abonner depuis au même endpoint
            c.executemany("DELETE FROM push_subscriptions WHERE endpoint = ? AND session = ? AND p256dh = ? AND auth = ?",
                          [(r["endpoint"], r["session"], r["p256dh"], r["auth"]) for r in dead])
    return {"livres": outcome.count("livre"), "echecs": outcome.count("echec"), "morts": len(dead),
            "differes": outcome.count("differe")}


def _owner() -> int | None:
    """Compte propriétaire de l'installation (le premier créé) : c'est lui que l'agent prévient."""
    with db.connect() as c:
        row = c.execute("SELECT MIN(id) AS id FROM users").fetchone()
    return row["id"] if row else None


def notify(title: str, text: str, url: str = "/", urgent: bool = False, user_id: int | None = None) -> None:
    """Depuis le code du serveur : envoie sans attendre (rien ne bloque si un service de push est lent), au compte
    donné ou, par défaut, au propriétaire de l'installation, jamais à tous les comptes."""
    target = user_id if user_id is not None else _owner()
    if target is None:
        return
    try:
        asyncio.get_running_loop().create_task(send(title, text, url, urgent, user_id=target))
    except RuntimeError:
        pass  # hors de la boucle (tests, scripts) : pas de notification


class Subscription(BaseModel):
    endpoint: str = Field(max_length=1000, pattern=r"^https://[^/?#]+/")
    p256dh: str = Field(min_length=80, max_length=100)
    auth: str = Field(min_length=16, max_length=32)


@router.get("/api/push/key")
def key(_: int = Depends(auth.current_user)):
    return {"cle": public_key()}


@router.post("/api/push/subscription")
def subscribe(body: Subscription, request: Request, apollo_session: str | None = Cookie(None),
              _: int = Depends(auth.current_user)):
    if not allowed_host(urlsplit(body.endpoint).hostname or ""):
        raise HTTPException(400, "Service de push inconnu (seuls ceux des navigateurs sont acceptés)")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _unb64(body.p256dh))
        assert len(_unb64(body.auth)) == 16
    except Exception:
        raise HTTPException(400, "Clés d'abonnement invalides")
    session = auth.digest(auth.request_token(request, apollo_session) or "")
    with db.connect() as c:
        c.execute("DELETE FROM push_subscriptions WHERE session = ?", (session,))  # renouvelé : l'ancien ne sert plus
        c.execute("INSERT OR REPLACE INTO push_subscriptions (endpoint, session, p256dh, auth, created_at) "
                  "VALUES (?, ?, ?, ?, ?)", (body.endpoint, session, body.p256dh, body.auth,
                                             datetime.now(timezone.utc).isoformat()))
    return {"ok": True}


@router.delete("/api/push/subscription")
def unsubscribe(request: Request, endpoint: str | None = None, apollo_session: str | None = Cookie(None),
                _: int = Depends(auth.current_user)):
    """Sans endpoint : coupe les notifications de cet appareil. Avec : supprime cet abonnement-là seulement (une
    désinscription rejouée en retard ne supprime pas l'abonnement qui l'a remplacé)."""
    session = auth.digest(auth.request_token(request, apollo_session) or "")
    with db.connect() as c:
        if endpoint is None:
            c.execute("DELETE FROM push_subscriptions WHERE session = ?", (session,))
        else:
            c.execute("DELETE FROM push_subscriptions WHERE session = ? AND endpoint = ?", (session, endpoint))
    return {"ok": True}


@router.get("/api/push/subscription")
def subscribed(request: Request, apollo_session: str | None = Cookie(None), _: int = Depends(auth.current_user)):
    with db.connect() as c:
        row = c.execute("SELECT endpoint FROM push_subscriptions WHERE session = ?",
                        (auth.digest(auth.request_token(request, apollo_session) or ""),)).fetchone()
    session = auth.digest(auth.request_token(request, apollo_session) or "")
    return {"abonne": bool(row), "endpoint": row["endpoint"] if row else None, "pour": session_tag(session)}


@router.post("/api/push/test")
async def test(request: Request, apollo_session: str | None = Cookie(None), user: int = Depends(auth.current_user)):
    """Message de test pour cet appareil seulement : le succès d'un autre appareil ne doit pas masquer un échec ici."""
    return await send("Noah", "Les notifications arrivent bien sur cet appareil.", user_id=user,
                      session=auth.digest(auth.request_token(request, apollo_session) or ""))
