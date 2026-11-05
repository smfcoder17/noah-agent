"""G4.5, côté serveur : ce qu'il demande à la fenêtre de l'app de garder. Un cookie avec une durée de vie est écrit par la
WebView sur le disque, en clair : la session de l'app n'en reçoit jamais, seul le navigateur (témoin) en reçoit un.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/android/jeton_test.py"
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from apollo import auth, db, main  # noqa: E402

db.init()
auth.create_user("alice", "motdepasse-a")
CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"
APP = CHROME + " NoahApp/0.1.0 Android"  # MainActivity : setAppendedUserAgentString("NoahApp/" + version + " Android")
DESKTOP_LIKE = "Mozilla/5.0 NoahApp-site Android"  # ne doit pas passer pour l'app


def login(agent: str) -> tuple[str, str]:
    client = TestClient(main.app, headers={"User-Agent": agent})
    r = client.post("/api/login", json={"username": "alice", "password": "motdepasse-a"})
    assert r.status_code == 200, r.text
    return r.json()["token"], r.headers.get("set-cookie", "")


def platform(token: str) -> str:
    with db.connect() as c:
        return c.execute("SELECT platform FROM sessions WHERE token = ?", (auth.digest(token),)).fetchone()["platform"]


def lasting(cookie: str) -> bool:
    lowered = cookie.lower()
    return "max-age" in lowered or "expires" in lowered


# Témoin : un navigateur garde son cookie 30 jours, le contrôle sait donc voir une durée de vie.
token, cookie = login(CHROME)
assert cookie.startswith("apollo_session=") and lasting(cookie), cookie
assert platform(token) == "web"
token, cookie = login(DESKTOP_LIKE)
assert lasting(cookie) and platform(token) == "web", cookie
print("1. navigateur : cookie de 30 jours, session « web » (témoin)")

# Reconnexion dans la fenêtre de l'app (déconnexion puis mot de passe dans l'interface).
token, cookie = login(APP)
assert cookie.startswith("apollo_session="), f"la fenêtre de l'app doit rester connectée : {cookie!r}"
assert not lasting(cookie), f"cookie écrit en clair sur le disque du téléphone : {cookie}"
assert "httponly" in cookie.lower(), cookie
assert platform(token) == "android", platform(token)
print("2. fenêtre de l'app : cookie de session sans durée de vie, session « android »")


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

print("jeton : tout est vert")
