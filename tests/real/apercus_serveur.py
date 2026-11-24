"""Le vrai serveur (donc les vrais en-têtes) et la vraie interface, avec un espace de travail qui contient un fichier de chaque type
d'aperçu : image, vidéo, Markdown, texte, page HTML. Voir apercus.mjs.

    docker run --rm -p 127.0.0.1:8096:8096 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/apercus_serveur.py"
"""
import base64
import json
import os
import struct
import sys
import tempfile
import time
import zlib

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, db, hermes, machine, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
conv = conv["id"] if isinstance(conv, dict) else conv

# Une vidéo H.264 de 3 secondes, 160x90 (ffmpeg testsrc), qui se lit vraiment.
MP4 = base64.b64decode("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")


def png(width, height, color):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\0" + bytes(color) * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


MARKDOWN = "# Rapport du jour\n\nUn **résumé** avec un [lien](https://example.com).\n\n- premier point\n- deuxième point\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
TEXTE = "première ligne\nseconde ligne\n\n  ligne indentée\ndernière ligne\n"
PAGE = "<!doctype html><meta charset=utf-8><title>Page</title><body style='font:20px sans-serif'><h1 id=titre>Page HTML vivante</h1><img src='logo.png' width=64><script>document.getElementById('titre').textContent += ' (script exécuté)'</script></body>"
DOSSIER_APP = "<!doctype html><meta charset=utf-8><body><h1 id=app>Application</h1><script src='app.js'></script></body>"

PDF = b"\n".join([
    b"%PDF-1.1",
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    b"4 0 obj<</Length 44>>stream",
    b"BT /F1 18 Tf 20 50 Td (PDF visible) Tj ET",
    b"endstream endobj",
    b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    b"trailer<</Root 1 0 R/Size 6>>",
    b"%EOF",
])

t = time.time()
FICHIERS = {
    "outputs/image.png": (png(320, 180, (42, 71, 201)), t - 10),
    "outputs/video.mp4": (MP4, t - 20),
    "outputs/rapport.md": (MARKDOWN.encode(), t - 30),
    "outputs/notes.txt": (TEXTE.encode(), t - 40),
    "outputs/page.html": (PAGE.encode(), t - 50),
    "outputs/doc.pdf": (PDF, t - 52),
    "outputs/logo.png": (png(64, 64, (15, 118, 110)), t - 55),
    "apps/demo/index.html": (DOSSIER_APP.encode(), t - 60),
    "apps/demo/app.js": (b"document.getElementById('app').textContent += ' chargee';", t - 60),
}


def widget(path):
    return "```noah\n" + json.dumps({"type": "preview", "path": path, "title": path.split("/")[-1]}) + "\n```"


MESSAGES = [("user", "Montre-moi tout")] + [
    ("agent", f"CAS-{p.split('/')[-1]}\n\n{widget('/opt/data/workspace/' + p)}") for p in FICHIERS if p not in ("outputs/logo.png", "apps/demo/app.js")
]
with db.connect() as c:
    c.executemany("INSERT INTO messages (conversation_id, role, text) VALUES (?, ?, ?)", [(conv, r, x) for r, x in MESSAGES])


async def list_files(agent_id):
    return [{"path": p, "size": len(v[0]), "modified": v[1]} for p, v in FICHIERS.items()]


async def read_file(agent_id, path):
    if path in FICHIERS:
        return httpx.Response(200, content=FICHIERS[path][0])
    return httpx.Response(404)


async def fake_media(agent_id, path):
    key = path.removeprefix("/opt/data/workspace/")
    if key in FICHIERS:
        return httpx.Response(200, content=FICHIERS[key][0], headers={"content-type": "image/png"})
    return httpx.Response(404)


async def healthy(*a, **k):
    return True


async def admin(agent_id, action, payload=None):
    return {"memoire": {"memory": [], "user": [], "limites": {"memory": 2200, "user": 1375}}}.get(action, {"applications": [], "google": {}})


hermes.list_files, hermes.read_file, hermes.media, hermes.health = list_files, read_file, fake_media, healthy
machine.admin = admin
uvicorn.run(main.app, host="0.0.0.0", port=8096, log_level="warning")
