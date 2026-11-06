"""Le chat vivant, côté serveur : la réponse sans le récit du travail, les réactions, les réponses à toucher.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/chat_vivant_test.py"
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

from noah import auth, db, events, hermes, machine, main, media  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
eve = auth.create_user("eve", "motdepasse-e")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
script: list = []
asked_replies: list[str] = []
next_replies: list = [[]]


async def start_run(agent, text, session_id):
    return "run-1"


async def run_events(agent, run_id):
    for pair in script:
        yield pair


async def healthy(*a, **k):
    return True


async def quick_replies(agent_id, text):
    asked_replies.append(text)
    if isinstance(next_replies[0], Exception):
        raise next_replies[0]
    return next_replies[0]


hermes.start_run, hermes.run_events, hermes.health = start_run, run_events, healthy
media.quick_replies = quick_replies
session = auth.new_session(alice, "test", "web")


async def chat(text: str) -> list[dict]:
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t", headers={"Authorization": f"Bearer {session}"}, timeout=20) as c:
        r = await c.post("/api/chat", json={"agent_id": "a1", "conversation_id": conv, "text": text})
        assert r.status_code == 200, r.text[:200]
        out = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    for _ in range(100):
        if not main._running_runs or all(t.done() for t in main._running_runs):
            break
        await asyncio.sleep(0.02)
    return out


def last_agent():
    with db.connect() as c:
        return dict(c.execute("SELECT id, role, text, detail FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", (conv,)).fetchone())


def delta(text):
    return ("message.delta", {"delta": text})


TOOL = ("tool.started", {"tool": "read_file", "args": {"path": "a.txt"}})
DONE = ("run.completed", {"output": ""})

# La réponse : ce qui suit le dernier outil.
script[:] = [delta("Je regarde."), TOOL, delta("Je clique."), TOOL, delta("Le post est "), delta("en ligne."), DONE]
sent = asyncio.run(chat("publie"))
row = last_agent()
assert row["text"] == "Le post est en ligne.", row
assert json.loads(row["detail"])["etapes"] == ["Je regarde.", "Je clique."], "le récit reste consultable"
assert sum(e["type"] == "etape" for e in sent) == 2, "l'écran range le récit au même moment"
assert not asked_replies, "pas de réponse à toucher sans question"
print("1. le récit du travail quitte la réponse")

# Un widget écrit avant un outil se garde.
script[:] = [delta('Voici :\n```noah\n{"type": "preview", "path": "a.html"}\n```'), TOOL, delta("Fini."), DONE]
asyncio.run(chat("montre"))
row = last_agent()
assert '"preview"' in row["text"] and row["text"].endswith("Fini."), row
assert row["detail"] is None
print("2. un widget écrit en chemin reste dans la réponse")

# Tout dit avant le dernier outil : sa dernière phrase est la réponse.
script[:] = [delta("Je regarde."), TOOL, delta("Le fichier est prêt."), TOOL, DONE]
asyncio.run(chat("prépare"))
row = last_agent()
assert row["text"] == "Le fichier est prêt." and json.loads(row["detail"])["etapes"] == ["Je regarde."], row
print("3. sans phrase après le dernier outil, la dernière écrite fait la réponse")

# Une erreur n'est pas masquée par une phrase de travail.
script[:] = [delta("Je regarde."), TOOL, ("run.failed", {"error": "panne"})]
sent = asyncio.run(chat("échoue"))
row = last_agent()
assert row["role"] == "error", row
print("4. une erreur reste une erreur")

# Une réaction en tête : posée sur le message de la personne, jamais affichée.
script[:] = [delta("[["), delta("🔥]] "), delta("Super idée."), DONE]
sent = asyncio.run(chat("BONNE IDÉE"))
assert {"type": "reaction", "emoji": "🔥"} in sent
assert all("[[" not in e.get("text", "") for e in sent)
assert last_agent()["text"] == "Super idée."
head = events.ReactionHead()
assert head.feed("[[oups]] du texte") == (None, "[[oups]] du texte"), "une marque inconnue reste du texte"
head = events.ReactionHead()
assert head.feed("Bonjour") == (None, "Bonjour") and head.feed(" toi") == (None, " toi"), "un texte ordinaire passe sans retard"
head = events.ReactionHead()
assert head.feed("[[") == (None, "") and head.flush() == (None, "[["), "un flux coupé ne perd rien"
assert events.ReactionHead().feed("[[👍]]") == ("👍", "")
print("5. réaction de l'agent : posée, jamais affichée")


async def api(method, path, user=alice, **kw):
    token = auth.new_session(user, "test", "web")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t", headers={"Authorization": f"Bearer {token}"}) as c:
        return await c.request(method, path, **kw)


rows = asyncio.run(api("GET", f"/api/conversations/{conv}/messages")).json()
user_row = [r for r in rows if r["text"] == "BONNE IDÉE"][-1]
agent_row = rows[-1]
assert user_row["reactions"] == {"agent": "🔥"}, user_row
url = f"/api/conversations/{conv}/messages/{agent_row['id']}/reaction"
assert asyncio.run(api("PUT", url, json={"emoji": "😈"})).status_code == 400, "seulement les réactions prévues"
assert asyncio.run(api("PUT", url, user=eve, json={"emoji": "👍"})).status_code in (403, 404), "une autre personne ne réagit pas"
assert asyncio.run(api("PUT", f"/api/conversations/{conv}/messages/999999/reaction", json={"emoji": "👍"})).status_code == 404
other = main._new_conversation(alice, "a1", "Autre")
assert asyncio.run(api("PUT", f"/api/conversations/{other}/messages/{agent_row['id']}/reaction", json={"emoji": "👍"})).status_code == 404, "un message d'une autre conversation"
machine.pop_context(conv)
assert asyncio.run(api("PUT", url, json={"emoji": "👍"})).status_code == 200
rows = asyncio.run(api("GET", f"/api/conversations/{conv}/messages")).json()
assert rows[-1]["reactions"] == {"user": "👍"}
told = machine.pop_context(conv)
assert "a réagi 👍" in told and "Super idée" in told, "l'agent l'apprend avec le prochain message"
assert asyncio.run(api("PUT", url, json={"emoji": None})).status_code == 200
assert "reactions" not in asyncio.run(api("GET", f"/api/conversations/{conv}/messages")).json()[-1]
assert not machine.pop_context(conv), "retirer une réaction ne dit rien"
print("6. réaction de la personne : bornée, à elle seule, connue de l'agent")

# Une question se touche.
next_replies[0] = ["Oui", "Non"]
script[:] = [delta("On publie ?"), DONE]
asyncio.run(chat("question"))
text = last_agent()["text"]
assert text.startswith("On publie ?") and '"type": "choice"' in text and '"Oui"' in text, text
assert main.task_state[conv] == "choice", "la question attend la personne"
asked_replies.clear()
script[:] = [delta('```noah\n{"type": "choice", "question": "x", "options": ["a", "b"]}\n```\nLequel préfères-tu ?'), DONE]
asyncio.run(chat("déjà un choix"))
assert not asked_replies, "l'agent a déjà proposé"
for failing in ([], ["seule"], RuntimeError("panne")):
    next_replies[0] = failing
    script[:] = [delta("Tu veux quoi ?"), DONE]
    sent = asyncio.run(chat("libre"))
    assert sent[-1].get("status") == "completed", ("une proposition ratée ne fait pas échouer le travail", sent[-1])
    assert last_agent()["text"] == "Tu veux quoi ?", "sans proposition valable, le message reste tel quel"
print("7. une question reçoit des réponses à toucher, sans jamais casser le message")
print("OK")
