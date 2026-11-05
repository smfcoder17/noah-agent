"""Ce que la personne voit quand ça casse : une phrase qu'elle comprend, les détails à côté, jamais un silence ni un secret.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/coordination/erreurs_test.py"
"""
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

from noah import auth, db, diagnostics, events, hermes, main, media, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
web = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(bruno, 'Firefox', 'web')}"})
agent_http = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "deepseek/x")
db.set_setting("api_key", "sk-or-v1-secretdelapersonne", secret=True)
db.set_setting("media_api_key", "sk-or-v1-secretdelapersonne", secret=True)


async def online(*a, **k):
    return True


hermes.health = online

# 1. Les erreurs brutes deviennent une phrase utile.
cases = {
    "Error code: 401 - {'error': {'message': 'API key expired.', 'code': 401}}": "a expiré",
    "HTTP 401: invalid x-api-key": "refusé ta clé",
    "AuthenticationError: bad token": "refusé ta clé",
    "Error code: 403 - key has no access": "refusé ta clé",
    "Error code: 402 - insufficient credits": "plus de crédit",
    "Error code: 429 - rate limit exceeded": "limite les requêtes",
    "HTTP 429: quota exceeded": "limite les requêtes",
    "HTTP 403: content policy violation": "selon ses règles",
    "HTTP 503: upstream credential expired": "en panne",
    "Your API key has expired": "a expiré",
    "Error code: 404 - model not found: deepseek/x": "modèle",
    "No endpoints found for deepseek/x": "modèle",
    "maximum context length is 8192 tokens": "trop longue",
    "Error code: 503 - upstream overloaded": "surchargé",
    "Read timed out": "n'a pas répondu",
    "'utf-8' codec can't decode byte 0x8b in position 1: invalid start byte": "Voir les détails",
    "": "arrêté avant la fin",
}
for raw, expected in cases.items():
    said = events.friendly_error(raw)
    assert expected in said, f"{raw!r} → {said!r}"
    assert "codec" not in said and "Error code" not in said, f"erreur brute montrée : {said}"
for own in ("Budget mensuel de 5.00 $ atteint. Augmente-le dans Noah Agent pour continuer.",
            "Plafond du jour de 1.00 $ atteint pour cet agent. Il reprend demain, ou augmente le plafond dans Noah Agent.",
            relay.UNREACHABLE):
    assert events.friendly_error(own) == own, "les phrases de Noah restent telles quelles"
    assert "sk-or" not in events.friendly_error("Budget exhausted; key=sk-or-v1-syntheticsecret123"), "un préfixe de Noah ne laisse pas passer une clé"
    assert "syntheticsecret" not in events.friendly_error("Budget exhausted; token=syntheticsecret123")
print("1. les erreurs connues sont traduites, les autres renvoient aux détails")

# 2. Les détails ne laissent passer aucun secret.
leaky = "401 sk-or-v1-abcdef123456 Bearer abcdefghijkl123 x-api-key: zzzzzzzzzzzz sk-or-v1-secretdelapersonne"
masked = diagnostics.mask(leaky)
for secret in ("abcdef123456", "abcdefghijkl123", "zzzzzzzzzzzz", "secretdelapersonne"):
    assert secret not in masked, masked
print("2. les secrets sont masqués")

# 3. Une tâche qui échoue garde ses détails, écran et historique.
script: list = []


async def start_run(agent, text, session_id):
    if script and script[0] == "refus":
        script.pop(0)
        raise httpx.ConnectError("agent en train de redémarrer")
    return "run-1"


async def run_events(agent, run_id):
    while script:
        item = script.pop(0)
        if isinstance(item, Exception):
            raise item
        yield item


hermes.start_run = start_run
hermes.run_events = run_events


def chat(text, conv=None):
    r = web.post("/api/chat", json={"agent_id": "a1", "text": text, "conversation_id": conv})
    evs = [json.loads(line[5:]) for line in r.text.splitlines() if line.startswith("data:")]
    return r, evs


def stored():
    with db.connect() as c:
        conv = c.execute("SELECT id FROM conversations ORDER BY rowid DESC LIMIT 1").fetchone()["id"]
    return web.get(f"/api/conversations/{conv}/messages").json()


script[:] = [("run.failed", {"error": "Error code: 401 - API key expired. sk-or-v1-abcdef123456"})]
_, evs = chat("hi")
done = [e for e in evs if e["type"] == "done"][-1]
assert "a expiré" in done["error"], done
assert "API key expired" in done["details"] and "abcdef123456" not in done["details"], done
assert "openrouter" in done["details"] and "deepseek/x" in done["details"], done
last = stored()[-1]
assert last["role"] == "error" and "a expiré" in last["text"] and "API key expired" in last["detail"], last
assert stored()[-2]["detail"] is None
print("3. une tâche échouée donne une phrase, et les détails restent après rechargement")

# 4. Jamais de message sans réponse ni erreur.
before = len(stored())
script[:] = ["refus"]
r, _ = chat("hi")
assert r.status_code == 503
after = stored()
assert len(after) == before + 2 and after[-1]["role"] == "error" and after[-1]["detail"], after[-2:]

script[:] = [("tool.started", {"tool": "terminal"})]  # le flux finit sans événement de fin
_, evs = chat("hi")
assert [e for e in evs if e["type"] == "done"], "l'écran doit savoir que c'est fini"
assert stored()[-1]["role"] == "error"

script[:] = [httpx.RemoteProtocolError("connexion coupée")]
_, evs = chat("hi")
assert "connexion coupée" in [e for e in evs if e["type"] == "done"][-1]["details"]
assert stored()[-1]["role"] == "error"
print("4. agent qui redémarre ou flux coupé : c'est écrit dans la conversation")

# 5. La création d'image ne répond jamais par un 500 muet, et la panne interne est distinguée de celle du fournisseur.
ask = {"type": "image", "description": "un lion sur la lune"}


async def models(kind):
    return [{"id": "image-a", "quality": 5, "speed": 3, "strengths": ["x"], "cost": None}]


async def fixed_voice():
    return "voix"

media.models = models
media.voice_model = fixed_voice
images = {"mode": "ok"}
real_client = httpx.AsyncClient


def upstream(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/chat/completions"):
        # Un modèle à raisonnement peut finir sans texte : content null.
        return httpx.Response(200, json={"model": "voix", "choices": [{"message": {"content": None}}]})
    if images["mode"] == "down":
        raise httpx.ConnectError("pas de route")
    if images["mode"] == "401":
        return httpx.Response(401, json={"error": {"message": "API key expired."}})
    return httpx.Response(200, json={"data": [{"b64_json": "aW1hZ2U=", "media_type": "image/png"}], "usage": {"cost": 0.01}})


media.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(upstream), **{k: v for k, v in kw.items() if k != "transport"})
uploads = {"mode": "ok"}


async def upload(agent_id, name, data, folder="uploads"):
    if uploads["mode"] == "down":
        raise httpx.HTTPStatusError("500", request=httpx.Request("PUT", "http://l"), response=httpx.Response(500))
    if uploads["mode"] == "bug":
        raise RuntimeError("panne interne sk-or-v1-abcdef123456")
    return f"/opt/data/workspace/outputs/{name}"


hermes.upload = upload
r = agent_http.post("/agent-api/media", json=ask)
assert r.status_code == 200 and r.json().get("chemin"), f"routeur sans texte : {r.status_code} {r.text}"
print("5a. un routeur qui répond sans texte n'empêche pas l'image")

images["mode"] = "401"
r = agent_http.post("/agent-api/media", json=ask)
assert r.status_code == 200 and "invalide ou expirée" in r.json()["erreur"], r.text
images["mode"] = "down"
r = agent_http.post("/agent-api/media", json=ask)
assert r.status_code == 200 and "ne répond pas" in r.json()["erreur"], r.text
images["mode"] = "ok"
uploads["mode"] = "down"
r = agent_http.post("/agent-api/media", json=ask)
assert r.status_code == 200 and "enregistr" in r.json()["erreur"], r.text
uploads["mode"] = "bug"
r = agent_http.post("/agent-api/media", json=ask)
assert r.status_code == 200 and "pas le fournisseur" in r.json()["erreur"], r.text
assert "abcdef123456" not in r.text
uploads["mode"] = "ok"
print("5b. chaque panne de la création dit où elle est")

# 6. Le propriétaire lit les erreurs du serveur sans accéder à la machine.
assert other.get("/api/diagnostic").status_code == 403
d = web.get("/api/diagnostic").json()
text = json.dumps(d, ensure_ascii=False)
assert "panne interne" in text and "Traceback" in text, text[:400]
assert "abcdef123456" not in text and "secretdelapersonne" not in text
assert d["fournisseur"] == "openrouter" and "version" in d and d["agents"][0]["id"] == "a1"


@main.app.get("/api/essai-panne")
def broken():
    raise ValueError("bug sk-or-v1-abcdef123456")


r = web.get("/api/essai-panne")
assert r.status_code == 500 and "Réglages" in r.json()["detail"] and "bug" not in r.text, r.text
assert "ValueError" in json.dumps(web.get("/api/diagnostic").json())
print("6. Réglages > Diagnostic : erreurs récentes, sans secret, réservé au propriétaire")
print("OK")
