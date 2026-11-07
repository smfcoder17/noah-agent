"""Le vrai serveur et la vraie interface, avec Hermes et le modèle rapide simulés : pour éprouver le chat pendant le travail dans un
navigateur, sans clé. La transmission à un vrai Hermes a sa preuve à part (steer_vrai.sh). Voir chat_pendant.mjs.

    docker run --rm -p 127.0.0.1:8099:8099 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/chat_pendant_serveur.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import uvicorn  # noqa: E402

from noah import auth, db, hermes, main, media  # noqa: E402

db.init()
alice = auth.create_user("alice", os.environ.get("MOT_DE_PASSE", "motdepasse-essai"))
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
main._new_conversation(alice, "a1", "Conversation", main=True)

steered: list[str] = []
started: list[str] = []
finish: dict[str, asyncio.Event] = {}


async def start_run(agent, text, session_id):
    started.append(text)
    run = f"run-{len(started)}"
    finish[run] = asyncio.Event()
    return run


async def run_events(agent, run_id):
    n = int(run_id.split("-")[1])
    yield "tool.started", {"tool": "read_file", "args": {"path": "/opt/data/workspace/rapport.pdf"}}
    await asyncio.sleep(0.5)
    yield "tool.started", {"tool": "web_search", "args": {"query": "prix du cuivre"}}
    if "NOTION" in started[n - 1]:
        accord.clear()
        yield "approval.request", {"request_id": "demande-2", "execution_generation": 1, "description": 'Outil « notion » : notion_create_pages\n{"pages": [{"parent": {"data_source_id": "d4b95a89-5612-40c9-842f-12d4f25e415c"}, "properties": {"Name": "Mon post du jour"}}], "telemetry": {"intent": "Create a post"}}'}
        await accord.wait()
    if "DEUX" in started[n - 1]:
        for request_id, title in (("demande-a", "Premier"), ("demande-b", "Second")):
            accord.clear()
            yield "approval.request", {"request_id": request_id, "execution_generation": 1, "description": 'Outil « notion » : create_page\n{"title": "' + title + '"}'}
            await accord.wait()
    if "ACCORD" in started[n - 1]:
        accord.clear()
        yield "approval.request", {"request_id": "demande-1", "execution_generation": 1, "description": "Supprimer le dossier ?"}
        await accord.wait()
        yield "tool.started", {"tool": "read_file", "args": {"path": "apres-accord.txt"}}
    await finish[run_id].wait()
    yield "run.completed", {"output": "Fini : " + started[n - 1].splitlines()[-1]}  # sans le contexte ajouté pour l'agent


accord = asyncio.Event()


async def answer_approval(agent, run_id, request_id, generation, approve):
    accord.set()
    if request_id == "demande-a":  # la réponse met du temps à revenir : le second accord arrive entre-temps
        await asyncio.sleep(5)


async def steer_run(agent, run_id, text):
    steered.append(text)


async def triage(agent_id, name, role, text, history, doing):
    if text.startswith("Tu en es"):
        return {"type": "question", "reponse": f"Là : {doing}."}
    if text.startswith("Plutôt"):
        return {"type": "precision", "reponse": "Compris, je lui passe ça."}
    return {"type": "tache", "reponse": "Je le fais juste après."}


async def healthy(*a, **k):
    return True


async def stop_run(agent, run_id):
    finish[run_id].set()


hermes.start_run, hermes.run_events, hermes.steer_run, hermes.stop_run, hermes.health = start_run, run_events, steer_run, stop_run, healthy
hermes.answer_approval = answer_approval
media.triage = triage


@main.app.post("/_essai/finir")
async def end_runs():
    for event in finish.values():
        event.set()
    return {"steered": steered, "started": started}


@main.app.post("/_essai/reprendre")
async def resume_without_screen():
    """Comme « C'est fait » sur un appel : le travail repart côté serveur, aucun écran ne suit son flux."""
    await main._resume_agent("a1", "NOTION suite")
    return {"ok": True}


@main.app.post("/_essai/deux")
async def two_approvals():
    await main._resume_agent("a1", "DEUX suite")
    return {"ok": True}


@main.app.get("/_essai/etat")
def state():
    return {"steered": steered, "started": started}


# Sans ce déplacement, la route d'envoi de la page d'accueil répondrait avant les deux routes d'essai.
main.app.router.routes[:0] = [main.app.router.routes.pop(), main.app.router.routes.pop(), main.app.router.routes.pop(), main.app.router.routes.pop()]
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning")
