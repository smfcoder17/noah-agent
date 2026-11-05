"""Nouvel appareil sur un compte : l'alerte, et « C'est moi » / « Ce n'est pas moi ». L'état vit côté serveur : l'écran se montre à
l'ouverture de n'importe quel autre appareil tant que personne n'a tranché, même celui qui n'a jamais vu ce compte. La connexion
n'attend aucun accord : ce serait enfermer le propriétaire dehors.

Un navigateur se reconnaît à un cookie sans aucun droit (noah_appareil) et au réseau d'où il a été confirmé : il n'est connu qu'une
fois confirmé, ou s'il est le tout premier du compte. Se déconnecter puis revenir ne fait donc pas disparaître un intrus.

« Ce n'est pas moi » coupe la session signalée, sans preuve : un geste de défense, limité à une session signalée. Il reste ouvert à
un jeton volé contre la toute nouvelle session de la personne, qui n'a qu'à se reconnecter ; il ne touche à aucun autre appareil.

« C'est moi » ne se décide pas depuis une session elle-même signalée, tant qu'un appareil au-dessus de tout soupçon existe : deux
connexions d'un voleur de mot de passe ne s'approuvent pas l'une l'autre. Sans un tel appareil, la plus ancienne décide pour les
plus récentes, qui peuvent ensuite la confirmer à leur tour.
"""
import asyncio
import hashlib
import hmac
import ipaddress
import logging
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from . import auth, courriel, db, desktop, push
from .config import SECRET_KEY

router = APIRouter()
log = logging.getLogger("uvicorn.error")

COOKIE = "noah_appareil"
COOKIE_DAYS = 400
FORGET_AFTER = COOKIE_DAYS * 86400


def network(ip: str) -> str:
    """Le réseau, pas l'adresse : un boîtier change souvent de dernière adresse. /24 en IPv4, /64 en IPv6."""
    try:
        return str(ipaddress.ip_network(f"{ip}/{64 if ':' in ip else 24}", strict=False))
    except ValueError:
        return ip


def cookie_value(request: Request) -> str:
    value = request.cookies.get(COOKIE, "")
    return value if 20 <= len(value) <= 64 else secrets.token_urlsafe(24)


def device_print(user: int, value: str) -> str:
    return hmac.new(SECRET_KEY.encode(), f"noah-appareil:{user}:{value}".encode(), hashlib.sha256).hexdigest()


def first_device(user: int) -> bool:
    """Aucune session et aucun navigateur connu : le premier appareil du compte n'a personne à prévenir."""
    with db.connect() as c:
        return (c.execute("SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1", (user,)).fetchone() is None
                and c.execute("SELECT 1 FROM appareils_connus WHERE user_id = ? LIMIT 1", (user,)).fetchone() is None)


def remember(user: int, fingerprint: str, reseau: str) -> None:
    now = time.time()
    with db.connect() as c:
        c.execute("DELETE FROM appareils_connus WHERE vu < ?", (now - FORGET_AFTER,))
        c.execute("INSERT INTO appareils_connus (user_id, empreinte, reseau, vu) VALUES (?, ?, ?, ?) "
                  "ON CONFLICT(user_id, empreinte, reseau) DO UPDATE SET vu = excluded.vu", (user, fingerprint, reseau, now))


def known(user: int, fingerprint: str, ip: str) -> bool:
    with db.connect() as c:
        return c.execute("SELECT 1 FROM appareils_connus WHERE user_id = ? AND empreinte = ? AND reseau = ?",
                         (user, fingerprint, network(ip))).fetchone() is not None


def _network_seen(c, user: int, session: str, ip: str) -> bool:
    here = network(ip)
    if c.execute("SELECT 1 FROM appareils_connus WHERE user_id = ? AND reseau = ?", (user, here)).fetchone():
        return True
    rows = c.execute("SELECT last_ip FROM sessions WHERE user_id = ? AND token != ?", (user, session)).fetchall()
    return any(r["last_ip"] and network(r["last_ip"]) == here for r in rows)


def signal(user: int, session: str, name: str, kind: str, ip: str, fingerprint: str = "") -> dict:
    """Note l'alerte tout de suite : elle existe même si la notification se perd. À envoyer ensuite par `announce`."""
    alert = {"id": secrets.token_urlsafe(12), "user": user, "nom": name[:80], "type": kind[:20], "ip": ip[:64],
             "cree": datetime.now(timezone.utc).isoformat()}
    with db.connect() as c:
        alert["reseau_connu"] = _network_seen(c, user, session, ip)
        # La session a pu être révoquée à l'instant : alors, plus rien à signaler sur cet écran.
        c.execute("INSERT INTO alertes_appareils (id, user_id, session, empreinte, nom, type, ip, reseau, reseau_connu, cree) "
                  "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE token = ?)",
                  (alert["id"], user, session, fingerprint, alert["nom"], alert["type"], alert["ip"], network(ip),
                   int(alert["reseau_connu"]), alert["cree"], session))
    return alert


async def announce(alert: dict) -> None:
    """Sur les appareils déjà reliés, là où chacun écoute : notification (navigateur, téléphone), application de bureau, courriel."""
    user, name, ip = alert["user"], alert["nom"] or "Appareil inconnu", alert["ip"]
    when = datetime.fromisoformat(alert["cree"]).strftime("%d/%m/%Y à %H:%M (UTC)")
    network_word = "réseau déjà vu" if alert["reseau_connu"] else "réseau jamais vu"
    title = "Nouvel appareil sur ton compte"
    text = f"{name}, adresse {ip or 'inconnue'}, {network_word}, le {when}. Ouvre Noah pour dire si c'est toi."
    try:
        await push.send(title, text, urgent=True, user_id=user)
    except Exception as e:  # noqa: BLE001 — une notification perdue ne change rien : l'écran reste à l'ouverture
        log.warning("Alerte de nouvel appareil non envoyée : %s", type(e).__name__)
    try:
        desktop.send_native(user, title, text)
    except Exception as e:  # noqa: BLE001
        log.warning("Alerte de nouvel appareil non transmise à l'application de bureau : %s", type(e).__name__)
    await asyncio.to_thread(courriel.notify_device, user, alert["nom"], ip, alert["reseau_connu"], when)


def _session_of(request: Request) -> str:
    return auth.session_key(auth.request_token(request, request.cookies.get(auth.COOKIE)))


def _may_confirm(c, user: int, me: str, target: str) -> bool:
    now = datetime.now(timezone.utc).isoformat()
    sessions = c.execute("SELECT token, created_at FROM sessions WHERE user_id = ? AND expires_at > ?", (user, now)).fetchall()
    flagged = {r["session"] for r in c.execute("SELECT session FROM alertes_appareils WHERE user_id = ? AND tranche = 0", (user,))}
    if me not in flagged:
        return True
    if any(s["token"] not in flagged for s in sessions):
        return False
    born = {s["token"]: s["created_at"] or "" for s in sessions}
    return born.get(me, "") < born.get(target, "")


@router.get("/api/me/alertes-appareils")
def pending(request: Request, user: int = Depends(auth.current_user)):
    """Les sessions signalées sur lesquelles personne n'a tranché, sauf celle qui demande : un appareil ne se signale pas à lui-même."""
    me = _session_of(request)
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as c:
        rows = c.execute("SELECT a.* FROM alertes_appareils a JOIN sessions s ON s.token = a.session "
                         "WHERE a.user_id = ? AND a.tranche = 0 AND a.session != ? AND s.expires_at > ? ORDER BY a.cree",
                         (user, me, now)).fetchall()
        return {"alertes": [{"id": r["id"], "nom": r["nom"], "type": r["type"], "ip": r["ip"], "reseau_connu": bool(r["reseau_connu"]),
                             "date": r["cree"], "peut_confirmer": _may_confirm(c, user, me, r["session"])} for r in rows]}


def _alert(c, user: int, alert_id: str, me: str):
    row = c.execute("SELECT * FROM alertes_appareils WHERE id = ? AND user_id = ? AND tranche = 0", (alert_id, user)).fetchone()
    if not row or row["session"] == me:
        raise HTTPException(404, "Cette alerte n'existe plus : quelqu'un a déjà tranché, ou cet appareil est déjà déconnecté.")
    return row


@router.post("/api/me/alertes-appareils/{alert_id}/moi")
def it_was_me(alert_id: str, request: Request, user: int = Depends(auth.current_user)):
    me = _session_of(request)
    with db.connect() as c:
        row = _alert(c, user, alert_id, me)
        if not _may_confirm(c, user, me, row["session"]):
            raise HTTPException(403, "Confirme depuis un appareil déjà relié : celui-ci est lui-même en attente de confirmation.")
        c.execute("UPDATE alertes_appareils SET tranche = 1 WHERE id = ?", (alert_id,))
    if row["empreinte"]:
        remember(user, row["empreinte"], row["reseau"])
    return {"ok": True}


@router.post("/api/me/alertes-appareils/{alert_id}/pas-moi")
def not_me(alert_id: str, request: Request, user: int = Depends(auth.current_user)):
    """Pas de preuve : c'est le geste de défense. Seulement la session signalée, et son navigateur n'est plus reconnu."""
    me = _session_of(request)
    with db.connect() as c:
        row = _alert(c, user, alert_id, me)
        c.execute("DELETE FROM sessions WHERE token = ? AND user_id = ?", (row["session"], user))  # l'alerte et ses fenêtres suivent
        if row["empreinte"]:
            c.execute("DELETE FROM appareils_connus WHERE user_id = ? AND empreinte = ?", (user, row["empreinte"]))
    log.warning("Compte n°%d : session signalée coupée par « Ce n'est pas moi » (adresse %s).", user, row["ip"] or "inconnue")
    return {"ok": True, "changer_mot_de_passe": True}
