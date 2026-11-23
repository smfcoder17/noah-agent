"""Sortie réseau des navigateurs d'agents : par où les sites les voient arriver (lot sortie-reseau).

Trois sorties, dans l'ordre : la maison (l'ordinateur de la personne, par son app de bureau : relais, voir sortie_relais.py), un VPN
(le fichier de configuration WireGuard de son fournisseur, par Gluetun), puis le serveur lui-même. Le lanceur crée l'aiguillage qui
choisit (launcher/aiguillage.py) et, pour le VPN, son conteneur ; ici, on garde ce que la personne a choisi et on le lui montre.

La maison ne demande rien de plus qu'un interrupteur dans l'app de bureau : ni compte, ni clé, ni conteneur. Le VPN, lui, se colle
sous « Avancé » : le fichier est scellé en base (db.seal), envoyé au seul lanceur (jamais à l'agent, jamais à l'écran), et absent de
toute réponse, de tout journal et de toute erreur : on ne renvoie que « un VPN est enregistré ».
Sans relais ni VPN, rien ne change : pas de conteneur de plus, pas d'appel au lanceur.

Avant la 0.4.3 la maison était un nœud de sortie Tailscale : sa clé et son nom sont effacés au premier démarrage (migrer), et le
lanceur retire le conteneur qui reste. Un VPN Surfshark enregistré par clé continue de marcher tel quel (fournisseur « surfshark »).
"""
import asyncio
import ipaddress
import re
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import access, db, hermes, sortie_relais

router = APIRouter()

WG_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")  # clé WireGuard : 32 octets en base64
ENDPOINT_RE = re.compile(r"^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5})$")
CITY_RE = re.compile(r"^[A-Za-z][A-Za-z .'-]{0,39}$")
ADDRESS_RE = re.compile(r"^[0-9a-fA-F:.]{3,45}/\d{1,3}(,[0-9a-fA-F:.]{3,45}/\d{1,3})?$")
DEFAULT_ADDRESS = "10.14.0.2/16"  # l'adresse que Surfshark donne à tous ses clients WireGuard
DEFAULT_CITY = "Montreal"
WG_MAX = 8 * 1024
STATUS_TTL = 5.0
LOCATION_TTL = 600.0
_status: dict = {"at": 0.0, "value": None}
_server_ip: dict = {"at": 0.0, "value": ""}
_push_lock = asyncio.Lock()


# --- Ce que la personne a choisi ---------------------------------------------------------------------------------------

def _setting(key: str, secret: bool = False) -> str:
    try:
        return db.get_setting(f"sortie:{key}", secret=secret) or ""
    except Exception:  # noqa: BLE001 - une valeur scellée avec une autre clé : comme si elle n'existait pas
        return ""


def maison() -> dict | None:
    """La maison est voulue quand l'app de bureau a été mise en route par l'interrupteur (sortie_relais.voulu)."""
    return {"actif": True} if sortie_relais.voulu() else None


def vpn() -> dict | None:
    conf = _setting("vpn:conf", True)
    if conf:
        return {"fournisseur": "custom", "conf": conf}
    key = _setting("vpn:cle", True)  # enregistré avant la 0.4.3 : Surfshark par sa clé, Gluetun choisit le serveur de la ville
    if key:
        return {"fournisseur": "surfshark", "cle_privee": key, "adresse": _setting("vpn:adresse") or DEFAULT_ADDRESS,
                "ville": _setting("vpn:ville") or DEFAULT_CITY}
    return None


def configured() -> bool:
    return bool(maison() or vpn())


def launcher_config() -> dict:
    """La configuration complète pour le lanceur, qui ne garde rien lui-même : seule voie du fichier VPN, serveur vers lanceur."""
    return {"maison": maison(), "vpn": vpn()}


def wireguard(texte: str) -> str:
    """Le fichier de configuration WireGuard d'un fournisseur, vérifié et réécrit avec les seules lignes dont Gluetun a besoin
    (clé privée, adresses, clé du serveur, point d'accès, plages). Toute autre ligne, et surtout celles qui lancent une commande
    (PostUp, PreUp…), est refusée : un fichier collé ne doit jamais exécuter quoi que ce soit. ValueError avec un message lisible."""
    if len(texte) > WG_MAX:
        raise ValueError("Ce fichier est trop long pour être une configuration WireGuard.")
    interface: dict[str, str] = {}
    peers: list[dict[str, str]] = []
    section = None
    for brut in texte.replace("\r", "").split("\n"):
        ligne = brut.split("#", 1)[0].strip()
        if not ligne:
            continue
        if ligne.startswith("["):
            nom = ligne.lower()
            if nom == "[interface]" and section is None and not interface:
                section = interface
            elif nom == "[peer]" and not peers:
                section = {}
                peers.append(section)
            else:
                raise ValueError("Cette configuration doit avoir une section [Interface] puis une seule section [Peer].")
            continue
        if section is None or "=" not in ligne:
            raise ValueError("Une ligne de cette configuration n'est pas de la forme « Nom = valeur ».")
        cle, valeur = (x.strip() for x in ligne.split("=", 1))
        cle = cle.lower()
        autorisees = ("privatekey", "address", "dns", "mtu", "listenport") if section is interface else \
            ("publickey", "presharedkey", "allowedips", "endpoint", "persistentkeepalive")
        if cle not in autorisees:
            raise ValueError("Cette configuration contient une ligne que Noah n'accepte pas, par sécurité (par exemple PostUp ou Table).")
        section[cle] = valeur
    if not interface or len(peers) != 1:
        raise ValueError("Cette configuration doit avoir une section [Interface] puis une seule section [Peer].")
    peer = peers[0]
    if not WG_KEY_RE.match(interface.get("privatekey", "")):
        raise ValueError("La clé privée (PrivateKey) de cette configuration n'a pas la bonne forme.")
    if not WG_KEY_RE.match(peer.get("publickey", "")) or (peer.get("presharedkey") and not WG_KEY_RE.match(peer["presharedkey"])):
        raise ValueError("Une clé du serveur (PublicKey ou PresharedKey) de cette configuration n'a pas la bonne forme.")
    try:
        adresses = [str(ipaddress.ip_interface(a.strip())) for a in interface.get("address", "").split(",") if a.strip()]
        plages = [str(ipaddress.ip_network(a.strip(), strict=False)) for a in (peer.get("allowedips") or "0.0.0.0/0, ::/0").split(",") if a.strip()]
    except ValueError:
        raise ValueError("Les adresses (Address ou AllowedIPs) de cette configuration n'ont pas la bonne forme.") from None
    point = ENDPOINT_RE.match(peer.get("endpoint", ""))
    if not adresses or not plages or not point or not 0 < int(point.group(2)) < 65536:
        raise ValueError("Il manque l'adresse du serveur VPN (Endpoint) ou la tienne (Address) dans cette configuration.")
    sortie = ["[Interface]", f"PrivateKey = {interface['privatekey']}", f"Address = {', '.join(adresses)}", "",
              "[Peer]", f"PublicKey = {peer['publickey']}"]
    if peer.get("presharedkey"):
        sortie.append(f"PresharedKey = {peer['presharedkey']}")
    sortie += [f"AllowedIPs = {', '.join(plages)}", f"Endpoint = {peer['endpoint']}", ""]
    return "\n".join(sortie)


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
    restauré), on le recrée ; un reste de l'ancienne maison (Tailscale) est retiré. Sans sortie configurée, ne fait rien : aucun appel."""
    if not configured():
        return
    state = await status(fresh=True)
    if state is None:
        return  # le lanceur dira son erreur à la création du navigateur
    wanted = {"noah-sortie": True, "noah-sortie-maison": False, "noah-sortie-vpn": bool(vpn())}
    have = state.get("conteneurs") or {}
    if any(bool(have.get(name)) != want for name, want in wanted.items()):
        await push()


async def migrer() -> None:
    """Au démarrage : la clé Tailscale et le nom du nœud d'avant la 0.4.3 sont effacés, et le lanceur retire ce qui en reste
    (conteneur, volume). La maison repasse par l'interrupteur de l'app de bureau : rien n'est repris tout seul."""
    with db.connect() as c:
        reste = c.execute("DELETE FROM settings WHERE key IN ('sortie:maison:cle', 'sortie:maison:noeud')").rowcount
    if reste:
        print("[sortie] ancienne sortie Tailscale effacée ; la maison passe désormais par l'app de bureau", flush=True)
        try:
            await push()
        except HTTPException as e:
            print(f"[sortie] le lanceur n'a pas encore retiré l'ancien conteneur ({e.detail})", flush=True)
    await sortie_relais.demarrer()


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
    active = air.get("active") if configured() else "direct"
    home = by_name.get("maison") or {}
    relais = sortie_relais.etat()
    if not relais["voulu"]:
        phase = "sans_relais"
    elif not relais["connecte"]:
        phase = "relais_eteint"
    elif active == "maison":
        phase = "relais_actif"
    else:
        phase = "relais_connecte"  # relié, mais l'aiguillage n'y est pas encore passé (sondes, ou délai avant de changer de sortie)
    reglage = vpn()
    v = by_name.get("vpn") or {}
    if not reglage:
        vpn_etat = "non_configure"
    elif not v:
        vpn_etat = "en_attente"
    else:
        vpn_etat = {"active": "actif", "prete": "pret", "injoignable": "injoignable"}.get(v.get("etat"), "en_attente")
    return {
        "phase": phase,
        "relais": {"voulu": relais["voulu"], "connecte": relais["connecte"], "nom": relais["nom"],
                   "adresse": home.get("ip") or "", "lieu": _place(home)},
        "vpn": {"configure": reglage is not None, "fournisseur": (reglage or {}).get("fournisseur", ""), "etat": vpn_etat,
                "adresse": v.get("ip") or "", "lieu": _place(v), "ville": (reglage or {}).get("ville", "")},
        "serveur": {"adresse": await _server_address()},
        "active": active,
        "bascules": air.get("bascules") or [],
        "lanceur": state is not None or not configured(),
    }


class Vpn(BaseModel):
    conf: str = ""  # le fichier de configuration WireGuard du fournisseur


@router.get("/api/sortie")
async def sortie_summary(user: int = Depends(access.owner_only)):
    return await summary()


@router.put("/api/sortie/vpn")
async def sortie_vpn(body: Vpn, user: int = Depends(access.owner_only)):
    try:
        conf = wireguard(body.conf)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    db.set_setting("sortie:vpn:conf", conf, secret=True)
    _forget_surfshark()  # la configuration collée remplace l'ancienne clé Surfshark
    await push()
    return await summary()


def _forget_surfshark() -> None:
    with db.connect() as c:
        c.execute("DELETE FROM settings WHERE key IN ('sortie:vpn:cle', 'sortie:vpn:adresse', 'sortie:vpn:ville')")


@router.delete("/api/sortie/vpn")
async def sortie_vpn_remove(user: int = Depends(access.owner_only)):
    _forget_surfshark()
    with db.connect() as c:
        c.execute("DELETE FROM settings WHERE key = 'sortie:vpn:conf'")
    await push()
    return await summary()
