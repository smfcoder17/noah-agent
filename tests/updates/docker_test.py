"""Transaction de mise à jour sur de vrais conteneurs jetables (préfixe noahtest-), registre local compris.
Ne touche à aucun conteneur de Noah : la liste des composants est remplacée par les conteneurs du test.

    sh tests/updates/docker_test.sh
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "/tests/updates")
from harness import AGENTS, c, docker, ref, signed, u  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402


# Durées de production, lues dans le code sans aucun réglage de test. Le reste du test les réduit ; ce sont elles qui comptent.
TEST_SETTINGS = ("NOAH_UPDATE_HEALTH", "NOAH_UPDATE_OBSERVE", "NOAH_UPDATE_POLL", "NOAH_UPDATE_CADDY_DEADLINE", "NOAH_UPDATE_WATCHDOG")
READ = "import json, updater as u; print(json.dumps(dict(health=u.HEALTH, observe=u.OBSERVE, poll=u.POLL, caddy=u.CADDY_DEADLINE, relay=u.RELAY_TIMEOUT, watchdog=u.WATCHDOG)))"
PROD = json.loads(subprocess.run([sys.executable, "-c", READ], cwd="/l", capture_output=True, text=True, check=True,
                                 env={k: v for k, v in os.environ.items() if k not in TEST_SETTINGS}).stdout)
assert PROD == {"health": 120, "observe": 300, "poll": 5, "caddy": 20, "relay": 1800, "watchdog": 300}, PROD
SOURCE = open("/l/updater.py", encoding="utf-8").read()
STOP_NEW = int(re.search(r"c\.stop\(timeout=(\d+)\)  # arrêt propre", SOURCE).group(1))  # arrêt d'un conteneur remplacé
STOP_BAD = int(re.search(r"main\.stop\(timeout=(\d+)\)  # la version fautive", SOURCE).group(1))  # arrêt de la version fautive
assert (STOP_NEW, STOP_BAD) == (30, 20), (STOP_NEW, STOP_BAD)
assert u.HEALTH < PROD["health"] and u.OBSERVE < PROD["observe"] and u.POLL < PROD["poll"] and u.CADDY_DEADLINE < PROD["caddy"] and u.WATCHDOG < PROD["watchdog"]
print(f"0. durées de production dans le code : santé {PROD['health']} s, observation {PROD['observe']} s, un regard toutes les "
      f"{PROD['poll']} s, Caddy {PROD['caddy']} s, relais {PROD['relay']} s, surveillance {PROD['watchdog']} s, arrêts {STOP_NEW} et {STOP_BAD} s ; ce test les réduit")

ROLLBACK_BUDGET = 300  # un retour arrière doit tenir en moins de 5 min avec les délais de production
# L'échec sur le 2e agent, en production : 2 arrêts à l'aller, 2 au retour, tout le délai de santé sur b, et 3 démarrages sains
# (a à l'aller, les deux au retour), chacun 3 réponses à POLL d'écart.
SCENARIO_WAITS = 2 * STOP_NEW + 2 * STOP_BAD + PROD["health"] + 3 * 2 * PROD["poll"]


def rollback_time(took: float, budget: float = ROLLBACK_BUDGET) -> float:
    """Le temps mesuré (gestes réels), plus les attentes que ce test a réduites : ce que ce retour arrière prendrait en production."""
    projected = took - u.HEALTH + SCENARIO_WAITS
    assert projected < budget, f"retour arrière trop long : {projected:.0f} s"
    return projected


# sync() attend tous les disques de la machine : un montage figé bloquerait la mise à jour, l'agent arrêté (vu en vrai).
assert "os.sync()" not in open(u.__file__, encoding="utf-8").read()


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


def both(work):
    """Le même geste sur les deux agents en même temps : chacun lance son conteneur, sans attendre l'autre."""
    with ThreadPoolExecutor(len(AGENTS)) as pool:
        return list(pool.map(work, AGENTS))


def prepare(name):
    remove(name)
    remove(name + "-ancien")
    try:
        c.volumes.get(f"{name}-data").remove(force=True)
    except docker.errors.NotFound:
        pass
    sh(f"{name}-data", "python -c \"import sqlite3; t=sqlite3.connect('/data/temoin.db'); "
       "t.execute('CREATE TABLE temoin (id INTEGER PRIMARY KEY, v TEXT)'); "
       "t.executemany('INSERT INTO temoin VALUES (?, ?)', [(i, str(i * 7)) for i in range(1000)]); t.commit()\" && "
       "mkdir -p /data/espace/partage && echo bonjour > /data/espace/note.txt && "
       "touch /data/espace/voyage-journal && chown -R 1000:1000 /data/espace && chmod 2775 /data/espace/partage")
    c.containers.run(f"{os.environ['REGISTRY']}/noahtest/app:v1", name=name, hostname=name, detach=True,
                     network="noahtest-net", volumes={f"{name}-data": {"bind": "/data"}},
                     restart_policy={"Name": "unless-stopped"})


def start_fleet():
    reset_state()
    both(prepare)
    for name in AGENTS:
        assert u.healthy(name, 30), f"{name} ne démarre pas"
    time.sleep(0.3)  # les bases s'écrivent (WAL)


def fleet_is(tag, migrated=False):
    def check(name):
        cont = c.containers.get(name)
        assert cont.image.id == img(tag) and cont.status == "running", (name, cont.image.tags, cont.status)
        assert u._get(name + "-ancien") is None, f"{name}-ancien resté"
        # Schéma, témoins et fichiers dans un seul conteneur : démarrer un conteneur par question coûte plus que la question.
        s, witness, files = sh(f"{name}-data", "python -c \"import sqlite3; d=sqlite3.connect('/data/state.db'); "
                               "print([r[1] for r in d.execute('PRAGMA table_info(t)')], d.execute('PRAGMA integrity_check').fetchone()[0]); "
                               "t=sqlite3.connect('/data/temoin.db'); print(t.execute('SELECT count(*), sum(id) FROM temoin').fetchone())\" && "
                               "stat -c '%u:%g %a' /data/espace/note.txt /data/espace/partage && ls /data/espace").split("\n", 2)
        assert s.endswith("ok") and (("migre" in s) == migrated), (name, s)
        assert witness == "(1000, 499500)", (name, "témoins perdus ou en trop", witness)
        assert "1000:1000" in files and "2775" in files and "voyage-journal" in files, (name, files)
    both(check)


def done_tx():
    s = u.load_state()
    assert s.get("en_cours") is None, s.get("en_cours")
    return s


# 1. Signature d'une autre clé : refusée (par le chemin de l'API aussi), écrite à l'historique, rien ne bouge.
start_fleet()
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.0.0", key=Ed25519PrivateKey.generate()))
assert not rep["ok"] and "refusé" in rep["erreur"], rep
try:
    u.verify_logged(*signed({"hermes": ref("app", "v2")}, "2.0.0", key=Ed25519PrivateKey.generate()))
    sys.exit("signature acceptée")
except ValueError:
    pass
assert sum("Manifeste refusé" in h["texte"] for h in u.load_state()["historique"]) >= 2
fleet_is("v1")
print("1. manifeste signé par une autre clé : refusé, rien n'a bougé")

# 2. Image introuvable dans le registre : rien ne commence.
rep = u.apply(*signed({"hermes": f"{os.environ['REGISTRY']}/noahtest/app@sha256:" + "0" * 64}, "2.0.0"))
assert not rep["ok"] and "Téléchargement" in rep["erreur"], rep
fleet_is("v1")
done_tx()
print("2. image introuvable : rien n'a commencé")

# 3. La v2 migre le schéma, passe sur l'agent a (canari), échoue sur b : TOUT revient, conteneurs et données.
# Le délai de santé est court ici : le temps mesuré est ramené aux délais de production, qui doivent tenir en moins de 5 min.
t0 = time.time()
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.0.0"))
took = time.time() - t0
assert took >= u.HEALTH, f"le délai de santé n'a pas été attendu : {took:.0f} s"
projected = rollback_time(took)
try:  # budget plus court que le délai de santé : le retour arrière est trop long, et ça se voit
    rollback_time(took, budget=SCENARIO_WAITS)
    sys.exit("retour arrière trop long pas détecté")
except AssertionError as e:
    assert "trop long" in str(e), e
assert not rep["ok"] and not rep["non_restaures"], rep
fleet_is("v1")
s = done_tx()
assert any(b["image"] == ref("app", "v2") and b["version"] == "2.0.0" for b in s["bloquees"])
print(f"3. échec sur le 2e agent : les deux reviennent en v1 avec leurs données d'avant la migration, propriétaires, "
      f"droits (setgid) et fichiers en -journal gardés ; version bloquée ({took:.0f} s mesurées, {projected:.0f} s avec les délais de production, "
      f"< {ROLLBACK_BUDGET} s ; dépassement détecté avec un budget court)")

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
start_fleet()
for step in ["arret", "arrete", "sauve", "renomme", "cree", "demarre", "observation"]:
    reset_state()  # la flotte vient de revenir et d'être vérifiée : chaque coupure repart de données déjà restaurées
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
for n in AGENTS:  # docker inspect : chaque conteneur tourne sur la référence signée, par empreinte
    cfg_image = c.containers.get(n).attrs["Config"]["Image"]
    assert cfg_image == ref("app", "v1b"), (n, cfg_image)
print(f"8. version saine : les deux agents passent, coupure la plus longue {worst:.1f} s (< 60 s), anciens retirés")

# 9. Sauvegarde impossible (volume des sauvegardes de 64 Ko, agent avec 300 Ko incompressibles : disque plein) :
# rien n'est bloqué, tout revient. (Un volume tmpfs est neuf à chaque montage : seule l'écriture est testée.)
start_fleet()
sh("noahtest-agent-a-data", "head -c 300000 /dev/urandom > /data/espace/gros.bin")
u.BACKUP_VOLUME = "noahtest-tiny"
pre = u.apply(*signed({"hermes": ref("app", "v2")}, "2.4.0"))
assert not pre["ok"] and "Place disque" in pre["erreur"], pre  # la vérification de place l'aurait arrêtée avant
u.SPACE_MARGIN = -(1 << 62)  # … on la désactive pour tester l'écriture qui échoue en plein milieu
rep = u.apply(*signed({"hermes": ref("app", "v2")}, "2.4.0"))
u.SPACE_MARGIN = 512 * 1024 * 1024
u.BACKUP_VOLUME = os.environ["NOAH_BACKUP_VOLUME"]
assert not rep["ok"] and "sauvegarde" in rep["erreur"], rep
fleet_is("v1")
s = done_tx()
assert not any(b["version"] == "2.4.0" for b in s["bloquees"])
print("9. disque des sauvegardes plein : refusé d'avance par la vérification de place ; et si l'écriture échoue quand même en plein milieu, rien n'a changé, rien de bloqué")

# 9 bis. Pas assez de place pour l'instantané ET la restauration : refusé avant de toucher à quoi que ce soit.
reset_state()  # flotte revenue et vérifiée à l'étape précédente
u.SPACE_MARGIN = 1 << 60
rep = u.apply(*signed({"hermes": ref("app", "v1b")}, "2.4.1"))
u.SPACE_MARGIN = 512 * 1024 * 1024
assert not rep["ok"] and "Place disque" in rep["erreur"], rep
fleet_is("v1")
done_tx()
print("9 bis. place disque insuffisante (vérifiée avant) : rien n'a commencé")

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
assert "noahtest-agent-a" in u.load_state()["gardes"]
rep = u.apply(*signed({"hermes": ref("app", "v1b")}, "2.6.0"))  # les mises à jour reprennent, sans toucher au gardé
assert rep["ok"] is True, rep
a = c.containers.get("noahtest-agent-a")
assert a.image.id == img("v1") and a.status != "running" and "migre" in schema("noahtest-agent-a")
assert c.containers.get("noahtest-agent-b").image.id == img("v1b") and c.containers.get("noahtest-agent-b").status == "running"
done_tx()
u.resolve("liberer")
assert not u.load_state().get("gardes")
print("10. intervention : « réessayer » refait la restauration (toujours impossible), « garder » ferme le journal ; la mise à jour suivante passe sans toucher au conteneur gardé ; « libérer » le rend")

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

# 13. Journal en retard sur la réalité : l'ancien conteneur a disparu après une coupure. La reprise recrée l'ancienne
# version sur son image d'avant (gardée au journal) et remet ses données d'avant.
start_fleet()
run = subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v3", "2.9.0"],
                     env=dict(os.environ, NOAH_TEST_CRASH_AT="demarre"), capture_output=True, text=True)
assert run.returncode == 137
assert any("migre" in schema("noahtest-agent-a") or time.sleep(0.5) for _ in range(30)), "la v3 n'a pas migré les données de a"
c.containers.get("noahtest-agent-a-ancien").remove(force=True)
u.recover()
fleet_is("v1")
done_tx()
print("13. ancien conteneur disparu : recréé sur l'image d'avant, données d'avant remises (témoins exacts)")

# 14. Le canari échoue : les agents jamais touchés ne sont ni arrêtés ni redémarrés (pas de coupure inutile).
reset_state()  # flotte revenue et vérifiée à l'étape précédente
started = c.containers.get("noahtest-agent-b").attrs["State"]["StartedAt"]
rep = u.apply(*signed({"hermes": ref("app", "v4")}, "3.0.0"))
assert not rep["ok"], rep
fleet_is("v1")
assert c.containers.get("noahtest-agent-b").attrs["State"]["StartedAt"] == started, "agent jamais touché redémarré"
done_tx()
print("14. canari en échec : l'agent jamais touché n'a pas été arrêté ni redémarré")

# 15. Coupure pendant la recréation de l'ancienne version (nom de côté « -neuf ») : reprise depuis ce nom.
reset_state()  # flotte revenue et vérifiée à l'étape précédente
subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v3", "3.1.0"],
               env=dict(os.environ, NOAH_TEST_CRASH_AT="demarre"), capture_output=True)
c.containers.get("noahtest-agent-a-ancien").remove(force=True)
run = subprocess.run([sys.executable, "/tests/updates/crash_child.py", "recover"],
                     env=dict(os.environ, NOAH_TEST_CRASH_AT="neuf-renomme"), capture_output=True, text=True)
assert run.returncode == 137 and u._get("noahtest-agent-a") is None and u._get("noahtest-agent-a-neuf"), run.stderr[-300:]
u.recover()
fleet_is("v1")
assert u._get("noahtest-agent-a-neuf") is None
done_tx()
print("15. coupure pendant la recréation de l'ancienne version : reprise depuis « -neuf », données d'avant, témoins exacts")

# 16. Instantané attendu mais perdu (inventaire supprimé) alors que la nouvelle version a tourné : pas de démarrage
# sur des données inconnues, intervention.
reset_state()  # flotte revenue et vérifiée à l'étape précédente
subprocess.run([sys.executable, "/tests/updates/crash_child.py", "v3", "3.2.0"],
               env=dict(os.environ, NOAH_TEST_CRASH_AT="demarre"), capture_output=True)
snap = u.load_state()["en_cours"]["elements"][0]["sauvegarde"]
sh("noahtest-backups", f"rm /data/{snap.split('/backups/', 1)[1]}/inventaire.json")
u.recover()
s = u.load_state()
assert s["en_cours"]["phase"] == "intervention" and s["en_cours"]["non_restaures"] == ["noahtest-agent-a"], s["en_cours"]
assert c.containers.get("noahtest-agent-a").status != "running"
u.resolve("garder")
u.resolve("liberer")
print("16. instantané perdu après le démarrage de la nouvelle version : intervention, l'agent n'est pas démarré")

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
