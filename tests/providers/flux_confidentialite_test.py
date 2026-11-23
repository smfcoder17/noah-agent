"""X33 : la page Confidentialité dit vrai. Pour chaque agent, le fournisseur et le modèle réellement utilisés au dernier tour, mode Auto compris, et le
même que celui qui a reçu l'appel (l'adresse touchée par le faux serveur). Un abonnement de l'ordinateur y figure comme tel.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/providers/flux_confidentialite_test.py"
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

from noah import auth, catalog, complexite, db, decision, hermes, main, modes, relay, watch  # noqa: E402

db.init()
watch.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    for agent_id, name in (("a1", "Noah"), ("a2", "Lea"), ("a3", "Max")):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent_id, name, alice))


async def nothing(*a, **k):
    return {}


async def read_nothing(agent_id, name):
    return ""


hermes._launcher, hermes._read, hermes.browser_identity = nothing, read_nothing, nothing
hermes.browser_secrets = lambda agent_id: ("cle-navigateur", "x")
main.mcp.seal_rights = nothing
decision.schedule_refresh = lambda: None
calls: list[dict] = []


def upstream(request: httpx.Request) -> httpx.Response:
    host, path = request.url.host, request.url.path
    if path.endswith("/models"):
        return httpx.Response(200, json={"data": [{"id": "mistral-small-3.2", "created": 1}, {"id": "qwen3", "created": 1}]})
    body = json.loads(request.content)
    calls.append({"host": host, "model": body["model"]})
    return httpx.Response(200, json={"id": "x", "object": "chat.completion", "created": 1, "model": body["model"],
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0.001}})


real = httpx.AsyncClient
catalog.httpx.AsyncClient = lambda **kw: real(transport=httpx.MockTransport(upstream), **kw)
relay._client = real(transport=httpx.MockTransport(upstream))


async def listed():
    return [{"id": "lab/cerveau", "name": "lab/cerveau", "lab": "lab", "created": 1, "context": 200000, "price_in": 3, "price_out": 15, "tools": True,
             "vision": False, "free": False}]


catalog.openrouter_catalog = listed
db.set_setting("provider", "openrouter")
db.set_setting("model", "lab/cerveau")
db.set_setting("api_key", "sk-or-cle", secret=True)
web = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
agents = {i: TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for(i)}"}) for i in ("a1", "a2", "a3")}
assert web.post("/api/fournisseurs", json={"nom": "vLLM", "base_url": "http://vllm.local:8000/v1", "api_key": "cle-vllm"}).status_code == 200


def turn(agent_id: str):
    calls.clear()
    r = agents[agent_id].post("/relay/v1/chat/completions", json={"model": "peu-importe", "messages": [{"role": "user", "content": "bonjour"}]})
    assert r.status_code == 200, r.text
    return calls[-1]


def flow(agent_id: str) -> dict:
    return next(f for f in web.get("/api/flux").json()["flux"] if f.get("agent") == agent_id)


# --- Avant tout tour : ce qui répondra, dit comme tel ------------------------------------------------------------------------------------------
before = flow("a1")
assert before["dernier_tour"] is False and "openrouter" in before["vers"] and "aucun tour pour l'instant" in before["detail"], before
print("1. sans tour encore, la page dit ce qui répondra")

# --- Un agent sur son propre fournisseur ---------------------------------------------------------------------------------------------------------
assert web.put("/api/agents/a1/model", json={"model": "qwen3", "provider": next(p["id"] for p in web.get("/api/fournisseurs").json() if p["label"] == "vLLM")}).status_code == 200
hit = turn("a1")
f = flow("a1")
assert hit == {"host": "vllm.local", "model": "qwen3"} and f["vers"] == "vllm.local" and f["detail"] == "vLLM · qwen3" and f["dernier_tour"], (hit, f)
assert f["fournisseur"] == relay.last_turn_of("a1")["fournisseur"] and f["modele"] == relay.last_turn_of("a1")["modele"], "la page et la trace du tour"
print("2. un agent sur vLLM : la page dit vLLM, qwen3, l'adresse qui a reçu l'appel")

# --- Mode Auto : le niveau choisi à chaque demande change le fournisseur d'un tour à l'autre ----------------------------------------------------------------
level = {"value": "fast"}


async def tier_for(agent_id, body):
    return level["value"]


complexite.tier_for = tier_for
decision.model = lambda: ""
for tier, model, provider in (("fast", "mistral-small-3.2", "autre:vllm"), ("balanced", "lab/cerveau", "openrouter"), ("smart", "lab/cerveau", "openrouter")):
    r = web.put("/api/modes/cerveau", json={"mode": tier, "modele": model, "fournisseur": provider})
    assert r.status_code == 200, r.text
assert web.put("/api/modes/cerveau", json={"actif": "auto"}).json()["actif"] == "auto"
auto_before = flow("a2")
assert auto_before["mode"] == "auto" and auto_before["dernier_tour"] is False and "aucun tour" in auto_before["detail"], auto_before
for tier, host, label in (("fast", "vllm.local", "vLLM"), ("smart", "openrouter.ai", "OpenRouter")):
    level["value"] = tier
    hit = turn("a2")
    f = flow("a2")
    assert hit["host"] == host and f["vers"] == host and f["detail"].startswith(label + " · ") and f["dernier_tour"] and f["mode"] == "auto", (tier, hit, f)
    assert f["modele"] == hit["model"], "le modèle de la page est celui de l'appel"
    # a3 suit aussi Auto, sans avoir parlé : son propre dernier tour reste inconnu, il n'emprunte pas celui de a2
    assert flow("a3")["dernier_tour"] is False
print("3. mode Auto : la page suit le fournisseur de chaque tour (vLLM au niveau simple, OpenRouter au complexe)")

# --- Un fournisseur en panne : le suivant répond, la page dit celui qui a répondu ------------------------------------------------------------------------
level["value"] = "fast"
real_upstream = upstream


def broken(request):
    if request.url.host == "vllm.local" and not request.url.path.endswith("/models"):
        return httpx.Response(503, json={"error": {"message": "surchargé"}})
    return real_upstream(request)


relay._client = real(transport=httpx.MockTransport(broken))
assert web.put("/api/modes/cerveau", json={"chaine": [{"modele": "mistral-small-3.2", "fournisseur": "autre:vllm"}, {"modele": "lab/cerveau", "fournisseur": "openrouter"}],
                                                   "actif": "custom"}).status_code == 200, "chaîne"
hit = turn("a3")
f = flow("a3")
assert hit["host"] == "openrouter.ai" and f["vers"] == "openrouter.ai" and f["detail"].startswith("OpenRouter"), (hit, f)
print("4. vLLM en panne, OpenRouter répond : la page dit OpenRouter, pas le premier de la chaîne")

# --- Un abonnement de l'ordinateur : dit comme tel ---------------------------------------------------------------------------------------------------
for provider, model, words in (("ordinateur:claude-code", "sonnet", "ton abonnement Claude, sur ton ordinateur · sonnet"),
                               ("ordinateur:chatgpt", "gpt-5", "ton abonnement ChatGPT, sur ton ordinateur · gpt-5"),
                               ("ordinateur:grok", "grok-4", "ton abonnement Grok, sur ton ordinateur · grok-4")):
    relay._note_turn("a1", provider, model, False)
    f = flow("a1")
    assert f["detail"] == words and f["vers"] == "ton ordinateur" and f["local"] is True, f
relay._note_turn("a1", "autre:vllm", "qwen3", True)  # un petit travail du modèle de décision n'est pas le tour de l'agent
assert flow("a1")["fournisseur"] == "ordinateur:grok"
print("5. Claude Code, ChatGPT et Grok sur l'ordinateur : « ton abonnement …, sur ton ordinateur », jamais un hôte distant")

# --- Un redémarrage n'efface pas le dernier tour ------------------------------------------------------------------------------------------------------
relay._note_turn("a1", "openai", "gpt-5", False)
relay.last_turn.clear()
assert flow("a1")["fournisseur"] == "openai" and flow("a1")["modele"] == "gpt-5" and flow("a1")["vers"] == "api.openai.com"
print("6. le dernier tour survit à un redémarrage")
print("confidentialité : tout est vert")
