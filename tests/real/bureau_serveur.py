"""Le vrai serveur et la vraie interface pour l'app de bureau (bureau_vps.mjs), avec Hermes et le modèle rapide simulés, sans clé.
Les données restent d'un démarrage à l'autre : c'est la coupure du serveur qu'on éprouve. L'agent répète « Réponds seulement : X » ;
« Travaille longtemps » le fait travailler jusqu'à POST /_essai/finir. /_essai/trafic rend ce que le serveur a reçu depuis le dernier
effacement : la capture de G3.1, le mot de passe ne doit s'y trouver nulle part.

    docker run -d --name noah-essai-bureau-1 -p 127.0.0.1:18473:8099 -e NOAH_WEB_DIR=/web -e NOAH_DATA_DIR=/donnees \
      -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" python:3.12-slim \
      sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/bureau_serveur.py"
"""
import asyncio
import json
import os
import sys

os.environ.setdefault("NOAH_DATA_DIR", "/donnees")
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import uvicorn  # noqa: E402

from noah import auth, db, hermes, main, media  # noqa: E402

PASSWORD = os.environ.get("MOT_DE_PASSE", "motdepasse-essai")
db.init()
if not auth.has_users():
    alice = auth.create_user("alice", PASSWORD)
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    db.set_setting("provider", "openrouter")
    db.set_setting("onboarded", "1")
    main._new_conversation(alice, "a1", "Conversation", main=True)

started: list[str] = []
steered: list[str] = []
finish: dict[str, asyncio.Event] = {}


async def start_run(agent, text, session_id):
    started.append(text.splitlines()[-1])  # sans le contexte ajouté pour l'agent
    run = f"run-{len(started)}"
    finish[run] = asyncio.Event()
    return run


async def run_events(agent, run_id):
    text = started[int(run_id.split("-")[1]) - 1]
    if text.startswith("Travaille longtemps"):
        yield "tool.started", {"tool": "web_search", "args": {"query": "prix du cuivre"}}
        await finish[run_id].wait()
    yield "run.completed", {"output": text.removeprefix("Réponds seulement : ")}


async def steer_run(agent, run_id, text):
    steered.append(text)


async def triage(agent_id, name, role, text, history, doing):
    return {"type": "question", "reponse": f"Là : {doing}."}


async def healthy(*a, **k):
    return True


async def stop_run(agent, run_id):
    finish[run_id].set()


hermes.start_run, hermes.run_events, hermes.steer_run, hermes.stop_run, hermes.health = start_run, run_events, steer_run, stop_run, healthy
media.triage = triage

traffic: list[dict] = []


async def respond(send, payload) -> None:
    body = json.dumps(payload).encode()
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})


async def recorded(scope, receive, send):
    """Avant toute l'application : aucune requête n'y échappe, et le corps n'est pas retenu en route."""
    if scope["type"] != "http":
        return await main.app(scope, receive, send)
    path = scope["path"]
    if path == "/_essai/trafic":
        out = list(traffic)
        if scope["method"] == "POST":
            traffic.clear()
        return await respond(send, out)
    if path == "/_essai/finir":
        for event in finish.values():
            event.set()
        return await respond(send, {"started": started, "steered": steered})
    headers = {k.decode(): v.decode("latin-1") for k, v in scope["headers"]}
    secret = PASSWORD.encode()
    entry = {"m": scope["method"], "p": path, "ua": headers.get("user-agent", ""),
             "mdp": secret in scope["query_string"] or any(PASSWORD in v for v in headers.values())}
    traffic.append(entry)

    async def watched():
        message = await receive()
        if secret in message.get("body", b""):
            entry["mdp"] = True
        return message

    await main.app(scope, watched, send)


uvicorn.run(recorded, host="0.0.0.0", port=8099, log_level="warning")
