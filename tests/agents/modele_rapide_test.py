"""Le modèle rapide : mesuré sur la clé du cerveau, le plus rapide qui répond juste est gardé, avec sa mesure, et sert à la voix rapide
et aux réponses à toucher. Demande réelle : « avec Grok Bot ou Muse, je peux continuer à chatter pendant qu'il travaille ».

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/modele_rapide_test.py"
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

from noah import catalog, db, media, rapide, relay  # noqa: E402

db.init()
db.set_setting("provider", "mistral")
db.set_setting("model", "mistral-large-latest")
db.set_setting("api_key", "cle-mistral", secret=True)

LISTED = [{"id": "mistral-large-latest", "price_in": 2.0, "price_out": 6.0},
          {"id": "lent-mini", "price_in": 0.1, "price_out": 0.3},
          {"id": "vif-small", "price_in": 0.2, "price_out": 0.6},
          {"id": "mistral-embed", "price_in": 0.01}]


async def models_for(provider, key, base=None):
    return LISTED


catalog.models_for = models_for
asked: list[str] = []


async def upstream(request: httpx.Request) -> httpx.Response:
    name = json.loads(request.content)["model"]
    asked.append(name)
    if name == "lent-mini":
        await asyncio.sleep(0.6)
    chunks = [{"choices": [{"delta": {"content": "Prêt"}}]}]
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))


async def main():
    state = await rapide.measure()
    # Seuls les modèles légers connus sont essayés : ni le cerveau, ni un modèle d'embeddings.
    assert sorted(asked) == ["lent-mini", "vif-small"], asked
    assert state["modele"] == "vif-small", state
    assert state["ms"] is not None and state["ms"] < 600, state
    # Persistance : relu depuis la base, et servi à la voix rapide et aux réponses à toucher.
    assert rapide.model() == "vif-small"
    assert json.loads(db.get_setting(rapide.KEY))["modele"] == "vif-small"
    _, _, models = await media._voice_target()
    assert models[0] == "vif-small", models
    # Une autre clé : la mesure ne vaut plus, chacun reprend son secours.
    db.set_setting("api_key", "autre-cle", secret=True)
    assert rapide.model() == ""
    print("ok : modèle rapide mesuré, choisi, gardé et servi")


asyncio.run(main())
