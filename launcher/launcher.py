"""Lanceur d'agents : seul service qui parle à Docker.

Il n'accepte qu'un petit vocabulaire (créer, écrire la config, redémarrer, supprimer un agent)
et construit lui-même chaque conteneur à partir d'une image fixe, sans montage de l'hôte ni
privilège. Le serveur Apollo n'a donc jamais accès au socket Docker.
"""
import io
import os
import re
import tarfile
import time

import docker
from docker.errors import NotFound
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel

KEY = os.environ["LAUNCHER_KEY"]
IMAGE = os.environ.get("AGENT_IMAGE", "nousresearch/hermes-agent:stable")
NETWORK = os.environ["AGENT_NETWORK"]
PREFIX = "apollo-agent-"
LABEL = "apollo.agent"
DATA = "/opt/data"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")

client = docker.from_env()
app = FastAPI(title="Apollo launcher")


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
        raise HTTPException(403, "Ce conteneur n'est pas un agent Apollo")
    return c


class NewAgent(BaseModel):
    api_key: str


BROWSER_IMAGE = os.environ.get("BROWSER_IMAGE", "ghcr.io/jo-inc/camofox-browser:latest")
BROWSER_PREFIX = "apollo-browser-"
BROWSER_LABEL = "apollo.browser"
# Version des réglages du navigateur ; un conteneur plus ancien est recréé (le profil reste dans son volume).
BROWSER_VERSION = "3"


class BrowserKeys(BaseModel):
    api_key: str
    vnc_password: str


@app.post("/agents/{agent_id}/browser", dependencies=[Depends(auth)])
def ensure_browser(agent_id: str, body: BrowserKeys):
    """Crée (si besoin) le navigateur Camoufox de l'agent, avec son écran partagé en noVNC.

    Le profil (cookies, sessions connectées) vit dans un volume à part, gardé entre les redémarrages.
    """
    check_id(agent_id)
    container(agent_id)  # l'agent doit exister
    name = BROWSER_PREFIX + agent_id
    try:
        c = client.containers.get(name)
        if c.labels.get("apollo.browser.version") == BROWSER_VERSION:
            if c.status != "running":
                c.start()
            return {"host": name, "created": False}
        c.remove(force=True)
    except NotFound:
        pass
    client.containers.run(
        BROWSER_IMAGE,
        name=name,
        hostname=name,
        detach=True,
        labels={BROWSER_LABEL: agent_id, "apollo.browser.version": BROWSER_VERSION},
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
        },
        volumes={name: {"bind": "/data", "mode": "rw"}},
        network=NETWORK,
        restart_policy={"Name": "unless-stopped"},
        mem_limit="2g",
        nano_cpus=2_000_000_000,
        shm_size="1g",
        security_opt=["no-new-privileges"],
    )
    return {"host": name, "created": True}


@app.post("/agents/{agent_id}/browser/restart", dependencies=[Depends(auth)])
def restart_browser(agent_id: str):
    """Redémarre le conteneur du navigateur (écran figé, navigateur planté). Profil et cookies restent."""
    check_id(agent_id)
    try:
        c = client.containers.get(BROWSER_PREFIX + agent_id)
    except NotFound:
        raise HTTPException(404, "Navigateur introuvable")
    if c.labels.get(BROWSER_LABEL) != agent_id:
        raise HTTPException(403, "Ce conteneur n'est pas un navigateur Apollo")
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
async def upload(agent_id: str, name: str, request: Request):
    """Dépose un fichier de l'utilisateur dans workspace/uploads/ (lisible par l'agent)."""
    c = container(check_id(agent_id))
    safe = re.sub(r"[^\w.\- ()]+", "_", os.path.basename(name)).strip() or "fichier"
    data = await request.body()
    if len(data) > FILE_MAX:
        raise HTTPException(413, "Fichier trop lourd (100 Mo max)")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(f"uploads/{safe}")
        info.size = len(data)
        info.mode = 0o644
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(data))
    c.exec_run(["mkdir", "-p", f"{WORKSPACE}/uploads"], user="root")
    c.put_archive(WORKSPACE, buf.getvalue())
    # L'agent tourne sous son propre utilisateur : on lui rend la propriété du dossier.
    c.exec_run(["sh", "-c", f"chown -R --reference={WORKSPACE} {WORKSPACE}/uploads"], user="root")
    return {"path": f"{WORKSPACE}/uploads/{safe}"}


@app.get("/agents", dependencies=[Depends(auth)])
def list_agents():
    return [
        {"id": c.labels[LABEL], "status": c.status}
        for c in client.containers.list(all=True, filters={"label": LABEL})
    ]


@app.post("/agents/{agent_id}", dependencies=[Depends(auth)])
def create(agent_id: str, body: NewAgent):
    check_id(agent_id)
    try:
        client.containers.get(PREFIX + agent_id)
        raise HTTPException(409, "Cet agent existe déjà")
    except NotFound:
        pass
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
            "API_SERVER_KEY": body.api_key,
        },
        volumes={PREFIX + agent_id: {"bind": DATA, "mode": "rw"}},
        network=NETWORK,
        extra_hosts={"host.docker.internal": "host-gateway"},
        restart_policy={"Name": "unless-stopped"},
        mem_limit="4g",
        nano_cpus=2_000_000_000,
        security_opt=["no-new-privileges"],
        cap_drop=["NET_RAW", "SYS_ADMIN", "MKNOD"],
    )
    return {"id": agent_id, "host": PREFIX + agent_id}


# Fichiers que le serveur peut écrire dans /opt/data : config d'Hermes, rôle, et l'outil `apollo.py` de l'agent.
CONFIG_FILES = (".env", "config.yaml", "SOUL.md", "apollo.py")


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
