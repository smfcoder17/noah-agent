"""Restauration d'une sauvegarde (scripts/backup.sh) depuis l'assistant de premier lancement (G3.5).

L'archive arrive du serveur (qui a vérifié le code d'installation et qu'aucun compte n'existe) ; le lanceur, seul à
parler à Docker, remet chaque volume : machines des agents et leurs navigateurs, puis les données du serveur, et la
clé qui déchiffre ses secrets. Chaque base SQLite passe `PRAGMA integrity_check` avant que le serveur ne redémarre.
Une sauvegarde du mode local (clés dans un .env) se restaure sur un VPS (clés dans le volume des secrets).
"""
import io
import json
import os
import re
import tarfile
import tempfile
import shutil
import threading
from pathlib import Path

import updater

client = updater.client
AGENT_IMAGE = os.environ.get("AGENT_IMAGE", "nousresearch/hermes-agent:stable")
VOLUME = re.compile(r"^(apollo_apollo-data|apollo_noah-secrets|apollo-agent-[a-z0-9-]+|apollo-browser-[a-z0-9-]+)$")
WORK = Path(tempfile.gettempdir()) / "noah-restauration"
CHECKED = "noah-restauration-verification"

state: dict = {"etape": None, "erreur": None, "fini": False}
_lock = threading.Lock()


def busy() -> bool:
    return state["etape"] is not None and not state["fini"]


def claim() -> bool:
    """Une seule restauration à la fois."""
    with _lock:
        if busy():
            return False
        state.update(etape="Réception de la sauvegarde…", erreur=None, fini=False)
        return True


def inspect(path: Path) -> dict[str, tarfile.TarInfo]:
    """Contenu attendu : un dossier noah-AAAAMMJJ-HHMM avec un <volume>.tar.gz par volume, et le .env (mode local).
    Tout autre chemin (.., absolu, lien, volume inconnu) fait refuser l'archive entière."""
    found: dict[str, tarfile.TarInfo] = {}
    with tarfile.open(path) as tar:
        for m in tar.getmembers():
            parts = m.name.strip("/").split("/")
            if m.name.startswith("/") or ".." in parts or len(parts) > 2 or m.issym() or m.islnk():
                raise ValueError(f"Chemin refusé dans l'archive : {m.name}")
            if len(parts) == 1 and m.isdir():
                continue
            if not m.isfile() or len(parts) != 2:
                raise ValueError(f"Élément inattendu dans l'archive : {m.name}")
            name = parts[1]
            if name == "env" or (name.endswith(".tar.gz") and VOLUME.match(name[: -len(".tar.gz")])):
                found[name] = m
            else:
                raise ValueError(f"Élément inattendu dans l'archive : {m.name}")
    if "apollo_apollo-data.tar.gz" not in found:
        raise ValueError("Ce n'est pas une sauvegarde de Noah Agent : les données du serveur manquent.")
    return found


def _secret_key(tar: tarfile.TarFile, found: dict) -> str:
    """Clé qui déchiffre les secrets de la sauvegarde : .env (mode local) ou volume des secrets (VPS)."""
    if "env" in found:
        for line in tar.extractfile(found["env"]).read().decode().splitlines():
            if line.startswith("APOLLO_SECRET_KEY="):
                return line.split("=", 1)[1].strip()
    if "apollo_noah-secrets.tar.gz" in found:
        with tarfile.open(fileobj=tar.extractfile(found["apollo_noah-secrets.tar.gz"]), mode="r:gz") as inner:
            for m in inner.getmembers():
                if m.name.lstrip("./") == "noah.json":
                    return json.loads(inner.extractfile(m).read())["APOLLO_SECRET_KEY"]
    raise ValueError("La clé de la sauvegarde manque (ni .env ni volume des secrets) : ses données sont illisibles.")


def _fill(volume: str, data) -> None:
    """Remplace le contenu d'un volume par une archive .tar.gz (flux), dans un conteneur jetable. L'archive passe par
    le disque, jamais entière en mémoire."""
    if not _exists(volume):
        client.volumes.create(volume)
    _image("alpine")
    c = client.containers.create("alpine", ["sh", "-c", "rm -rf /v/* /v/.[!.]* 2>/dev/null; tar xzf /in.tar.gz -C /v"],
                                 volumes={volume: {"bind": "/v", "mode": "rw"}})
    inner, outer = WORK / "in.tar.gz", WORK / "entree.tar"
    try:
        with open(inner, "wb") as f:
            shutil.copyfileobj(data, f, 1 << 20)
        with tarfile.open(outer, "w") as t:
            t.add(inner, arcname="in.tar.gz")
        inner.unlink()
        with open(outer, "rb") as f:
            c.put_archive("/", f)
        c.start()
        if c.wait()["StatusCode"] != 0:
            raise RuntimeError(f"Extraction impossible dans {volume} : {c.logs().decode()[-300:]}")
    finally:
        c.remove(force=True)
        inner.unlink(missing_ok=True)
        outer.unlink(missing_ok=True)


def _image(name: str) -> None:
    try:
        client.images.get(name)
    except updater.NotFound:
        client.images.pull(name)


def _exists(volume: str) -> bool:
    try:
        client.volumes.get(volume)
        return True
    except updater.NotFound:
        return False


CHECK = ("import glob, sqlite3, sys\n"
         "bad = [p for p in glob.glob('/v/*.db') if sqlite3.connect(p).execute('PRAGMA integrity_check').fetchone()[0] != 'ok']\n"
         "print(' '.join(bad)); sys.exit(1 if bad else 0)")


def _integrity(volume: str) -> None:
    """Chaque base SQLite du volume (state.db d'Hermes, apollo.db du serveur…) passe `PRAGMA integrity_check`."""
    image = updater.pinned("hermes", AGENT_IMAGE)
    _image(image)
    out = client.containers.run(image, ["python", "-c", CHECK], entrypoint=[],
                                # Écriture permise : une base en WAL a besoin de son fichier -shm même pour être lue.
                                volumes={volume: {"bind": "/v", "mode": "rw"}}, remove=True, user="root")
    if out.strip():
        raise RuntimeError(f"Base abîmée dans {volume} : {out.decode().strip()}")


def _mount(container, target: str) -> str:
    for m in container.attrs.get("Mounts", []):
        if m.get("Destination") == target and m.get("Type") == "volume":
            return m["Name"]
    raise RuntimeError(f"Le serveur n'a pas de volume pour {target} : restaure avec scripts/restore.sh.")


def run(path: Path, labels: tuple[str, str]) -> None:
    """Travail complet, dans un fil. L'état se lit par GET /restore (le serveur est arrêté pendant une partie)."""
    def step(text: str) -> None:
        state["etape"] = text

    try:
        found = inspect(path)
        server = client.containers.get(updater.SERVER)
        data_volume, secrets_volume = _mount(server, "/data"), _mount(server, "/secrets")
        with tarfile.open(path) as tar:
            key = _secret_key(tar, found)
            step("Arrêt des agents de cette installation…")
            for label in labels:
                for c in client.containers.list(all=True, filters={"label": label}):
                    c.remove(force=True)
            machines = sorted(n for n in found if n.startswith(("apollo-agent-", "apollo-browser-")))
            for i, name in enumerate(machines, 1):
                volume = name[: -len(".tar.gz")]
                step(f"Machines des agents : {i} sur {len(machines)}…")
                _fill(volume, tar.extractfile(found[name]))
                if volume.startswith("apollo-agent-"):
                    _integrity(volume)
            step("Compte, conversations et réglages…")
            # Vérifiées à part d'abord : une base abîmée ne remplace jamais les données de ce serveur.
            _fill(CHECKED, tar.extractfile(found["apollo_apollo-data.tar.gz"]))
            _integrity(CHECKED)
            server.stop(timeout=30)
            _fill(data_volume, tar.extractfile(found["apollo_apollo-data.tar.gz"]))
            # La clé de la sauvegarde déchiffre ses secrets ; la clé du lanceur reste celle de ce serveur, et le code
            # d'installation n'a plus lieu d'être (le compte revient avec la sauvegarde).
            current = json.loads(updater.read_text(server, "/secrets/noah.json")[0])
            current["APOLLO_SECRET_KEY"] = key
            current.pop("NOAH_SETUP_CODE", None)
            buf = io.BytesIO()
            raw = json.dumps(current).encode()
            with tarfile.open(fileobj=buf, mode="w") as t:
                info = tarfile.TarInfo("noah.json")
                info.size, info.mode = len(raw), 0o600
                t.addfile(info, io.BytesIO(raw))
            server.put_archive("/secrets", buf.getvalue())
        step("Redémarrage du serveur…")
        server.start()
        state["fini"] = True
        step("Restauré")
    except Exception as e:  # noqa: BLE001 — tout échec est rapporté à l'écran de l'assistant
        state["erreur"] = str(e)
        state["fini"] = True
        try:
            client.containers.get(updater.SERVER).start()  # jamais laissé arrêté
        except Exception:
            pass
    finally:
        path.unlink(missing_ok=True)
        if _exists(CHECKED):
            client.volumes.get(CHECKED).remove(force=True)
        updater._lock.release()  # pris par la route POST /restore
