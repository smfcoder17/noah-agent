"""Le lanceur remplacé par son relais, de bout en bout, sur un lanceur jetable (noahtest-launcher)."""
import os
import sys
import time

sys.path.insert(0, "/tests/updates")
from harness import c, docker, ref, signed, u  # noqa: E402

NAME = u.LAUNCHER  # noahtest-launcher
u.components = lambda: {"noah-launcher": [NAME]}


def remove(name):
    try:
        c.containers.get(name).remove(force=True)
    except docker.errors.NotFound:
        pass


def wait_tx(seconds=600):
    deadline = time.time() + seconds
    while time.time() < deadline:
        s = u.load_state()
        final = (s.get("dernier_rapport") or {}).get("composants", {}).get("noah-launcher") != "en_cours"  # le rapport de fin suit la fermeture du journal
        relay = u._get(u.RELAY)
        if s.get("en_cours") is None and final and relay and relay.attrs["HostConfig"]["RestartPolicy"]["Name"] == "no":
            return s
        time.sleep(0.5)
    sys.exit(f"transaction pas finie : {u.load_state().get('en_cours')}")


def launcher(tag):
    for n in (NAME, NAME + "-ancien", u.RELAY):
        remove(n)
    for p in u.STATE.parent.glob("*"):
        if p.is_file():
            p.unlink()
    c.containers.run(f"{os.environ['REGISTRY']}/noahtest/launcher:{tag}", name=NAME, detach=True, network="noahtest-net",
                     environment={"LAUNCHER_KEY": "test", "AGENT_NETWORK": "noahtest-net", "NOAH_LAUNCHER_NAME": NAME,
                                  "NOAH_RELAY_NAME": u.RELAY, "NOAH_UPDATE_KEY": os.environ["NOAH_UPDATE_KEY"],
                                  "NOAH_UPDATE_POLL": os.environ["NOAH_UPDATE_POLL"], "NOAH_UPDATE_WATCHDOG": os.environ["NOAH_UPDATE_WATCHDOG"]},
                     volumes={"/var/run/docker.sock": {"bind": "/var/run/docker.sock"}, "noahtest-state": {"bind": "/state"}},
                     restart_policy={"Name": "unless-stopped"})
    assert u.healthy(NAME, 60), "le lanceur de test ne démarre pas"


def check(tag):
    new = c.containers.get(NAME)
    assert new.image.id == c.images.get(ref("launcher", tag)).id and new.status == "running", new.image.tags
    assert u._get(NAME + "-ancien") is None
    relay = c.containers.get(u.RELAY)
    assert relay.attrs["HostConfig"]["RestartPolicy"]["Name"] == "no"
    assert relay.image.id == c.images.get(ref("launcher", "a")).id, "le relais doit tourner sur l'ancienne image"


# 1. Nouvelle version saine : le relais remplace le lanceur, l'observe, valide, se désactive.
launcher("a")
rep = u.apply(*signed({"noah-launcher": ref("launcher", "b")}, "3.0.0"))
assert rep["ok"] and rep["composants"]["noah-launcher"] == "en_cours", rep
s = wait_tx()
assert s["dernier_rapport"]["ok"] and s["version_max"] == "3.0.0", s["dernier_rapport"]
check("b")
print("1. lanceur remplacé par le relais, observé, ancien retiré, relais désactivé")

# 2. Nouvelle version cassée : le relais remet l'ancien lanceur et bloque la version.
launcher("a")
rep = u.apply(*signed({"noah-launcher": ref("launcher", "casse")}, "3.0.1"))
s = wait_tx()
assert not s["dernier_rapport"]["ok"] and any(b["image"] == ref("launcher", "casse") for b in s["bloquees"]), s
check("a")
print("2. lanceur cassé : le relais remet l'ancien, version bloquée")

# 3. Le relais meurt net (kill -9) après avoir renommé l'ancien lanceur : Docker le relance, il termine.
for step in ("relais-arrete", "relais-renomme", "relais-cree", "relais-demarre"):
    launcher("a")
    os.environ["NOAH_TEST_CRASH_RELAY"] = step
    rep = u.apply(*signed({"noah-launcher": ref("launcher", "b")}, "3.1.0"))
    del os.environ["NOAH_TEST_CRASH_RELAY"]
    s = wait_tx()
    assert s["dernier_rapport"]["ok"], (step, s["dernier_rapport"])
    assert c.containers.get(u.RELAY).attrs["RestartCount"] >= 1, "le relais n'a pas été coupé"
    check("b")
    print(f"3. relais coupé à l'étape « {step} » : relancé par Docker, il termine la mise à jour")

for n in (NAME, NAME + "-ancien", u.RELAY):
    remove(n)
