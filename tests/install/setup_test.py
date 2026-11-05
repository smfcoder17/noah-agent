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
ENV = {"NOAH_DATA_DIR": data, "NOAH_SECRETS_FILE": f"{vault}/noah.json", "NOAH_SETUP_CODE": "auto",
       "LAUNCHER_KEY": "auto", "NOAH_SECRET_KEY": "auto"}
os.environ.update(ENV)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, config, db, main  # noqa: E402

db.init()
code = json.load(open(f"{vault}/noah.json"))["NOAH_SETUP_CODE"]
assert len(code) == 12 and oct(os.stat(f"{vault}/noah.json").st_mode)[-3:] == "600", "secrets lisibles par d'autres"
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
assert r.status_code == 200 and "noah_session" in r.headers.get("set-cookie", ""), r.text
assert client().post("/api/setup/account", json={**account, "installation": code}).status_code == 410
assert "NOAH_SETUP_CODE" not in json.load(open(f"{vault}/noah.json")), "code d'installation encore dans les secrets"
assert client().get("/api/status").json()["setup_code"] is False
assert client().post("/api/setup/check", json={"installation": code}).status_code == 410
print("3. bon code : compte créé ; ensuite 410, code effacé des secrets")

# 3 bis. L'assistant ne se termine qu'après une exécution terminée du modèle en service, avec du texte.
assert owner.get("/api/status").json()["onboarded"] is False
assert client().post("/api/setup/done").status_code == 401
r = owner.post("/api/setup/done"); assert r.status_code == 409, (r.status_code, r.text)
with db.connect() as c:  # message « agent » sans exécution réussie (annonce système, essai d'avant) : pas une preuve
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Noah', '', 'k')")
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main) VALUES ('c1', 1, 'a1', 'x', 1)")
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c1', 'agent', 'Noah 2.0 est installée.')")
assert owner.post("/api/setup/done").status_code == 409, "un message système termine l'assistant"
db.set_setting("provider", "openrouter"); db.set_setting("model", "m1")
rev = main._config_rev("a1")
db.set_setting("applied:a1", rev)  # l'agent a bien reçu cette configuration
main._model_replied({"type": "done", "status": "failed"}, "Bonjour, je", rev)  # texte puis échec
main._model_replied({"type": "done", "status": "completed"}, "   ", rev)        # rien de lisible
main._model_replied(None, "Bonjour", rev)                                       # flux coupé sans fin
assert owner.post("/api/setup/done").status_code == 409, "essai raté accepté"
main._model_replied({"type": "done", "status": "completed"}, "Bonjour, je suis Noah.", rev)
db.set_setting("model", "m2")  # modèle changé après l'essai : il faut réessayer avec celui-ci
assert owner.post("/api/setup/done").status_code == 409, "essai d'un autre modèle accepté"
main._model_replied({"type": "done", "status": "completed"}, "Bonjour, je suis Noah.", rev)  # parti avant le changement
assert owner.post("/api/setup/done").status_code == 409, "essai lancé avec l'ancien modèle accepté"
db.set_setting("api_key", "cle-essai", secret=True)
rev = main._config_rev("a1")
db.set_setting("applied:a1", rev)  # l'agent a bien reçu cette configuration
main._model_replied({"type": "done", "status": "completed"}, "Bonjour, je suis Noah.", rev)
db.set_setting("api_key", "autre-cle", secret=True)  # clé remplacée après l'essai
assert owner.post("/api/setup/done").status_code == 409, "clé changée après l'essai acceptée"
db.set_setting("api_key", "cle-essai", secret=True)
db.set_setting("model_a1", "m-propre")  # l'agent a son propre modèle : l'essai fait avec le modèle global ne compte pas
assert owner.post("/api/setup/done").status_code == 409, "essai d'un autre modèle que celui de l'agent accepté"
db.set_setting("model_a1", "")
# Modèle changé en base sans que l'agent ait été reconfiguré (lanceur indisponible) : sa réponse ne prouve rien.
db.set_setting("model", "m3")
main._model_replied({"type": "done", "status": "completed"}, "Bonjour", main._config_rev("a1"))
assert owner.post("/api/setup/done").status_code == 409, "modèle jamais appliqué certifié"
db.set_setting("model", "m2")
assert owner.post("/api/setup/done").status_code == 200
assert owner.get("/api/status").json()["onboarded"] is True
print("3 bis. fin refusée (409) pour un message système, un essai raté ou un autre modèle ; acceptée après un vrai essai")

# 3 ter. Installation d'avant l'assistant (aucune clé « onboarded ») : jamais renvoyée dans l'assistant.
with db.connect() as c:
    c.execute("DELETE FROM settings WHERE key = 'onboarded'")
assert owner.get("/api/status").json()["onboarded"] is True
print("3 ter. installation d'avant l'assistant : considérée comme finie")

# 3 quater. Flux sortants (G7.4) : le fournisseur et le modèle de chaque agent, puis le reste ; aucune télémétrie.
db.set_setting("model_a1", "modele-propre")
flux = owner.get("/api/flux").json()
brain = [f for f in flux["flux"] if f.get("agent") == "a1"]
assert brain and brain[0]["vers"] == "openrouter.ai" and "modele-propre" in brain[0]["detail"], flux
assert flux["telemetrie"] is False and any("mises à jour" in f["quoi"] for f in flux["flux"])
assert client().get("/api/flux").status_code == 401
db.set_setting("model_a1", "")
print("3 quater. flux sortants : fournisseur et modèle de chaque agent, mises à jour, aucune télémétrie")

# 4. Redémarrage (nouveau processus, mêmes volumes) : mêmes secrets, session toujours valable, pas de nouveau code.
token = auth.new_session(auth.check_password("franck", "motdepasse-long"), "PC", "web")
restart = subprocess.run([sys.executable, "-c", f"""
import json, sys
sys.path.insert(0, "/app")
from noah import auth, config
print(json.dumps({{"launcher": config.LAUNCHER_KEY, "secret": config.SECRET_KEY, "setup": config.SETUP_CODE,
                   "valid": auth.still_valid({token!r})}}))
"""], env={**os.environ, **ENV}, capture_output=True, text=True)
after = json.loads(restart.stdout.strip().splitlines()[-1])
assert after["launcher"] == config.LAUNCHER_KEY and after["secret"] == config.SECRET_KEY, "secrets changés au redémarrage"
assert after["valid"], "session perdue au redémarrage"
assert after["setup"] == "", "un nouveau code d'installation est apparu après la création du compte"
print("4. redémarrage : mêmes secrets, session gardée, aucun nouveau code d'installation")

# 5. Cas limites, sur la fonction de vérification (personne n'a encore de compte).
from concurrent.futures import ThreadPoolExecutor  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from fastapi import HTTPException  # noqa: E402

auth.has_users = lambda: False
req = lambda ip: SimpleNamespace(headers={"x-test-ip": ip})  # noqa: E731


def verdict(given: str, ip: str) -> int:
    try:
        main._check_setup_code(given, req(ip))
        return 200
    except HTTPException as e:
        return e.status_code


# 5a. Essais simultanés depuis une adresse : le plafond tient (essai réservé avant la comparaison).
main._setup_tries.clear()
with ThreadPoolExecutor(16) as pool:
    results = list(pool.map(lambda i: verdict("BBBBBBBB", "198.51.100.7"), range(16)))
assert results.count(403) <= main.LOGIN_TRIES and results.count(429) >= 16 - main.LOGIN_TRIES, results
print(f"5a. 16 essais simultanés : {results.count(403)} comparés, {results.count(429)} refusés (429)")

# 5b. Base des comptes perdue, secrets gardés (code effacé) : un nouveau code est tiré, rien n'est ouvert.
config.SETUP_CODE = ""
config.renew_setup_code()
fresh = json.load(open(f"{vault}/noah.json"))["NOAH_SETUP_CODE"]
assert len(fresh) == 12 and config.setup_code() == fresh
assert verdict("", "198.51.100.8") == 403
config.SETUP_CODE = "ABCDEFGH"  # code court d'une version d'avant
config.renew_setup_code()
assert len(config.setup_code()) == 12, "ancien code court gardé"
fresh = config.setup_code()
print("5b. code effacé, ou court (version d'avant), sans compte : nouveau code de 12 lettres au démarrage")

# 5c. Sans code du tout (ordinateur personnel) : le compte ne se crée que depuis la machine ou le réseau local.
config.SETUP_CODE = ""
assert verdict("", "9.9.9.9") == 403, "installation sans code prise depuis Internet"
assert verdict("", "127.0.0.1") == 200 and verdict("", "172.18.0.1") == 200
relayed = SimpleNamespace(headers={"x-test-ip": "172.18.0.1", "x-forwarded-for": "9.9.9.9"})
try:
    main._check_setup_code("", relayed)
    raise AssertionError("installation sans code acceptée à travers un relais")
except HTTPException as e:
    assert e.status_code == 403
print("5c. sans code : refusé depuis Internet ou à travers un relais, accepté depuis la machine (ou Docker en local)")

# 5d. Des essais faux depuis beaucoup d'adresses ne bloquent pas le propriétaire (pas de plafond global).
config.SETUP_CODE = fresh
for i in range(30):
    for _ in range(main.LOGIN_TRIES):
        verdict("BBBBBBBBBBBB", f"9.9.{i}.1")
assert verdict(fresh, "8.8.4.4") == 200, "propriétaire bloqué par des essais d'inconnus"
print("5d. 300 essais faux répartis sur 30 adresses : le propriétaire passe toujours")

# 6. Compatibilité des apps (G5.6) : le serveur annonce la plus ancienne version servie ; en dessous, 426 et un
# message lisible, au lieu d'une erreur plus loin. L'interface web (même version que le serveur) n'est pas concernée.
main.MIN_CLIENT_VERSION = "0.2.0"
st = client().get("/api/status", headers={"X-Noah-Version": "0.1.0"})
assert st.status_code == 200 and st.json()["min_client_version"] == "0.2.0" and st.json()["api"] == 1
old = client().post("/api/pairing/claim", json={"code": "x"}, headers={"X-Noah-Version": "0.1.9"})
assert old.status_code == 426 and "mets-la à jour" in old.json()["detail"], old.text
for v in ("0.2.0", "0.10.0", "1.0.0-beta"):
    assert client().post("/api/pairing/claim", json={"code": "x"}, headers={"X-Noah-Version": v}).status_code != 426, v
assert client().post("/api/pairing/claim", json={"code": "x"}).status_code != 426
print("6. app trop ancienne : 426 avec « mets-la à jour » ; versions servies et interface web inchangées")
print("installation : tout est vert")
