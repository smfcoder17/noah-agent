"""Le lanceur sur un petit VPS : Docker refuse une limite de CPU au-dessus des cœurs de la machine, et le navigateur ne démarrait jamais.

    docker run --rm -v "$PWD/launcher:/launcher:ro" -v "$PWD/tests:/tests:ro" python:3.12-slim sh -c \
      "pip install -q fastapi pydantic httpx && python /tests/agents/petit_vps_test.py"
"""
import os
import sys
import tempfile
from unittest.mock import MagicMock

docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
os.environ.update(LAUNCHER_KEY="k", AGENT_NETWORK="reseau", NOAH_UPDATES_DIR=tempfile.mkdtemp())
sys.path.insert(0, "/launcher")
import launcher  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

for path in ("/openapi.json", "/docs", "/redoc"):
    assert TestClient(launcher.app).get(path).status_code == 404, f"le lanceur décrit ses routes sans clé : {path}"
print("le lanceur ne décrit pas ses routes")

client = launcher.client
launcher.updater.put_env = lambda *a, **k: None
client.containers.get.side_effect = docker.errors.NotFound()
vrai_container = launcher.container  # remise en place au test 12
launcher.container = lambda agent_id: None


def limits(cores):
    client.info.return_value = {"NCPU": cores}
    launcher._cores.cache_clear()
    client.containers.create.reset_mock()
    launcher._run_agent("essai", "k", [])
    agent = client.containers.create.call_args.kwargs["nano_cpus"]
    client.containers.create.reset_mock()

    class Created(Exception):
        pass

    client.containers.create.return_value.get_archive.side_effect = Created()  # la suite (fichiers à déposer) ne sert pas ici
    try:
        launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b"))
    except Created:
        pass
    browser = client.containers.create.call_args.kwargs["nano_cpus"]
    client.containers.create.return_value.get_archive.side_effect = None
    return agent / 1e9, browser / 1e9


assert limits(2) == (2, 2), "VPS à 2 cœurs : Docker refuse 4 CPU pour le navigateur"
assert limits(1) == (1, 1), "VPS à 1 cœur"
assert limits(16) == (2, 4), "grosse machine : les limites voulues"
print("1. les limites de CPU ne dépassent jamais les cœurs de la machine")

client.info.side_effect = RuntimeError("Docker occupé")
launcher._cores.cache_clear()
assert launcher._cpus(4) == 4_000_000_000
client.info.side_effect = None
print("2. nombre de cœurs illisible : la limite voulue")

client.images.get.side_effect = docker.errors.NotFound()
client.images.pull.reset_mock()
launcher._prefetch_images()
pulled = [c.args[0] for c in client.images.pull.call_args_list]
assert launcher.IMAGE in pulled and launcher.BROWSER_IMAGE in pulled, pulled
client.images.get.side_effect = None
print("3. les deux images sont préchargées : le premier usage du navigateur ne fige pas l'agent plusieurs minutes")

web = TestClient(launcher.app, raise_server_exceptions=False, headers={"x-launcher-key": "k", "Authorization": "Bearer k"})


@launcher.app.get("/essai-docker")
def refused():
    raise docker.errors.APIError("range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available")


r = web.get("/essai-docker")
assert r.status_code == 502 and "range of CPUs" in r.json()["detail"], r.text
print("4. un refus de Docker est rendu avec sa raison")

# 4. Lecture d'un fichier : aucun lien suivi, même dans un dossier intermédiaire. Le script tourne ici comme dans l'agent.
import pathlib  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402

base = pathlib.Path(tempfile.mkdtemp())
secret = base / "google_token.json"
secret.write_text("SECRET")
work = base / "workspace"
(work / "apps/jeu").mkdir(parents=True)
(work / "apps/jeu/index.html").write_text("page")
(work / "apps/jeu/assets").symlink_to(base)
(work / "apps/jeu/lien.txt").symlink_to(secret)
os.mkfifo(work / "tube")
(work / "gros.bin").write_bytes(b"x" * 2000)


def run(rel, limit=1000):
    r = subprocess.run([sys.executable, "-c", launcher.READ_NO_LINK, str(work), rel, str(limit)], capture_output=True, timeout=10)
    return r.returncode, r.stdout


assert run("apps/jeu/index.html") == (0, b"page")
assert run("apps/jeu/assets/google_token.json")[0] == 45, "lien dans un dossier intermédiaire"
assert run("apps/jeu/lien.txt")[0] == 45, "lien en dernier"
assert run("tube")[0] == 45, "pas un fichier"
assert run("absent.txt")[0] == 44 and run("apps/absent/x")[0] == 44
assert run("gros.bin")[0] == 46
linked = base / "racine-lien"
linked.symlink_to(base)
r = subprocess.run([sys.executable, "-c", launcher.READ_NO_LINK, str(linked), "google_token.json", "1000"], capture_output=True, timeout=10)
assert r.returncode == 45 and b"SECRET" not in r.stdout, "une racine remplacée par un lien"
r = subprocess.run([sys.executable, "-c", launcher.READ_NO_LINK, str(work) + "/", "apps/jeu/index.html", "1000"], capture_output=True, timeout=10)
assert r.returncode == 0 and r.stdout == b"page", "une racine écrite avec une barre finale"
print("4. lecture : aucun lien suivi, ni fichier spécial ; trop lourd et absent reconnus")

launcher.SHARE_ROOTS[:] = ["/home/moi", "C:/Users/Moi"]
folder = lambda chemin, ecriture: launcher.Folder(nom="d", chemin=chemin, ecriture=ecriture)
for chemin in ("/home/moi", "/home/moi/", "c:\\users\\moi"):
    try:
        launcher._check_folders([folder(chemin, True)])
        sys.exit(f"écriture acceptée sur toute la racine : {chemin}")
    except launcher.HTTPException as e:
        assert e.status_code == 403, e
assert launcher._check_folders([folder("/home/moi", False)]) and launcher._check_folders([folder("/home/moi/projet", True)]), "lecture de la racine, ou écriture d'un sous-dossier, refusée"
for chemin in ("/home/moi/.bashrc", "/home/moi/.profile", "/home/moi/.gitconfig", "/home/moi/.local/share", "/home/moi/Library/LaunchAgents", "/home/moi/.config/autostart", "C:/Users/Moi/AppData/Roaming"):
    assert not launcher._shareable(chemin), f"partageable : {chemin}"
assert launcher._shareable("/home/moi/profile"), "un dossier nommé comme un fichier sensible, sans le point, reste partageable"
print("5. dossiers : pas d'écriture sur une racine entière, ni rien de ce qui s'exécute à l'ouverture d'une session")

client.containers.create.reset_mock()
client.containers.create.side_effect = None
launcher._run_agent("hote", "k", [])
assert "extra_hosts" not in client.containers.create.call_args.kwargs, "l'agent reçoit un nom pour joindre l'hôte"
print("6. un agent n'a pas de nom pour joindre l'hôte : c'est le serveur qui parle à un modèle local")

# --- 0.1.8 ---
import threading  # noqa: E402

# 7. Régression 0.1.7 : le serveur dépose applications_extra.py avec la config ; le lanceur le refusait, et toute
# configuration d'agent échouait (« Fichier non autorisé »).
depot = MagicMock(name="agent")
launcher.container = lambda agent_id: depot
r = web.put("/agents/essai/files", json={"files": {"config.yaml": "a: 1\n", "applications_extra.py": "CATALOG = []\n"}})
assert r.status_code == 200, f"le lanceur refuse un fichier que le serveur envoie : {r.text}"
assert depot.put_archive.called
assert web.put("/agents/essai/files", json={"files": {"../etc/passwd": "x"}}).status_code == 400, "la liste reste fermée"
assert web.put("/agents/essai/files", json={"files": {"autre.py": "x"}}).status_code == 400, "la liste reste fermée"
print("7. le lanceur accepte applications_extra.py, et rien d'autre de nouveau")

# 8. Le verrou du parc : une opération qui en croise une autre attend son tour au lieu d'un faux « mise à jour ».
verrou = launcher.updater._lock
verrou.acquire()
threading.Timer(0.3, verrou.release).start()
r = web.post("/agents/essai/restart")
assert r.status_code == 200, f"refus alors que l'autre opération finit en 0,3 s : {r.text}"
assert not verrou.locked(), "verrou rendu"
launcher.FROZEN_WAIT = 0.2
verrou.acquire()
r = web.post("/agents/essai/restart")
assert r.status_code == 409 and "mise à jour" not in r.json()["detail"], f"occupé sans mise à jour : le message ne doit pas en parler ({r.text})"
etat = launcher.updater.load_state
launcher.updater.load_state = lambda: {"en_cours": {"phase": "application"}, "gardes": []}
r = web.post("/agents/essai/restart")
assert r.status_code == 409 and "mise à jour" in r.json()["detail"], r.text
verrou.release()
r = web.post("/agents/essai/restart")
assert r.status_code == 409 and "mise à jour" in r.json()["detail"], "pendant une vraie mise à jour, toujours refusé"
launcher.updater.load_state = etat
assert not verrou.locked(), "verrou rendu après un refus"
launcher.FROZEN_WAIT = 30
print("8. verrou du parc : attente bornée, et « mise à jour » seulement quand c'en est une")


# 9 et 10. Journaux bornés, mémoire selon la machine avec un plancher.
def created(ram_go):
    client.info.side_effect = None
    client.info.return_value = {"NCPU": 4, **({"MemTotal": int(ram_go * 2**30)} if ram_go else {})}
    launcher._cores.cache_clear()
    launcher._ram.cache_clear()
    client.containers.get.side_effect = docker.errors.NotFound()
    client.containers.create.reset_mock()
    client.containers.create.side_effect = None
    launcher._run_agent("essai", "k", [])
    agent = client.containers.create.call_args.kwargs

    class Created(Exception):
        pass

    client.containers.create.reset_mock()
    client.containers.create.return_value.get_archive.side_effect = Created()
    try:
        launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b"))
    except Created:
        pass
    client.containers.create.return_value.get_archive.side_effect = None
    return agent, client.containers.create.call_args.kwargs


agent, browser = created(16)
for kw in (agent, browser):
    assert kw.get("log_config") == {"type": "json-file", "config": {"max-size": "10m", "max-file": "3"}}, kw.get("log_config")
print("9. journaux des agents et des navigateurs : 30 Mo au plus par conteneur")

GO = 2**30
assert (agent["mem_limit"], browser["mem_limit"]) == (4 * GO, 4 * GO), "grosse machine : 4 Go comme avant"
agent, browser = created(8)
assert (agent["mem_limit"], browser["mem_limit"]) == (int(3.2 * GO), 4 * GO), (agent["mem_limit"], browser["mem_limit"])
agent, browser = created(4)
assert (agent["mem_limit"], browser["mem_limit"]) == (int(1.6 * GO), 2 * GO), (agent["mem_limit"], browser["mem_limit"])
agent, browser = created(2)
assert agent["mem_limit"] == launcher.MEM_FLOOR_AGENT and browser["mem_limit"] == launcher.MEM_FLOOR_BROWSER, "plancher : jamais sous ce qu'il faut pour tourner"
assert launcher.MEM_FLOOR_BROWSER >= 2 * GO, "un onglet lourd dépasse 1,8 Go : le navigateur garde 2 Go au moins"
agent, browser = created(0)
assert (agent["mem_limit"], browser["mem_limit"]) == (4 * GO, 4 * GO), "RAM illisible : la limite voulue"
assert browser.get("oom_score_adj", 0) > 0 and "oom_score_adj" not in agent, "à court de mémoire, le navigateur part avant le reste"
print("10. mémoire : une part de la RAM de la machine, 4 Go au plus, avec un plancher")

# 11. Dossiers partagés : l'ancien conteneur n'est retiré qu'une fois le nouveau créé.
ancien = MagicMock(name="ancien")
ancien.name, ancien.id, ancien.status = "noah-agent-essai", "id-ancien", "running"
ancien.exec_run.return_value.exit_code = 1
launcher.container = lambda agent_id: ancien
launcher._agent_key = lambda c: "k"
client.containers.get.side_effect = docker.errors.NotFound()
client.containers.create.side_effect = docker.errors.APIError("montage refusé")
r = web.put("/agents/essai/folders", json={"dossiers": []})
assert r.status_code == 502, r.text
assert not ancien.remove.called, "création ratée : l'agent d'avant est détruit"
assert [c.args[0] for c in ancien.rename.call_args_list] == ["noah-agent-essai-ancien", "noah-agent-essai"], ancien.rename.call_args_list
assert ancien.start.called, "l'agent d'avant doit repartir"
ancien.reset_mock()
ancien.exec_run.return_value.exit_code = 1
client.containers.create.side_effect = None
ordre = []
client.containers.create.side_effect = lambda *a, **k: ordre.append("creation") or MagicMock()
ancien.remove.side_effect = lambda **k: ordre.append("retrait")
ancien.stop.side_effect = lambda **k: ordre.append("arret")
r = web.put("/agents/essai/folders", json={"dossiers": []})
assert r.status_code == 200, r.text
assert ordre == ["arret", "creation", "retrait"], ordre
assert ancien.stop.call_args.kwargs.get("timeout"), "arrêt propre, pas brutal"
client.containers.create.side_effect = None
ancien.reset_mock()
client.containers.get.side_effect = None
client.containers.get.return_value = MagicMock(name="reste")  # un « -ancien » d'une opération coupée
r = web.put("/agents/essai/folders", json={"dossiers": []})
assert r.status_code == 409, r.text
assert not ancien.stop.called and not ancien.rename.called, "un reste -ancien : l'agent ne doit pas être arrêté"
client.containers.get.side_effect = docker.errors.NotFound()
print("11. dossiers partagés : arrêt propre, création, puis seulement retrait de l'ancien ; sinon il revient")

# 12. Suppression : les restes « -ancien » d'une opération coupée partent aussi, sinon les volumes restent.
restes = {"noah-agent-essai-ancien": MagicMock(labels={launcher.LABEL: "essai"}),
          "noah-browser-essai-ancien": MagicMock(labels={launcher.BROWSER_LABEL: "essai"}),
          "noah-agent-essai": MagicMock(labels={launcher.LABEL: "essai"})}
etranger = MagicMock(labels={launcher.BROWSER_LABEL: "autre"})


def trouve(nom):
    if nom in restes:
        return restes[nom]
    if nom == "noah-browser-essai":
        return etranger
    raise docker.errors.NotFound()


launcher.container = vrai_container  # la vraie fonction, qui contrôle l'étiquette
client.containers.get.side_effect = trouve
client.volumes.get.reset_mock()
client.volumes.get.return_value.remove.side_effect = None
r = web.delete("/agents/essai")
assert r.status_code == 200 and not r.json().get("restes"), r.text
assert all(c.remove.called for c in restes.values()), "un conteneur -ancien reste et retient le volume"
assert not etranger.remove.called, "un conteneur qui n'est pas à cet agent n'est jamais retiré"
client.volumes.get.return_value.remove.side_effect = docker.errors.APIError("volume is in use")
r = web.delete("/agents/essai")
assert r.status_code == 200 and r.json()["restes"] == ["noah-agent-essai", "noah-browser-essai"], r.text
client.volumes.get.return_value.remove.side_effect = None
print("12. suppression : conteneurs -ancien retirés, volumes restants nommés")

# 13. Identité du navigateur : sans langue ni fuseau (ipinfo.io muet), le navigateur en place est gardé tel quel.
launcher.container = lambda agent_id: None
nav = MagicMock(status="exited", labels={"noah.browser.version": f"{launcher.BROWSER_VERSION}:fr-CA:America/Toronto"})
client.containers.get.side_effect = lambda nom: nav
client.containers.create.reset_mock()
assert launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b")) == {"host": "noah-browser-essai", "created": False}
assert nav.start.called and not nav.stop.called and not nav.remove.called and not client.containers.create.called, "recréé en UTC/en-US pour une panne d'ipinfo.io"
nav.labels = {"noah.browser.version": "1:fr-CA:America/Toronto"}


class Recree(Exception):
    pass


client.containers.create.side_effect = Recree()
try:
    launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b"))
    sys.exit("réglages d'une autre version : le navigateur doit être recréé")
except Recree:
    pass
nav.labels = {"noah.browser.version": f"{launcher.BROWSER_VERSION}:fr-CA:America/Toronto"}
nav.reset_mock()
try:
    launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b", locale="fr-FR", timezone="Europe/Paris"))
    sys.exit("une identité connue et différente : le navigateur doit être recréé")
except Recree:
    pass
client.containers.create.side_effect = None
print("13. navigateur : une identité vide ne remplace jamais celle en place")

# 14. Paquets : un agent qui s'arrête pendant la boucle n'empêche pas les suivants de retrouver les leurs.
casse, bon = MagicMock(name="casse"), MagicMock(name="bon")
casse.exec_run.side_effect = docker.errors.APIError("is not running")
bon.exec_run.side_effect = [MagicMock(output=b"ffmpeg\n", exit_code=0), MagicMock(exit_code=1), MagicMock(exit_code=0, output=b"")]
client.containers.list.return_value = [casse, bon]
client.containers.list.side_effect = None
launcher._restore_packages()
assert bon.exec_run.call_count == 3, "l'agent suivant n'a pas retrouvé ses paquets"
print("14. paquets : une erreur sur un agent ne coupe pas la restauration des autres")
print("OK")
