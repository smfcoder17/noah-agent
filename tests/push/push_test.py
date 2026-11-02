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


def service(request: httpx.Request) -> httpx.Response:
    received.append(request)
    return httpx.Response(410 if "mort" in str(request.url) else 201)


push.transport = httpx.MockTransport(service)
user = auth.create_user("alice", "motdepasse-a")
token_a = auth.new_session(user, "Pixel", "android")
app = TestClient(main.app, headers={"Authorization": f"Bearer {token_a}"})
assert app.post("/api/push/subscription", json={"endpoint": "http://evil", "p256dh": p256dh, "auth": b64(secret)}).status_code == 422
assert app.post("/api/push/subscription", json={"endpoint": "https://push.example/vivant", "p256dh": p256dh,
                                                "auth": b64(secret)}).status_code == 200
assert app.get("/api/push/subscription").json()["abonne"]
k2, p2, s2 = device()
token_b = auth.new_session(user, "Vieux", "web")
TestClient(main.app, headers={"Authorization": f"Bearer {token_b}"}).post(
    "/api/push/subscription", json={"endpoint": "https://push.example/mort", "p256dh": p2, "auth": b64(s2)})
assert asyncio.run(push.send("Veille", "Le prix a baissé", urgent=True)) == 1
r = [x for x in received if x.url.path == "/vivant"][0]
assert r.headers["content-encoding"] == "aes128gcm" and r.headers["urgency"] == "high" and int(r.headers["ttl"]) > 0
assert r.headers["authorization"].startswith("vapid t=")
msg = json.loads(http_ece.decrypt(r.content, private_key=key, auth_secret=secret, version="aes128gcm"))
assert msg == {"titre": "Veille", "texte": "Le prix a baissé", "url": "/"}, msg
with db.connect() as c:
    left = [row["endpoint"] for row in c.execute("SELECT endpoint FROM push_subscriptions")]
assert left == ["https://push.example/vivant"], left
print("3. de bout en bout : message reçu et déchiffré ; abonnement mort (410) supprimé")

# 4. Appareil déconnecté : plus aucune notification pour lui.
received.clear()
auth.drop_session(token_a)
assert asyncio.run(push.send("Noah", "test")) == 0 and not received
with db.connect() as c:
    assert c.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0] == 0
print("4. appareil déconnecté : abonnement supprimé avec sa session, rien n'est envoyé")
print("push : tout est vert")
