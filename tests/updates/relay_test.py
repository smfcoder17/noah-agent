"""Le lanceur remplacé par son relais, de bout en bout, sur un lanceur jetable (noahtest-launcher)."""
import base64
import json
import os
import sys
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

KEY = Ed25519PrivateKey.from_private_bytes(base64.b64decode(os.environ["TEST_PRIVATE_KEY"]))
os.environ["NOAH_UPDATE_KEY"] = base64.b64encode(
    KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
sys.path.insert(0, "/l")
import docker  # noqa: E402
import updater as u  # noqa: E402

c = docker.from_env()
REG, NAME = os.environ["REGISTRY"], "noahtest-launcher"
u.LAUNCHER = NAME
u.components = lambda: {"noah-launcher": [NAME]}


def ref(tag: str) -> str:
    return next(d for d in c.images.get(f"{REG}/noahtest/launcher:{tag}").attrs["RepoDigests"] if d.startswith(REG))


def signed(image: str, version: str) -> tuple[bytes, str]:
    raw = json.dumps({"version": version, "images": {"noah-launcher": image}}).encode()
    return raw, base64.b64encode(KEY.sign(raw)).decode()


def wait_relay(seconds: int = 400) -> dict:
    deadline = time.time() + seconds
    while time.time() < deadline:
        state = u.load_state()
        if "relais" not in state and state.get("dernier_rapport", {}).get("composants", {}).get("noah-launcher") in ("fait", "retour_arriere"):
            return state
        time.sleep(5)
    sys.exit("le relais n'a pas fini")


def launcher(tag: str):
    for n in (NAME, NAME + "-ancien", u.RELAY):
        try:
            c.containers.get(n).remove(force=True)
        except docker.errors.NotFound:
            pass
    c.containers.run(f"{REG}/noahtest/launcher:{tag}", name=NAME, detach=True, network="noahtest-net",
                     environment={"LAUNCHER_KEY": "test", "AGENT_NETWORK": "noahtest-net", "NOAH_LAUNCHER_NAME": NAME,
                                  "NOAH_UPDATE_KEY": os.environ["NOAH_UPDATE_KEY"]},
                     volumes={"/var/run/docker.sock": {"bind": "/var/run/docker.sock"}, "noahtest-state": {"bind": "/state"}},
                     restart_policy={"Name": "unless-stopped"})
    assert u.healthy(NAME, 60), "le lanceur de test ne démarre pas"


# 1. Nouvelle version saine : le relais remplace le lanceur, puis se désactive.
launcher("a")
rep = u.apply(*signed(ref("b"), "3.0.0"))
assert rep["ok"] and rep["composants"]["noah-launcher"] == "en_cours", rep
state = wait_relay()
assert state["dernier_rapport"]["ok"], state["dernier_rapport"]
new = c.containers.get(NAME)
assert new.image.id == c.images.get(ref("b")).id and new.status == "running"
assert u.healthy(NAME, 30)
relay = c.containers.get(u.RELAY)
assert relay.attrs["HostConfig"]["RestartPolicy"]["Name"] == "no"
try:
    c.containers.get(NAME + "-ancien")
    sys.exit("ancien lanceur resté")
except docker.errors.NotFound:
    pass
print("1. lanceur remplacé par le relais, ancien retiré, relais désactivé")

# 2. Nouvelle version cassée : le relais remet l'ancien lanceur et bloque la version.
launcher("a")
rep = u.apply(*signed(ref("casse"), "3.0.1"))
state = wait_relay()
assert not state["dernier_rapport"]["ok"]
back = c.containers.get(NAME)
assert back.image.id == c.images.get(ref("a")).id and back.status == "running"
assert any(b["image"] == ref("casse") for b in state["bloquees"])
print("2. lanceur cassé : le relais remet l'ancien, version bloquée")

for n in (NAME, NAME + "-ancien", u.RELAY):
    try:
        c.containers.get(n).remove(force=True)
    except docker.errors.NotFound:
        pass
