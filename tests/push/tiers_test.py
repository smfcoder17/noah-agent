"""G4.4, simulé : tout ce qu'un service de push (tiers) reçoit est capturé (adresse, en-têtes, corps) et aucun contenu de
message n'y figure, sous aucune forme. Le même contrôle sur un message en clair doit crier : le test regarde vraiment.
La preuve avec un vrai ntfy derrière un vrai TLS est dans ntfy_test.sh.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/mobile:/mobile:ro" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt http_ece==1.2.1 && python /tests/push/tiers_test.py"
"""
import asyncio
import base64
import json
import os
import pathlib
import re
import sys
import tempfile
import urllib.parse

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import http_ece  # noqa: E402
import httpx  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, desktop, main, push  # noqa: E402

db.init()
TITLE, TEXT, CALL = "TITRE-PRIVE-G44", "TEXTE-PRIVE-G44 ton dossier medical", "APPEL-PRIVE-G44"
SECRETS = (TITLE, TEXT, "TEXTE-PRIVE-G44", CALL)


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def forms(secret: str) -> list[bytes]:
    """Le secret tel quel, et encodé : base64 (aux trois alignements possibles dans un texte plus long), adresse, hexa."""
    raw = secret.encode()
    out = [raw, raw.hex().encode(), urllib.parse.quote(secret).encode()]
    for shift in range(3):
        for encode in (base64.b64encode, base64.urlsafe_b64encode):
            out.append(encode(raw[shift:]).rstrip(b"=")[:-2])
    return out


def leaks(request: httpx.Request) -> list[str]:
    """Ce que le tiers peut lire de cette requête. Le jeton VAPID (en base64 dans l'en-tête) est lu en clair aussi."""
    blob = str(request.url).encode() + b"\n" + request.content + b"\n"
    for name, value in request.headers.items():
        blob += name.encode() + b": " + value.encode() + b"\n"
        for part in re.findall(r"[A-Za-z0-9_-]{8,}", value):
            try:
                blob += base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)) + b"\n"
            except ValueError:
                pass
    return [s for s in SECRETS if any(f in blob for f in forms(s))]


# 0. Le contrôle lui-même : un message en clair, dans le corps, un en-tête ou l'adresse, est bien repéré.
for clear in (httpx.Request("POST", "https://ntfy.sh/up", content=json.dumps({"titre": TITLE}).encode()),
              httpx.Request("POST", "https://ntfy.sh/up", content=base64.b64encode(("x" + TEXT).encode())),
              httpx.Request("POST", "https://ntfy.sh/up", content=b"x", headers={"X-Title": TITLE}),
              httpx.Request("POST", f"https://ntfy.sh/up?message={urllib.parse.quote(TEXT)}", content=b"x")):
    assert leaks(clear), f"le contrôle ne voit rien dans {clear.url} {clear.content!r}"
print("0. contrôle : un message en clair (corps, base64, en-tête, adresse) est repéré")

captured: list[httpx.Request] = []
mode = {"retry": False, "n": 0}


def third_party(request: httpx.Request) -> httpx.Response:
    captured.append(request)
    mode["n"] += 1
    if mode["retry"] and mode["n"] == 1:
        return httpx.Response(429, headers={"Retry-After": "3600"})
    return httpx.Response(201)


push.transport = httpx.MockTransport(third_party)
push.RETRIES = (0, 0)
key = ec.generate_private_key(ec.SECP256R1())
point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
secret = os.urandom(16)
owner = auth.create_user("alice", "motdepasse-a")
token = auth.new_session(owner, "Pixel", "android")
phone = TestClient(main.app, headers={"Authorization": f"Bearer {token}"})
endpoint = "https://ntfy.sh/upTiersG44abcd"
assert phone.post("/api/push/subscription", json={"endpoint": endpoint, "p256dh": b64(point), "auth": b64(secret)}).status_code == 200


def opened(request: httpx.Request) -> dict:
    return json.loads(http_ece.decrypt(request.content, private_key=key, auth_secret=secret, version="aes128gcm"))


def check(label: str, count: int) -> None:
    """Le tiers a bien reçu un envoi (sinon le test ne regarderait rien), il n'y lit rien, l'appareil y lit tout."""
    assert len(captured) == count, f"{label} : {len(captured)} envois capturés, {count} attendus"
    for request in captured:
        assert str(request.url) == endpoint, request.url
        assert request.headers["content-encoding"] == "aes128gcm", request.headers
        found = leaks(request)
        assert not found, f"{label} : {found} en clair chez le tiers"
        message = opened(request)
        assert message["titre"] == TITLE and message["texte"].startswith("TEXTE-PRIVE-G44"), message
    captured.clear()
    mode.update(retry=False, n=0)


# 1. Les trois chemins du serveur vers le téléphone : envoi direct, notification de fond, notification de bureau.
assert asyncio.run(push.send(TITLE, TEXT, url=f"/#appel={CALL}", urgent=True, user_id=owner))["livres"] == 1
request = captured[0]
assert not leaks(request), f"en clair chez le tiers : {leaks(request)}"
assert opened(request)["url"] == f"/#appel={CALL}", "le rappel n'arrive pas à l'appareil"
check("envoi direct", 1)


async def from_server() -> None:
    push.notify(TITLE, TEXT, url=f"/#appel={CALL}", urgent=True, user_id=owner)
    desktop.notify(TITLE, TEXT)
    await asyncio.sleep(0.5)


asyncio.run(from_server())
check("notification du serveur", 2)
print("1. envoi direct, push.notify, desktop.notify : rien de lisible chez le tiers, l'appareil lit tout")

# 2. Envoi différé (Retry-After) : le renvoi depuis la base est chiffré lui aussi.
mode["retry"] = True
assert asyncio.run(push.send(TITLE, TEXT, session=auth.digest(token)))["differes"] == 1
with db.connect() as c:
    c.execute("UPDATE push_queue SET not_before = 0")
assert asyncio.run(push.flush_queue()) == 1
check("envoi différé", 2)
print("2. message repris plus tard par la file : aussi chiffré au renvoi")

# 3. Deux envois du même message ne se ressemblent pas ; un autre appareil ne peut pas les lire.
asyncio.run(push.send(TITLE, TEXT, user_id=owner))
asyncio.run(push.send(TITLE, TEXT, user_id=owner))
first, second = captured[0].content, captured[1].content
assert first != second and first[:16] != second[:16], "même chiffré pour le même message (sel réutilisé)"
other = ec.generate_private_key(ec.SECP256R1())
try:
    http_ece.decrypt(first, private_key=other, auth_secret=os.urandom(16), version="aes128gcm")
    raise AssertionError("un autre appareil a lu le message")
except AssertionError:
    raise
except Exception:
    pass
check("deux envois", 2)
print("3. chiffré différent à chaque envoi, illisible pour un autre appareil")

# 4. Aucune autre route vers un tiers : hors de push.py, les abonnements sont supprimés ou comptés, jamais utilisés pour
# envoyer ; le seul envoi de push.py passe par encrypt().
noah = pathlib.Path(main.__file__).parent
for path in noah.glob("*.py"):
    if path.name in ("push.py", "db.py"):
        continue
    source = path.read_text(encoding="utf-8")
    for line in source.splitlines():
        if "push_subscriptions" in line or "push_queue" in line:
            assert "DELETE FROM" in line or "SELECT p.endpoint FROM" in line, f"{path.name} : {line.strip()}"
    assert "ntfy" not in source.lower() and "fcm.googleapis" not in source, f"{path.name} parle à un service de push"
    assert "p256dh" not in source, f"{path.name} lit les clés d'un abonnement"
source = (noah / "push.py").read_text(encoding="utf-8")
posts = re.findall(r"client\.post\(.*\)", source)
assert len(posts) == 1 and "content=encrypt(payload" in posts[0], posts
assert not re.findall(r"(?<!router)\.(?:post|put|patch|request|stream)\(", source.replace("client.post(", "")), "autre envoi réseau dans push.py"
print("4. hors de push.py, un abonnement n'est que supprimé ou compté ; son unique envoi réseau a pour corps encrypt(payload)")

# 5. L'app : un message que la bibliothèque n'a pas pu déchiffrer n'est jamais affiché, et les clés sont celles du
# serveur (VAPID) ; un tiers ne peut donc pas faire afficher un texte de son choix.
java = pathlib.Path("/mobile/android/app/src/main/java/agent/noah/mobile/NoahPush.java").read_text(encoding="utf-8")
body = java[java.index("public void onMessage("):]
body = body[:body.index("private void handle(")]
guard = "if (!message.getDecrypted()) return;"
assert guard in body and body.index(guard) < body.index("show("), "un message non déchiffré est affiché"
# Avant de savoir à quelle session il est destiné, seul le type du message est lu, pour choisir un canal : ni son texte, ni son adresse.
assert body.count("getContent") == 1 and body.index(guard) < body.index("getContent"), "onMessage lit le contenu avant le contrôle"
assert 'generic.put("type",' in body and body.count("generic.put(") == 1, "la notification générique reprend plus que le type"
assert 'show(id, "Noah", "Nouvelle notification. Ouvre Noah pour la voir.", "/", generic);' in body, "la notification générique montre du contenu"
assert re.search(r'UnifiedPush\.register\(activity, ConstantsKt\.INSTANCE_DEFAULT, "Noah", vapid\)', java), "inscription sans clé VAPID"
print("5. app : message non déchiffré jamais affiché, inscription liée à la clé VAPID du serveur")

print("tiers : tout est vert")
