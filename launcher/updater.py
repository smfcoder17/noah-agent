"""Mises à jour des conteneurs de Noah Agent, faites par le lanceur (seul service qui parle à Docker).

Le serveur décide quand (créneau calme, rien en cours) ; le lanceur décide quoi : il revérifie lui-même la signature
du manifeste (clé publique dans son image), refuse une version plus ancienne que la dernière installée, et n'installe
que les empreintes signées. Une mise à jour est une transaction, journalisée sur disque (fsync) avant chaque geste :

  remplacement  pour chaque conteneur, dans l'ordre (un agent d'abord, en canari, puis les autres, les navigateurs,
                Caddy, le serveur) : arrêt, instantané à froid de ses volumes (inventaire avec empreintes), renommage
                en <nom>-ancien, création sur la nouvelle image, démarrage, contrôle de santé ;
  observation   tous les conteneurs neufs sont surveillés 2 minutes (ils tournent, ne redémarrent pas, répondent ;
                le serveur aussi à travers Caddy), comme la fenêtre de retour arrière de What's Up Docker ;
  lanceur       s'il change, un relais lancé depuis la nouvelle image le remplace, l'observe, et décide pour toute
                la transaction (les anciens conteneurs attendent jusque-là) ;
  validation    les anciens conteneurs partent, les versions sont épinglées pour les agents à venir.

Au premier échec, tout ce qui a changé revient (conteneurs et données d'avant), et l'empreinte fautive est bloquée
pour cette version. Une coupure à n'importe quelle étape (kill -9, panne de courant) est rattrapée au démarrage
suivant en rapprochant le journal de l'état réel de Docker : on revient à l'ancienne version, ou on termine la
validation, jamais un mélange. Si les données d'avant ne peuvent pas être remises, le conteneur reste arrêté et le
journal reste ouvert (« intervention ») plutôt que de démarrer une ancienne version sur des données migrées.
Mécanique de What's Up Docker (préchargement, sauvegarde bloquante, retour arrière selon la santé) et étape
« helper » de Coolify.
"""
import base64
import contextlib
import ctypes
import hashlib
import io
import json
import os
import re
import shutil
import socket
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import docker
    from docker.errors import APIError, NotFound
except ImportError:  # conteneur jetable des sauvegardes : pas besoin de Docker
    docker = None

client = docker.from_env() if docker and not os.environ.get("NOAH_TOOL") else None
STATE = Path(os.environ.get("NOAH_UPDATE_STATE", "/state/updates.json"))
BACKUP_VOLUME = os.environ.get("NOAH_BACKUP_VOLUME", "noah_noah-backups")
PUBLIC_KEY = os.environ.get("NOAH_UPDATE_KEY", "")
OBSERVE = int(os.environ.get("NOAH_UPDATE_OBSERVE", "120"))
HEALTH = int(os.environ.get("NOAH_UPDATE_HEALTH", "120"))
POLL = float(os.environ.get("NOAH_UPDATE_POLL", "5"))  # secondes entre deux regards sur un conteneur qui démarre
CADDY_DEADLINE = float(os.environ.get("NOAH_UPDATE_CADDY_DEADLINE", "20"))  # échéance du contrôle à travers Caddy
WATCHDOG = float(os.environ.get("NOAH_UPDATE_WATCHDOG", "300"))  # secondes entre deux tours de la surveillance
CRASH_AT = os.environ.get("NOAH_TEST_CRASH_AT", "")  # tests : arrêt brutal à une étape donnée
# Version de ce lanceur (posée à la publication) : plancher de l'anti-retour, même sur un journal tout neuf.
BUILT_VERSION = os.environ.get("NOAH_VERSION", "")
RELAY_TIMEOUT = int(os.environ.get("NOAH_RELAY_TIMEOUT", "1800"))
SPACE_MARGIN = int(os.environ.get("NOAH_UPDATE_SPACE_MARGIN", str(512 * 1024 * 1024)))
MAX_TRIES = 3  # échecs sans faute de l'image (disque plein, registre…) : au-delà, on attend la version suivante ou un clic
REF = re.compile(r"[a-z0-9./_:-]+@sha256:[0-9a-f]{64}")
_lock = threading.Lock()

SERVER, CADDY = "noah-server", "noah-caddy"
LAUNCHER = os.environ.get("NOAH_LAUNCHER_NAME", "noah-launcher")
RELAY = os.environ.get("NOAH_RELAY_NAME", "noah-launcher-relais")
IS_RELAY = os.environ.get("NOAH_IS_RELAY") == "1"
ORDER = ["hermes", "navigateur", "caddy", "noah-server"]
STEPS = ["arret", "sauve", "renomme", "cree", "demarre", "sain"]
# Fichiers que Docker Compose copie dans le conteneur à sa création (configs: content) : une recréation les perdrait.
COPIED_FILES = {CADDY: ["/etc/caddy/Caddyfile"]}
# Fournis par le lanceur : création particulière d'un composant (nom, image) -> None, verrou partagé avec ses autres
# opérations sur ces conteneurs, et geste après validation (réinstaller les paquets des agents…).
HOOKS: dict = {}
LOCKS: dict = {}
AFTER: dict = {}


class Corrupt(Exception):
    pass


class ToolFailed(RuntimeError):
    pass


class BackupFailed(ToolFailed):
    """Instantané impossible (disque plein…) : pas la faute de la nouvelle version."""


class NoSnapshot(ToolFailed):
    """Pas d'instantané complet : la nouvelle version n'a jamais tourné sur ces données (rien à remettre)."""


def _crash(step: str) -> None:
    """Tests : simule une coupure net (pas de finally, pas de nettoyage), une seule fois par étape."""
    if CRASH_AT and CRASH_AT == step:
        marker = STATE.parent / f".coupe-{step}"
        if not marker.exists():
            marker.write_text("1")
            os._exit(137)


# --- État : écrit sur disque avant chaque geste irréversible --------------------------------------------------

def _read(path: Path) -> dict:
    return json.loads(path.read_text())


def load_state() -> dict:
    """État courant ; s'il est illisible, sa copie précédente. Si les deux le sont, on refuse d'agir (Corrupt)
    plutôt que de repartir d'un état vierge qui oublierait une transaction en cours."""
    if not STATE.exists():
        return {"images": {}, "historique": [], "bloquees": [], "en_cours": None}
    for path in (STATE, STATE.with_suffix(".bak")):
        try:
            return _read(path)
        except (FileNotFoundError, ValueError):
            continue
    raise Corrupt(f"journal des mises à jour illisible ({STATE})")


@contextlib.contextmanager
def state_lock():
    """Verrou partagé par le lanceur, le relais et la reprise (même fichier, même noyau) ; aussi entre threads."""
    import fcntl
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with _lock, open(STATE.parent / ".verrou", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


_write_lock = threading.Lock()


def update_state(change) -> dict:
    """Lecture, modification, écriture : sous un verrou entre processus (lanceur, relais), fichier temporaire unique."""
    import fcntl
    import uuid
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock, open(STATE.parent / ".verrou-etat", "a") as lockfh:
        fcntl.flock(lockfh, fcntl.LOCK_EX)
        state = load_state()
        change(state)
        STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE.with_suffix(f".{uuid.uuid4().hex}.tmp")
        with open(tmp, "w") as fh:
            fh.write(json.dumps(state, ensure_ascii=False, indent=1))
            fh.flush()
            os.fsync(fh.fileno())
        if STATE.exists():
            shutil.copyfile(STATE, STATE.with_suffix(".bak"))
        os.replace(tmp, STATE)
        dirfd = os.open(STATE.parent, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        return state


def _log(text: str) -> None:
    print(f"[mise à jour] {text}", flush=True)

    def add(s):
        s["historique"] = (s.get("historique", []) + [{"quand": int(time.time()), "texte": text}])[-100:]
    update_state(add)


def _tx(change) -> dict:
    return update_state(lambda s: change(s["en_cours"]))


def _item(name: str, **fields) -> None:
    def change(s):
        for it in s["en_cours"]["elements"]:
            if it["nom"] == name:
                it.update(fields)
    update_state(change)


def pinned(component: str, default: str) -> str:
    """Image à utiliser pour un composant que le lanceur crée lui-même (agents, navigateurs)."""
    try:
        return load_state().get("images", {}).get(component) or default
    except Corrupt:
        return default


def _component(name: str) -> str | None:
    if name.startswith("noah-agent-"):
        return "hermes"
    if name.startswith("noah-browser-"):
        return "navigateur"
    return {CADDY: "caddy", SERVER: "noah-server", LAUNCHER: "noah-launcher"}.get(name)


def _semver(v: str) -> tuple:
    m = re.match(r"(\d+)\.(\d+)\.(\d+)$", v or "")
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


# --- Manifeste signé ----------------------------------------------------------------------------------------

def verify_manifest(raw: bytes, signature: str) -> dict:
    """Même contrôle que le serveur, refait ici : une fuite de la clé du lanceur ne suffit pas à faire tourner une
    image choisie par un attaquant avec l'accès à Docker."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    if not PUBLIC_KEY:
        raise ValueError("clé de signature des versions absente")
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY)).verify(base64.b64decode(signature.strip()), raw)
    except (InvalidSignature, ValueError) as e:
        raise ValueError("signature du manifeste invalide") from e
    manifest = json.loads(raw)
    images = manifest.get("images")
    if not isinstance(images, dict) or not all(isinstance(r, str) and REF.fullmatch(r) for r in images.values()):
        raise ValueError("manifeste sans empreintes")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", ""))):
        raise ValueError("manifeste sans numéro de version")
    return manifest


# --- Ce qui tourne ------------------------------------------------------------------------------------------

def components() -> dict[str, list[str]]:
    """Composant -> conteneurs (dans l'ordre où les mettre à jour)."""
    agents = sorted(c.name for c in client.containers.list(all=True, filters={"label": "noah.agent"}))
    browsers = sorted(c.name for c in client.containers.list(all=True, filters={"label": "noah.browser"}))
    out = {"hermes": [n for n in agents if not n.endswith("-ancien")],
           "navigateur": [n for n in browsers if not n.endswith("-ancien")]}
    for name in (CADDY, SERVER, LAUNCHER):
        try:
            client.containers.get(name)
            out[_component(name)] = [name]
        except NotFound:
            pass
    return out


def _get(name: str):
    try:
        return client.containers.get(name)
    except NotFound:
        return None


def _runs(name: str, ref: str) -> bool:
    c = _get(name)
    if not c:
        return False
    img = c.image
    return ref in (img.attrs.get("RepoDigests") or []) or ref.split("@")[-1] == img.id


def current() -> dict[str, list[dict]]:
    """Image de chaque conteneur, composant par composant : un parc à moitié mis à jour se voit."""
    out = {}
    for comp, names in components().items():
        out[comp] = []
        for name in names:
            c = _get(name)
            if c:
                img = c.image
                out[comp].append({"nom": name, "image_id": img.id, "digests": img.attrs.get("RepoDigests") or []})
    return out


# --- Préchargement ------------------------------------------------------------------------------------------

def _present(ref: str) -> bool:
    try:
        client.images.get(ref)
        return True
    except NotFound:
        return False


def pull(refs: list[str]) -> dict:
    """Télécharge les images à l'avance : au moment de la mise à jour, la coupure ne dure que la recréation."""
    done, failed = [], []
    for ref in refs:
        try:
            if not _present(ref):
                repo, digest = ref.split("@", 1)
                client.images.pull(repo, tag=digest)
            done.append(ref)
        except APIError as e:
            failed.append({"image": ref, "erreur": str(e)[:300]})
    return {"telechargees": done, "echecs": failed}


# --- Instantanés des volumes (conteneur jetable, conteneur d'origine arrêté) -----------------------------------

def _tool_image() -> str:
    """Image du lanceur lui-même (Python, sqlite3) : sert aux sauvegardes et restaurations, sans rien télécharger."""
    for ref in (socket.gethostname(), LAUNCHER):
        c = _get(ref)
        if c:
            return c.image.id
    return "python:3.12-slim"


def _tool(args: list[str], volumes: list[str], folder_rw: bool = True) -> str:
    """Lance ce fichier (<args> + volumes) dans un conteneur jetable, nommé d'après la tâche : après une coupure, la
    reprise le retrouve et l'arrête avant de recommencer. Lève une erreur s'il échoue."""
    tag = hashlib.sha1(" ".join([LAUNCHER] + args + volumes).encode()).hexdigest()[:12]
    name = f"noah-outil-{tag}"
    old = _get(name)
    if old:
        old.remove(force=True)
    mounts = {BACKUP_VOLUME: {"bind": "/backups", "mode": "rw" if folder_rw else "ro"}}
    for i, v in enumerate(volumes):
        mounts[v] = {"bind": f"/v{i}", "mode": "rw"}
    box = client.containers.create(_tool_image(), ["python", "/tmp/updater.py", *args, *volumes], volumes=mounts,
                                   name=name, labels={"noah.outil": LAUNCHER}, entrypoint=[], working_dir="/tmp", user="0",
                                   environment={"NOAH_TOOL": "1"})
    try:
        data = Path(__file__).read_bytes()
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            info = tarfile.TarInfo("updater.py")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        box.put_archive("/tmp", buf.getvalue())
        box.start()
        code = box.wait(timeout=3600)["StatusCode"]
        out = box.logs().decode(errors="replace").strip()
        if code == 3:
            raise NoSnapshot(out.splitlines()[-1] if out else "pas d'instantané")
        if code != 0:
            lines = out.splitlines()
            raise ToolFailed(lines[-1] if lines else f"code {code}")
        return out
    finally:
        box.remove(force=True)


def backup(volumes: list[str], folder: str) -> None:
    try:
        _tool(["snapshot", folder], volumes)
    except Exception as e:  # noqa: BLE001 - délai dépassé, Docker indisponible… : jamais la faute de la nouvelle image
        raise BackupFailed(str(e)[:300]) from e


def space(volumes: list[str]) -> dict:
    """Taille des volumes et place libre sur le disque des sauvegardes (le même que celui des volumes)."""
    return json.loads(_tool(["espace", "/backups"], volumes).splitlines()[-1])


def drop_backup(folder: str, keep: bool = False) -> None:
    """Instantanés d'une transaction annulée : supprimés (ils prendraient la place des suivants), ou marqués à garder
    (intervention : ce sont peut-être les seules données d'avant)."""
    try:
        _tool(["garde" if keep else "supprime", folder], [])
    except ToolFailed as e:
        print(f"[mise à jour] sauvegardes {folder} : {e}", flush=True)


def unpack(folder: str, volumes: list[str]) -> None:
    _tool(["unpack", folder], volumes, folder_rw=False)


def _is_sqlite(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def _check_sqlite(path: str) -> None:
    import sqlite3
    db = sqlite3.connect(path)
    try:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit(f"base abîmée : {path}")
    finally:
        db.close()


def _sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sync_volume(path: str) -> None:
    """Écrit sur disque le volume de ce chemin, et lui seul. Jamais sync() : il attend tous les disques de la machine, et un seul
    montage figé (réseau, FUSE) bloquerait la mise à jour, l'agent arrêté, jusqu'à l'échéance d'une heure. Vu en vrai."""
    fd = os.open(path, os.O_RDONLY)
    try:
        if ctypes.CDLL(None, use_errno=True).syncfs(fd) != 0:
            raise OSError(ctypes.get_errno(), "syncfs", path)
    finally:
        os.close(fd)


def _snapshot(folder: str, volumes: list[str]) -> None:
    """(Conteneur jetable.) /v<i> -> <folder>/<volume>.tar.gz, propriétaires et droits gardés, plus un inventaire
    des archives (empreintes). Les bases SQLite passent par l'API backup (le journal WAL compris) et integrity_check ;
    seuls leurs fichiers annexes (-wal, -shm, -journal) sont laissés de côté."""
    import sqlite3
    shutil.rmtree(folder, ignore_errors=True)  # reste d'une tentative coupée
    os.makedirs(folder)
    try:
        inventory = {}
        for i, name in enumerate(volumes):
            src = f"/v{i}"
            with tarfile.open(f"{folder}/{name}.tar.gz", "w:gz") as tar:
                tar.addfile(tar.gettarinfo(src, "."))
                for root, dirs, files in os.walk(src):
                    for entry in dirs + files:
                        path = os.path.join(root, entry)
                        base = next((path[: -len(s)] for s in ("-wal", "-shm", "-journal") if path.endswith(s)), None)
                        if base and _is_sqlite(base):
                            continue
                        info = tar.gettarinfo(path, "./" + os.path.relpath(path, src))
                        if info is None:  # socket, fichier spécial
                            continue
                        if info.isfile() and _is_sqlite(path):
                            copy = "/tmp/copy.db"
                            live, out = sqlite3.connect(path, timeout=30), sqlite3.connect(copy)
                            try:
                                live.backup(out)
                            finally:
                                live.close()
                                out.close()
                            _check_sqlite(copy)
                            info.size = os.path.getsize(copy)
                            with open(copy, "rb") as fh:
                                tar.addfile(info, fh)
                            os.unlink(copy)
                        elif info.isfile():
                            with open(path, "rb") as fh:
                                tar.addfile(info, fh)
                        else:
                            tar.addfile(info)
            inventory[name] = _sha(f"{folder}/{name}.tar.gz")
        _sync_volume(folder)  # archives sur disque avant l'inventaire : une panne ne laisse pas un inventaire sans archives
        with open(f"{folder}/inventaire.json", "w") as fh:  # écrit en dernier : sans lui, l'instantané n'existe pas
            json.dump(inventory, fh)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)  # pas de sauvegarde à moitié faite qui remplit le disque
        raise
    # Ne garder que les 5 dernières mises à jour.
    tops = sorted((p for p in Path("/backups").glob("maj-*") if not (p / ".garder").exists()),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for old in tops[5:]:
        shutil.rmtree(old, ignore_errors=True)


def _safe_members(tar: tarfile.TarFile, dest: Path):
    """Notre propre archive : on garde droits et propriétaires tels quels (le filtre « tar » de Python retire setgid
    et sticky), en refusant seulement ce qui sortirait du dossier."""
    root = dest.resolve()
    for m in tar.getmembers():
        target = (dest / m.name).resolve()
        if target != root and root not in target.parents:
            raise SystemExit(f"chemin hors du volume dans l'archive : {m.name}")
        if m.islnk() and root not in (dest / m.linkname).resolve().parents:
            raise SystemExit(f"lien hors du volume dans l'archive : {m.name}")
        yield m


def _unpack(folder: str, volumes: list[str]) -> None:
    """Restauration idempotente : on peut la relancer après une coupure à n'importe quel moment."""
    try:
        inventory = json.loads(Path(folder, "inventaire.json").read_text())
    except (FileNotFoundError, ValueError):
        print(f"pas d'instantané complet : {folder}", flush=True)
        raise SystemExit(3)
    for i, name in enumerate(volumes):
        archive, dest = Path(f"{folder}/{name}.tar.gz"), Path(f"/v{i}")
        if name not in inventory or not archive.exists() or _sha(str(archive)) != inventory[name]:
            raise SystemExit(f"archive absente ou abîmée : {archive}")
        staging, aside = dest / ".noah-restauration", dest / ".noah-avant"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
        try:
            with tarfile.open(archive) as tar:
                tar.extractall(staging, members=_safe_members(tar, staging), numeric_owner=True, filter="fully_trusted")
            for path in staging.rglob("*"):
                if path.is_file() and not path.is_symlink() and _is_sqlite(str(path)):
                    _check_sqlite(str(path))
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)  # les données en place n'ont pas bougé
            raise
        # Bascule par renommages : ce qui est en place passe de côté, puis l'archive extraite prend sa place.
        aside.mkdir(exist_ok=True)
        for child in dest.iterdir():
            if child not in (staging, aside):
                os.replace(child, aside / child.name) if not (aside / child.name).exists() else (
                    shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink())
        for child in staging.iterdir():
            os.replace(child, dest / child.name)
        st = staging.stat()
        os.chown(dest, st.st_uid, st.st_gid)
        os.chmod(dest, st.st_mode & 0o7777)
        staging.rmdir()
        _sync_volume(str(dest))  # données d'avant sur disque avant de jeter celles d'après et de redémarrer l'ancien
        shutil.rmtree(aside, ignore_errors=True)


def volumes_of(name: str) -> list[str]:
    c = _get(name)
    if not c:
        return []
    return [m["Name"] for m in c.attrs.get("Mounts", []) if m.get("Type") == "volume" and m.get("Name") != BACKUP_VOLUME]


# --- Santé ----------------------------------------------------------------------------------------------------

def _health_url(name: str) -> str | None:
    if name == SERVER:
        return f"http://{SERVER}:8080/api/status"
    if name == LAUNCHER or name.endswith("-launcher"):
        return f"http://{name}:9000/health"
    if name == CADDY:
        return f"http://{CADDY}:80/"  # Caddy répond (redirection vers HTTPS) : il a bien sa configuration
    if name.startswith("noah-agent-"):
        return f"http://{name}:8642/health"
    if name.startswith("noah-browser-"):
        return f"http://{name}:9377/health"
    return None


def _answers(url: str) -> bool:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(url, timeout=5) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        return e.code in (301, 302, 308)
    except Exception:  # noqa: BLE001 - pas encore prêt
        return False


def _through_caddy() -> bool:
    """De bout en bout, comme un utilisateur : HTTPS sur le nom public, par Caddy, jusqu'au serveur."""
    import http.client
    import ssl
    if not _get(CADDY):
        return True  # installation sans Caddy (ordinateur local)
    try:
        with urllib.request.urlopen(f"http://{SERVER}:8080/api/public", timeout=5) as r:
            address = json.loads(r.read()).get("adresse") or ""
        host = address.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0] if address.startswith("https://") else ""
    except Exception:  # noqa: BLE001
        return False
    if not host:
        return True
    # Certificat vérifié pour le nom public, comme le ferait un navigateur (tests : autorité locale de Caddy).
    ctx = ssl.create_default_context(cafile=os.environ.get("NOAH_TEST_CA") or None)
    deadline = time.monotonic() + CADDY_DEADLINE  # échéance globale : un flux qui traîne compte comme un échec
    try:
        raw = socket.create_connection((CADDY, 443), timeout=min(10, CADDY_DEADLINE))
        sock = ctx.wrap_socket(raw, server_hostname=host)
        conn = http.client.HTTPSConnection(host, 443, timeout=min(10, CADDY_DEADLINE), context=ctx)
        conn.sock = sock
        # Le chat passe par un flux (SSE) : on en ouvre un vrai, à travers Caddy, et on attend deux événements.
        conn.request("GET", "/api/health/stream", headers={"Host": host, "Accept": "text/event-stream"})
        resp = conn.getresponse()
        if resp.status != 200:
            return False
        events, read = 0, 0
        while events < 2:
            if time.monotonic() > deadline or read > 65536:
                return False
            line = resp.fp.readline(4096)
            if not line:
                return False
            read += len(line)
            events += line.startswith(b"data:")
        return True
    except Exception:  # noqa: BLE001
        return False


def healthy(name: str, seconds: int | None = None) -> bool:
    """Sain = répond 3 fois de suite (sur 10 s avec POLL à 5 s), sans redémarrer entre-temps."""
    url = _health_url(name)
    deadline = time.time() + (HEALTH if seconds is None else seconds)
    streak, restarts = 0, None
    while time.time() < deadline:
        c = _get(name)
        running = bool(c) and c.status == "running" and c.attrs["State"].get("Health", {}).get("Status") != "unhealthy"
        count = c.attrs.get("RestartCount", 0) if c else None
        if restarts is not None and count != restarts:
            streak = 0
        restarts = count
        streak = streak + 1 if running and (_answers(url) if url else True) else 0
        if streak >= 3:
            return True
        time.sleep(POLL)
    return False


def observe(names: list[str], seconds: int, caddy_before: bool = False) -> str | None:
    """Fenêtre de retour arrière : pendant `seconds`, chaque conteneur neuf tourne et ne redémarre pas ; à la fin il
    répond (et le serveur répond à travers Caddy). Rend le premier fautif, ou None."""
    start = {}
    for n in names:
        c = _get(n)
        start[n] = (c.id if c else None, c.attrs.get("RestartCount", 0) if c else None)
    deadline = time.time() + seconds
    while True:
        for n in names:
            c = _get(n)
            if not c or c.id != start[n][0] or c.status != "running" or c.attrs.get("RestartCount", 0) != start[n][1]:
                return n
        if time.time() >= deadline:
            break
        time.sleep(min(10, max(1, deadline - time.time())))
    for n in names:
        if not healthy(n, 30):  # 3 réponses de suite, pas un seul essai qui peut tomber au mauvais moment
            return n
    if caddy_before and (SERVER in names or CADDY in names):
        if not any(_through_caddy() or time.sleep(POLL) for _ in range(3)):
            return SERVER if SERVER in names else CADDY
    return None


# --- Gestes sur un conteneur -------------------------------------------------------------------------------------

class _nolock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# --- Jetons hors de la config Docker ------------------------------------------------------------------------------
# Une variable d'environnement se lit dans `docker inspect` et dans le Docker Manager de Hostinger : les jetons vont
# dans un fichier du conteneur (ou de son volume), écrit avant son démarrage.

def read_text(c, path: str) -> tuple[str, int, int] | None:
    """Contenu d'un fichier du conteneur (même arrêté), avec son propriétaire ; None s'il n'existe pas."""
    try:
        stream, _ = c.get_archive(path)
    except NotFound:
        return None
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
        member = tar.getmembers()[0]
        return tar.extractfile(member).read().decode(), member.uid, member.gid


def env_values(text: str | None) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in (text or "").splitlines() if "=" in line and not line.lstrip().startswith("#"))
    return {k.strip(): v.strip().strip("'\"") for k, v in pairs}


def put_env(c, path: str, values: dict[str, str], uid: int = 0, gid: int = 0) -> None:
    """Pose des clés dans un fichier KEY=valeur (mode 600) du conteneur, en gardant ses autres lignes."""
    for v in values.values():
        if not re.fullmatch(r"[\w.+/=-]*", v):
            raise ValueError("valeur de jeton inattendue")  # le fichier est lu par sh : rien qui s'interprète
    old = read_text(c, path)
    text, uid, gid = old if old else ("", uid, gid)
    lines = [l for l in text.splitlines() if l.split("=", 1)[0].strip() not in values]
    data = ("\n".join(lines + [f"{k}={v}" for k, v in values.items()]) + "\n").encode()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(os.path.basename(path))
        info.size, info.mode, info.uid, info.gid, info.mtime = len(data), 0o600, uid, gid, int(time.time())
        tar.addfile(info, io.BytesIO(data))
    c.put_archive(os.path.dirname(path), buf.getvalue())


# Conteneurs d'avant ce changement : le jeton passe de leur config au fichier quand ils sont recréés (mise à jour).
ENV_TO_FILE = {"noah.agent": ("/opt/data/.env", ("API_SERVER_KEY",))}


def _create_like(old, name: str, image: str) -> None:
    """Crée `name` (arrêté) comme `old` (déjà renommé), sur `image`, sans les valeurs par défaut de l'ancienne image."""
    attrs, cfg, hc = old.attrs, old.attrs["Config"], dict(old.attrs["HostConfig"])
    for label, (path, keys) in ENV_TO_FILE.items():
        env = env_values("\n".join(cfg.get("Env") or []))
        moved = {k: env[k] for k in keys if k in env}
        if label in (cfg.get("Labels") or {}) and moved:
            put_env(old, path, moved)  # dans le volume, que le nouveau conteneur reprend
            cfg = {**cfg, "Env": [e for e in cfg["Env"] if e.split("=", 1)[0] not in moved]}
    image_cfg = old.image.attrs.get("Config", {})
    networks = attrs["NetworkSettings"]["Networks"]
    mounted = [m.get("Destination", "") for m in attrs.get("Mounts", [])]
    stale = _get(name)
    if stale:
        stale.remove(force=True)  # reste d'une création coupée
    first, *others = list(networks.items()) or [(None, None)]
    networking = None
    if first[0]:
        networking = client.api.create_networking_config(
            {first[0]: client.api.create_endpoint_config(aliases=[a for a in (first[1].get("Aliases") or []) if a != old.id[:12]])})

    def own(values, defaults):
        base = set(defaults or [])
        return [v for v in values if v not in base] if values else values
    created = client.api.create_container(
        image=image, name=name, hostname=cfg.get("Hostname"),
        environment=own(cfg.get("Env"), image_cfg.get("Env")),
        command=None if cfg.get("Cmd") == image_cfg.get("Cmd") else cfg.get("Cmd"),
        entrypoint=None if cfg.get("Entrypoint") == image_cfg.get("Entrypoint") else cfg.get("Entrypoint"),
        working_dir=None if cfg.get("WorkingDir") == image_cfg.get("WorkingDir") else cfg.get("WorkingDir"),
        user=None if cfg.get("User") == image_cfg.get("User") else (cfg.get("User") or None),
        labels={k: v for k, v in (cfg.get("Labels") or {}).items() if (image_cfg.get("Labels") or {}).get(k) != v},
        ports=list((cfg.get("ExposedPorts") or {}).keys()),
        host_config=hc, networking_config=networking)
    new = client.containers.get(created["Id"])
    try:
        for net, endpoint in others:
            client.networks.get(net).connect(new, aliases=[a for a in (endpoint.get("Aliases") or []) if a != old.id[:12]])
        for path in COPIED_FILES.get(name, []):
            if any(path == m or path.startswith(m.rstrip("/") + "/") for m in mounted):
                continue  # monté depuis l'hôte : le montage suit déjà
            stream, _ = old.get_archive(path)
            new.put_archive(os.path.dirname(path), b"".join(stream))
        if name.startswith("noah-agent-"):  # droits des outils : hors du volume, écrits en root (voir launcher._seal_rights)
            with contextlib.suppress(NotFound):
                stream, _ = old.get_archive("/etc/noah")
                new.put_archive("/etc", b"".join(stream))
    except Exception:
        # Création à moitié faite : on retire ce conteneur-ci (par son identifiant), le nom redevient libre pour le
        # retour arrière de l'appelant.
        new.remove(force=True)
        raise


def replace(name: str, image: str, snapshot: str | None) -> bool:
    """Une étape à la fois, chacune écrite au journal avant d'être faite. Rend True si le neuf est sain."""
    comp = _component(name)
    with LOCKS.get(comp) or _nolock():
        c = client.containers.get(name)
        _item(name, etape="arret")
        _crash("arret")
        c.stop(timeout=30)  # arrêt propre ; l'instantané est pris à froid : rien n'est écrit pendant
        _crash("arrete")
        if snapshot:
            backup(volumes_of(name), snapshot)
        _item(name, etape="sauve")
        _crash("sauve")
        old = _get(f"{name}-ancien")
        if old:
            old.remove(force=True)
        c.rename(f"{name}-ancien")
        _item(name, etape="renomme")
        _crash("renomme")
        if comp in HOOKS:
            HOOKS[comp](name, image)  # crée et démarre (le navigateur reçoit ses fichiers avant de démarrer)
        else:
            _create_like(client.containers.get(f"{name}-ancien"), name, image)
            _item(name, etape="cree")
            _crash("cree")
            client.containers.get(name).start()
        _item(name, etape="demarre")
        _crash("demarre")
    ok = healthy(name)
    if ok:
        _item(name, etape="sain")
    return ok


def finish(name: str) -> None:
    old = _get(f"{name}-ancien")
    if old:
        old.remove(force=True)


def restore(name: str, start: bool = True) -> None:
    """Le neuf part, l'ancien reprend son nom (et redémarre)."""
    old = _get(f"{name}-ancien")
    if not old:
        c = _get(name)
        if c and start and c.status != "running":
            c.start()
        return
    new = _get(name)
    if new:
        new.remove(force=True)
    old.rename(name)
    if start:
        old.start()


def undo(item: dict) -> bool:
    """Ramène un conteneur à son état d'avant la transaction, d'après l'état réel de Docker (le journal peut être en
    retard d'un geste) :
    1. l'ancienne version reprend son nom, arrêtée (depuis <nom>-ancien, ou recréée sur l'image d'avant si elle a
       disparu) ;
    2. si un instantané complet existe, il est remis : il a été pris à froid juste avant tout changement, le remettre
       est toujours sûr ; s'il n'existe pas en entier, la nouvelle version n'a jamais tourné sur ces données ;
    3. l'ancienne version redémarre (si elle tournait avant), seulement si ses données sont revenues.
    Rend False si les données d'avant n'ont pas pu être remises : il reste arrêté (intervention)."""
    name, snap, before = item["nom"], item.get("sauvegarde"), item.get("image_avant")
    start = not item.get("etait_arrete")
    if item.get("restauration") == "impossible":
        return False  # en attente d'une décision (Réglages > Mises à jour) : on ne le démarre pas
    with LOCKS.get(_component(name)) or _nolock():
        old, main, spare = _get(f"{name}-ancien"), _get(name), _get(f"{name}-neuf")
        if spare is not None and main is None and old is None:
            # Coupure pendant la recréation de l'ancienne version : on la reprend depuis le neuf mis de côté.
            _create_like(spare, name, before)
            main = client.containers.get(name)
        if spare is not None and main is not None:
            spare.remove(force=True)
        untouched = (item.get("etape") is None and old is None and main is not None
                     and (not before or main.image.id == before))
        if untouched:
            # Jamais touché (après le canari dans l'ordre) : pas d'arrêt, pas de restauration, pas de coupure.
            if start and main.status != "running":
                main.start()
            return True
        if old is not None:
            if main is not None:
                main.stop(timeout=20)  # la version fautive n'écrit plus pendant la restauration
                main.remove(force=True)
            old.rename(name)
            main = old
        elif main is not None and before and main.image.id != before:
            # L'ancien conteneur a disparu (journal en retard) : on recrée l'ancienne version, même configuration.
            main.stop(timeout=20)
            main.rename(f"{name}-neuf")
            _crash("neuf-renomme")
            _create_like(main, name, before)
            main.remove(force=True)
            main = client.containers.get(name)
        if main is None:
            _log(f"{name} : introuvable pendant le retour arrière")
            return False
        if main.status == "running" and (snap and item.get("restauration") != "faite"):
            main.stop(timeout=20)
        if snap and item.get("restauration") != "faite":
            _item(name, restauration="en_cours")  # coupé ici : la reprise refait la restauration (idempotente)
            _crash("restauration")
            try:
                unpack(snap, volumes_of(name))
                _item(name, restauration="faite")
            except NoSnapshot:
                if item.get("etape") in (None, "arret"):
                    _item(name, restauration="faite")  # instantané jamais terminé : la nouvelle version n'a pas tourné
                else:
                    # L'instantané devait exister (étape franchie) et il manque : on ne sait pas ce qu'il y a dedans.
                    _item(name, restauration="impossible")
                    _log(f"{name} : instantané attendu mais introuvable ({snap}). Il reste arrêté.")
                    return False
            except Exception as e:  # noqa: BLE001
                _item(name, restauration="impossible")
                _log(f"{name} : données d'avant impossibles à remettre ({str(e)[:160]}). Il reste arrêté ; "
                     f"sauvegarde : {snap}")
                return False
        main.reload()  # statut réel : il vient peut-être d'être arrêté pour la restauration
        if start and main.status != "running":
            main.start()
    return healthy(name) if start else True


def _undo_all(items: list[dict]) -> list[str]:
    """Retour arrière de toute la transaction, en ordre inverse. Rend les conteneurs qui n'ont pas pu revenir."""
    left = []
    for item in reversed(items):
        try:
            if not undo(item):
                left.append(item["nom"])
        except Exception as e:  # noqa: BLE001
            print(f"[mise à jour] retour arrière de {item['nom']} : {str(e)[:200]}", flush=True)
            left.append(item["nom"])
    return left


def _commit(tx: dict) -> None:
    """Validation : épinglage, puis retrait des anciens conteneurs. Écrite au journal avant : une coupure ici se
    termine au démarrage suivant, sans retour en arrière."""
    _tx(lambda t: t.update(phase="validation"))
    for item in tx["elements"]:
        if item.get("etait_arrete"):
            _recreate_stopped(item, tx["cibles"][item["composant"]])
    _crash("validation")
    for item in tx["elements"]:
        finish(item["nom"])
    if tx.get("lanceur"):
        finish(LAUNCHER)
    pins = {c: r for c, r in tx["cibles"].items() if c in ("hermes", "navigateur")}

    def close(s):
        s.setdefault("images", {}).update(pins)
        s.setdefault("acceptes", {})[tx["version"]] = tx.get("empreinte")
        if _semver(tx["version"]) > _semver(s.get("version_max", "")):
            s["version_max"] = tx["version"]
        s["en_cours"] = None
    update_state(close)
    for comp in {i["composant"] for i in tx["elements"]}:
        if comp in AFTER:
            threading.Thread(target=AFTER[comp], daemon=True).start()


def _commit_retry(tx: dict, tries: int = 3) -> None:
    for attempt in range(tries):
        try:
            _commit(load_state()["en_cours"] or tx)
            return
        except Exception:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            time.sleep(10 * (attempt + 1))


def _recreate_stopped(item: dict, image: str) -> None:
    """Conteneur arrêté par l'utilisateur : recréé sur la nouvelle image et laissé arrêté. Rejouable : se repère à
    l'état réel (nom principal, <nom>-ancien) après une coupure entre les deux gestes."""
    name, comp = item["nom"], item["composant"]
    with LOCKS.get(comp) or _nolock():
        main, old = _get(name), _get(f"{name}-ancien")
        if main is not None and _runs(name, image):
            if item.get("recree") or old is None:
                return  # déjà fait (finish retirera l'ancien)
            main.remove(force=True)  # créé mais peut-être pas configuré (coupure) : on recommence
            main = None
        if main is not None:
            if old is not None:
                old.remove(force=True)
            main.rename(f"{name}-ancien")
            _crash("arrete-renomme")
        if comp in HOOKS:
            HOOKS[comp](name, image, False)  # le navigateur reçoit ses fichiers, sans démarrer
        else:
            _create_like(client.containers.get(f"{name}-ancien"), name, image)
        _item(name, recree=True)


def _fail(tx: dict, why: str, bad_ref: str | None) -> dict:
    """Échec : tout revient. Le journal ne se ferme que si tout est revenu ; sinon il reste ouvert (intervention).
    Rejouable : relancé par la reprise si une coupure tombe au milieu."""
    _tx(lambda t: t.update(phase="retour_arriere", raison=why))
    if tx.get("lanceur") and IS_RELAY and _get(LAUNCHER) and _runs(LAUNCHER, tx["lanceur"]):
        _get(LAUNCHER).stop(timeout=20)  # relais : le lanceur neuf ne touche plus à rien pendant le retour arrière
    left = _undo_all(load_state()["en_cours"]["elements"])
    if tx.get("lanceur"):
        try:
            restore(LAUNCHER)
        except Exception:  # noqa: BLE001
            left.append(LAUNCHER)

    def close(s):
        if bad_ref:
            s.setdefault("bloquees", []).append({"image": bad_ref, "version": tx["version"],
                                                 "composant": next((c for c, r in tx["cibles"].items() if r == bad_ref), "?")})
        else:  # pas la faute de l'image : compté, pour ne pas réessayer toutes les 5 minutes
            tries = s.setdefault("essais", {})
            tries[tx["version"]] = tries.get(tx["version"], 0) + 1
        if left:
            s["en_cours"]["phase"] = "intervention"
            s["en_cours"]["non_restaures"] = left
        else:
            s["en_cours"] = None
    update_state(close)
    drop_backup(tx["sauvegardes"], keep=bool(left))
    text = f"Noah {tx['version']} : {why}. " + (
        f"Retour arrière incomplet, à vérifier : {', '.join(left)} (arrêtés, sauvegardes dans {tx['sauvegardes']})."
        if left else "Retour à la version précédente, avec ses données.")
    _log(text)
    return {"ok": False, "version": tx["version"], "erreur": why, "composants": {"retour_arriere": True},
            "non_restaures": left}


# --- Transaction ------------------------------------------------------------------------------------------------

def _blocked(state: dict, version: str, ref: str) -> bool:
    return any(b.get("image") == ref and b.get("version") == version for b in state.get("bloquees", []))


def _report(report: dict) -> None:
    report["fin"] = int(time.time())
    update_state(lambda s: s.update(dernier_rapport=report))


def apply(raw: bytes, signature: str, wanted: list[str] | None = None, retry_blocked: bool = False) -> dict:
    """Installe les composants `wanted` (tous par défaut) du manifeste signé. Rend le rapport, aussi enregistré."""
    report = {"ok": False, "debut": int(time.time()), "composants": {}}
    if _lock.locked():
        return {"ok": False, "erreur": "Une mise à jour est déjà en cours"}
    with state_lock():
        try:
            state = load_state()
        except Corrupt as e:
            return {"ok": False, "erreur": str(e)}
        if state.get("en_cours"):
            report["erreur"] = "Une mise à jour précédente n'est pas terminée" + (
                " : elle attend ta décision" if state["en_cours"].get("phase") == "intervention" else "")
            _report(report)
            return report
        try:
            manifest = verify_manifest(raw, signature)
        except ValueError as e:
            report["erreur"] = f"Manifeste refusé : {e}"
            _log(report["erreur"])
            _report(report)
            return report
        version = manifest["version"]
        report["version"] = version
        digest = hashlib.sha256(raw).hexdigest()
        seen = state.get("acceptes", {}).get(version)
        if seen and seen != digest:
            report["erreur"] = f"Manifeste refusé : un autre contenu a déjà été accepté pour la version {version}"
            _log(report["erreur"])
            _report(report)
            return report
        floor = max(_semver(state.get("version_max", "")), _semver(BUILT_VERSION))
        if _semver(version) < floor:
            report["erreur"] = f"Manifeste refusé : {version} est plus ancienne que {'.'.join(map(str, floor))}, déjà installée"
            _log(report["erreur"])
            _report(report)
            return report
        targets = {c: r for c, r in manifest["images"].items() if wanted is None or c in wanted}
        if retry_blocked:
            update_state(lambda s: (s.update(bloquees=[b for b in s.get("bloquees", []) if b.get("image") not in targets.values()]),
                                    s.setdefault("essais", {}).pop(version, None)))
        elif state.get("essais", {}).get(version, 0) >= MAX_TRIES:
            report["erreur"] = f"{MAX_TRIES} essais sans succès pour cette version : elle attend la suivante, ou un clic"
            _report(report)
            return report
        else:
            for comp, ref in list(targets.items()):
                if _blocked(state, version, ref):
                    report["composants"][comp] = "bloquee"
                    del targets[comp]
        if not targets:
            report["erreur"] = "Cette version a déjà échoué ici : elle attend la suivante, ou un clic pour réessayer"
            _report(report)
            return report
        missing = pull(list(targets.values()))["echecs"]
        if missing:  # registre en panne, limite de Docker Hub… : rien ne commence, rien n'est bloqué
            report["erreur"] = "Téléchargement impossible, rien n'a changé : " + missing[0]["erreur"][:200]
            _log(report["erreur"])
            _report(report)
            return report
        names = components()
        try:  # place pour l'instantané ET pour la restauration (extraite à côté des données) : sinon rien ne commence
            vols = sorted({v for comp in targets for n in names.get(comp, []) for v in volumes_of(n)})
            room = space(vols) if vols else {"volumes": 0, "libre": 1 << 62}
        except (ToolFailed, ValueError) as e:
            room = {"volumes": 0, "libre": 1 << 62}
            print(f"[mise à jour] place disque inconnue : {e}", flush=True)
        need = 2 * room["volumes"] + SPACE_MARGIN
        if room["libre"] < need:
            report["erreur"] = (f"Place disque insuffisante, rien n'a changé : il faut {need / 1e9:.1f} Go, "
                                f"{room['libre'] / 1e9:.1f} Go libres")
            _log(report["erreur"])
            _report(report)
            return report
        caddy_before = _through_caddy() if ("caddy" in targets or "noah-server" in targets) else False
        folder = f"/backups/maj-{time.strftime('%Y%m%d-%H%M%S')}"
        items = []
        kept = set(state.get("gardes", []))  # mis de côté par l'utilisateur après une intervention : on n'y touche pas
        for comp in [c for c in ORDER if c in targets]:
            for name in names.get(comp, []):
                if name not in kept and not _runs(name, targets[comp]):
                    items.append({"nom": name, "composant": comp, "etape": None,
                                  "sauvegarde": f"{folder}/{name}" if volumes_of(name) else None,
                                  "etait_arrete": _stopped_on_purpose(name),
                                  "image_avant": client.containers.get(name).image.id})
        launcher_ref = targets.get("noah-launcher") if not _runs(LAUNCHER, targets.get("noah-launcher", "")) else None
        tx = {"version": version, "depuis": int(time.time()), "phase": "remplacement", "cibles": targets,
              "sauvegardes": folder, "elements": items, "lanceur": launcher_ref, "caddy_avant": caddy_before,
              "empreinte": digest}
        update_state(lambda s: s.update(en_cours=tx))
        try:
            for item in items:
                if item["etait_arrete"]:
                    continue  # recréé à la validation, sans le démarrer
                try:
                    ok = replace(item["nom"], targets[item["composant"]], item["sauvegarde"])
                except BackupFailed as e:  # instantané impossible (disque plein…) : rien de bloqué, tout revient
                    tx = load_state()["en_cours"]
                    rep = _fail(tx, f"sauvegarde de {item['nom']} impossible ({str(e)[:160]})", None)
                    _report(rep)
                    return rep
                except Exception as e:  # noqa: BLE001 - image qui ne démarre pas, fichier absent…
                    print(f"[mise à jour] {item['nom']} : {str(e)[:300]}", flush=True)
                    ok = False
                if not ok:
                    rep = _fail(load_state()["en_cours"], f"{item['nom']} ne répondait plus sur la nouvelle version",
                                targets[item["composant"]])
                    _report(rep)
                    return rep
            _tx(lambda t: t.update(phase="observation"))
            _crash("observation")
            bad = observe([i["nom"] for i in items if not i["etait_arrete"]], OBSERVE, caddy_before)
            if bad:
                comp = _component(bad) or next((i["composant"] for i in items if i["nom"] == bad), None)
                rep = _fail(load_state()["en_cours"], f"{bad} est tombé pendant la période d'observation",
                            targets.get(comp))
                _report(rep)
                return rep
            if launcher_ref:
                _tx(lambda t: t.update(phase="lanceur", lanceur_depuis=int(time.time())))
                _start_relay(launcher_ref)
                report.update(ok=True, composants={c: "fait" for c in targets if c != "noah-launcher"} | {"noah-launcher": "en_cours"})
                _report(report)
                return report
        except Exception as e:  # noqa: BLE001 - imprévu avant la validation : on revient en arrière tout de suite
            print(f"[mise à jour] erreur imprévue : {e}", flush=True)
            rep = _fail(load_state()["en_cours"], f"erreur imprévue ({str(e)[:160]})", None)
            _report(rep)
            return rep
        # Point de non-retour : à partir d'ici, une erreur laisse la validation ouverte ; elle est réessayée (chaque
        # geste est rejouable), ici puis par la surveillance.
        try:
            _commit_retry(load_state()["en_cours"])
        except Exception as e:  # noqa: BLE001
            _log(f"Validation de {version} interrompue ({str(e)[:160]}) : elle sera terminée au prochain démarrage")
            report.update(ok=False, erreur="validation à terminer au prochain démarrage du lanceur", validation="a_terminer")
            _report(report)
            return report
        report.update(ok=True, composants={c: "fait" for c in targets})
        _log(f"Noah {version} installée")
        _report(report)
        return report


def _stopped_on_purpose(name: str) -> bool:
    """Arrêté (par l'utilisateur ou par Noah), pas en train de redémarrer après un plantage passager."""
    c = client.containers.get(name)
    return c.status in ("exited", "created") and not c.attrs["State"].get("Restarting")


def _start_relay(image: str) -> None:
    """Le lanceur ne peut pas se remplacer pendant qu'il tourne : un relais, lancé depuis la nouvelle image, le fait
    et décide pour toute la transaction. Il redémarre seul après une coupure (always) et se désactive à la fin."""
    me = client.containers.get(LAUNCHER)
    state_volume = next((m["Name"] for m in me.attrs.get("Mounts", []) if m.get("Destination") == str(STATE.parent)), None)
    network = next(iter(me.attrs["NetworkSettings"]["Networks"]), "noah-net")
    old = _get(RELAY)
    if old:
        old.remove(force=True)
    volumes = {"/var/run/docker.sock": {"bind": "/var/run/docker.sock", "mode": "rw"}}
    if state_volume:
        volumes[state_volume] = {"bind": "/state", "mode": "rw"}
    env = {k: os.environ[k] for k in ("NOAH_UPDATE_OBSERVE", "NOAH_UPDATE_HEALTH", "NOAH_UPDATE_POLL", "NOAH_UPDATE_CADDY_DEADLINE", "NOAH_BACKUP_VOLUME", "NOAH_TEST_CRASH_RELAY")
           if k in os.environ}
    env.update(NOAH_UPDATE_STATE="/state/updates.json", NOAH_LAUNCHER_NAME=LAUNCHER, NOAH_RELAY_NAME=RELAY, NOAH_IS_RELAY="1")
    if os.environ.get("NOAH_TEST_CRASH_RELAY"):
        env["NOAH_TEST_CRASH_AT"] = os.environ["NOAH_TEST_CRASH_RELAY"]
    # Lancé depuis l'image du lanceur actuel, qui a mené la transaction : si la nouvelle version est cassée, c'est un
    # code éprouvé qui fait le retour arrière. La nouvelle image n'est qu'un paramètre (tx["lanceur"]).
    client.containers.run(me.image.id, ["python", "updater.py", "relay"], volumes=volumes, network=network, detach=True,
                          name=RELAY, environment=env, restart_policy={"Name": "always"}, working_dir="/app")


def _relay() -> None:
    """Relais : remplace le lanceur, l'observe, puis valide ou annule toute la transaction. Rejouable : après une
    coupure, il repart de l'état réel (le lanceur neuf existe-t-il ? répond-il ?)."""
    with state_lock():
        tx = load_state().get("en_cours")
        if tx and tx.get("phase") == "validation":
            pass  # le lanceur neuf valide
        elif tx and tx.get("phase") in ("retour_arriere", "remplacement", "observation"):
            _report(_fail(tx, tx.get("raison") or "interrompue", None))  # retour arrière coupé : on le termine
        elif tx and tx.get("phase") == "lanceur":
            image = tx["lanceur"]
            ok = False
            try:
                if _get(f"{LAUNCHER}-ancien") is None:
                    c = client.containers.get(LAUNCHER)
                    c.stop(timeout=30)
                    _crash("relais-arrete")
                    c.rename(f"{LAUNCHER}-ancien")
                    _crash("relais-renomme")
                if _get(LAUNCHER) is None or not _runs(LAUNCHER, image):
                    _create_like(client.containers.get(f"{LAUNCHER}-ancien"), LAUNCHER, image)
                    _crash("relais-cree")
                if client.containers.get(LAUNCHER).status != "running":
                    client.containers.get(LAUNCHER).start()
                _crash("relais-demarre")
                fleet = [LAUNCHER] + [i["nom"] for i in tx["elements"] if not i.get("etait_arrete")]
                ok = healthy(LAUNCHER) and observe(fleet, min(OBSERVE, 120), tx.get("caddy_avant", False)) is None
            except Exception as e:  # noqa: BLE001
                print(f"[mise à jour] relais : {str(e)[:300]}", flush=True)
            if ok:
                # Le lanceur neuf (avec ses crochets : navigateurs arrêtés…) fait la validation dès qu'il a la main.
                _tx(lambda t: t.update(phase="validation"))
                _log(f"Lanceur {tx['version']} sain : validation confiée au nouveau lanceur")
            else:
                _report(_fail(tx, "le nouveau lanceur ne répondait pas", image))
    tx = load_state().get("en_cours")
    if tx and tx.get("phase") not in ("intervention", "validation"):
        raise SystemExit(1)  # pas fini : Docker relance le relais, qui reprendra où il en était
    me = _get(socket.gethostname())
    if me:
        me.update(restart_policy={"Name": "no"})  # fini : ne plus redémarrer


def recover() -> None:
    """Au démarrage du lanceur. Rapproche le journal de l'état réel : une transaction coupée revient en arrière en
    entier, une validation coupée se termine ; le relais garde la main tant qu'il tourne."""
    with state_lock():
        for c in client.containers.list(all=True, filters={"label": f"noah.outil={LAUNCHER}"}):
            c.remove(force=True)  # sauvegarde ou restauration orpheline : on la refait proprement
        try:
            state = load_state()
        except Corrupt as e:
            print(f"[mise à jour] {e} : rien n'est fait, à vérifier à la main", flush=True)
            return
        tx = state.get("en_cours")
        if not tx or tx.get("phase") == "intervention":
            return
        if tx.get("phase") == "lanceur":
            relay = _get(RELAY)
            late = time.time() - tx.get("lanceur_depuis", time.time()) > RELAY_TIMEOUT
            if relay and relay.status in ("running", "restarting", "created") and not late:
                return  # le relais décide
            if relay and late:
                relay.remove(force=True)  # relais en panne depuis trop longtemps : on reprend la main
            if _runs(LAUNCHER, tx["lanceur"]) and healthy(LAUNCHER, 60):
                tx["phase"] = "validation"  # nous sommes le lanceur neuf, et nous répondons : le relais a été coupé
                _tx(lambda t: t.update(phase="validation"))
            else:
                _report(_fail(tx, "le relais du lanceur a été interrompu", None))
                return
        if tx.get("phase") == "validation":
            _commit(tx)
            _log(f"Noah {tx['version']} installée")
            _report({"ok": True, "version": tx["version"], "composants": {c: "fait" for c in tx["cibles"]}})
            return
        _report(_fail(tx, tx.get("raison") or "interrompue (arrêt du lanceur)", None))


def verify_logged(raw: bytes, signature: str) -> dict:
    try:
        return verify_manifest(raw, signature)
    except ValueError as e:
        _log(f"Manifeste refusé : {e}")
        raise


def refusal() -> str | None:
    """Pourquoi /update/apply ne lancerait rien maintenant (réponse immédiate au serveur), ou None."""
    if _lock.locked():
        return "Une mise à jour est déjà en cours"
    try:
        tx = load_state().get("en_cours")
    except Corrupt as e:
        return str(e)
    if tx:
        return "Une mise à jour précédente n'est pas terminée" + (" : elle attend ta décision" if tx.get("phase") == "intervention" else "")
    return None


def watchdog() -> None:
    """Toutes les 5 minutes : un relais en panne depuis trop longtemps ne bloque pas Noah pour toujours."""
    while True:
        time.sleep(WATCHDOG)
        try:
            tx = load_state().get("en_cours")
            if tx and tx.get("phase") == "validation" and not (_get(RELAY) and _get(RELAY).status == "running"):
                recover()  # validation interrompue par une erreur : rejouable, on la termine
                continue
            if tx and tx.get("phase") == "lanceur" and time.time() - tx.get("lanceur_depuis", time.time()) > RELAY_TIMEOUT:
                relay = _get(RELAY)
                if relay:
                    relay.remove(force=True)  # hors du verrou : un relais bloqué le garde, on le libère d'abord
                recover()
        except Exception as e:  # noqa: BLE001
            print(f"[mise à jour] surveillance : {e}", flush=True)


def resolve(action: str) -> dict:
    """Sortie de l'état « intervention », sur décision de l'utilisateur. « reessayer » : refaire la restauration des
    données d'avant ; « garder » : laisser ces conteneurs arrêtés tels quels, fermer le journal (il s'en occupe)."""
    with state_lock():
        tx = load_state().get("en_cours")
        if action == "liberer":
            tx = {"phase": "intervention"}
        if not tx or tx.get("phase") != "intervention":
            return {"ok": False, "erreur": "Rien en attente"}
        if action == "reessayer":
            update_state(lambda s: [it.pop("restauration", None) for it in s["en_cours"]["elements"]
                                    if it["nom"] in s["en_cours"].get("non_restaures", [])])
            rep = _fail(load_state()["en_cours"], tx.get("raison") or "retour arrière repris", None)
            _report(rep)
            return rep
        if action == "garder":
            kept = tx.get("non_restaures", [])
            update_state(lambda s: (s.update(en_cours=None), s.update(gardes=sorted(set(s.get("gardes", [])) | set(kept)))))
            _log(f"Journal de {tx['version']} fermé à la main ; restés arrêtés : {', '.join(tx.get('non_restaures', []))}")
            return {"ok": True}
        if action == "liberer":
            update_state(lambda s: s.update(gardes=[]))
            _log("Conteneurs mis de côté rendus à Noah")
            return {"ok": True}
        return {"ok": False, "erreur": "Action inconnue"}


if __name__ == "__main__" and sys.argv[1:2] == ["relay"]:
    _relay()
elif __name__ == "__main__" and sys.argv[1:2] in (["snapshot"], ["unpack"]):
    (_snapshot if sys.argv[1] == "snapshot" else _unpack)(sys.argv[2], sys.argv[3:])
elif __name__ == "__main__" and sys.argv[1:2] == ["espace"]:
    total = sum(os.lstat(os.path.join(r, f)).st_size for i in range(len(sys.argv[3:]))
                for r, _, fs_ in os.walk(f"/v{i}") for f in fs_)
    st = os.statvfs(sys.argv[2])
    print(json.dumps({"volumes": total, "libre": st.f_bavail * st.f_frsize}))
elif __name__ == "__main__" and sys.argv[1:2] == ["supprime"]:
    shutil.rmtree(sys.argv[2], ignore_errors=True)
elif __name__ == "__main__" and sys.argv[1:2] == ["garde"]:
    if os.path.isdir(sys.argv[2]):
        Path(sys.argv[2], ".garder").write_text("intervention")
