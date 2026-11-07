"""Le vrai serveur et la vraie interface, avec une longue conversation sur plusieurs jours et un faux espace de travail. Voir fil_long.mjs.

    docker run --rm -p 127.0.0.1:8099:8099 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/fil_long_serveur.py"
"""
import asyncio
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, db, hermes, machine, main, media  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
bruno = auth.create_user("bruno", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Bis', '', 'k2', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
main._new_conversation(alice, "a2", "Conversation", main=True)
conv = conv["id"] if isinstance(conv, dict) else conv


def widget(path, title):
    return "Voici.\n\n```noah\n" + json.dumps({"type": "preview", "path": path, "title": title}, ensure_ascii=False) + "\n```"


# 150 messages sur trois jours. Une page tout en haut, une au milieu (ancienne), une dans le dernier message (récente).
now = datetime.now(timezone.utc)
rows = []
for i in range(75):
    when = now - timedelta(minutes=2 if i == 74 else (75 - i) * 60)
    at = when.strftime("%Y-%m-%d %H:%M:%S")
    rows.append(("user", f"Demande numéro {i:03d} : parle-moi du sujet {i}", at))
    if i == 55:
        rows.append(("agent", widget("outputs/jeu-ancien/index.html", "Jeu ancien"), at))
    elif i == 74:
        rows.append(("agent", widget("outputs/recent.html", "Page récente"), at))
    else:
        rows.append(("agent", f"Réponse {i:03d}. " + "Du texte pour remplir l'écran. " * 12, at))
with db.connect() as c:
    c.executemany("INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?, ?, ?, ?)", [(conv, r, t, a) for r, t, a in rows])

t = time.time()
files = {
    "outputs/jeu-ancien/index.html": ("<!doctype html><h1 id=vu>Jeu chargé</h1>", t - 90000),
    "outputs/jeu-ancien/style.css": ("h1{color:red}", t - 90000),
    "outputs/recent.html": ("<!doctype html><h1>Page récente</h1>", t - 60),
    "outputs/rapports/mars/bilan.pdf": ("%PDF-1.4", t - 5000),
    "outputs/rapports/mars/notes.txt": ("notes", t - 4000),
    "outputs/rapports/avril.txt": ("avril", t - 3000),
    "apps/compteur/index.html": ("<!doctype html><h1>Compteur</h1>", t - 2000),
    "captures/ecran.txt": ("capture", t - 1000),
    "uploads/photo.txt": ("photo", t - 500),
    "outputs/bientot.html": ("<!doctype html><h1>Bientôt ancienne</h1>", t - 30),
}
other_files = {"uploads/de-bis.txt": ("bis", t - 10)}
deleted: list[str] = []


async def list_files(agent_id):
    return [{"path": p, "size": len(v[0]), "modified": v[1]} for p, v in (other_files if agent_id == "a2" else files).items()]


async def read_file(agent_id, path):
    if path in files:
        return httpx.Response(200, content=files[path][0].encode())
    return httpx.Response(404)


async def delete_files(agent_id, paths):
    deleted.extend(paths)
    for p in paths:
        files.pop(p, None)
    return {"supprimes": paths, "refuses": []}


started: list[str] = []


async def start_run(agent, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    text = started[int(run_id.split("-")[1]) - 1]
    if "BAVARD" in text:
        yield "message.delta", {"delta": "[["}
        yield "message.delta", {"delta": "👍]] Je regarde la page."}
        yield "tool.started", {"tool": "web_search", "args": {"query": "prix du cuivre"}}
        await asyncio.sleep(1.2)
        yield "message.delta", {"delta": "Je clique sur le bouton."}
        yield "tool.started", {"tool": "read_file", "args": {"path": "a.txt"}}
        await asyncio.sleep(1.2)
        yield "message.delta", {"delta": "C'est fait. On publie maintenant ?"}
    yield "run.completed", {"output": "Reçu."}


async def quick_replies(agent_id, said):
    return ["Oui, publie", "Pas encore"]


async def healthy(*a, **k):
    return True


hermes.list_files, hermes.read_file, hermes.delete_files = list_files, read_file, delete_files
hermes.start_run, hermes.run_events, hermes.health = start_run, run_events, healthy


async def admin(agent_id, action, payload=None):
    return {"memoire": {"memory": [], "user": [], "limites": {"memory": 2200, "user": 1375}}}.get(action, {"applications": [], "google": {}})


machine.admin = admin
media.quick_replies = quick_replies


@main.app.get("/_essai/etat")
def state():
    return {"deleted": deleted, "started": started, "conversation": conv}


@main.app.post("/_essai/bientot-ancienne")
def nearly_old():
    """Une page dans le dernier message, qui passera les 30 minutes dans 25 s."""
    at = (datetime.now(timezone.utc) - timedelta(minutes=30) + timedelta(seconds=25)).strftime("%Y-%m-%d %H:%M:%S")
    with db.connect() as c:
        c.execute("INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?, 'agent', ?, ?)", (conv, widget("outputs/bientot.html", "Bientôt ancienne"), at))
    return {"ok": True}


# Sans ce déplacement, la route d'envoi de la page d'accueil répondrait avant les routes d'essai.
main.app.router.routes[:0] = [main.app.router.routes.pop(), main.app.router.routes.pop()]
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning")
