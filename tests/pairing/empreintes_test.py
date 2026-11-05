"""G2.4 : la base ne contient que des hachages SHA-256 des jetons d'appairage et d'appareil, jamais un jeton en clair,
vérifié par un dump SQL (et par les octets bruts des fichiers de la base, journal WAL compris, où reste ce qu'un dump ne
montre plus). Tous les chemins qui créent un jeton passent ici. Vrais : routes, SQLite. Rien n'est simulé sur ce chemin.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim \
      sh -c "pip install -q -r /app/requirements.txt && python /tests/pairing/empreintes_test.py"
"""
import base64
import hashlib
import os
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = Path(tempfile.mkdtemp())
os.environ["NOAH_DATA_DIR"] = str(DATA)
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
main._ip = lambda request: request.headers.get("x-test-ip", "")
ip = iter(range(1, 250))
SHA = re.compile(r"^[0-9a-f]{64}$")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def client(token: str | None = None) -> TestClient:
    c = TestClient(main.app, headers={"X-Test-Ip": f"10.0.0.{next(ip)}"})
    if token:
        c.headers["Authorization"] = f"Bearer {token}"
    return c


secrets_seen: dict[str, str] = {}   # ce qui ne doit jamais être écrit en clair : nom -> jeton
live: dict[str, str] = {}           # jetons d'appareil encore valables : nom -> jeton

# Connexion par mot de passe : le jeton arrive en cookie.
browser = client()
assert browser.post("/api/login", json={"username": "alice", "password": "motdepasse-a"}).status_code == 200
live["navigateur"] = browser.cookies.get(auth.COOKIE)
web = client(live["navigateur"])

# QR code (application Android), puis le code court d'un autre affichage.
p = web.post("/api/pairing").json()
link = p["adresse"].split("#appairage=")[1]
secrets_seen |= {"lien du QR": link, "code court": p["code"], "code court normalisé": p["code"].replace("-", "")}
r = client().post("/api/pairing/claim", json={"code": link, "appareil": "Pixel 8", "type": "android"}).json()
secrets_seen["sondage du QR"] = r["sondage"]
fid = web.get("/api/pairing/pending").json()["demandes"][0]["id"]
assert web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]}).status_code == 200
live["android (QR)"] = client().post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).json()["token"]

p = web.post("/api/pairing").json()
secrets_seen |= {"code court 2": p["code"], "code court 2 normalisé": p["code"].replace("-", ""),
                 "lien du QR 2": p["adresse"].split("#appairage=")[1]}
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Tablette", "type": "android"}).json()
secrets_seen["sondage du code court"] = r["sondage"]
fid = web.get("/api/pairing/pending").json()["demandes"][0]["id"]
web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]})
live["android (code court)"] = client().post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).json()["token"]

# Navigateur du téléphone : le jeton arrive en cookie au sondage.
p = web.post("/api/pairing").json()
link2 = p["adresse"].split("#appairage=")[1]
secrets_seen |= {"lien du QR 3": link2, "code court 3": p["code"], "code court 3 normalisé": p["code"].replace("-", "")}
phone = client()
r = phone.post("/api/pairing/claim", json={"code": link2}).json()
secrets_seen["sondage du navigateur"] = r["sondage"]
fid = web.get("/api/pairing/pending").json()["demandes"][0]["id"]
web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]})
assert phone.post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).status_code == 200
live["navigateur du téléphone"] = phone.cookies.get(auth.COOKIE)

# Application de bureau (autorisation dans le navigateur).
r = client().post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"}).json()
fid = r["adresse"].split("#autoriser=")[1]
secrets_seen |= {"sondage du bureau": r["sondage"], "identifiant de la page d'accord": fid}
number = web.get(f"/api/pairing/flow/{fid}").json()["verification"]
assert web.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 200
live["bureau"] = client().post("/api/pairing/flow/poll", json={"sondage": r["sondage"], "verification": number}).json()["token"]

# Un QR affiché et jamais scanné : son empreinte reste en mémoire, rien en base.
p = web.post("/api/pairing").json()
unused = p["adresse"].split("#appairage=")[1]
secrets_seen |= {"lien du QR jamais scanné": unused, "code court jamais servi": p["code"],
                 "code court jamais servi normalisé": p["code"].replace("-", "")}
assert auth.digest(unused) in main._pairing and unused not in main._pairing, "jeton d'appairage gardé en clair en mémoire"
assert all(SHA.match(k) for k in main._pairing), "clé du registre d'appairage qui n'est pas une empreinte"
assert all(SHA.match(f["sondage"]) for f in main._flows.values()), "sondage gardé en clair en mémoire"

# Abonnement aux notifications : rattaché à la session de l'appareil (colonne `session` des deux tables de push).
point = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
sub = client(live["android (QR)"]).post("/api/push/subscription", json={
    "endpoint": "https://fcm.googleapis.com/fcm/send/abc", "p256dh": base64.urlsafe_b64encode(point).decode().rstrip("="),
    "auth": "AAAAAAAAAAAAAAAAAAAAAA"})
assert sub.status_code == 200, sub.text
with db.connect() as c:
    c.execute("INSERT INTO push_queue (endpoint, session, p256dh, auth, payload, urgent, not_before, tries, created) "
              "SELECT endpoint, session, p256dh, auth, x'00', 0, 0, 0, 0 FROM push_subscriptions")

# Un appareil révoqué : son jeton n'est plus rien, et n'a jamais été écrit en clair non plus.
revoked = auth.new_session(alice, "Révoqué", "android")
secrets_seen["session révoquée"] = revoked
assert client(revoked).delete("/api/devices/self").status_code == 200

# Base d'une ancienne version : une session en clair, déjà sur le disque, est migrée au démarrage et marche encore.
legacy = "ancien-jeton-en-clair-" + "z" * 22
now = datetime.now(timezone.utc)
with db.connect() as c:
    c.execute("INSERT INTO sessions (token, user_id, expires_at, device, platform) VALUES (?, ?, ?, 'Ancien', 'web')",
              (legacy, alice, (now + timedelta(days=5)).isoformat()))
with sqlite3.connect(DATA / "noah.db") as c:
    c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
assert legacy.encode() in (DATA / "noah.db").read_bytes(), "le contrôle ne verrait pas un jeton en clair sur le disque"
auth.hash_old_sessions()
with db.connect() as c:
    pass  # dernière connexion fermée : SQLite reverse le journal WAL dans le fichier
live["ancienne session migrée"] = legacy
assert client(legacy).get("/api/me").status_code == 200, "session migrée refusée"

all_tokens = {**secrets_seen, **live}
assert all(all_tokens.values()) and len(set(all_tokens.values())) == len(all_tokens), "jeton vide ou répété : le contrôle ne vaut rien"

# 1. Le dump SQL de toute la base, et les octets bruts de tous les fichiers du dossier de données.
with sqlite3.connect(DATA / "noah.db") as c:
    dump = "\n".join(c.iterdump())
    tables = sorted(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
files = {p.name: p.read_bytes() for p in DATA.rglob("*") if p.is_file()}
assert "noah.db" in files and len(dump) > 5000, "dump vide : le contrôle ne regarde rien"
for name, value in all_tokens.items():
    assert value not in dump, f"{name} en clair dans le dump SQL"
    for fname, content in files.items():
        assert value.encode() not in content, f"{name} en clair dans le fichier {fname}"
print(f"1. {len(all_tokens)} jetons cherchés dans le dump SQL ({len(dump)} caractères, {len(tables)} tables) et dans "
      f"{', '.join(sorted(files))} : aucun en clair")

# 2. Ce qui est en base est bien l'empreinte SHA-256 de chaque jeton d'appareil, et rien d'autre.
with sqlite3.connect(DATA / "noah.db") as c:
    stored = {r[0] for r in c.execute("SELECT token FROM sessions")}
expected = {sha256(t) for t in live.values()}
assert stored == expected, f"sessions en base : {len(stored)}, attendues : {len(expected)}"
assert all(digest in dump for digest in expected), "empreinte absente du dump : le contrôle ne regarde pas la bonne base"
assert all(SHA.match(s) for s in stored)
assert auth.digest("abc") == hashlib.sha256(b"abc").hexdigest(), "ce n'est pas du SHA-256"
print(f"2. table sessions : exactement les {len(expected)} empreintes SHA-256 attendues")

# 3. Les colonnes qui désignent une session (notifications) gardent l'empreinte, pas le jeton.
with sqlite3.connect(DATA / "noah.db") as c:
    for table in ("push_subscriptions", "push_queue"):
        values = [r[0] for r in c.execute(f"SELECT session FROM {table}")]
        assert values == [sha256(live["android (QR)"])], f"{table}.session : {values}"
print("3. push_subscriptions.session et push_queue.session : empreinte de la session")

# 4. Une empreinte volée n'ouvre rien : c'est le but du hachage.
assert client(sha256(live["bureau"])).get("/api/me").status_code == 401, "une empreinte volée dans la base connecte"
print("4. l'empreinte lue dans la base, présentée comme jeton : 401")
print("G2.4 : tout est vert")
