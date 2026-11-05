"""Serveur d'essai de tests/real/comptes_ecrans.mjs : le vrai serveur et la vraie interface compilée, une base neuve, et un petit serveur
de courriel en TLS à côté. COMPTES_MODE=vide : aucun compte (écran du code d'installation). COMPTES_MODE=temporaire : premier compte
choisi au déploiement. Sinon : un propriétaire et un profil déjà là. Les codes reçus se lisent sur /boite, sur le port 8081."""
import base64
import datetime
import email
import email.policy
import http.server
import json
import os
import re
import socket
import ssl
import tempfile
import threading

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ["NOAH_WEB_DIR"] = "/web"
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["NOAH_UPDATE_MANIFEST"] = "http://127.0.0.1:9/manifeste"
MODE = os.environ.get("COMPTES_MODE", "")
if MODE == "vide":
    os.environ["NOAH_SETUP_CODE"] = "BCDFGHJKLMNP"
if MODE == "temporaire":
    os.environ.update({"NOAH_ADMIN_USER": "patronne", "NOAH_ADMIN_PASSWORD": "provisoire-tres-long"})

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

folder = tempfile.mkdtemp()
key = ec.generate_private_key(ec.SECP256R1())
now = datetime.datetime.now(datetime.timezone.utc)
name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "localhost")])
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False).sign(key, hashes.SHA256()))
with open(f"{folder}/c.pem", "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))
with open(f"{folder}/k.pem", "wb") as f:
    f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
os.environ["SSL_CERT_FILE"] = f"{folder}/c.pem"
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(f"{folder}/c.pem", f"{folder}/k.pem")
mails: list[dict] = []


def serve_smtp(conn) -> None:
    buffer = b""
    secure = False
    rcpt: list[str] = []

    def line() -> bytes:
        nonlocal buffer
        while b"\r\n" not in buffer:
            chunk = conn.recv(4096)
            if not chunk:
                raise OSError
            buffer += chunk
        out, buffer = buffer.split(b"\r\n", 1)
        return out

    conn.sendall(b"220 essai\r\n")
    while True:
        text = line().decode("latin-1")
        verb = text.split(" ", 1)[0].upper()
        if verb == "EHLO":
            conn.sendall(b"250-essai\r\n250-AUTH PLAIN\r\n250 OK\r\n" if secure else b"250-essai\r\n250-STARTTLS\r\n250 OK\r\n")
        elif verb == "STARTTLS":
            conn.sendall(b"220 vas-y\r\n")
            conn = context.wrap_socket(conn, server_side=True)
            secure, buffer = True, b""
        elif verb == "AUTH":
            base64.b64decode(text.split(" ")[2])
            conn.sendall(b"235 ok\r\n")
        elif verb == "RCPT":
            rcpt.append(re.search(r"<(.*)>", text).group(1))
            conn.sendall(b"250 ok\r\n")
        elif verb == "DATA":
            conn.sendall(b"354 vas-y\r\n")
            rows = []
            while (row := line()) != b".":
                rows.append(row)
            parsed = email.message_from_bytes(b"\r\n".join(rows), policy=email.policy.default)
            mails.append({"vers": rcpt[-1], "sujet": str(parsed["Subject"])})
            conn.sendall(b"250 ok\r\n")
        elif verb == "QUIT":
            conn.sendall(b"221 salut\r\n")
            return
        else:
            conn.sendall(b"250 ok\r\n")


def smtp_loop() -> None:
    listener = socket.create_server(("127.0.0.1", 2525))
    while True:
        conn, _ = listener.accept()

        def guarded(c=conn):
            try:
                serve_smtp(c)
            except (OSError, ssl.SSLError):
                pass

        threading.Thread(target=guarded, daemon=True).start()


class Box(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = json.dumps(mails).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_) -> None:
        pass


threading.Thread(target=smtp_loop, daemon=True).start()
threading.Thread(target=http.server.ThreadingHTTPServer(("0.0.0.0", 8081), Box).serve_forever, daemon=True).start()

import uvicorn  # noqa: E402

from noah import auth, db, main  # noqa: E402

if MODE not in ("vide", "temporaire"):
    db.init()
    auth.create_user("alice", "motdepasse-a")
    nina = auth.create_user("nina", "motdepasse-n")
    db.set_setting("onboarded", "1")
    db.set_setting("provider", "openrouter")
    db.set_setting("model", "modele-essai")
    auth.new_session(nina, "Téléphone de Nina", "android", "203.0.113.12")
    auth.new_session(nina, "Firefox sur Windows", "web", "203.0.113.40")
uvicorn.run(main.app, host="0.0.0.0", port=8080, proxy_headers=True, forwarded_allow_ips="*", log_level="warning")
