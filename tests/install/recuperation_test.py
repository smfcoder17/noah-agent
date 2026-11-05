"""Mot de passe oublié, sans courriel : qui a accès au serveur lit un code à usage unique (journaux, ou commande dans le
conteneur), et change le mot de passe du propriétaire. Toutes les sessions tombent. Vrais : les routes, la base, le processus
de la commande. Simulée : l'horloge. Le parcours à l'écran, avec les vrais journaux du conteneur : tests/real/recuperation_ecran.mjs.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/install/recuperation_test.py"
"""
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

data = tempfile.mkdtemp()
ENV = {"NOAH_DATA_DIR": data, "LAUNCHER_KEY": "x", "NOAH_SECRET_KEY": "y" * 32, "NOAH_SETUP_CODE": ""}
os.environ.update(ENV)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main, recuperation  # noqa: E402

db.init()
main._ip = lambda request: request.headers.get("x-test-ip", "")
net = iter(range(1, 60000))


def client(ip: str | None = None) -> TestClient:
    n = next(net)
    return TestClient(main.app, headers={"X-Test-Ip": ip or f"10.{n >> 8}.{n & 255}.1"})


class Clock:
    """L'horloge du seul module de récupération, décalée : il croit que `offset` secondes ont passé."""
    offset = 0.0

    def time(self) -> float:
        return time.time() + self.offset

    def __getattr__(self, name):
        return getattr(time, name)


clock = Clock()
recuperation.time = clock


class Lines(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


journal = Lines()
logging.getLogger("uvicorn.error").addHandler(journal)
CODE = re.compile(r"\b[B-Z]{4}-[B-Z]{4}-[B-Z]{4}\b")


def ask() -> str:
    """Le bouton de l'écran : rend le code tel que le propriétaire le lit dans les journaux."""
    before = len(journal.lines)
    r = client().post("/api/recuperation/code")
    assert r.status_code == 200, r.text
    found = CODE.findall("\n".join(journal.lines[before:]))
    assert len(found) == 1, f"attendu un code dans les journaux : {journal.lines[before:]}"
    assert found[0] not in r.text, "le code part dans la réponse à un inconnu"
    return found[0]


def reset(code: str, password: str = "nouveau-mdp-1", c: TestClient | None = None):
    return (c or client()).post("/api/recuperation", json={"code": code, "password": password})


def logs_in(username: str, password: str) -> bool:
    return client().post("/api/login", json={"username": username, "password": password}).status_code == 200


# Sans compte : rien à récupérer, c'est le code d'installation qui sert.
assert client().post("/api/recuperation/code").status_code == 410
print("0. aucun compte : 410, c'est le code d'installation qui sert")

franck = auth.create_user("franck", "ancien-mdp-1")
nina = auth.create_user("nina", "mdp-de-nina")

# 1. Le code va dans les journaux, jamais dans la réponse ; la base n'en garde que l'empreinte.
code = ask()
plain = code.replace("-", "")
assert len(plain) == 12, code
for name in os.listdir(data):
    with open(f"{data}/{name}", "rb") as f:
        raw = f.read()
    assert plain.encode() not in raw and code.encode() not in raw, f"code en clair dans {name}"
print(f"1. code dans les journaux ({len(plain)} lettres), absent de la réponse et de la base")

# 2. Le bouton ne remplace pas un code en cours : un inconnu ne peut ni l'annuler, ni remplir les journaux.
before = len(journal.lines)
for _ in range(5):
    assert client().post("/api/recuperation/code").status_code == 200
assert not CODE.findall("\n".join(journal.lines[before:])), "le bouton a écrit un autre code"
print("2. 5 demandes de plus : aucun nouveau code, celui en cours reste valable")

# 3. Faux code : refusé, le mot de passe ne bouge pas. Trop d'essais depuis une adresse : 429, même avec le bon code.
attacker = client("203.0.113.9")
statuses = [reset("BCDF-GHJK-LMNP", c=attacker).status_code for _ in range(recuperation.TRIES_PER_NETWORK)]
assert statuses == [400] * recuperation.TRIES_PER_NETWORK, statuses
assert reset(code, c=attacker).status_code == 429, "le bon code passe pendant le blocage"
assert logs_in("franck", "ancien-mdp-1") and not logs_in("franck", "nouveau-mdp-1")
print(f"3. {recuperation.TRIES_PER_NETWORK} codes faux depuis une adresse, puis 429 même avec le bon ; mot de passe inchangé")

# 3 bis. Mot de passe trop court : refusé avant tout, sans consommer d'essai ni le code.
assert reset(code, "court").status_code == 422
print("3 bis. mot de passe trop court : 422, le code reste valable")

# 4. Essais comptés sur le code, toutes adresses confondues : au-delà, il est annulé. Le bon ne passe plus.
for _ in range(recuperation.TRIES_PER_CODE):
    assert reset("BCDF-GHJK-LMNP").status_code == 400
assert reset(code).status_code == 400, "code encore valable après trop d'essais"
assert logs_in("franck", "ancien-mdp-1")
print(f"4. {recuperation.TRIES_PER_CODE} essais faux répartis sur des adresses : le code est annulé")

# 5. Expire au bout de 15 min, annoncé et tenu des deux côtés de la limite ; un code expiré laisse la place à un autre.
assert recuperation.SECONDS == 900
code = ask()
clock.offset = 901
assert reset(code).status_code == 400, "accepté après 15 min"
assert logs_in("franck", "ancien-mdp-1")
code = ask()
clock.offset += 895
assert reset(code, "avant-limite-1").status_code == 200, "refusé avant les 15 min"
assert logs_in("franck", "avant-limite-1")
auth.set_password(franck, "ancien-mdp-1")
clock.offset = 0
code = ask()
print("5. accepté à 895 s, refusé à 901 s, et un nouveau code devient possible")

# 6. Le bon code, tiret et minuscules tolérés : le mot de passe change, l'écran apprend le nom du compte. Toutes les
# sessions tombent, celles du propriétaire, ses fenêtres et celles des profils ; les abonnements aux notifications aussi.
device = auth.new_session(franck, "Téléphone", "android")
web = auth.new_session(franck, "Firefox", "web")
window = auth.new_window(device)
other = auth.new_session(nina, "Chrome", "web")
with db.connect() as c:
    c.execute("INSERT INTO push_subscriptions (endpoint, session, p256dh, auth, created_at) VALUES ('https://p/1', ?, 'k', 'a', '')",
              (auth.digest(device),))
    c.execute("INSERT INTO push_queue (endpoint, session, p256dh, auth, payload, urgent, not_before, tries, created) "
              "VALUES ('https://p/1', ?, 'k', 'a', x'00', 0, 0, 0, 0)", (auth.digest(device),))
connected = TestClient(main.app, headers={"Authorization": f"Bearer {web}", "X-Test-Ip": "10.250.0.1"})
assert connected.get("/api/me").status_code == 200
qr = connected.post("/api/pairing").json()["adresse"].split("#appairage=")[1]

# Dix mots de passe faux juste avant : c'est le cas normal, et ils ne doivent pas bloquer la suite.
me = "198.51.100.7"
mine = client(me)
for _ in range(main.LOGIN_TRIES):
    mine.post("/api/login", json={"username": "franck", "password": "je-ne-sais-plus"})
assert mine.post("/api/login", json={"username": "franck", "password": "ancien-mdp-1"}).status_code == 429

r = reset(code.lower().replace("-", " "), c=mine)
assert r.status_code == 200 and r.json()["username"] == "franck", r.text
assert not logs_in("franck", "ancien-mdp-1"), "l'ancien mot de passe sert encore"
assert mine.post("/api/login", json={"username": "franck", "password": "nouveau-mdp-1"}).status_code == 200, "bloqué par ses essais d'avant"
for name, token in (("appareil", device), ("navigateur", web), ("fenêtre", window), ("profil", other)):
    assert TestClient(main.app, headers={"Authorization": f"Bearer {token}"}).get("/api/me").status_code == 401, f"session gardée : {name}"
assert logs_in("nina", "mdp-de-nina"), "le mot de passe d'un profil a changé"
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_subscriptions").fetchone() and not c.execute("SELECT 1 FROM push_queue").fetchone()
print("6. mot de passe changé, nom du compte rendu, toutes les sessions tombées, connexion possible malgré 10 essais faux avant")

# 6 bis. Un QR affiché avant le changement ne sert plus à rien.
assert client().post("/api/pairing/claim", json={"code": qr, "appareil": "x"}).status_code == 400
print("6 bis. le QR affiché avant le changement est mort")

# 6 ter. Le changement se voit dans les journaux, avec l'adresse, sans le mot de passe.
said = [line for line in journal.lines if "198.51.100.7" in line]
assert said and not any("nouveau-mdp-1" in line for line in journal.lines), journal.lines
print("6 ter. le changement est écrit dans les journaux, sans le mot de passe")

# 7. Usage unique : le même code ne sert pas deux fois, même au même instant.
assert reset(code, "encore-autre-1").status_code == 400
for _ in range(3):
    code = ask()
    start = threading.Barrier(8)
    codes: list[int] = []

    def racer(c: TestClient, password: str) -> None:
        start.wait()
        codes.append(reset(code, password, c).status_code)

    threads = [threading.Thread(target=racer, args=(client(), f"course-mdp-{i}")) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [200] + [400] * 7, codes
print("7. second usage refusé ; 8 envois simultanés (3 fois) : un seul passe")

# 8. La commande dans le conteneur : un autre processus, la même base. Elle remplace le code en cours : avoir la main sur le
# serveur vaut mieux qu'un clic anonyme, et un code perdu ne doit pas faire attendre 15 min.
stale = ask()
done = subprocess.run([sys.executable, "-m", "noah.recuperation"], cwd="/app", env={**os.environ, **ENV}, capture_output=True, text=True, timeout=60)
assert done.returncode == 0, done.stderr
found = CODE.findall(done.stdout)
assert len(found) == 1, done.stdout
assert reset(stale, "remplace-mdp-1").status_code == 400, "l'ancien code sert encore après la commande"
r = reset(found[0], "commande-mdp-1")
assert r.status_code == 200 and logs_in("franck", "commande-mdp-1"), r.text
print("8. commande : autre processus, code valable côté serveur, l'ancien code est remplacé")

# 9. Sans propriétaire, la commande le dit et sort en erreur.
empty = tempfile.mkdtemp()
bare = {**os.environ, **ENV, "NOAH_DATA_DIR": empty}
subprocess.run([sys.executable, "-c", "from noah import db; db.init()"], cwd="/app", env=bare, check=True, capture_output=True, timeout=60)
done = subprocess.run([sys.executable, "-m", "noah.recuperation"], cwd="/app", env=bare, capture_output=True, text=True, timeout=60)
assert done.returncode != 0 and not CODE.findall(done.stdout) and "installation" in done.stdout + done.stderr, done.stdout + done.stderr
print("9. aucun compte : la commande sort en erreur, sans code")
print("Récupération du mot de passe : tout est vert")
