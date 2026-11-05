"""G12 et J9 : plusieurs profils sur un même serveur, aucune fuite, et des agents partagés avec des droits.

Le test parcourt `app.routes` lui-même : toute route /api/ qui prend un identifiant (agent, conversation, appel, routine,
veille, tâche, flux, appareil…) doit être dans ROUTES ou dans WHITELIST, sinon il échoue. Vraies routes, vraie base dans un
dossier temporaire ; aucun conteneur : tout appel réseau sortant est capté et compté, et un refus ne doit en faire aucun.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/profiles/profiles_test.py"
"""
import asyncio
import os
import sqlite3
import sys
import tempfile
import threading
import time
import typing
import uuid
from pathlib import Path

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import bcrypt  # noqa: E402
import httpx  # noqa: E402
from fastapi.routing import APIRoute, APIWebSocketRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

# --- Aucun appel ne sort : ni lanceur, ni conteneur, ni fournisseur ----------------------------------------------------
touched: list[str] = []  # tout ce qui aurait touché une machine, un conteneur ou le fournisseur
upstream_cost = {"value": 0.0}


def outside(request: httpx.Request) -> httpx.Response:
    touched.append(str(request.url))
    if request.url.path.endswith("chat/completions"):
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": upstream_cost["value"]}})
    return httpx.Response(200, json={})


class Sandbox(httpx.AsyncClient):
    def __init__(self, *a, **k):
        k["transport"] = httpx.MockTransport(outside)
        super().__init__(*a, **k)


httpx.AsyncClient = Sandbox

from apollo import access, auth, db, desktop, handoff, hermes, machine, main, media, profiles, push, relay, updates, watch  # noqa: E402, F401

app = main.app
OLD_DIR = db.DATA_DIR


# --- 1. Une installation d'avant les profils ne perd rien, ni données ni accès ------------------------------------------
OLD_SCHEMA = """
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash BLOB NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE usage (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL, cost REAL NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
"""


def test_migration() -> None:
    old = Path(tempfile.mkdtemp())
    pw = bcrypt.hashpw(b"ancien-mot-de-passe", bcrypt.gensalt(4))
    raw = sqlite3.connect(old / "apollo.db")
    raw.executescript(OLD_SCHEMA)
    raw.execute("INSERT INTO users (id, username, pw_hash) VALUES (7, 'ancien', ?)", (pw,))
    raw.execute("INSERT INTO users (id, username, pw_hash) VALUES (9, 'second', ?)", (pw,))
    raw.execute("INSERT INTO sessions VALUES (?, 7, '2099-01-01T00:00:00+00:00')", (auth.digest("jeton-ancien"),))
    for agent_id, name in (("vieux-1", "Vieux un"), ("vieux-2", "Vieux deux")):
        raw.execute("INSERT INTO agents (id, name, api_key) VALUES (?, ?, 'k')", (agent_id, name))
        raw.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost) VALUES (?, 'm', 1, 1, 0.5)", (agent_id,))
    raw.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost) VALUES ('supprime', 'm', 1, 1, 0.25)")
    raw.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c1', 7, 'vieux-1', 'Mes notes')")
    raw.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c1', 'user', 'mot gardé')")
    raw.commit()
    raw.close()
    db.DATA_DIR = old
    try:
        db.init()
        db.init()  # deuxième démarrage : rien ne bouge, rien ne casse
        with db.connect() as c:
            roles = {r["username"]: r["role"] for r in c.execute("SELECT username, role FROM users")}
            assert roles == {"ancien": "owner", "second": "member"}, roles
            owners = {r["owner_id"] for r in c.execute("SELECT owner_id FROM agents")}
            assert owners == {7}, owners
            assert {r["owner_id"] for r in c.execute("SELECT owner_id FROM usage")} == {7}
            assert c.execute("SELECT COUNT(*) FROM agents").fetchone()[0] == 2
            assert c.execute("SELECT text FROM messages").fetchone()["text"] == "mot gardé"
            assert c.execute("SELECT shared FROM conversations").fetchone()["shared"] == 0, "visible par défaut"
        assert auth.check_password("ancien", "ancien-mot-de-passe") == 7
        web = TestClient(app, headers={"Authorization": "Bearer jeton-ancien"}, raise_server_exceptions=False)
        assert web.get("/api/me").json()["role"] == "owner"
        assert web.get("/api/conversations/c1/messages").json()[0]["text"] == "mot gardé"
        assert len(TestClient(app, headers={"Authorization": "Bearer jeton-ancien"}).get("/api/agents").json()) == 2
        # Deuxième propriétaire impossible, même par erreur.
        try:
            with db.connect() as c:
                c.execute("UPDATE users SET role = 'owner' WHERE id = 9")
            raise AssertionError("deux propriétaires acceptés")
        except sqlite3.IntegrityError:
            pass
    finally:
        db.DATA_DIR = OLD_DIR
    print("1. migration : premier compte propriétaire, agents et dépenses à lui, données et session gardées, relançable")


# --- Base de travail et comptes -----------------------------------------------------------------------------------------
db.init()
watch.init()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
LEA = auth.create_user("lea", "motdepasse-l")
UMA = auth.create_user("uma", "motdepasse-u")
ADA = auth.create_user("ada", "motdepasse-d")
ZED = auth.create_user("zed", "motdepasse-z")
db.set_setting("provider", "openrouter")
db.set_setting("model", "modele-de-base")
db.set_setting("api_key", "CLE-DU-FOURNISSEUR", secret=True)
db.set_setting("onboarded", "1")


def client(user: int) -> TestClient:
    return TestClient(app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


ACTORS = {"bruno": (BRUNO, 0), "lea": (LEA, 1), "uma": (UMA, 2), "ada": (ADA, 3), "alice": (ALICE, 4)}
WEB = {name: client(uid) for name, (uid, _) in ACTORS.items()}
LEVEL = {"lecture": 1, "usage": 2, "admin": 3, "proprietaire": 4, "auteur": 4}

A, B = "agent-alice", "agent-bruno"
CA, CB = "conv-alice", "conv-bruno"
WID, CALL, HANDOFF, RID, RUN = "veille-alice", "appel-alice", "prise-en-main", "demande-alice", "tache-alice"
AUDIO = "0123456789abcdef0123"
SECRET_A, SECRET_B = "SECRET-ALICE", "SECRET-BRUNO"


class FakeFuture:
    def done(self):
        return False

    def set_result(self, _):
        pass


stopped: list[str] = []
started: list[dict] = []
pushes: list[dict] = []


async def fake_start(agent, text, session_id):
    touched.append(f"run:{agent.id}")
    started.append({"agent": agent.id, "text": text, "session": session_id})
    return uuid.uuid4().hex


# Comportement du run simulé : par défaut il finit tout de suite ; les tests de révocation le font durer.
run_behaviour = {"mode": "fini", "events": []}
stop_signal: list[asyncio.Event] = []


async def fake_events(agent, run_id):
    for kind, data in run_behaviour["events"]:
        yield kind, data
    if run_behaviour["mode"] == "bavard":
        for _ in range(3000):
            yield "message.delta", {"delta": "."}
            await asyncio.sleep(0.05)
    elif run_behaviour["mode"] == "muet":
        await asyncio.sleep(60)
    yield "message.delta", {"delta": "ok"}
    yield "run.completed", {}


async def fake_stop(agent, run_id):
    touched.append(f"stop:{agent.id}")
    stopped.append(run_id)


async def fake_answer(agent, *a):
    touched.append(f"accord:{agent.id}")


async def fake_create(agent_id):
    return "cle-du-conteneur"


deleted_containers: list[str] = []


async def fake_delete(agent_id):
    touched.append(f"supprime:{agent_id}")
    deleted_containers.append(agent_id)


async def nothing(*a, **k):
    touched.append("machine")
    return {}


hermes.start_run, hermes.run_events, hermes.stop_run, hermes.answer_approval = fake_start, fake_events, fake_stop, fake_answer
hermes.create_container, hermes.delete_container = fake_create, fake_delete
hermes.recreate_container = hermes.configure = hermes.ensure_browser = hermes.restart = nothing
main._browser_wake = main._browser_restart = nothing  # leur vraie boucle attend un écran pendant 15 s
handoff._ensure_keeper = lambda agent_id: None  # gardien du mode privé : testé par keeper_test
updates.install = updates.resolve = updates.check = nothing
updates.blocked = lambda: asyncio.sleep(0, None)
push.notify = lambda title, text, url="/", urgent=False, user_id=None: pushes.append(
    {"title": title, "text": text, "urgent": urgent, "user": user_id})


def fixture() -> None:
    """Remet les données d'alice en place : les routes qui suppriment doivent pouvoir réussir, à chaque essai."""
    now = time.time()
    with db.connect() as c:
        c.execute("INSERT OR IGNORE INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (A, SECRET_A, ALICE))
        c.execute("UPDATE agents SET name = ?, owner_id = ? WHERE id = ?", (SECRET_A, ALICE, A))
        c.execute("INSERT OR IGNORE INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (B, SECRET_B, BRUNO))
        c.execute("INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title, main) VALUES (?, ?, ?, ?, 1)", (CA, ALICE, A, f"Titre {SECRET_A}"))
        c.execute("INSERT OR IGNORE INTO conversations (id, user_id, agent_id, title, main) VALUES (?, ?, ?, ?, 1)", (CB, BRUNO, B, f"Titre {SECRET_B}"))
        c.execute("UPDATE conversations SET shared = 0, archived = 0 WHERE id IN (?, ?)", (CA, CB))
        if not c.execute("SELECT 1 FROM messages WHERE conversation_id = ?", (CA,)).fetchone():
            c.execute("INSERT INTO messages (conversation_id, role, text) VALUES (?, 'user', ?)", (CA, f"message {SECRET_A}"))
        c.execute("INSERT OR IGNORE INTO watches (id, agent_id, name, url) VALUES (?, ?, 'Veille', 'https://example.org')", (WID, A))
        c.execute("INSERT OR IGNORE INTO mcp_tools (agent_id, nom, url, auth) VALUES (?, 'notion', 'https://93.184.216.34/mcp', 'aucune')", (A,))
        c.execute("INSERT OR REPLACE INTO voice_calls (id, agent_id, user_id, conversation_id, texte, etat, created_at) "
                  "VALUES (?, ?, ?, ?, ?, 'sonne', ?)", (CALL, A, ALICE, CA, f"rappel {SECRET_A}", now))
        c.execute("DELETE FROM agent_shares WHERE agent_id = ?", (A,))
        c.executemany("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, ?)",
                      [(A, LEA, "lecture"), (A, UMA, "usage"), (A, ADA, "admin"), (A, ZED, "lecture")])
    handoff._calls[A] = {"id": HANDOFF, "message": "Connecte-toi", "depuis": now, "origine": "agent", "attente": FakeFuture(), "attentifs": 1}
    desktop._waiting[RID] = (FakeFuture(), ALICE)
    media.drop_stream(AUDIO)
    stream = media.audio_stream(AUDIO)
    stream.owner = ALICE
    stream.queue.put_nowait(None)


# --- La table de toutes les routes : qui a le droit de quoi -------------------------------------------------------------
# « auteur » : la ressource (conversation, rappel, flux, demande) est à une seule personne, quel que soit son droit sur l'agent.
ROUTES = {
    ("PUT", "/api/agents/{agent_id}/plafond"): "proprietaire",
    ("PUT", "/api/agents/{agent_id}/model"): "admin",
    ("PATCH", "/api/agents/{agent_id}/look"): "admin",
    ("POST", "/api/agents/{agent_id}/repair"): "admin",
    ("PATCH", "/api/agents/{agent_id}"): "admin",
    ("DELETE", "/api/agents/{agent_id}"): "proprietaire",
    ("GET", "/api/agents/{agent_id}/conversations"): "lecture",
    ("POST", "/api/conversations/{conv_id}/archive"): "auteur",
    ("GET", "/api/conversations/{conv_id}/messages"): "auteur",
    ("DELETE", "/api/conversations/{conv_id}"): "auteur",
    ("POST", "/api/conversations/{conv_id}/partage"): "auteur",
    ("POST", "/api/chat"): "usage",
    ("POST", "/api/agents/{agent_id}/apercu"): "usage",
    ("POST", "/api/agents/{agent_id}/runs/{run_id}/approval"): "usage",
    ("POST", "/api/agents/{agent_id}/runs/{run_id}/stop"): "usage",
    ("GET", "/api/agents/{agent_id}/media"): "usage",
    ("GET", "/api/agents/{agent_id}/files"): "usage",
    ("GET", "/api/agents/{agent_id}/files/raw/{path:path}"): "usage",
    ("POST", "/api/agents/{agent_id}/upload"): "usage",
    ("GET", "/api/agents/{agent_id}/screen-url"): "admin",
    ("POST", "/api/agents/{agent_id}/clipboard/paste"): "admin",
    ("GET", "/api/agents/{agent_id}/clipboard/copy"): "admin",
    ("GET", "/api/agents/{agent_id}/screen-status"): "admin",
    ("POST", "/api/agents/{agent_id}/browser/wake"): "admin",
    ("POST", "/api/agents/{agent_id}/browser/cookies"): "admin",
    ("POST", "/api/agents/{agent_id}/browser/restart"): "admin",
    ("GET", "/api/agents/{agent_id}/screen/{path:path}"): "admin",
    ("POST", "/api/voice/transcribe"): "usage",
    ("POST", "/api/voice/speak"): "usage",
    ("POST", "/api/voice/say"): "usage",
    ("POST", "/api/voice/reply"): "usage",
    ("POST", "/api/voice/prepare"): "usage",
    ("GET", "/api/voice/audio/{audio_id}"): "auteur",
    ("POST", "/api/voice/cancel/{audio_id}"): "auteur",
    ("GET", "/api/agents/{agent_id}/computer"): "admin",
    ("POST", "/api/agents/{agent_id}/install"): "admin",
    ("GET", "/api/agents/{agent_id}/memory"): "admin",
    ("PUT", "/api/agents/{agent_id}/memory"): "admin",
    ("GET", "/api/agents/{agent_id}/routines"): "admin",
    ("POST", "/api/agents/{agent_id}/routines"): "admin",
    ("POST", "/api/agents/{agent_id}/routines/{routine_id}/{action}"): "admin",
    ("GET", "/api/agents/{agent_id}/connections"): "admin",
    ("POST", "/api/agents/{agent_id}/connections/apps/{name}/{action}"): "admin",
    ("POST", "/api/agents/{agent_id}/connections/tools/test"): "admin",
    ("POST", "/api/agents/{agent_id}/connections/tools"): "admin",
    ("PUT", "/api/agents/{agent_id}/connections/tools/{name}/droit"): "admin",
    ("POST", "/api/agents/{agent_id}/connections/tools/{name}/{action}"): "admin",
    ("GET", "/api/agents/{agent_id}/folders"): "admin",
    ("PUT", "/api/agents/{agent_id}/folders"): "proprietaire",  # et rôle owner : c'est son ordinateur (voir test_secrets)
    ("GET", "/api/agents/{agent_id}/google"): "admin",
    ("POST", "/api/agents/{agent_id}/google/connect"): "admin",
    ("POST", "/api/agents/{agent_id}/google/cancel"): "admin",
    ("POST", "/api/agents/{agent_id}/google/disconnect"): "admin",
    ("GET", "/api/agents/{agent_id}/watches"): "admin",
    ("POST", "/api/agents/{agent_id}/watches"): "admin",
    ("POST", "/api/agents/{agent_id}/watches/{wid}/{action}"): "admin",
    ("GET", "/api/agents/{agent_id}/appel"): "lecture",
    ("POST", "/api/agents/{agent_id}/appel/{call_id}"): "admin",
    ("GET", "/api/calls/{call_id}"): "auteur",
    ("POST", "/api/calls/{call_id}/answer"): "auteur",
    ("POST", "/api/calls/{call_id}/decline"): "auteur",
    ("POST", "/api/desktop/result/{rid}"): "auteur",
    ("GET", "/api/agents/{agent_id}/shares"): "proprietaire",
    ("PUT", "/api/agents/{agent_id}/shares"): "proprietaire",
    ("DELETE", "/api/agents/{agent_id}/shares/{user_id}"): "proprietaire",
}
FILL = {"agent_id": A, "conv_id": CA, "run_id": RUN, "routine_id": "routine-1", "name": "notion", "wid": WID, "audio_id": AUDIO,
        "rid": RID, "user_id": str(ZED), "path:path": "index.html"}
BODIES = {
    "/api/chat": lambda: {"agent_id": A, "text": "bonjour"},
    "/api/agents/{agent_id}/apercu": lambda: {"path": "apps/x/index.html"},
    "/api/agents/{agent_id}/plafond": lambda: {"daily": 1},
    "/api/agents/{agent_id}/model": lambda: {"model": None},
    "/api/agents/{agent_id}/look": lambda: {"color": "#112233"},
    "/api/agents/{agent_id}": lambda: {"name": SECRET_A, "role": "Son rôle"},
    "/api/conversations/{conv_id}/archive": lambda: {"archived": False},
    "/api/conversations/{conv_id}/partage": lambda: {"partagee": False},
    "/api/agents/{agent_id}/runs/{run_id}/approval": lambda: {"request_id": "r", "generation": 1, "approve": True},
    "/api/agents/{agent_id}/clipboard/paste": lambda: {"texte": "x"},
    "/api/agents/{agent_id}/browser/cookies": lambda: {"cookies": '[{"name": "a", "domain": "b.example", "value": "c"}]'},
    "/api/voice/speak": lambda: {"text": "x", "agent_id": A},
    "/api/voice/say": lambda: {"text": "x", "agent_id": A, "audio_id": uuid.uuid4().hex},
    "/api/voice/prepare": lambda: {"agent_id": A},
    "/api/voice/reply": lambda: {"text": "x", "agent_id": A, "audio_id": uuid.uuid4().hex},
    "/api/agents/{agent_id}/install": lambda: {"paquets": ["cowsay"]},
    "/api/agents/{agent_id}/memory": lambda: {"cible": "memory", "entrees": []},
    "/api/agents/{agent_id}/routines": lambda: {"consigne": "x", "quand": "every day"},
    "/api/agents/{agent_id}/connections/tools/test": lambda: {"url": "https://93.184.216.34/mcp"},
    "/api/agents/{agent_id}/connections/tools": lambda: {"url": "https://93.184.216.34/mcp", "nom": "essai"},
    "/api/agents/{agent_id}/connections/tools/{name}/droit": lambda: {"droit": "agir"},
    "/api/agents/{agent_id}/folders": lambda: {"dossiers": []},
    "/api/agents/{agent_id}/google/connect": lambda: {"permissions": [next(iter(__import__("apollo.accounts").accounts.PERMS))]},
    "/api/agents/{agent_id}/watches": lambda: {"nom": "n", "url": "https://example.org"},
    "/api/agents/{agent_id}/appel/{call_id}": lambda: {"reponse": "impossible"},
    "/api/agents/{agent_id}/shares": lambda: {"utilisateur": "zed", "droit": "lecture", "compris": True},
    "/api/desktop/result/{rid}": lambda: {},
}
QUERIES = {"/api/agents/{agent_id}/media": {"path": "/x.png"}, "/api/agents/{agent_id}/upload": {"name": "x.txt"}, "/api/voice/transcribe": {"agent_id": A}}

# Routes avec un identifiant qui n'appartient à aucun agent. Chacune a sa raison et, quand c'est possible, sa vérification.
WHITELIST = {
    ("GET", "/api/apercu/{token}/{path:path}"): "Sans session : le lien signé porte le compte, le dossier et l'expiration, et suit les droits (apercu_test).",
    ("POST", "/api/chat/ensuite"): "Mêmes droits que /api/chat : agent utilisable et conversation à ce compte (ensuite_test).",
    ("GET", "/api/pairing/flow/{public}"): "Demande d'appairage : identifiant aléatoire ; le premier compte qui la voit en devient le seul titulaire (vérifié par test_personal et pairing_test).",
    ("POST", "/api/pairing/flow/{public}/{decision}"): "Même titulaire exigé pour accepter ou refuser ; le nombre à recopier protège le reste (pairing_test).",
    ("DELETE", "/api/devices/{device_id}"): "Filtré par compte dans auth.revoke_device : un appareil d'un autre compte rend 404 (vérifié par test_personal).",
    ("PATCH", "/api/profiles/{profile_id}"): "Réservé au rôle owner (vérifié par OWNER_ROUTES).",
    ("DELETE", "/api/profiles/{profile_id}"): "Réservé au rôle owner (vérifié par OWNER_ROUTES et test_profiles).",
}

# Routes sans identifiant : la configuration globale, refusée à un profil…
OWNER_ROUTES = {
    ("POST", "/api/setup/done"): None,
    ("POST", "/api/model"): {"provider": "openrouter", "api_key": "CLE-DU-FOURNISSEUR", "model": "modele-de-base"},
    ("POST", "/api/budget"): {"monthly": None},
    ("GET", "/api/flux"): None,
    ("GET", "/api/media"): None,
    ("POST", "/api/media"): {"kind": "image", "model": "auto"},
    ("POST", "/api/media/key"): {"api_key": "CLE-DE-MEDIAS"},
    ("GET", "/api/diagnostic"): None,
    ("GET", "/api/voice/server"): None,
    ("POST", "/api/voice/server"): {"base_url": "http://voix.exemple/v1", "api_key": "CLE-DE-VOIX", "speech_model": "m"},
    ("POST", "/api/google/client"): {"fichier": '{"installed": {"client_id": "1-a.apps.googleusercontent.com", "client_secret": "secret"}}'},
    ("GET", "/api/updates"): None,
    ("POST", "/api/updates/check"): None,
    ("POST", "/api/updates/install"): None,
    ("POST", "/api/updates/skip"): None,
    ("POST", "/api/updates/resolve"): {"action": "garder"},
    ("POST", "/api/updates/postpone"): None,
    ("PUT", "/api/updates/settings"): {"auto": True},
    ("GET", "/api/profiles"): None,
    ("POST", "/api/profiles"): {"username": "nouveau-essai", "password": "motdepasse-n"},
    ("GET", "/api/mcp/reseaux"): None,
    ("PUT", "/api/mcp/reseaux"): {"reseaux": []},
}
OWNER_WITH_ID = {("PATCH", "/api/profiles/{profile_id}"): {"budget": None}, ("DELETE", "/api/profiles/{profile_id}"): None}
# … et les routes ouvertes, chacune avec la raison pour laquelle elle ne montre rien d'un autre.
OPEN_ROUTES = {
    ("GET", "/api/status"): "Publique : aucune donnée de compte.",
    ("POST", "/api/setup/check"): "Publique : refusée dès qu'un compte existe.",
    ("POST", "/api/setup/restore"): "Refusée dès qu'un compte existe (code d'installation).",
    ("GET", "/api/setup/restore"): "Avancement de la restauration, sans donnée de compte.",
    ("POST", "/api/setup/account"): "Premier compte seulement (410 ensuite, vérifié par test_profiles).",
    ("POST", "/api/pairing"): "Code de ce compte.",
    ("DELETE", "/api/pairing"): "Code de ce compte.",
    ("GET", "/api/pairing/pending"): "Demandes dont ce compte est le titulaire.",
    ("POST", "/api/pairing/claim"): "Sans session : le code donne une demande, à accepter par son titulaire.",
    ("POST", "/api/pairing/flow"): "Sans session : crée une demande sans titulaire.",
    ("POST", "/api/pairing/flow/poll"): "Sans session : le jeton de sondage est le secret.",
    ("POST", "/api/login"): "Publique.",
    ("POST", "/api/logout"): "Sa propre session.",
    ("GET", "/api/devices"): "Appareils de ce compte (filtre par user_id).",
    ("DELETE", "/api/devices/self"): "Sa propre session.",
    ("POST", "/api/devices/others/revoke"): "Autres sessions de ce compte.",
    ("GET", "/api/me"): "Ce compte.",
    ("POST", "/api/me/password"): "Ce compte, avec son mot de passe actuel.",
    ("GET", "/api/providers"): "Liste statique des fournisseurs connus, sans clé.",
    ("POST", "/api/models"): "Un profil ne lit que le fournisseur en service, sans adresse ni clé à lui (vérifié par test_secrets).",
    ("GET", "/api/usage"): "Filtrée par profil (vérifié par test_lists).",
    ("GET", "/api/model"): "Le nom du cerveau, sans clé ni adresse pour un profil (vérifié par test_secrets).",
    ("GET", "/api/voice/ready"): "Une raison de refus, sans clé ni adresse ; un profil ne lit qu'une phrase générale (cle_refusee_test).",
    ("GET", "/api/agents"): "Filtrée par droit (vérifié par test_lists).",
    ("POST", "/api/agents"): "L'agent créé est à ce compte (vérifié par test_budget).",
    ("GET", "/api/calls/pending"): "Filtrée par compte et par droit (vérifié par test_lists).",
    ("GET", "/api/calls/wait"): "Même lecture que /api/calls/pending, en attente longue.",
    ("GET", "/api/desktop/next"): "File de ce compte (vérifié par test_desktop).",
    ("GET", "/api/desktop/status"): "État de l'application de bureau de ce compte (vérifié par test_desktop).",
    ("GET", "/api/health/stream"): "Contrôle technique, sans donnée.",
    ("GET", "/api/push/key"): "Clé publique du serveur.",
    ("POST", "/api/push/subscription"): "Abonnement de cette session.",
    ("DELETE", "/api/push/subscription"): "Abonnement de cette session.",
    ("GET", "/api/push/subscription"): "Abonnement de cette session.",
    ("POST", "/api/push/test"): "Envoi à cette session.",
    ("GET", "/api/tls-ask"): "Publique (Caddy) : répond oui ou non pour un nom de ce serveur.",
    ("GET", "/api/public"): "Publique : l'adresse du serveur.",
}
# Noms qui désignent une ressource où qu'ils soient dans la requête : chemin, adresse ou corps.
SENSITIVE = {"agent_id", "agent", "conv_id", "conversation_id", "call_id", "routine_id", "wid", "watch_id", "run_id", "rid", "audio_id",
             "device_id", "profile_id", "user_id", "public", "id"}


def _model_of(annotation) -> list[type[BaseModel]]:
    args = typing.get_args(annotation) or (annotation,)
    return [a for a in args if isinstance(a, type) and issubclass(a, BaseModel)]


def takes_an_id(route: APIRoute) -> bool:
    dep = route.dependant
    names = {p.name for p in dep.path_params} | {p.name for p in dep.query_params}
    for field in dep.body_params:
        for model in _model_of(field.field_info.annotation):
            names |= set(model.model_fields)
    return bool(dep.path_params) or bool(names & SENSITIVE)


def api_routes() -> list[tuple[str, str, APIRoute]]:
    out = []
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/"):
            out += [(m, route.path, route) for m in sorted(route.methods) if m != "HEAD"]
    return out


def test_every_route_is_declared() -> None:
    missing, stale, seen = [], [], set()
    for method, path, route in api_routes():
        key = (method, path)
        seen.add(key)
        if takes_an_id(route):
            if key not in ROUTES and key not in WHITELIST:
                missing.append(key)
        elif key not in OWNER_ROUTES and key not in OPEN_ROUTES:
            missing.append(key)
    for key in [*ROUTES, *WHITELIST, *OWNER_ROUTES, *OPEN_ROUTES, *OWNER_WITH_ID]:
        if key not in seen:
            stale.append(key)
    assert not missing, f"Routes ni couvertes ni justifiées : {missing}"
    assert not stale, f"Routes déclarées qui n'existent plus : {stale}"
    assert all(reason for reason in [*WHITELIST.values(), *OPEN_ROUTES.values()]), "exception sans raison"
    sockets = [r.path for r in app.routes if isinstance(r, APIWebSocketRoute) and r.path.startswith("/api/")]
    assert sockets == ["/api/agents/{agent_id}/screen/websockify"], f"nouveau WebSocket à couvrir : {sockets}"
    print(f"2. {len(seen)} routes /api/ énumérées : {len(ROUTES)} par droit, {len(OWNER_ROUTES) + len(OWNER_WITH_ID)} réservées au propriétaire, "
          f"{len(WHITELIST)} en liste blanche, {len(OPEN_ROUTES)} ouvertes avec leur raison")


def call(web: TestClient, method: str, path: str):
    url = path
    for name, value in FILL.items():
        url = url.replace("{" + name + "}", value)
    action = {"routines": "pause", "connections": "remove", "watches": "pause"}
    for key, verb in action.items():
        if f"/{key}/" in path:
            url = url.replace("{action}", verb)
    url = url.replace("{call_id}", HANDOFF if "/appel/" in path else CALL)
    assert "{" not in url, url
    kw = {}
    if method != "GET" and path in BODIES and not (method == "DELETE"):
        kw["json"] = BODIES[path]()
    elif path == "/api/voice/transcribe":
        kw["content"] = b"audio"
    if path in QUERIES:
        kw["params"] = QUERIES[path]
    return web.request(method, url, **kw)


def test_isolation_on_every_route() -> None:
    checked = 0
    for (method, path), needed in ROUTES.items():
        for name, (uid, level) in ACTORS.items():
            fixture()
            main._runs[RUN] = {"agent": A, "user": uid}
            touched.clear()
            r = call(WEB[name], method, path)
            where = f"{method} {path} par {name} : {r.status_code} {r.text[:160]}"
            if level >= LEVEL[needed]:
                assert r.status_code not in (401, 403, 404, 405, 422), f"refusé à tort : {where}"
            else:
                assert r.status_code in (403, 404), f"fuite : {where}"
                assert not touched, f"refusé, mais a quand même touché {touched} : {where}"
                assert SECRET_A not in r.text, where
                if name == "bruno":
                    assert r.status_code == 404, f"un agent invisible doit rendre 404 : {where}"
            checked += 1
    main._runs.pop(RUN, None)
    # 403 quand l'agent est visible et que le droit manque, 404 quand il est invisible.
    fixture()
    assert WEB["lea"].post("/api/chat", json={"agent_id": A, "text": "x"}).status_code == 403
    assert WEB["uma"].delete(f"/api/agents/{A}").status_code == 403
    assert WEB["bruno"].delete(f"/api/agents/{A}").status_code == 404
    print(f"3. {checked} essais : chaque profil reçoit 403 ou 404 sous son droit, sans rien toucher ; au-dessus, il passe")


def test_owner_routes() -> None:
    for (method, path), body in OWNER_ROUTES.items():
        fixture()
        touched.clear()
        r = WEB["bruno"].request(method, path, **({"json": body} if body is not None else {}))
        assert r.status_code == 403, f"{method} {path} ouvert à un profil : {r.status_code} {r.text[:120]}"
        assert not touched, f"{method} {path} : refusé mais a touché {touched}"
        ok = WEB["alice"].request(method, path, **({"json": body} if body is not None else {}))
        assert ok.status_code not in (401, 403, 404, 405, 422), f"{method} {path} refusé au propriétaire : {ok.status_code} {ok.text[:160]}"
    with db.connect() as c:
        c.execute("DELETE FROM users WHERE username = 'nouveau-essai'")
    for (method, path), body in OWNER_WITH_ID.items():
        url = path.replace("{profile_id}", str(ZED))
        r = WEB["ada"].request(method, url, **({"json": body} if body is not None else {}))
        assert r.status_code == 403 and auth.check_password("zed", "motdepasse-z") == ZED, f"{method} {path} : {r.status_code}"
    # Un profil ne se sert pas du serveur pour essayer une adresse ou une clé.
    assert WEB["bruno"].post("/api/models", json={"provider": "openrouter", "base_url": "http://interne:9000/v1"}).status_code == 403
    assert WEB["bruno"].post("/api/models", json={"provider": "openrouter", "api_key": "autre"}).status_code == 403
    assert WEB["bruno"].post("/api/models", json={"provider": "gemini"}).status_code == 403
    print("4. configuration globale (fournisseur, clé, budget global, mises à jour, flux, profils) : 403 pour un profil, ouverte au propriétaire")


def test_lists() -> None:
    fixture()
    with db.connect() as c:
        c.execute("DELETE FROM usage")
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, owner_id) VALUES (?, 'modele-a', 1, 1, 3.5, ?)", (A, ALICE))
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, conversation_id, owner_id) "
                  "VALUES (?, 'modele-a', 1, 1, 1.5, ?, ?)", (A, CA, ALICE))
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, conversation_id, owner_id) "
                  "VALUES (?, 'modele-b', 1, 1, 0.25, ?, ?)", (B, CB, BRUNO))
    bruno, alice = WEB["bruno"], WEB["alice"]
    for path in ("/api/agents", "/api/usage", "/api/calls/pending", f"/api/agents/{B}/conversations", "/api/devices"):
        r = bruno.get(path)
        assert r.status_code == 200, path
        assert SECRET_A not in r.text and A not in r.text and CA not in r.text and "3.5" not in r.text, f"{path} : {r.text[:300]}"
    for path in ("/api/agents", "/api/usage", "/api/flux", "/api/calls/pending", f"/api/agents/{A}/conversations"):
        r = alice.get(path)
        assert r.status_code == 200, path
        assert SECRET_B not in r.text and B not in r.text and CB not in r.text, f"{path} : {r.text[:300]}"
    assert bruno.get("/api/flux").status_code == 403
    mine = bruno.get("/api/usage").json()
    assert mine["month_cost"] == 0.25 and [a["agent_id"] for a in mine["agents"]] == [B], mine
    assert list(mine["today"]) == [B] and mine["budget"] is None, mine
    total = alice.get("/api/usage").json()
    assert total["month_cost"] == 5.25, "le propriétaire voit le total de ce qu'il paie"
    assert [a["agent_id"] for a in total["agents"]] == [A], total["agents"]
    # Une tâche de fond d'un autre agent ne remonte pas chez bruno (le filtre d'avant la laissait passer).
    assert all(t["agent_id"] == B for t in mine["tasks"]), mine["tasks"]
    # Sur un agent partagé : ce qu'on y a soi-même dépensé, rien de son propriétaire, et plus rien après la révocation.
    uma = WEB["uma"]
    assert uma.post("/api/chat", json={"agent_id": A, "text": "x"}).status_code == 200
    own = [c for c in uma.get(f"/api/agents/{A}/conversations").json() if c["main"]][0]["id"]
    with db.connect() as c:
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, conversation_id, owner_id) "
                  "VALUES (?, 'modele-a', 1, 1, 0.75, ?, ?)", (A, own, ALICE))
    hers = uma.get("/api/usage").json()
    assert [(a["agent_id"], a["cost"]) for a in hers["agents"]] == [(A, 0.75)] and hers["month_cost"] == 0, hers
    assert "3.5" not in uma.get("/api/usage").text and [t["conversation_id"] for t in hers["tasks"]] == [own], hers
    assert alice.get("/api/usage").json()["month_cost"] == 6.0, "la dépense d'un partage va au propriétaire de l'agent"
    assert own not in [t["conversation_id"] for t in alice.get("/api/usage").json()["tasks"]], "alice voit une tâche d'uma"
    alice.delete(f"/api/agents/{A}/shares/{UMA}")
    assert uma.get("/api/usage").json()["agents"] == [], "dépense visible après la révocation"
    print("5. listes (agents, usage, flux, conversations, appels) : pas une donnée de l'autre profil")


def test_personal() -> None:
    fixture()
    alice_devices = WEB["alice"].get("/api/devices").json()["appareils"]
    assert WEB["bruno"].delete(f"/api/devices/{alice_devices[0]['id']}").status_code == 404
    assert len(WEB["alice"].get("/api/devices").json()["appareils"]) == len(alice_devices)
    flow = TestClient(app).post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"}).json()
    public = flow["adresse"].split("autoriser=")[1]
    assert WEB["alice"].get(f"/api/pairing/flow/{public}").status_code == 200
    assert WEB["bruno"].get(f"/api/pairing/flow/{public}").status_code == 404, "demande d'appairage vue par un autre compte"
    assert WEB["bruno"].post(f"/api/pairing/flow/{public}/refuser", json={}).status_code == 404
    print("6. liste blanche vérifiée : appareils et demandes d'appairage restent à leur compte")


def test_rights() -> None:
    fixture()
    lea, uma, ada, alice = WEB["lea"], WEB["uma"], WEB["ada"], WEB["alice"]
    # Lecture : voit l'agent et seulement ce qui est rendu visible, sans écrire.
    assert A in [a["id"] for a in lea.get("/api/agents").json()]
    assert [a["droit"] for a in lea.get("/api/agents").json() if a["id"] == A] == ["lecture"]
    assert lea.get(f"/api/conversations/{CA}/messages").status_code == 404, "conversation lisible sans que son auteur l'ait décidé"
    assert CA not in lea.get(f"/api/agents/{A}/conversations").text
    assert alice.post(f"/api/conversations/{CA}/partage", json={"partagee": True}).status_code == 200
    assert lea.get(f"/api/conversations/{CA}/messages").status_code == 200
    seen = [c for c in lea.get(f"/api/agents/{A}/conversations").json() if c["id"] == CA]
    assert seen and seen[0]["de"] == "alice" and seen[0]["main"] is False, seen
    assert lea.post(f"/api/conversations/{CA}/archive", json={"archived": True}).status_code == 403
    assert lea.delete(f"/api/conversations/{CA}").status_code == 403
    assert lea.post("/api/chat", json={"agent_id": A, "text": "x", "conversation_id": CA}).status_code == 403
    assert lea.get(f"/api/agents/{A}/files").status_code == 403
    assert uma.post("/api/chat", json={"agent_id": A, "text": "x", "conversation_id": CA}).status_code == 404, "écrit chez alice"
    alice.post(f"/api/conversations/{CA}/partage", json={"partagee": False})
    # Usage : parle dans SA conversation, jamais dans celle d'alice. L'agent sait à qui il parle.
    started.clear()
    before = alice.get(f"/api/conversations/{CA}/messages").json()
    r = uma.post("/api/chat", json={"agent_id": A, "text": "Bonjour, ici Uma"})
    assert r.status_code == 200 and '"status": "completed"' in r.text, r.text
    assert alice.get(f"/api/conversations/{CA}/messages").json() == before, "le message d'uma est arrivé chez alice"
    convs = uma.get(f"/api/agents/{A}/conversations").json()
    own = [c for c in convs if c["main"]]
    assert len(own) == 1 and own[0]["id"] != CA and own[0]["de"] is None, convs
    assert "Bonjour, ici Uma" in uma.get(f"/api/conversations/{own[0]['id']}/messages").text
    assert alice.get(f"/api/conversations/{own[0]['id']}/messages").status_code == 404, "alice lit la conversation d'uma"
    assert ada.get(f"/api/conversations/{own[0]['id']}/messages").status_code == 404, "un admin lit la conversation d'uma"
    alice.post("/api/chat", json={"agent_id": A, "text": "Bonjour, ici Alice"})
    assert len(started) == 2 and started[0]["session"] != started[1]["session"], "même session Hermes pour deux personnes"
    assert "uma" in started[0]["text"] and "alice" not in started[0]["text"], started[0]["text"]
    assert "alice" in started[1]["text"], started[1]["text"]
    # Une tâche d'alice : uma ne l'arrête pas et n'y répond pas.
    main._runs[RUN] = {"agent": A, "user": ALICE}
    touched.clear()
    assert uma.post(f"/api/agents/{A}/runs/{RUN}/stop").status_code == 403 and not touched
    assert uma.post(f"/api/agents/{A}/runs/{RUN}/approval", json={"request_id": "r", "generation": 1, "approve": True}).status_code == 403 and not touched
    assert ada.post(f"/api/agents/{A}/runs/{RUN}/stop").status_code == 200, "un admin règle l'agent"
    main._runs.pop(RUN)
    # Admin : ses réglages, sauf le supprimer ou le repartager, et sauf l'argent de son propriétaire.
    assert ada.patch(f"/api/agents/{A}", json={"name": SECRET_A, "role": "Autre rôle"}).status_code == 200
    assert ada.delete(f"/api/agents/{A}").status_code == 403
    assert ada.put(f"/api/agents/{A}/shares", json={"utilisateur": "bruno", "droit": "lecture", "compris": True}).status_code == 403
    assert ada.delete(f"/api/agents/{A}/shares/{LEA}").status_code == 403
    assert ada.get(f"/api/agents/{A}/shares").status_code == 403
    assert ada.put(f"/api/agents/{A}/plafond", json={"daily": 99}).status_code == 403
    # Partage : l'avertissement est dit, et demandé en retour.
    shares = alice.get(f"/api/agents/{A}/shares").json()
    assert "seule mémoire, un seul navigateur et un seul dossier de travail" in shares["avertissement"]
    assert "comptes connectés et ses dossiers" in shares["avertissement"]
    r = alice.put(f"/api/agents/{A}/shares", json={"utilisateur": "bruno", "droit": "lecture"})
    assert r.status_code == 400 and "seule mémoire" in r.json()["detail"], r.text
    assert alice.put(f"/api/agents/{A}/shares", json={"utilisateur": "alice", "droit": "lecture", "compris": True}).status_code == 400
    assert alice.put(f"/api/agents/{A}/shares", json={"utilisateur": "inconnu", "droit": "lecture", "compris": True}).status_code == 404
    assert alice.put(f"/api/agents/{A}/shares", json={"utilisateur": "bruno", "droit": "maitre", "compris": True}).status_code == 422
    badge = [a for a in alice.get("/api/agents").json() if a["id"] == A][0]
    assert badge["partage"] is True and badge["droit"] == "proprietaire" and badge["partage_par"] is None, badge
    print("7. droits : lecture sans écrire, usage dans sa propre conversation, admin sans supprimer ni repartager ; l'agent sait à qui il parle")


def test_revocation() -> None:
    # À la requête suivante.
    fixture()
    uma, alice = WEB["uma"], WEB["alice"]
    uma.post("/api/chat", json={"agent_id": A, "text": "ma conversation"})
    own = [c for c in uma.get(f"/api/agents/{A}/conversations").json() if c["main"]][0]["id"]
    with db.connect() as c:
        c.execute("INSERT OR REPLACE INTO voice_calls (id, agent_id, user_id, conversation_id, texte, etat, created_at) "
                  "VALUES ('appel-uma', ?, ?, ?, 'pour uma', 'sonne', ?)", (A, UMA, own, time.time()))
    assert "appel-uma" in uma.get("/api/calls/pending").text
    assert alice.delete(f"/api/agents/{A}/shares/{UMA}").status_code == 200
    assert uma.get(f"/api/agents/{A}/conversations").status_code == 404
    assert uma.get(f"/api/conversations/{own}/messages").status_code == 404, "sa conversation doit disparaître avec l'accès"
    assert uma.post("/api/chat", json={"agent_id": A, "text": "x"}).status_code == 404
    assert A not in [a["id"] for a in uma.get("/api/agents").json()]
    assert "appel-uma" not in uma.get("/api/calls/pending").text and uma.get("/api/calls/appel-uma").status_code == 404
    assert alice.delete(f"/api/agents/{A}/shares/{UMA}").status_code == 404
    with db.connect() as c:
        c.execute("DELETE FROM voice_calls WHERE id = 'appel-uma'")

    def scope(token: str) -> Request:
        return Request({"type": "http", "method": "POST", "path": "/api/chat", "query_string": b"", "scheme": "http",
                        "headers": [(b"authorization", f"Bearer {token}".encode())], "client": ("1.1.1.1", 1), "server": ("x", 80)})

    # Flux SSE déjà ouvert : muet (le modèle réfléchit) ou bavard (les deux doivent être coupés en 5 s).
    async def cut(mode: str, act) -> float:
        fixture()
        run_behaviour["mode"] = mode
        stopped.clear()
        token = auth.new_session(UMA, "sse", "web")
        response = await main.chat(main.ChatMessage(agent_id=A, text="longue tâche"), scope(token), None, user=UMA)
        got = []

        async def read():
            async for chunk in response.body_iterator:
                got.append(chunk)

        reader = asyncio.create_task(read())
        await asyncio.sleep(1.1)
        assert got, "le flux ne s'est pas ouvert"
        await act()
        begin = time.monotonic()
        try:
            await asyncio.wait_for(reader, 8)
        except asyncio.TimeoutError:
            raise AssertionError(f"flux {mode} toujours ouvert 8 s après le retrait de l'accès")
        return time.monotonic() - begin

    async def revoke():
        await profiles.revoke_share(A, UMA, user=ALICE)

    async def downgrade():
        await profiles.set_share(A, profiles.Share(utilisateur="uma", droit="lecture", compris=True), user=ALICE)

    async def drop_session():
        auth.revoke_others(UMA, "")

    for mode in ("muet", "bavard"):
        took = asyncio.run(cut(mode, revoke))
        assert took <= 5, f"flux {mode} coupé en {took:.1f} s"
        assert stopped, "sa tâche continue alors que son accès est retiré"
        print(f"8. révocation : flux {mode} coupé en {took:.1f} s, sa tâche arrêtée")
    took = asyncio.run(cut("bavard", downgrade))
    assert took <= 5, f"droit réduit : flux coupé en {took:.1f} s"
    run_behaviour["mode"] = "fini"
    WEB["uma"] = client(UMA)  # sessions intactes jusqu'ici

    # WebSocket de l'écran déjà ouvert.
    class Upstream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def send(self, _):
            pass

        def __aiter__(self):
            return self

        async def __anext__(self):
            await asyncio.sleep(120)
            raise StopAsyncIteration

    main.websockets.connect = lambda *a, **k: Upstream()
    socket = "/api/agents/" + A + "/screen/websockify"

    def refused(web: TestClient) -> bool:
        try:
            with web.websocket_connect(socket):
                return False
        except WebSocketDisconnect as e:
            return e.code == 4401

    fixture()
    for name in ("bruno", "lea", "uma"):
        assert refused(WEB[name]), f"écran ouvert à {name}"
    for revoke_it in (lambda: alice.delete(f"/api/agents/{A}/shares/{ADA}"), lambda: auth.revoke_others(ADA, "")):
        fixture()
        ada = client(ADA)
        closed: dict = {}
        with ada.websocket_connect(socket) as ws:
            def wait():
                try:
                    ws.receive()
                except WebSocketDisconnect:
                    pass
                closed["at"] = time.monotonic()

            watcher = threading.Thread(target=wait, daemon=True)
            watcher.start()
            time.sleep(0.5)
            assert not closed, "écran fermé sans raison"
            revoke_it()
            begin = time.monotonic()
            watcher.join(8)
            assert closed, "écran toujours ouvert 8 s après la révocation"
            took = closed["at"] - begin
            assert took <= 5, f"écran coupé en {took:.1f} s"
            print(f"9. écran déjà ouvert coupé en {took:.1f} s")
    print("9. WebSocket de l'écran : refusé sous le droit admin, coupé en 5 s au plus (partage retiré ou appareil révoqué)")
    WEB["ada"] = client(ADA)


def test_budget() -> None:
    fixture()
    upstream_cost["value"] = 0.06
    alice, bruno = WEB["alice"], WEB["bruno"]
    agent_b = TestClient(app, headers={"Authorization": f"Bearer {relay.token_for(B)}"})
    agent_a = TestClient(app, headers={"Authorization": f"Bearer {relay.token_for(A)}"})
    with db.connect() as c:
        c.execute("DELETE FROM usage")
    ask = lambda agent: agent.post("/relay/v1/chat/completions", json={"model": "m", "messages": []})  # noqa: E731
    assert ask(agent_b).status_code == 200, "aucun plafond : l'appel passe"
    assert alice.patch(f"/api/profiles/{BRUNO}", json={"budget": 0.10}).json()["budget"] == 0.10
    assert bruno.patch(f"/api/profiles/{BRUNO}", json={"budget": 500}).status_code == 403, "un profil lève son propre plafond"
    pushes.clear()
    assert ask(agent_b).status_code == 200  # 0,12 $ : franchi par cet appel
    assert any(p["user"] == BRUNO and p["urgent"] for p in pushes), f"alerte : {pushes}"
    assert not any(p["user"] == ALICE for p in pushes), "l'alerte d'un profil part chez un autre"
    touched.clear()
    r = ask(agent_b)
    assert r.status_code == 402 and "profil" in r.json()["error"]["message"], r.text
    assert not touched, "appel parti chez le fournisseur au-delà du plafond"
    assert bruno.get("/api/usage").json()["budget"] == 0.10
    # Les autres profils continuent ; et les plafonds d'avant restent en place, pour tous.
    assert ask(agent_a).status_code == 200, "le plafond d'un profil arrête les agents d'un autre"
    db.set_setting("budget_daily:agent-alice", "0.01")
    assert ask(agent_a).status_code == 402 and "Plafond du jour" in ask(agent_a).json()["error"]["message"]
    db.set_setting("budget_daily:agent-alice", "")
    db.set_setting("budget_monthly", "0.01")
    assert "Budget mensuel de 0.01" in ask(agent_a).json()["error"]["message"]
    db.set_setting("budget_monthly", "")
    # Supprimer l'agent ne remet pas le compteur à zéro.
    assert bruno.delete(f"/api/agents/{B}").status_code == 200
    created = bruno.post("/api/agents", json={"name": "Remplaçant"}).json()["id"]
    assert [a["id"] for a in bruno.get("/api/agents").json()] == [created] and access.right(BRUNO, created) == "proprietaire"
    fresh = TestClient(app, headers={"Authorization": f"Bearer {relay.token_for(created)}"})
    assert ask(fresh).status_code == 402, "plafond contourné en recréant un agent"
    # Le partage ne fait pas payer celui qui parle : la dépense va au propriétaire de l'agent.
    assert relay.billed_to(A) == ALICE
    # La voix aussi s'arrête au plafond, y compris sans agent, et elle compte pour celui qui parle.
    assert bruno.post("/api/voice/speak", json={"text": "x"}).status_code == 400
    assert "Budget mensuel de ce profil" in bruno.post("/api/voice/speak", json={"text": "x"}).text
    assert bruno.post("/api/voice/speak", json={"text": "x", "agent_id": A}).status_code == 404
    # L'agent d'un profil ne lit ni le budget global ni le total du serveur.
    db.set_setting("budget_monthly", "1234")
    state = fresh.get("/agent-api/etat").json()["budget"]
    assert state["plafond"] == 0.10 and state["atteint"], state
    db.set_setting("budget_monthly", "")
    alice.patch(f"/api/profiles/{BRUNO}", json={"budget": None})
    assert ask(fresh).status_code == 200, "plafond retiré"
    assert bruno.delete(f"/api/agents/{created}").status_code == 200
    upstream_cost["value"] = 0.0
    print("10. plafond mensuel par profil : alerte au profil, arrêt à 100 %, les autres continuent, plafonds d'avant intacts, pas contournable")


def test_notifications() -> None:
    fixture()
    alice, uma = WEB["alice"], WEB["uma"]
    uma.post("/api/chat", json={"agent_id": A, "text": "ma tâche"})
    own = [c for c in uma.get(f"/api/agents/{A}/conversations").json() if c["main"]][0]["id"]
    agent_a = TestClient(app, headers={"Authorization": f"Bearer {relay.token_for(A)}"})
    with db.connect() as c:
        c.execute("DELETE FROM voice_calls")
    # Sans profil partagé dans le coup : seulement le propriétaire de l'agent.
    assert push._owner() == ALICE and access.owner_of(B) == BRUNO
    relay.active[A] = []
    assert access.recipients(A) == [ALICE]
    pushes.clear()
    r = agent_a.post("/agent-api/rappel", json={"texte": "Compte rendu pour alice"})
    assert r.status_code == 200, r.text
    assert {p["user"] for p in pushes} == {ALICE}, pushes
    with db.connect() as c:
        c.execute("DELETE FROM voice_calls")
    # Tâche lancée par uma : uma est appelée, avec le compte rendu dans SA conversation ; alice sait, sans le lire.
    relay.active[A] = [own]
    assert access.recipients(A) == [ALICE, UMA]
    pushes.clear()
    r = agent_a.post("/agent-api/rappel", json={"texte": "Compte rendu pour uma"})
    assert r.status_code == 200, r.text
    with db.connect() as c:
        call_row = c.execute("SELECT user_id, conversation_id FROM voice_calls").fetchone()
    assert call_row["user_id"] == UMA and call_row["conversation_id"] == own, dict(call_row)
    assert "Compte rendu pour uma" in uma.get(f"/api/conversations/{own}/messages").text
    assert "Compte rendu pour uma" not in alice.get(f"/api/conversations/{CA}/messages").text
    assert {p["user"] for p in pushes} == {ALICE, UMA}, pushes
    assert not any("Compte rendu pour uma" in p["text"] for p in pushes if p["user"] == ALICE), pushes
    assert not any(p["user"] in (LEA, ADA, BRUNO) for p in pushes), pushes
    # Une tâche lancée en partage ne passe ni par les collègues de l'agent ni par l'ordinateur du propriétaire.
    with db.connect() as c:
        c.execute("INSERT OR IGNORE INTO agents (id, name, role, api_key, owner_id) VALUES ('collegue', 'Collègue', '', 'k', ?)", (ALICE,))
    r = agent_a.post("/agent-api/demander", json={"agent": "collegue", "consigne": "lis ses courriels"})
    assert r.status_code == 403, f"tâche d'un invité relayée à un agent non partagé : {r.status_code} {r.text}"
    desktop._seen[ALICE] = {"at": time.time(), "os": "test"}
    assert "erreur" in agent_a.post("/agent-api/ordinateur", json={"action": "commande", "cible": "whoami"}).json()
    desktop._seen.pop(ALICE)
    relay.active[A] = []
    # Accord demandé pendant la tâche d'uma : uma et alice, personne d'autre.
    run_behaviour["events"] = [("approval.request", {"request_id": "r", "generation": 1, "summary": "Envoyer ?"})]
    pushes.clear()
    uma.post("/api/chat", json={"agent_id": A, "text": "envoie"})
    run_behaviour["events"] = []
    wanted = [p for p in pushes if p["title"] == "Noah attend ton accord"]
    assert {p["user"] for p in wanted} == {ALICE, UMA}, pushes
    with db.connect() as c:
        c.execute("DELETE FROM agents WHERE id = 'collegue'")
    print("11. rappels et notifications : le propriétaire de l'agent, plus le profil partagé s'il a lancé la tâche, personne d'autre")


def test_desktop() -> None:
    """L'application de bureau d'un profil ne reçoit jamais les actions de l'agent d'un autre."""
    fixture()
    desktop.WAIT = 0.05
    sessions = {u: auth.new_session(u, "bureau", "desktop") for u in (ALICE, BRUNO)}

    async def go():
        transport = httpx.ASGITransport(app=app)
        as_user = lambda u: {"Authorization": f"Bearer {sessions[u]}"}  # noqa: E731
        real = Sandbox.__mro__[1]
        async with real(transport=transport, base_url="http://t", timeout=10) as http:
            alice = (await http.get("/api/desktop/next", headers=as_user(ALICE), params={"os": "windows"}))
            assert alice.status_code == 204
            assert (await http.get("/api/desktop/status", headers=as_user(BRUNO))).json()["connecte"] is False
            assert (await http.get("/api/desktop/status", headers=as_user(ALICE))).json()["connecte"] is True
            # Le propriétaire de l'agent A répond seul à l'action de A.
            pending = asyncio.create_task(http.post("/agent-api/ordinateur", json={"action": "notifier", "titre": "t", "texte": "pour alice"},
                                                    headers={"Authorization": f"Bearer {relay.token_for(A)}"}))
            await asyncio.sleep(0.05)
            desktop.WAIT = 0.05
            other = await http.get("/api/desktop/next", headers=as_user(BRUNO))
            assert other.status_code == 204, f"action d'alice livrée à bruno : {other.text}"
            desktop.WAIT = 2
            item = (await http.get("/api/desktop/next", headers=as_user(ALICE))).json()
            assert item["texte"] == "pour alice", item
            wrong = await http.post(f"/api/desktop/result/{item['id']}", json={"ok": True}, headers=as_user(BRUNO))
            assert wrong.status_code == 404, "bruno répond à la place d'alice"
            ok = await http.post(f"/api/desktop/result/{item['id']}", json={"fait": "oui"}, headers=as_user(ALICE))
            assert ok.status_code == 200
            assert (await pending).json() == {"fait": "oui"}

    asyncio.run(go())
    desktop._seen.clear()
    desktop._queues.clear()
    print("12. application de bureau : file, état et réponses par compte")


def test_secrets() -> None:
    fixture()
    bruno = WEB["bruno"]
    # Les agents des autres sont invisibles aussi pour un agent.
    agent_b = TestClient(app, headers={"Authorization": f"Bearer {relay.token_for(B)}"})
    assert SECRET_A not in agent_b.get("/agent-api/agents").text
    assert agent_b.post("/agent-api/demander", json={"agent": A, "consigne": "x"}).status_code == 404
    assert agent_b.get(f"/agent-api/fils/{CA}").status_code == 404
    # Ni clé ni jeton dans ce que voit un profil.
    for path in ("/api/agents", "/api/model", "/api/usage", "/api/me"):
        r = bruno.get(path)
        assert "CLE-DU-FOURNISSEUR" not in r.text and "api_key" not in r.text and relay.token_for(B) not in r.text, path
    db.set_setting("base_url", "http://interne:9000/v1")
    assert bruno.get("/api/model").json()["base_url"] is None and WEB["alice"].get("/api/model").json()["base_url"]
    db.set_setting("base_url", "")
    # Le cerveau en service reste consultable pour un profil, sans adresse à lui.
    assert bruno.post("/api/models", json={"provider": "openrouter"}).status_code != 403
    # Les dossiers de l'ordinateur et les identifiants Google sont au propriétaire de l'installation.
    touched.clear()
    assert bruno.put(f"/api/agents/{B}/folders", json={"dossiers": [{"chemin": "/home/alice"}]}).status_code == 403 and not touched
    assert bruno.post(f"/api/agents/{B}/google/connect", json={"permissions": [next(iter(__import__("apollo.accounts").accounts.PERMS))]}).status_code == 403
    google = {"client_id": "1-a.apps.googleusercontent.com", "client_secret": "volé-volé"}
    assert agent_b.post("/agent-api/google/identifiants", json=google).status_code == 403
    assert "volé" not in (db.get_setting("google_client") or "")
    # Le flux de son d'un autre compte ne s'écoute pas et ne s'écrit pas.
    assert WEB["uma"].post("/api/voice/say", json={"text": "x", "agent_id": A, "audio_id": AUDIO}).status_code == 404
    print("13. conteneurs, secrets et comptes : un agent ne voit pas ceux des autres, un profil ne lit ni clé ni adresse")


def test_profiles() -> None:
    fixture()
    alice = WEB["alice"]
    # Création : mot de passe haché, comme les autres ; connexion normale.
    r = alice.post("/api/profiles", json={"username": "nina", "password": "motdepasse-n", "budget": 5})
    assert r.status_code == 200 and r.json()["budget"] == 5 and r.json()["role"] == "member", r.text
    nina_id = r.json()["id"]
    with db.connect() as c:
        stored = c.execute("SELECT pw_hash FROM users WHERE id = ?", (nina_id,)).fetchone()["pw_hash"]
    assert stored.startswith(b"$2") and b"motdepasse" not in stored
    assert alice.post("/api/profiles", json={"username": "nina", "password": "motdepasse-n"}).status_code == 409
    assert alice.post("/api/profiles", json={"username": "x", "password": "court"}).status_code == 422
    login = TestClient(app).post("/api/login", json={"username": "nina", "password": "motdepasse-n"})
    assert login.status_code == 200
    nina = TestClient(app, headers={"Authorization": f"Bearer {login.json()['token']}"}, raise_server_exceptions=False)
    me = nina.get("/api/me").json()
    assert me["role"] == "member" and me["username"] == "nina", me
    assert alice.get("/api/me").json()["role"] == "owner"
    assert [p["username"] for p in alice.get("/api/profiles").json()["profils"]].count("nina") == 1
    # Un second compte ne se crée que par le propriétaire.
    assert TestClient(app).post("/api/setup/account", json={"username": "pirate", "password": "motdepasse-p"}).status_code == 410
    # Son mot de passe initial, il le remplace ; ses autres appareils tombent, pas celui-ci.
    other = auth.new_session(nina_id, "téléphone", "android")
    assert nina.post("/api/me/password", json={"actuel": "faux", "nouveau": "nouveau-mdp-1"}).status_code == 400
    assert nina.post("/api/me/password", json={"actuel": "motdepasse-n", "nouveau": "nouveau-mdp-1"}).status_code == 200
    assert auth.check_password("nina", "nouveau-mdp-1") == nina_id and not auth.still_valid(other)
    assert nina.get("/api/me").status_code == 200
    # Suppression sans agent : directe. Le propriétaire ne peut pas se supprimer.
    assert alice.delete(f"/api/profiles/{ALICE}").status_code == 400
    # Avec des agents : le choix est obligatoire, et la réponse le dit.
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('agent-nina', 'Clara', '', 'k', ?)", (nina_id,))
        c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main) VALUES ('conv-nina', ?, 'agent-nina', 'Ses notes', 1)", (nina_id,))
        c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('conv-nina', 'user', 'à garder')")
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, owner_id) VALUES ('agent-nina', 'm', 1, 1, 0.5, ?)", (nina_id,))
        c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('agent-nina', ?, 'usage')", (UMA,))
        c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('agent-nina', ?, 'usage')", (ALICE,))
        c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main) VALUES ('conv-alice-chez-nina', ?, 'agent-nina', 'Chez Nina', 1)", (ALICE,))
        session = auth.digest(login.json()["token"])
        c.execute("INSERT INTO push_subscriptions (endpoint, session, p256dh, auth) VALUES ('https://fcm.googleapis.com/x', ?, 'a', 'b')", (session,))
    r = alice.delete(f"/api/profiles/{nina_id}")
    assert r.status_code == 409 and "Clara" in r.json()["detail"] and "transferer" in r.json()["detail"] and "supprimer" in r.json()["detail"], r.text
    assert nina.get("/api/me").status_code == 200, "demande incomplète : rien ne doit avoir bougé"
    assert alice.delete(f"/api/profiles/{nina_id}?agents=au-hasard").status_code == 409
    assert WEB["bruno"].delete(f"/api/profiles/{nina_id}?agents=supprimer").status_code == 403
    # Transfert : l'agent et ses conversations passent au propriétaire, ses partages restent, sa session tombe.
    stopped.clear()
    main._runs["tache-nina"] = {"agent": "agent-nina", "user": nina_id}
    r = alice.delete(f"/api/profiles/{nina_id}?agents=transferer")
    assert r.status_code == 200 and r.json()["agents"] == "transferes" and r.json()["noms"] == ["Clara"], r.text
    main._runs.pop("tache-nina")
    assert stopped == ["tache-nina"], "sa tâche continue après la suppression"
    assert nina.get("/api/me").status_code == 401, "session gardée après la suppression"
    assert TestClient(app).post("/api/login", json={"username": "nina", "password": "nouveau-mdp-1"}).status_code == 401
    assert access.right(ALICE, "agent-nina") == "proprietaire" and access.right(UMA, "agent-nina") == "usage"
    assert alice.get("/api/conversations/conv-nina/messages").json()[0]["text"] == "à garder", "conversation perdue au transfert"
    mains = [c["id"] for c in alice.get("/api/agents/agent-nina/conversations").json() if c["main"]]
    assert mains == ["conv-alice-chez-nina"], f"deux conversations principales : {mains}"
    with db.connect() as c:
        assert c.execute("SELECT owner_id FROM usage WHERE agent_id = 'agent-nina'").fetchone()["owner_id"] == ALICE
        assert not c.execute("SELECT 1 FROM push_subscriptions WHERE session = ?", (session,)).fetchone(), "ses appareils restent abonnés"
        assert not c.execute("SELECT 1 FROM sessions WHERE user_id = ?", (nina_id,)).fetchone()
        c.execute("DELETE FROM agents WHERE id = 'agent-nina'")
    # Suppression avec ses agents : machine et conversations effacées.
    r = alice.post("/api/profiles", json={"username": "otto", "password": "motdepasse-o"}).json()
    otto = r["id"]
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('agent-otto', 'Oscar', '', 'k', ?)", (otto,))
        c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main) VALUES ('conv-otto', ?, 'agent-otto', 'Notes', 1)", (otto,))
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, owner_id) VALUES ('agent-otto', 'm', 1, 1, 0.5, ?)", (otto,))
    deleted_containers.clear()
    r = alice.delete(f"/api/profiles/{otto}?agents=supprimer")
    assert r.status_code == 200 and r.json()["agents"] == "supprimes", r.text
    assert deleted_containers == ["agent-otto"], "conteneur laissé en place"
    with db.connect() as c:
        assert not c.execute("SELECT 1 FROM agents WHERE id = 'agent-otto'").fetchone()
        assert not c.execute("SELECT 1 FROM conversations WHERE id = 'conv-otto'").fetchone()
        assert c.execute("SELECT owner_id FROM usage WHERE agent_id = 'agent-otto'").fetchone()["owner_id"] == ALICE, "dépense perdue pour le total"
    # Le numéro de compte peut resservir : le nouveau venu n'hérite de rien.
    reborn = alice.post("/api/profiles", json={"username": "pia", "password": "motdepasse-p"}).json()
    assert reborn["id"] == otto, "SQLite aurait pu ne pas réutiliser ce numéro : l'essai ne prouve plus rien"
    assert reborn["depense"] == 0 and reborn["agents"] == [], reborn
    pia = client(reborn["id"])
    assert pia.get("/api/agents").json() == [] and pia.get("/api/usage").json()["agents"] == []
    assert alice.delete(f"/api/profiles/{reborn['id']}").json()["agents"] == "aucun"
    print("14. profils : création, mot de passe haché et remplaçable, suppression avec choix explicite, sessions et appareils coupés, numéro réutilisé sans héritage")


test_migration()
test_every_route_is_declared()
test_isolation_on_every_route()
test_owner_routes()
test_lists()
test_personal()
test_rights()
test_revocation()
WEB["uma"] = client(UMA)
test_budget()
test_notifications()
test_desktop()
test_secrets()
test_profiles()
print("Tout est vert : profils et partage")
