"""Demande faite en appel pendant que l'agent travaille, puis raccroché : elle part quand il a fini, même si l'écran se ferme.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/voice/ensuite_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, db, hermes, main, pendant  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
pendant.POLL = 0.02
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
started: list[str] = []
refuse = [False]


async def start_run(agent, text, session_id):
    if refuse[0]:
        raise httpx.ConnectError("agent arrêté")
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    yield "run.completed", {"output": f"Fait : {started[-1]}"}


async def online(*a, **k):
    return True


hermes.start_run = start_run
hermes.run_events = run_events
hermes.health = online


def rows(conversation=conv):
    with db.connect() as c:
        return [(r["role"], r["text"]) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id", (conversation,))]


async def settle():
    for _ in range(100):
        await asyncio.sleep(0.02)
        if all(t.done() for t in pendant._drains.values()):
            return
    raise AssertionError("la demande attend encore")


async def later(user, text="Crée le fichier", conversation=conv, agent="a1"):
    return await main.chat_after(main.LaterMessage(agent_id=agent, text=text, conversation_id=conversation), user=user)


async def everything():
    # 1. L'agent travaille : rien ne part, puis la demande part dès qu'il a fini.
    main.task_state[conv] = "work"
    assert (await later(alice))["ok"]
    await asyncio.sleep(0.15)
    assert started == [] and rows() == [], "rien ne doit partir par-dessus un tour en cours"
    main.task_state[conv] = "done"
    await settle()
    assert started == ["Crée le fichier"], started
    assert rows() == [("user", "Crée le fichier"), ("agent", "Fait : Crée le fichier")], rows()
    print("1. elle attend la fin du tour en cours, puis elle part et la réponse est écrite")

    # 2. Agent libre : elle part tout de suite.
    await later(alice, "Deuxième")
    await settle()
    assert started[-1] == "Deuxième"
    print("2. agent libre : elle part tout de suite")

    # 3. Sans conversation précisée : la conversation principale.
    await later(alice, "Sans fil", conversation=None)
    await settle()
    assert ("user", "Sans fil") in rows()
    print("3. sans conversation précisée : la principale")

    # 4. Agent arrêté : la demande et l'échec restent écrits.
    refuse[0] = True
    await later(alice, "Pendant la panne")
    await settle()
    refuse[0] = False
    assert rows()[-2] == ("user", "Pendant la panne") and rows()[-1][0] == "error", rows()[-2:]
    print("4. agent arrêté : la demande et l'échec restent écrits")

    # 5. Trop longtemps occupé : ce n'est pas perdu en silence.
    pendant.WAIT = 0.05
    main.task_state[conv] = "work"
    await later(alice, "Trop tard")
    await settle()
    assert rows()[-2] == ("user", "Trop tard") and rows()[-1][0] == "error", rows()[-2:]
    main.task_state[conv] = "done"
    pendant.WAIT = 86400
    print("5. agent occupé trop longtemps : écrit, et dit")

    # 6. Les droits de /api/chat.
    for user, agent, conversation in ((bruno, "a1", conv), (alice, "absent", conv), (alice, "a1", "autre")):
        try:
            await later(user, "Non", conversation, agent)
        except main.HTTPException as e:
            assert e.status_code in (403, 404), e.status_code
            continue
        raise AssertionError(f"accepté : {user} {agent} {conversation}")
    print("6. mêmes droits que /api/chat")


asyncio.run(everything())
print("OK")
