"""Publier par l'API : Instagram et X branchés comme un outil. Un post part une seule fois, le jeton reste sur le serveur.

Vrais : les routes de Noah, la base, le relais MCP, le droit, le retour OAuth. Simulés : Instagram et X (d'après leur documentation),
Hermes et le lanceur. Une vraie publication reste à prouver avec un vrai compte, sur accord de la personne.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/publication_test.py"
"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

LOGS: list[str] = []


class Keep(logging.Handler):
    def emit(self, record):
        LOGS.append(record.getMessage())


logging.getLogger().addHandler(Keep())
logging.getLogger().setLevel(logging.DEBUG)

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, connexion, db, hermes, machine, main, mcp, public, publication, relay  # noqa: E402

IG_TOKEN = "jeton-instagram-tres-secret-0123456789"
JPEG = b"\xff\xd8\xff" + b"a" * 50
JPEG2 = b"\xff\xd8\xff" + b"b" * 50
PNG = b"\x89PNG" + b"c" * 50
FILES = {"/w/1.jpg": JPEG, "/w/2.jpg": JPEG2, "/w/3.png": PNG, "/w/gros.jpg": b"\xff\xd8\xff" + b"z" * 9_000_000}

db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
A, B = "agent-alice", "agent-bruno"
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Alma', '', 'k', ?)", (A, ALICE))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Basile', '', 'k', ?)", (B, BRUNO))


def client(user: int) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


alice, bruno = client(ALICE), client(BRUNO)
agent = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for(A)}"}, raise_server_exceptions=False)
outside = TestClient(main.app, base_url="https://noah.exemple", headers={"X-Forwarded-For": "203.0.113.9"}, raise_server_exceptions=False)
PUBLICATION = f"/api/agents/{A}/publication"

admin_calls: list[tuple] = []


async def admin(agent_id, action, payload=None):
    admin_calls.append((agent_id, action, payload))
    return {}


async def read_file(agent_id, path):
    assert agent_id == A
    return httpx.Response(200, content=FILES[path]) if path in FILES else httpx.Response(404)


machine.admin = admin
hermes.read_file = read_file
public.main_url = lambda: "https://noah.exemple"
publication.IG_READY_EVERY = 0

calls: list[httpx.Request] = []
script: dict = {}  # ce que doit faire la plateforme simulée
counter = {"n": 100}
served: list[bytes] = []


def new_id() -> str:
    counter["n"] += 1
    return str(counter["n"])


def instagram(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/refresh_access_token":
        if script.get("refresh") == "panne":
            return httpx.Response(400, json={"error": {"message": "non"}})
        return httpx.Response(200, json={"access_token": "jeton-instagram-renouvele-0123456789", "expires_in": 5184000})
    assert path.startswith("/v27.0/"), path
    if script.get("mort"):
        return httpx.Response(400, json={"error": {"code": 190, "message": f"Jeton {IG_TOKEN} expiré"}})
    assert request.headers.get("authorization", "").startswith("Bearer "), "le jeton passe par l'en-tête"
    rest = path.removeprefix("/v27.0/")
    if rest.startswith("99/"):  # le second compte de l'essai
        rest = "17841/" + rest[3:]
    if rest == "me":
        if request.headers["authorization"] != f"Bearer {IG_TOKEN}":
            return httpx.Response(400, json={"error": {"code": 190, "message": "Invalid"}})
        return httpx.Response(200, json={"user_id": "17841", "username": "marque", "id": "999"})
    if rest == "17841/media" and request.method == "POST":
        body = json.loads(request.content)
        if script.get("conteneur_refuse"):
            return httpx.Response(400, json={"error": {"code": 36003, "error_user_msg": "Ratio d'image non pris en charge"}})
        if body.get("image_url"):
            key = body["image_url"].rsplit("/", 1)[-1].removesuffix(".jpg")
            assert body["image_url"].startswith("https://noah.exemple/"), "une adresse publique"
            served.append(publication._images[key][0])  # Instagram vient la chercher
        return httpx.Response(200, json={"id": new_id()})
    if rest == "17841/media" and request.method == "GET":
        return httpx.Response(200, json={"data": [{"permalink": "https://www.instagram.com/p/ANCIEN/", "timestamp": "2026", "media_type": "IMAGE", "caption": "Ancien"}]})
    if rest == "17841/media_publish":
        if script.get("publication_perdue"):
            script.pop("publication_perdue")
            raise httpx.ReadTimeout("perdu")
        if script.get("publication_panne"):
            script.pop("publication_panne")
            return httpx.Response(503, text="passerelle")
        return httpx.Response(200, json={"id": "555"})
    if rest == "17841/content_publishing_limit":
        return httpx.Response(200, json={"data": [{"quota_usage": 3, "config": {"quota_total": 100}}]})
    if rest == "555":
        if script.get("sans_adresse"):
            return httpx.Response(400, json={"error": {"code": 1, "message": "non"}})
        return httpx.Response(200, json={"permalink": "https://www.instagram.com/p/NOUVEAU/"})
    if request.url.params.get("fields") == "status_code,status":
        if script.get("image_refusee"):
            return httpx.Response(200, json={"status_code": "ERROR", "status": "Format refusé"})
        script["attente"] = script.get("attente", 0) + 1
        return httpx.Response(200, json={"status_code": "IN_PROGRESS" if script["attente"] == 1 else "FINISHED"})
    return httpx.Response(404, json={"error": {"message": "inconnu"}})


def x_api(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/2/oauth2/token":
        form = parse_qs(request.content.decode())
        assert form["client_id"] == ["client-de-x"]
        if form["grant_type"] == ["authorization_code"]:
            if script.get("x_retire_droit"):
                with db.connect() as c:
                    c.execute("DELETE FROM agent_shares WHERE user_id = ?", (BRUNO,))
            script["x_verifier"] = form["code_verifier"][0]
            script["x_redirect"] = form["redirect_uri"][0]
            assert form["code"] == ["code-de-x"]
            return httpx.Response(200, json={"access_token": "acces-x-1-0123456789", "refresh_token": "renouv-x-1-0123456789", "expires_in": 7200})
        assert form["grant_type"] == ["refresh_token"] and form["refresh_token"] == ["renouv-x-1-0123456789"], "le dernier renouvellement"
        return httpx.Response(200, json={"access_token": "acces-x-2-0123456789", "refresh_token": "renouv-x-2-0123456789", "expires_in": 7200})
    if path == "/2/users/me":
        return httpx.Response(200, json={"data": {"id": "1", "username": "marque_x"}})
    if path == "/2/media/upload/initialize":
        body = json.loads(request.content)
        assert body["media_category"] == "tweet_image" and body["total_bytes"] > 0
        return httpx.Response(200, json={"data": {"id": new_id()}})
    if path.endswith("/finalize") and script.get("x_traitement"):
        return httpx.Response(200, json={"data": {"processing_info": {"state": "pending", "check_after_secs": 0}}})
    if path == "/2/media/upload":
        script["x_lectures"] = script.get("x_lectures", 0) + 1
        return httpx.Response(200, json={"data": {"processing_info": {"state": script["x_traitement"] if script["x_lectures"] > 1 else "in_progress", "check_after_secs": 0}}})
    if path.endswith("/append") or path.endswith("/finalize"):
        return httpx.Response(200, json={"data": {}})
    if path == "/2/tweets":
        if script.get("x_panne"):
            script.pop("x_panne")
            return httpx.Response(502, text="passerelle")
        if script.get("x_credit"):
            return httpx.Response(402, json={"title": "Credits depleted"})
        script["x_body"] = json.loads(request.content)
        return httpx.Response(201, json={"data": {"id": "777", "text": "x"}})
    return httpx.Response(404, json={})


def upstream(request: httpx.Request) -> httpx.Response:
    calls.append(request)
    return instagram(request) if request.url.host == "graph.instagram.com" else x_api(request)


real_client = httpx.AsyncClient
publication._client = lambda: real_client(transport=httpx.MockTransport(upstream), timeout=5)


def rpc(method: str, server: str, **params) -> dict:
    r = agent.post(f"/agent-api/mcp/{server}", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    assert r.status_code == 200, r.text
    return r.json()


def call(server: str, tool: str, **args) -> tuple[bool, str]:
    result = rpc("tools/call", server, name=tool, arguments=args)["result"]
    return bool(result.get("isError")), result["content"][0]["text"]


def row(name: str):
    with db.connect() as c:
        return c.execute("SELECT * FROM mcp_tools WHERE agent_id = ? AND nom = ?", (A, name)).fetchone()


def set_right(name: str, droit: str) -> None:
    assert alice.put(f"/api/agents/{A}/connections/tools/{name}/droit", json={"droit": droit}).status_code == 200


def published() -> int:
    return sum(1 for q in calls if q.url.path.endswith("/media_publish"))


def forget_posts() -> None:
    with db.connect() as c:
        c.execute("DELETE FROM publications")


# --- 1. Connecter Instagram --------------------------------------------------------------------------------------------
r = alice.post(f"{PUBLICATION}/instagram", json={"jeton": "un-mauvais-jeton-0123456789"})
assert r.status_code == 400 and "refuse" in r.json()["detail"], r.text
assert not row("instagram") and not admin_calls, "rien n'est enregistré pour un jeton refusé"
assert bruno.post(f"{PUBLICATION}/instagram", json={"jeton": IG_TOKEN}).status_code in (403, 404), "pas l'agent d'un autre"
# Droit retiré pendant la vérification du jeton : rien ne se branche.
with db.connect() as c:
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (A, BRUNO))
real_check = publication.instagram_check


async def revoked_meanwhile(token):
    with db.connect() as c:
        c.execute("DELETE FROM agent_shares WHERE user_id = ?", (BRUNO,))
    return await real_check(token)


publication.instagram_check = revoked_meanwhile
assert bruno.post(f"{PUBLICATION}/instagram", json={"jeton": IG_TOKEN}).status_code in (403, 404)
publication.instagram_check = real_check
assert not row("instagram"), "droit retiré : Instagram ne se branche pas"
r = alice.post(f"{PUBLICATION}/instagram", json={"jeton": f"Bearer {IG_TOKEN}"})
assert r.status_code == 200 and r.json()["compte"] == "marque", r.text
stored = row("instagram")
assert IG_TOKEN not in stored["jeton"] and stored["droit"] == "confirmer", "chiffré, et confirmation par défaut"
sent = json.dumps(admin_calls)
assert IG_TOKEN not in sent and "noah-server:8080/agent-api/mcp/instagram" in sent, "l'agent parle à Noah, jamais à Instagram avec le jeton"
assert alice.post(f"{PUBLICATION}/instagram", json={"jeton": IG_TOKEN}).status_code == 400, "déjà connecté"
state = asyncio.run(mcp.connections_state(A, [], {}))["outils"][0]
assert state["compte"] == "marque" and state["url"] == "https://graph.instagram.com" and IG_TOKEN not in json.dumps(state)
assert mcp.outbound(A)[0]["url"] == "https://graph.instagram.com", "la liste de ce qui sort dit la vraie adresse"
print("1. Instagram : jeton vérifié, chiffré, absent de la machine de l'agent")

# --- 2. Droit -----------------------------------------------------------------------------------------------------------
tools = {t["name"] for t in rpc("tools/list", "instagram")["result"]["tools"]}
assert tools == {"publier_post", "derniers_posts", "compte"}
wrong, text = call("instagram", "publier_post", images=["/w/1.jpg"], legende="Bonjour")
assert wrong and "confirmation" in text and published() == 0 and not served, "sans accord, rien ne part"
wrong, text = call("instagram", "compte")
assert not wrong and json.loads(text)["limite"] == 100, "la lecture passe sans accord"
wrong, text = call("instagram", "derniers_posts", nombre=2)
assert not wrong and "ANCIEN" in text
set_right("instagram", "lire")
assert {t["name"] for t in rpc("tools/list", "instagram")["result"]["tools"]} == {"derniers_posts", "compte"}
assert call("instagram", "publier_post", images=["/w/1.jpg"], legende="Bonjour")[0] and published() == 0
set_right("instagram", "confirmer")
args = {"images": ["/w/1.jpg"], "legende": "Accordé"}
mcp._grants[(A, "instagram")] = [(time.time() + 60, mcp._shown("publier_post", args), "g")]
assert call("instagram", "publier_post", **{**args, "legende": "Autre texte"})[0] and published() == 0, "l'accord vaut pour ce qui a été montré"
assert not call("instagram", "publier_post", **args)[0] and published() == 1, "l'accord ouvre cet appel"
assert call("instagram", "publier_post", images=["/w/2.jpg"], legende="Encore")[0] and published() == 1, "et lui seul"
forget_posts()
set_right("instagram", "agir")
print("2. droit : sans accord rien ne part, l'accord vaut pour ce post")

# --- 3. Carrousel ------------------------------------------------------------------------------------------------------
calls.clear()
served.clear()
wrong, text = call("instagram", "publier_post", images=["/w/1.jpg", "/w/2.jpg"], legende="Mon carrousel #marque")
assert not wrong and json.loads(text) == {"publie": True, "adresse": "https://www.instagram.com/p/NOUVEAU/"}, text
assert served == [JPEG, JPEG2], "dans l'ordre donné"
posted = [json.loads(q.content) for q in calls if q.url.path.endswith("/17841/media") and q.method == "POST"]
assert [p.get("is_carousel_item") for p in posted[:2]] == [True, True] and all("caption" not in p for p in posted[:2]), posted
assert posted[2]["media_type"] == "CAROUSEL" and posted[2]["caption"] == "Mon carrousel #marque" and len(posted[2]["children"].split(",")) == 2, posted
assert not publication._images, "les images ne restent pas à une adresse publique"
key = publication._share(JPEG).rsplit("/", 1)[-1]
r = outside.get(f"/api/post-image/{key}")
assert r.status_code == 200 and r.content == JPEG and r.headers["content-type"] == "image/jpeg" and "noindex" in r.headers["x-robots-tag"], "joignable de dehors : Instagram vient la chercher"
assert outside.get("/api/post-image/autre.jpg").status_code == 404
publication._images[key.removesuffix(".jpg")] = (JPEG, time.time() - 1)
assert outside.get(f"/api/post-image/{key}").status_code == 404, "l'adresse expire"
print("3. carrousel : ordre, légende, adresse d'image joignable puis retirée")

# --- 4. Ce qui ne part pas ----------------------------------------------------------------------------------------------
calls.clear()
for args, why in (({"images": ["/w/3.png"], "legende": "x"}, "JPEG"), ({"images": ["/w/nulle.jpg"], "legende": "x"}, "introuvable"),
                  ({"images": ["/w/gros.jpg"], "legende": "x"}, "Mo"), ({"images": ["/w/1.jpg"] * 21, "legende": "x"}, "20"),
                  ({"images": [], "legende": "x"}, "au moins une image"), ({"images": ["/w/1.jpg"], "legende": "x" * 2201}, "2200")):
    wrong, text = call("instagram", "publier_post", **args)
    assert wrong and why in text and "Rien n'est parti" in text, (why, text)
assert not calls, "refusé avant d'appeler Instagram"
public.main_url = lambda: ""
wrong, text = call("instagram", "publier_post", images=["/w/1.jpg"], legende="Sans adresse")
assert wrong and "navigateur" in text and published() == 0, text
public.main_url = lambda: "https://noah.exemple"
forget_posts()
print("4. contrôles : format, taille, nombre, adresse publique, avant tout appel")

# --- 5. Une seule fois ---------------------------------------------------------------------------------------------------
calls.clear()
post = {"images": ["/w/1.jpg"], "legende": "Unique"}
assert not call("instagram", "publier_post", **post)[0] and published() == 1
wrong, text = call("instagram", "publier_post", **post)
assert wrong and "déjà en ligne" in text and "NOUVEAU" in text and published() == 1, text
assert not call("instagram", "publier_post", images=["/w/2.jpg"], legende="Unique")[0] and published() == 2, "autre image : autre post"
assert not call("instagram", "publier_post", **post, republier=True)[0] and published() == 3, "republier à la demande"

script["publication_perdue"] = True
calls.clear()
lost = {"images": ["/w/1.jpg"], "legende": "Perdu"}
wrong, text = call("instagram", "publier_post", **lost)
assert wrong and "peut-être en ligne" in text and "Rien n'est parti" not in text, text
wrong, text = call("instagram", "publier_post", **lost)
assert wrong and "incertain" in text and published() == 1, "un post peut-être en ligne ne repart pas seul"
assert not call("instagram", "publier_post", **lost, republier=True)[0] and published() == 2

# Une panne au moment de publier ne prouve pas que rien n'est parti.
script["publication_panne"] = True
calls.clear()
gateway = {"images": ["/w/1.jpg"], "legende": "Passerelle"}
wrong, text = call("instagram", "publier_post", **gateway)
assert wrong and "peut-être en ligne" in text and "Rien n'est parti" not in text, text
wrong, text = call("instagram", "publier_post", **gateway)
assert wrong and "incertain" in text and published() == 1, "ne repart pas seul"

# En ligne, mais son adresse n'a pas pu être lue : on ne donne pas le profil pour le post.
script["sans_adresse"] = True
wrong, text = call("instagram", "publier_post", images=["/w/2.jpg"], legende="Sans adresse lue")
script.pop("sans_adresse")
answer = json.loads(text)
assert not wrong and answer["publie"] is True and answer["adresse"] is None and "derniers_posts" in answer["a_faire"], answer

script["conteneur_refuse"] = True
calls.clear()
bad = {"images": ["/w/1.jpg"], "legende": "Refusé"}
wrong, text = call("instagram", "publier_post", **bad)
assert wrong and "Ratio" in text and "Rien n'est parti" in text and published() == 0, text
script.pop("conteneur_refuse")
assert not call("instagram", "publier_post", **bad)[0] and published() == 1, "refusé sans rien publier : se corrige et repart"

script["image_refusee"] = True
wrong, text = call("instagram", "publier_post", images=["/w/2.jpg"], legende="Image refusée")
assert wrong and "Format refusé" in text, text
script.pop("image_refusee")


async def twice():
    return await asyncio.gather(*(publication._publish(A, "instagram", json.loads(db.unseal(row("instagram")["jeton"])), {"images": ["/w/1.jpg"], "legende": "Ensemble"}) for _ in range(2)), return_exceptions=True)


quick_post = publication._instagram_post


async def slow_post(*args):
    await asyncio.sleep(0.05)  # le temps que le second appel arrive pendant que le premier travaille
    return await quick_post(*args)


publication._instagram_post = slow_post
calls.clear()
both = asyncio.run(twice())
publication._instagram_post = quick_post
assert sum(isinstance(x, publication.Refused) and "en cours" in str(x) for x in both) == 1 and published() == 1, both
# Deux tentatives à la fois, sur demande : l'échec de la première ne touche pas la seconde.
first = publication._claim(A, "instagram", "m1", False)
with db.connect() as c:
    c.execute("UPDATE publications SET at = at - 700 WHERE id = ?", (first,))
second = publication._claim(A, "instagram", "m1", True)
publication._close(first, "refuse")
with db.connect() as c:
    assert c.execute("SELECT etat FROM publications WHERE id = ?", (second,)).fetchone()["etat"] == "en_cours", "une tentative en clôt une autre"
publication._close(second, "publie", "https://x")
# Deux agents reliés au même compte : le même post ne part pas deux fois.
try:
    publication._claim(B, "instagram", "m1", False)
except publication.Refused:
    pass
else:
    raise AssertionError("un autre agent republie le même post sur le même compte")
# Et si le premier agent est supprimé : le post, lui, reste en ligne.
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('agent-passe', 'Passé', '', 'k', ?)", (ALICE,))
publication._close(publication._claim("agent-passe", "instagram", "m2", False), "publie", "https://x")
with db.connect() as c:
    c.execute("DELETE FROM agents WHERE id = 'agent-passe'")
try:
    publication._claim(A, "instagram", "m2", False)
except publication.Refused:
    pass
else:
    raise AssertionError("supprimer un agent efface la protection contre le doublon")
# Passé le délai, le registre se vide de lui-même.
with db.connect() as c:
    c.execute("UPDATE publications SET at = at - ? WHERE empreinte = 'm2'", (publication.ALREADY_SECONDS + 1,))
publication._close(publication._claim(A, "instagram", "m3", False), "refuse")
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM publications WHERE empreinte = 'm2'").fetchone(), "le registre ne garde rien au-delà du délai"
print("5. un post part une fois : doublon, envoi incertain, refus corrigé, deux appels ensemble")

# --- 6. Le jeton ---------------------------------------------------------------------------------------------------------
creds = json.loads(db.unseal(row("instagram")["jeton"]))
creds["renouvele"] = time.time() - 21 * 86400
publication._save(A, "instagram", creds, creds["jeton"])
script["refresh"] = "panne"
assert not call("instagram", "compte")[0], "un renouvellement raté ne bloque rien"
assert json.loads(db.unseal(row("instagram")["jeton"]))["jeton"] == IG_TOKEN
calls.clear()
call("instagram", "compte")
assert not any(q.url.path == "/refresh_access_token" for q in calls), "pas de nouvel essai avant une heure"
script.pop("refresh")
publication._refresh_failed.clear()
assert "tools" in rpc("tools/list", "instagram")["result"]
fresh = json.loads(db.unseal(row("instagram")["jeton"]))
assert fresh["jeton"] == "jeton-instagram-renouvele-0123456789" and time.time() - fresh["renouvele"] < 60, "renouvelé bien avant les 60 jours, sans action de la personne"
# Deux appels partis avec l'ancien jeton : un seul renouvellement, et aucun des deux n'est refusé.
old = {**fresh, "jeton": IG_TOKEN, "renouvele": time.time() - 21 * 86400}
publication._save(A, "instagram", old, fresh["jeton"])
calls.clear()


async def two_refreshes():
    return await asyncio.gather(publication._instagram_token(A, dict(old)), publication._instagram_token(A, dict(old)))


assert asyncio.run(two_refreshes()) == [fresh["jeton"]] * 2
assert sum(q.url.path == "/refresh_access_token" for q in calls) == 1, "un seul renouvellement"
# Compte retiré et remplacé pendant le renouvellement : le nouveau compte n'est pas écrasé.
before = json.loads(db.unseal(row("instagram")["jeton"]))
replaced = {**before, "jeton": "jeton-du-compte-b-0123456789", "id": "99", "compte": "compteb"}
publication._save(A, "instagram", replaced, before["jeton"])
try:
    publication._save(A, "instagram", {**before, "jeton": "renouvele-du-compte-a-0123456789"}, before["jeton"])
except publication.TokenRefused:
    pass
else:
    raise AssertionError("le renouvellement du compte retiré a écrasé le nouveau")
assert json.loads(db.unseal(row("instagram")["jeton"]))["compte"] == "compteb"
calls.clear()
post = {"images": ["/w/1.jpg"], "legende": "Unique"}
assert not call("instagram", "publier_post", **post)[0] and published() == 1, "le même contenu sur un autre compte est un autre post"
publication._save(A, "instagram", before, replaced["jeton"])
script["mort"] = True
wrong, text = call("instagram", "publier_post", images=["/w/2.jpg"], legende="Jeton mort")
assert wrong and IG_TOKEN not in text and "jeton_refuse" == row("instagram")["etat"], text
script.pop("mort")
print("6. jeton : renouvelé seul, un jeton mort se signale sans se répéter")

# --- 7. X ---------------------------------------------------------------------------------------------------------------
state = alice.get(PUBLICATION).json()
assert state["adresse_publique"] and state["retour"] == "https://noah.exemple/api/connexion/retour", state
r = alice.post(f"{PUBLICATION}/x", json={"client_id": "client-de-x"})
assert r.status_code == 200 and r.json()["retour"] is True, r.text
asked = urlsplit(r.json()["adresse"])
query = {k: v[0] for k, v in parse_qs(asked.query).items()}
assert asked.netloc == "x.com" and query["code_challenge_method"] == "S256" and "offline.access" in query["scope"] and "media.write" in query["scope"], query
assert query["redirect_uri"] == state["retour"]
assert not row("x"), "rien n'est branché avant l'accord"
back = alice.get("/api/connexion/retour", params={"state": query["state"], "code": "code-de-x"}, follow_redirects=False)
assert back.status_code == 303, back.text
assert base64.urlsafe_b64encode(hashlib.sha256(script["x_verifier"].encode()).digest()).rstrip(b"=").decode() == query["code_challenge"], "PKCE tenu"
assert script["x_redirect"] == state["retour"]
stored = row("x")
assert stored and "acces-x-1" not in stored["jeton"] and stored["droit"] == "confirmer"
assert alice.get("/api/connexion/retour", params={"state": query["state"], "code": "code-de-x"}).status_code == 400, "un retour ne sert qu'une fois"
assert alice.post(f"{PUBLICATION}/x", json={"client_id": "pas bon !"}).status_code == 422
# Droit retiré pendant l'accord chez X : rien ne se branche.
alice.post(f"/api/agents/{A}/connections/tools/x/remove", json={})
with db.connect() as c:
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (A, BRUNO))
late = urlsplit(bruno.post(f"{PUBLICATION}/x", json={"client_id": "client-de-x"}).json()["adresse"])
with db.connect() as c:
    c.execute("DELETE FROM agent_shares WHERE user_id = ?", (BRUNO,))
script.pop("x_verifier", None)
refused_back = bruno.get("/api/connexion/retour", params={"state": parse_qs(late.query)["state"][0], "code": "code-de-x"}, follow_redirects=False)
assert refused_back.status_code == 502 and not row("x"), "droit retiré : X ne se branche pas"
assert "x_verifier" not in script, "droit retiré : le code n'est même pas échangé chez X"
# Et pendant l'échange avec X.
with db.connect() as c:
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (A, BRUNO))
late = urlsplit(bruno.post(f"{PUBLICATION}/x", json={"client_id": "client-de-x"}).json()["adresse"])
script["x_retire_droit"] = True
refused_back = bruno.get("/api/connexion/retour", params={"state": parse_qs(late.query)["state"][0], "code": "code-de-x"}, follow_redirects=False)
script.pop("x_retire_droit")
assert refused_back.status_code == 502 and not row("x"), "droit retiré pendant l'échange : X ne se branche pas"
r = alice.post(f"{PUBLICATION}/x", json={"client_id": "client-de-x"})
query = {k: v[0] for k, v in parse_qs(urlsplit(r.json()["adresse"]).query).items()}
assert alice.get("/api/connexion/retour", params={"state": query["state"], "code": "code-de-x"}, follow_redirects=False).status_code == 303 and row("x")
set_right("x", "agir")
assert json.loads(call("x", "compte")[1])["compte"] == "marque_x"
calls.clear()
wrong, text = call("x", "publier_post", texte="Bonjour X", images=["/w/1.jpg", "/w/3.png"])
assert not wrong and json.loads(text)["adresse"] == "https://x.com/marque_x/status/777", text
paths = [q.url.path for q in calls]
assert sum(p.endswith("/initialize") for p in paths) == 2 and sum(p.endswith("/finalize") for p in paths) == 2 and paths[-1] == "/2/tweets", paths
assert script["x_body"]["text"] == "Bonjour X" and len(script["x_body"]["media"]["media_ids"]) == 2
assert all(q.headers["authorization"] == "Bearer acces-x-1-0123456789" for q in calls)
assert "déjà en ligne" in call("x", "publier_post", texte="Bonjour X", images=["/w/1.jpg", "/w/3.png"])[1]
wrong, text = call("x", "publier_post", texte="Texte seul")
assert not wrong and "media" not in script["x_body"], "le texte seul suffit"
for args, why in (({"texte": "cinq", "images": ["/w/1.jpg"] * 5}, "4 au plus"), ({"texte": "  "}, "texte")):
    wrong, text = call("x", "publier_post", **args)
    assert wrong and why in text, text
FILES["/w/texte.txt"] = b"pas une image"
wrong, text = call("x", "publier_post", texte="Mauvais fichier", images=["/w/texte.txt"])
assert wrong and "JPEG, PNG ou WebP" in text, text
# Une image encore en traitement : on attend ; un échec se dit.
script["x_traitement"] = "succeeded"
wrong, text = call("x", "publier_post", texte="Image traitée", images=["/w/2.jpg"])
assert not wrong and script.get("x_lectures") == 2, (text, script.get("x_lectures"))
script["x_lectures"] = 0
script["x_traitement"] = "failed"
wrong, text = call("x", "publier_post", texte="Image ratée", images=["/w/3.png"])
assert wrong and "pas pu traiter" in text, text
script.pop("x_traitement")
script["x_panne"] = True
wrong, text = call("x", "publier_post", texte="Panne X")
assert wrong and "peut-être en ligne" in text, text
assert "incertain" in call("x", "publier_post", texte="Panne X")[1]
script["x_credit"] = True
wrong, text = call("x", "publier_post", texte="Sans crédit")
assert wrong and "crédit" in text and "navigateur" in text and "Rien n'est parti" in text, text
script.pop("x_credit")
assert not call("x", "publier_post", texte="Sans crédit")[0], "refusé : repart une fois le crédit revenu"
creds = json.loads(db.unseal(row("x")["jeton"]))
creds["expire"] = time.time() - 1
publication._save(A, "x", creds, creds["jeton"])
calls.clear()
assert not call("x", "publier_post", texte="Après deux heures")[0]
assert calls[0].url.path == "/2/oauth2/token" and calls[-1].headers["authorization"] == "Bearer acces-x-2-0123456789"
kept = json.loads(db.unseal(row("x")["jeton"]))
assert kept["renouvellement"] == "renouv-x-2-0123456789" and kept["expire"] > time.time(), "le nouveau renouvellement est gardé tout de suite"
# Compte remplacé pendant un appel : ce post ne part pas sur l'autre.
stale = {**kept, "expire": time.time() - 1}
publication._save(A, "x", {**kept, "id": "autre-compte"}, kept["jeton"])
try:
    asyncio.run(publication._x_token(A, stale))
except publication.TokenRefused:
    pass
else:
    raise AssertionError("un post pour A a pris le jeton de B")
publication._save(A, "x", kept, kept["jeton"])
print("7. X : accord PKCE sans copier de code, images par morceaux, jeton renouvelé")

# --- 8. Accord lisible, retrait, journaux ----------------------------------------------------------------------------------
asked = mcp.plain_request('Outil « instagram » : publier_post\n{"images": ["/opt/data/workspace/outputs/a.jpg"], "legende": "Mon nouveau post"}')
assert asked["demande"] == "Ton agent veut publier sur Instagram." and asked["apercu"] == ["Mon nouveau post"], asked
assert mcp.plain_request('Outil « x » : publier_post\n{}')["demande"] == "Ton agent veut publier sur X."
asked = mcp.plain_request('Outil « notion » : create_page\n{"title": "Mon post du jour", "body": "Le texte"}')
assert asked["demande"] == "Ton agent veut créer « Mon post du jour » dans Notion." and asked["apercu"] == ["Le texte"], asked
asked = mcp.plain_request('Outil « notion » : create_page\n{"body": "Le texte", "title": "Mon post du jour"}')
assert asked["demande"] == "Ton agent veut créer « Mon post du jour » dans Notion.", "le titre se lit par sa clé, pas par sa place"
assert mcp.plain_request('Outil « notion » : create_page\n{"body": "Le texte"}')["demande"] == "Ton agent veut créer quelque chose dans Notion."
assert alice.post(f"/api/agents/{A}/connections/tools/x/remove", json={}).status_code == 200 and not row("x")
wrong = agent.post("/agent-api/mcp/x", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
assert wrong.status_code == 404, "retiré : l'outil n'existe plus"
other = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for(B)}"}, raise_server_exceptions=False)
assert other.post("/agent-api/mcp/instagram", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).status_code == 404, "un agent ne se sert pas du compte d'un autre"
for secret in (IG_TOKEN, "acces-x-1-0123456789", "renouv-x-1-0123456789", "jeton-instagram-renouvele-0123456789"):
    assert not any(secret in line for line in LOGS), secret
print("8. carte lisible, retrait, aucun jeton dans les journaux")
print("publication : tout est vert")
assert connexion  # le retour passe bien par le module commun
