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
NETWORK = os.environ["AGENT_NETWORK"]
PREFIX = "noah-agent-"
LABEL = "noah.agent"
DATA = "/opt/data"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")

client = docker.from_env()
# Ni /docs, ni /redoc, ni /openapi.json : les machines des agents joignent ce service, il ne leur décrit pas ses routes.
app = FastAPI(title="Noah Agent launcher", docs_url=None, redoc_url=None, openapi_url=None)


def auth(authorization: str = Header("")) -> None:
    if not hmac.compare_digest(authorization.encode(), f"Bearer {KEY}".encode()):
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
# 15 : sessions enregistrées chaque minute (connexions gardées après un arrêt brutal) ; 14 : remplir une page de connexion ; 12 : image Noah avec bureau, sans uBlock ; 11 : toutes les routes sous clé ; 10 : clé du mode privé à part ; 9 : aucune capture pendant une prise en main ; 8 : jetons hors de la config Docker
BROWSER_VERSION = "16"


def _frozen(agent_id: str):
    """Opération sur le parc (créer, supprimer, recréer un agent ou un navigateur) : elle tient le verrou des mises à
    jour pendant toute sa durée. Une transaction qui démarre l'attend ; pendant une transaction, elle est refusée."""
    if not updater._lock.acquire(blocking=False):
        raise HTTPException(409, "Noah installe une mise à jour : réessaie dans quelques minutes.")
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


@app.exception_handler(docker.errors.APIError)
async def docker_refused(request: Request, error: Exception):
    """Sans ça, le serveur ne reçoit qu'« Internal Server Error » et ne peut rien dire de plus."""
    print(f"[lanceur] Docker a refusé {request.url.path} : {error}", flush=True)
    if "is not running" in str(error):  # la personne lit ce message tel quel : pas d'identifiant de conteneur
        return JSONResponse({"detail": "Ton agent est arrêté pour l'instant. Relance-le avec « Redémarrer », puis réessaie."}, status_code=409)
    return JSONResponse({"detail": f"Docker a refusé : {error}"}, status_code=502)

_browser_lock = threading.Lock()  # deux appels simultanés recréaient le même conteneur (conflit Docker)


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
    version = f"{BROWSER_VERSION}:{body.locale}:{body.timezone}"
    try:
        c = client.containers.get(name)
        if c.labels.get("noah.browser.version") == version:
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
        },
        volumes={name: {"bind": "/data", "mode": "rw"}},
        network=NETWORK,
        restart_policy={"Name": "unless-stopped"},
        # Firefox sans carte graphique dessine tout au processeur : avec 2 cœurs, la console Google Cloud mettait 10 à
        # 30 s par clic et l'écran partagé ramait. Un onglet de cette console dépasse à lui seul 1,8 Go.
        mem_limit="4g",
        nano_cpus=_cpus(4),
        shm_size="1g",
        security_opt=["no-new-privileges"],
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


@app.post("/agents/{agent_id}/browser/restart", dependencies=[Depends(auth), Depends(_frozen)])
def restart_browser(agent_id: str):
    """Redémarre le conteneur du navigateur (écran figé, navigateur planté). Profil et cookies restent."""
    check_id(agent_id)
    try:
        c = client.containers.get(BROWSER_PREFIX + agent_id)
    except NotFound:
        raise HTTPException(404, "Navigateur introuvable")
    if c.labels.get(BROWSER_LABEL) != agent_id:
        raise HTTPException(403, "Ce conteneur n'est pas un navigateur Noah Agent")
    c.restart(timeout=10)
    return {"ok": True}


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


def _shareable(path: str) -> bool:
    p = _norm(path)
    if not p or ".." in p.split("/") or SENSITIVE.search(p):
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
    c.remove(force=True)
    out = _run_agent(agent_id, key, folders)
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
    c = client.containers.create(
        image,
        command="gateway run",
        name=PREFIX + agent_id,
        hostname=PREFIX + agent_id,
        labels={LABEL: agent_id},
        environment={
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "0.0.0.0",
        },
        volumes=volumes,
        network=NETWORK,
        restart_policy={"Name": "unless-stopped"},
        mem_limit="4g",
        nano_cpus=_cpus(2),
        security_opt=["no-new-privileges"],
        cap_drop=["NET_RAW", "SYS_ADMIN", "MKNOD"],
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
# et la liste des dossiers partagés (pour que l'agent sache ce qu'ils sont).
CONFIG_FILES = (".env", "config.yaml", "SOUL.md", "noah.py", "dossiers.json",
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


def _seal_rights(c, rights: dict) -> None:
    """Les droits des outils, lus par le plugin de garde à chaque appel. Ils vivent hors du volume, écrits par root : l'agent
    peut lire son droit, pas se le donner, ni renommer un dossier parent qui lui appartient. Perdus si le conteneur est
    recréé : le serveur les réécrit à la configuration, et un droit absent vaut « confirmer »."""
    clean = json.dumps({str(k): v for k, v in (rights or {}).items() if v in TOOL_RIGHTS}, ensure_ascii=False)
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
        res = c.exec_run(["sh", "-c", f"cat {PACKAGES_FILE} 2>/dev/null"], user="root")
        wanted = [p for p in res.output.decode().split() if PACKAGE_RE.match(p)]
        if not wanted:
            continue
        missing = [p for p in wanted if c.exec_run(["dpkg", "-s", p], user="root").exit_code != 0]
        if missing:
            _apt(c, missing)


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
    try:
        b = client.containers.get(BROWSER_PREFIX + agent_id)
        if b.labels.get(BROWSER_LABEL) == agent_id:
            b.remove(force=True)
    except NotFound:
        pass
    for volume in (PREFIX + agent_id, BROWSER_PREFIX + agent_id):
        try:
            client.volumes.get(volume).remove(force=True)
        except NotFound:
            pass
    return {"ok": True}


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
