"""Aperçu d'une app dans son bac à sable : sans cookie, elle charge quand même ses images et ses données, et rien d'autre.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/apercu_test.py"
"""
import asyncio
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import access, auth, db, hermes, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(bruno, 'Firefox', 'web')}"})
anonymous = TestClient(main.app)
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))

FILES = {
    "apps/jeu/index.html": b"<img src='assets/lion.jpg'>",
    "apps/jeu/assets/lion.jpg": b"JPEG",
    "apps/jeu/data.json": b"{}",
    "apps/autre/secret.txt": b"AUTRE",
    "outputs/rapport.html": b"<h1>Rapport</h1><img src='graphe.png'><a href='../notes.txt'>x</a><img src='https://ailleurs.example/x.png'><style>a{background:url(fond.jpg)}</style>",
    "outputs/graphe.png": b"PNG",
    "outputs/fond.jpg": b"JPG",
    "outputs/autre-client.txt": b"CONFIDENTIEL",
    "uploads/page.html": b"<h1>Page</h1>",
    "uploads/piece.pdf": b"PDF",
    "notes.txt": b"NOTES",
    "racine.html": b"<h1>Racine</h1>",
}
asked: list[str] = []


async def read_file(agent_id, path):
    asked.append(path)
    if path in FILES:
        return httpx.Response(200, content=FILES[path])
    return httpx.Response(404)


hermes.read_file = read_file


def link(path, client=web):
    r = client.post("/api/agents/a1/apercu", json={"path": path})
    return r


entry = link("/opt/data/workspace/apps/jeu/index.html").json()["url"]
assert entry.endswith("/index.html") and entry.startswith("/api/apercu/"), entry
base = entry.rsplit("/", 1)[0]

# 1. Sans cookie, avec le lien de l'aperçu : la page et ce qui l'accompagne.
r = anonymous.get(entry)
assert r.status_code == 200 and r.content == FILES["apps/jeu/index.html"], r.text
assert "sandbox" in r.headers["content-security-policy"] and "allow-same-origin" not in r.headers["content-security-policy"]
assert r.headers["referrer-policy"] == "no-referrer", "le lien ne doit pas partir vers les sites que la page appelle"
r = anonymous.get(f"{base}/assets/lion.jpg")
assert r.status_code == 200 and r.content == b"JPEG"
r = anonymous.get(f"{base}/data.json", headers={"Origin": "null"})
assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "*", "fetch depuis un bac à sable"
print("1. l'app charge ses images et ses données sans cookie, toujours dans son bac à sable")

# 2. Rien hors de son dossier.
asked.clear()
for bad in ("../autre/secret.txt", "..%2Fautre%2Fsecret.txt", "assets/../../autre/secret.txt", "..%2F..%2Fnotes.txt"):
    r = anonymous.get(f"{base}/{bad}")
    assert r.status_code in (403, 404) and b"AUTRE" not in r.content and b"NOTES" not in r.content, f"{bad} : {r.status_code}"
assert not asked, f"le lecteur de fichiers a été appelé : {asked}"
print("2. rien hors de son dossier")

# 3. Une page à la racine ne reçoit pas tout l'espace de travail.
root = link("racine.html").json()["url"]
assert anonymous.get(root).status_code == 200
assert anonymous.get(root.rsplit("/", 1)[0] + "/notes.txt").status_code == 403
print("3. une page à la racine ne voit qu'elle-même")

# 3 bis. Dans un dossier commun, une page ne lit que ce qu'elle cite : pas les autres livrables.
report = link("outputs/rapport.html").json()["url"]
near = report.rsplit("/", 1)[0]
assert anonymous.get(report).status_code == 200
assert anonymous.get(f"{near}/graphe.png").content == b"PNG" and anonymous.get(f"{near}/fond.jpg").content == b"JPG", "ce qu'elle cite"
assert anonymous.get(f"{near}/autre-client.txt").status_code == 403, "un livrable voisin"
assert anonymous.get(f"{near}/..%2Fnotes.txt").status_code in (403, 404), "un chemin cité hors du dossier ne compte pas"
page = link("uploads/page.html").json()["url"]
assert anonymous.get(page.rsplit("/", 1)[0] + "/piece.pdf").status_code == 403, "un fichier envoyé ne voit pas les autres"
print("3 bis. dans outputs/ et uploads/, une page ne lit que ce qu'elle cite")

# 4. Jeton faux, expiré, ou droits retirés.
head, tail = entry.removeprefix("/api/apercu/").split("/", 1)
assert anonymous.get(f"/api/apercu/{head[:-2]}xx/{tail}").status_code == 403
assert anonymous.get(f"/api/apercu/autre.{head.split('.')[-1]}/{tail}").status_code == 403
main.PREVIEW_SECONDS = -10
expired = link("apps/jeu/index.html").json()["url"]
assert anonymous.get(expired).status_code == 403
main.PREVIEW_SECONDS = 86400
assert other.post("/api/agents/a1/apercu", json={"path": "apps/jeu/index.html"}).status_code in (403, 404), "profil sans accès"
real = access.allowed
access.allowed = lambda *a, **k: False
assert anonymous.get(entry).status_code == 403, "partage retiré : le lien ne sert plus"
access.allowed = real
print("4. jeton faux, expiré ou droits retirés : refus")

# 5. Fichier absent : une phrase, pas du JSON. Un chemin hors de l'espace de travail : refusé.
r = anonymous.get(f"{base}/absent.png", headers={"Sec-Fetch-Dest": "iframe"})
assert r.status_code == 404 and "Fichier indisponible" in r.text
assert link("/etc/passwd").status_code == 400
assert link("../secret").status_code == 400
print("5. fichier absent dit, chemin hors de l'espace de travail refusé")
print("OK")
_ = (asyncio, time)
