"""Une clé refusée s'arrête à l'enregistrement, pas au premier message. La voix dit la vraie raison quand elle ne peut pas marcher.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/providers/cle_refusee_test.py"
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

from apollo import auth, catalog, db, main, media, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
db.set_setting("owner_id", str(alice))
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(bruno, 'Firefox', 'web')}"})
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))


async def nothing(*a, **k):
    return None


main._configure = nothing
main._start_agent = nothing

GOOD = "cle-valide"
transcription = {"mode": "ok"}


def upstream(request: httpx.Request) -> httpx.Response:
    sent = request.headers.get("authorization", "").removeprefix("Bearer ")
    path = request.url.path
    if path.endswith("/key"):
        if sent == GOOD:
            return httpx.Response(200, json={"data": {"label": "x"}})
        return httpx.Response(401, json={"error": {"message": "API key expired.", "code": 401}})
    if path.endswith("/v1/models") and request.url.host == "api.anthropic.com":
        if request.headers.get("x-api-key") == GOOD:
            return httpx.Response(200, json={"data": [{"id": "claude-x"}]})
        return httpx.Response(401, json={"error": {"message": "invalid x-api-key"}})
    if path.endswith("/audio/transcriptions"):
        if transcription["mode"] == "down":
            raise httpx.ConnectError("pas de route")
        if transcription["mode"] == "503":
            return httpx.Response(503, json={"error": {"message": "surchargé"}})
        if sent != GOOD:
            return httpx.Response(401, json={"error": {"message": "API key expired.", "code": 401}})
        return httpx.Response(200, json={"text": "bonjour"})
    return httpx.Response(200, json={"data": []})


real_client = httpx.AsyncClient
catalog.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(upstream), **kw)
relay._client = real_client(transport=httpx.MockTransport(upstream))


async def fixed(kind):
    return ["modele-a", "modele-b"]


media.backups = fixed


def model(**body):
    return web.post("/api/model", json=body)


def transcribe():
    return web.post("/api/voice/transcribe", params={"format": "webm", "agent_id": "a1"}, content=b"AUDIO")


# 1. Une clé OpenRouter expirée : le catalogue est public, seul un appel avec la clé la démasque.
r = web.post("/api/models", json={"provider": "openrouter", "api_key": "expiree"})
assert r.status_code == 400 and "invalide ou expirée" in r.json()["detail"], r.text
r = model(provider="openrouter", api_key="expiree", model="m")
assert r.status_code == 400 and "invalide ou expirée" in r.json()["detail"], r.text
assert not db.get_setting("provider") and not db.get_setting("api_key"), "une clé refusée ne doit rien changer"
print("1. une clé OpenRouter expirée est refusée, rien n'est enregistré")

# 2. Une clé refusée n'écrase pas le cerveau qui marche.
assert model(provider="anthropic", api_key=GOOD, model="claude-x").status_code == 200
r = model(provider="anthropic", api_key="expiree", model="claude-x")
assert r.status_code == 400 and db.get_setting("api_key", secret=True) == GOOD
r = model(provider="openrouter", api_key="expiree", model="m")
assert r.status_code == 400 and db.get_setting("provider") == "anthropic" and db.get_setting("api_key", secret=True) == GOOD
assert model(provider="anthropic", model="claude-x").status_code == 200, "changer de modèle sans retaper la clé"
print("2. le cerveau en service reste en place")

# 3. Cerveau Anthropic sans clé de médias : la voix le dit avant d'ouvrir le micro, et la route donne la vraie raison.
ready = web.get("/api/voice/ready").json()
assert "OpenRouter" in ready["dictation"] and "OpenRouter" in ready["call"], ready
assert other.get("/api/voice/ready").status_code == 200, "chaque profil doit savoir si la voix marche"
r = transcribe()
assert r.status_code == 400 and "OpenRouter" in r.json()["detail"], r.text
assert web.get("/api/media").json()["available"] is False
print("3. sans clé OpenRouter, la voix dit pourquoi elle ne peut pas marcher")

# 4. Une clé pour la voix et la création, à côté du cerveau.
assert other.post("/api/media/key", json={"api_key": GOOD}).status_code == 403
r = web.post("/api/media/key", json={"api_key": "expiree"})
assert r.status_code == 400 and "invalide ou expirée" in r.json()["detail"] and not db.get_setting("media_api_key")
assert web.post("/api/media/key", json={"api_key": GOOD}).status_code == 200
assert db.get_setting("provider") == "anthropic", "cette clé ne change pas le cerveau"
assert GOOD not in web.get("/api/media").text, "la clé ne revient jamais à l'interface"
assert web.get("/api/voice/ready").json() == {"dictation": None, "call": None}
assert transcribe().json() == {"text": "bonjour"}
print("4. la clé de la voix s'ajoute sans toucher au cerveau, et la dictée marche")

# 5. La clé expire plus tard : le message le dit, sans parler d'une panne.
db.set_setting("media_api_key", "expiree", secret=True)
r = transcribe()
assert r.status_code == 400 and "invalide ou expirée" in r.json()["detail"] and "Voix" in r.json()["detail"], r.text
print("5. une clé expirée après coup est nommée")

# 6. Une vraie panne n'est pas un refus : le navigateur garde le son et réessaie.
db.set_setting("media_api_key", GOOD, secret=True)
for mode in ("down", "503"):
    transcription["mode"] = mode
    r = transcribe()
    assert r.status_code == 503, f"{mode} : {r.status_code} {r.text}"
transcription["mode"] = "ok"
print("6. fournisseur injoignable ou surchargé : 503, pas un refus")

# 7. Retirer la clé.
assert web.post("/api/media/key", json={"api_key": ""}).status_code == 200
assert not db.get_setting("media_api_key") and web.get("/api/voice/ready").json()["call"]
print("7. la clé de la voix se retire")
print("OK")
