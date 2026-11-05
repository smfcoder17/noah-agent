"""Le vrai serveur et la vraie interface, avec Hermes et le tri simulés : pour éprouver l'appel vocal dans un navigateur, sans clé.
La voix elle-même (transcription, réponse rapide, son) est simulée côté navigateur. Voir appel_defauts.mjs.

    docker run --rm --name noah-essai-appel-defauts -p 127.0.0.1:8097:8097 -e APOLLO_WEB_DIR=/web -v noah-pip-cache:/root/.cache/pip \
      -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/appel_defauts_serveur.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from apollo import auth, db, hermes, main, media  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a0', 'Ailleurs', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
main._new_conversation(alice, "a0", "Conversation", main=True)

steered: list[str] = []
started: list[str] = []
finish: dict[str, asyncio.Event] = {}
settings = {"start_delay": 0.0, "output": ""}  # Hermes lent à démarrer ; ce que l'agent répond


async def start_run(agent, text, session_id):
    started.append(text)
    run = f"run-{len(started)}"
    finish[run] = asyncio.Event()
    await asyncio.sleep(settings["start_delay"])
    return run


async def run_events(agent, run_id):
    text = started[int(run_id.split("-")[1]) - 1].splitlines()[-1]  # sans le contexte ajouté pour l'agent
    yield "tool.started", {"tool": "web_search", "args": {"query": "prix du cuivre"}}
    if "longtemps" in text:
        await finish[run_id].wait()
    else:
        await asyncio.sleep(0.3)
    yield "run.completed", {"output": settings["output"] or f"Fini : {text}"}


async def steer_run(agent, run_id, text):
    steered.append(text)


async def triage(agent_id, name, role, text, history, doing):
    if text.startswith("Plutôt"):
        return {"type": "precision", "reponse": "Compris, je lui passe ça."}
    return {"type": "tache", "reponse": "Je le fais juste après."}


async def healthy(*a, **k):
    return True


async def stop_run(agent, run_id):
    finish[run_id].set()


async def read_file(agent_id, path):
    """Un fichier dont le nom contient « panne » répond comme une machine d'agent injoignable."""
    return httpx.Response(502, text="mauvaise passerelle") if "panne" in path else httpx.Response(200, content=b"contenu")


hermes.start_run, hermes.run_events, hermes.steer_run, hermes.stop_run, hermes.health, hermes.read_file = start_run, run_events, steer_run, stop_run, healthy, read_file
media.triage = triage


@main.app.post("/_essai/agent/{agent_id}")
def new_agent(agent_id: str):
    """Un agent neuf pour chaque scénario, sans conversation : la principale naît au premier message."""
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent_id, agent_id, alice))
    return {"id": agent_id}


@main.app.post("/_essai/regler")
async def tune(request: main.Request):
    settings.update(await request.json())
    return settings


@main.app.post("/_essai/finir")
async def end_runs():
    for event in finish.values():
        event.set()
    return {"ok": True}


@main.app.get("/_essai/etat")
def state():
    return {"steered": steered, "started": [t.splitlines()[-1] for t in started]}


@main.app.get("/_essai/messages/{agent_id}")
def messages(agent_id: str):
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT m.role, m.text FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.agent_id = ? ORDER BY m.id", (agent_id,))]


# Sans ce déplacement, la route d'envoi de la page d'accueil répondrait avant les routes d'essai.
essai = [r for r in main.app.router.routes if getattr(r, "path", "").startswith("/_essai")]
main.app.router.routes[:] = essai + [r for r in main.app.router.routes if r not in essai]
uvicorn.run(main.app, host="0.0.0.0", port=8097, log_level="warning")
