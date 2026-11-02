"""Mises à jour des conteneurs de Noah Agent, faites par le lanceur (seul service qui parle à Docker).

Le serveur décide quoi et quand (manifeste signé, créneau calme, rien en cours) ; ici, on exécute, prudemment :
1. images téléchargées à l'avance, par empreinte (jamais une étiquette qui bouge) ;
2. sauvegarde des volumes concernés : si elle échoue (disque plein…), rien ne change ;
3. chaque conteneur est recréé avec sa configuration, sur la nouvelle image ; l'ancien est gardé à côté ;
4. contrôle de santé ; en cas d'échec, l'ancien conteneur revient, et l'empreinte fautive est bloquée.
Ordre : un agent d'abord (canari), puis les autres, les navigateurs, Caddy, le serveur, et le lanceur en dernier, par
un conteneur auxiliaire (il ne peut pas se remplacer lui-même pendant qu'il tourne). Même mécanique que What's Up
Docker (préchargement, sauvegarde bloquante, retour arrière) et que l'étape « helper » de Coolify.
"""
import io
import json
import os
import socket
import sys
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

try:
    import docker
    from docker.errors import APIError, NotFound
except ImportError:  # conteneur jetable des sauvegardes : pas besoin de Docker
    docker = None

client = docker.from_env() if docker and not os.environ.get("NOAH_TOOL") else None
STATE = Path(os.environ.get("NOAH_UPDATE_STATE", "/state/updates.json"))
BACKUP_VOLUME = os.environ.get("NOAH_BACKUP_VOLUME", "apollo_noah-backups")
_lock = threading.Lock()
# Recréations particulières, fournies par le lanceur : composant -> fonction(nom, image) -> bool.
HOOKS: dict = {}

# Composant -> conteneurs qu'il fait tourner, et comment savoir qu'ils vont bien.
SERVER, LAUNCHER, CADDY = "apollo-server", "apollo-launcher", "apollo-caddy"
COPIED_FILES = {CADDY: ["/etc/caddy/Caddyfile"]}


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (FileNotFoundError, ValueError):
        return {"images": {}, "historique": [], "bloquees": [], "en_cours": None}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    os.replace(tmp, STATE)


def pinned(component: str, default: str) -> str:
    """Image à utiliser pour un composant que le lanceur crée lui-même (agents, navigateurs)."""
    return load_state().get("images", {}).get(component) or default


def _log(state: dict, text: str) -> None:
    state["historique"] = (state.get("historique", []) + [{"quand": int(time.time()), "texte": text}])[-100:]
    save_state(state)


# --- Ce qui tourne ----------------------------------------------------------------------------------------

def components() -> dict[str, list[str]]:
    """Nom du composant -> conteneurs (dans l'ordre où les mettre à jour)."""
    agents = sorted(c.name for c in client.containers.list(all=True, filters={"label": "apollo.agent"}))
    browsers = sorted(c.name for c in client.containers.list(all=True, filters={"label": "apollo.browser"}))
    out = {"hermes": agents, "navigateur": browsers}
    for name, comp in ((CADDY, "caddy"), (SERVER, "noah-server"), (LAUNCHER, "noah-launcher")):
        try:
            client.containers.get(name)
            out[comp] = [name]
        except NotFound:
            pass
    return out


def current() -> dict[str, dict]:
    """Empreinte de l'image en service pour chaque composant (la première trouvée)."""
    out = {}
    for comp, names in components().items():
        for name in names:
            try:
                img = client.containers.get(name).image
            except NotFound:
                continue
            digests = img.attrs.get("RepoDigests") or []
            out[comp] = {"image_id": img.id, "digests": digests, "conteneurs": len(names)}
            break
    return out


# --- Préchargement et sauvegarde ---------------------------------------------------------------------------

def pull(refs: list[str]) -> dict:
    """Télécharge les images à l'avance : au moment de la mise à jour, la coupure ne dure que la recréation."""
    done, failed = [], []
    for ref in refs:
        try:
            repo, digest = ref.split("@", 1) if "@" in ref else (ref, None)
            client.images.pull(repo, tag=digest) if digest else client.images.pull(ref)
            done.append(ref)
        except APIError as e:
            failed.append({"image": ref, "erreur": str(e)[:300]})
    return {"telechargees": done, "echecs": failed}


def _tool_image() -> str:
    """Image du lanceur lui-même (Python, sqlite3) : sert aux sauvegardes et restaurations, sans rien télécharger."""
    for ref in (socket.gethostname(), LAUNCHER):
        try:
            return client.containers.get(ref).image.id
        except NotFound:
            continue
    return "python:3.12-slim"


def _tool(args: list[str], volumes: list[str], folder_rw: bool = True) -> None:
    """Lance ce fichier (<args> + volumes) dans un conteneur jetable qui voit les volumes en /v0, /v1… et les
    sauvegardes en /backups. Lève une erreur si le conteneur échoue."""
    mounts = {BACKUP_VOLUME: {"bind": "/backups", "mode": "rw" if folder_rw else "ro"}}
    for i, v in enumerate(volumes):
        mounts[v] = {"bind": f"/v{i}", "mode": "rw"}
    box = client.containers.create(_tool_image(), ["python", "/tmp/updater.py", *args, *volumes], volumes=mounts,
                                   entrypoint=[], working_dir="/tmp", environment={"NOAH_TOOL": "1"})
    try:
        data = Path(__file__).read_bytes()
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            info = tarfile.TarInfo("updater.py")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        box.put_archive("/tmp", buf.getvalue())
        box.start()
        code = box.wait(timeout=1800)["StatusCode"]
        if code != 0:
            raise RuntimeError(box.logs(tail=20).decode(errors="replace").strip() or f"code {code}")
    finally:
        box.remove(force=True)


def backup(volumes: list[str], label: str) -> str:
    """Instantané des volumes, bases SQLite comprises (copie cohérente par l'API backup, vérifiée par integrity_check).
    Lève une erreur au moindre problème (disque plein…) : la mise à jour n'a alors pas lieu."""
    folder = f"/backups/{label}-{time.strftime('%Y%m%d-%H%M%S')}"
    _tool(["snapshot", folder], volumes)
    return folder


def unpack(folder: str, volumes: list[str]) -> None:
    """Remet les volumes dans l'état de l'instantané (retour arrière : la nouvelle version a pu migrer les données)."""
    _tool(["unpack", folder], volumes, folder_rw=False)


def _snapshot(folder: str, volumes: list[str]) -> None:
    """(Dans le conteneur jetable.) /v<i> -> <folder>/<volume>.tar.gz ; les bases SQLite sont copiées à chaud
    proprement, puis vérifiées."""
    import shutil
    import sqlite3
    os.makedirs(folder, exist_ok=True)
    for i, name in enumerate(volumes):
        src, stage = Path(f"/v{i}"), Path(f"/tmp/stage/{name}")
        shutil.copytree(src, stage, symlinks=True, ignore=shutil.ignore_patterns("*-wal", "*-shm", "*-journal"))
        for path in src.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            with open(path, "rb") as fh:
                if fh.read(16) != b"SQLite format 3\x00":
                    continue
            copy = stage / path.relative_to(src)
            copy.unlink(missing_ok=True)
            live, out = sqlite3.connect(path), sqlite3.connect(copy)
            try:
                live.backup(out)
                if out.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise SystemExit(f"base abîmée : {name}/{path.relative_to(src)}")
            finally:
                live.close()
                out.close()
        with tarfile.open(f"{folder}/{name}.tar.gz.part", "w:gz") as tar:
            tar.add(stage, arcname=".")
        os.replace(f"{folder}/{name}.tar.gz.part", f"{folder}/{name}.tar.gz")
        shutil.rmtree(stage)
    # Ne garder que les 5 dernières sauvegardes d'avant mise à jour.
    for old in sorted(Path("/backups").glob("maj-*"), key=lambda p: p.stat().st_mtime, reverse=True)[5:]:
        shutil.rmtree(old, ignore_errors=True)


def _unpack(folder: str, volumes: list[str]) -> None:
    import shutil
    for i, name in enumerate(volumes):
        archive, dest = Path(f"{folder}/{name}.tar.gz"), Path(f"/v{i}")
        if not archive.exists():
            continue
        for child in dest.iterdir():
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
        with tarfile.open(archive) as tar:
            tar.extractall(dest, filter="tar")


def volumes_of(name: str) -> list[str]:
    try:
        mounts = client.containers.get(name).attrs.get("Mounts", [])
    except NotFound:
        return []
    return [m["Name"] for m in mounts if m.get("Type") == "volume" and m.get("Name") != BACKUP_VOLUME]


# --- Recréer un conteneur sur une nouvelle image -------------------------------------------------------------

def _without_image_defaults(values: list | None, image_values: list | None) -> list | None:
    """Garde ce qui a été réglé pour ce conteneur, pas les valeurs par défaut de l'ancienne image (la nouvelle a les
    siennes, par exemple un autre PATH)."""
    if not values:
        return values
    base = set(image_values or [])
    return [v for v in values if v not in base]


def _health_url(name: str) -> str | None:
    if name == SERVER:
        return "http://apollo-server:8080/api/status"
    if name == LAUNCHER:
        return "http://apollo-launcher:9000/health"
    if name.startswith("apollo-agent-"):
        return f"http://{name}:8642/health"
    if name.startswith("apollo-browser-"):
        return f"http://{name}:9377/health"
    return None  # Caddy : il suffit qu'il tourne


def healthy(name: str, seconds: int = 120) -> bool:
    url = _health_url(name)
    deadline = time.time() + seconds
    stable_since = None
    while time.time() < deadline:
        try:
            c = client.containers.get(name)
            running = c.status == "running"
        except NotFound:
            running = False
        if running and url:
            try:
                with urllib.request.urlopen(url, timeout=5) as r:
                    if r.status == 200:
                        return True
            except Exception:  # noqa: BLE001 - pas encore prêt
                pass
        elif running:
            stable_since = stable_since or time.time()
            if time.time() - stable_since > 10:
                return True
        else:
            stable_since = None
        time.sleep(3)
    return False


def recreate(name: str, image: str) -> None:
    """Remplace le conteneur `name` par le même, sur `image`. L'ancien reste sous le nom <name>-ancien jusqu'à
    `finish` (succès) ou `restore` (échec)."""
    old = client.containers.get(name)
    attrs, cfg, hc = old.attrs, old.attrs["Config"], dict(old.attrs["HostConfig"])
    image_cfg = old.image.attrs.get("Config", {})
    networks = attrs["NetworkSettings"]["Networks"]
    for stale in (f"{name}-ancien",):
        try:
            client.containers.get(stale).remove(force=True)
        except NotFound:
            pass
    old.stop(timeout=30)
    old.rename(f"{name}-ancien")
    first, *others = list(networks.items()) or [(None, None)]
    networking = None
    if first[0]:
        networking = client.api.create_networking_config(
            {first[0]: client.api.create_endpoint_config(aliases=[a for a in (first[1].get("Aliases") or []) if a != old.id[:12]])})
    created = client.api.create_container(
        image=image,
        name=name,
        hostname=cfg.get("Hostname"),
        environment=_without_image_defaults(cfg.get("Env"), image_cfg.get("Env")),
        command=None if cfg.get("Cmd") == image_cfg.get("Cmd") else cfg.get("Cmd"),
        entrypoint=None if cfg.get("Entrypoint") == image_cfg.get("Entrypoint") else cfg.get("Entrypoint"),
        working_dir=None if cfg.get("WorkingDir") == image_cfg.get("WorkingDir") else cfg.get("WorkingDir"),
        user=cfg.get("User") or None,
        labels={k: v for k, v in (cfg.get("Labels") or {}).items() if (image_cfg.get("Labels") or {}).get(k) != v},
        ports=list((cfg.get("ExposedPorts") or {}).keys()),
        host_config=hc,
        networking_config=networking,
    )
    new = client.containers.get(created["Id"])
    for net, endpoint in others:
        client.networks.get(net).connect(new, aliases=[a for a in (endpoint.get("Aliases") or []) if a != old.id[:12]])
    # Fichiers que Docker Compose a copiés dans le conteneur à sa création (configs: content, le Caddyfile) : ils ne
    # font pas partie de la configuration, une recréation les perdrait.
    for path in COPIED_FILES.get(name, []):
        stream, _ = old.get_archive(path)
        new.put_archive(os.path.dirname(path), b"".join(stream))
    new.start()


def finish(name: str) -> None:
    try:
        client.containers.get(f"{name}-ancien").remove(force=True)
    except NotFound:
        pass


def restore(name: str) -> None:
    """Retour arrière : le nouveau conteneur part, l'ancien reprend son nom et redémarre."""
    try:
        old = client.containers.get(f"{name}-ancien")
    except NotFound:  # échec avant le renommage : l'original est encore là, sous son nom
        client.containers.get(name).start()
        return
    try:
        client.containers.get(name).remove(force=True)
    except NotFound:
        pass
    old.rename(name)
    old.start()


def replace_one(name: str, image: str, snapshot: str | None = None) -> bool:
    """Recrée, vérifie ; sinon remet l'ancien conteneur et, si on a l'instantané, ses données d'avant."""
    try:
        recreate(name, image)
        if healthy(name):
            finish(name)
            return True
    except (APIError, NotFound) as e:  # la nouvelle image ne démarre même pas (commande absente, plateforme…)
        print(f"[mise à jour] {name} : {str(e)[:300]}", flush=True)
    rollback(name, snapshot)
    return False


def rollback(name: str, snapshot: str | None) -> None:
    try:
        client.containers.get(name).stop(timeout=20)  # la nouvelle version n'écrit plus pendant la restauration
    except NotFound:
        pass
    if snapshot:
        try:
            unpack(snapshot, volumes_of(f"{name}-ancien") or volumes_of(name))
        except Exception as e:  # noqa: BLE001 - l'ancien conteneur revient quand même
            print(f"[mise à jour] {name} : restauration des données impossible ({str(e)[:200]})", flush=True)
    restore(name)
    healthy(name, 60)


def recover() -> None:
    """Au démarrage du lanceur : une mise à jour coupée net (kill -9, panne de courant) a pu laisser un <nom>-ancien.
    Si le nouveau conteneur répond, on termine ; sinon l'ancien revient. Jamais ni l'un ni l'autre."""
    for c in client.containers.list(all=True, filters={"name": "-ancien"}):
        name = c.name.removesuffix("-ancien")
        if c.name == name or name == LAUNCHER:  # le lanceur, c'est le relais qui s'en occupe
            continue
        try:
            if client.containers.get(name).status == "running" and healthy(name, 60):
                finish(name)
                continue
        except NotFound:
            pass
        restore(name)


# --- Appliquer une mise à jour --------------------------------------------------------------------------------

def apply(targets: dict[str, str]) -> dict:
    """targets : composant -> image par empreinte (repo@sha256:…). Rend ce qui a été fait, composant par composant."""
    if not _lock.acquire(blocking=False):
        return {"ok": False, "erreur": "Une mise à jour est déjà en cours"}
    state = load_state()
    report = {"ok": True, "composants": {}}
    try:
        state["en_cours"] = {"depuis": int(time.time()), "cibles": targets}
        save_state(state)
        blocked = set(state.get("bloquees", []))
        if any(ref in blocked for ref in targets.values()):
            return {"ok": False, "erreur": "Une de ces versions a déjà échoué ici : elle est bloquée."}
        names = components()
        # Sauvegarde d'abord, de tout ce qui va changer. Un échec arrête tout.
        volumes = sorted({v for comp in targets for name in names.get(comp, []) for v in volumes_of(name)})
        try:
            report["sauvegarde"] = backup(volumes, "maj") if volumes else None
        except Exception as e:  # noqa: BLE001 - disque plein, alpine absent…
            _log(state, f"Mise à jour annulée : la sauvegarde a échoué ({str(e)[:200]})")
            return {"ok": False, "erreur": f"Sauvegarde impossible, rien n'a changé : {str(e)[:300]}"}
        order = ["hermes", "navigateur", "caddy", "noah-server"]
        for comp in [c for c in order if c in targets]:
            ref = targets[comp]
            ok_all = True
            for name in names.get(comp, []):
                swap = HOOKS.get(comp, replace_one)
                if not (swap(name, ref, report.get("sauvegarde")) if swap is replace_one else swap(name, ref)):
                    ok_all = False
                    break  # le premier (canari) échoue : on n'essaie pas les autres
            report["composants"][comp] = "fait" if ok_all else "retour_arriere"
            if ok_all:
                if comp in ("hermes", "navigateur"):
                    state.setdefault("images", {})[comp] = ref  # les prochains agents et navigateurs l'utiliseront
                _log(state, f"{comp} mis à jour ({ref.split('@')[-1][:19]})")
            else:
                state.setdefault("bloquees", []).append(ref)
                report["ok"] = False
                _log(state, f"{comp} : échec du contrôle de santé, retour à la version précédente")
                break
        if report["ok"] and "noah-launcher" in targets:
            # Le lanceur se remplace par un conteneur auxiliaire, lancé depuis la nouvelle image.
            try:
                client.containers.get("apollo-launcher-relais").remove(force=True)
            except NotFound:
                pass
            client.containers.run(targets["noah-launcher"], ["python", "updater.py", "helper", LAUNCHER, targets["noah-launcher"]],
                                  volumes={"/var/run/docker.sock": {"bind": "/var/run/docker.sock", "mode": "rw"}},
                                  network="apollo-net", detach=True, name="apollo-launcher-relais",
                                  restart_policy={"Name": "on-failure", "MaximumRetryCount": 3})
            report["composants"]["noah-launcher"] = "en_cours"
        return report
    finally:
        state = load_state()
        state["en_cours"] = None
        state["dernier_rapport"] = {**report, "fin": int(time.time())}
        save_state(state)
        _lock.release()


if __name__ == "__main__" and sys.argv[1:2] == ["helper"]:
    # Conteneur auxiliaire : remplace le lanceur, vérifie qu'il répond, sinon remet l'ancien.
    name, image = sys.argv[2], sys.argv[3]
    try:
        client.containers.get(f"{name}-ancien")
        # Relancé après une coupure (politique on-failure) : on termine ce qui était commencé.
        ok = client.containers.get(name).status == "running" and healthy(name, 60)
        finish(name) if ok else restore(name)
    except NotFound:
        ok = replace_one(name, image)
    print("ok" if ok else "retour_arriere", flush=True)
elif __name__ == "__main__" and sys.argv[1:2] in (["snapshot"], ["unpack"]):
    (_snapshot if sys.argv[1] == "snapshot" else _unpack)(sys.argv[2], sys.argv[3:])
