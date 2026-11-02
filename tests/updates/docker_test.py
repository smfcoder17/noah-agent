"""Transaction de mise à jour sur de vrais conteneurs jetables (préfixe noahtest-), registre local compris.
Ne touche à aucun conteneur de Noah : la liste des composants est remplacée par les conteneurs du test.

    sh tests/updates/docker_test.sh
"""
import base64
import json
import os
import sys
import tempfile
import time

os.environ["NOAH_UPDATE_STATE"] = tempfile.mkdtemp() + "/updates.json"
os.environ["NOAH_BACKUP_VOLUME"] = "noahtest-backups"
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

KEY = Ed25519PrivateKey.generate()
os.environ["NOAH_UPDATE_KEY"] = base64.b64encode(
    KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
sys.path.insert(0, "/l")
import docker  # noqa: E402
import updater as u  # noqa: E402

c = docker.from_env()
REG = os.environ["REGISTRY"]
AGENTS = ["noahtest-agent-a", "noahtest-agent-b"]
u.components = lambda: {"hermes": list(AGENTS)}
u._component = lambda name: "hermes" if name.startswith("noahtest-agent-") else None
u._health_url = lambda name: f"http://{name}:8000/health"
u.LAUNCHER = "noahtest-runner"  # image des outils de sauvegarde : celle de ce conteneur
_healthy = u.healthy
u.healthy = lambda name, seconds=120: _healthy(name, min(seconds, 30))  # test : 30 s au lieu de 120


def ref(tag: str) -> str:
    return next(d for d in c.images.get(f"{REG}/noahtest/app:{tag}").attrs["RepoDigests"] if d.startswith(REG))


def signed(images: dict, version: str = "2.0.0", key=KEY) -> tuple[bytes, str]:
    raw = json.dumps({"version": version, "images": images}).encode()
    return raw, base64.b64encode(key.sign(raw)).decode()


def reset():
    for n in AGENTS + [a + "-ancien" for a in AGENTS]:
        try:
            c.containers.get(n).remove(force=True)
        except docker.errors.NotFound:
            pass


def sh(volume: str, script: str) -> str:
    box = c.containers.run("python:3.12-slim", ["sh", "-c", script], volumes={volume: {"bind": "/data"}}, detach=True)
    box.wait()
    out = box.logs().decode().strip()
    box.remove()
    return out


def schema(name: str) -> str:
    return sh(f"{name}-data", "python -c \"import sqlite3; d=sqlite3.connect('/data/state.db'); "
              "print([r[1] for r in d.execute('PRAGMA table_info(t)')], d.execute('PRAGMA integrity_check').fetchone()[0])\"")


def image_of(name: str) -> str:
    return c.containers.get(name).image.id


reset()
for name in AGENTS:
    for v in (f"{name}-data",):
        try:
            c.volumes.get(v).remove(force=True)
        except docker.errors.NotFound:
            pass
    sh(f"{name}-data", "mkdir -p /data/espace && echo bonjour > /data/espace/note.txt && chown -R 1000:1000 /data/espace")
    c.containers.run(f"{REG}/noahtest/app:v1", name=name, hostname=name, detach=True, network="noahtest-net",
                     volumes={f"{name}-data": {"bind": "/data"}}, restart_policy={"Name": "unless-stopped"})
for name in AGENTS:
    assert _healthy(name, 30), f"{name} ne démarre pas"
time.sleep(2)  # les bases s'écrivent (WAL)
v1 = {n: image_of(n) for n in AGENTS}

# 1. Signature d'une autre clé : refusée, rien ne bouge.
rep = u.apply(*signed({"hermes": ref("v2")}, key=Ed25519PrivateKey.generate()))
assert not rep["ok"] and "refusé" in rep["erreur"] and {n: image_of(n) for n in AGENTS} == v1, rep
print("1. manifeste signé par une autre clé : refusé, rien n'a bougé")

# 2. Image introuvable dans le registre : rien ne commence.
rep = u.apply(*signed({"hermes": f"{REG}/noahtest/app@sha256:" + "0" * 64}))
assert not rep["ok"] and "Téléchargement" in rep["erreur"] and {n: image_of(n) for n in AGENTS} == v1, rep
print("2. image introuvable : rien n'a commencé")

# 3. La v2 migre le schéma, passe sur l'agent a (canari), échoue sur b : TOUT revient, conteneurs et données.
t0 = time.time()
rep = u.apply(*signed({"hermes": ref("v2")}))
took = time.time() - t0
assert not rep["ok"] and rep["composants"] == {"hermes": "retour_arriere"}, rep
assert {n: image_of(n) for n in AGENTS} == v1, "parc mélangé après l'échec"
for name in AGENTS:
    s = schema(name)
    assert "migre" not in s and s.endswith("ok"), (name, s)
    owner = sh(f"{name}-data", "stat -c %u:%g /data/espace/note.txt && cat /data/espace/note.txt")
    assert owner == "1000:1000\nbonjour", (name, owner)
    assert c.containers.get(name).status == "running"
state = u.load_state()
assert state["en_cours"] is None and state["dernier_rapport"]["ok"] is False
assert any(b["image"] == ref("v2") and b["version"] == "2.0.0" for b in state["bloquees"])
print(f"3. échec sur le 2e agent : les deux reviennent en v1 avec leurs données d'avant la migration, propriétaires "
      f"gardés, version bloquée ({took:.0f} s)")

# 4. Version bloquée : pas réessayée seule ; un clic (force) la retente.
rep = u.apply(*signed({"hermes": ref("v2")}))
assert rep["composants"].get("hermes") == "bloquee" and not rep["ok"] and "échoué" in rep["erreur"] and {n: image_of(n) for n in AGENTS} == v1, rep
print("4. version bloquée : pas réessayée toute seule")

# 5. Version saine : tout passe, les anciens partent, les agents à venir sont épinglés.
rep = u.apply(*signed({"hermes": ref("v1b")}, version="2.0.1"))
assert rep["ok"], rep
for name in AGENTS:
    assert c.containers.get(name).image.id == c.images.get(ref("v1b")).id
    try:
        c.containers.get(name + "-ancien")
        sys.exit("ancien conteneur resté")
    except docker.errors.NotFound:
        pass
assert u.pinned("hermes", "x") == ref("v1b")
print("5. version saine : les deux agents passent, anciens retirés, prochains agents épinglés")

# 6. Coupure brutale en plein remplacement (journal laissé par la transaction), puis redémarrage du lanceur.
snap = "/backups/maj-coupure/noahtest-agent-a"
u.backup(["noahtest-agent-a-data"], snap)
u.recreate("noahtest-agent-a", ref("v2"))  # la v2 a migré la base de a…
time.sleep(3)
u.update_state(lambda s: s.update(en_cours={"version": "2.0.2", "remplaces": [], "courant": {"nom": "noahtest-agent-a", "sauvegarde": snap}}))
u.recover()  # … et le serveur s'est arrêté net
a = c.containers.get("noahtest-agent-a")
assert a.image.id == c.images.get(ref("v1b")).id and a.status == "running" and "migre" not in schema("noahtest-agent-a")
assert u.load_state()["en_cours"] is None and "interrompue" in u.load_state()["dernier_rapport"]["erreur"]
print("6. coupure en plein remplacement : au redémarrage, ancienne version et données d'avant")

# 7. Sauvegarde impossible (volume des sauvegardes en lecture seule ≈ disque plein) : erreur, rien d'écrit.
try:
    u._tool(["snapshot", "/backups/maj-x/y"], ["noahtest-agent-a-data"], folder_rw=False)
    sys.exit("la sauvegarde aurait dû échouer")
except RuntimeError:
    print("7. sauvegarde impossible : erreur levée avant tout changement")
reset()
