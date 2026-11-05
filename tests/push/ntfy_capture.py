"""G4.4, côté conteneur : lancé par ntfy_test.sh. Trois étapes.

    cert  : certificat de ntfy.test (le serveur ne parle qu'en HTTPS à un service de push)
    send  : vrai code du serveur vers le vrai ntfy, puis lecture comme un distributeur ; l'appareil déchiffre
    scan  : la capture du tiers (journal trace de ntfy, sa base, ce qu'il redistribue) ne contient aucun contenu
"""
import asyncio
import base64
import datetime
import json
import os
import pathlib
import sys
import tempfile
import time

CAPTURE = pathlib.Path("/capture")
HOST = "ntfy.test"
TOPIC = "upCaptureG44ab"  # 14 caractères commençant par up : ce que ntfy reconnaît comme un sujet UnifiedPush
WITNESS_TOPIC = "upTemoinG44abc"
WITNESS = "TEMOIN-CLAIR-G44"  # envoyé en clair, exprès : la capture doit le voir, sinon elle ne regarde rien
TITLE, TEXT, CALL = "TITRE-PRIVE-G44", "TEXTE-PRIVE-G44", "APPEL-PRIVE-G44"


def cert() -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, HOST)])
    now = datetime.datetime.now(datetime.timezone.utc)
    built = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
             .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(hours=1))
             .not_valid_after(now + datetime.timedelta(days=1))
             .add_extension(x509.SubjectAlternativeName([x509.DNSName(HOST)]), critical=False)
             .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
             .sign(key, hashes.SHA256()))
    pathlib.Path("/certs/cert.pem").write_bytes(built.public_bytes(serialization.Encoding.PEM))
    pathlib.Path("/certs/key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                                 serialization.NoEncryption()))
    os.chmod("/certs/key.pem", 0o644)  # volume jetable, lu par le conteneur ntfy


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def send() -> None:
    os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
    os.environ.setdefault("LAUNCHER_KEY", "x")
    os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
    os.environ["NOAH_PUSH_HOSTS"] = HOST  # ntfy auto-hébergé, comme le réglerait l'administrateur
    os.environ["SSL_CERT_FILE"] = "/certs/cert.pem"
    sys.path.insert(0, "/app")
    import http_ece
    import httpx
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from fastapi.testclient import TestClient

    from apollo import auth, db, desktop, main, push

    db.init()
    base = f"https://{HOST}"
    for _ in range(60):
        try:
            if httpx.get(f"{base}/v1/health", verify="/certs/cert.pem", timeout=2).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    else:
        raise SystemExit("ntfy ne répond pas en HTTPS")

    # Témoin : la même capture doit voir ce message-là.
    r = httpx.post(f"{base}/{WITNESS_TOPIC}", content=WITNESS, verify="/certs/cert.pem")
    assert r.status_code == 200, (r.status_code, r.text)

    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    secret = os.urandom(16)
    owner = auth.create_user("alice", "motdepasse-a")
    token = auth.new_session(owner, "Pixel", "android")
    phone = TestClient(main.app, headers={"Authorization": f"Bearer {token}"})
    # ?up=1 : l'adresse que le distributeur ntfy donne à l'app (sans lui, ntfy prend le binaire pour une pièce jointe).
    r = phone.post("/api/push/subscription", json={"endpoint": f"{base}/{TOPIC}?up=1", "p256dh": b64(point), "auth": b64(secret)})
    assert r.status_code == 200, r.text

    out = asyncio.run(push.send(TITLE, TEXT, url=f"/#appel={CALL}", urgent=True, user_id=owner))
    assert out["livres"] == 1, f"le vrai ntfy n'a pas accepté l'envoi : {out}"

    async def from_server():
        push.notify(TITLE, TEXT, url=f"/#appel={CALL}", urgent=True, user_id=owner)
        desktop.notify(TITLE, TEXT)
        await asyncio.sleep(3)

    asyncio.run(from_server())

    # Ce que le distributeur du téléphone reçoit de ntfy.
    raw = httpx.get(f"{base}/{TOPIC}/json", params={"poll": "1", "since": "all"}, verify="/certs/cert.pem", timeout=10)
    assert raw.status_code == 200, raw.text
    (CAPTURE / "distribue.jsonl").write_bytes(raw.content)
    messages = [json.loads(line) for line in raw.text.splitlines() if line.strip()]
    assert len(messages) == 3, f"{len(messages)} messages chez ntfy, 3 attendus : {raw.text[:300]}"
    assert not seen(raw.content, TITLE), "contenu en clair dans ce que ntfy redistribue"
    other = ec.generate_private_key(ec.SECP256R1())
    for m in messages:
        assert m.get("encoding") == "base64", f"ntfy n'a pas vu du binaire : {m}"
        body = base64.b64decode(m["message"])
        clear = json.loads(http_ece.decrypt(body, private_key=key, auth_secret=secret, version="aes128gcm"))
        assert clear["titre"] == TITLE and clear["texte"] == TEXT, clear
        try:
            http_ece.decrypt(body, private_key=other, auth_secret=os.urandom(16), version="aes128gcm")
            raise AssertionError("un autre appareil a lu le message")
        except AssertionError:
            raise
        except Exception:
            pass
        (CAPTURE / "corps.bin").open("ab").write(body + b"\n")
    print(f"send : {len(messages)} messages acceptés par le vrai ntfy en TLS ; l'appareil les déchiffre, un autre non")


def forms(secret: str) -> list[bytes]:
    raw = secret.encode()
    out = [raw, raw.hex().encode()]
    for shift in range(3):
        for encode in (base64.b64encode, base64.urlsafe_b64encode):
            out.append(encode(raw[shift:]).rstrip(b"=")[:-2])
    return out


def seen(blob: bytes, secret: str) -> bool:
    return any(f in blob for f in forms(secret))


def scan() -> None:
    files = {p.name: p.read_bytes() for p in sorted(CAPTURE.iterdir())}
    log, cache = files["ntfy.log"], files["cache.db"]
    for name, blob in (("journal", log), ("base", cache)):
        assert WITNESS.encode() in blob, f"la capture ne voit pas le témoin en clair dans : {name}"
    assert log.count(TOPIC.encode()) >= 3 and cache.count(TOPIC.encode()) >= 3, "la capture ne contient pas les envois de Noah"
    assert b"aes128gcm" in log, "journal sans les en-têtes : la capture ne montre pas ce que le tiers reçoit"
    found = [(name, s) for name, blob in files.items() for s in (TITLE, TEXT, CALL) if seen(blob, s)]
    assert not found, f"contenu en clair chez le tiers : {found}"
    sizes = ", ".join(f"{name} {len(blob)} o" for name, blob in files.items())
    print(f"scan : témoin vu, envois de Noah vus, aucun contenu sous aucune forme ({sizes})")


{"cert": cert, "send": send, "scan": scan}[sys.argv[1]]()
