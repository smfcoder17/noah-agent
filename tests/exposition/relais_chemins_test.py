"""Relais : l'agent n'atteint que les routes de chat du fournisseur avec la clé du propriétaire (audit 0.3.0, Sonnet n°2).

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/exposition/relais_chemins_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import db, main, relay  # noqa: E402

db.init()
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Veilleur', '', 'k')")
db.set_setting("provider", "openrouter")
db.set_setting("api_key", "sk-CLE-DU-PROPRIETAIRE", secret=True)

seen = []


def upstream(request: httpx.Request) -> httpx.Response:
    seen.append((request.method, request.url.path))
    return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
agent = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
fails = 0


def check(ok: bool, what: str) -> None:
    global fails
    print(("ok   " if ok else "ÉCHEC ") + what)
    fails += not ok


r = agent.post("/relay/v1/chat/completions", json={"model": "m", "messages": []})
check(r.status_code == 200 and seen[-1] == ("POST", "/api/v1/chat/completions"), "le chat passe")
check(agent.get("/relay/v1/models").status_code == 200, "la liste des modèles passe")
before = len(seen)
for method, path in (("POST", "/relay/v1/../../api/delete"), ("GET", "/relay/v1/%2e%2e/%2e%2e/api/tags"),
                     ("POST", "/relay/v1/files"), ("POST", "/relay/v1/keys"), ("GET", "/relay/v1/credits"),
                     ("POST", "/relay/v1/chat/completions/../../admin"), ("GET", "/relay/v1/models/%2e%2e")):
    r = agent.request(method, path, json={"name": "x"} if method == "POST" else None)
    check(r.status_code == 404, f"{method} {path} refusé ({r.status_code})")
check(len(seen) == before, "rien n'est parti chez le fournisseur pour ces routes")
check(relay.relay_path_allowed("POST", "audio/speech") and not relay.relay_path_allowed("GET", "chat/completions"), "méthode par route")
# Une requête invalide ne recopie pas ce qu'on a envoyé (audit 0.3.0, Sonnet n°8).
from noah import auth  # noqa: E402
u = auth.create_user("alice", "motdepasse-alice")
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(u, 'Firefox', 'web')}"})
r = web.post("/api/login", json={"username": "x" * 5000, "password": "ghp_SECRET_" + "A" * 5000})
check(r.status_code == 422 and "ghp_SECRET_" not in r.text and "xxxxxxxx" not in r.text and "loc" in r.text, "un 422 ne recopie pas le jeton envoyé")
print("relais : tout est vert" if not fails else f"relais : {fails} échec(s)")
sys.exit(1 if fails else 0)
