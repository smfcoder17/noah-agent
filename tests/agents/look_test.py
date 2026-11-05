"""Apparence d'un agent : couleur, forme du visage, détail distinctif. Stockée côté serveur, validée strictement.

    export MSYS_NO_PATHCONV=1; docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" -w /tests/agents \
      -e PYTHONPATH=/app --entrypoint python ghcr.io/smfcoder17/noah-server:edge look_test.py
"""
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def outside(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"appel sortant interdit : {request.url}")


class Sandbox(httpx.AsyncClient):
    def __init__(self, *a, **k):
        k["transport"] = httpx.MockTransport(outside)
        super().__init__(*a, **k)


httpx.AsyncClient = Sandbox

from noah import auth, coordination, db, hermes, main  # noqa: E402


async def nothing(*a, **k):
    return {}


hermes.configure = hermes.recreate_container = hermes.restart = nothing

# --- 0. Une base d'avant l'apparence reçoit les colonnes sans rien perdre --------------------------------------------------
old = Path(tempfile.mkdtemp())
raw = sqlite3.connect(old / "noah.db")
raw.executescript("""
CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO agents (id, name, api_key, color) VALUES ('vieux', 'Vieux', 'k', '#112233');
""")
raw.commit()
raw.close()
real_dir = db.DATA_DIR
db.DATA_DIR = old
try:
    db.init()
    db.init()
    with db.connect() as c:
        row = c.execute("SELECT color, shape, detail FROM agents WHERE id = 'vieux'").fetchone()
    assert tuple(row) == ("#112233", "", ""), tuple(row)
finally:
    db.DATA_DIR = real_dir
print("0. ancienne base : colonnes forme et détail ajoutées, couleur gardée, relançable")

# --- Base de travail -------------------------------------------------------------------------------------------------------
db.init()
OWNER = auth.create_user("alice", "motdepasse-a")
READER = auth.create_user("bruno", "motdepasse-b")
ADMIN = auth.create_user("ada", "motdepasse-d")
db.set_setting("onboarded", "1")


def client(user: int) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


alice, bruno, ada = client(OWNER), client(READER), client(ADMIN)
A = "agent-look"
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Lumi', '', 'k', ?)", (A, OWNER))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'lecture')", (A, READER))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (A, ADMIN))


async def healthy(a):
    return True


main._health = healthy


def mine(who: TestClient = alice) -> dict:
    return next(a for a in who.get("/api/agents").json() if a["id"] == A)


def look(body: dict, who: TestClient = alice) -> int:
    return who.patch(f"/api/agents/{A}/look", json=body).status_code


# --- 1. Réglages absents : l'apparence actuelle ne change pas ----------------------------------------------------------------
first = mine()
assert (first["color"], first["shape"], first["detail"]) == ("", "", ""), first
assert look({"pinned": True}) == 200
assert (mine()["color"], mine()["shape"], mine()["detail"]) == ("", "", "")
assert look({"color": "#aabbcc"}) == 200
assert (mine()["color"], mine()["shape"], mine()["detail"]) == ("#aabbcc", "", ""), mine()
print("1. sans réglage : forme et détail vides, couleur seule ne les touche pas")

# --- 2. Forme et détail enregistrés, lisibles par tous ceux qui voient l'agent ------------------------------------------------
assert look({"shape": "goutte", "detail": "lunettes"}) == 200
got = mine()
assert (got["color"], got["shape"], got["detail"]) == ("#aabbcc", "goutte", "lunettes"), got
seen = mine(bruno)
assert (seen["color"], seen["shape"], seen["detail"]) == ("#aabbcc", "goutte", "lunettes"), "le lecteur voit le même visage"
assert look({"color": "#010203"}) == 200 and mine()["shape"] == "goutte", "changer la couleur garde la forme"
assert look({"shape": "", "detail": ""}) == 200
assert (mine()["shape"], mine()["detail"]) == ("", ""), "vide : retour au visage d'origine"
assert look({"shape": "cube", "detail": "antenne"}, ada) == 200 and mine()["shape"] == "cube", "un admin partagé peut"
print("2. forme et détail enregistrés, vus par le lecteur, vidés par une chaîne vide")

# --- 3. Validation stricte : rien d'autre que la liste et #rrggbb --------------------------------------------------------------
before = mine()
for bad in ({"color": "red"}, {"color": "#12345"}, {"color": "#1234567"}, {"color": "#ggg000"}, {"color": 'url(x)'},
            {"color": '#aabbcc" onload="x'}, {"color": "#aabbcc\n"}, {"shape": "<script>"}, {"shape": "Cube"}, {"shape": "cube "},
            {"shape": "x" * 5000}, {"detail": "../etc"}, {"detail": 'a"b'}, {"detail": "inconnu"}, {"shape": None, "detail": 3}):
    code = look(bad)
    assert code in (422,) or bad == {"shape": None, "detail": 3} and code == 422, (bad, code)
    assert mine() == before, f"{bad} a changé quelque chose"
print("3. valeurs hors liste ou hors format refusées (422), rien n'est modifié")

# --- 4. Pas de droit admin : rien ne bouge -------------------------------------------------------------------------------------
before = mine()
assert look({"shape": "bulle", "detail": "antenne", "color": "#000000"}, bruno) in (403, 404)
assert mine() == before, "un lecteur ne change pas l'apparence"
print("4. un lecteur est refusé et rien ne change")

# --- 5. L'appel entrant porte le même visage (téléphone) ---------------------------------------------------------------------
look({"shape": "pastille", "detail": "sourcils", "color": "#445566"})
with db.connect() as c:
    c.execute("INSERT INTO voice_calls (id, agent_id, user_id, conversation_id, texte, etat, created_at) VALUES ('c1', ?, ?, 'x', 't', 'sonne', ?)",
              (A, OWNER, 9e9))
    row = c.execute(coordination.CALL_ROW + "WHERE v.id = 'c1'").fetchone()
pub = coordination._public(row)
assert (pub["couleur"], pub["forme"], pub["detail"]) == ("#445566", "pastille", "sourcils"), pub
print("5. l'appel annonce couleur, forme et détail de l'agent")

print("OK")
