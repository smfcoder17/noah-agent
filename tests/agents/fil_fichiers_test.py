"""La conversation par tranches, et la suppression de fichiers : qui a le droit, et ce que le lanceur accepte vraiment.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/launcher:/l:ro" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/fil_fichiers_test.py"
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from unittest.mock import MagicMock

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.update(LAUNCHER_KEY="k", NOAH_SECRET_KEY="y" * 32, AGENT_NETWORK="reseau", NOAH_UPDATES_DIR=tempfile.mkdtemp())
docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
sys.path[:0] = ["/app", "/l"]
import launcher  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main  # noqa: E402

db.init()
alice, bruno, carla, dan, eve = (auth.create_user(n, "motdepasse-essai") for n in ("alice", "bruno", "carla", "dan", "eve"))
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.executemany("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, ?)", [(bruno, "lecture"), (carla, "usage"), (dan, "admin")])
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
with db.connect() as c:
    c.executemany("INSERT INTO messages (conversation_id, role, text) VALUES (?, ?, ?)", [(conv, "user", f"m{i}") for i in range(150)])


def client(user=None):
    headers = {"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"} if user else {}
    return TestClient(main.app, headers=headers, raise_server_exceptions=False)


# --- La conversation par tranches ---
web = client(alice)
url = f"/api/conversations/{conv}/messages"
texts = lambda rows: [r["text"] for r in rows]  # noqa: E731

everything = web.get(url).json()
assert texts(everything) == [f"m{i}" for i in range(150)], "sans paramètre : tout, dans l'ordre (les applications déjà installées lisent ainsi)"
page = web.get(url, params={"limit": 60}).json()
assert texts(page) == [f"m{i}" for i in range(90, 150)], "les 60 derniers, du plus ancien au plus récent"
assert all("id" in r and "created_at" in r for r in page), "chaque message porte de quoi reprendre et se dater"
older = web.get(url, params={"avant": page[0]["id"], "limit": 60}).json()
assert texts(older) == [f"m{i}" for i in range(30, 90)], "la page d'avant, sans recoupement"
rest = web.get(url, params={"avant": older[0]["id"], "limit": 60}).json()
assert texts(rest) == [f"m{i}" for i in range(30)], "le début, plus court : il n'y a plus rien avant"
since = web.get(url, params={"depuis": page[0]["id"]}).json()
assert texts(since) == texts(page), "reprendre depuis une ancre donne la fenêtre, et les messages qui s'y ajoutent"
long = main._new_conversation(alice, "a1", "Longue")
with db.connect() as c:
    c.executemany("INSERT INTO messages (conversation_id, role, text) VALUES (?, 'user', 'x')", [(long,)] * 600)
assert len(web.get(f"/api/conversations/{long}/messages", params={"limit": 100000}).json()) == 500, "une tranche reste bornée"
assert client(eve).get(url, params={"limit": 60}).status_code in (403, 404), "une autre personne ne lit aucune tranche"
assert client(eve).get(url, params={"avant": page[0]["id"]}).status_code in (403, 404), "ni en remontant"
print("la conversation se lit par tranches")

# --- Qui peut supprimer ---
asked: list = []


async def delete_files(agent_id, paths):
    asked.append(paths)
    return {"supprimes": paths, "refuses": []}


hermes.delete_files = delete_files
route = "/api/agents/a1/files/supprimer"
body = {"chemins": ["uploads/a.txt"]}
assert client().post(route, json=body).status_code == 401, "sans session"
for who, why in ((eve, "sans accès"), (bruno, "lecture"), (carla, "usage")):
    assert client(who).post(route, json=body).status_code in (403, 404), f"refusé : {why}"
assert not asked, "rien n'a atteint le lanceur"
assert client(dan).post(route, json=body).status_code == 200, "admin"
assert web.post(route, json=body).status_code == 200, "propriétaire"
assert len(asked) == 2
assert web.post(route, json={"chemins": []}).status_code == 422, "une demande vide"
print("seuls l'admin et le propriétaire suppriment")

# --- Le script du lanceur, pour de vrai, sur un vrai dossier ---
top = tempfile.mkdtemp()
root, outside = top + "/workspace", top + "/ailleurs"
os.makedirs(outside)
for path in ("outputs/a/b/c.txt", "outputs/a/garde.txt", "uploads/seul.txt", "uploads/dossier/x.txt", "outputs/d/e.txt"):
    os.makedirs(os.path.dirname(f"{root}/{path}"), exist_ok=True)
    open(f"{root}/{path}", "w").close()
open(outside + "/secret.txt", "w").close()
os.symlink(outside, root + "/outputs/lien-dossier")
os.symlink(outside + "/secret.txt", root + "/outputs/lien-fichier")


def run(*paths):
    out = subprocess.run([sys.executable, "-c", launcher.DELETE_NO_LINK, root, json.dumps(paths)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


exists = lambda p: os.path.lexists(f"{root}/{p}")  # noqa: E731
assert run("outputs/a/b/c.txt")["supprimes"] == ["outputs/a/b/c.txt"]
assert not exists("outputs/a/b/c.txt") and not exists("outputs/a/b"), "le dossier vidé part aussi"
assert exists("outputs/a/garde.txt"), "un dossier encore habité reste"
run("uploads/seul.txt", "uploads/dossier/x.txt")
assert exists("uploads") and not exists("uploads/dossier"), "un dossier de premier niveau reste, même vide"
r = run("outputs/lien-dossier/secret.txt")
assert r["refuses"] == ["outputs/lien-dossier/secret.txt"], "un dossier remplacé par un lien ne mène nulle part"
assert os.path.exists(outside + "/secret.txt"), "ce qui est hors de l'espace de travail reste"
assert run("outputs/lien-fichier")["supprimes"] == ["outputs/lien-fichier"]
assert not exists("outputs/lien-fichier") and os.path.exists(outside + "/secret.txt"), "un lien part, ce qu'il désigne reste"
assert run("outputs/d")["refuses"] == ["outputs/d"] and exists("outputs/d/e.txt"), "un dossier ne part pas d'un coup : seulement ce qui a été choisi"
assert run("outputs/absent.txt")["supprimes"] == ["outputs/absent.txt"], "déjà parti : c'est réussi"
print("le script supprime sans suivre de lien")

# --- La route du lanceur : les chemins refusés, et les grosses demandes ---
for bad in ("../secret", "/etc/passwd", "outputs/../../secret", "outputs//a", "./a", "outputs/.", "", "a\x00b", "a/" * 600 + "b"):
    try:
        launcher._workspace_paths([bad])
    except HTTPException as e:
        assert e.status_code == 400
    else:
        raise AssertionError(f"chemin accepté : {bad[:40]!r}")
try:
    launcher._workspace_paths(["a"] * (launcher.DELETE_MOST + 1))
except HTTPException:
    pass
else:
    raise AssertionError("une demande sans limite")

calls: list = []


class Box:
    def exec_run(self, cmd, **kw):
        calls.append(json.loads(cmd[4]))
        return MagicMock(exit_code=0, output=json.dumps({"supprimes": calls[-1], "refuses": []}).encode())


launcher.container = lambda agent_id: Box()
web2 = TestClient(launcher.app, headers={"Authorization": "Bearer k", "X-Launcher-Key": "k"}, raise_server_exceptions=False)
wanted = [f"uploads/é{i:04d}" + "é" * 290 for i in range(250)]  # 298 caractères accentués : plus de 128 Kio d'un coup une fois échappés
res = web2.post("/agents/a1/files/supprimer", json={"chemins": wanted})
assert res.status_code == 200, res.text[:200]
assert res.json()["supprimes"] == wanted, "tout est traité"
assert len(calls) > 1 and all(len(json.dumps(part)) < 131072 for part in calls), "par lots : un seul argument de commande ne dépasse pas la limite du système"
assert TestClient(launcher.app).post("/agents/a1/files/supprimer", json={"chemins": ["a"]}).status_code in (401, 403), "le lanceur demande sa clé"
print("le lanceur borne et découpe")

# Régression 0.1.7 : tout fichier que hermes.configure envoie doit être dans la liste du lanceur, sinon toute configuration
# d'agent échoue (« Fichier non autorisé : applications_extra.py »). Lu dans le code des deux côtés, pour que l'écart ne revienne pas.
import inspect  # noqa: E402
import re  # noqa: E402

source = inspect.getsource(hermes.configure)
envoyes = set(re.findall(r'files\["([^"]+)"\]', source))
if 'files[f"plugins/noah-garde/{name}"]' in source:
    envoyes |= {"plugins/noah-garde/plugin.yaml", "plugins/noah-garde/__init__.py"}
assert {"config.yaml", "noah.py", "applications_extra.py"} <= envoyes, f"lecture du code à revoir : {envoyes}"
assert len(re.findall(r"files\[", source)) == len(re.findall(r'files\["[^"]+"\]', source)) + 1, "un fichier envoyé sous un nom que ce test ne sait pas lire"
assert envoyes <= set(launcher.CONFIG_FILES), f"le lanceur refuserait : {sorted(envoyes - set(launcher.CONFIG_FILES))}"
print("tout fichier envoyé par la configuration est accepté par le lanceur")
asyncio.run(asyncio.sleep(0))
print("OK")
