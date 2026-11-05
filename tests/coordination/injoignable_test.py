"""Modèle injoignable : la conversation le dit tout de suite, au lieu de laisser Hermes réessayer plusieurs minutes en silence.
Vrais `_run` et relais ; seule la machine de l'agent est simulée, et le fournisseur refuse la connexion.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/coordination/injoignable_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main, relay  # noqa: E402

db.init()
owner = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a', 'Alma', 'Son rôle', 'k')")
db.set_setting("provider", "openrouter")
agent_http = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a')}"})
main.MODEL_WATCH = 0.05
main.MODEL_DOWN_LIMIT = 0.3

reachable = [False]


def upstream(request: httpx.Request) -> httpx.Response:
    if not reachable[0]:
        raise httpx.ConnectError("connexion refusée")
    return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
ask = {"model": "m", "messages": []}

# Le relais rend une erreur lisible au lieu d'une exception, et retient la panne.
r = agent_http.post("/relay/v1/chat/completions", json=ask)
assert r.status_code == 502 and "injoignable" in r.json()["error"]["message"], r.text
assert relay.failing_for("a") is not None
r = agent_http.post("/relay/v1/chat/completions", json=ask | {"stream": True})
assert r.status_code == 502, r.text
assert agent_http.get("/relay/v1/models").status_code == 502
reachable[0] = True
assert agent_http.post("/relay/v1/chat/completions", json=ask).status_code == 200
assert relay.failing_for("a") is None, "une réponse efface la panne"
reachable[0] = False

# Machine de l'agent simulée : pas d'événement tant que personne ne l'arrête.
stopped: list[str] = []
events: list[asyncio.Queue] = []


async def fake_start(agent, text, session_id):
    events.append(asyncio.Queue())
    return str(len(events) - 1)


async def fake_events(agent, run_id):
    while True:
        kind, data = await events[int(run_id)].get()
        yield kind, data
        if kind.startswith("run."):
            return


async def fake_stop(agent, run_id):
    stopped.append(run_id)
    events[int(run_id)].put_nowait(("run.cancelled", {}))


hermes.start_run, hermes.run_events, hermes.stop_run = fake_start, fake_events, fake_stop


async def call_relay():
    """L'agent appelle le relais pendant la tâche, comme Hermes."""
    await asyncio.to_thread(agent_http.post, "/relay/v1/chat/completions", json=ask)


async def read(stream, conv):
    out = []
    async for chunk in stream:
        if chunk.startswith("data:"):
            out.append(json.loads(chunk[5:]))
    return out


async def scenario():
    # 1. Jamais joint : prévenu vite, puis arrêt avec le motif, et le motif reste dans la conversation.
    conv = main._new_conversation(owner, "a", "Conversation", main=True)
    begin = time.time()
    stream = await main._run(main._agent("a"), conv, "Bonjour")
    reader = asyncio.create_task(read(stream, conv))
    await asyncio.sleep(0.05)
    await call_relay()
    got = await asyncio.wait_for(reader, 5)
    assert time.time() - begin < 3, "arrêté bien avant les minutes de réessai d'Hermes"
    assert any(e["type"] == "activity" and "ne répond pas" in e["label"] for e in got), got
    done = [e for e in got if e["type"] == "done"]
    assert done and done[0]["status"] == "failed" and "injoignable" in done[0]["error"], got
    assert stopped == ["0"]
    assert main.task_state[conv] == "error"
    with db.connect() as c:
        saved = [dict(r) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ?", (conv,))]
    assert any(m["role"] == "error" and "injoignable" in m["text"] for m in saved), saved

    # 2. Le modèle a répondu pendant cette tâche, puis coupe : on prévient, mais le long travail n'est pas perdu.
    conv = main._new_conversation(owner, "a", "Longue tâche")
    stream = await main._run(main._agent("a"), conv, "Une longue tâche")
    reader = asyncio.create_task(read(stream, conv))
    await asyncio.sleep(0.05)
    reachable[0] = True
    await call_relay()
    reachable[0] = False
    await call_relay()
    await asyncio.sleep(main.MODEL_DOWN_LIMIT * 2)
    assert stopped == ["0"], "une coupure après une réponse n'arrête pas la tâche"
    reachable[0] = True
    await call_relay()
    events[-1].put_nowait(("message.delta", {"delta": "Fini."}))
    events[-1].put_nowait(("run.completed", {}))
    got = await asyncio.wait_for(reader, 5)
    assert any(e["type"] == "activity" and "ne répond pas" in e["label"] for e in got), got
    assert [e for e in got if e["type"] == "done"][0]["status"] == "completed", got

    # 3. Une panne d'avant cette tâche ne la condamne pas d'avance.
    reachable[0] = False
    await call_relay()
    await asyncio.sleep(main.MODEL_DOWN_LIMIT * 1.5)
    reachable[0] = True
    conv = main._new_conversation(owner, "a", "Après la panne")
    stream = await main._run(main._agent("a"), conv, "Bonjour")
    reader = asyncio.create_task(read(stream, conv))
    await asyncio.sleep(main.MODEL_DOWN_LIMIT * 1.5)
    assert stopped == ["0"], "une panne passée ne compte pas"
    events[-1].put_nowait(("run.completed", {"output": "Bonjour."}))
    got = await asyncio.wait_for(reader, 5)
    assert not any(e["type"] == "activity" for e in got), got


async def lost_turn():
    """Un redémarrage a coupé un tour : Hermes refuse tout message dans cette conversation jusqu'à ce qu'on en prenne acte."""
    reachable[0] = True
    discarded: list[tuple[str, str]] = []

    async def fake_discard(agent_id, session, profile=None):
        discarded.append((agent_id, session))

    hermes.discard_lost_turn = fake_discard
    conv = main._new_conversation(owner, "a", "Après le redémarrage")
    stream = await main._run(main._agent("a"), conv, "Tu es là ?")
    reader = asyncio.create_task(read(stream, conv))
    await asyncio.sleep(0.05)
    first = len(events) - 1
    events[first].put_nowait(("run.failed", {"error": hermes.LOST_TURN}))
    await asyncio.sleep(0.1)
    assert discarded == [("a", f"noah-{conv}")], discarded
    assert len(events) == first + 2, "le message repart dans un nouveau run"
    events[-1].put_nowait(("message.delta", {"delta": "Oui."}))
    events[-1].put_nowait(("run.completed", {}))
    got = await asyncio.wait_for(reader, 5)
    starts = [e["run_id"] for e in got if e["type"] == "start"]
    assert starts == [str(first), str(first + 1)], "l'application apprend le nouveau run, pour pouvoir l'arrêter"
    assert any(e["type"] == "activity" and "coupé par un redémarrage" in e["label"] for e in got), got
    assert [e for e in got if e["type"] == "done"][0]["status"] == "completed", got
    assert not main._runs, "aucun run oublié"

    # La levée échoue : le message le dit, sans boucler.
    async def broken_discard(agent_id, session, profile=None):
        raise httpx.ConnectError("lanceur injoignable")

    hermes.discard_lost_turn = broken_discard
    conv = main._new_conversation(owner, "a", "Levée impossible")
    stream = await main._run(main._agent("a"), conv, "Tu es là ?")
    reader = asyncio.create_task(read(stream, conv))
    await asyncio.sleep(0.05)
    events[-1].put_nowait(("run.failed", {"error": hermes.LOST_TURN}))
    got = await asyncio.wait_for(reader, 5)
    done = [e for e in got if e["type"] == "done"][0]
    assert done["status"] == "failed" and "redémarrage" in done["error"], got


asyncio.run(scenario())
asyncio.run(lost_turn())
print("Modèle injoignable : dit vite, tâche sans réponse arrêtée, long travail gardé, panne passée oubliée ; tour perdu levé.")
