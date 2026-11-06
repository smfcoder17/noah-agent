"""Changer de modèle est instantané : l'agent n'est ni arrêté ni redémarré, et son prochain appel part vers le nouveau modèle, même au
milieu d'une tâche. Plainte réelle : « ça plante, ça ne redémarre pas, ça devrait être instantané ».

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/modele_instantane_test.py"
"""
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

from noah import auth, db, decision, hermes, main, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Lea', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "ancien/modele")
db.set_setting("api_key", "cle-openrouter", secret=True)

launcher: list[tuple[str, str]] = []
slow = {"s": 0.0}


async def fake_launcher(method, path, **kw):
    launcher.append((method, path))
    if slow["s"]:
        time.sleep(slow["s"])
    return {}


async def fake_read(agent_id, name):
    return ""


async def nothing(*a, **k):
    return {}


hermes._launcher = fake_launcher
hermes._read = fake_read
hermes.browser_identity = nothing
hermes.browser_secrets = lambda agent_id: ("cle-navigateur", "x")
main.mcp.seal_rights = nothing
decision.schedule_refresh = lambda: None

sent: list[dict] = []


def upstream(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    sent.append({"url": str(request.url), "model": body.get("model"), "auth": request.headers.get("authorization", ""), "body": body})
    return httpx.Response(200, json={"id": "x", "object": "chat.completion", "created": 1, "model": body.get("model"),
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
web = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
agent = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
other = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a2')}"})


def ask(client, model="ancien/modele", **extra):
    r = client.post("/relay/v1/chat/completions", json={"model": model, "messages": [{"role": "user", "content": "bonjour"}], **extra})
    assert r.status_code == 200, r.text
    return sent[-1]


assert ask(agent)["model"] == "ancien/modele"
print("1. avant : le cerveau choisi")

slow["s"] = 3
t0 = time.monotonic()
r = web.post("/api/model", json={"provider": "openrouter", "model": "nouveau/modele"})
took = time.monotonic() - t0
slow["s"] = 0
assert r.status_code == 200, r.text
assert ask(agent)["model"] == "nouveau/modele", sent[-1]
print(f"2. le prochain appel part vers le nouveau modèle, alors que l'agent demande encore l'ancien ; réponse de l'écran en {took:.2f} s")

deadline = time.monotonic() + 10
while time.monotonic() < deadline and sum(1 for m, p in launcher if p.endswith("/files")) < 2:
    time.sleep(0.05)
assert not [p for m, p in launcher if "restart" in p or p.endswith("/stop") or p.endswith("/start")], launcher
assert sum(1 for m, p in launcher if p.endswith("/files")) >= 2, launcher
print("3. personne n'est redémarré, et les fichiers de chaque agent suivent pour son prochain démarrage")

launcher.clear()
r = web.put("/api/agents/a2/model", json={"model": "propre/a-lea"})
assert r.status_code == 200, r.text
assert ask(other, "nouveau/modele")["model"] == "propre/a-lea" and ask(agent, "nouveau/modele")["model"] == "nouveau/modele"
r = web.put("/api/agents/a2/model", json={"model": None})
assert ask(other, "propre/a-lea")["model"] == "nouveau/modele"
assert not [p for m, p in launcher if "restart" in p], launcher
print("4. le cerveau propre à un agent : pareil, sans toucher aux autres, et retour au cerveau de tous")

helper = decision.model
decision.model = lambda: "petit/modele"
assert ask(agent, "petit/modele")["model"] == "petit/modele"
assert ask(agent, "ancien/modele")["model"] == "nouveau/modele"
decision.model = helper
print("5. le modèle de décision garde son chemin")

r = web.post("/api/model", json={"provider": "custom", "model": "local-1", "base_url": "http://mon-serveur:8000/v1", "api_key": "cle-locale"})
assert r.status_code == 200, r.text
seen = ask(agent, "nouveau/modele")
assert seen["url"].startswith("http://mon-serveur:8000/v1/") and seen["model"] == "local-1" and "cle-locale" in seen["auth"], seen
print("6. un autre fournisseur : la bonne adresse et la bonne clé dès le prochain appel")

marked = [{"role": "system", "content": [{"type": "text", "text": "consignes", "cache_control": {"type": "ephemeral"}}]}, {"role": "user", "content": "x", "cache_control": {"type": "ephemeral"}}]
db.set_setting("model", "gpt-sans-marqueur")
assert "cache_control" not in json.dumps(ask(agent, "ancien", messages=marked)["body"]), sent[-1]["body"]
marked = [{"role": "system", "content": [{"type": "text", "text": "consignes", "cache_control": {"type": "ephemeral"}}]}]
db.set_setting("model", "claude-opus-x")
assert "cache_control" in json.dumps(ask(agent, "ancien", messages=marked)["body"])
print("7. les marqueurs de cache ne partent que vers les modèles qui les lisent")
print("Tout est tenu.")
