"""Lanceur d'agents : seul service qui parle à Docker.

Il n'accepte qu'un petit vocabulaire (créer, écrire la config, redémarrer, supprimer un agent)
et construit lui-même chaque conteneur à partir d'une image fixe, sans montage de l'hôte ni
privilège. Le serveur Noah Agent n'a donc jamais accès au socket Docker.
"""
import io
import json
import os
import re
import tarfile
import threading
import time
from pathlib import Path

import docker
from docker.errors import NotFound
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, Response
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
IMAGE = os.environ.get("AGENT_IMAGE", "nousresearch/hermes-agent:stable")
NETWORK = os.environ["AGENT_NETWORK"]
PREFIX = "apollo-agent-"
LABEL = "apollo.agent"
DATA = "/opt/data"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")

client = docker.from_env()
app = FastAPI(title="Noah Agent launcher")


def auth(authorization: str = Header("")) -> None:
    if authorization != f"Bearer {KEY}":
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


BROWSER_IMAGE = os.environ.get("BROWSER_IMAGE", "ghcr.io/jo-inc/camofox-browser:latest")
BROWSER_PREFIX = "apollo-browser-"
BROWSER_LABEL = "apollo.browser"
# Version des réglages du navigateur ; un conteneur plus ancien est recréé (le profil reste dans son volume).
BROWSER_VERSION = "7"


class BrowserKeys(BaseModel):
    api_key: str
    vnc_password: str
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


_browser_lock = threading.Lock()  # deux appels simultanés recréaient le même conteneur (conflit Docker)


@app.post("/agents/{agent_id}/browser", dependencies=[Depends(auth)])
def ensure_browser(agent_id: str, body: BrowserKeys):
    """Crée (si besoin) le navigateur Camoufox de l'agent, avec son écran partagé en noVNC.

    Le profil (cookies, sessions connectées) vit dans un volume à part, gardé entre les redémarrages.
    """
    with _browser_lock:
        return _ensure_browser(agent_id, body)


def _ensure_browser(agent_id: str, body: BrowserKeys):
    check_id(agent_id)
    container(agent_id)  # l'agent doit exister
    name = BROWSER_PREFIX + agent_id
    version = f"{BROWSER_VERSION}:{body.locale}:{body.timezone}"
    try:
        c = client.containers.get(name)
        if c.labels.get("apollo.browser.version") == version:
            if c.status != "running":
                c.start()
            return {"host": name, "created": False}
        c.stop(timeout=20)  # arrêt propre : Camoufox enregistre les cookies de la session (connexions comprises)
        c.remove(force=True)
    except NotFound:
        pass
    _ensure_image(BROWSER_IMAGE)
    c = client.containers.create(
        BROWSER_IMAGE,
        name=name,
        hostname=name,
        labels={BROWSER_LABEL: agent_id, "apollo.browser.version": version},
        environment={
            "CAMOFOX_PORT": "9377",
            "CAMOFOX_BIND_HOST": "0.0.0.0",
            "CAMOFOX_API_KEY": body.api_key,
            "CAMOFOX_PROFILE_DIR": "/data/profiles",
            "CAMOFOX_COOKIES_DIR": "/data/cookies",
            "CAMOFOX_CRASH_REPORT_ENABLED": "false",
            "ENABLE_VNC": "1",
            "VNC_RESOLUTION": "1920x1080",  # taille de la fenêtre Camoufox : rien n'est coupé à l'écran
            "VNC_PASSWORD": body.vnc_password,
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
        nano_cpus=4_000_000_000,
        shm_size="1g",
        security_opt=["no-new-privileges"],
    )
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
    c.start()
    return {"host": name, "created": True}


CAMOUFOX_CFG = "/root/.cache/camoufox/camoufox.cfg"


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


@app.post("/agents/{agent_id}/browser/restart", dependencies=[Depends(auth)])
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


@app.get("/agents/{agent_id}/file", dependencies=[Depends(auth)])
def read_workspace_file(agent_id: str, path: str):
    full = _workspace_path(path)
    try:
        stream, stat = container(check_id(agent_id)).get_archive(full)
    except NotFound:
        raise HTTPException(404, "Fichier introuvable")
    if stat["size"] > FILE_MAX:
        raise HTTPException(413, "Fichier trop lourd")
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
        member = tar.getmembers()[0]
        if not member.isfile():
            raise HTTPException(400, "Ce n'est pas un fichier")
        return Response(tar.extractfile(member).read(), media_type="application/octet-stream")


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
# Jamais partagés, même sous une racine autorisée : clés, identifiants, données des applications.
SENSITIVE = re.compile(r"(^|/)(\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.config|appdata|library/keychains)(/|$)", re.I)


class Folder(BaseModel):
    nom: str
    chemin: str
    ecriture: bool = False


NewAgent.model_rebuild()


def _norm(path: str) -> str:
    return path.strip().replace("\\", "/").rstrip("/")


def _shareable(path: str) -> bool:
    p = _norm(path)
    if not p or ".." in p.split("/") or SENSITIVE.search(p):
        return False
    for root in SHARE_ROOTS:
        r = _norm(root)
        windows = re.match(r"^[A-Za-z]:", r) is not None  # C:\… : chemins insensibles à la casse
        a, b = (p.lower(), r.lower()) if windows else (p, r)
        if a == b or a.startswith(b + "/"):
            return True
    return False


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
    return folders


@app.get("/folders/roots", dependencies=[Depends(auth)])
def folder_roots():
    return {"racines": SHARE_ROOTS}


@app.post("/agents/{agent_id}", dependencies=[Depends(auth)])
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


@app.put("/agents/{agent_id}/folders", dependencies=[Depends(auth)])
def set_folders(agent_id: str, body: AgentFolders):
    """Change les dossiers partagés : la machine de l'agent est recréée (son volume garde tout le reste)."""
    folders = _check_folders(body.dossiers)
    c = container(check_id(agent_id))
    env = dict(e.split("=", 1) for e in c.attrs["Config"]["Env"] if "=" in e)
    c.remove(force=True)
    out = _run_agent(agent_id, env["API_SERVER_KEY"], folders)
    threading.Thread(target=_restore_packages, daemon=True).start()
    return out


def _run_agent(agent_id: str, api_key: str, folders: list[Folder]):
    volumes = {PREFIX + agent_id: {"bind": DATA, "mode": "rw"}}
    for f in folders:
        volumes[f.chemin] = {"bind": f"{DATA}/dossiers/{f.nom}", "mode": "rw" if f.ecriture else "ro"}
    client.containers.run(
        IMAGE,
        command="gateway run",
        name=PREFIX + agent_id,
        hostname=PREFIX + agent_id,
        detach=True,
        labels={LABEL: agent_id},
        environment={
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "0.0.0.0",
            "API_SERVER_KEY": api_key,
        },
        volumes=volumes,
        network=NETWORK,
        extra_hosts={"host.docker.internal": "host-gateway"},
        restart_policy={"Name": "unless-stopped"},
        mem_limit="4g",
        nano_cpus=2_000_000_000,
        security_opt=["no-new-privileges"],
        cap_drop=["NET_RAW", "SYS_ADMIN", "MKNOD"],
    )
    return {"id": agent_id, "host": PREFIX + agent_id}


# Fichiers que le serveur peut écrire dans /opt/data : config d'Hermes, rôle, l'outil `noah.py` de l'agent,
# et la liste des dossiers partagés (pour que l'agent sache ce qu'ils sont).
CONFIG_FILES = (".env", "config.yaml", "SOUL.md", "noah.py", "dossiers.json")


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
    try:
        stream, stat = container(agent_id).get_archive(path)
    except NotFound:
        raise HTTPException(404, "Image introuvable")
    if stat["size"] > MEDIA_MAX:
        raise HTTPException(413, "Image trop lourde")
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
        data = tar.extractfile(tar.getmembers()[0]).read()
    return Response(data, media_type=MEDIA_TYPES[ext], headers={"Cache-Control": "private, max-age=86400"})


# Hermes fige le prompt système d'une session à son premier message. Pour qu'un nouveau rôle ou de
# nouvelles consignes s'appliquent aux conversations en cours, on efface ce prompt enregistré :
# Hermes le reconstruit au tour suivant, une seule fois.
FORGET_PROMPTS = """
import sqlite3
c = sqlite3.connect('/opt/data/state.db', timeout=30)
n = c.execute("UPDATE sessions SET system_prompt = NULL, system_prompt_hash = NULL WHERE id LIKE 'apollo-%'").rowcount
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
    return out


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


@app.post("/agents/{agent_id}/restart", dependencies=[Depends(auth)])
def restart(agent_id: str):
    container(check_id(agent_id)).restart(timeout=10)
    return {"ok": True}


@app.delete("/agents/{agent_id}", dependencies=[Depends(auth)])
def delete(agent_id: str):
    c = container(check_id(agent_id))
    c.remove(force=True)
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
