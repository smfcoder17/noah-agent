"""G4.5, côté serveur : ce qu'il demande à la fenêtre de l'app de garder. La WebView écrit tous ses cookies sur le disque,
en clair, même sans durée de vie (reproduit sur émulateur) : le jeton d'appareil n'y va donc jamais. L'app l'échange contre
une session de fenêtre, courte, qui tombe avec lui, et qui n'ouvre rien de durable.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/android/jeton_test.py"
"""
import base64
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main, push, updates  # noqa: E402

db.init()
auth.create_user("alice", "motdepasse-a")
CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"
APP = CHROME + " NoahApp/0.1.0 Android"  # MainActivity : setAppendedUserAgentString("NoahApp/" + version + " Android")
DESKTOP_LIKE = "Mozilla/5.0 NoahApp-site Android"  # ne doit pas passer pour l'app


def login(agent: str) -> tuple[str, str]:
    client = TestClient(main.app, headers={"User-Agent": agent})
    r = client.post("/api/login", json={"username": "alice", "password": "motdepasse-a"})
    assert r.status_code == 200, r.text
    cookie = r.headers.get("set-cookie", "")
    # Navigateur : le jeton n'est que dans le cookie (public_test). App : il est aussi dans la réponse.
    return r.json().get("token") or cookie.split(";", 1)[0].split("=", 1)[1], cookie


def platform(token: str) -> str:
    with db.connect() as c:
        return c.execute("SELECT platform FROM sessions WHERE token = ?", (auth.digest(token),)).fetchone()["platform"]


def lasting(cookie: str) -> bool:
    lowered = cookie.lower()
    return "max-age" in lowered or "expires" in lowered


# Témoin : un navigateur garde son cookie 30 jours, le contrôle sait donc voir une durée de vie.
token, cookie = login(CHROME)
assert cookie.startswith("noah_session=") and lasting(cookie), cookie
assert platform(token) == "web"
token, cookie = login(DESKTOP_LIKE)
assert lasting(cookie) and platform(token) == "web", cookie
print("1. navigateur : cookie de 30 jours, session « web » (témoin)")

# Reconnexion dans la fenêtre de l'app (déconnexion puis mot de passe dans l'interface).
token, cookie = login(APP)
assert cookie.startswith("noah_session="), f"la fenêtre de l'app doit rester connectée : {cookie!r}"
assert not lasting(cookie), f"cookie écrit en clair sur le disque du téléphone : {cookie}"
assert "httponly" in cookie.lower(), cookie
assert platform(token) == "android", platform(token)
assert token not in cookie, f"le jeton d'appareil est parti dans le cookie de la fenêtre : {cookie}"
print("2. fenêtre de l'app : cookie sans durée de vie, session « android », et ce n'est pas le jeton d'appareil")


# Prolongation d'une session : le cookie n'est pas réécrit avec une durée de vie dans la fenêtre de l'app.
def renewed_cookie(agent: str, session: str) -> str:
    past = datetime.now(timezone.utc) - timedelta(days=2)
    with db.connect() as c:
        c.execute("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token = ?",
                  (past.isoformat(), (past + timedelta(days=3)).isoformat(), auth.digest(session)))
    client = TestClient(main.app, headers={"User-Agent": agent}, cookies={auth.COOKIE: session})
    r = client.get("/api/push/key")
    assert r.status_code == 200, r.text
    with db.connect() as c:
        left = datetime.fromisoformat(c.execute("SELECT expires_at FROM sessions WHERE token = ?", (auth.digest(session),)).fetchone()["expires_at"])
    assert left - datetime.now(timezone.utc) > timedelta(days=20), "session non prolongée : ce contrôle ne regarde rien"
    return r.headers.get("set-cookie", "")


browser_token, _ = login(CHROME)
assert lasting(renewed_cookie(CHROME, browser_token)), "témoin : le navigateur devrait recevoir un cookie prolongé"
assert not lasting(renewed_cookie(APP, token)), "prolongation : cookie écrit en clair sur le disque du téléphone"
print("3. session prolongée : cookie prolongé pour le navigateur (témoin), pas pour la fenêtre de l'app")


# --- Session de fenêtre : le jeton d'appareil reste dans le Keystore, la WebView ne reçoit que ça ------------------------
FENETRE = "/api/devices/self/fenetre"
SOURCE = {"Origin": "http://testserver"}  # écritures par cookie : le contrôle anti-CSRF veut une page de Noah


def device(name: str = "Pixel") -> str:
    return auth.new_session(1, name, "android")


def bearer(session: str) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {session}"})


def in_window(session: str) -> TestClient:
    """Ce que fait la WebView : le cookie seul, depuis une page de Noah."""
    return TestClient(main.app, headers={"User-Agent": APP, **SOURCE}, cookies={auth.COOKIE: session})


def open_window(parent: str) -> str:
    r = bearer(parent).post(FENETRE)
    assert r.status_code == 200, r.text
    assert "set-cookie" not in r.headers, "l'échange ne pose aucun cookie : c'est l'app qui range ce qu'elle reçoit"
    return r.json()["jeton"]


def window_row(session: str):
    with db.connect() as c:
        return c.execute("SELECT * FROM window_sessions WHERE token = ?", (auth.digest(session),)).fetchone()


def set_window(session: str, **values) -> None:
    with db.connect() as c:
        for column, value in values.items():
            c.execute(f"UPDATE window_sessions SET {column} = ? WHERE token = ?", (value.isoformat(), auth.digest(session)))


def alive(session: str) -> bool:
    return in_window(session).get("/api/me").status_code == 200


def time_left(session: str) -> timedelta:
    return datetime.fromisoformat(window_row(session)["expires_at"]) - datetime.now(timezone.utc)


def public_id(session: str) -> str:
    return auth.device_id(auth.digest(session))


# L'échange : le jeton rendu n'est pas celui de l'appareil, il connecte, et la base n'en garde que l'empreinte.
parent = device()
window = open_window(parent)
assert window != parent and len(window) >= 40
assert in_window(window).get("/api/me").json()["username"] == "alice"
assert window_row(window)["parent"] == auth.digest(parent)
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM window_sessions WHERE token = ?", (window,)).fetchone(), "jeton en clair en base"
assert bearer(parent).post(FENETRE).json()["duree"] == auth.WINDOW_IDLE.total_seconds()
print("4. échange : jeton distinct, connecté, seule son empreinte en base")

# Courte et glissante : au plus quelques heures sans usage, jamais les 30 jours d'une session normale.
assert timedelta(minutes=30) <= auth.WINDOW_IDLE <= timedelta(hours=4), auth.WINDOW_IDLE
assert time_left(window) <= auth.WINDOW_IDLE, time_left(window)
now = datetime.now(timezone.utc)
set_window(window, last_seen=now - timedelta(minutes=10), expires_at=now + timedelta(minutes=1))
r = in_window(window).get("/api/me")
assert r.status_code == 200 and "set-cookie" not in r.headers, r.headers
assert auth.WINDOW_IDLE - timedelta(minutes=1) < time_left(window) <= auth.WINDOW_IDLE, "l'usage doit la prolonger, de la durée courte"
# La branche de current_user qui prolonge à 30 jours : mêmes dates qu'au test 3, où une session normale gagne 30 jours.
set_window(window, last_seen=now - timedelta(days=2), expires_at=now + timedelta(hours=1), created_at=now - timedelta(hours=1))
assert alive(window) and time_left(window) <= auth.WINDOW_IDLE, f"prolongée au-delà de la durée courte : {time_left(window)}"
set_window(window, expires_at=now - timedelta(seconds=1))
assert in_window(window).get("/api/me").status_code == 401, "expirée, elle ne doit plus connecter"
print("5. glissante d'après l'usage, jamais au-delà de la durée courte ; expirée, refusée")

# Une copie volée du cookie ne se garde pas en vie indéfiniment, même utilisée sans arrêt.
window = open_window(parent)
now = datetime.now(timezone.utc)
set_window(window, created_at=now - auth.WINDOW_LONGEST + timedelta(minutes=30), last_seen=now - timedelta(minutes=10))
assert alive(window) and time_left(window) <= timedelta(minutes=30), time_left(window)
set_window(window, created_at=now - auth.WINDOW_LONGEST - timedelta(minutes=1), last_seen=now - timedelta(minutes=10), expires_at=now + timedelta(hours=1))
assert not alive(window), "le plafond doit tenir même si la date d'expiration dit autre chose"
print("6. plafond absolu : une copie utilisée sans arrêt finit par tomber")

# Un flux ouvert (chat, écran) compte comme un usage : le renouvellement du cookie ne le coupe pas.
window = open_window(parent)
now = datetime.now(timezone.utc)
set_window(window, last_seen=now - timedelta(minutes=10), expires_at=now + timedelta(minutes=1))
assert auth.still_valid(window) and time_left(window) > timedelta(minutes=30), time_left(window)
set_window(window, expires_at=now - timedelta(seconds=1))
assert not auth.still_valid(window)
print("7. flux ouvert : il prolonge sa session tant qu'il tourne, et s'arrête si elle est tombée")

# Renouveler ne coupe pas la session précédente : un flux ou un appel ouvert avec elle continue.
first, second = open_window(parent), open_window(parent)
assert alive(first) and alive(second) and first != second
print("8. renouvellement : la session précédente reste valable pour ce qu'elle a déjà ouvert")


# Elle tombe avec l'appareil parent, par tous les chemins.
def revoked_by(how, name: str) -> None:
    mine = device(name)
    held = open_window(mine)
    assert alive(held)
    how(mine)
    assert not alive(held), f"session de fenêtre encore valable après : {name}"
    assert not auth.still_valid(held), f"flux encore ouvert après : {name}"


other = device("Autre")
revoked_by(lambda t: bearer(other).request("DELETE", f"/api/devices/{public_id(t)}", json={"motdepasse": "motdepasse-a"}).raise_for_status(), "Réglages > Appareils")
revoked_by(lambda t: bearer(t).delete("/api/devices/self").raise_for_status(), "oublier ce serveur")
revoked_by(lambda t: auth.drop_session(t), "drop_session")
revoked_by(lambda t: auth.revoke_others(1, other), "déconnecter tous les autres")
revoked_by(lambda t: auth.set_password(1, "motdepasse-a", keep=auth.digest(other)), "changement de mot de passe")


def parent_expired(session: str) -> None:
    with db.connect() as c:
        c.execute("UPDATE sessions SET expires_at = ? WHERE token = ?",
                  ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), auth.digest(session)))


revoked_by(parent_expired, "parent expiré")
print("9. appareil parent révoqué ou expiré, par tous les chemins : la session de fenêtre et ses flux tombent")

# Se déconnecter dans la fenêtre déconnecte l'appareil : sinon l'app rouvrirait la session toute seule.
mine = device("Déconnexion")
held = open_window(mine)
assert in_window(held).post("/api/logout").status_code == 200
assert not alive(held) and bearer(mine).post(FENETRE).status_code == 401
mine = device("Oubli")
held = open_window(mine)
assert in_window(held).delete("/api/devices/self").status_code == 200
assert not alive(held) and bearer(mine).post(FENETRE).status_code == 401
print("10. déconnexion ou oubli depuis la fenêtre : l'appareil parent part aussi, plus d'échange possible")

# Absente de la liste : le téléphone reste un seul appareil, marqué « actuel » vu depuis sa fenêtre.
mine = device("Liste")
before = bearer(mine).get("/api/devices").json()["appareils"]
held_three = [open_window(mine) for _ in range(3)]
after = in_window(held_three[0]).get("/api/devices").json()["appareils"]
assert sorted(d["id"] for d in after) == sorted(d["id"] for d in before), "une session de fenêtre se voit comme un appareil"
assert [d["id"] for d in after if d["actuel"]] == [public_id(mine)], after
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM sessions WHERE token = ?", (auth.digest(held_three[0]),)).fetchone()
print("11. liste des appareils : aucune session de fenêtre, le parent est l'appareil actuel")

# Elle ne se reproduit pas : ni par en-tête, ni par cookie. Une session de navigateur non plus (Bearer d'appareil exigé).
held = open_window(mine)
r = bearer(held).post(FENETRE)
assert r.status_code == 403, f"session de fenêtre créée depuis une session de fenêtre : {r.status_code}"
r = in_window(held).post(FENETRE)
assert r.status_code == 403, f"session de fenêtre créée par cookie : {r.status_code}"
browser_token, _ = login(CHROME)
r = TestClient(main.app, headers=SOURCE, cookies={auth.COOKIE: browser_token}).post(FENETRE)
assert r.status_code == 403, f"échange par cookie d'une session de navigateur : {r.status_code}"
assert TestClient(main.app).post(FENETRE).status_code == 401
print("12. échange refusé à une session de fenêtre et à un simple cookie")

# Rien de durable depuis la fenêtre : ni appairer, ni créer un compte sans le mot de passe. Témoin : le jeton d'appareil le peut.
OWNED = [("POST", "/api/pairing", None), ("DELETE", "/api/pairing", None), ("GET", "/api/pairing/pending", None)]
flow = TestClient(main.app).post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"}).json()
public = flow["adresse"].rsplit("=", 1)[1]
for method, path, body in OWNED + [("GET", f"/api/pairing/flow/{public}", None),
                                   ("POST", f"/api/pairing/flow/{public}/autoriser", {"verification": ""}),
                                   ("POST", f"/api/pairing/flow/{public}/refuser", {"verification": ""})]:
    r = in_window(held).request(method, path, json=body)
    assert r.status_code == 403, f"{method} {path} ouvert à une session de fenêtre : {r.status_code} {r.text}"
    assert "navigateur" in r.json()["detail"], r.text  # l'interface affiche cette phrase telle quelle
    r = bearer(held).request(method, path, json=body)
    assert r.status_code == 403, f"{method} {path} ouvert à une session de fenêtre par en-tête : {r.status_code}"
for method, path, body in OWNED:
    r = bearer(mine).request(method, path, json=body)
    assert r.status_code == 200, f"témoin : {method} {path} doit répondre 200 à une vraie session : {r.status_code} {r.text}"
# Un compte de plus : jamais sans le mot de passe, qu'un cookie de fenêtre ou un jeton volés n'ont pas. Pas de preuve gardée pour une fenêtre.
INTRUS = {"username": "intrus", "password": "motdepasse-intrus"}
for who in (in_window(held), bearer(held), bearer(mine)):
    r = who.post("/api/profiles", json=INTRUS)
    assert r.status_code == 428, f"compte créé sans le mot de passe : {r.status_code} {r.text}"
    assert who.post("/api/profiles", json={**INTRUS, "motdepasse": "faux-mot-de-passe"}).status_code == 400
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM users WHERE username = 'intrus'").fetchone()
assert in_window(held).post("/api/profiles", json={**INTRUS, "motdepasse": "motdepasse-a"}).status_code == 200, "depuis l'app, avec le mot de passe"
assert in_window(held).post("/api/profiles", json={"username": "intrus2", "password": "motdepasse-intrus"}).status_code == 428, "preuve gardée pour une fenêtre"
with db.connect() as c:
    c.execute("DELETE FROM users WHERE username = 'intrus'")
r = bearer(mine).get(f"/api/pairing/flow/{public}")
assert r.status_code == 200, f"la demande n'a pas survécu aux refus ci-dessus : {r.text}"
print("13. appairage refusé depuis la fenêtre ; création de compte seulement avec le mot de passe, redemandé à chaque fois")

# Révoquer : ce que permet une session normale, pas plus. « Tous les autres » garde son propre appareil.
mine, a, b = device("Moi"), device("A"), device("B")
held = open_window(mine)
assert in_window(held).post("/api/devices/others/revoke").status_code == 428, "cookie de fenêtre volé : pas de révocation sans le mot de passe"
assert bearer(a).get("/api/me").status_code == 200 and bearer(b).get("/api/me").status_code == 200
assert in_window(held).post("/api/devices/others/revoke", json={"motdepasse": "motdepasse-a"}).status_code == 200
assert alive(held), "« déconnecter les autres » depuis la fenêtre a coupé son propre appareil"
assert bearer(mine).get("/api/me").status_code == 200
assert bearer(a).get("/api/me").status_code == 401 and bearer(b).get("/api/me").status_code == 401
c2 = device("C")
assert in_window(held).delete(f"/api/devices/{public_id(c2)}").status_code == 428
assert bearer(c2).get("/api/me").status_code == 200
assert in_window(held).request("DELETE", f"/api/devices/{public_id(c2)}", json={"motdepasse": "motdepasse-a"}).status_code == 200
assert bearer(c2).get("/api/me").status_code == 401
auth.create_user("bob", "motdepasse-b")
theirs = auth.new_session(2, "Bob", "android")
assert in_window(held).delete(f"/api/devices/{public_id(theirs)}").status_code == 404, "appareil d'un autre compte révoqué"
assert bearer(theirs).get("/api/me").status_code == 200
assert in_window(held).delete(f"/api/devices/{public_id(held)}").status_code == 404, "une fenêtre n'est pas un appareil"
print("14. révocation : avec le mot de passe, son propre appareil gardé, un autre compte intouchable")

# Le mot de passe changé depuis la fenêtre garde cet appareil, pas seulement la session de fenêtre.
other = device("Autre")
r = in_window(held).post("/api/me/password", json={"actuel": "motdepasse-a", "nouveau": "motdepasse-a"})
assert r.status_code == 200, r.text
assert alive(held) and bearer(mine).get("/api/me").status_code == 200, "changer son mot de passe a déconnecté ce téléphone"
assert bearer(other).get("/api/me").status_code == 401
print("15. changement de mot de passe depuis la fenêtre : ce téléphone reste relié, les autres non")

# Notifications : la fenêtre parle pour son appareil. Un abonnement ne s'accroche jamais à une session qui va mourir.
endpoint = "https://ntfy.sh/upTemoin"
point = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
keys = {"p256dh": base64.urlsafe_b64encode(point).decode().rstrip("="), "auth": "AAAAAAAAAAAAAAAAAAAAAA"}
r = in_window(held).post("/api/push/subscription", json={"endpoint": endpoint, **keys})
assert r.status_code == 200, r.text
with db.connect() as c:
    assert c.execute("SELECT session FROM push_subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()["session"] == auth.digest(mine)
seen = in_window(held).get("/api/push/subscription").json()
assert seen["abonne"] and seen["pour"] == push.session_tag(auth.digest(mine)), seen
assert bearer(mine).get("/api/push/subscription").json() == seen, "le service d'arrière-plan et la fenêtre ne voient pas le même abonné"
assert in_window(held).delete("/api/push/subscription").status_code == 200
assert not bearer(mine).get("/api/push/subscription").json()["abonne"]
print("16. notifications : abonnement et identité sont ceux de l'appareil, depuis la fenêtre comme depuis le service")

# Reconnexion par la fenêtre de l'app : ce qu'elle reçoit en cookie est bien une session de fenêtre.
token, cookie = login(APP)
value = cookie.split(";", 1)[0].split("=", 1)[1]
assert window_row(value) and window_row(value)["parent"] == auth.digest(token), cookie
print("17. mot de passe tapé dans la fenêtre : cookie = session de fenêtre, le jeton d'appareil n'y est pas")

# QR scanné dans la fenêtre de l'app (type « web ») : même règle, pas le cookie de 30 jours.
holder = device("Titulaire")
link = bearer(holder).post("/api/pairing").json()["adresse"].rsplit("=", 1)[1]
app_client = TestClient(main.app, headers={"User-Agent": APP})
claim = app_client.post("/api/pairing/claim", json={"code": link}).json()
pending = bearer(holder).get("/api/pairing/pending").json()["demandes"][0]["id"]
r = bearer(holder).post(f"/api/pairing/flow/{pending}/autoriser", json={"verification": claim["verification"], "motdepasse": "motdepasse-a"})
assert r.status_code == 200, r.text
r = app_client.post("/api/pairing/flow/poll", json={"sondage": claim["sondage"]})
assert r.status_code == 200 and r.json()["token"], r.text
cookie = r.headers.get("set-cookie", "")
assert not lasting(cookie) and r.json()["token"] not in cookie, cookie
assert window_row(cookie.split(";", 1)[0].split("=", 1)[1]), cookie
print("18. QR scanné dans la fenêtre : session de fenêtre en cookie, pas de cookie de 30 jours")

# Pendant une mise à jour du serveur, l'app s'ouvre quand même : l'échange n'est pas une donnée à garder.
updates.maintenance = True
try:
    assert bearer(mine).post(FENETRE).status_code == 200, "échange refusé pendant une mise à jour : téléphone bloqué sur la page d'attente"
finally:
    updates.maintenance = False
print("19. mise à jour en cours : l'échange reste possible")

print("jeton : tout est vert")
