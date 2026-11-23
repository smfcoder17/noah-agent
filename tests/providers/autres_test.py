"""X12 : autant de fournisseurs « autres » qu'on veut, chacun avec son nom, son adresse et sa clé. Trois branchés ensemble listent chacun leurs
modèles, un agent tourne sur l'un d'eux, les clés restent scellées et ne sont jamais renvoyées, l'ancien emplacement « custom » ne perd rien.
Faux serveurs aux formats réels (GET /models d'un service compatible OpenAI, chat/completions), aucun réseau.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/providers/autres_test.py"
"""
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import asyncio  # noqa: E402

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, autres, catalog, db, decision, hermes, main, modes, providers, relay, watch  # noqa: E402

db.init()
watch.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Lea', '', 'k', ?)", (alice,))


async def nothing(*a, **k):
    return {}


async def read_nothing(agent_id, name):
    return ""


hermes._launcher, hermes._read, hermes.browser_identity = nothing, read_nothing, nothing
hermes.browser_secrets = lambda agent_id: ("cle-navigateur", "x")
main.mcp.seal_rights = nothing
decision.schedule_refresh = lambda: None

# Trois services compatibles OpenAI, chacun avec sa clé et ses modèles ; un quatrième ne répond pas.
SERVICES = {
    "lm.local": ("cle-lm", ["qwen3-14b", "llama-3.3-70b"]),
    "vllm.local": ("cle-vllm", ["mistral-small-3.2"]),
    "litellm.local": ("cle-litellm", ["gpt-x", "claude-x", "gemini-x"]),
}
calls: list[dict] = []


def upstream(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if host == "mort.local":
        raise httpx.ConnectError("injoignable")
    if host == "openrouter.ai":
        return httpx.Response(200, json={"id": "x", "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 1, "completion_tokens": 1, "cost": 0.001}})
    key, ids = SERVICES[host]
    assert request.headers.get("authorization") == f"Bearer {key}", f"la clé de {host} ne part que chez lui : {request.headers.get('authorization')}"
    if request.url.path.endswith("/models"):
        return httpx.Response(200, json={"object": "list", "data": [{"id": i, "object": "model", "created": 1} for i in ids]})
    body = json.loads(request.content)
    calls.append({"url": str(request.url), "model": body["model"], "auth": request.headers["authorization"]})
    return httpx.Response(200, json={"id": "x", "object": "chat.completion", "created": 1, "model": body["model"],
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


real_client = httpx.AsyncClient
catalog.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(upstream), **kw)
relay._client = real_client(transport=httpx.MockTransport(upstream))


async def listed():
    return [{"id": "lab/cerveau", "name": "lab/cerveau", "lab": "lab", "created": 1, "context": 200000, "price_in": 3, "price_out": 15, "tools": True,
             "vision": False, "free": False}]


catalog.openrouter_catalog = listed
db.set_setting("provider", "openrouter")
db.set_setting("model", "lab/cerveau")
db.set_setting("api_key", "sk-or-cle-openrouter", secret=True)
web = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
agent1 = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
agent2 = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a2')}"})


def ask(client):
    return client.post("/relay/v1/chat/completions", json={"model": "peu-importe", "messages": [{"role": "user", "content": "bonjour"}]})


# --- 0. L'ancien emplacement unique « custom », branché avant ce lot : rien ne se perd ----------------------------------------------------
db.set_setting("provider_base:custom", "http://lm.local:1234/v1")
db.set_setting("provider_key:custom", "cle-lm", secret=True)
db.set_setting("provider_connected:custom", "1")
rows = {r["id"]: r for r in web.get("/api/fournisseurs").json()}
assert rows["custom"]["connected"] and rows["custom"]["models"] == 2 and rows["custom"]["base_url"] == "http://lm.local:1234/v1"
assert rows["custom"]["label"] == "lm.local:1234" and rows["custom"]["autre"], rows["custom"]
assert providers.key_of("custom") == "cle-lm"
print("0. l'ancien « custom » reste branché, avec son adresse, sa clé et ses modèles, et se compte parmi les autres")

# --- 1. Trois fournisseurs « autres » branchés ensemble -----------------------------------------------------------------------------------
made = {}
for name, host, port in (("LM Studio", "lm.local", 1234), ("vLLM du bureau", "vllm.local", 8000), ("LiteLLM", "litellm.local", 4000)):
    r = web.post("/api/fournisseurs", json={"nom": name, "base_url": f"http://{host}:{port}/v1", "api_key": SERVICES[host][0]})
    assert r.status_code == 200, r.text
    made[name] = r.json()["id"]
    assert r.json()["models"] == len(SERVICES[host][1])
assert list(made.values()) == ["autre:lm-studio", "autre:vllm-du-bureau", "autre:litellm"], made
rows = {r["id"]: r for r in web.get("/api/fournisseurs").json()}
for pid, (label, count) in {"autre:lm-studio": ("LM Studio", 2), "autre:vllm-du-bureau": ("vLLM du bureau", 1), "autre:litellm": ("LiteLLM", 3)}.items():
    assert rows[pid]["connected"] and rows[pid]["label"] == label and rows[pid]["models"] == count and rows[pid]["own_url"], rows[pid]
text = web.get("/api/fournisseurs").text
assert not any(k in text for k, _ in SERVICES.values()), "une clé n'est jamais renvoyée"
with db.connect() as c:
    raw = c.execute("SELECT value FROM settings WHERE key = 'provider_key:autre:vllm-du-bureau'").fetchone()["value"]
assert raw != "cle-vllm" and "cle-vllm" not in raw, "la clé est scellée dans la base"
assert providers.key_of("autre:vllm-du-bureau") == "cle-vllm"
available = asyncio.run(modes.available(modes.BRAIN))
by_provider: dict[str, list[str]] = {}
for model in available:
    by_provider.setdefault(model["fournisseur"], []).append(model["id"])
assert sorted(by_provider["autre:lm-studio"]) == ["llama-3.3-70b", "qwen3-14b"] and by_provider["autre:vllm-du-bureau"] == ["mistral-small-3.2"]
assert sorted(by_provider["autre:litellm"]) == ["claude-x", "gemini-x", "gpt-x"] and by_provider["custom"], by_provider.keys()
assert "openrouter" in by_provider
print("1. trois « autres » branchés ensemble listent chacun leurs modèles ; clés scellées, jamais renvoyées")

# Une adresse qui ne répond pas : refus net, aucune fiche gardée.
r = web.post("/api/fournisseurs", json={"nom": "Mort", "base_url": "http://mort.local/v1"})
assert r.status_code == 400 and not any(e["label"] == "Mort" for e in autres.entries()), r.text
assert web.post("/api/fournisseurs", json={"nom": "Sans adresse", "base_url": ""}).status_code == 400
assert web.post("/api/fournisseurs", json={"nom": "Piège", "base_url": "http://moi:secret@lm.local/v1"}).status_code == 400
print("2. une adresse morte ou piégée est refusée, sans fiche orpheline")

# --- 3. Un agent tourne sur l'un d'eux ----------------------------------------------------------------------------------------------------
r = web.put("/api/agents/a1/model", json={"model": "mistral-small-3.2", "provider": "autre:vllm-du-bureau"})
assert r.status_code == 200 and r.json()["cerveau"]["fournisseur"] == "autre:vllm-du-bureau", r.text
assert web.put("/api/agents/a2/model", json={"model": "x", "provider": "autre:inconnu"}).status_code == 400
calls.clear()
assert ask(agent1).status_code == 200
assert calls and calls[-1] == {"url": "http://vllm.local:8000/v1/chat/completions", "model": "mistral-small-3.2", "auth": "Bearer cle-vllm"}, calls
assert modes.shown_brain("a1")["fournisseur_nom"] == "vLLM du bureau"
calls.clear()
assert ask(agent2).status_code == 200 and not calls, "l'autre agent suit le cerveau de tous (OpenRouter), pas le service de son voisin"
print("3. l'agent a1 tourne sur vLLM avec sa clé, a2 reste sur le cerveau de tous")

# Changer le cerveau de tous ne déplace pas l'agent : il a son modèle.
r = web.post("/api/model", json={"provider": "autre:litellm", "model": "gpt-x"})
assert r.status_code == 200, r.text
assert "agents_propres" not in r.json(), "plus de bandeau « garde son propre modèle » : ni dans la réponse"
calls.clear()
assert ask(agent1).status_code == 200 and calls[-1]["model"] == "mistral-small-3.2" and "vllm.local" in calls[-1]["url"]
assert ask(agent2).status_code == 200 and calls[-1]["model"] == "gpt-x" and "litellm.local" in calls[-1]["url"]
print("4. le cerveau de tous change : a1 garde le sien (vLLM), a2 suit (LiteLLM)")

# --- 5. Débrancher -------------------------------------------------------------------------------------------------------------------------
assert web.delete("/api/fournisseurs/autre:litellm").status_code == 409, "un fournisseur qui sert de cerveau ne se débranche pas"
assert web.delete("/api/fournisseurs/openai").status_code == 404
assert web.delete("/api/fournisseurs/autre:vllm-du-bureau").status_code == 200
assert "autre:vllm-du-bureau" not in {r["id"] for r in web.get("/api/fournisseurs").json()}
assert db.get_setting("model_a1") is None and db.get_setting("model_provider_a1") is None, "l'agent revient au cerveau de tous"
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM settings WHERE key LIKE 'provider%vllm-du-bureau'").fetchone(), "sa clé et son adresse sont effacées"
print("5. débrancher efface la fiche, la clé et le choix des agents qui l'utilisaient")
print("autres fournisseurs : tout est vert")
