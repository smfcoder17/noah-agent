"""Le vrai serveur et la vraie interface, avec Hermes simulé : pour voir le reçu dans un navigateur, sans clé. Voir recu_ecran.mjs.

    docker run --rm -p 127.0.0.1:8117:8117 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/recu_serveur.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import uvicorn  # noqa: E402

from noah import auth, db, hermes, main, recu  # noqa: E402

db.init()
alice = auth.create_user("alice", os.environ.get("MOT_DE_PASSE", "motdepasse-essai"))
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)


def tool(name: str, end: str = "tool.completed") -> list[tuple]:
    return [("tool.started", {"tool_name": name, "args": {}, "preview": None}), (end, {"tool_name": name, "args": {}, "preview": None})]


SCRIPTS = {  # le mot trouvé dans le message décide de ce que le run simulé fait
    "MENSONGE": [("assistant.delta", {"delta": "J'ai envoyé le courriel à Marc."})],
    "VRAI": [*tool("mcp_gmail_send_message"), ("assistant.delta", {"delta": "J'ai envoyé le courriel à Marc."})],
    "CACHE": [*tool("mcp_gmail_delete_message"), ("assistant.delta", {"delta": "Voici le résumé de ta journée."})],
    "NAVIGATEUR": [*tool("browser_click"), ("assistant.delta", {"delta": "J'ai publié ton article."})],
    "ECHEC": [*tool("mcp_blog_publish_post", "tool.failed"), ("assistant.delta", {"delta": "C'est publié."})],
    "ORDINAIRE": [("assistant.delta", {"delta": "Bonjour, en quoi puis-je aider ?"})],
}
started: list[str] = []


async def start_run(agent, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    text = started[int(run_id.split("-")[1]) - 1]
    for word, pairs in SCRIPTS.items():
        if word in text:
            for pair in pairs:
                yield pair
    yield "run.completed", {"output": ""}


async def healthy(*a, **k):
    return True


hermes.start_run, hermes.run_events, hermes.health = start_run, run_events, healthy
assert recu.claims_in("J'ai envoyé le courriel à Marc.")
uvicorn.run(main.app, host="0.0.0.0", port=8117, log_level="warning")
