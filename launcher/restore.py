"""Restauration d'une sauvegarde (scripts/backup.sh) depuis l'assistant de premier lancement (G3.5).

L'archive arrive du serveur (qui a vérifié le code d'installation et qu'aucun compte n'existe) ; le lanceur, seul à
parler à Docker, remet chaque volume : machines des agents et leurs navigateurs, puis les données du serveur, et la
clé qui déchiffre ses secrets. Chaque base SQLite passe `PRAGMA integrity_check` avant que le serveur ne redémarre.
Une sauvegarde du mode local (clés dans un .env) se restaure sur un VPS (clés dans le volume des secrets).
"""
import base64
import hashlib
import hmac
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

state: dict = {"etape": None, "erreur": None, "fini": False, "avertissement": None}
_lock = threading.Lock()


def busy() -> bool:
    return state["etape"] is not None and not state["fini"]


def claim() -> bool:
    """Une seule restauration à la fois."""
    with _lock:
        if busy():
            return False
        state.update(etape="Réception de la sauvegarde…", erreur=None, fini=False, avertissement=None)
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


CHECK = """
import glob, json, os, sqlite3, sys
out = {"bases": {}, "agents": [], "dossiers": []}
for p in glob.glob("/v/*.db"):
    out["bases"][os.path.basename(p)] = sqlite3.connect(p).execute("PRAGMA integrity_check").fetchone()[0]
if os.path.exists("/v/apollo.db"):
    c = sqlite3.connect("/v/apollo.db")
    out["agents"] = [r[0] for r in c.execute("SELECT id FROM agents")]
    # Secrets chiffrés (Fernet) : le lanceur vérifie que la clé de la sauvegarde les a signés.
    out["chiffres"] = [r[0] for r in c.execute("SELECT value FROM settings WHERE value LIKE 'gAAAAA%' LIMIT 50")]
    if "--detacher" in sys.argv:  # dossiers de l'ancien ordinateur : introuvables ici, l'agent ne serait pas recréé
        out["dossiers"] = [r[0][len("dossiers_"):] for r in c.execute("SELECT key FROM settings WHERE key LIKE 'dossiers_%' AND value NOT IN ('', '[]')")]
        c.execute("DELETE FROM settings WHERE key LIKE 'dossiers_%'")
        c.commit()
    c.close()
print(json.dumps(out))
"""


def _integrity(volume: str, detach: bool = False) -> dict:
    """Chaque base SQLite du volume passe `PRAGMA integrity_check` ; rend aussi les agents connus du serveur."""
    image = updater.pinned("hermes", AGENT_IMAGE)
    _image(image)
    # create/start/wait/logs plutôt que containers.run : avec le pilote de journaux « local » (Docker Desktop, certains
    # VPS), run rend None au lieu de la sortie.
    c = client.containers.create(image, ["python", "-c", CHECK] + (["--detacher"] if detach else []), entrypoint=[],
                                 # Écriture permise : une base en WAL a besoin de son fichier -shm même pour être lue.
                                 volumes={volume: {"bind": "/v", "mode": "rw"}}, user="root")
    try:
        c.start()
        code = c.wait(timeout=600).get("StatusCode")
        out = c.logs(stdout=True, stderr=False).decode().strip()
    finally:
        c.remove(force=True)
    if code != 0 or not out:
        raise RuntimeError(f"Vérification des bases impossible dans {volume} (code {code}).")
    report = json.loads(out.splitlines()[-1])
    bad = [n for n, v in report["bases"].items() if v != "ok"]
    if bad:
        raise RuntimeError(f"Base abîmée dans {volume} : {', '.join(bad)}")
    return report


def _mount(container, target: str) -> str:
    for m in container.attrs.get("Mounts", []):
        if m.get("Destination") == target and m.get("Type") == "volume":
            return m["Name"]
    raise RuntimeError(f"Le serveur n'a pas de volume pour {target} : installe-le avec get.sh, puis restaure.")


MARGIN = 2 << 30  # 2 Go laissés libres sur le disque après la restauration


def _fernet_ok(key: str, token: str) -> bool:
    """La clé de la sauvegarde a bien chiffré ce secret (même calcul que le serveur : Fernet sur sha256 de la clé).
    Seule la signature est vérifiée, le secret n'est jamais déchiffré ici."""
    try:
        raw = base64.urlsafe_b64decode(token.encode() + b"=" * (-len(token) % 4))
    except ValueError:
        return False
    if len(raw) < 57 or raw[0] != 0x80:
        return False
    signing = hashlib.sha256(key.encode()).digest()[:16]
    return hmac.compare_digest(hmac.new(signing, raw[:-32], hashlib.sha256).digest(), raw[-32:])


def _check_key(key: str, tokens: list[str]) -> None:
    bad = [t for t in tokens if not _fernet_ok(key, t)]
    if bad:
        raise ValueError(f"La clé de la sauvegarde ne correspond pas à ses secrets ({len(bad)} sur {len(tokens)}) : "
                         "les clés des fournisseurs seraient illisibles. Refais la sauvegarde avec scripts/backup.sh.")


def _preflight(tar: tarfile.TarFile, found: dict) -> None:
    """Avant de toucher à quoi que ce soit : chaque archive intérieure se lit jusqu'au bout, et ce qu'elle déposera tient
    sur le disque (une petite archive de zéros peut se décompresser en dizaines de gigaoctets)."""
    total = 0
    sizes: dict[str, int] = {}
    for name, member in found.items():
        if not name.endswith(".tar.gz"):
            continue
        size = 0
        try:
            with tarfile.open(fileobj=tar.extractfile(member), mode="r|gz") as inner:
                for m in inner:
                    size += m.size
        except (tarfile.TarError, OSError, EOFError) as e:
            raise ValueError(f"Archive abîmée : {name} ({e})")
        sizes[name] = size
        total += size
    # Au plus fort : tous les volumes restaurés, plus la copie de vérification des données du serveur (elle vit
    # jusqu'à la fin), plus deux copies de la plus grosse archive intérieure (_fill la pose sur le lanceur, puis dans le
    # conteneur qui la décompresse), plus 2 % pour les en-têtes tar et les blocs du système de fichiers.
    biggest = max((m.size for n, m in found.items() if n in sizes), default=0)
    peak = int((total + sizes.get("apollo_apollo-data.tar.gz", 0) + 2 * biggest) * 1.02)
    free = shutil.disk_usage("/").free
    if peak + MARGIN > free:
        raise ValueError(f"Pas assez de place : la restauration a besoin de {peak >> 20} Mo au plus fort, "
                         f"il reste {free >> 20} Mo sur le serveur.")


JOURNAL = Path(os.environ.get("NOAH_RESTORE_JOURNAL", "/state/restauration.json"))


def _journal(**fields) -> None:
    """État écrit sur le disque : un lanceur coupé en pleine restauration le retrouve à son redémarrage."""
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    JOURNAL.write_text(json.dumps({**state, **fields}))


def recover() -> None:
    """Au démarrage du lanceur : une restauration interrompue laisse peut-être le serveur arrêté. On le relance et on
    le dit (l'écran de l'assistant affiche l'erreur ; la sauvegarde peut être renvoyée)."""
    try:
        saved = json.loads(JOURNAL.read_text())
    except (FileNotFoundError, ValueError):
        return
    if not saved.get("fini"):
        state.update(etape=saved.get("etape"), fini=True,
                     erreur="Restauration interrompue (redémarrage du lanceur). Renvoie la sauvegarde pour la reprendre.")
        try:
            client.containers.get(updater.SERVER).start()
        except Exception:
            pass
        _journal()
    else:
        state.update(saved)


def _server_up(seconds: int = 180) -> bool:
    """Le serveur répond avec la sauvegarde : il a lu sa base et déchiffré sa clé (sinon il ne démarre pas)."""
    import time
    import urllib.request
    for _ in range(seconds // 3):
        try:
            with urllib.request.urlopen(f"http://{updater.SERVER}:8080/api/status", timeout=5) as r:
                s = json.loads(r.read())
                if s.get("has_account"):
                    return s.get("secrets_lisibles", True)  # serveur d'avant ce champ : la vérification a eu lieu
        except Exception:
            pass
        time.sleep(3)
    return False


def run(path: Path, labels: tuple[str, str]) -> None:
    """Travail complet, dans un fil. L'état se lit par GET /restore (le serveur est arrêté pendant une partie)."""
    def step(text: str) -> None:
        state["etape"] = text
        _journal()

    locked = True  # pris par la route POST /restore
    try:
        found = inspect(path)
        server = client.containers.get(updater.SERVER)
        data_volume, _ = _mount(server, "/data"), _mount(server, "/secrets")
        with tarfile.open(path) as tar:
            step("Vérification de la sauvegarde…")
            _preflight(tar, found)
            key = _secret_key(tar, found)
            # Données du serveur vérifiées à part d'abord : une base abîmée ne remplace jamais rien ici.
            _fill(CHECKED, tar.extractfile(found["apollo_apollo-data.tar.gz"]))
            checked = _integrity(CHECKED)
            _check_key(key, checked.get("chiffres", []))  # avant tout remplacement : une mauvaise clé ne casse rien
            agents = checked["agents"]
            missing = [a for a in agents if f"apollo-agent-{a}.tar.gz" not in found]
            if missing:
                raise ValueError(f"La sauvegarde ne contient pas la machine de : {', '.join(missing)}.")

            step("Arrêt des agents de cette installation…")
            for label in labels:
                for c in client.containers.list(all=True, filters={"label": label}):
                    c.remove(force=True)
            machines = sorted(n for n in found if n.startswith(("apollo-agent-", "apollo-browser-")))
            for i, name in enumerate(machines, 1):
                volume = name[: -len(".tar.gz")]
                step(f"Machines des agents : {i} sur {len(machines)}…")
                _fill(volume, tar.extractfile(found[name]))
                if volume.startswith("apollo-agent-") and "state.db" not in _integrity(volume)["bases"]:
                    raise ValueError(f"La mémoire de l'agent manque dans la sauvegarde ({volume}).")

            step("Compte, conversations et réglages…")
            server.stop(timeout=30)
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
            _fill(data_volume, tar.extractfile(found["apollo_apollo-data.tar.gz"]))
            folders = _integrity(data_volume, detach=True)["dossiers"]

        step("Redémarrage du serveur…")
        # Le serveur recrée les agents dès son démarrage : le verrou des mises à jour doit être libre pour lui.
        updater._lock.release()
        locked = False
        server.start()
        if not _server_up():
            raise RuntimeError("Le serveur ne démarre pas correctement avec la sauvegarde (compte ou clés illisibles) : "
                               "regarde ses journaux (docker logs apollo-server).")
        if folders:
            state["avertissement"] = ("Dossiers partagés de l'ancien ordinateur détachés (à reconnecter dans Détails → "
                                      f"Dossiers) pour : {', '.join(folders)}.")
        state["fini"] = True
        step("Restauré")
    except Exception as e:  # noqa: BLE001 — tout échec est rapporté à l'écran de l'assistant
        state["erreur"] = str(e)
        state["fini"] = True
        _journal()
        try:
            client.containers.get(updater.SERVER).start()  # jamais laissé arrêté
        except Exception:
            pass
    finally:
        path.unlink(missing_ok=True)
        if _exists(CHECKED):
            client.volumes.get(CHECKED).remove(force=True)
        if locked:
            updater._lock.release()
