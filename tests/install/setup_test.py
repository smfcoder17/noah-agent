"""Installation sur VPS (G1.4, G1.5) : le code d'installation à usage unique, et les secrets et sessions qui survivent à
un redémarrage (docker compose down puis up, ou nouvelle image).

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/install/setup_test.py"
"""
import json
import os
import subprocess
import sys
import tempfile

data, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
# Comme deploy/docker-compose.yml : aucune variable à saisir, tout est « auto ».
ENV = {"APOLLO_DATA_DIR": data, "NOAH_SECRETS_FILE": f"{vault}/noah.json", "NOAH_SETUP_CODE": "auto",
       "LAUNCHER_KEY": "auto", "APOLLO_SECRET_KEY": "auto"}
os.environ.update(ENV)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from apollo import auth, config, db, main  # noqa: E402

db.init()
code = json.load(open(f"{vault}/noah.json"))["NOAH_SETUP_CODE"]
assert len(code) == 8 and oct(os.stat(f"{vault}/noah.json").st_mode)[-3:] == "600", "secrets lisibles par d'autres"
ip = iter(range(1, 250))


def client() -> TestClient:
    return TestClient(main.app, headers={"X-Test-Ip": f"10.1.0.{next(ip)}"})


main._ip = lambda request: request.headers.get("x-test-ip", "")
account = {"username": "franck", "password": "motdepasse-long"}

# 1. Sans le code, ou avec un faux, personne ne prend l'installation (le premier visiteur d'une IP publique).
assert client().get("/api/status").json()["setup_code"] is True
assert client().post("/api/setup/account", json={**account, "installation": ""}).status_code == 403
assert client().post("/api/setup/account", json={**account, "installation": "BCDFGHJK"}).status_code == 403
assert not auth.has_users()
print("1. sans code ou avec un faux : 403, aucun compte créé")

# 2. Essais répétés depuis une même adresse : bloqués (429) avant de pouvoir deviner.
attacker = TestClient(main.app, headers={"X-Test-Ip": "203.0.113.9"})
codes = [attacker.post("/api/setup/account", json={**account, "installation": f"BCDFGHJ{c}"}).status_code
         for c in "LMNPQRSTVWXZ"]
assert 429 in codes and codes.index(429) <= main.LOGIN_TRIES, codes
assert attacker.post("/api/setup/account", json={**account, "installation": code}).status_code == 429, "vrai code accepté pendant le blocage"
print(f"2. {codes.index(429)} essais faux depuis une adresse, puis 429 (même avec le vrai code)")

# 2 bis. Assistant (G1.8) : le code est vérifié en première étape, sans être consommé.
assert client().post("/api/setup/check", json={"installation": "BCDFGHJK"}).status_code == 403
assert client().post("/api/setup/check", json={"installation": code}).status_code == 200
assert "NOAH_SETUP_CODE" in json.load(open(f"{vault}/noah.json")) and not auth.has_users()
print("2 bis. assistant : code vérifié d'abord (403 faux, 200 bon), toujours valable pour créer le compte")

# 3. Le bon code (tirets et minuscules tolérés) crée le propriétaire ; ensuite 410 et le code est effacé.
owner = TestClient(main.app, headers={"X-Test-Ip": "10.2.0.1", "Origin": "http://testserver"})
r = owner.post("/api/setup/account", json={**account, "installation": f"{code[:4].lower()}-{code[4:]}"})
assert r.status_code == 200 and "apollo_session" in r.headers.get("set-cookie", ""), r.text
assert client().post("/api/setup/account", json={**account, "installation": code}).status_code == 410
assert "NOAH_SETUP_CODE" not in json.load(open(f"{vault}/noah.json")), "code d'installation encore dans les secrets"
assert client().get("/api/status").json()["setup_code"] is False
assert client().post("/api/setup/check", json={"installation": code}).status_code == 410
print("3. bon code : compte créé ; ensuite 410, code effacé des secrets")

# 3 bis. L'assistant ne se termine qu'après une vraie réponse du modèle.
assert owner.get("/api/status").json()["onboarded"] is False
assert client().post("/api/setup/done").status_code == 401
r = owner.post("/api/setup/done"); assert r.status_code == 409, (r.status_code, r.text)
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Noah', '', 'k')")
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main) VALUES ('c1', 1, 'a1', 'x', 1)")
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c1', 'error', 'clé refusée')")
assert owner.post("/api/setup/done").status_code == 409, "une erreur compte comme une réponse"
with db.connect() as c:
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c1', 'agent', 'Bonjour, je suis Noah.')")
assert owner.post("/api/setup/done").status_code == 200
assert owner.get("/api/status").json()["onboarded"] is True
print("3 bis. fin de l'assistant refusée (409) sans réponse du modèle, acceptée après")

# 4. Redémarrage (nouveau processus, mêmes volumes) : mêmes secrets, session toujours valable, pas de nouveau code.
token = auth.new_session(auth.check_password("franck", "motdepasse-long"), "PC", "web")
restart = subprocess.run([sys.executable, "-c", f"""
import json, sys
sys.path.insert(0, "/app")
from apollo import auth, config
print(json.dumps({{"launcher": config.LAUNCHER_KEY, "secret": config.SECRET_KEY, "setup": config.SETUP_CODE,
                   "valid": auth.still_valid({token!r})}}))
"""], env={**os.environ, **ENV}, capture_output=True, text=True)
after = json.loads(restart.stdout.strip().splitlines()[-1])
assert after["launcher"] == config.LAUNCHER_KEY and after["secret"] == config.SECRET_KEY, "secrets changés au redémarrage"
assert after["valid"], "session perdue au redémarrage"
assert after["setup"] == "", "un nouveau code d'installation est apparu après la création du compte"
print("4. redémarrage : mêmes secrets, session gardée, aucun nouveau code d'installation")
print("installation : tout est vert")
