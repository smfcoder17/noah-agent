"""Notifications Web Push, vérifiées par des implémentations de référence : http_ece (celle de pywebpush et de
Mozilla) déchiffre ce que le serveur chiffre, PyJWT vérifie la signature VAPID.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt http_ece==1.2.1 'pyjwt[crypto]==2.10.1' && python /tests/push/push_test.py"
"""
import asyncio
import base64
import json
import os
import sys
import tempfile
import time

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import http_ece  # noqa: E402
import httpx  # noqa: E402
import jwt  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from apollo import auth, db, main, push  # noqa: E402

db.init()


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def device():
    """Un navigateur : sa paire de clés et son secret, comme PushManager.subscribe() les crée."""
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, b64(point), os.urandom(16)


# 1. Chiffrement aes128gcm : la référence déchiffre exactement le message.
key, p256dh, secret = device()
body = push.encrypt("Noah attend ton accord — é ✓".encode(), p256dh, b64(secret))
plain = http_ece.decrypt(body, private_key=key, auth_secret=secret, version="aes128gcm")
assert plain == "Noah attend ton accord — é ✓".encode(), plain
other, _, other_secret = device()
try:
    http_ece.decrypt(body, private_key=other, auth_secret=other_secret, version="aes128gcm")
    raise AssertionError("un autre appareil a lu le message")
except AssertionError:
    raise
except Exception:
    pass
print("1. chiffrement RFC 8291 : déchiffré par http_ece, illisible pour un autre appareil")

# 2. VAPID : jeton ES256 vérifié par PyJWT avec la clé publique annoncée, limité au service de push visé.
header = push.vapid_header("https://fcm.googleapis.com/fcm/send/abc")
token = header.split("t=")[1].split(",")[0]
k = header.split("k=")[1]
pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.urlsafe_b64decode(k + "=" * (-len(k) % 4)))
claims = jwt.decode(token, pub, algorithms=["ES256"], audience="https://fcm.googleapis.com")
assert claims["sub"].startswith(("https://", "mailto:")) and claims["exp"] > 0, claims
assert k == push.public_key() and push.public_key() == push.public_key(), "clé VAPID instable"
print("2. VAPID RFC 8292 : signature ES256 vérifiée par PyJWT, audience = le service de push")

# 3. De bout en bout : abonnement par l'API, envoi, le faux service de push reçoit un message que l'appareil lit.
received = []


FCM = "https://fcm.googleapis.com/fcm/send/"
flaky = {"n": 0}


def service(request: httpx.Request) -> httpx.Response:
    received.append(request)
    path = request.url.path
    if path.endswith("/mort"):
        return httpx.Response(410)
    if path.endswith("/instable"):  # erreur passagère au premier essai, puis accepté
        flaky["n"] += 1
        return httpx.Response(503) if flaky["n"] == 1 else httpx.Response(201)
    if "/refuse" in path:
        return httpx.Response(400, text="mauvaise clé")
    return httpx.Response(201)


push.transport = httpx.MockTransport(service)
push.RETRIES = (0, 0)
user = auth.create_user("alice", "motdepasse-a")
token_a = auth.new_session(user, "Pixel", "android")
app = TestClient(main.app, headers={"Authorization": f"Bearer {token_a}"})


def subscribe(client: TestClient, endpoint: str, p: str, s: bytes) -> int:
    return client.post("/api/push/subscription", json={"endpoint": endpoint, "p256dh": p, "auth": b64(s)}).status_code


assert subscribe(app, "http://evil/x", p256dh, secret) == 422
for internal in ("https://127.0.0.1/x", "https://launcher:9000/update/apply", "https://fcm.googleapis.com.evil.net/x",
                 "https://intranet.local/push"):
    assert subscribe(app, internal, p256dh, secret) == 400, internal
assert push.allowed_host("ntfy.sh") and not push.allowed_host("ntfy.sh.evil.net")  # app Android (UnifiedPush)
assert not push.allowed_host("ntfy.exemple.org")
os.environ["NOAH_PUSH_HOSTS"] = "ntfy.exemple.org"  # ntfy auto-hébergé, ajouté par l'administrateur
assert push.allowed_host("ntfy.exemple.org") and not push.allowed_host("evil.exemple.org")
del os.environ["NOAH_PUSH_HOSTS"]
print("3. seuls les services de push des navigateurs sont acceptés (pas d'adresse interne : pas de SSRF)")

assert subscribe(app, FCM + "vivant", p256dh, secret) == 200
assert app.get("/api/push/subscription").json()["abonne"]
k2, p2, s2 = device()
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'Vieux', 'web')}"}),
                 "https://updates.push.services.mozilla.com/wpush/v2/mort", p2, s2) == 200
k3, p3, s3 = device()
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'Mac', 'web')}"}),
                 "https://web.push.apple.com/instable", p3, s3) == 200
k4, p4, s4 = device()
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'PC', 'web')}"}),
                 "https://wns2-par02p.notify.windows.com/w/refuse", p4, s4) == 200
out = asyncio.run(push.send("Veille", "Le prix a baissé", urgent=True))
assert out == {"livres": 2, "echecs": 1, "morts": 1, "differes": 0}, out
r = [x for x in received if x.url.path.endswith("/vivant")][0]
assert r.headers["content-encoding"] == "aes128gcm" and r.headers["urgency"] == "high" and int(r.headers["ttl"]) > 0
assert r.headers["authorization"].startswith("vapid t=")
msg = json.loads(http_ece.decrypt(r.content, private_key=key, auth_secret=secret, version="aes128gcm"))
assert msg == {"titre": "Veille", "texte": "Le prix a baissé", "url": "/", "pour": push.session_tag(auth.digest(token_a))}, msg
assert len([x for x in received if x.url.path.endswith("/instable")]) == 2, "pas de nouvel essai après le 503"
assert len([x for x in received if x.url.path.endswith("/refuse")]) == 1, "erreur définitive réessayée"
wns = [x for x in received if x.url.host.endswith(".notify.windows.com")][0]
assert wns.headers["x-wns-type"] == "wns/raw" and "x-wns-type" not in r.headers, "en-tête X-WNS-Type (WNS seulement)"
with db.connect() as c:
    left = sorted(row["endpoint"] for row in c.execute("SELECT endpoint FROM push_subscriptions"))
assert not any(e.endswith("/mort") for e in left) and len(left) == 3, left
print("4. de bout en bout : déchiffré ; 503 réessayé puis livré ; 400 compté en échec ; 410 supprimé ; bilan exact")

# 5. Test depuis l'interface : le bilan dit la vérité (pas « envoyé » quand le service a refusé).
assert app.post("/api/push/test").json()["livres"] >= 1
print("5. /api/push/test rend livrés, échecs et morts")

# 5 bis. Le test ne vise que l'appareil qui le demande : le succès d'un autre appareil ne masque pas un échec ici.
k5, p5, s5 = device()
token_e = auth.new_session(user, "PC en échec", "web")
app_e = TestClient(main.app, headers={"Authorization": f"Bearer {token_e}"})
assert subscribe(app_e, "https://wns2-par02p.notify.windows.com/w/refuse2", p5, s5) == 200
out = app_e.post("/api/push/test").json()
assert out == {"livres": 0, "echecs": 1, "morts": 0, "differes": 0}, out
print("5 bis. test d'activation limité à l'appareil courant : son échec n'est pas masqué")

# 5 ter. Abonnement enregistré avant la liste des services (adresse interne) : jamais appelé, supprimé à l'envoi.
received.clear()
with db.connect() as c:
    c.execute("INSERT INTO push_subscriptions (endpoint, session, p256dh, auth) VALUES (?, ?, ?, ?)",
              ("https://launcher:9000/update/apply", auth.digest(token_e), p5, b64(s5)))
asyncio.run(push.send("Noah", "test"))
assert not [x for x in received if x.url.host == "launcher"], "adresse interne appelée"
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_subscriptions WHERE endpoint LIKE 'https://launcher%'").fetchone()
print("5 ter. ancien abonnement vers une adresse interne : jamais appelé, supprimé")

# 5 quater. Appareil déconnecté pendant l'attente d'un nouvel essai (après un 503) : le deuxième envoi ne part pas.
received.clear()
k6, p6, s6 = device()
token_f = auth.new_session(user, "Révoqué en route", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_f}"}),
                 "https://web.push.apple.com/lent", p6, s6) == 200
calls = {"n": 0}


def slow(request: httpx.Request) -> httpx.Response:
    received.append(request)
    if request.url.path.endswith("/lent"):
        calls["n"] += 1
        auth.drop_session(token_f)  # révoqué juste après le premier essai
        return httpx.Response(503)
    return httpx.Response(201)


push.transport = httpx.MockTransport(slow)
asyncio.run(push.send("Secret", "contenu confidentiel"))
assert calls["n"] == 1, f"{calls['n']} envois vers un appareil révoqué"
push.transport = httpx.MockTransport(service)
print("5 quater. appareil révoqué pendant l'attente d'un nouvel essai : rien ne repart vers lui")

# 5 quinquies. Abonnement renouvelé par le navigateur : l'ancien est remplacé (un seul par appareil).
k7, p7, s7 = device()
assert subscribe(app_e, "https://wns2-par02p.notify.windows.com/w/nouveau", p7, s7) == 200
with db.connect() as c:
    mine = [r["endpoint"] for r in c.execute("SELECT endpoint FROM push_subscriptions WHERE session = ?", (auth.digest(token_e),))]
assert mine == ["https://wns2-par02p.notify.windows.com/w/nouveau"], mine
print("5 quinquies. abonnement renouvelé : l'ancien est remplacé, un seul par appareil")

# 5 sexies. Retry-After respecté : secondes et date HTTP, plafonnés à 5 minutes.
from email.utils import format_datetime  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

assert push._retry_after("120", 2) == 120 and push._retry_after("3600", 2) == 3600
assert push._retry_after("999999", 2) == push.TTL  # au-delà de la durée de vie du message, attendre n'a plus de sens
later = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=90), usegmt=True)
assert 85 <= push._retry_after(later, 2) <= 90
assert push._retry_after("n'importe quoi", 7) == 7 and push._retry_after("", 7) == 7
print("5 sexies. Retry-After respecté (3600 s compris), en secondes ou en date HTTP, jusqu'à la durée de vie du message")

# 5 septies. L'interface compare l'abonnement du serveur à celui du navigateur : l'API rend l'adresse enregistrée.
assert app_e.get("/api/push/subscription").json()["endpoint"] == "https://wns2-par02p.notify.windows.com/w/nouveau"
print("5 septies. /api/push/subscription rend l'abonnement enregistré (réconciliation côté page)")

# 5 octies. Notification du serveur : au propriétaire seulement, jamais aux abonnements d'un autre compte.
bob = auth.create_user("bob", "motdepasse-b")
kb, pb, sb = device()
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(bob, 'Bob', 'web')}"}),
                 "https://fcm.googleapis.com/fcm/send/bob", pb, sb) == 200
received.clear()


async def notify_and_wait():
    push.notify("Noah attend ton accord", "secret d'Alice", urgent=True)
    await asyncio.sleep(0.5)

asyncio.run(notify_and_wait())
assert received and not [x for x in received if x.url.path.endswith("/bob")], "notification d'Alice envoyée à Bob"
print("5 octies. notification du serveur : au compte propriétaire seulement, rien chez un autre compte")

# 5 nonies. Même navigateur, autre compte entre deux essais : le message d'Alice ne part pas vers l'abonnement de Bob.
k8, p8, s8 = device()
token_g = auth.new_session(user, "Alice", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_g}"}), FCM + "partage", p8, s8) == 200
token_h = auth.new_session(bob, "Bob", "web")
swapped = {"n": 0}


def swap(request: httpx.Request) -> httpx.Response:
    received.append(request)
    if request.url.path.endswith("/partage"):
        swapped["n"] += 1
        if swapped["n"] == 1:  # Alice se déconnecte, Bob se connecte dans le même navigateur et s'abonne
            auth.drop_session(token_g)
            k9, p9, s9 = device()
            subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_h}"}), FCM + "partage", p9, s9)
            return httpx.Response(503)
    return httpx.Response(201)


push.transport = httpx.MockTransport(swap)
asyncio.run(push.send("Secret d'Alice", "contenu", user_id=user))
assert swapped["n"] == 1, f"{swapped['n']} envois : le message d'Alice est reparti vers l'abonnement de Bob"
with db.connect() as c:
    assert c.execute("SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND session = ?",
                     (FCM + "partage", auth.digest(token_h))).fetchone(), "l'abonnement de Bob a été supprimé"
push.transport = httpx.MockTransport(service)
print("5 nonies. autre compte dans le même navigateur entre deux essais : le message ne part pas chez lui")

# 5 decies. Retry-After long : l'envoi est gardé en base (survit à un redémarrage) et repris à l'heure dite.
k10, p10, s10 = device()
token_i = auth.new_session(user, "Plus tard", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_i}"}), FCM + "plustard", p10, s10) == 200
state = {"n": 0}


def later(request: httpx.Request) -> httpx.Response:
    received.append(request)
    if request.url.path.endswith("/plustard"):
        state["n"] += 1
        return httpx.Response(429, headers={"Retry-After": "3600"}) if state["n"] == 1 else httpx.Response(201)
    return httpx.Response(201)


push.transport = httpx.MockTransport(later)
out = asyncio.run(push.send("Plus tard", "contenu", session=auth.digest(token_i)))
assert out["differes"] == 1 and state["n"] == 1, out
with db.connect() as c:
    row = c.execute("SELECT not_before FROM push_queue WHERE endpoint LIKE '%plustard'").fetchone()
assert row and row["not_before"] > time.time() + 3500, "Retry-After de 3600 s non respecté"
assert asyncio.run(push.flush_queue()) == 0 and state["n"] == 1, "envoyé avant l'heure"
with db.connect() as c:  # une heure plus tard (après un redémarrage, la file est relue depuis la base)
    c.execute("UPDATE push_queue SET not_before = 0")
assert asyncio.run(push.flush_queue()) == 1 and state["n"] == 2
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_queue").fetchone()
# Arrêt du serveur pendant le dépilage : l'envoi réservé redevient dû après le bail, rien n'est perdu.
state["n"] = 0
out = asyncio.run(push.send("Plus tard", "deux", session=auth.digest(token_i)))
with db.connect() as c:
    c.execute("UPDATE push_queue SET not_before = 0")


def crash(request: httpx.Request) -> httpx.Response:
    raise KeyboardInterrupt  # le processus s'arrête au milieu de l'envoi


push.transport = httpx.MockTransport(crash)
try:
    asyncio.run(push.flush_queue())
except BaseException:
    pass
with db.connect() as c:
    kept = c.execute("SELECT not_before FROM push_queue WHERE endpoint LIKE '%plustard'").fetchone()
assert kept and kept["not_before"] > time.time() + 200, "envoi perdu à l'arrêt pendant le dépilage"
push.transport = httpx.MockTransport(later)
with db.connect() as c:
    c.execute("UPDATE push_queue SET not_before = 0")  # le bail est passé
assert asyncio.run(push.flush_queue()) == 1
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_queue").fetchone()
# 410 reçu lors d'un envoi différé : l'abonnement exact est supprimé aussi (plus annoncé comme actif).
k11, p11, s11 = device()
token_j = auth.new_session(user, "Mort plus tard", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_j}"}), FCM + "mortplustard", p11, s11) == 200
step = {"n": 0}


def dies(request: httpx.Request) -> httpx.Response:
    received.append(request)
    step["n"] += 1
    return httpx.Response(503, headers={"Retry-After": "120"}) if step["n"] == 1 else httpx.Response(410)


push.transport = httpx.MockTransport(dies)
assert asyncio.run(push.send("x", "y", session=auth.digest(token_j)))["differes"] == 1
with db.connect() as c:
    c.execute("UPDATE push_queue SET not_before = 0")
asyncio.run(push.flush_queue())
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_subscriptions WHERE endpoint LIKE '%mortplustard'").fetchone(), "abonnement mort gardé"
push.transport = httpx.MockTransport(service)
# Reporté deux fois 23 heures : la durée de vie compte depuis la création du message, pas depuis le dernier report.
k12, p12, s12 = device()
token_k = auth.new_session(user, "Vieux message", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_k}"}), FCM + "vieux", p12, s12) == 200
age = {"n": 0}


def busy(request: httpx.Request) -> httpx.Response:
    received.append(request)
    age["n"] += 1
    return httpx.Response(429, headers={"Retry-After": str(23 * 3600)})


push.transport = httpx.MockTransport(busy)
assert asyncio.run(push.send("x", "y", session=auth.digest(token_k)))["differes"] == 1
with db.connect() as c:
    created = c.execute("SELECT created FROM push_queue WHERE endpoint LIKE '%vieux'").fetchone()["created"]
    c.execute("UPDATE push_queue SET not_before = 0, created = ? WHERE endpoint LIKE '%vieux'", (created - 23 * 3600,))
asyncio.run(push.flush_queue())  # 23 h plus tard : nouveau report de 23 h refusé (le message aurait 46 h)
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_queue WHERE endpoint LIKE '%vieux'").fetchone(), "message reporté au-delà de 24 h"
# Un report accepté garde l'heure de création d'origine, et le TTL envoyé est la vie restante.
age["n"] = 0


def once_busy(request: httpx.Request) -> httpx.Response:
    received.append(request)
    age["n"] += 1
    return httpx.Response(429, headers={"Retry-After": "3600"}) if age["n"] == 1 else httpx.Response(201)


push.transport = httpx.MockTransport(once_busy)
asyncio.run(push.send("x", "y", session=auth.digest(token_k)))
with db.connect() as c:
    c.execute("UPDATE push_queue SET not_before = 0, created = created - 20 * 3600 WHERE endpoint LIKE '%vieux'")
    created = c.execute("SELECT created FROM push_queue WHERE endpoint LIKE '%vieux'").fetchone()["created"]
received.clear()
asyncio.run(push.flush_queue())
sent = [x for x in received if x.url.path.endswith("/vieux")]
assert sent and int(sent[0].headers["ttl"]) <= 4 * 3600, sent[0].headers["ttl"] if sent else "rien"
push.transport = httpx.MockTransport(service)
print("5 decies. Retry-After d'une heure : envoi gardé en base, repris à l'heure dite, pas avant ; un arrêt pendant le dépilage ne perd rien")

# 6. Clé VAPID : vingt premiers appels simultanés ne créent qu'une seule clé.
with db.connect() as c:
    c.execute("DELETE FROM settings WHERE key = 'vapid_key'")
import concurrent.futures  # noqa: E402

with concurrent.futures.ThreadPoolExecutor(20) as pool:
    keys = set(pool.map(lambda _: push.public_key(), range(20)))
assert len(keys) == 1 and push.public_key() in keys, len(keys)
print("6. clé VAPID créée une seule fois, même sous appels simultanés")

# 7. Appareil déconnecté : plus aucune notification pour lui.
received.clear()
auth.drop_session(token_a)
asyncio.run(push.send("Noah", "test"))
assert not [x for x in received if x.url.path.endswith("/vivant")]
with db.connect() as c:
    assert not c.execute("SELECT 1 FROM push_subscriptions WHERE endpoint LIKE '%vivant'").fetchone()
# 6 bis. Désinscription rejouée en retard : seul l'abonnement visé disparaît, pas celui qui l'a remplacé.
k13, p13, s13 = device()
token_l = auth.new_session(user, "Désinscrit", "android")
phone = TestClient(main.app, headers={"Authorization": f"Bearer {token_l}"})
assert subscribe(phone, "https://ntfy.sh/upAncien", p13, s13) == 200
assert subscribe(phone, "https://ntfy.sh/upNouveau", p13, s13) == 200  # réinscrit avant que le DELETE parte
assert phone.delete("/api/push/subscription", params={"endpoint": "https://ntfy.sh/upAncien"}).status_code == 200
assert phone.get("/api/push/subscription").json()["endpoint"] == "https://ntfy.sh/upNouveau", "nouvel abonnement supprimé"
# Service retiré de NOAH_PUSH_HOSTS après la mise en file : plus rien ne part vers lui.
os.environ["NOAH_PUSH_HOSTS"] = "ntfy.exemple.org"
k14, p14, s14 = device()
token_m = auth.new_session(user, "Auto-hébergé", "android")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_m}"}), "https://ntfy.exemple.org/upX", p14, s14) == 200
del os.environ["NOAH_PUSH_HOSTS"]
received.clear()
row = {"endpoint": "https://ntfy.exemple.org/upX", "session": auth.digest(token_m), "p256dh": p14, "auth": b64(s14)}
async def once():
    async with httpx.AsyncClient(transport=push.transport) as cl:
        return await push._send_one(cl, row, b"{}", False)
assert asyncio.run(once()) == "echec" and not received, "envoi vers un service retiré de la liste"
# Longue panne du service de push (503 sans Retry-After) : après 7 reports, toujours gardé tant qu'il reste du temps.
k15, p15, s15 = device()
token_n = auth.new_session(user, "Panne longue", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_n}"}), FCM + "panne", p15, s15) == 200
push.transport = httpx.MockTransport(lambda request: httpx.Response(503))
row = {"endpoint": FCM + "panne", "session": auth.digest(token_n), "p256dh": p15, "auth": b64(s15)}
async def late():
    async with httpx.AsyncClient(transport=push.transport) as cl:
        return await push._send_one(cl, row, b"{}", False, tries=7, created=time.time() - 2 * 3600)
assert asyncio.run(late()) == "differe", "alerte abandonnée après une panne de deux heures"
with db.connect() as c:
    c.execute("DELETE FROM push_queue WHERE endpoint LIKE ?", ("%panne",))
push.transport = httpx.MockTransport(service)
# Redémarrage pendant le premier envoi : le message était déjà en file, il sera repris.
k16, p16, s16 = device()
token_o = auth.new_session(user, "Premier envoi", "web")
assert subscribe(TestClient(main.app, headers={"Authorization": f"Bearer {token_o}"}), FCM + "premier", p16, s16) == 200
def boom(request):
    raise KeyboardInterrupt  # le processus s'arrête au milieu du premier envoi
push.transport = httpx.MockTransport(boom)
try:
    asyncio.run(push.send("Alerte", "importante", session=auth.digest(token_o)))
except BaseException:
    pass
with db.connect() as c:
    kept = c.execute("SELECT not_before FROM push_queue WHERE endpoint LIKE ?", ("%premier",)).fetchall()
assert kept, "message perdu par un arrêt pendant le premier envoi"
with db.connect() as c:
    c.execute("DELETE FROM push_queue WHERE endpoint LIKE ?", ("%premier",))
push.transport = httpx.MockTransport(service)
print("6 bis. désinscription en retard : seul l'abonnement visé ; service retiré de la liste : plus d'envoi")

print("7. appareil déconnecté : abonnement supprimé avec sa session, rien ne lui est envoyé")
print("push : tout est vert")
