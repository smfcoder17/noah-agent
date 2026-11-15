"""Chaque réponse de l'agent garde le modèle qui l'a écrite : l'écran marque un changement de modèle dans la conversation.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/modele_par_reponse_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, db, decision, hermes, main, media, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "openai/gpt-5.1")
db.set_setting("api_key", "cle", secret=True)
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
# Un message d'avant ce changement : il n'a pas de modèle, et se lit toujours.
main._save_message(conv, "agent", "Ancienne réponse.")


def upstream(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if body.get("stream"):
        chunk = {"choices": [{"index": 0, "delta": {"content": "ok"}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
        return httpx.Response(200, content=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode(), headers={"content-type": "text/event-stream"})
    return httpx.Response(200, json={"id": "x", "object": "chat.completion", "created": 1, "model": body.get("model"),
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
calls: list[dict] = []  # les appels au modèle que l'agent fait pendant son tour


async def start_run(agent, text, session_id):
    return "run-1"


async def run_events(agent, run_id):
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t", headers={"Authorization": f"Bearer {relay.token_for('a1')}"}) as c:
        for call in calls:
            r = await c.post("/relay/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}], **call})
            assert r.status_code == 200, r.text
    yield "message.delta", {"delta": "Voilà."}
    yield "run.completed", {"output": ""}


async def healthy(*a, **k):
    return True


async def no_replies(agent_id, text):
    return []


hermes.start_run, hermes.run_events, hermes.health = start_run, run_events, healthy
media.quick_replies = no_replies
session = auth.new_session(alice, "test", "web")


async def chat(text: str) -> list[dict]:
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t", headers={"Authorization": f"Bearer {session}"}, timeout=20) as c:
        r = await c.post("/api/chat", json={"agent_id": "a1", "conversation_id": conv, "text": text})
        assert r.status_code == 200, r.text[:200]
        out = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    for _ in range(100):
        if not main._running_runs or all(t.done() for t in main._running_runs):
            break
        await asyncio.sleep(0.02)
    return out


async def stored() -> list[dict]:
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t", headers={"Authorization": f"Bearer {session}"}) as c:
        r = await c.get(f"/api/conversations/{conv}/messages")
        assert r.status_code == 200, r.text
        return [m for m in r.json() if m["role"] == "agent"]


def done_of(events: list[dict]) -> dict:
    return next(e for e in events if e["type"] == "done")


calls[:] = [{"model": "openai/gpt-5.1"}]
first = asyncio.run(chat("bonjour"))
assert done_of(first).get("model") == "openai/gpt-5.1", done_of(first)
rows = asyncio.run(stored())
assert rows[0]["model"] is None and rows[0]["text"] == "Ancienne réponse.", rows[0]
assert rows[-1]["model"] == "openai/gpt-5.1", rows[-1]
print("1. la réponse garde son modèle, l'écran l'apprend dès la fin du tour ; un ancien message se lit sans modèle")

db.set_setting("model_a1", "anthropic/claude-sonnet-4.5")  # la personne change le cerveau de l'agent
calls[:] = [{"model": "openai/gpt-5.1", "stream": True}]  # l'agent demande encore l'ancien : le relais suit le nouveau
second = asyncio.run(chat("et maintenant ?"))
assert done_of(second).get("model") == "anthropic/claude-sonnet-4.5", done_of(second)
assert asyncio.run(stored())[-1]["model"] == "anthropic/claude-sonnet-4.5"
print("2. après un changement de modèle, la réponse suivante porte le nouveau (appel en flux)")

helper = decision.model
decision.model = lambda: "petit/modele"
calls[:] = [{"model": "openai/gpt-5.1"}, {"model": "petit/modele"}]  # un petit travail après la réponse du cerveau
asyncio.run(chat("encore"))
decision.model = helper
assert asyncio.run(stored())[-1]["model"] == "anthropic/claude-sonnet-4.5", "le modèle de décision n'écrit pas la réponse"
print("3. un petit travail du modèle de décision ne prend pas la place du cerveau")

calls[:] = []  # aucun appel mesuré pendant ce tour (réponse sans modèle, ou tour d'un autre)
silent = asyncio.run(chat("rien"))
assert "model" not in done_of(silent) and asyncio.run(stored())[-1]["model"] is None
assert "conv" not in relay.turn_model and conv not in relay.turn_model, relay.turn_model
print("4. un tour sans appel ne reprend pas le modèle du tour précédent, et rien ne reste en mémoire")
print("Tout est tenu.")
