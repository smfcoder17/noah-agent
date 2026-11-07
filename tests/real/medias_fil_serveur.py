"""Le vrai serveur (donc le vrai CSP) et la vraie interface, avec des messages qui citent des images et des vidéos. Voir medias_fil.mjs.

    docker run --rm -p 127.0.0.1:8097:8097 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/medias_fil_serveur.py"
"""
import asyncio
import base64
import json
import os
import struct
import sys
import tempfile
import zlib

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, db, hermes, machine, main, media  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
conv = conv["id"] if isinstance(conv, dict) else conv

A = "/opt/data/workspace/captures/a.png"
B = "/opt/data/workspace/captures/b.png"
GIF = "/tmp/anime.gif"


def preview(path):
    return "```noah\n" + json.dumps({"type": "preview", "path": path}) + "\n```"


YT = "https://www.youtube.com/watch?v=M7lc1UVf-VE"  # la vidéo de démonstration de l'API YouTube : elle accepte d'être intégrée
MESSAGES = [
    ("user", "Montre-moi tout"),
    ("agent", f"CAS-MEDIA seul.\nMEDIA:{A}"),
    ("agent", f"CAS-DOUBLE les deux.\nMEDIA:{A}\n\n{preview(A)}"),
    ("agent", f"CAS-NU enregistrée dans {A}."),
    ("agent", f"CAS-PLUSIEURS\nMEDIA:{A}\nMEDIA:{B}\nMEDIA:{GIF}\nEt encore {B}."),
    ("agent", "CAS-ABSENTE\nMEDIA:/opt/data/workspace/captures/absente.png"),
    ("agent", f"CAS-VIDEO regarde :\n\n{YT}\n\nFin."),
    ("agent", "CAS-AUTRES\n\nhttps://vimeo.com/76979871\n\nhttps://x.com/elonmusk/status/1585841080431321088\n\nhttps://www.tiktok.com/@scout2015/video/6718335390845095173\n\nhttps://www.instagram.com/p/CUbHfhpswxt/"),
    ("agent", f"CAS-TEXTE regarde {YT}&x=1 ce soir, ou https://example.com/video\n\n```\n{YT}\n```"),
    ("agent", 'CAS-PIEGE\n\n```noah\n{"type":"video","url":"javascript:alert(1)"}\n```\n\nhttps://youtube.com.evil.com/watch?v=M7lc1UVf-VE'),
]
with db.connect() as c:
    c.executemany("INSERT INTO messages (conversation_id, role, text) VALUES (?, ?, ?)", [(conv, r, t) for r, t in MESSAGES])


def png(width, height, color):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\0" + bytes(color) * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


FILES = {
    A: (png(320, 180, (42, 71, 201)), "image/png"),
    B: (png(200, 200, (15, 118, 110)), "image/png"),
    GIF: (base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), "image/gif"),
}


async def fake_media(agent_id, path):
    if path in FILES:
        return httpx.Response(200, content=FILES[path][0], headers={"content-type": FILES[path][1]})
    return httpx.Response(404)


started: list[str] = []


async def start_run(agent, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    # Une réponse coupée par un outil : la même image citée dans chaque partie, puis son widget.
    yield "message.delta", {"delta": "CAS-FLUX première partie.\nMEDIA:"}
    await asyncio.sleep(0.3)
    yield "message.delta", {"delta": A + "\n"}
    yield "tool.started", {"tool": "read_file", "args": {"path": "a.txt"}}
    await asyncio.sleep(0.8)
    yield "message.delta", {"delta": f"Deuxième partie.\nMEDIA:{A}\n\n"}
    await asyncio.sleep(0.3)
    yield "message.delta", {"delta": preview(A) + f"\n\n{YT}"}
    await asyncio.sleep(0.5)
    yield "run.completed", {"output": "Reçu."}


async def healthy(*a, **k):
    return True


async def no_files(agent_id):
    return []


async def admin(agent_id, action, payload=None):
    return {"memoire": {"memory": [], "user": [], "limites": {"memory": 2200, "user": 1375}}}.get(action, {"applications": [], "google": {}})


async def quick_replies(agent_id, said):
    return []


hermes.media, hermes.start_run, hermes.run_events, hermes.health, hermes.list_files = fake_media, start_run, run_events, healthy, no_files
machine.admin = admin
media.quick_replies = quick_replies
uvicorn.run(main.app, host="0.0.0.0", port=8097, log_level="warning")
