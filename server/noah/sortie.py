"""Sortie réseau des navigateurs d'agents : par où les sites les voient arriver (lot sortie-reseau).

Trois sorties, dans l'ordre : la maison (nœud de sortie Tailscale sur le PC de la personne), un VPN (Surfshark par Gluetun), puis le
serveur lui-même. Le lanceur crée les conteneurs et l'aiguillage qui choisit (launcher/aiguillage.py) ; ici, on garde ce que la
personne a saisi et on le lui montre.

Les clés (Tailscale, WireGuard) sont scellées en base (db.seal), envoyées au seul lanceur (jamais à l'agent, jamais à l'écran), et
absentes de toute réponse, de tout journal et de toute erreur : on ne renvoie que « une clé est enregistrée ».
Sans sortie configurée, rien ne change : pas de conteneur de plus, pas d'appel au lanceur.
"""
import asyncio
import re
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import access, db, hermes

router = APIRouter()

KEY_RE = re.compile(r"^[\w.+/=-]{8,512}$")  # clé d'authentification Tailscale (tskey-auth-…)
WG_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")  # clé privée WireGuard : 32 octets en base64
NODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
CITY_RE = re.compile(r"^[A-Za-z][A-Za-z .'-]{0,39}$")
ADDRESS_RE = re.compile(r"^[0-9a-fA-F:.]{3,45}/\d{1,3}(,[0-9a-fA-F:.]{3,45}/\d{1,3})?$")
DEFAULT_ADDRESS = "10.14.0.2/16"  # l'adresse que Surfshark donne à tous ses clients WireGuard
DEFAULT_CITY = "Montreal"
TITLES = {"maison": "Maison", "vpn": "VPN", "serveur": "Serveur"}
STATUS_TTL = 5.0
LOCATION_TTL = 600.0
_status: dict = {"at": 0.0, "value": None}
_server_ip: dict = {"at": 0.0, "value": ""}
_push_lock = asyncio.Lock()


# --- Ce que la personne a saisi ---------------------------------------------------------------------------------------

def _setting(key: str, secret: bool = False) -> str:
    try:
        return db.get_setting(f"sortie:{key}", secret=secret) or ""
    except Exception:  # noqa: BLE001 - une valeur scellée avec une autre clé : comme si elle n'existait pas
        return ""


def maison() -> dict | None:
    key, node = _setting("maison:cle", True), _setting("maison:noeud")
    return {"cle": key, "noeud": node} if node else None


def vpn() -> dict | None:
    key = _setting("vpn:cle", True)
    return {"cle_privee": key, "adresse": _setting("vpn:adresse") or DEFAULT_ADDRESS, "ville": _setting("vpn:ville") or DEFAULT_CITY} if key else None


def configured() -> bool:
    return bool(maison() or vpn())


def launcher_config() -> dict:
    """La configuration complète pour le lanceur, qui ne garde rien lui-même : seule voie des clés, serveur vers lanceur."""
    return {"maison": maison(), "vpn": vpn()}


# --- Le lanceur -------------------------------------------------------------------------------------------------------

async def push() -> dict:
    """Pose la configuration chez le lanceur : crée, remplace ou retire les conteneurs qui ont changé."""
    async with _push_lock:
        try:
            out = await hermes._launcher("PUT", "/sortie", json=launcher_config(), timeout=900)  # la première fois, il télécharge les images
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, _launcher_reason(e)) from None
        except httpx.HTTPError:
            raise HTTPException(502, "Le lanceur ne répond pas : réessaie dans un instant.") from None
    _status["at"] = 0.0
    return out


def _launcher_reason(e: httpx.HTTPStatusError) -> str:
    try:
        return str(e.response.json().get("detail") or "")[:300] or "Le lanceur a refusé cette configuration."
    except ValueError:
        return "Le lanceur a refusé cette configuration."


async def status(fresh: bool = False) -> dict | None:
    """Ce que dit le lanceur : {"conteneurs": {...}, "aiguillage": {...} | None}. None : il ne répond pas. Court cache."""
    if not fresh and time.monotonic() - _status["at"] < STATUS_TTL:
        return _status["value"]
    try:
        value = await hermes._launcher("GET", "/sortie", timeout=15)
    except httpx.HTTPError:
        value = None
    _status.update(at=time.monotonic(), value=value)
    return value


async def reconcile() -> None:
    """Avant de créer un navigateur : si une sortie est configurée et qu'un de ses conteneurs manque (supprimé à la main, VPS
    restauré), on le recrée. Sans sortie configurée, ne fait rien : aucun appel."""
    if not configured():
        return
    state = await status(fresh=True)
    if state is None:
        return  # le lanceur dira son erreur à la création du navigateur
    wanted = {"noah-sortie": True, "noah-sortie-maison": bool(maison()), "noah-sortie-vpn": bool(vpn())}
    have = state.get("conteneurs") or {}
    if any(have.get(name) != want for name, want in wanted.items()):
        await push()


# --- Langue et fuseau de la sortie active --------------------------------------------------------------------------------

async def active_geo() -> dict | None:
    """Pays, région et fuseau de la sortie active (maison ou VPN), pour que le navigateur ait la langue et l'heure de l'endroit
    où les sites le voient. None : pas de sortie configurée, repli direct, ou adresse pas encore lue."""
    if not configured():
        return None
    state = await status()
    air = (state or {}).get("aiguillage") or {}
    for s in air.get("sorties") or []:
        if s.get("nom") == air.get("active") and s["nom"] != "direct" and s.get("country") and s.get("timezone"):
            return {"country": s["country"], "region": s.get("region") or "", "timezone": s["timezone"]}
    return None


# --- L'écran ------------------------------------------------------------------------------------------------------------

async def _server_address() -> str:
    from . import public
    if time.monotonic() - _server_ip["at"] > LOCATION_TTL or not _server_ip["value"]:
        _server_ip.update(at=time.monotonic(), value=public._state.get("ip") or await public._public_ip())
    return _server_ip["value"]


def _place(s: dict) -> str:
    return ", ".join(p for p in (s.get("city"), s.get("region")) if p)


async def summary() -> dict:
    state = await status(fresh=True) if configured() else None
    air = (state or {}).get("aiguillage") or {}
    by_name = {s["nom"]: s for s in air.get("sorties") or []}
    lines = []
    for ident in ("maison", "vpn", "serveur"):
        is_set = {"maison": maison, "vpn": vpn, "serveur": lambda: True}[ident]() is not None
        s = by_name.get("direct" if ident == "serveur" else ident)
        if not is_set:
            etat = "non_configuree"
        elif ident == "serveur":
            etat = "active" if not air or air.get("active") in (None, "direct") else "prete"
        elif not s:
            etat = "en_attente"  # lanceur muet, ou aiguillage qui démarre : pas encore de sonde
        else:
            etat = {"active": "active", "prete": "prete", "injoignable": "injoignable"}.get(s.get("etat"), "en_attente")
        address = (s or {}).get("ip") or ""
        if ident == "serveur" and not address:
            address = await _server_address()
        line = {"id": ident, "titre": TITLES[ident], "etat": etat, "adresse": address, "lieu": _place(s or {}), "configuree": is_set}
        if ident == "maison":
            line["noeud"] = (maison() or {}).get("noeud", "")
            line["cle"] = bool((maison() or {}).get("cle"))
        if ident == "vpn":
            line["ville"] = (vpn() or {}).get("ville", "")
            line["adresse_wireguard"] = (vpn() or {}).get("adresse", "")
            line["cle"] = bool(vpn())
        lines.append(line)
    return {"lignes": lines, "active": air.get("active") if configured() else "direct", "bascules": air.get("bascules") or [],
            "lanceur": state is not None or not configured()}


class Maison(BaseModel):
    cle: str = ""  # vide : on garde celle qui est enregistrée
    noeud: str = ""


class Vpn(BaseModel):
    cle_privee: str = ""  # vide : on garde celle qui est enregistrée
    adresse: str = ""
    ville: str = ""


@router.get("/api/sortie")
async def sortie_summary(user: int = Depends(access.owner_only)):
    return await summary()


@router.put("/api/sortie/maison")
async def sortie_maison(body: Maison, user: int = Depends(access.owner_only)):
    node = body.noeud.strip() or _setting("maison:noeud")
    key = body.cle.strip()
    if not NODE_RE.match(node):
        raise HTTPException(400, "Le nom du nœud de sortie ne va pas : le nom de ton PC dans Tailscale (lettres, chiffres, tirets) ou son adresse en 100.….")
    if key and not KEY_RE.match(key):
        raise HTTPException(400, "Cette clé Tailscale n'a pas la bonne forme : elle commence par tskey-auth- et ne contient ni espace ni retour à la ligne.")
    if not key and not _setting("maison:cle", True) and not _setting("maison:noeud"):
        raise HTTPException(400, "Colle la clé d'authentification Tailscale : sans elle, Noah ne peut pas rejoindre ton réseau.")
    if key:
        db.set_setting("sortie:maison:cle", key, secret=True)
    db.set_setting("sortie:maison:noeud", node)
    await push()
    return await summary()


@router.put("/api/sortie/vpn")
async def sortie_vpn(body: Vpn, user: int = Depends(access.owner_only)):
    key = body.cle_privee.strip()
    address = body.adresse.strip() or _setting("vpn:adresse") or DEFAULT_ADDRESS
    city = body.ville.strip() or _setting("vpn:ville") or DEFAULT_CITY
    if key and not WG_RE.match(key):
        raise HTTPException(400, "Cette clé WireGuard n'a pas la bonne forme : 44 caractères qui finissent par =, sans espace.")
    if not key and not _setting("vpn:cle", True):
        raise HTTPException(400, "Colle la clé privée WireGuard de ton compte Surfshark.")
    if not ADDRESS_RE.match(address):
        raise HTTPException(400, "L'adresse WireGuard ne va pas : elle ressemble à 10.14.0.2/16.")
    if not CITY_RE.match(city):
        raise HTTPException(400, "La ville ne va pas : son nom en anglais, comme Montreal.")
    if key:
        db.set_setting("sortie:vpn:cle", key, secret=True)
    db.set_setting("sortie:vpn:adresse", address)
    db.set_setting("sortie:vpn:ville", city)
    await push()
    return await summary()


@router.delete("/api/sortie/{ident}")
async def sortie_remove(ident: str, user: int = Depends(access.owner_only)):
    if ident not in ("maison", "vpn"):
        raise HTTPException(404, "Cette sortie n'existe pas.")
    for key in {"maison": ("maison:cle", "maison:noeud"), "vpn": ("vpn:cle", "vpn:adresse", "vpn:ville")}[ident]:
        with db.connect() as c:
            c.execute("DELETE FROM settings WHERE key = ?", (f"sortie:{key}",))
    await push()
    return await summary()
