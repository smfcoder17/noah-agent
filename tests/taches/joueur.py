"""Banc commun des tests des questions (0.4.0, L2) : vrai `_run`, vraies routes, vraie base ; seuls la machine de l'agent (Hermes) et
l'envoi des notifications sont simulés. Un « joueur » tient la place du cerveau de chaque agent : il lit ce que l'agent reçoit,
le donne au faux modèle (tests/real/faux_modele.py, lancé comme serveur) et rejoue la commande que le modèle choisit contre les vraies
routes de l'agent. Le faux modèle ne devine rien : il obéit à « Pose la question : … » et à « Réponses connues : clé=valeur ».
"""
import asyncio
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, coordination, db, hermes, machine, main, push, questions, relay  # noqa: E402
main._today = lambda: ""

PORT = 18921
faux = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "real", "faux_modele.py"), str(PORT)])
for _ in range(100):
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
        break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit("le faux modèle ne répond pas")

db.init()
owner = auth.create_user("alice", "motdepasse-a")
# Noah est créé le premier : c'est le chef d'équipe.
AGENTS = {"noah": "Noah", "lea": "Léa", "hugo": "Hugo", "zoe": "Zoé"}
with db.connect() as c:
    for agent_id, name in AGENTS.items():
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, owner))
MAINS = {a: main._new_conversation(owner, a, "Conversation", main=True) for a in AGENTS}
main.app.dependency_overrides[auth.current_user] = lambda: owner

runs: list[dict] = []
down: set[str] = set()


async def fake_start(agent, text, session_id):
    if agent.id in down:
        raise httpx.ConnectError("arrêté")
    runs.append({"agent": agent.id, "text": text, "conv": session_id.removeprefix("noah-"), "events": asyncio.Queue(), "joue": False})
    return str(len(runs) - 1)


async def fake_events(agent, run_id):
    queue = runs[int(run_id)]["events"]
    while True:
        kind, data = await queue.get()
        yield kind, data
        if kind.startswith("run."):
            return


hermes.start_run = fake_start
hermes.run_events = fake_events
push.notify = lambda *a, **k: None
coordination.FREE_POLL = 0.01
questions.AGENT_WAIT = 0.05
questions.LIVRAISON_ATTENTE = 5

transport = httpx.ASGITransport(app=main.app)


def client(token: str | None = None) -> httpx.AsyncClient:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.AsyncClient(transport=transport, base_url="http://noah.test", headers=headers)


def as_agent(agent: str) -> httpx.AsyncClient:
    return client(relay.token_for(agent))


def finish(run: dict, text="C'est fait.", status="completed"):
    if text:
        run["events"].put_nowait(("message.delta", {"delta": text}))
    run["events"].put_nowait((f"run.{status}", {}))


def modele(texte: str) -> str | None:
    """Ce que le faux modèle ferait de ce texte : la commande de l'outil de l'agent, ou None."""
    body = {"model": "faux-modele", "messages": [{"role": "user", "content": texte}], "tools": [{"type": "function", "function": {"name": "terminal"}}]}
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        message = json.load(r)["choices"][0]["message"]
    calls = message.get("tool_calls") or []
    return json.loads(calls[0]["function"]["arguments"])["command"] if calls else None


async def jouer(run: dict) -> None:
    """Le tour d'un agent : le faux modèle choisit une commande, elle part vers les routes, le tour se termine."""
    command = await asyncio.to_thread(modele, run["text"])
    if command:
        words = shlex.split(command)[2:]  # après « python3 /opt/data/noah.py »
        async with as_agent(run["agent"]) as h:
            if words[0] == "question":
                rest, why = words[1:], ""
                if "--pourquoi" in rest:
                    i = rest.index("--pourquoi")
                    why = rest[i + 1]
                    del rest[i:i + 2]
                r = await h.post("/agent-api/question", json={"question": " ".join(rest), "pourquoi": why})
                run["question"] = r.json()
            elif words[0] == "repondre":
                run["resultat"] = (await h.post(f"/agent-api/question/{words[1]}/repondre", json={"reponse": " ".join(words[2:])})).json()
            elif words[0] == "remonter":
                run["resultat"] = (await h.post(f"/agent-api/question/{words[1]}/remonter", json={"savoir": " ".join(words[2:])})).json()
    finish(run, "J'attends la réponse." if command and command.split()[2] == "question" else "C'est fait.")


async def joueur() -> None:
    while True:
        for run in list(runs):
            if not run["joue"]:
                run["joue"] = True
                await jouer(run)
        await asyncio.sleep(0.01)


def _calm() -> tuple:
    with db.connect() as c:
        state = (c.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0],
                 tuple(tuple(r) for r in c.execute("SELECT id, etat, a, maj FROM questions ORDER BY id")),
                 tuple(tuple(r) for r in c.execute("SELECT id, etat FROM delegations ORDER BY id")))
    return (len(runs), sum(1 for r in runs if r["joue"]), state)


async def settle():
    for _ in range(50):
        await asyncio.sleep(0.005)
    last, calm, deadline = _calm(), 0, time.monotonic() + 8
    while calm < 60 and time.monotonic() < deadline:
        await asyncio.sleep(0.005)
        now = _calm()
        calm, last = (calm + 1, last) if now == last else (0, now)


async def deleguer(de: str, vers: str, consigne: str) -> dict:
    async with as_agent(de) as h:
        r = await h.post("/agent-api/demander", json={"agent": vers, "consigne": consigne})
    assert r.status_code == 200, r.text
    with db.connect() as c:
        return r.json() | {"conversation_id": c.execute("SELECT conversation_id FROM delegations WHERE id = ?", (r.json()["id"],)).fetchone()[0]}


def question(qid: str) -> dict:
    return questions.get(qid)


def toutes() -> list[dict]:
    with db.connect() as c:
        return [questions._ligne(r) for r in c.execute("SELECT * FROM questions ORDER BY cree, rowid")]


def clear():
    with db.connect() as c:
        c.execute("DELETE FROM questions")
        c.execute("DELETE FROM regles")
