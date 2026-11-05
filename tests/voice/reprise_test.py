"""Un message sans rapport n'est pas une reprise, et le premier message après un redémarrage ne paie pas le démarrage.

Preuve sur un vrai conteneur Hermes : tests/real/reprise_vrai.py et tests/real/vitesse.py.
    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/voice/reprise_test.py"
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
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, chauffe, db, handoff, hermes, main, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Rita', '', 'k2', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("api_key", "cle", secret=True)
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
agent = main._agent("a1")
started: list[str] = []
end = ["run.completed", {"output": "Salut !"}]


async def start_run(a, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(a, run_id):
    yield end[0], end[1]


async def online(*a, **k):
    return True


hermes.start_run = start_run
hermes.run_events = run_events
hermes.health = online


async def say(text, extra=""):
    stream = await main._run(agent, conv, text, context=main._left_open("a1", conv) + extra)
    async for _ in stream:
        pass
    while main._running_runs:
        await asyncio.sleep(0.01)


async def turns():
    # 1. Rien en suspens : le prompt reste celui d'avant, donc en cache.
    await say("Bonjour")
    assert started[-1] == "Bonjour", started[-1]
    print("1. rien en suspens : aucune note")

    # 2. Une demande coupée : le message suivant le dit à l'agent, et lui demande de répondre à ce message.
    end[:] = ["run.cancelled", {}]
    await say("Connecte-toi à mon compte Google.")
    end[:] = ["run.completed", {"output": "Salut !"}]
    await say("hi")
    assert "Connecte-toi à mon compte Google." in started[-1] and "s'est arrêtée avant la fin" in started[-1] and started[-1].endswith("hi"), started[-1]
    assert "Réponds au message ci-dessous" in started[-1], started[-1]
    print("2. demande coupée : le message suivant répond à ce message")

    # 3. Une seule fois : ce tour a fini normalement.
    await say("Merci")
    assert started[-1] == "Merci", started[-1]
    print("3. une fois fini, plus de note")

    # 4. Un échec aussi, et un serveur qui redémarre en plein tour : le tour ouvert survit, il est en base.
    end[:] = ["run.failed", {"error": "boom"}]
    await say("Fais le rapport")
    assert db.get_setting(f"tour_ouvert:{conv}") == "Fais le rapport"
    end[:] = ["run.completed", {"output": "Salut !"}]
    await say("hi")
    assert "Fais le rapport" in started[-1], started[-1]
    print("4. échec : même note, lue en base")

    # 5. Un appel que plus aucun tour n'attend : sa réponse relancera l'agent, il n'a pas à le relancer lui-même.
    call = handoff.open_call("a1", "Connecte-toi à Google dans l'écran.")
    assert handoff.idle_call("a1") is call
    await say("hi")
    assert "Connecte-toi à Google dans l'écran." in started[-1] and "sans `attendre`" in started[-1], started[-1]
    call["attentifs"] = 1  # un tour l'attend encore
    assert handoff.idle_call("a1") is None and "attendre" not in main._left_open("a1", conv)
    call["attentifs"] = 0
    handoff.close_call("a1", call["id"], "impossible")
    assert handoff.idle_call("a1") is None
    print("5. appel sans personne qui l'attend : l'agent sait que la réponse lui reviendra")

    # 6. Un appel expiré ne se relance pas.
    assert "Ne le relance pas" in handoff._result("x", "inconnu")["conseil"]
    print("6. appel terminé : le conseil dit de ne pas le relancer")

    # 7. La réponse à un appel, elle, demande bien de reprendre : aucune note ne le contredit.
    end[:] = ["run.cancelled", {}]
    await say("Fais le rapport")
    end[:] = ["run.completed", {"output": "ok"}]
    task = await main._resume_agent("a1", "C'est fait. Reprends où tu en étais.")
    await task
    assert started[-1] == "C'est fait. Reprends où tu en étais.", started[-1]
    print("7. reprise demandée : pas de note")


asyncio.run(turns())


# --- La chauffe : ni modèle, ni dépense, et une seule par démarrage -------------------------------------------------------
upstream_calls: list[dict] = []


def upstream(request: httpx.Request) -> httpx.Response:
    upstream_calls.append(json.loads(request.content))
    return httpx.Response(200, json={"choices": [{"message": {"content": "vrai modèle"}}], "usage": {"prompt_tokens": 5, "completion_tokens": 1}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
web = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})


def usage_rows():
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) AS n FROM usage").fetchone()["n"]


before = usage_rows()
db.set_setting("budget_monthly", "0")  # budget atteint : la chauffe passe quand même, elle ne coûte rien
r = web.post("/relay/v1/chat/completions", json={"model": "m", "stream": True, "messages": [{"role": "user", "content": relay.warmup_mark("a1")}]})
assert r.status_code == 200 and "text/event-stream" in r.headers["content-type"] and '"content": "ok"' in r.text and r.text.endswith("data: [DONE]\n\n"), r.text
r = web.post("/relay/v1/chat/completions", json={"model": "m", "messages": [{"role": "user", "content": relay.warmup_mark("a1")}]})
assert r.json()["choices"][0]["message"]["content"] == "ok", r.text
assert not upstream_calls and usage_rows() == before, "la chauffe ne touche ni au fournisseur, ni à la dépense"
print("8. la chauffe est servie par le relais : ni fournisseur, ni dépense")

db.set_setting("budget_monthly", "")
# La marque d'un autre, une phrase qui lui ressemble, ou un résumé de conversation qui la cite : le vrai modèle.
for fake in (relay.warmup_mark("a2"), "[Entretien technique de Noah, rien à faire]", "bonjour", "TURNS TO SUMMARIZE:\n" + relay.warmup_mark("a1") + "\n" + "x" * 2000):
    r = web.post("/relay/v1/chat/completions", json={"model": "m", "messages": [{"role": "assistant", "content": relay.warmup_mark("a1")}, {"role": "user", "content": fake}]})
    assert r.json()["choices"][0]["message"]["content"] == "vrai modèle", (fake[:80], r.text)
assert len(upstream_calls) == 4
print("9. tout autre message va au vrai modèle")

warmed: list[str] = []
deleted: list[str] = []
alive = {"v": False}
free = {"v": True}


async def health(a):
    return alive["v"]


async def warm_events(a, run_id):
    yield "run.completed", {}


class Http:
    async def delete(self, url, **kw):
        deleted.append(url)
        return httpx.Response(200)


async def warm_start(a, text, session_id):
    warmed.append((text, session_id))
    return "run-chauffe"


hermes.health = health
hermes.start_run = warm_start
hermes.run_events = warm_events
hermes.http = lambda: Http()
agents = lambda: [hermes.Agent("a1", "k")]  # noqa: E731
ready = lambda a: free["v"]  # noqa: E731


async def boots():
    await chauffe._pass(agents, ready)
    assert not warmed, "un agent qui ne répond pas ne se chauffe pas"
    alive["v"] = True
    free["v"] = False
    await chauffe._pass(agents, ready)
    assert not warmed, "pas pendant une mise à jour ou un tour"
    free["v"] = True
    await chauffe._pass(agents, ready)
    await chauffe._pass(agents, ready)
    assert len(warmed) == 1 and warmed[0][0] == relay.warmup_mark("a1") and warmed[0][1].startswith(chauffe.SESSION), warmed
    assert deleted and deleted[-1].endswith(f"/api/sessions/{warmed[0][1]}"), "sa session ne reste pas dans les recherches de l'agent"
    alive["v"] = False  # il redémarre
    await chauffe._pass(agents, ready)
    alive["v"] = True
    await chauffe._pass(agents, ready)
    assert len(warmed) == 2, "à chaque redémarrage"
    print("10. une chauffe par démarrage, jamais pendant un tour, et sa session s'efface")

    # Un contexte qui a passé la limite se résume tout de suite, sur sa vraie session, sans personne qui attend.
    warmed.clear()
    sizes = [hermes.CONTEXT_LIMIT - 1, hermes.CONTEXT_LIMIT]

    async def events_of_size(a, run_id):
        if sizes:
            relay.context_size[conv] = sizes.pop(0)
        yield "run.completed", {"output": "ok"}

    hermes.run_events = events_of_size
    await say("Petit contexte")
    await asyncio.sleep(0.05)
    assert [w for w in warmed if w[0] != "Petit contexte"] == [], warmed
    await say("Gros contexte")
    await asyncio.sleep(0.05)
    assert (relay.warmup_mark("a1"), f"noah-{conv}") in warmed and conv not in relay.context_size, warmed
    print("11. contexte trop gros : résumé tout de suite, pendant que personne n'attend")


asyncio.run(boots())
print("OK")
