"""Un fichier de l'agent remis au navigateur : un fichier qui ne s'exécute pas se lit (vidéo seule dans un onglet, PDF), par morceaux ;
ce qui peut s'exécuter reste dans son bac à sable.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/fichiers_servis_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
anonymous = TestClient(main.app)
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))

VIDEO = bytes(range(256)) * 4  # 1024 octets
FILES = {
    "outputs/video.mp4": VIDEO,
    "outputs/son.mp3": b"ID3" + bytes(97),
    "outputs/doc.pdf": b"%PDF-1.4 ...",
    "outputs/photo.png": b"\x89PNG....",
    "outputs/notes.txt": b"une\ndeux\n",
    "outputs/rapport.md": b"# Titre\n",
    "outputs/page.html": b"<script>parent.x</script>",
    "outputs/dessin.svg": b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    "outputs/donnees.xml": b"<a/>",
    "outputs/programme.exe": b"MZ",
    "outputs/inconnu.zzz": b"?",
}


async def read_file(agent_id, path):
    return httpx.Response(200, content=FILES[path]) if path in FILES else httpx.Response(404)


hermes.read_file = read_file


def raw(name, **headers):
    return web.get(f"/api/agents/a1/files/raw/outputs/{name}", headers=headers)


def sandboxed(r):
    return r.headers["content-security-policy"].startswith("sandbox ")


# 1. Ce qui ne s'exécute pas n'a pas de bac à sable : la vidéo ouverte seule dans un onglet se recharge depuis une origine « null »
#    et le navigateur la refuse (CORS), le lecteur de PDF ne s'ouvre pas.
for name in ("video.mp4", "son.mp3", "doc.pdf", "photo.png", "notes.txt", "rapport.md"):
    r = raw(name)
    csp = r.headers["content-security-policy"]
    assert r.status_code == 200 and not sandboxed(r), f"{name} : bac à sable inutile, il casse sa lecture : {csp}"
    assert "script-src" not in csp and "default-src 'none'" in csp, f"{name} : un fichier lu seul ne doit exécuter aucun script : {csp}"
    assert r.headers["x-content-type-options"] == "nosniff", name
print("1. vidéo, son, PDF, image, texte : sans script, sans bac à sable")

# 2. Ce qui peut s'exécuter, ou qu'on ne reconnaît pas, y reste.
for name in ("page.html", "dessin.svg", "donnees.xml", "programme.exe", "inconnu.zzz"):
    r = raw(name)
    assert r.status_code == 200 and sandboxed(r) and "allow-same-origin" not in r.headers["content-security-policy"], f"{name} : {r.headers['content-security-policy']}"
print("2. page, SVG, XML, programme, type inconnu : toujours en bac à sable")

# 3. Lecture par morceaux : ce que Safari, iOS et Android exigent d'une vidéo, et sans quoi on ne peut pas avancer dans un fichier encore en route.
full = raw("video.mp4")
assert full.status_code == 200 and full.headers["accept-ranges"] == "bytes" and full.content == VIDEO and "content-range" not in full.headers
first = raw("video.mp4", Range="bytes=0-99")
assert first.status_code == 206 and first.content == VIDEO[:100], first.status_code
assert first.headers["content-range"] == "bytes 0-99/1024" and first.headers["content-length"] == "100" and first.headers["content-type"] == "video/mp4"
assert raw("video.mp4", Range="bytes=1000-").content == VIDEO[1000:]
assert raw("video.mp4", Range="bytes=-24").content == VIDEO[-24:]
assert raw("video.mp4", Range="bytes=1020-5000").headers["content-range"] == "bytes 1020-1023/1024", "fin au-delà du fichier : tronquée"
past = raw("video.mp4", Range="bytes=2000-")
assert past.status_code == 416 and past.headers["content-range"] == "bytes */1024", past.headers
for odd in ("bytes=0-1,5-6", "items=0-1", "bytes=-", "bytes=9-3", "n'importe quoi"):
    assert raw("video.mp4", Range=odd).status_code in (200, 416), odd
assert raw("video.mp4", Range="bytes=0-1,5-6").content == VIDEO, "plusieurs plages : le fichier entier"
print("3. Range : 206 avec Content-Range, fin ouverte, derniers octets, 416 hors du fichier, plages multiples ignorées")

# 4. Même chose depuis le lien d'aperçu (une page y cite ses vidéos), et une page y garde son bac à sable.
link = web.post("/api/agents/a1/apercu", json={"path": "outputs/video.mp4"}).json()["url"]
r = anonymous.get(link, headers={"Range": "bytes=10-19"})
assert r.status_code == 206 and r.content == VIDEO[10:20] and not sandboxed(r), (r.status_code, r.headers)
page = anonymous.get(web.post("/api/agents/a1/apercu", json={"path": "outputs/page.html"}).json()["url"])
assert page.status_code == 200 and sandboxed(page) and page.headers["referrer-policy"] == "no-referrer"
print("4. lien d'aperçu : morceaux pour la vidéo, bac à sable pour la page")

# 5. Le téléchargement reste un téléchargement, et un fichier absent reste une erreur lisible.
assert "attachment" in web.get("/api/agents/a1/files/raw/outputs/video.mp4?download=1").headers["content-disposition"]
assert web.get("/api/agents/a1/files/raw/outputs/absent.mp4").status_code == 404
print("5. téléchargement et fichier absent inchangés")
print("OK")
