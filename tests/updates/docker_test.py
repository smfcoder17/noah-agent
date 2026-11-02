"""Transaction de mise à jour sur de vrais conteneurs jetables (préfixe noahtest-), registre local compris.
Ne touche à aucun conteneur de Noah : la liste des composants est remplacée par les conteneurs du test.

    sh tests/updates/docker_test.sh
"""
import os
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, "/tests/updates")
from harness import AGENTS, c, docker, ref, signed, u  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402


def reset_state():
    for p in u.STATE.parent.glob("*"):
        if p.is_file():
            p.unlink()


def remove(name):
    try:
        c.containers.get(name).remove(force=True)
    except docker.errors.NotFound:
        pass


def sh(volume, script):
    box = c.containers.run("python:3.12-slim", ["sh", "-c", script], volumes={volume: {"bind": "/data"}}, detach=True)
    box.wait()
    out = box.logs().decode().strip()
    box.remove()
    return out


def schema(name):
    return sh(f"{name}-data", "python -c \"import sqlite3; d=sqlite3.connect('/data/state.db'); "
              "print([r[1] for r in d.execute('PRAGMA table_info(t)')], d.execute('PRAGMA integrity_check').fetchone()[0])\"")


def image_of(name):
    return c.containers.get(name).image.id


def img(tag):
    return c.images.get(ref("app", tag)).id


def start_fleet():
    reset_state()
    for name in AGENTS:
        remove(name)
        remove(name + "-ancien")
        try:
            c.volumes.get(f"{name}-data").remove(force=True)
        except docker.errors.NotFound:
            pass
        sh(f"{name}-data", "mkdir -p /data/espace/partage && echo bonjour > /data/espace/note.txt && "
           "touch /data/espace/voyage-journal && chown -R 1000:1000 /data/espace && chmod 2775 /data/espace/partage")
        c.containers.run(f"{os.environ['REGISTRY']}/noahtest/app:v1", name=name, hostname=name, detach=True,
                         network="noahtest-net", volumes={f"{name}-data": {"bind": "/data"}},
                         restart_policy={"Name": "unless-stopped"})
    for name in AGENTS:
        assert u.healthy(name, 30), f"{name} ne démarre pas"
    time.sleep(2)  # les bases s'écrivent (WAL)


def fleet_is(tag, migrated=False):
    for name in AGENTS:
        cont = c.containers.get(name)
        assert cont.image.id == img(tag) and cont.status == "running", (name, cont.image.tags, cont.status)
        assert u._get(name + "-ancien") is None, f"{name}-ancien resté"
        s = schema(name)
        assert s.endswith("ok") and (("migre" in s) == migrated), (name, s)
        files = sh(f"{name}-data", "stat -c '%u:%g %a' /data/espace/note.txt /data/espace/partage && ls /data/espace")
        assert "1000:1000" in files and "2775" in files and "voyage-journal" in files, (name, files)


def done_tx():
    s = u.load_state()
    assert s.get("en_cours") is None, s.get("en_cours")
    return s


# 1. Signature d'une autre clé : refusée, rien ne bouge.
start_fleet()
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.0.0", key=Ed25519PrivateKey.generate()))
assert not rep["ok"] and "refusé" in rep["erreur"], rep
fleet_is("v1")
print("1. manifeste signé par une autre clé : refusé, rien n'a bougé")

# 2. Image introuvable dans le registre : rien ne commence.
rep = u.apply(*signed({"hermes": f"{os.environ['REGISTRY']}/noahtest/app@sha256:" + "0" * 64}, "2.0.0"))
assert not rep["ok"] and "Téléchargement" in rep["erreur"], rep
fleet_is("v1")
done_tx()
print("2. image introuvable : rien n'a commencé")

# 3. La v2 migre le schéma, passe sur l'agent a (canari), échoue sur b : TOUT revient, conteneurs et données.
# Avec le vrai délai de santé (120 s) : le retour arrière doit tenir en moins de 5 min.
u.HEALTH = 120
t0 = time.time()
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.0.0"))
took = time.time() - t0
u.HEALTH = int(os.environ["NOAH_UPDATE_HEALTH"])
assert took < 300, f"retour arrière trop long : {took:.0f} s"
assert not rep["ok"] and not rep["non_restaures"], rep
fleet_is("v1")
s = done_tx()
assert any(b["image"] == ref("app", "v2") and b["version"] == "2.0.0" for b in s["bloquees"])
print(f"3. échec sur le 2e agent : les deux reviennent en v1 avec leurs données d'avant la migration, propriétaires, "
      f"droits (setgid) et fichiers en -journal gardés ; version bloquée ({took:.0f} s avec le vrai délai de santé de 120 s, < 300 s)")

# 4. Version bloquée : pas réessayée seule.
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.0.0"))
assert not rep["ok"] and "échoué" in rep["erreur"], rep
fleet_is("v1")
print("4. version bloquée : pas réessayée toute seule")

# 5. Une version plus ancienne qu'une version déjà installée est refusée par le lanceur lui-même.
u.update_state(lambda s: s.update(version_max="2.5.0"))
rep = u.apply(*signed({"hermes": ref("app", "v1b")}, "2.4.9"))
assert not rep["ok"] and "plus ancienne" in rep["erreur"], rep
u.update_state(lambda s: s.update(version_max="2.0.0"))
fleet_is("v1")
print("5. manifeste rejoué plus ancien : refusé par le lanceur")

# 6. Coupure nette (os._exit, comme kill -9) à chaque étape, puis redémarrage du lanceur (recover).
for step in ["arret", "arrete", "sauve", "renomme", "cree", "demarre", "observation"]:
    start_fleet()
    env = dict(os.environ, NOAH_TEST_CRASH_AT=step)
    run = subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v3", "2.1.0"], env=env, capture_output=True, text=True)
    assert run.returncode == 137, (step, run.returncode, run.stdout[-300:], run.stderr[-300:])
    u.recover()
    fleet_is("v1")
    done_tx()
    print(f"6. coupure à l'étape « {step} » : au redémarrage, les deux agents en v1, données d'avant, journal fermé")

# 7. Coupure pendant la validation : la reprise la termine (pas de retour en arrière après le point de non-retour).
start_fleet()
run = subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v1b", "2.2.0"],
                     env=dict(os.environ, NOAH_TEST_CRASH_AT="validation"), capture_output=True, text=True)
assert run.returncode == 137, run.stderr[-300:]
u.recover()
fleet_is("v1b")
s = done_tx()
assert s["version_max"] == "2.2.0" and s["images"]["hermes"] == ref("app", "v1b")
print("7. coupure pendant la validation : terminée au redémarrage, les deux agents en v1b")

# 8. Mise à jour saine : coupure par agent mesurée, anciens retirés, prochains agents épinglés.
start_fleet()
outage = {n: [0.0, None] for n in AGENTS}
stop = threading.Event()


def watch():
    while not stop.is_set():
        for n in AGENTS:
            try:
                ok = urllib.request.urlopen(f"http://{n}:8000/health", timeout=1).status == 200
            except Exception:  # noqa: BLE001
                ok = False
            down_since = outage[n][1]
            if not ok and down_since is None:
                outage[n][1] = time.time()
            elif ok and down_since is not None:
                outage[n][0] = max(outage[n][0], time.time() - down_since)
                outage[n][1] = None
        time.sleep(0.3)


t = threading.Thread(target=watch, daemon=True)
t.start()
rep = u.apply(*signed({"hermes": ref("app", "v1b")}, "2.3.0"))
stop.set()
t.join()
assert rep["ok"], rep
fleet_is("v1b")
worst = max(o[0] for o in outage.values())
assert worst < 60, outage
print(f"8. version saine : les deux agents passent, coupure la plus longue {worst:.1f} s (< 60 s), anciens retirés")

# 9. Sauvegarde impossible (volume des sauvegardes de 64 Ko, agent avec 300 Ko incompressibles : disque plein) :
# rien n'est bloqué, tout revient. (Un volume tmpfs est neuf à chaque montage : seule l'écriture est testée.)
start_fleet()
sh("noahtest-agent-a-data", "head -c 300000 /dev/urandom > /data/espace/gros.bin")
u.BACKUP_VOLUME = "noahtest-tiny"
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.4.0"))
u.BACKUP_VOLUME = os.environ["NOAH_BACKUP_VOLUME"]
assert not rep["ok"] and "sauvegarde" in rep["erreur"], rep
fleet_is("v1")
s = done_tx()
assert not any(b["version"] == "2.4.0" for b in s["bloquees"])
print("9. disque des sauvegardes plein : rien n'a changé, rien de bloqué")

# 10. Archive d'instantané abîmée au moment du retour arrière : le conteneur reste arrêté, le journal reste ouvert.
start_fleet()
env = dict(os.environ, NOAH_TEST_CRASH_AT="demarre")
subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v3", "2.5.0"], env=env, capture_output=True)
snap = u.load_state()["en_cours"]["elements"][0]["sauvegarde"]
sh("noahtest-backups", f"echo abime >> /data/{snap.split('/backups/', 1)[1]}/noahtest-agent-a-data.tar.gz")
u.recover()
s = u.load_state()
assert s["en_cours"]["phase"] == "intervention" and s["en_cours"]["non_restaures"] == ["noahtest-agent-a"], s["en_cours"]
assert c.containers.get("noahtest-agent-a").status != "running"
assert "migre" in schema("noahtest-agent-a")  # données migrées laissées en place, ancienne version pas démarrée dessus
assert s["dernier_rapport"]["non_restaures"] == ["noahtest-agent-a"]
print("10. archive abîmée : l'agent reste arrêté (pas d'ancienne version sur des données migrées), signalé")
rep = u.resolve("reessayer")
assert u.load_state()["en_cours"]["phase"] == "intervention" and c.containers.get("noahtest-agent-a").status != "running", u.load_state()["en_cours"]
assert "migre" in schema("noahtest-agent-a")
rep = u.resolve("garder")
assert u.load_state()["en_cours"] is None and c.containers.get("noahtest-agent-a").status != "running"
assert u.apply(*signed({"hermes": ref("app", "v1b")}, "2.6.0"))["ok"] is not None  # les mises à jour reprennent
print("10. intervention : « réessayer » refait la restauration (toujours impossible), « garder » ferme le journal")

# 11. Agent arrêté par l'utilisateur : recréé sur la nouvelle image et laissé arrêté, même coupé au milieu.
for crash in ("", "arrete-renomme"):
    start_fleet()
    c.containers.get("noahtest-agent-b").stop()
    if crash:
        run = subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v1b", "2.7.0"],
                             env=dict(os.environ, NOAH_TEST_CRASH_AT=crash), capture_output=True, text=True)
        assert run.returncode == 137, run.stderr[-300:]
        u.recover()
    else:
        assert u.apply(*signed({"hermes": ref("app", "v1b")}, "2.7.0"))["ok"]
    a, b = c.containers.get("noahtest-agent-a"), c.containers.get("noahtest-agent-b")
    assert a.image.id == img("v1b") and a.status == "running"
    assert b.image.id == img("v1b") and b.status != "running", (b.image.tags, b.status)
    assert u._get("noahtest-agent-b-ancien") is None and u._get("noahtest-agent-a-ancien") is None
    done_tx()
    print(f"11. agent arrêté par l'utilisateur : recréé sur la nouvelle image, laissé arrêté{' (coupure entre renommage et création)' if crash else ''}")

# 12. Coupure au milieu du retour arrière (pendant la restauration des données) : la reprise le termine.
start_fleet()
run = subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v2", "2.8.0"],
                     env=dict(os.environ, NOAH_TEST_CRASH_AT="restauration"), capture_output=True, text=True)
assert run.returncode == 137, (run.returncode, run.stdout[-300:])
assert u.load_state()["en_cours"]["phase"] == "retour_arriere"
u.recover()
fleet_is("v1")
done_tx()
print("12. coupure pendant le retour arrière : terminé au redémarrage, les deux agents en v1 avec leurs données")
for n in AGENTS:
    remove(n)
    remove(n + "-ancien")
