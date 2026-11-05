"""Plafond de dépense quotidien par agent (G8.1) : prévenu sur le téléphone avant le dépassement, arrêté au plafond.
Test avec un plafond de 0,10 $, comme le demande la grille de validation.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/budget/budget_test.py"
"""
import os
import sys
import tempfile

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from apollo import auth, db, main, push, relay  # noqa: E402

db.init()
user = auth.create_user("alice", "motdepasse-a")
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'Firefox', 'web')}"})
with db.connect() as c:
    for agent_id, name in (("a1", "Veilleur"), ("a2", "Rédacteur")):
        c.execute("INSERT INTO agents (id, name, role, api_key) VALUES (?, ?, '', 'k')", (agent_id, name))
db.set_setting("provider", "openrouter")

calls = []


def upstream(request: httpx.Request) -> httpx.Response:
    calls.append(request)
    return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}],
                                     "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.045}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
alerts = []
push.notify = lambda title, text, url="/", urgent=False, user_id=None: alerts.append((title, urgent))
agent = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a2')}"})


def ask(client: TestClient) -> int:
    return client.post("/relay/v1/chat/completions", json={"model": "m", "messages": []}).status_code


# 1. Plafond de 0,10 $ par agent et par jour, posé depuis l'interface.
assert web.post("/api/budget", json={"monthly": None, "daily": 0.10}).status_code == 200
assert ask(agent) == 200 and not alerts                       # 0,045 $ : rien à signaler
assert ask(agent) == 200 and alerts == [("Veilleur approche de son plafond", False)], alerts  # 0,09 $ : 80 % passés
assert ask(agent) == 200                                      # 0,135 $ : plafond franchi par cet appel
assert alerts[-1] == ("Veilleur s'est arrêté", True), alerts  # prévenu tout de suite, en urgent
before = len(calls)
r = agent.post("/relay/v1/chat/completions", json={"model": "m", "messages": []})
assert r.status_code == 402 and "Plafond du jour" in r.json()["error"]["message"], r.text
assert len(calls) == before, "appel parti chez le fournisseur au-delà du plafond"
assert len(alerts) == 2, f"alerte répétée : {alerts}"         # une seule alerte par niveau et par jour
print("1. plafond de 0,10 $ : alerte à 80 %, arrêt au plafond, plus aucun appel payant, une alerte par niveau")

# 2. Le plafond est par agent : l'autre agent continue.
assert ask(other) == 200
print("2. un agent au plafond n'arrête pas les autres")

# 3. Plafond propre à un agent, prioritaire ; le retirer rend celui de tous les agents.
assert web.put("/api/agents/a1/plafond", json={"daily": 1.0}).status_code == 200
assert ask(agent) == 200, "plafond propre à l'agent ignoré"
assert web.put("/api/agents/a1/plafond", json={"daily": None}).status_code == 200
assert ask(agent) == 402
assert web.put("/api/agents/inconnu/plafond", json={"daily": 1.0}).status_code == 404
print("3. plafond propre à un agent prioritaire ; retiré, celui de tous les agents revient")

# 4. L'interface voit la dépense du jour et le plafond de chaque agent ; le budget mensuel n'efface pas le quotidien.
u = web.get("/api/usage").json()
assert u["daily"] == 0.10 and u["today"]["a1"]["plafond"] == 0.10 and u["today"]["a1"]["depense"] >= 0.10, u
assert web.post("/api/budget", json={"monthly": 50}).status_code == 200
assert web.get("/api/usage").json()["daily"] == 0.10, "réglage du budget mensuel qui efface le plafond quotidien"
print("4. dépense du jour et plafond visibles par agent ; régler le mensuel garde le quotidien")
# 5. G8.2 : chaque appel compte pour la tâche (conversation) dont le run est en cours ; plusieurs runs à la fois ou
# aucun = travail de fond. Vu par jour et par tâche dans /api/usage.
with db.connect() as c:
    for conv, title in (("c1", "Veille concurrents"), ("c2", "Article")):
        c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, 'a2', ?)", (conv, user, title))
assert web.put("/api/agents/a2/plafond", json={"daily": 10}).status_code == 200
relay.active["a2"] = ["c1"]
assert ask(other) == 200 and ask(other) == 200
relay.active["a2"] = ["c1", "c2"]                              # deux tâches en même temps : on ne devine pas
assert ask(other) == 200
relay.active["a2"] = []
assert ask(other) == 200                                       # routine planifiée, surveillance
u = web.get("/api/usage").json()
tasks = {t["conversation_id"]: t for t in u["tasks"] if t["agent_id"] == "a2"}
assert tasks["c1"]["calls"] == 2 and tasks["c1"]["title"] == "Veille concurrents" and abs(tasks["c1"]["cost"] - 0.09) < 1e-9, tasks
assert "c2" not in tasks and tasks[None]["calls"] == 3 and tasks[None]["title"] == "Travail de fond", tasks
days = [d for d in u["days"] if d["agent_id"] == "a2"]
assert len(days) == 1 and days[0]["calls"] == 5 and days[0]["tokens"] == 75, days
print("5. dépense par tâche (une tâche en cours : elle ; plusieurs ou aucune : travail de fond) et par jour")

# 6. Codex (3e passage) : la tâche est celle du départ de l'appel, même si une autre lui succède avant la réponse.
switch = upstream


def upstream(request: httpx.Request) -> httpx.Response:  # noqa: F811
    relay.active["a2"] = ["c2"]  # c1 finit et c2 commence pendant que le fournisseur répond
    return switch(request)


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
relay.active["a2"] = ["c1"]
assert ask(other) == 200
tasks = {t["conversation_id"]: t for t in web.get("/api/usage").json()["tasks"] if t["agent_id"] == "a2"}
assert tasks["c1"]["calls"] == 3 and "c2" not in tasks, tasks
print("6. appel compté pour la tâche en cours à son départ, pas à sa réponse")

# 7. Jours au fuseau de l'utilisateur, avec le décalage de chaque date (heure d'été).
from zoneinfo import ZoneInfo  # noqa: E402

from apollo import updates  # noqa: E402

updates.local_zone = lambda: ZoneInfo("America/Toronto")
assert relay.local_day("2026-11-01 04:30:00") == "2026-11-01"   # 00:30, encore à UTC−4
assert relay.local_day("2026-11-02 04:30:00") == "2026-11-01"   # 23:30, passé à UTC−5
assert relay.month_start().endswith(("04:00:00", "05:00:00"))  # minuit à Toronto, le 1er du mois
print("7. jour de chaque dépense avec le décalage de sa date (changement d'heure du 1er novembre)")

# 8. Le plafond vaut pour tout ce qu'un agent dépense, pas seulement le relais : image, voix, transcription, tri d'une veille.
import asyncio  # noqa: E402

from apollo import media, precall, watch  # noqa: E402

db.set_setting("media_api_key", "cle-openrouter", secret=True)
assert relay.day_refusal("a1"), "a1 est au plafond depuis l'étape 3"
media_calls = []


def media_upstream(request: httpx.Request) -> httpx.Response:
    media_calls.append(str(request.url))
    return httpx.Response(200, json={"data": [{"b64_json": "AA=="}], "usage": {"cost": 0.04}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(media_upstream))
real_client = httpx.AsyncClient
media.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(media_upstream), **kw)


async def refused(job) -> str:
    try:
        await job
    except media.MediaError as e:
        return str(e)
    raise AssertionError("dépense acceptée au-delà du plafond")


async def stopped_at_cap() -> None:
    for job in (media.image("a1", "un chat", model="m"), media.speak("a1", "Bonjour."), media.transcribe("a1", b"AUDIO", "webm"), media.music("a1", "un air", model="m"),
                media.video("a1", "un film", model="m"), watch.triage("a1", {"criteria": "", "name": "n", "url": "u"}, [{"titre": "t", "texte": "x"}])):
        assert "Plafond du jour" in await refused(job)
    await precall._prepare("a1", user, "une raison")
    assert not media_calls, f"appels payants au-delà du plafond : {media_calls}"
asyncio.run(stopped_at_cap())
print("8. au plafond : image, voix, transcription, musique, vidéo, tri de veille et préparation d'appel refusés, aucun appel payant")

# 9. Une dépense hors du relais compte et prévient, comme un appel au modèle.
alerts.clear()
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a3', 'Graphiste', '', 'k')")
assert web.put("/api/agents/a3/plafond", json={"daily": 0.09}).status_code == 200  # 0,04 $ l'image : 0,08 $ passe les 80 %


async def images() -> None:
    await media.image("a3", "un chat", model="m")
    assert not alerts, alerts
    await media.image("a3", "un chat", model="m")
    assert alerts == [("Graphiste approche de son plafond", False)], alerts
    await media.image("a3", "un chat", model="m")
    assert alerts[-1] == ("Graphiste s'est arrêté", True), alerts
    assert "Plafond du jour" in await refused(media.image("a3", "un chat", model="m"))
asyncio.run(images())
media._record("routeur", "m", 5.0)
media._record("", "m", 5.0)
assert len(alerts) == 2, f"alerte pour un agent qui n'en est pas un : {alerts}"
print("9. images facturées : alerte à 80 %, arrêt au plafond, comme le relais ; le routeur n'est pas un agent")

# 10. Plusieurs appels partis en même temps : le plafond ne se vérifie qu'au départ, chacun compte à son retour.
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a4', 'Pressé', '', 'k')")
assert web.put("/api/agents/a4/plafond", json={"daily": 0.10}).status_code == 200
relay._client = real_client(transport=httpx.MockTransport(upstream))
quick = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a4')}"})
assert ask(quick) == 200 and ask(quick) == 200 and ask(quick) == 200 and ask(quick) == 402
spent = relay.day_cost("a4")
assert 0.10 <= spent < 0.10 + 0.045 + 1e-9, spent
print(f"10. dépassement borné : {spent:.3f} $ pour un plafond de 0,10 $ et des appels à 0,045 $ (un appel au plus, son coût n'est connu qu'à son retour)")

# 11. Plafond relevé dans la journée : l'agent reprend, et il prévient de nouveau avant le nouveau plafond (alors que l'alerte du
# précédent est déjà partie aujourd'hui).
alerts.clear()
assert web.put("/api/agents/a4/plafond", json={"daily": spent + 0.05}).status_code == 200
assert ask(quick) == 200 and alerts == [("Pressé approche de son plafond", False)], alerts
assert ask(quick) == 200 and alerts[-1] == ("Pressé s'est arrêté", True), alerts
assert ask(quick) == 402
assert len(alerts) == 2, alerts
print("11. plafond relevé : l'agent reprend, et le nouveau plafond prévient de nouveau")
print("plafond quotidien : tout est vert")
