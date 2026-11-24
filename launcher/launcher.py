"""Lanceur d'agents : seul service qui parle à Docker.

Il n'accepte qu'un petit vocabulaire (créer, écrire la config, redémarrer, supprimer un agent)
et construit lui-même chaque conteneur à partir d'une image fixe, sans montage de l'hôte ni
privilège. Le serveur Noah Agent n'a donc jamais accès au socket Docker.
"""
import base64
import functools
import io
import hmac
import json
import os
import re
import tarfile
import threading
import time
from pathlib import Path

import docker

import aiguillage
import restore
import updater
from docker.errors import NotFound
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel


def _shared_key() -> str:
    """Même clé que le serveur : de .env (install.sh), sinon du fichier de secrets que le serveur tire au premier
    démarrage dans le volume commun (installation sans variables)."""
    if os.environ.get("LAUNCHER_KEY"):
        return os.environ["LAUNCHER_KEY"]
    path = Path(os.environ.get("NOAH_SECRETS_FILE", "/secrets/noah.json"))
    for _ in range(240):
        try:
            return json.loads(path.read_text())["LAUNCHER_KEY"]
        except (FileNotFoundError, ValueError, KeyError):
            time.sleep(0.5)
    raise RuntimeError(f"Clé du lanceur introuvable dans {path}")


KEY = _shared_key()
IMAGE = os.environ.get("AGENT_IMAGE", "nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d")
# E1 (audit 0.3.0) : agents et navigateurs sur un réseau à eux, où le lanceur n'est pas. Les fichiers d'avant donnaient
# « noah-net », le réseau commun avec le lanceur : il devient « noah-agents ». Un autre nom (bancs d'essai) reste tel quel.
SHARED_NETWORK = "noah-net"
NETWORK = "noah-agents" if os.environ.get("AGENT_NETWORK", SHARED_NETWORK) in ("", SHARED_NETWORK) else os.environ["AGENT_NETWORK"]
MANAGED_NETWORK = NETWORK == "noah-agents"  # créé et tenu par le lanceur ; un réseau de banc d'essai l'est par son banc
SERVER_NAME = os.environ.get("NOAH_SERVER_NAME", "noah-server")
# Capacités : toutes retirées, puis seulement celles dont l'essai a prouvé le besoin (isolement_reel.sh, securite-audit.md).
# Hermes démarre en root sous s6 puis passe à l'utilisateur hermes (SETUID, SETGID), règle son volume (CHOWN, DAC_OVERRIDE)
# et s'arrête proprement (KILL : s6 signale des processus d'un autre utilisateur). Camoufox tourne en root et ne demande
# rien ; les programmes du bureau de son écran passent au compte 1001, ce qui demande SETUID et SETGID. Sans elles,
# le bureau ne démarrait jamais (EACCES) : Firefox seul, sans gestionnaire de fenêtres (tests/navigateur/bureau_reel.mjs).
AGENT_CAPS = ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL"]
BROWSER_CAPS: list[str] = ["SETUID", "SETGID"]
PREFIX = "noah-agent-"
LABEL = "noah.agent"
DATA = "/opt/data"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")

client = docker.from_env()
# Ni /docs, ni /redoc, ni /openapi.json : les machines des agents joignent ce service, il ne leur décrit pas ses routes.
app = FastAPI(title="Noah Agent launcher", docs_url=None, redoc_url=None, openapi_url=None)

# E1 : le lanceur ne répond qu'aux conteneurs nommés ici (le serveur), au relais des mises à jour et à lui-même. Les autres
# voisins de son réseau (Caddy) reçoivent 403, même avec la clé. Vide (bancs d'essai, fichiers d'avant) : pas de filtre.
CLIENTS = [n.strip() for n in os.environ.get("NOAH_LANCEUR_CLIENTS", "").split(",") if n.strip()]
_peers: dict[str, float] = {}  # adresse -> fin de validité
_peers_read = [0.0]


def _peer_allowed(host: str) -> bool:
    if not CLIENTS or host in ("127.0.0.1", "::1"):
        return True
    now = time.monotonic()
    if _peers.get(host, 0) > now:
        return True
    if now - _peers_read[0] < 1:  # une adresse inconnue ne fait pas interroger Docker à chaque appel
        return False
    _peers_read[0] = now
    known = set()
    for name in (*CLIENTS, updater.RELAY):
        try:
            networks = client.containers.get(name).attrs.get("NetworkSettings", {}).get("Networks") or {}
        except Exception:  # noqa: BLE001 - absent (relais) ou Docker occupé : pas d'adresse de plus
            continue
        known |= {n.get("IPAddress") for n in networks.values() if isinstance(n, dict) and n.get("IPAddress")}
    _peers.clear()
    _peers.update({ip: now + 60 for ip in known})
    return host in known


@app.middleware("http")
async def _only_clients(request: Request, call_next):
    from starlette.concurrency import run_in_threadpool
    if not await run_in_threadpool(_peer_allowed, request.client.host if request.client else ""):
        return JSONResponse({"detail": "Le lanceur ne répond qu'au serveur."}, status_code=403)
    return await call_next(request)


_network_lock = threading.Lock()


def _ensure_agents_network() -> None:
    """E1 : le réseau des agents existe, et le serveur y est branché sous son nom (les agents l'appellent noah-server).
    Le lanceur, lui, n'y est jamais : un agent ou un navigateur compromis ne le joint pas."""
    if not MANAGED_NETWORK:
        return
    with _network_lock:
        try:
            net = client.networks.get(NETWORK)
        except NotFound:
            net = client.networks.create(NETWORK, driver="bridge", labels={"noah.reseau": "agents"})
        try:
            server = client.containers.get(SERVER_NAME)
        except NotFound:
            return  # le serveur n'est pas encore créé : la veille le branchera
        if NETWORK not in (server.attrs.get("NetworkSettings", {}).get("Networks") or {}):
            net.connect(server, aliases=[SERVER_NAME])
            print(f"[lanceur] {SERVER_NAME} branché sur {NETWORK}", flush=True)


def _watch_network() -> None:
    """Le serveur recréé par `docker compose up` perd les réseaux branchés à la main : la veille le rebranche."""
    while True:
        try:
            _ensure_agents_network()
        except Exception as e:  # noqa: BLE001 - Docker occupé : au prochain tour
            print(f"[lanceur] réseau des agents : {e}", flush=True)
        time.sleep(15)


_key_read = [None]  # date du fichier de secrets au dernier chargement de KEY


def _reload_key() -> bool:
    """M5 : la clé renouvelée par `python -m noah.cle_lanceur` (serveur) est prise sans redémarrer ; l'ancienne ne vaut plus.
    Une clé fixée par l'environnement ne change pas ici."""
    global KEY
    if os.environ.get("LAUNCHER_KEY"):
        return False
    path = Path(os.environ.get("NOAH_SECRETS_FILE", "/secrets/noah.json"))
    try:
        stamp = path.stat().st_mtime_ns
        if stamp == _key_read[0]:
            return False
        fresh = json.loads(path.read_text())["LAUNCHER_KEY"]
    except (OSError, ValueError, KeyError, TypeError):
        return False
    _key_read[0] = stamp
    changed = bool(fresh) and fresh != KEY
    if changed:
        KEY = fresh
    return changed


def auth(authorization: str = Header("")) -> None:
    if hmac.compare_digest(authorization.encode(), f"Bearer {KEY}".encode()):
        return
    if _reload_key() and hmac.compare_digest(authorization.encode(), f"Bearer {KEY}".encode()):
        return
    raise HTTPException(401, "Clé du lanceur invalide")


def check_id(agent_id: str) -> str:
    if not ID_RE.match(agent_id):
        raise HTTPException(400, "Identifiant d'agent invalide")
    return agent_id


def container(agent_id: str):
    try:
        c = client.containers.get(PREFIX + agent_id)
    except NotFound:
        raise HTTPException(404, "Agent introuvable")
    if c.labels.get(LABEL) != agent_id:
        raise HTTPException(403, "Ce conteneur n'est pas un agent Noah Agent")
    return c


class NewAgent(BaseModel):
    api_key: str
    dossiers: list["Folder"] = []


BROWSER_IMAGE = os.environ.get("BROWSER_IMAGE", "ghcr.io/smfcoder17/noah-browser:stable")
BROWSER_PREFIX = "noah-browser-"
BROWSER_LABEL = "noah.browser"
# Version des réglages du navigateur ; un conteneur plus ancien est recréé (le profil reste dans son volume).
# 19 : aucune capacité, réseau des agents sans le lanceur (E1).
# 20 : SETUID et SETGID pour le bureau (sous le compte 1001), empreinte à la taille de l'écran ; 17 : empreinte tirée une fois par agent, gardée dans /data/empreinte.json ; 15 : sessions enregistrées chaque minute (connexions gardées après un arrêt brutal) ; 14 : remplir une page de connexion ; 12 : image Noah avec bureau, sans uBlock ; 11 : toutes les routes sous clé ; 10 : clé du mode privé à part ; 9 : aucune capture pendant une prise en main ; 8 : jetons hors de la config Docker
BROWSER_VERSION = "20"


FROZEN_WAIT = 30  # secondes ; sous le délai de 120 s du serveur (hermes._launcher)


def _frozen(agent_id: str):
    """Opération sur le parc (créer, supprimer, recréer un agent ou un navigateur) : elle tient le verrou des mises à
    jour pendant toute sa durée. Une transaction qui démarre l'attend ; pendant une transaction, elle est refusée.
    Une autre opération en cours (un navigateur qui s'arrête, un agent qui se crée) : on attend son tour, un temps borné,
    au lieu d'un faux « Noah installe une mise à jour »."""
    if not updater._lock.acquire(timeout=FROZEN_WAIT):
        not_updating(agent_id)  # une vraie mise à jour : son propre message
        raise HTTPException(409, "Une autre opération sur tes agents est en cours : réessaie dans une minute.")
    try:
        not_updating(agent_id)
        yield
    finally:
        updater._lock.release()


class BrowserKeys(BaseModel):
    api_key: str
    vnc_password: str
    private_key: str = ""  # mode privé (G7.7) : connue du serveur seulement, pas de l'agent
    # Langue et fuseau de la connexion de l'utilisateur : un navigateur en UTC/en-US derrière une IP
    # de Montréal est un signal de robot classique (X, Google, banques).
    locale: str = ""
    timezone: str = ""


def _browser_version(locale: str, timezone: str, proxy: bool) -> str:
    """Étiquette des réglages du navigateur. Sans sortie réseau elle reste celle d'avant : aucun navigateur n'est recréé pour rien."""
    return f"{BROWSER_VERSION}:{locale}:{timezone}" + (":s" if proxy else "")


def _version_proxy(label: str) -> bool:
    return (label.split(":") + ["", "", "", ""])[3] == "s"


def _ensure_image(name: str) -> None:
    """containers.create ne télécharge pas l'image (run le fait) : premier navigateur sur un VPS neuf."""
    try:
        client.images.get(name)
    except NotFound:
        client.images.pull(name)


def _prefetch_images() -> None:
    """Sur un VPS neuf, chaque image pèse 4 Go : les prendre tout de suite, pendant que la personne crée son compte. Sinon
    l'écran reste figé quand elle choisit son modèle, et l'agent quand il ouvre son navigateur pour la première fois."""
    for image in (IMAGE, updater.pinned("navigateur", BROWSER_IMAGE)):
        try:
            _ensure_image(image)
        except Exception as e:  # noqa: BLE001 - réseau coupé : le premier usage réessaiera et dira l'erreur
            print(f"[lanceur] image {image} non préchargée : {e}", flush=True)


threading.Thread(target=_prefetch_images, daemon=True).start()


@functools.lru_cache(maxsize=1)
def _cores() -> int | None:
    return client.info().get("NCPU")


def _cpus(wanted: int) -> int:
    """Limite de CPU pour Docker, qui refuse une valeur au-dessus des cœurs de la machine : sur un VPS à 2 cœurs, un
    navigateur limité à 4 ne démarrait jamais."""
    try:
        return min(wanted, _cores() or wanted) * 1_000_000_000
    except Exception:  # noqa: BLE001 - Docker occupé : la limite voulue, il dira s'il la refuse
        return wanted * 1_000_000_000


GO = 2**30
MEM_MAX = 4 * GO
MEM_FLOOR_AGENT = 1 * GO  # Hermes et ses outils
MEM_FLOOR_BROWSER = 2 * GO  # un onglet de la console Google Cloud dépasse à lui seul 1,8 Go
# Journaux des agents et navigateurs : 30 Mo au plus par conteneur. Sans ça, json-file grossit sans fin et remplit le disque.
LOG_CONFIG = {"type": "json-file", "config": {"max-size": "10m", "max-file": "3"}}


@functools.lru_cache(maxsize=1)
def _ram() -> int | None:
    return client.info().get("MemTotal")


def _mem(share: float, floor: int) -> int:
    """Limite de mémoire selon la machine : 4 Go fixes laissaient un agent et son navigateur réclamer 8 Go sur un VPS de 4,
    et le noyau tuait alors au hasard, serveur compris. Jamais sous le plancher, qui garde de quoi tourner."""
    try:
        total = _ram()
    except Exception:  # noqa: BLE001 - Docker occupé : la limite voulue
        total = None
    if not total:
        return MEM_MAX
    return max(floor, min(MEM_MAX, int(total * share)))


@app.exception_handler(docker.errors.APIError)
async def docker_refused(request: Request, error: Exception):
    """Sans ça, le serveur ne reçoit qu'« Internal Server Error » et ne peut rien dire de plus."""
    print(f"[lanceur] Docker a refusé {request.url.path} : {error}", flush=True)
    if "is not running" in str(error):  # la personne lit ce message tel quel : pas d'identifiant de conteneur
        return JSONResponse({"detail": "Ton agent est arrêté pour l'instant. Relance-le avec « Redémarrer », puis réessaie."}, status_code=409)
    return JSONResponse({"detail": f"Docker a refusé : {error}"}, status_code=502)

_browser_lock = threading.Lock()  # deux appels simultanés recréaient le même conteneur (conflit Docker)


@app.get("/agents/{agent_id}/browser", dependencies=[Depends(auth)])
def browser_status(agent_id: str):
    """Lecture seule : distingue un navigateur au repos d'un conteneur qui tourne sans répondre."""
    check_id(agent_id)
    try:
        c = client.containers.get(BROWSER_PREFIX + agent_id)
    except NotFound:
        return {"status": "absent"}
    if c.labels.get(BROWSER_LABEL) != agent_id:
        raise HTTPException(403, "Ce conteneur n'est pas un navigateur Noah Agent")
    return {"status": c.status}


@app.post("/agents/{agent_id}/browser", dependencies=[Depends(auth), Depends(_frozen)])
def ensure_browser(agent_id: str, body: BrowserKeys):
    """Crée (si besoin) le navigateur Camoufox de l'agent, avec son écran partagé en noVNC.

    Le profil (cookies, sessions connectées) vit dans un volume à part, gardé entre les redémarrages.
    """
    with _browser_lock:
        return _ensure_browser(agent_id, body)


def _ensure_browser(agent_id: str, body: BrowserKeys, image: str | None = None, start: bool = True):
    check_id(agent_id)
    container(agent_id)  # l'agent doit exister
    name = BROWSER_PREFIX + agent_id
    proxy = _sortie_ready()  # une sortie réseau est configurée : le navigateur n'a que l'aiguillage pour porte vers Internet
    version = _browser_version(body.locale, body.timezone, proxy)
    try:
        c = client.containers.get(name)
        current = c.labels.get("noah.browser.version", "")
        # Langue et fuseau inconnus (ipinfo.io muet) : on garde l'identité en place plutôt que de recréer en UTC/en-US.
        same = current == version or (not (body.locale and body.timezone)
                                      and current.split(":")[0] == BROWSER_VERSION and _version_proxy(current) == proxy)
        if same:
            if c.status != "running":
                c.start()
            return {"host": name, "created": False}
        c.stop(timeout=20)  # arrêt propre : Camoufox enregistre les cookies de la session (connexions comprises)
        c.remove(force=True)
    except NotFound:
        pass
    image = image or updater.pinned("navigateur", BROWSER_IMAGE)  # version figée par la dernière mise à jour
    _ensure_image(image)
    image_cfg = client.images.get(image).attrs["Config"]
    _ensure_agents_network()
    c = client.containers.create(
        image,
        name=name,
        hostname=name,
        labels={BROWSER_LABEL: agent_id, "noah.browser.version": version},
        # Les jetons sont lus d'un fichier au démarrage, puis la commande de l'image est lancée telle quelle.
        entrypoint=["/bin/sh", "-c", f'set -a; . {SECRETS_FILE}; set +a; exec "$@"', "noah"],
        command=(image_cfg.get("Entrypoint") or []) + (image_cfg.get("Cmd") or []),
        environment={
            "CAMOFOX_PORT": "9377",
            "CAMOFOX_BIND_HOST": "0.0.0.0",
            "CAMOFOX_PROFILE_DIR": "/data/profiles",
            "CAMOFOX_COOKIES_DIR": "/data/cookies",
            "CAMOFOX_CRASH_REPORT_ENABLED": "false",
            # Avec uBlock, sur 2 cœurs, des onglets expiraient à 30 s pendant que l'extension travaillait, avec ou sans bureau.
            "CAMOFOX_DISABLE_DEFAULT_ADDONS": "1",
            "ENABLE_VNC": "1",
            "VNC_RESOLUTION": "1920x1080",  # taille de la fenêtre Camoufox : rien n'est coupé à l'écran
            "VNC_BIND": "0.0.0.0",
            "NOVNC_PORT": "6080",
            "MAX_OLD_SPACE_SIZE": "256",
            # Par défaut, Camoufox ferme une session après 10 min sans appel et s'éteint 5 min plus tard,
            # même quand l'utilisateur a la main sur l'écran. On garde l'onglet 1 h et la session 2 h.
            "TAB_INACTIVITY_MS": "3600000",
            "SESSION_TIMEOUT_MS": "7200000",
            "BROWSER_IDLE_TIMEOUT_MS": "1800000",
            **({"CAMOFOX_LOCALE": body.locale, "CAMOFOX_TIMEZONE": body.timezone, "TZ": body.timezone}
               if body.locale and body.timezone else {}),
            # Camofox lit ces variables (/app/lib/config.js de l'image) ; sans sortie réseau configurée, rien n'est ajouté.
            **({"PROXY_HOST": SORTIE, "PROXY_PORT": str(SORTIE_PORT), "PROXY_PROTOCOL": "http"} if proxy else {}),
        },
        volumes={name: {"bind": "/data", "mode": "rw"}},
        network=NETWORK,
        restart_policy={"Name": "unless-stopped"},
        # Firefox sans carte graphique dessine tout au processeur : avec 2 cœurs, la console Google Cloud mettait 10 à
        # 30 s par clic et l'écran partagé ramait. Un onglet de cette console dépasse à lui seul 1,8 Go.
        # Moitié de la RAM, 4 Go au plus, 2 Go au moins. À court de mémoire, le navigateur part avant le serveur.
        mem_limit=_mem(0.5, MEM_FLOOR_BROWSER),
        oom_score_adj=500,
        log_config=LOG_CONFIG,
        nano_cpus=_cpus(4),
        shm_size="1g",
        security_opt=["no-new-privileges"],
        # E1 : SETUID et SETGID seules, pour passer le bureau au compte 1001 (Camoufox lui-même n'en demande aucune). Sans
        # NET_RAW, un navigateur compromis n'écoute ni n'usurpe rien ; il est sur le réseau des agents, sans le lanceur.
        # PID bornés : un onglet fou n'épuise pas l'hôte (M8).
        cap_drop=["ALL"],
        cap_add=list(BROWSER_CAPS),
        pids_limit=2048,
    )
    # Sans CAMOFOX_ACCESS_KEY, Camofox ne protège que l'import de cookies : les agents sont sur le même réseau, et celui d'un
    # autre profil ouvrait des onglets ici, avec les comptes connectés de cet agent (G12.3).
    updater.put_env(c, SECRETS_FILE, {"CAMOFOX_API_KEY": body.api_key, "CAMOFOX_ACCESS_KEY": body.api_key,
                                      "VNC_PASSWORD": body.vnc_password, "NOAH_PRIVATE_KEY": body.private_key})
    # Avant le démarrage : le plugin Noah et sa déclaration, puis le correctif AutoConfig de Firefox (un onglet ouvert à
    # la main dans l'écran hérite du conteneur de l'agent, donc de ses cookies).
    here = Path(__file__).parent / "camofox-noah"
    c.put_archive("/app", _tar({"plugins/noah/index.js": (here / "index.js").read_bytes(),
                                "camofox.config.json": (here / "camofox.config.json").read_bytes()}))
    stream, _ = c.get_archive(CAMOUFOX_CFG)
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
        cfg = tar.extractfile(tar.getmembers()[0]).read()
    if b"NOAH :" not in cfg:
        cfg += (here / "autoconfig.js").read_bytes()
    c.put_archive(os.path.dirname(CAMOUFOX_CFG), _tar({os.path.basename(CAMOUFOX_CFG): cfg}))
    if start:
        c.start()
    if not proxy:
        _sortie_cleanup()  # une sortie retirée garde son aiguillage tant qu'un navigateur s'y accroche : plus aucun ne le fait
    return {"host": name, "created": True}


CAMOUFOX_CFG = "/root/.cache/camoufox/camoufox.cfg"
# Jetons du navigateur, hors de la config Docker (visible dans `docker inspect` et le Docker Manager de Hostinger).
SECRETS_FILE = "/noah.env"


def _tar(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


@app.post("/agents/{agent_id}/browser/stop", dependencies=[Depends(auth), Depends(_frozen)])
def stop_browser(agent_id: str):
    """Au repos : arrêt propre, Camoufox enregistre ses cookies. Le profil reste dans son volume."""
    check_id(agent_id)
    try:
        c = client.containers.get(BROWSER_PREFIX + agent_id)
    except NotFound:
        return {"ok": True}
    if c.labels.get(BROWSER_LABEL) != agent_id:
        raise HTTPException(403, "Ce conteneur n'est pas un navigateur Noah Agent")
    c.stop(timeout=20)
    return {"ok": True}


FINGERPRINT_FILE = "/data/empreinte.json"  # voir keepFingerprint dans camofox-noah/index.js


@app.post("/agents/{agent_id}/browser/restart", dependencies=[Depends(auth), Depends(_frozen)])
def restart_browser(agent_id: str, new_identity: bool = False):
    """Redémarre le conteneur du navigateur (écran figé, navigateur planté). Profil et cookies restent.

    new_identity : l'empreinte gardée (écran, matériel, polices, WebGL) est oubliée ; Firefox en tire une neuve au démarrage
    et la garde à son tour. Les cookies restent : un site connecté verra une autre machine et peut redemander la connexion."""
    check_id(agent_id)
    try:
        c = client.containers.get(BROWSER_PREFIX + agent_id)
    except NotFound:
        raise HTTPException(404, "Navigateur introuvable")
    if c.labels.get(BROWSER_LABEL) != agent_id:
        raise HTTPException(403, "Ce conteneur n'est pas un navigateur Noah Agent")
    if new_identity:
        if c.status != "running":
            c.start()
        if c.exec_run(["rm", "-f", FINGERPRINT_FILE], user="root").exit_code != 0:
            raise HTTPException(502, "L'empreinte du navigateur n'a pas pu être effacée : réessaie.")
    c.restart(timeout=20)  # comme l'arrêt : le temps d'enregistrer les cookies de la session
    return {"ok": True, "new_identity": new_identity}


# --- Sortie réseau des navigateurs ----------------------------------------------------------------------------------------
# Lot sortie-reseau. Les sites doivent voir le navigateur d'un agent arriver de chez la personne, pas du VPS. Deux conteneurs au plus,
# créés seulement si la personne a choisi une sortie (Réglages > Serveur > Sortie réseau) :
#   noah-sortie-vpn     Gluetun (le fichier WireGuard du fournisseur, ou Surfshark par clé pour qui l'avait déjà) : le seul à demander
#                       NET_ADMIN et /dev/net/tun, parce qu'un VPN ne se fait pas autrement ;
#   noah-sortie         l'aiguillage (launcher/aiguillage.py), seule porte des navigateurs, qui choisit la meilleure sortie.
# La « maison » n'a plus de conteneur : c'est l'ordinateur de la personne, par son app de bureau, que le serveur joint à
# noah-server:3130 (un mandataire HTTP CONNECT du serveur, qui multiplexe sur la connexion de l'app). Avant le relais par l'app de bureau, c'était un
# nœud Tailscale (noah-sortie-maison) : ce conteneur et son volume sont retirés s'ils restent (_sortie_legacy).
# Les sorties vivent sur un réseau à elles (noah-sorties) ; l'aiguillage est sur celui-là et sur celui des agents. Le lanceur
# n'est ni sur l'un ni sur l'autre, et aucun des deux n'a le socket Docker ni de capacité de plus que ci-dessus.
# Le fichier du VPN est posé dans un fichier du conteneur (jamais dans sa config Docker : ni variable, ni étiquette).
SORTIE = "noah-sortie"
SORTIE_MAISON = "noah-sortie-maison"  # l'ancienne maison (Tailscale) : jamais plus créée, retirée si elle reste
SORTIE_VPN = "noah-sortie-vpn"
SORTIE_LABEL = "noah.sortie"  # « aiguillage », « maison » (ancienne) ou « vpn »
SORTIE_PORT = 3128
SORTIES_NETWORK = "noah-sorties"
RELAIS_PORT = int(os.environ.get("NOAH_RELAIS_PORT", "3130"))  # le mandataire du relais, dans le serveur (server/noah/sortie_relais.py)
# Image officielle, figée par empreinte (liste multi-architectures) : on ne change de version qu'ici, après essai.
GLUETUN_IMAGE = os.environ.get("SORTIE_GLUETUN_IMAGE", "qmcgaw/gluetun@sha256:fa19cc76b2af13d57a8d3dc3066f2ada061b1c761b8aecf989b3877c0486e027")
GLUETUN_PROXY = 8888
GLUETUN_CONF = "/gluetun/wireguard/wg0.conf"  # l'endroit où Gluetun cherche le fichier WireGuard du fournisseur « custom »
SORTIE_READY_WAIT = 60  # secondes à attendre que l'aiguillage ait fait sa première série de sondes
CITY_RE = re.compile(r"^[A-Za-z][A-Za-z .'-]{0,39}$")
ADDRESS_RE = re.compile(r"^[0-9a-fA-F:.]{3,45}/\d{1,3}(,[0-9a-fA-F:.]{3,45}/\d{1,3})?$")
KEY_RE = re.compile(r"^[\w.+/=-]{8,512}$")  # clé privée WireGuard de Surfshark (base64)
WG_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")
WG_ENDPOINT_RE = re.compile(r"^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5})$")
_sortie_lock = threading.Lock()


class SortieMaison(BaseModel):
    actif: bool = True  # l'app de bureau de la personne relie son ordinateur : rien d'autre à dire, le serveur sait où il écoute


class SortieVpn(BaseModel):
    fournisseur: str = "surfshark"  # « custom » : le fichier WireGuard du fournisseur de la personne ; « surfshark » : l'ancienne clé
    conf: str = ""  # fournisseur « custom » : le fichier, déjà vérifié par le serveur et revérifié ici
    cle_privee: str = ""  # fournisseur « surfshark » : clé privée WireGuard du compte
    adresse: str = "10.14.0.2/16"
    ville: str = "Montreal"


class SortieConfig(BaseModel):
    maison: SortieMaison | None = None
    vpn: SortieVpn | None = None


def wireguard(texte: str) -> str:
    """Le fichier WireGuard d'un fournisseur, revérifié et réécrit avec les seules lignes dont Gluetun a besoin : jamais PostUp, PreUp,
    Table ni autre ligne qui s'exécute. Même règle que server/noah/sortie.py (qui l'a déjà appliquée) : le lanceur ne fait pas confiance."""
    import ipaddress
    if len(texte) > 8 * 1024:
        raise ValueError("trop long")
    interface: dict = {}
    peers: list[dict] = []
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
                raise ValueError("sections")
            continue
        if section is None or "=" not in ligne:
            raise ValueError("ligne")
        cle, valeur = (x.strip() for x in ligne.split("=", 1))
        cle = cle.lower()
        if cle not in (("privatekey", "address", "dns", "mtu", "listenport") if section is interface else
                       ("publickey", "presharedkey", "allowedips", "endpoint", "persistentkeepalive")):
            raise ValueError("ligne refusée")
        section[cle] = valeur
    if not interface or len(peers) != 1:
        raise ValueError("sections")
    peer = peers[0]
    if not WG_KEY_RE.match(interface.get("privatekey", "")) or not WG_KEY_RE.match(peer.get("publickey", "")):
        raise ValueError("clés")
    if peer.get("presharedkey") and not WG_KEY_RE.match(peer["presharedkey"]):
        raise ValueError("clés")
    try:
        adresses = [str(ipaddress.ip_interface(a.strip())) for a in interface.get("address", "").split(",") if a.strip()]
        plages = [str(ipaddress.ip_network(a.strip(), strict=False)) for a in (peer.get("allowedips") or "0.0.0.0/0, ::/0").split(",") if a.strip()]
    except ValueError:
        raise ValueError("adresses") from None
    point = WG_ENDPOINT_RE.match(peer.get("endpoint", ""))
    if not adresses or not plages or not point or not 0 < int(point.group(2)) < 65536:
        raise ValueError("point d'accès")
    lignes = ["[Interface]", f"PrivateKey = {interface['privatekey']}", f"Address = {', '.join(adresses)}", "",
              "[Peer]", f"PublicKey = {peer['publickey']}"]
    if peer.get("presharedkey"):
        lignes.append(f"PresharedKey = {peer['presharedkey']}")
    return "\n".join(lignes + [f"AllowedIPs = {', '.join(plages)}", f"Endpoint = {peer['endpoint']}", ""])


def _sortie_container(name: str, kind: str):
    """Le conteneur de ce nom s'il est bien une sortie Noah ; None sinon."""
    try:
        c = client.containers.get(name)
    except NotFound:
        return None
    return c if c.labels.get(SORTIE_LABEL) == kind else None


def _sortie_ready() -> bool:
    """Un aiguillage avec au moins une sortie en amont existe : les navigateurs créés maintenant passent par lui. Une panne de
    Docker n'est pas « pas de sortie » : l'erreur remonte, le navigateur n'est pas créé en direct par mégarde."""
    c = _sortie_container(SORTIE, "aiguillage")
    if c is None or not c.labels.get("noah.sortie.amont"):
        return False
    if c.status != "running":
        c.start()
    return True


def _sorties_network() -> None:
    try:
        client.networks.get(SORTIES_NETWORK)
    except NotFound:
        client.networks.create(SORTIES_NETWORK, driver="bridge", labels={"noah.reseau": "sorties"})


def _digest(*parts: str) -> str:
    import hashlib
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()[:16]


def _remove_container(c, volume: str = "") -> None:
    try:
        c.stop(timeout=10)
    except Exception:  # noqa: BLE001 - déjà arrêté
        pass
    c.remove(force=True)
    if volume:
        try:
            client.volumes.get(volume).remove()
        except NotFound:
            pass


def _sortie_common(name: str, kind: str, config_hash: str) -> dict:
    return dict(
        name=name, hostname=name,
        labels={SORTIE_LABEL: kind, "noah.sortie.config": config_hash},
        network=SORTIES_NETWORK,
        restart_policy={"Name": "unless-stopped"},
        mem_limit=_mem(0.15, 256 * 2**20),
        log_config=LOG_CONFIG,
        security_opt=["no-new-privileges"],
        pids_limit=512,
        cap_drop=["ALL"],
    )


def _put_file(c, path: str, text: str, mode: int = 0o600) -> None:
    """Pose un fichier (et ses dossiers) dans le conteneur, lisible par son seul propriétaire."""
    parts = Path(path).parts[1:]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for i in range(1, len(parts)):
            d = tarfile.TarInfo("/".join(parts[:i]))
            d.type, d.mode, d.mtime = tarfile.DIRTYPE, 0o755, int(time.time())
            tar.addfile(d)
        data = text.encode()
        info = tarfile.TarInfo("/".join(parts))
        info.size, info.mode, info.mtime = len(data), mode, int(time.time())
        tar.addfile(info, io.BytesIO(data))
    c.put_archive("/", buf.getvalue())


def _make_vpn(cfg: SortieVpn):
    custom = cfg.fournisseur == "custom"
    h = _digest("vpn-custom", cfg.conf) if custom else _digest("vpn", cfg.cle_privee, cfg.adresse, cfg.ville)
    c = _sortie_container(SORTIE_VPN, "vpn")
    if c is not None and c.labels.get("noah.sortie.config") == h:
        if c.status != "running":
            c.start()
        return c
    if c is not None:
        _remove_container(c)
    _ensure_image(GLUETUN_IMAGE)
    common = _sortie_common(SORTIE_VPN, "vpn", h)
    # Gluetun est le seul conteneur de Noah qui demande une capacité : un VPN crée une interface réseau (NET_ADMIN) et ouvre
    # /dev/net/tun. Rien d'autre : ni NET_RAW, ni privilège, ni accès à l'hôte.
    common["cap_add"] = ["NET_ADMIN"]
    environment = {
        "VPN_TYPE": "wireguard",
        "HTTPPROXY": "on",
        "HTTPPROXY_LISTENING_ADDRESS": f":{GLUETUN_PROXY}",
        "FIREWALL_INPUT_PORTS": str(GLUETUN_PROXY),  # l'aiguillage, voisin sur noah-sorties, joint le mandataire
        "UPDATER_PERIOD": "0",
    }
    if custom:
        environment["VPN_SERVICE_PROVIDER"] = "custom"  # le fournisseur, quel qu'il soit : tout est dans son fichier
    else:
        environment.update(VPN_SERVICE_PROVIDER="surfshark", WIREGUARD_ADDRESSES=cfg.adresse, SERVER_CITIES=cfg.ville)
    c = client.containers.create(
        GLUETUN_IMAGE,
        entrypoint=["/bin/sh", "-c", f'set -a; . {SECRETS_FILE}; set +a; exec /gluetun-entrypoint', "noah"],
        environment=environment,
        devices=["/dev/net/tun:/dev/net/tun:rwm"],
        **common,
    )
    if custom:
        updater.put_env(c, SECRETS_FILE, {})  # le point d'entrée lit ce fichier : vide ici, le fichier du fournisseur est ailleurs
        _put_file(c, GLUETUN_CONF, wireguard(cfg.conf))
    else:
        updater.put_env(c, SECRETS_FILE, {"WIREGUARD_PRIVATE_KEY": cfg.cle_privee})
    c.start()
    return c


def _make_aiguillage(amont: list[dict]):
    h = _digest("aiguillage", json.dumps(amont, sort_keys=True))
    c = _sortie_container(SORTIE, "aiguillage")
    if c is not None and c.labels.get("noah.sortie.config") == h:
        if c.status != "running":
            c.start()
        return c
    if c is not None:
        _remove_container(c)
    image = client.containers.get(updater.LAUNCHER).image  # l'image du lanceur, déjà là : l'aiguillage ne lui doit que Python et son fichier
    _ensure_agents_network()
    labels = {SORTIE_LABEL: "aiguillage", "noah.sortie.config": h, "noah.sortie.amont": ",".join(s["nom"] for s in amont)}
    c = client.containers.create(
        image,
        name=SORTIE, hostname=SORTIE,
        command=["python", "/app/aiguillage.py"],
        user="65534:65534",
        environment={"NOAH_SORTIE_AMONT": json.dumps(amont), "NOAH_SORTIE_PORT": str(SORTIE_PORT)},
        labels=labels,
        network=NETWORK,  # le réseau des agents, sous le nom « noah-sortie » : l'adresse que les navigateurs gardent
        restart_policy={"Name": "unless-stopped"},
        mem_limit=_mem(0.1, 192 * 2**20),
        log_config=LOG_CONFIG,
        security_opt=["no-new-privileges"],
        pids_limit=256,
        cap_drop=["ALL"],
        read_only=True,
        tmpfs={"/tmp": "size=8m"},
        healthcheck={"test": ["CMD", "python", "/app/aiguillage.py", "--etat"], "interval": 30 * 10**9, "timeout": 5 * 10**9, "retries": 3},
    )
    try:
        client.networks.get(SORTIES_NETWORK).connect(c)  # les sorties en amont, que les navigateurs ne voient pas
    except Exception:
        c.remove(force=True)
        raise
    c.start()
    return c


def _sortie_state() -> dict | None:
    """Ce que l'aiguillage dit de lui-même (lu dans son conteneur : aucun port ne mène à cet état), ou None."""
    c = _sortie_container(SORTIE, "aiguillage")
    if c is None or c.status != "running":
        return None
    try:
        out = c.exec_run(["python", "/app/aiguillage.py", "--etat"], user="65534")
        return json.loads(out.output.decode()) if out.exit_code == 0 else None
    except Exception:  # noqa: BLE001 - il démarre encore
        return None


def _sortie_wait() -> dict | None:
    for _ in range(SORTIE_READY_WAIT):
        state = _sortie_state()
        if state is not None:
            return state
        time.sleep(1)
    return None


def _check_sortie(cfg: SortieConfig) -> None:
    if not cfg.vpn:
        return
    if cfg.vpn.fournisseur == "custom":
        try:
            wireguard(cfg.vpn.conf)
        except ValueError:
            raise HTTPException(400, "Configuration WireGuard invalide.") from None
    elif cfg.vpn.fournisseur == "surfshark":
        if not (KEY_RE.match(cfg.vpn.cle_privee) and ADDRESS_RE.match(cfg.vpn.adresse) and CITY_RE.match(cfg.vpn.ville)):
            raise HTTPException(400, "Clé WireGuard, adresse ou ville invalide.")
    else:
        raise HTTPException(400, "Fournisseur de VPN inconnu.")


def _retirer_ancienne_maison() -> None:
    """Le nœud Tailscale d'avant le relais par l'app de bureau : son conteneur, et son état (qui garde la clé de la personne chez Tailscale)."""
    c = _sortie_container(SORTIE_MAISON, "maison")
    if c is not None:
        _remove_container(c, SORTIE_MAISON)
    else:
        try:
            client.volumes.get(SORTIE_MAISON).remove()
        except NotFound:
            pass
        except Exception:  # noqa: BLE001 - un volume encore tenu : au prochain passage
            pass


def _apply_sortie(cfg: SortieConfig) -> dict:
    _check_sortie(cfg)
    _sorties_network()
    _retirer_ancienne_maison()
    amont: list[dict] = []
    if cfg.maison and cfg.maison.actif:
        amont.append({"nom": "maison", "hote": SERVER_NAME, "port": RELAIS_PORT})  # le mandataire du relais, dans le serveur
    if cfg.vpn:
        _make_vpn(cfg.vpn)
        amont.append({"nom": "vpn", "hote": SORTIE_VPN, "port": GLUETUN_PROXY})
    elif (c := _sortie_container(SORTIE_VPN, "vpn")) is not None:
        _remove_container(c)
    if amont:
        _make_aiguillage(amont)
    else:
        _sortie_cleanup(emptied=True)
    return _sortie_report(wait=bool(amont))


def _sortie_legacy() -> None:
    """Au démarrage du lanceur : plus rien de l'ancienne maison. Son conteneur part, et un aiguillage qui la comptait encore parmi
    ses amonts est refait sans elle (ou part, s'il ne lui reste rien) : le serveur n'a pas à repasser pour que cela soit propre."""
    with _sortie_lock:
        _retirer_ancienne_maison()
        c = _sortie_container(SORTIE, "aiguillage")
        if c is None:
            return
        try:
            env = dict(e.split("=", 1) for e in c.attrs["Config"]["Env"] if "=" in e)
            amont = json.loads(env.get("NOAH_SORTIE_AMONT", "[]"))
        except (KeyError, TypeError, ValueError):
            return
        gardes = [s for s in amont if s.get("hote") != SORTIE_MAISON]
        if len(gardes) == len(amont):
            return
        if gardes:
            _make_aiguillage(gardes)
        else:
            _sortie_cleanup(emptied=True)


@app.on_event("startup")
def sortie_legacy() -> None:
    def run() -> None:
        try:
            _sortie_legacy()
        except Exception as e:  # noqa: BLE001 - Docker pas prêt : le serveur redira la configuration, qui fait le même ménage
            print(f"[lanceur] ancienne sortie maison : {type(e).__name__}", flush=True)
    threading.Thread(target=run, daemon=True).start()


def _agent_proxy_env(agent_id: str) -> dict[str, str]:
    """Les outils de l'agent (terminal, curl, web, recherche) sortent par l'aiguillage, comme son navigateur : sans cela, un
    site voit l'adresse du serveur même quand la personne a choisi la sortie de chez elle. Hermes lit HTTP(S)_PROXY et NO_PROXY
    (majuscules et minuscules) et les transmet à ses outils. Restent directs : ce serveur, par où passent tous les appels de
    modèle et de fournisseur (RELAY_URL : l'agent n'a aucune clé et ne parle à aucun fournisseur), le navigateur de l'agent,
    l'aiguillage, le réseau Docker et le réseau local (l'aiguillage les refuserait de toute façon)."""
    return aiguillage.env_proxy_agent(SORTIE, SORTIE_PORT, [SERVER_NAME, BROWSER_PREFIX + agent_id])


def _agent_on_proxy(c) -> bool:
    env = dict(e.split("=", 1) for e in (c.attrs.get("Config", {}).get("Env") or []) if "=" in e)
    return env.get("HTTPS_PROXY") == f"http://{SORTIE}:{SORTIE_PORT}"


def _agents_on_proxy() -> bool:
    return any(_agent_on_proxy(a) for a in client.containers.list(all=True, filters={"label": LABEL}))


def _browsers_on_proxy() -> bool:
    """Un navigateur ou un agent créé avec le proxy s'y accroche : l'aiguillage ne part pas, il reste vidé (direct seulement)."""
    return _agents_on_proxy() or any(_version_proxy(b.labels.get("noah.browser.version", ""))
                                     for b in client.containers.list(all=True, filters={"label": BROWSER_LABEL}))


def _sortie_cleanup(emptied: bool = False) -> None:
    """Plus aucune sortie. L'aiguillage reste, vidé (il ne sort plus qu'en direct), tant qu'un navigateur créé avec lui s'y
    accroche, puis il part : sans cela, ces navigateurs perdraient Internet jusqu'à leur prochaine recréation.
    `emptied` : la configuration vient d'être vidée. Sinon (un navigateur vient d'être recréé), seul un aiguillage déjà vide part."""
    c = _sortie_container(SORTIE, "aiguillage")
    if c is None or (not emptied and c.labels.get("noah.sortie.amont")):
        return
    if _browsers_on_proxy():
        if emptied and c.labels.get("noah.sortie.amont"):
            _make_aiguillage([])
        return
    _remove_container(c)


def _agents_vers_aiguillage() -> None:
    """Une sortie vient d'être choisie : les agents d'avant n'ont pas le proxy dans leur environnement, que Docker ne change pas
    sur un conteneur qui existe. Chacun est recréé une fois (même image, même volume, même jeton), comme pour l'isolement ; ensuite
    le choix de la sortie (maison, VPN, serveur) se fait dans l'aiguillage, sans rien redémarrer."""
    with updater._lock:
        try:
            if updater.load_state().get("en_cours") or not _sortie_ready():
                return  # une mise à jour recrée déjà le parc ; sortie retirée entre-temps
        except updater.Corrupt:
            return
        for c in client.containers.list(all=True, filters={"label": LABEL}):
            if not c.name.endswith("-ancien") and not _agent_on_proxy(c):
                _recreate_isolated(c, "sur l'aiguillage de sortie", _agent_proxy_env(c.labels.get(LABEL) or c.name[len(PREFIX):]))


def _sortie_report(wait: bool = False) -> dict:
    present = {n: _sortie_container(n, k) is not None for n, k in ((SORTIE_MAISON, "maison"), (SORTIE_VPN, "vpn"), (SORTIE, "aiguillage"))}
    return {"conteneurs": present, "aiguillage": (_sortie_wait() if wait else _sortie_state())}


def _frozen_fleet():
    """Une opération sur le parc qui ne vise aucun agent en particulier : même verrou que les autres."""
    yield from _frozen("")


@app.get("/sortie", dependencies=[Depends(auth)])
def sortie_status():
    """Lecture seule : quels conteneurs existent et ce que dit l'aiguillage (jamais une clé)."""
    return _sortie_report()


@app.put("/sortie", dependencies=[Depends(auth), Depends(_frozen_fleet)])
def sortie_apply(body: SortieConfig):
    """Pose la configuration complète des sorties : crée, remplace ou retire ce qui a changé, laisse en place ce qui n'a pas changé.
    Les clés viennent du serveur (qui les garde scellées) et ne sont jamais renvoyées."""
    with _sortie_lock:
        out = _apply_sortie(body)
    if body.maison or body.vpn:
        threading.Thread(target=_agents_vers_aiguillage, daemon=True).start()  # après la réponse : le verrou du parc se libère avec elle
    return out


# --- Fichiers de l'espace de travail ----------------------------------------------

WORKSPACE = "/opt/data/workspace"
FILE_MAX = 100 * 1024 * 1024


def _workspace_path(path: str) -> str:
    path = "/" + path.strip("/")
    full = WORKSPACE + path if not path.startswith(WORKSPACE) else path
    if ".." in full.split("/") or not full.startswith(WORKSPACE + "/"):
        raise HTTPException(400, "Chemin hors de l'espace de travail")
    return full


@app.get("/agents/{agent_id}/files", dependencies=[Depends(auth)])
def list_files(agent_id: str):
    c = container(check_id(agent_id))
    res = c.exec_run(
        ["find", WORKSPACE, "-maxdepth", "6", "-type", "f", "-not", "-path", "*/node_modules/*",
         "-not", "-path", "*/.git/*", "-printf", "%P\t%s\t%T@\n"],
        user="root",
    )
    files = []
    for line in res.output.decode(errors="replace").splitlines()[:1000]:
        parts = line.split("\t")
        if len(parts) == 3:
            files.append({"path": parts[0], "size": int(parts[1]), "modified": float(parts[2])})
    files.sort(key=lambda f: -f["modified"])
    return files


# Lit un fichier depuis l'agent en ouvrant chaque dossier sans suivre de lien : un lien posé dans l'espace de travail ne mène
# jamais à ses secrets. Exécuté dans le conteneur, parce que seul lui sait ce que sont ces chemins au moment de l'ouverture.
READ_NO_LINK = r"""
import os, stat, sys
root, rel, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
parts = [p for p in rel.split("/") if p]
try:
    fd = os.open(root.rstrip("/"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    for part in parts[:-1]:
        fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
except FileNotFoundError:
    sys.exit(44)
except OSError:
    sys.exit(45)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode):
    sys.exit(45)
if info.st_size > limit:
    sys.exit(46)
with os.fdopen(fd, "rb") as f:
    sys.stdout.buffer.write(f.read())
"""


# Supprime sans suivre de lien, pour la même raison : un dossier remplacé par un lien ne mène jamais hors de l'espace de travail.
# Le lien lui-même, en fin de chemin, se supprime comme un fichier ; ce qu'il désigne reste. Les dossiers vidés partent aussi, sauf
# ceux de premier niveau (outputs, uploads…), que l'agent et les envois s'attendent à trouver.
DELETE_NO_LINK = r"""
import json, os, stat, sys
root, done, failed = sys.argv[1].rstrip("/"), [], []
for rel in json.loads(sys.argv[2]):
    parts = [p for p in rel.split("/") if p]
    chain = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for part in parts[:-1]:
            chain.append((fd, part))
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        if stat.S_ISDIR(os.stat(parts[-1], dir_fd=fd, follow_symlinks=False).st_mode):
            raise IsADirectoryError(rel)
        os.unlink(parts[-1], dir_fd=fd)
        done.append(rel)
        for parent, name in reversed(chain[1:]):
            os.rmdir(name, dir_fd=parent)
    except FileNotFoundError:
        done.append(rel) if rel not in done else None
    except OSError:
        failed.append(rel) if rel not in done else None
print(json.dumps({"supprimes": done, "refuses": failed}))
"""


def _workspace_paths(paths: list[str]) -> list[str]:
    """Des chemins relatifs, dans l'espace de travail, sans détour : le reste refuse toute la demande."""
    if len(paths) > DELETE_MOST:
        raise HTTPException(400, "Trop de fichiers d'un coup")
    for rel in paths:
        parts = rel.split("/")
        if not rel or len(rel) > 1024 or rel.startswith("/") or "\x00" in rel or any(p in ("", ".", "..") for p in parts):
            raise HTTPException(400, "Chemin refusé")
    return paths


class FilesToDelete(BaseModel):
    chemins: list[str]


DELETE_MOST = 1000
DELETE_ARG_BYTES = 100_000  # un argument de commande ne dépasse pas 128 Kio sous Linux


def _delete_batches(paths: list[str]):
    """Des lots dont le JSON tient dans un argument. Un accent compte six octets une fois échappé : compter les chemins ne suffit pas."""
    batch: list[str] = []
    size = 2
    for rel in paths:
        cost = len(json.dumps(rel)) + 2
        if batch and size + cost > DELETE_ARG_BYTES:
            yield batch
            batch, size = [], 2
        batch.append(rel)
        size += cost
    if batch:
        yield batch


@app.post("/agents/{agent_id}/files/supprimer", dependencies=[Depends(auth), Depends(_frozen)])
def delete_files(agent_id: str, body: FilesToDelete):
    c = container(check_id(agent_id))
    paths, out = _workspace_paths(body.chemins), {"supprimes": [], "refuses": []}
    for batch in _delete_batches(paths):
        res = c.exec_run(["python3", "-c", DELETE_NO_LINK, WORKSPACE, json.dumps(batch)], user="root", stdout=True, stderr=False)
        if res.exit_code != 0:
            raise HTTPException(500, "Suppression impossible")
        part = json.loads(res.output)
        out["supprimes"] += part["supprimes"]
        out["refuses"] += part["refuses"]
    return out


def _read_no_link(c, root: str, rel: str, limit: int) -> bytes:
    res = c.exec_run(["python3", "-c", READ_NO_LINK, root, rel, str(limit)], user="root", stdout=True, stderr=False)
    if res.exit_code == 44:
        raise HTTPException(404, "Fichier introuvable")
    if res.exit_code == 46:
        raise HTTPException(413, "Fichier trop lourd")
    if res.exit_code != 0:
        raise HTTPException(400, "Ce n'est pas un fichier")
    return res.output


@app.get("/agents/{agent_id}/file", dependencies=[Depends(auth)])
def read_workspace_file(agent_id: str, path: str):
    full = _workspace_path(path)
    data = _read_no_link(container(check_id(agent_id)), WORKSPACE, full.removeprefix(WORKSPACE + "/"), FILE_MAX)
    return Response(data, media_type="application/octet-stream")


@app.put("/agents/{agent_id}/upload", dependencies=[Depends(auth)])
async def upload(agent_id: str, name: str, request: Request, folder: str = "uploads"):
    """Dépose un fichier dans workspace/uploads/ (envoyé par l'utilisateur) ou workspace/outputs/ (média créé pour l'agent)."""
    if folder not in ("uploads", "outputs"):
        raise HTTPException(400, "Dossier non autorisé")
    c = container(check_id(agent_id))
    safe = re.sub(r"[^\w.\- ()]+", "_", os.path.basename(name)).strip() or "fichier"
    data = await request.body()
    if len(data) > FILE_MAX:
        raise HTTPException(413, "Fichier trop lourd (100 Mo max)")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(f"{folder}/{safe}")
        info.size = len(data)
        info.mode = 0o644
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(data))
    c.exec_run(["mkdir", "-p", f"{WORKSPACE}/{folder}"], user="root")
    c.put_archive(WORKSPACE, buf.getvalue())
    # L'agent tourne sous son propre utilisateur : on lui rend la propriété du dossier.
    c.exec_run(["sh", "-c", f"chown -R --reference={WORKSPACE} {WORKSPACE}/{folder}"], user="root")
    return {"path": f"{WORKSPACE}/{folder}/{safe}"}


@app.get("/agents", dependencies=[Depends(auth)])
def list_agents():
    return [
        {"id": c.labels[LABEL], "status": c.status}
        for c in client.containers.list(all=True, filters={"label": LABEL})
    ]


# --- Dossiers de l'ordinateur partagés avec l'agent -------------------------------------------
# Seule exception au « aucun montage de l'hôte » : des dossiers choisis par l'utilisateur, et seulement sous les
# racines que le propriétaire de la machine a autorisées dans NOAH_SHARE_ROOTS (séparées par « ; »). Sans racine,
# le partage est coupé : un serveur compromis ne peut pas demander à monter le disque entier.
SHARE_ROOTS = [r.strip() for r in os.environ.get("NOAH_SHARE_ROOTS", "").split(";") if r.strip()]
FOLDER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
# Jamais partagés, même sous une racine autorisée : clés, identifiants, données des applications, et ce que l'ordinateur
# exécute de lui-même à l'ouverture d'une session.
SENSITIVE = re.compile(r"(^|/)(\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.config|\.local|appdata|library/keychains|library/launchagents|"
                       r"\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zprofile|\.zshenv|\.gitconfig|\.netrc|\.npmrc|\.pypirc)(/|$)", re.I)


class Folder(BaseModel):
    nom: str
    chemin: str
    ecriture: bool = False


NewAgent.model_rebuild()


def _norm(path: str) -> str:
    return path.strip().replace("\\", "/").rstrip("/")


def _same_or_under(path: str, root: str) -> tuple[bool, bool]:
    """(identique à la racine, sous la racine). C:\\… : chemins insensibles à la casse."""
    p, r = _norm(path), _norm(root)
    a, b = (p.lower(), r.lower()) if re.match(r"^[A-Za-z]:", r) else (p, r)
    return a == b, a.startswith(b + "/")


# Jamais partageables, même sous une racine large (« / ») : le socket Docker et les dossiers du système donneraient
# l'hôte à l'agent (audit 0.3.0, DeepSeek M2).
SYSTEM_DIRS = ("var/run", "run", "proc", "sys", "dev", "etc", "boot", "root", "var/lib/docker", "var/lib/containerd", "usr", "bin",
               "sbin", "lib", "lib64")
SYSTEM = re.compile(r"^/(" + "|".join(re.escape(d) for d in SYSTEM_DIRS) + r")(/|$)|docker.sock", re.I)


def _holds_system(p: str) -> bool:
    """`/`, `/var`, `/var/lib`… : un dossier qui contient un dossier du système. Le monter monterait aussi ce qu'il contient
    (relecture 0.3.0, partie 3 n°1 : `/var` exposait `/var/run/docker.sock`)."""
    low = p.lower()
    return low == "" or any(("/" + d).startswith(low + "/") for d in SYSTEM_DIRS)


def _shareable(path: str) -> bool:
    """Limite connue : le lanceur ne voit pas le disque de l'hôte, il ne lit donc pas les liens symboliques. Un lien posé sous une
    racine autorisée et qui mène vers /etc passerait ces tests (docs/epics/0.3.0/securite-audit.md, « Limites »)."""
    p = re.sub(r"/+", "/", _norm(path))
    parts = p.split("/")
    if not p or ".." in parts or "." in parts or SENSITIVE.search(p) or SYSTEM.search(p) or (p.startswith("/") and _holds_system(p)):
        return False
    return any(any(_same_or_under(p, root)) for root in SHARE_ROOTS)


def _is_root(path: str) -> bool:
    return any(_same_or_under(path, root)[0] for root in SHARE_ROOTS)


def _check_folders(folders: list[Folder]) -> list[Folder]:
    if len(folders) > 20:
        raise HTTPException(400, "20 dossiers au plus")
    if len({f.nom for f in folders}) != len(folders):
        raise HTTPException(400, "Deux dossiers portent le même nom")
    for f in folders:
        if not FOLDER_NAME_RE.match(f.nom):
            raise HTTPException(400, f"Nom de dossier invalide : {f.nom}")
        if not _shareable(f.chemin):
            raise HTTPException(403, f"Dossier non autorisé : {f.chemin}")
        if f.ecriture and _is_root(f.chemin):  # le dossier personnel en écriture : l'agent y poserait de quoi s'exécuter hors de sa machine
            raise HTTPException(403, f"Écriture refusée sur tout {f.chemin} : choisis un sous-dossier, ou partage-le en lecture.")
    return folders


@app.get("/folders/roots", dependencies=[Depends(auth)])
def folder_roots():
    return {"racines": SHARE_ROOTS}


@app.post("/agents/{agent_id}", dependencies=[Depends(auth), Depends(_frozen)])
def create(agent_id: str, body: NewAgent):
    check_id(agent_id)
    try:
        client.containers.get(PREFIX + agent_id)
        raise HTTPException(409, "Cet agent existe déjà")
    except NotFound:
        pass
    return _run_agent(agent_id, body.api_key, _check_folders(body.dossiers))


class AgentFolders(BaseModel):
    dossiers: list[Folder]


@app.put("/agents/{agent_id}/folders", dependencies=[Depends(auth), Depends(_frozen)])
def set_folders(agent_id: str, body: AgentFolders):
    """Change les dossiers partagés : la machine de l'agent est recréée (son volume garde tout le reste)."""
    folders = _check_folders(body.dossiers)
    c = container(check_id(agent_id))
    key = _agent_key(c)
    rights = c.exec_run(["cat", "/etc/noah/mcp-droits.json"], user="root")
    # Recréer avant de retirer : un montage refusé (dossier disparu, chemin interdit) laissait la personne sans agent.
    was_running = c.status == "running"
    name = PREFIX + agent_id
    if _exists_container(name + "-ancien"):  # vérifié avant l'arrêt : sinon le renommage échoue et l'agent reste arrêté
        raise HTTPException(409, "Une opération précédente sur cet agent n'est pas terminée (conteneur « -ancien » encore "
                                 "présent) : rien n'est modifié.")
    c.stop(timeout=10)  # arrêt propre : Hermes finit d'écrire, puis le volume est libre pour le nouveau
    try:
        c.rename(name + "-ancien")
    except Exception:
        if was_running:
            c.start()
        raise
    try:
        out = _run_agent(agent_id, key, folders)
    except Exception:
        c.rename(name)  # l'agent d'avant revient tel quel
        if was_running:
            c.start()
        raise
    c.remove(force=True)
    if rights.exit_code == 0:
        _seal_rights(container(agent_id), json.loads(rights.output))
    threading.Thread(target=_restore_packages, daemon=True).start()
    return out


def _agent_key(c) -> str:
    """Jeton de l'API de l'agent : dans son .env (Hermes le charge), ou dans sa config pour un conteneur d'avant."""
    env = dict(e.split("=", 1) for e in c.attrs["Config"]["Env"] if "=" in e)
    return updater.env_values((updater.read_text(c, f"{DATA}/.env") or ("",))[0]).get("API_SERVER_KEY") or env["API_SERVER_KEY"]


HERMES_UID = 10000  # utilisateur hermes de l'image : propriétaire du .env d'un volume neuf


def _run_agent(agent_id: str, api_key: str, folders: list[Folder]):
    volumes = {PREFIX + agent_id: {"bind": DATA, "mode": "rw"}}
    for f in folders:
        volumes[f.chemin] = {"bind": f"{DATA}/dossiers/{f.nom}", "mode": "rw" if f.ecriture else "ro"}
    image = updater.pinned("hermes", IMAGE)
    _ensure_image(image)
    _ensure_agents_network()
    proxy = _sortie_ready()  # une sortie réseau est configurée : les outils web de l'agent sortent par l'aiguillage, comme son navigateur
    c = client.containers.create(
        image,
        command="gateway run",
        name=PREFIX + agent_id,
        hostname=PREFIX + agent_id,
        labels={LABEL: agent_id},
        environment={
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "0.0.0.0",
            **(_agent_proxy_env(agent_id) if proxy else {}),
        },
        volumes=volumes,
        network=NETWORK,
        restart_policy={"Name": "unless-stopped"},
        mem_limit=_mem(0.4, MEM_FLOOR_AGENT),  # 40 % de la RAM, 4 Go au plus, 1 Go au moins
        log_config=LOG_CONFIG,
        nano_cpus=_cpus(2),
        security_opt=["no-new-privileges"],
        cap_drop=["ALL"],  # E1 : puis seulement les capacités prouvées (AGENT_CAPS)
        cap_add=list(AGENT_CAPS),
        pids_limit=2048,  # une boucle de processus de l'agent n'épuise pas l'hôte (audit 0.3.0, M8)
    )
    # Jeton de l'API dans le .env du volume, avant le premier démarrage : l'API n'est jamais ouverte sans lui.
    try:
        updater.put_env(c, f"{DATA}/.env", {"API_SERVER_KEY": api_key}, HERMES_UID, HERMES_UID)
        c.start()
    except Exception:
        c.remove(force=True)  # sinon « Cet agent existe déjà » au prochain essai, pour un conteneur jamais démarré
        raise
    return {"id": agent_id, "host": PREFIX + agent_id}


# Fichiers que le serveur peut écrire dans /opt/data : config d'Hermes, rôle, l'outil `noah.py` de l'agent,
# la liste des dossiers partagés (pour que l'agent sache ce qu'ils sont) et les applications que Noah ajoute au catalogue
# d'Hermes (lues par agent_admin.py). Tout fichier envoyé par hermes.configure doit être ici (test fil_fichiers_test.py).
CONFIG_FILES = (".env", "config.yaml", "SOUL.md", "noah.py", "dossiers.json", "applications_extra.py",
                "plugins/noah-garde/plugin.yaml", "plugins/noah-garde/__init__.py")  # garde de Noah (G7.6)


class Files(BaseModel):
    # chemin relatif dans /opt/data -> contenu texte
    files: dict[str, str]


@app.get("/agents/{agent_id}/files/{name}", dependencies=[Depends(auth)])
def read_file(agent_id: str, name: str):
    check_id(agent_id)
    if name not in CONFIG_FILES:
        raise HTTPException(400, "Fichier non autorisé")
    try:
        stream, _ = container(agent_id).get_archive(f"{DATA}/{name}")
    except NotFound:
        return {"content": ""}
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
        member = tar.getmembers()[0]
        return {"content": tar.extractfile(member).read().decode()}


@app.put("/agents/{agent_id}/files", dependencies=[Depends(auth)])
def write_files(agent_id: str, body: Files):
    check_id(agent_id)
    for name in body.files:
        if name not in CONFIG_FILES:
            raise HTTPException(400, f"Fichier non autorisé : {name}")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, content in body.files.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755 if name.endswith(".py") else 0o644
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))
    container(agent_id).put_archive(DATA, buf.getvalue())
    return {"ok": True}


MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MEDIA_ROOTS = ("/opt/data/workspace/", "/opt/data/home/", "/opt/data/browser_screenshots/", "/opt/data/cache/", "/tmp/")
MEDIA_MAX = 10 * 1024 * 1024


@app.get("/agents/{agent_id}/media", dependencies=[Depends(auth)])
def media(agent_id: str, path: str):
    """Rend une image produite par l'agent (capture, graphique). Images seulement, dossiers de travail seulement."""
    check_id(agent_id)
    ext = os.path.splitext(path)[1].lower()
    if ".." in path or ext not in MEDIA_TYPES or not path.startswith(MEDIA_ROOTS):
        raise HTTPException(400, "Fichier non autorisé")
    base = next(r for r in MEDIA_ROOTS if path.startswith(r))
    data = _read_no_link(container(agent_id), base, path.removeprefix(base), MEDIA_MAX)
    return Response(data, media_type=MEDIA_TYPES[ext], headers={"Cache-Control": "private, max-age=86400"})


# Hermes fige le prompt système d'une session à son premier message. Pour qu'un nouveau rôle ou de
# nouvelles consignes s'appliquent aux conversations en cours, on efface ce prompt enregistré :
# Hermes le reconstruit au tour suivant, une seule fois.
FORGET_PROMPTS = """
import sqlite3
c = sqlite3.connect('/opt/data/state.db', timeout=30)
n = c.execute("UPDATE sessions SET system_prompt = NULL, system_prompt_hash = NULL WHERE id LIKE 'noah-%'").rowcount
c.commit()
print(n)
"""


@app.post("/agents/{agent_id}/refresh-prompts", dependencies=[Depends(auth)])
def refresh_prompts(agent_id: str):
    c = container(check_id(agent_id))
    owner = c.exec_run(["stat", "-c", "%u:%g", f"{DATA}/state.db"], user="root")
    if owner.exit_code != 0:
        return {"sessions": 0}  # aucune session encore
    res = c.exec_run(["python3", "-c", FORGET_PROMPTS], user=owner.output.decode().strip())
    if res.exit_code != 0:
        raise HTTPException(500, res.output.decode(errors="replace")[-300:])
    return {"sessions": int(res.output.decode().strip() or 0)}


# --- Administration de la machine de l'agent (disque, mémoire, routines, Google) ---------------

ADMIN = (Path(__file__).parent / "agent_admin.py").read_text(encoding="utf-8")
HERMES_PYTHON = "/opt/hermes/.venv/bin/python"


def _owner(c) -> str:
    """uid:gid du propriétaire de /opt/data (l'utilisateur hermes) : les fichiers écrits restent les siens."""
    res = c.exec_run(["stat", "-c", "%u:%g", DATA], user="root")
    return res.output.decode().strip() if res.exit_code == 0 else "10000:10000"


@app.post("/agents/{agent_id}/sessions/{session}/discard", dependencies=[Depends(auth)])
def discard_lost_turn(agent_id: str, session: str, profil: str = ""):
    """Un redémarrage pendant un tour bloque la session jusqu'à ce qu'on prenne acte du tour perdu (il n'est pas rejoué)."""
    if not re.fullmatch(r"noah-[\w-]{1,80}", session) or (profil and not re.fullmatch(r"u\d+[0-9a-f]{8}", profil)):
        raise HTTPException(400, "Session invalide")
    c = container(check_id(agent_id))
    home = f"{DATA}/profiles/{profil}" if profil else DATA
    res = c.exec_run([HERMES_PYTHON, "-m", "hermes_cli.main", "sessions", "discard", session, "--yes"], user=_owner(c),
                     environment={"HOME": DATA, "HERMES_HOME": home}, workdir=DATA)
    if res.exit_code != 0:
        raise HTTPException(502, res.output.decode(errors="replace")[-300:])
    return {"ok": True}


@app.post("/agents/{agent_id}/admin/{action}", dependencies=[Depends(auth)])
def admin(agent_id: str, action: str, body: dict = Body(default_factory=dict)):
    if not re.fullmatch(r"[a-z_]{2,30}", action):
        raise HTTPException(400, "Action invalide")
    c = container(check_id(agent_id))
    res = c.exec_run([HERMES_PYTHON, "-c", ADMIN, action, json.dumps(body)], user=_owner(c),
                     environment={"HOME": DATA, "HERMES_HOME": DATA}, workdir=DATA)
    text = res.output.decode(errors="replace").strip().splitlines()
    try:
        out = json.loads(text[-1]) if text else {}
    except json.JSONDecodeError:
        raise HTTPException(500, " / ".join(text)[-500:])
    if res.exit_code != 0:
        raise HTTPException(400, out.get("erreur") or "Échec")
    if "droits" in body:
        _seal_rights(c, body["droits"])
    return out


TOOL_RIGHTS = ("lire", "agir", "confirmer")
MODE_RIGHT = "@mode"  # l'autonomie de l'agent, lue par le garde : « agir » ne demande jamais
AUTONOMY = ("agir", "auto", "prudent")


def _seal_rights(c, rights: dict) -> None:
    """Les droits des outils, lus par le plugin de garde à chaque appel. Ils vivent hors du volume, écrits par root : l'agent
    peut lire son droit, pas se le donner, ni renommer un dossier parent qui lui appartient. Perdus si le conteneur est
    recréé : le serveur les réécrit à la configuration, et un droit absent vaut « confirmer ».

    `@mode` porte l'autonomie choisie (agir, auto, prudent) : le garde l'applique sans appel réseau, donc une action ne
    peut pas attendre un accord qui n'arrivera jamais quand la personne a réglé « Agir »."""
    clean_rights = {str(k): v for k, v in (rights or {}).items()
                    if v in TOOL_RIGHTS or (str(k) == MODE_RIGHT and v in AUTONOMY)}
    clean = json.dumps(clean_rights, ensure_ascii=False)
    res = c.exec_run(["sh", "-c", 'mkdir -p /etc/noah && printf %s "$1" > /etc/noah/mcp-droits.tmp && '
                      "chmod 644 /etc/noah/mcp-droits.tmp && mv -f /etc/noah/mcp-droits.tmp /etc/noah/mcp-droits.json", "droits", clean], user="root")
    if res.exit_code != 0:
        raise HTTPException(500, "Droits des outils non écrits")


# Paquets Debian que l'agent peut installer : noms simples seulement (pas d'option ni de chemin).
PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,62}$")
PACKAGES_FILE = f"{DATA}/.noah/packages.txt"


class Packages(BaseModel):
    paquets: list[str]


def _apt(c, packages: list[str]) -> tuple[bool, str]:
    script = ("export DEBIAN_FRONTEND=noninteractive; "
              "( [ -n \"$(ls -A /var/lib/apt/lists 2>/dev/null | grep -v lock)\" ] || apt-get update -qq ) && "
              "apt-get install -y -qq --no-install-recommends \"$@\" || "
              "( apt-get update -qq && apt-get install -y -qq --no-install-recommends \"$@\" )")
    res = c.exec_run(["sh", "-c", script, "apt", *packages], user="root")
    return res.exit_code == 0, res.output.decode(errors="replace")[-1500:]


@app.post("/agents/{agent_id}/install", dependencies=[Depends(auth)])
def install(agent_id: str, body: Packages):
    pkgs = [p.strip().lower() for p in body.paquets if p.strip()]
    if not pkgs or len(pkgs) > 10 or not all(PACKAGE_RE.match(p) for p in pkgs):
        raise HTTPException(400, "Noms de paquets invalides")
    c = container(check_id(agent_id))
    ok, log = _apt(c, pkgs)
    if not ok:
        raise HTTPException(400, log)
    # Gardés dans le volume : réinstallés si la machine de l'agent est recréée (nouvelle image).
    owner = _owner(c)
    c.exec_run(["sh", "-c", f"mkdir -p {DATA}/.noah && touch {PACKAGES_FILE} && "
                f"for p in \"$@\"; do grep -qx \"$p\" {PACKAGES_FILE} || echo \"$p\" >> {PACKAGES_FILE}; done && "
                f"chown -R {owner} {DATA}/.noah", "rec", *pkgs], user="root")
    return {"ok": True, "paquets": pkgs, "journal": log.replace("\r", "\n").strip().splitlines()[-1][-200:]}


def _restore_packages() -> None:
    """Au démarrage du lanceur : réinstalle dans chaque agent les paquets qu'il avait ajoutés."""
    for c in client.containers.list(filters={"label": LABEL}):
        try:
            res = c.exec_run(["sh", "-c", f"cat {PACKAGES_FILE} 2>/dev/null"], user="root")
            wanted = [p for p in res.output.decode().split() if PACKAGE_RE.match(p)]
            if not wanted:
                continue
            missing = [p for p in wanted if c.exec_run(["dpkg", "-s", p], user="root").exit_code != 0]
            if missing:
                _apt(c, missing)
        except Exception as e:  # noqa: BLE001 - un agent arrêté entre-temps ne prive pas les suivants de leurs paquets
            print(f"[lanceur] paquets de {c.name} non restaurés : {e}", flush=True)


@app.on_event("startup")
def restore_packages() -> None:
    threading.Thread(target=_restore_packages, daemon=True).start()


@app.post("/agents/{agent_id}/restart", dependencies=[Depends(auth), Depends(_frozen)])
def restart(agent_id: str):
    container(check_id(agent_id)).restart(timeout=10)
    return {"ok": True}


@app.delete("/agents/{agent_id}", dependencies=[Depends(auth), Depends(_frozen)])
def delete(agent_id: str):
    """Se reprend après une coupure : conteneur déjà parti ou non, le navigateur et les volumes partent aussi."""
    try:
        container(check_id(agent_id)).remove(force=True)
    except HTTPException as e:
        if e.status_code != 404:
            raise
    # Le navigateur, et les restes « -ancien » d'une opération coupée (dossiers, mise à jour) : sinon ils retiennent les
    # volumes. Seulement ceux qui portent l'étiquette de cet agent.
    for name, label in ((BROWSER_PREFIX + agent_id, BROWSER_LABEL), (PREFIX + agent_id + "-ancien", LABEL),
                        (BROWSER_PREFIX + agent_id + "-ancien", BROWSER_LABEL)):
        try:
            b = client.containers.get(name)
            if b.labels.get(label) == agent_id:
                b.remove(force=True)
        except NotFound:
            pass
    left = []
    for volume in (PREFIX + agent_id, BROWSER_PREFIX + agent_id):
        try:
            client.volumes.get(volume).remove(force=True)
        except NotFound:
            pass
        except docker.errors.APIError as e:  # encore utilisé : on le nomme au lieu d'échouer en silence au milieu
            print(f"[lanceur] volume {volume} gardé : {e}", flush=True)
            left.append(volume)
    return {"ok": True, "restes": left}


# --- Mises à jour (détail dans updater.py) --------------------------------------------------------------

@app.get("/health")
def health():
    """Contrôle de santé après une mise à jour du lanceur : il répond et il parle à Docker."""
    try:
        client.ping()
    except Exception:  # noqa: BLE001
        raise HTTPException(503, "Docker injoignable")
    return {"ok": True}


def _recreate_browser(name: str, image: str, start: bool = True) -> None:
    """Navigateur sur une nouvelle image : la transaction l'a déjà arrêté et renommé <nom>-ancien ; on le recrée par
    _ensure_browser, qui dépose l'extension Noah et la config de Firefox avant le démarrage (une simple recréation
    les perdrait). Appelé avec _browser_lock déjà pris."""
    old = client.containers.get(f"{name}-ancien")
    env = dict(e.split("=", 1) for e in old.attrs["Config"]["Env"] if "=" in e)
    env.update(updater.env_values((updater.read_text(old, SECRETS_FILE) or ("",))[0]))
    agent_id = old.labels[BROWSER_LABEL]
    _, locale, timezone = (old.labels.get("noah.browser.version", "") + "::").split(":")[:3]
    body = BrowserKeys(api_key=env["CAMOFOX_API_KEY"], vnc_password=env["VNC_PASSWORD"],
                       private_key=env.get("NOAH_PRIVATE_KEY", ""), locale=locale, timezone=timezone)
    _ensure_browser(agent_id, body, image, start)


@app.post("/restore", dependencies=[Depends(auth)])
async def restore_start(request: Request):
    """Archive de scripts/backup.sh, envoyée par le serveur (code d'installation vérifié, aucun compte encore).
    Elle tient le verrou des mises à jour jusqu'à la fin du travail (relâché par restore.run)."""
    if not updater._lock.acquire(blocking=False):
        raise HTTPException(409, "Noah installe une mise à jour : réessaie dans quelques minutes.")
    try:
        not_updating("")
    except HTTPException:
        updater._lock.release()
        raise
    if not restore.claim():
        updater._lock.release()
        raise HTTPException(409, "Une restauration est déjà en cours")
    restore.WORK.mkdir(parents=True, exist_ok=True)
    path = restore.WORK / "sauvegarde.tar"
    try:
        with open(path, "wb") as f:  # sur le disque : l'archive peut peser plusieurs gigaoctets
            async for chunk in request.stream():
                f.write(chunk)
        restore.inspect(path)
    except Exception as e:
        path.unlink(missing_ok=True)
        restore.state.update(etape=None, erreur=None, fini=False)
        updater._lock.release()
        raise HTTPException(400, str(e) if isinstance(e, ValueError) else "Archive illisible")
    threading.Thread(target=restore.run, args=(path, (LABEL, BROWSER_LABEL)), daemon=True).start()
    return {"ok": True}


@app.get("/restore", dependencies=[Depends(auth)])
def restore_status():
    return restore.state


updater.HOOKS["navigateur"] = _recreate_browser
updater.LOCKS["navigateur"] = _browser_lock
updater.AFTER["hermes"] = _restore_packages  # paquets ajoutés par les agents : réinstallés sur la nouvelle image
# Mise à jour interrompue par un arrêt brutal : annulée au démarrage, avant toute nouvelle opération.
_recovering = threading.Thread(target=updater.recover, daemon=True)
_recovering.start()
threading.Thread(target=restore.recover, daemon=True).start()  # restauration coupée : serveur relancé, erreur dite
threading.Thread(target=updater.watchdog, daemon=True).start()


def _migrate_agent_tokens() -> None:
    """Agents créés avant G7.2 (jeton de l'API dans leur config Docker) : recréés une fois sur la même image, le jeton
    passant dans le .env de leur volume. Même verrou que les mises à jour ; si le nouveau ne répond pas, l'ancien revient."""
    _recovering.join(600)  # une mise à jour coupée se règle d'abord
    with updater._lock:
        try:
            busy = bool(updater.load_state().get("en_cours"))
        except updater.Corrupt:
            return
        if busy:
            return  # une mise à jour s'en chargera (_create_like déplace aussi le jeton)
        for c in client.containers.list(all=True, filters={"label": LABEL}):
            if not any(e.startswith("API_SERVER_KEY=") for e in c.attrs["Config"]["Env"] or []):
                continue
            name, running = c.name, c.status == "running"
            if _exists_container(name + "-ancien"):
                # Reste d'une opération coupée : on ne touche à rien (un renommage échouerait, et le retour arrière
                # risquerait de viser le mauvais conteneur). La prochaine mise à jour s'en chargera.
                print(f"[lanceur] migration du jeton de {name} remise : {name}-ancien existe déjà", flush=True)
                continue
            renamed, new_id = False, None
            try:
                c.stop(timeout=30)
                c.rename(name + "-ancien")
                renamed = True
                c.reload()
                updater._create_like(c, name, c.image.id)
                new = client.containers.get(name)
                new_id = new.id
                if running:
                    new.start()
                    if not updater.healthy(name, 120):
                        raise RuntimeError("l'agent ne répond pas après la migration")
                c.remove(force=True)
            except Exception as e:  # noqa: BLE001 — l'ancien conteneur revient tel quel
                print(f"[lanceur] migration du jeton de {name} annulée : {e}", flush=True)
                # Seul le conteneur créé ici est supprimé, par son identifiant : jamais l'original.
                if new_id:
                    try:
                        client.containers.get(new_id).remove(force=True)
                    except NotFound:
                        pass
                if renamed:
                    c.rename(name)
                if running:
                    c.start()


def _exists_container(name: str) -> bool:
    try:
        client.containers.get(name)
        return True
    except NotFound:
        return False


threading.Thread(target=_migrate_agent_tokens, daemon=True).start()


def _isolate_existing() -> None:
    """Conteneurs d'avant E1 : agents et navigateurs passent du réseau commun au leur, sans redémarrer ; un agent sans
    `cap_drop: ALL` est recréé une fois sur la même image (même volume, même jeton), comme pour la migration du jeton.
    Les navigateurs le sont à leur prochaine ouverture (BROWSER_VERSION)."""
    if not MANAGED_NETWORK:
        return
    try:
        _ensure_agents_network()
        for label in (LABEL, BROWSER_LABEL):
            for c in client.containers.list(all=True, filters={"label": label}):
                nets = c.attrs.get("NetworkSettings", {}).get("Networks") or {}
                if NETWORK not in nets:
                    client.networks.get(NETWORK).connect(c, aliases=[c.name])
                if SHARED_NETWORK in nets:
                    client.networks.get(SHARED_NETWORK).disconnect(c)
    except Exception as e:  # noqa: BLE001 - au prochain démarrage du lanceur
        print(f"[lanceur] passage des agents sur {NETWORK} remis : {e}", flush=True)
        return
    _recovering.join(600)
    with updater._lock:
        try:
            if updater.load_state().get("en_cours"):
                return  # une mise à jour recrée déjà le parc
        except updater.Corrupt:
            return
        for c in client.containers.list(all=True, filters={"label": LABEL}):
            if (c.attrs.get("HostConfig", {}).get("CapDrop") or []) != ["ALL"] and not c.name.endswith("-ancien"):
                _recreate_isolated(c)


def _recreate_isolated(c, quoi: str = "isolé (cap_drop ALL)", env: dict | None = None) -> None:
    name, running = c.name, c.status == "running"
    if _exists_container(name + "-ancien"):
        print(f"[lanceur] isolement de {name} remis : {name}-ancien existe déjà", flush=True)
        return
    renamed, new_id = False, None
    try:
        c.stop(timeout=30)
        c.rename(name + "-ancien")
        renamed = True
        c.reload()
        hc = c.attrs["HostConfig"]  # _create_like recopie cette configuration : on y pose l'isolement
        hc.update(CapDrop=["ALL"], CapAdd=list(AGENT_CAPS), SecurityOpt=sorted(set(hc.get("SecurityOpt") or []) | {"no-new-privileges"}))
        if env:  # _create_like recopie aussi l'environnement : on y pose le proxy
            cfg = c.attrs["Config"]
            cfg["Env"] = [e for e in (cfg.get("Env") or []) if e.split("=", 1)[0] not in env] + [f"{k}={v}" for k, v in env.items()]
        updater._create_like(c, name, c.image.id)
        new = client.containers.get(name)
        new_id = new.id
        if running:
            new.start()
            if not updater.healthy(name, 120):
                raise RuntimeError("l'agent ne répond pas une fois recréé")
        c.remove(force=True)
        print(f"[lanceur] {name} recréé {quoi}", flush=True)
    except Exception as e:  # noqa: BLE001 — l'ancien conteneur revient tel quel
        print(f"[lanceur] isolement de {name} annulé : {e}", flush=True)
        if new_id:
            try:
                client.containers.get(new_id).remove(force=True)
            except NotFound:
                pass
        if renamed:
            c.rename(name)
        if running:
            c.start()


threading.Thread(target=_isolate_existing, daemon=True).start()


def _agents_vers_aiguillage_au_demarrage() -> None:
    """Une sortie était déjà choisie avant cette version (0.4.3 : seul le navigateur passait par elle) : au démarrage du lanceur,
    les agents sans le proxy le reçoivent, sans attendre que la personne rebascule l'interrupteur. Après l'isolement et la reprise
    d'une mise à jour, qui prennent le même verrou."""
    _recovering.join(600)
    try:
        _agents_vers_aiguillage()
    except Exception as e:  # noqa: BLE001 - Docker indisponible : au prochain démarrage, ou au prochain choix de sortie
        print(f"[lanceur] passage des agents sur l'aiguillage remis : {e}", flush=True)


threading.Thread(target=_agents_vers_aiguillage_au_demarrage, daemon=True).start()
threading.Thread(target=_watch_network, daemon=True).start()


def not_updating(agent_id: str = "") -> None:
    """Pendant une mise à jour, on ne crée ni ne supprime d'agent : la transaction a figé la liste des conteneurs.
    Une transaction qui démarre attend la fin de l'opération en cours (même verrou), et aucune ne démarre pendant."""
    try:
        state = updater.load_state()
    except updater.Corrupt:
        raise HTTPException(409, "Le journal des mises à jour est illisible : rien n'est modifié tant qu'il n'est pas vérifié.")
    tx = state.get("en_cours")
    if agent_id and any(agent_id in g for g in state.get("gardes", [])):
        raise HTTPException(409, "Cet agent a été mis de côté après une mise à jour (Réglages > Mises à jour).")
    if tx and tx.get("phase") == "intervention":
        # Des conteneurs sont gardés arrêtés pour protéger leurs données : rien ne doit les redémarrer ou les recréer.
        raise HTTPException(409, "Une mise à jour attend ta décision (Réglages > Mises à jour) avant de toucher aux agents.")
    if tx:
        raise HTTPException(409, "Noah installe une mise à jour : réessaie dans quelques minutes.")


class SignedManifest(BaseModel):
    manifeste: str  # octets signés, en base64
    signature: str
    composants: list[str] | None = None
    force: bool = False


def _verified(body: SignedManifest) -> tuple[bytes, dict]:
    raw = base64.b64decode(body.manifeste)
    try:
        return raw, updater.verify_logged(raw, body.signature)  # un refus est écrit à l'historique
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/update/status", dependencies=[Depends(auth)])
def update_status():
    return {"actuel": updater.current(), "etat": updater.load_state()}


@app.post("/update/pull", dependencies=[Depends(auth)])
def update_pull(body: SignedManifest):
    """Préchargement : seulement des images du manifeste signé."""
    _, manifest = _verified(body)
    return updater.pull([r for c, r in manifest["images"].items() if body.composants is None or c in body.composants])


class Resolve(BaseModel):
    action: str


@app.post("/update/resolve", dependencies=[Depends(auth)])
def update_resolve(body: Resolve):
    return updater.resolve(body.action)


@app.post("/update/apply", dependencies=[Depends(auth)])
def update_apply(body: SignedManifest):
    """Lancée en arrière-plan : le serveur lui-même peut être recréé pendant l'opération ; il relit l'état ensuite."""
    raw, _ = _verified(body)
    reason = updater.refusal()  # réponse honnête tout de suite, plutôt qu'un « en cours » qui ne commencera pas
    if reason:
        raise HTTPException(409, reason)
    threading.Thread(target=updater.apply, args=(raw, body.signature, body.composants, body.force), daemon=True).start()  # force : réessayer une version bloquée
    return {"ok": True, "en_cours": True}
