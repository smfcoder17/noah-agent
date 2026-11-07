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

from fastapi.testclient import TestClient  # noqa: E402

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

# L'écran finit sur ce que la conversation garde.
PREVIEW = '```noah\n{"type": "preview", "path": "a.html"}\n```'
script[:] = [delta(PREVIEW), TOOL, delta("Le rapport est prêt."), TOOL, DONE]
sent = asyncio.run(chat("aperçu puis conclusion"))
row = last_agent()
assert row["text"].endswith("Le rapport est prêt.") and PREVIEW in row["text"] and row["detail"] is None, row
assert sent[-1]["reponse"] == row["text"] and sent[-1]["etapes"] == [], sent[-1]
script[:] = [delta("Le rapport "), ("reasoning.delta", {"text": "détail"}), delta("est prêt."), TOOL, delta("Puis la fin."), DONE]
sent = asyncio.run(chat("texte coupé"))
assert sent[-1]["reponse"] == "Puis la fin." and sent[-1]["etapes"] == ["Le rapport est prêt."], sent[-1]
script[:] = [delta("Voici : /opt/data/workspace/outputs/rapport.pdf"), TOOL, delta("Fini."), DONE]
asyncio.run(chat("fichier livré"))
row = last_agent()
assert "/opt/data/workspace/outputs/rapport.pdf" in row["text"] and row["detail"] is None, "un fichier livré ne se perd pas dans le récit"
script[:] = [delta("Je lis /opt/data/workspace/uploads/a.txt"), TOOL, delta("Fini."), DONE]
asyncio.run(chat("fichier lu"))
assert last_agent()["text"] == "Fini.", "lire un fichier reste du récit"
print("3 bis. l'écran finit sur ce qui est gardé ; un fichier livré reste dans la réponse")

# Deux questions à la suite : un seul choix.
next_replies[0] = ["Oui", "Non"]
asked_replies.clear()
script[:] = [delta('```noah\n{"type": "choice", "question": "x", "options": ["a", "b"]}\n```'), TOOL, delta("On publie ?"), DONE]
asyncio.run(chat("deux choix"))
assert last_agent()["text"].count('"choice"') == 1 and not asked_replies, last_agent()
next_replies[0] = []
print("3 ter. un choix déjà posé en chemin n'en appelle pas un second")

# Coupure avant de savoir si le début retenu était une réaction : le texte reste.
script[:] = [delta("[[pas fini")]
asyncio.run(chat("coupure"))
assert "[[pas fini" in last_agent()["text"], last_agent()
print("3 quater. un début retenu n'est pas perdu si le flux s'arrête")

# La réaction va au message auquel il répond, pas à la question posée pendant le travail.
async def run_with_aside(agent, run_id):
    main._save_message(conv, "user", "Une question pendant le travail")
    yield delta("[[👍]] Bien reçu.")
    yield DONE
plain_events = hermes.run_events
hermes.run_events = run_with_aside
asyncio.run(chat("Message d'origine"))
hermes.run_events = plain_events
with db.connect() as c:
    target = c.execute("SELECT m.text FROM reactions r JOIN messages m ON m.id = r.message_id WHERE r.who = 'agent' AND r.emoji = '👍' ORDER BY r.rowid DESC LIMIT 1").fetchone()
assert target and target["text"] == "Message d'origine", target and dict(target)
print("3 quinquies. la réaction va au message auquel il répond")

# À toi : ce qui attend la personne, et seulement elle.
web = TestClient(main.app, headers={"Authorization": f"Bearer {session}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(eve, 'test', 'web')}"})
main.task_state[conv] = "approve"
main.task_approval[conv] = {"demande": "Ton agent veut publier sur Instagram.", "apercu": ["Mon post"], "request_id": "r", "generation": 1, "run_id": "x"}
items = web.get("/api/a-toi").json()
assert [i["conversation_id"] for i in items] == [conv] and items[0]["demande"].startswith("Ton agent veut publier") and items[0]["apercu"] == ["Mon post"] and items[0]["main"], items
assert items[0]["request_id"] == "r" and items[0]["run_id"] == "x", "À toi répond sans ouvrir le fil"
assert other.get("/api/a-toi").json() == [], "rien des autres"
main.task_state[conv] = "choice"
main.task_approval.pop(conv)
assert web.get("/api/a-toi").json()[0]["demande"] == "Une question attend ta réponse."
main.task_state[conv] = "done"
assert web.get("/api/a-toi").json() == []
with db.connect() as c:
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'usage')", (eve,))
hers = main._new_conversation(eve, "a1", "Mon secret", main=True)
main.task_state[hers] = "approve"
main.task_approval[hers] = {"demande": "Ton agent veut publier sur Instagram.", "apercu": ["Texte privé"]}
assert [i["conversation_id"] for i in other.get("/api/a-toi").json()] == [hers]
assert "Mon secret" not in web.get("/api/a-toi").text and "Texte privé" not in web.get("/api/a-toi").text, "une conversation privée reste à son autrice"
with db.connect() as c:
    c.execute("UPDATE conversations SET shared = 1 WHERE id = ?", (hers,))
assert [i["conversation_id"] for i in web.get("/api/a-toi").json()] == [hers], "rendue lisible : le propriétaire la voit"
with db.connect() as c:
    c.execute("DELETE FROM agent_shares WHERE user_id = ?", (eve,))
assert other.get("/api/a-toi").json() == [], "accès retiré : plus rien"
main.task_state[hers] = "done"
print("3 sexies. À toi : ce qui t'attend, et rien des autres")

# Activité : ce qu'il a fait, et les accords donnés.
log = web.get("/api/agents/a1/activite").json()
assert any(r["kind"] == "tache" and r["titre"] == "Message d'origine" and r["resultat"] == "Bien reçu." and r["etat"] == "fait" for r in log), log[:2]
assert all("noah" not in r["resultat"] for r in log), "pas de widget dans le journal"
main._journal("a1", hers, "tache", "Secret d'Ève", "", "fait")
with db.connect() as c:
    c.execute("UPDATE conversations SET shared = 0 WHERE id = ?", (hers,))
assert "Secret d'Ève" not in web.get("/api/agents/a1/activite").text, "une conversation privée reste à son autrice"
assert other.get("/api/agents/a1/activite").status_code in (403, 404), "sans accès à l'agent, rien"


async def answered(*a, **k):
    return None


hermes.answer_approval = answered
main._runs["run-x"] = {"agent": "a1", "user": alice, "conv": conv, "profil": None}
main.task_state[conv] = "approve"
main.task_approval[conv] = {"demande": "Ton agent veut publier sur Instagram."}
r = web.post("/api/agents/a1/runs/run-x/approval", json={"request_id": "r", "generation": 1, "approve": True})
assert r.status_code == 200, r.text
assert main.task_state[conv] == "work" and web.get("/api/a-toi").json() == [], "le badge tombe dès la réponse"
assert any(e["kind"] == "accord" and e["etat"] == "autorise" and "publier sur Instagram" in e["titre"] for e in web.get("/api/agents/a1/activite").json()), "l'accord laisse une trace"
# Un second accord arrive pendant que Hermes reçoit la réponse au premier : il reste à la personne.


async def second_arrives(*a, **k):
    main.task_state[conv] = "approve"
    main.task_approval[conv] = {"demande": "Ton agent veut envoyer un second message.", "request_id": "r2"}


hermes.answer_approval = second_arrives
main.task_state[conv] = "approve"
main.task_approval[conv] = {"demande": "Ton agent veut publier une première fois.", "request_id": "r1"}
assert web.post("/api/agents/a1/runs/run-x/approval", json={"request_id": "r1", "generation": 1, "approve": False}).status_code == 200
assert [i["request_id"] for i in web.get("/api/a-toi").json()] == ["r2"], "le second accord reste à donner"
newest = web.get("/api/agents/a1/activite").json()[0]
assert newest["etat"] == "refuse" and "première fois" in newest["titre"], newest
main.task_state[conv] = "done"
main.task_approval.pop(conv)
main._runs.pop("run-x")
print("3 septies. Activité : tâches et accords, sans les conversations privées ; le badge tombe dès la réponse")

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
