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
print("plafond quotidien : tout est vert")
