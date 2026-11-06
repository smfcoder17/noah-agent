"""Fournisseurs : Ollama local ou distant, Ollama Cloud et tout service compatible OpenAI. La clé ne suit jamais un autre fournisseur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/providers/provider_test.py"

Avec NOAH_OLLAMA_URL, le dernier essai parle à un vrai Ollama.
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
from fastapi import HTTPException  # noqa: E402

from noah import catalog, db, main, relay  # noqa: E402

db.init()
seen: list[httpx.Request] = []


def upstream(request: httpx.Request) -> httpx.Response:
    seen.append(request)
    if request.url.host == "api.mammouth.ai":
        if request.url.path == "/public/models":
            assert "authorization" not in request.headers, "la liste publique ne reçoit pas la clé"
            return httpx.Response(200, json={"object": "list", "data": [
                {"id": "claude-haiku-5-5", "owned_by": "openai", "created": 5, "model_info": {"max_input_tokens": 200000, "input_cost_per_token": 1e-7, "output_cost_per_token": 5e-7}},
                {"id": "kimi-k3", "owned_by": "openai", "created": 5, "model_info": {}},
                {"id": "modele-inconnu", "owned_by": "openai", "created": 5},
                {"id": "gpt-image-2", "owned_by": "openai"}, {"id": "text-embedding-3-large", "owned_by": "openai"}, {"id": "sonar-pro", "owned_by": "openai"},
            ]})
        if request.url.path == "/key/info":
            ok = request.headers.get("authorization") == "Bearer bonne-cle"
            return httpx.Response(200 if ok else 401, json={})
    if request.url.path.endswith("/models"):
        return httpx.Response(200, json={"data": [{"id": "mon-modele"}]})
    if request.url.path == "/api/tags":
        return httpx.Response(200, json={"models": [{"name": "kimi-k3:cloud", "capabilities": ["tools"]}, {"name": "petit", "capabilities": []}]})
    return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 1}})


real_client = httpx.AsyncClient
catalog.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(upstream), **kw)

clean = main._clean_base_url
assert clean(" http://x:11434/v1/ ") == "http://x:11434/v1" and clean("") is None
for bad in ("ftp://x/v1", "http://moi:secret@x/v1", "http://x/v1?cle=1", "x:11434"):
    try:
        clean(bad)
    except HTTPException:
        continue
    raise AssertionError(f"adresse acceptée : {bad}")
print("1. adresses : http(s) seulement, sans identifiants ni paramètres")

assert relay.upstream_base("ollama") == "http://host.docker.internal:11434/v1"
assert relay.upstream_base("ollama", "http://gpu:11434/v1/") == "http://gpu:11434/v1"
assert relay.upstream_base("ollama", "http://gpu:11434") == "http://gpu:11434/v1", "l'adresse saisie telle quelle ne doit pas donner 404"
assert relay.upstream_base("custom") == "", "un service sans adresse n'a pas d'adresse par défaut"
assert relay.upstream_base("ollama-cloud", "http://piege/v1") == "https://ollama.com/v1", "Ollama Cloud n'accepte pas d'adresse"
assert relay.upstream_base("openrouter", "http://piege/v1") == relay.UPSTREAMS["openrouter"]
print("2. seuls Ollama et le service libre acceptent une adresse")

models = asyncio.run(catalog.models_for("custom", "k", "http://svc/v1"))
assert [m["id"] for m in models] == ["mon-modele"] and seen[-1].url == "http://svc/v1/models"
assert seen[-1].headers["authorization"] == "Bearer k"
assert asyncio.run(catalog.models_for("custom", None, None)) == []
models = asyncio.run(catalog.models_for("ollama", None, "http://gpu:11434/v1"))
assert seen[-1].url == "http://gpu:11434/api/tags" and "authorization" not in seen[-1].headers and models
models = asyncio.run(catalog.models_for("ollama-cloud", "k"))
assert seen[-1].url == "https://ollama.com/api/tags" and all(m["cloud"] for m in models)
assert catalog.groups("custom", models) == []
print("3. listes de modèles : service libre, Ollama à distance, Ollama Cloud")


async def save(**body) -> None:
    async def nothing(*a, **k):
        return None
    main._configure = nothing
    main._start_agent = nothing
    tasks = main.BackgroundTasks()
    await main.set_model(main.ModelChoice(**body), tasks, user=1)
    await tasks()


with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'A', '', 'k')")
asyncio.run(save(provider="openrouter", api_key="cle-openrouter", model="m"))
assert db.get_setting("api_key", secret=True) == "cle-openrouter"
asyncio.run(save(provider="openrouter", model="m2"))
assert db.get_setting("api_key", secret=True) == "cle-openrouter", "changer de modèle garde la clé"
asyncio.run(save(provider="custom", base_url="http://piege/v1", model="m"))
assert not db.get_setting("api_key"), "la clé OpenRouter ne doit pas partir vers un autre service"
asyncio.run(save(provider="custom", base_url="http://svc/v1", api_key="cle-svc", model="m"))
asyncio.run(save(provider="custom", base_url="http://autre/v1", model="m"))
assert not db.get_setting("api_key"), "la clé d'un service ne suit pas vers une autre adresse"
asyncio.run(save(provider="ollama", model="kimi-k3:cloud"))
assert not db.get_setting("api_key") and not db.get_setting("base_url")
for bad, why in (({"provider": "custom", "model": "m"}, "adresse"), ({"provider": "ollama-cloud", "model": "m"}, "clé")):
    try:
        asyncio.run(save(**bad))
    except HTTPException:
        continue
    raise AssertionError(f"accepté sans {why}")
print("4. la clé enregistrée ne suit ni un autre fournisseur ni une autre adresse")


# Mammouth : adresse fixe, liste publique avec ses prix, clé vérifiée avant d'être gardée.
assert relay.upstream_base("mammouth", "http://piege/v1") == "https://api.mammouth.ai/v1", "Mammouth n'accepte pas d'autre adresse"
listed = asyncio.run(catalog.models_for("mammouth", None))
assert [m["id"] for m in listed] == ["claude-haiku-5-5", "kimi-k3", "modele-inconnu"], "ni images, ni embeddings, ni recherche web comme cerveau"
haiku = listed[0]
assert (haiku["lab"], haiku["context"]) == ("anthropic", 200000), "le labo se lit dans le nom, pas dans owned_by"
assert abs(haiku["price_in"] - 0.1) < 1e-9 and abs(haiku["price_out"] - 0.5) < 1e-9, "prix en dollars par million de jetons"
assert listed[1]["lab"] == "moonshotai" and listed[1]["price_in"] is None, "sans prix : inconnu, pas zéro"
assert listed[2]["lab"] == "mammouth"
prices = asyncio.run(catalog.mammouth_prices())
assert catalog.price_of(prices, "claude-haiku-5-5")["price_out"] > 0 and not catalog.price_of(prices, "kimi-k3")
try:
    asyncio.run(save(provider="mammouth", model="claude-haiku-5-5", api_key="mauvaise"))
except HTTPException as e:
    assert e.status_code == 400
else:
    raise AssertionError("clé Mammouth refusée mais enregistrée")
try:
    asyncio.run(save(provider="mammouth", model="claude-haiku-5-5"))
except HTTPException as e:
    assert "clé" in e.detail
else:
    raise AssertionError("Mammouth accepté sans clé")
asyncio.run(save(provider="mammouth", model="claude-haiku-5-5", api_key="bonne-cle"))
assert db.get_setting("provider") == "mammouth" and db.get_setting("api_key", secret=True) == "bonne-cle"
print("5. Mammouth : adresse fixe, modèles et prix publics, clé vérifiée")


if os.environ.get("NOAH_OLLAMA_URL"):
    catalog.httpx.AsyncClient = real_client
    found = asyncio.run(catalog.models_for("ollama", None, os.environ["NOAH_OLLAMA_URL"]))
    assert found
    print(f"6. vrai Ollama : {len(found)} modèles avec outils")
print("fournisseurs : tout est vert")
