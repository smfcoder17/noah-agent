"""Mises à jour des conteneurs de Noah Agent, faites par le lanceur (seul service qui parle à Docker).

Le serveur décide quand (créneau calme, rien en cours) ; le lanceur décide quoi : il revérifie lui-même la signature
du manifeste (clé publique dans son image) et n'installe que les empreintes signées. Une mise à jour est une
transaction journalisée dans /state/updates.json :
1. images présentes en local, par empreinte (jamais une étiquette qui bouge) ; sinon rien ne commence ;
2. pour chaque conteneur, dans l'ordre (un agent d'abord, en canari, puis les autres, les navigateurs, Caddy, le
   serveur) : instantané de ses volumes (SQLite copié proprement et vérifié, propriétaires gardés), recréation sur
   la nouvelle image, contrôle de santé sur la durée ; l'ancien conteneur reste à côté (<nom>-ancien) ;
3. au premier échec, tout ce qui a changé revient en arrière, conteneurs et données, et l'empreinte fautive est
   bloquée pour cette version ; si tout va bien, les anciens conteneurs sont retirés ;
4. le lanceur lui-même est remplacé par un conteneur relais, lancé depuis la nouvelle image.
Une coupure en plein milieu (kill -9, panne) est annulée au démarrage suivant : on revient à l'ancienne version
complète, jamais un mélange. Même mécanique que What's Up Docker (préchargement, sauvegarde bloquante, retour
arrière selon la santé) et que l'étape « helper » de Coolify.
"""
import base64
import io
import json
import os
import re
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
BACKUP_VOLUME = os.environ.get("NOAH_BACKUP_VOLUME", "apollo_noah-backups")
PUBLIC_KEY = os.environ.get("NOAH_UPDATE_KEY", "")
REF = re.compile(r"[a-z0-9./_:-]+@sha256:[0-9a-f]{64}")
_lock = threading.Lock()  # une transaction (ou une reprise) à la fois
_state_lock = threading.Lock()

SERVER, CADDY = "apollo-server", "apollo-caddy"
LAUNCHER = os.environ.get("NOAH_LAUNCHER_NAME", "apollo-launcher")
RELAY = "apollo-launcher-relais"
ORDER = ["hermes", "navigateur", "caddy", "noah-server"]
# Fichiers que Docker Compose copie dans le conteneur à sa création (configs: content) : une recréation les perdrait.
COPIED_FILES = {CADDY: ["/etc/caddy/Caddyfile"]}
# Fournis par le lanceur : recréation particulière d'un composant (nom, image) -> bool, et verrou partagé avec ses
# autres opérations sur ces conteneurs.
HOOKS: dict = {}
LOCKS: dict = {}


# --- État -------------------------------------------------------------------------------------------------

def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (FileNotFoundError, ValueError):
        return {"images": {}, "historique": [], "bloquees": [], "en_cours": None}


def update_state(change) -> dict:
    """Lecture, modification, écriture atomique, sous verrou : deux écritures ne s'écrasent pas."""
    with _state_lock:
        state = load_state()
        change(state)
        STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
        os.replace(tmp, STATE)
        return state


def _log(text: str) -> None:
    print(f"[mise à jour] {text}", flush=True)

    def add(s):
        s["historique"] = (s.get("historique", []) + [{"quand": int(time.time()), "texte": text}])[-100:]
    update_state(add)


def pinned(component: str, default: str) -> str:
    """Image à utiliser pour un composant que le lanceur crée lui-même (agents, navigateurs)."""
    return load_state().get("images", {}).get(component) or default


def _component(name: str) -> str | None:
    if name.startswith("apollo-agent-"):
        return "hermes"
    if name.startswith("apollo-browser-"):
        return "navigateur"
    return {CADDY: "caddy", SERVER: "noah-server", LAUNCHER: "noah-launcher"}.get(name)


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
    return manifest


# --- Ce qui tourne ------------------------------------------------------------------------------------------

def components() -> dict[str, list[str]]:
    """Composant -> conteneurs (dans l'ordre où les mettre à jour)."""
    agents = sorted(c.name for c in client.containers.list(all=True, filters={"label": "apollo.agent"}))
    browsers = sorted(c.name for c in client.containers.list(all=True, filters={"label": "apollo.browser"}))
    out = {"hermes": [n for n in agents if not n.endswith("-ancien")],
           "navigateur": [n for n in browsers if not n.endswith("-ancien")]}
    for name in (CADDY, SERVER, LAUNCHER):
        try:
            client.containers.get(name)
            out[_component(name)] = [name]
        except NotFound:
            pass
    return out


def _runs(name: str, ref: str) -> bool:
    try:
        img = client.containers.get(name).image
    except NotFound:
        return False
    return ref in (img.attrs.get("RepoDigests") or []) or ref.split("@")[-1] == img.id


def current() -> dict[str, list[dict]]:
    """Image de chaque conteneur, composant par composant : un parc à moitié mis à jour se voit."""
    out = {}
    for comp, names in components().items():
        out[comp] = []
        for name in names:
            try:
                img = client.containers.get(name).image
            except NotFound:
                continue
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


# --- Instantanés des volumes ----------------------------------------------------------------------------------

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
                                   entrypoint=[], working_dir="/tmp", user="0", environment={"NOAH_TOOL": "1"})
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
        if code != 0:
            lines = box.logs(tail=5).decode(errors="replace").strip().splitlines()
            raise RuntimeError(lines[-1] if lines else f"code {code}")
    finally:
        box.remove(force=True)


def backup(volumes: list[str], folder: str) -> None:
    """Instantané des volumes dans <folder>. Lève une erreur au moindre problème (disque plein…)."""
    _tool(["snapshot", folder], volumes)


def unpack(folder: str, volumes: list[str]) -> None:
    """Remet les volumes dans l'état de l'instantané. Les données en place ne sont touchées qu'une fois l'archive
    entièrement extraite à côté et ses bases vérifiées."""
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


def _snapshot(folder: str, volumes: list[str]) -> None:
    """(Conteneur jetable.) /v<i> -> <folder>/<volume>.tar.gz, propriétaires et droits gardés. Les bases SQLite sont
    copiées par l'API backup (cohérentes même ouvertes) et vérifiées par integrity_check."""
    import shutil
    import sqlite3
    os.makedirs(folder, exist_ok=False)
    try:
        for i, name in enumerate(volumes):
            src = f"/v{i}"
            with tarfile.open(f"{folder}/{name}.tar.gz.part", "w:gz") as tar:
                tar.addfile(tar.gettarinfo(src, "."))  # propriétaire et droits de la racine du volume
                for root, dirs, files in os.walk(src):
                    for entry in dirs + files:
                        path = os.path.join(root, entry)
                        arc = "./" + os.path.relpath(path, src)
                        if entry.endswith(("-wal", "-shm", "-journal")):
                            continue
                        info = tar.gettarinfo(path, arc)
                        if info is None:  # socket, fichier spécial : rien à sauvegarder
                            continue
                        if info.isfile() and _is_sqlite(path):
                            copy = "/tmp/copy.db"
                            live, out = sqlite3.connect(path), sqlite3.connect(copy)
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
            os.replace(f"{folder}/{name}.tar.gz.part", f"{folder}/{name}.tar.gz")
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)  # pas de sauvegarde à moitié faite qui remplit le disque
        raise
    # Ne garder que les 5 dernières mises à jour.
    tops = sorted(Path("/backups").glob("maj-*"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in tops[5:]:
        shutil.rmtree(old, ignore_errors=True)


def _unpack(folder: str, volumes: list[str]) -> None:
    import shutil
    for i, name in enumerate(volumes):
        archive, dest = Path(f"{folder}/{name}.tar.gz"), Path(f"/v{i}")
        if not archive.exists():
            continue
        staging = dest / ".noah-restauration"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
        try:
            with tarfile.open(archive) as tar:
                tar.extractall(staging, filter="tar", numeric_owner=True)
            for path in staging.rglob("*"):
                if path.is_file() and not path.is_symlink() and _is_sqlite(str(path)):
                    _check_sqlite(str(path))
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)  # les données en place n'ont pas bougé
            raise
        # Bascule : tout est prêt et vérifié, on remplace.
        for child in dest.iterdir():
            if child != staging:
                shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
        for child in staging.iterdir():
            os.rename(child, dest / child.name)
        stat = staging.stat()
        os.chown(dest, stat.st_uid, stat.st_gid)
        staging.rmdir()


def volumes_of(name: str) -> list[str]:
    try:
        mounts = client.containers.get(name).attrs.get("Mounts", [])
    except NotFound:
        return []
    return [m["Name"] for m in mounts if m.get("Type") == "volume" and m.get("Name") != BACKUP_VOLUME]


# --- Recréer un conteneur sur une nouvelle image -----------------------------------------------------------------

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
    if name == LAUNCHER or name.endswith("-launcher"):
        return f"http://{name}:9000/health"
    if name == CADDY:
        return "http://apollo-caddy:80/"  # Caddy répond (redirection vers HTTPS) : il a bien sa configuration
    if name.startswith("apollo-agent-"):
        return f"http://{name}:8642/health"
    if name.startswith("apollo-browser-"):
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


def healthy(name: str, seconds: int = 120) -> bool:
    """Sain = répond 3 fois de suite sur 10 s, sans redémarrer entre-temps (un conteneur qui répond une fois puis
    boucle n'est pas sain)."""
    url = _health_url(name)
    deadline = time.time() + seconds
    streak, restarts = 0, None
    while time.time() < deadline:
        try:
            c = client.containers.get(name)
            state = c.attrs.get("State", {})
            running = c.status == "running" and state.get("Health", {}).get("Status") != "unhealthy"
            count = c.attrs.get("RestartCount", 0)
        except NotFound:
            running, count = False, None
        if restarts is not None and count != restarts:
            streak = 0
        restarts = count
        ok = running and (_answers(url) if url else True)
        streak = streak + 1 if ok else 0
        if streak >= 3:
            return True
        time.sleep(5)
    return False


def recreate(name: str, image: str) -> None:
    """Remplace le conteneur `name` par le même, sur `image`. L'ancien reste sous le nom <name>-ancien jusqu'à
    `finish` (succès) ou `restore` (échec)."""
    old = client.containers.get(name)
    attrs, cfg, hc = old.attrs, old.attrs["Config"], dict(old.attrs["HostConfig"])
    image_cfg = old.image.attrs.get("Config", {})
    networks = attrs["NetworkSettings"]["Networks"]
    mounted = [m.get("Destination", "") for m in attrs.get("Mounts", [])]
    try:
        client.containers.get(f"{name}-ancien").remove(force=True)
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
        user=None if cfg.get("User") == image_cfg.get("User") else (cfg.get("User") or None),
        labels={k: v for k, v in (cfg.get("Labels") or {}).items() if (image_cfg.get("Labels") or {}).get(k) != v},
        ports=list((cfg.get("ExposedPorts") or {}).keys()),
        host_config=hc,
        networking_config=networking,
    )
    new = client.containers.get(created["Id"])
    for net, endpoint in others:
        client.networks.get(net).connect(new, aliases=[a for a in (endpoint.get("Aliases") or []) if a != old.id[:12]])
    for path in COPIED_FILES.get(name, []):
        if any(path == m or path.startswith(m.rstrip("/") + "/") for m in mounted):
            continue  # monté depuis l'hôte : le montage suit déjà, inutile (et impossible en lecture seule) de copier
        stream, _ = old.get_archive(path)
        new.put_archive(os.path.dirname(path), b"".join(stream))
    new.start()


def finish(name: str) -> None:
    try:
        client.containers.get(f"{name}-ancien").remove(force=True)
    except NotFound:
        pass


def restore(name: str, start: bool = True) -> None:
    """Le nouveau conteneur part, l'ancien reprend son nom (et redémarre)."""
    try:
        old = client.containers.get(f"{name}-ancien")
    except NotFound:  # échec avant le renommage : l'original est encore là, sous son nom
        if start:
            client.containers.get(name).start()
        return
    try:
        client.containers.get(name).remove(force=True)
    except NotFound:
        pass
    old.rename(name)
    if start:
        old.start()


def swap(name: str, image: str) -> bool:
    """Recrée et contrôle. N'annule rien : c'est la transaction qui décide (tout revient, ou rien)."""
    comp = _component(name)
    try:
        with LOCKS.get(comp) or _nolock():
            (HOOKS.get(comp) or recreate)(name, image)
        return healthy(name)
    except Exception as e:  # noqa: BLE001 - image qui ne démarre pas, fichier absent… : échec, pas plantage
        print(f"[mise à jour] {name} : {str(e)[:300]}", flush=True)
        return False


class _nolock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def rollback(name: str, snapshot: str | None) -> bool:
    """Ancien conteneur et données d'avant. Si les données ne peuvent pas être remises, l'ancien conteneur reste
    arrêté (il ne doit pas démarrer sur des données migrées) et le journal le dit."""
    with LOCKS.get(_component(name)) or _nolock():
        try:
            client.containers.get(name).stop(timeout=20)  # la version fautive n'écrit plus pendant la restauration
        except NotFound:
            pass
        if snapshot:
            vols = volumes_of(f"{name}-ancien") or volumes_of(name)
            try:
                unpack(snapshot, vols)
            except Exception as e:  # noqa: BLE001
                restore(name, start=False)
                _log(f"{name} : données d'avant impossibles à remettre ({str(e)[:160]}). Il reste arrêté ; "
                     f"sauvegarde : {snapshot}")
                return False
        restore(name)
    return healthy(name, 120)


# --- Transaction ------------------------------------------------------------------------------------------------

def _blocked(state: dict, version: str, ref: str) -> bool:
    return any(b.get("image") == ref and b.get("version") == version for b in state.get("bloquees", []))


def apply(raw: bytes, signature: str, wanted: list[str] | None = None, force: bool = False) -> dict:
    """Installe les composants `wanted` (tous par défaut) du manifeste signé. Rend le rapport, aussi enregistré."""
    if not _lock.acquire(blocking=False):
        return {"ok": False, "erreur": "Une mise à jour est déjà en cours"}
    report = {"ok": False, "debut": int(time.time()), "composants": {}}
    relay = False
    try:
        try:
            manifest = verify_manifest(raw, signature)
        except ValueError as e:
            report["erreur"] = f"Manifeste refusé : {e}"
            _log(report["erreur"])
            return report
        version = manifest.get("version", "?")
        report["version"] = version
        state = load_state()
        targets = {c: r for c, r in manifest["images"].items() if wanted is None or c in wanted}
        if force:
            update_state(lambda s: s.update(bloquees=[b for b in s.get("bloquees", []) if b.get("image") not in targets.values()]))
        else:
            for comp, ref in list(targets.items()):
                if _blocked(state, version, ref):
                    report["composants"][comp] = "bloquee"
                    del targets[comp]
        if not targets:
            report["erreur"] = "Cette version a déjà échoué ici : elle attend la suivante, ou un clic pour réessayer"
            return report
        names = components()
        # Rien ne commence tant que toutes les images ne sont pas là (registre en panne, limite de Docker Hub…).
        missing = pull(list(targets.values()))["echecs"]
        if missing:
            report["erreur"] = "Téléchargement impossible, rien n'a changé : " + missing[0]["erreur"][:200]
            _log(report["erreur"])
            return report
        tx = f"/backups/maj-{time.strftime('%Y%m%d-%H%M%S')}"
        update_state(lambda s: s.update(en_cours={"version": version, "depuis": int(time.time()), "sauvegardes": tx,
                                                  "remplaces": [], "courant": None}))
        done: list[tuple[str, str | None]] = []
        failed = None
        for comp in [c for c in ORDER if c in targets]:
            ref = targets[comp]
            for name in names.get(comp, []):
                if _runs(name, ref):
                    continue
                vols = volumes_of(name)
                snap = f"{tx}/{name}" if vols else None
                try:
                    if snap:
                        backup(vols, snap)
                except Exception as e:  # noqa: BLE001 - disque plein…
                    failed = (comp, ref, f"Sauvegarde de {name} impossible : {str(e)[:200]}", False)
                    break
                update_state(lambda s: s["en_cours"].update(courant={"nom": name, "sauvegarde": snap}))
                if not swap(name, ref):
                    rollback(name, snap)
                    failed = (comp, ref, f"{name} ne répondait plus sur la nouvelle version", True)
                    break
                done.append((name, snap))
                update_state(lambda s: (s["en_cours"]["remplaces"].append({"nom": name, "sauvegarde": snap}),
                                        s["en_cours"].update(courant=None)))
            if failed:
                break
            report["composants"][comp] = "fait"
        if failed:
            comp, ref, why, block = failed
            for name, snap in reversed(done):  # tout ce qui avait changé revient : jamais un parc mélangé
                rollback(name, snap)
            report["composants"] = {comp: "retour_arriere"}
            report["erreur"] = why
            if block:
                update_state(lambda s: s.setdefault("bloquees", []).append({"image": ref, "version": version, "composant": comp}))
            _log(f"Noah {version} : {why}. Retour à la version précédente, avec ses données.")
            return report
        for name, _ in done:
            finish(name)
        # Les agents et navigateurs créés plus tard prennent eux aussi les images signées.
        update_state(lambda s: s.setdefault("images", {}).update({c: r for c, r in targets.items() if c in ("hermes", "navigateur")}))
        report["ok"] = True
        if "noah-launcher" in targets and not _runs(LAUNCHER, targets["noah-launcher"]):
            _start_relay(targets["noah-launcher"], version)
            report["composants"]["noah-launcher"] = "en_cours"
            relay = True
        _log(f"Noah {version} installée" + (" (le lanceur suit)" if relay else ""))
        return report
    finally:
        report["fin"] = int(time.time())
        update_state(lambda s: s.update(en_cours=None, dernier_rapport=report))
        _lock.release()


def _start_relay(image: str, version: str) -> None:
    """Le lanceur ne peut pas se remplacer pendant qu'il tourne : un relais, lancé depuis la nouvelle image, le fait.
    Il redémarre seul après une coupure (always) et se désactive quand il a fini."""
    me = client.containers.get(LAUNCHER)
    state_volume = next((m["Name"] for m in me.attrs.get("Mounts", []) if m.get("Destination") == str(STATE.parent)), None)
    network = next(iter(me.attrs["NetworkSettings"]["Networks"]), "apollo-net")
    try:
        client.containers.get(RELAY).remove(force=True)
    except NotFound:
        pass
    update_state(lambda s: s.update(relais={"image": image, "version": version, "depuis": int(time.time())}))
    volumes = {"/var/run/docker.sock": {"bind": "/var/run/docker.sock", "mode": "rw"}}
    if state_volume:
        volumes[state_volume] = {"bind": "/state", "mode": "rw"}
    client.containers.run(image, ["python", "updater.py", "relay", LAUNCHER, image, version], volumes=volumes,
                          network=network, detach=True, name=RELAY,
                          environment={"NOAH_UPDATE_STATE": "/state/updates.json", "NOAH_LAUNCHER_NAME": LAUNCHER},
                          restart_policy={"Name": "always"})


def _relay(name: str, image: str, version: str) -> None:
    resumed = True
    try:
        client.containers.get(f"{name}-ancien")
    except NotFound:
        resumed = False
    if resumed:  # relancé après une coupure : on termine si le nouveau répond, sinon l'ancien revient
        ok = healthy(name, 180)
        finish(name) if ok else restore(name)
    else:
        ok = swap(name, image)
        finish(name) if ok else restore(name)
    if not ok:
        update_state(lambda s: s.setdefault("bloquees", []).append({"image": image, "version": version, "composant": "noah-launcher"}))
    _log(f"Lanceur {'mis à jour' if ok else ': échec, retour à la version précédente'} ({version})")
    update_state(lambda s: (s.pop("relais", None), s.update(dernier_rapport={
        "ok": ok, "version": version, "fin": int(time.time()), "composants": {"noah-launcher": "fait" if ok else "retour_arriere"},
        **({} if ok else {"erreur": "le nouveau lanceur ne répondait pas"})})))
    client.containers.get(socket.gethostname()).update(restart_policy={"Name": "no"})  # fini : ne plus redémarrer


def recover() -> None:
    """Au démarrage du lanceur. Une transaction coupée net (kill -9, panne de courant) est annulée en entier :
    chaque conteneur touché revient à l'ancienne version, avec ses données. Ne touche qu'aux conteneurs du journal."""
    with _lock:
        state = load_state()
        tx = state.get("en_cours")
        if tx:
            touched = [r for r in tx.get("remplaces", [])] + ([tx["courant"]] if tx.get("courant") else [])
            for item in reversed(touched):
                try:
                    client.containers.get(f"{item['nom']}-ancien")
                except NotFound:
                    continue
                rollback(item["nom"], item.get("sauvegarde"))
            _log(f"Mise à jour {tx.get('version', '')} interrompue : retour à la version précédente")
            update_state(lambda s: s.update(en_cours=None, dernier_rapport={
                "ok": False, "version": tx.get("version"), "fin": int(time.time()), "composants": {},
                "erreur": "interrompue (arrêt du serveur), version précédente remise"}))
        relay = state.get("relais")
        if relay and socket.gethostname() != RELAY:
            try:
                running = client.containers.get(RELAY).status in ("running", "restarting")
            except NotFound:
                running = False
            if not running and _runs(LAUNCHER, relay["image"]):  # c'est nous, la nouvelle version, et on tourne
                finish(LAUNCHER)
                update_state(lambda s: s.pop("relais", None))
                _log(f"Lanceur mis à jour ({relay.get('version')})")


if __name__ == "__main__" and sys.argv[1:2] == ["relay"]:
    _relay(sys.argv[2], sys.argv[3], sys.argv[4])
elif __name__ == "__main__" and sys.argv[1:2] in (["snapshot"], ["unpack"]):
    (_snapshot if sys.argv[1] == "snapshot" else _unpack)(sys.argv[2], sys.argv[3:])
