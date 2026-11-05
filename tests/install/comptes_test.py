"""Comptes, sur un vrai serveur uvicorn et un vrai petit serveur de courriel en TLS, sans aucun service extérieur : un jeton volé ne
coupe pas les autres appareils, premier compte choisi au déploiement (vrais démarrages du serveur), mot de passe temporaire, gestion
des profils par le propriétaire, code reçu par courriel, alerte de nouvel appareil et « Ce n'est pas moi ».

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/install/comptes_test.py"
"""
import base64
import datetime
import email
import email.policy
import hashlib
import hmac
import json
import logging
import os
import re
import socket
import sqlite3
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time

data = tempfile.mkdtemp()
os.environ.update({"NOAH_DATA_DIR": data, "LAUNCHER_KEY": "x", "NOAH_SECRET_KEY": "y" * 32, "NOAH_UPDATE_MANIFEST": "http://127.0.0.1:9/manifeste"})
for leftover in ("NOAH_ADMIN_USER", "NOAH_ADMIN_PASSWORD", "NOAH_SETUP_CODE"):
    os.environ.pop(leftover, None)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402
from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from noah import auth, courriel, db, main, push, recuperation  # noqa: E402

failed: list[str] = []
_addr = iter(range(1, 60000))


def check(ok: bool, what: str, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'ÉCHEC'} {what}" + (f" : {detail}" if not ok and detail != "" else ""), flush=True)
    if not ok:
        failed.append(what)


# --- Certificats : une autorité que le serveur croit (SSL_CERT_FILE, comme un vrai magasin), et une qu'il ne connaît pas ------------

def _name(text: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, text)])


def _authority(name: str):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(_name(name)).issuer_name(_name(name)).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256()))
    return key, cert


def _leaf(ca_key, ca_cert, host: str, folder: str, name: str) -> tuple[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(_name(host)).issuer_name(ca_cert.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False).sign(ca_key, hashes.SHA256()))
    cert_path, key_path = f"{folder}/{name}.crt", f"{folder}/{name}.key"
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return cert_path, key_path


pki = tempfile.mkdtemp()
trusted_key, trusted_ca = _authority("Autorite de confiance")
stranger_key, stranger_ca = _authority("Autorite inconnue")
with open(f"{pki}/ca.pem", "wb") as f:
    f.write(trusted_ca.public_bytes(serialization.Encoding.PEM))
os.environ["SSL_CERT_FILE"] = f"{pki}/ca.pem"
GOOD_CERT = _leaf(trusted_key, trusted_ca, "localhost", pki, "bon")
BAD_CERT = _leaf(stranger_key, stranger_ca, "localhost", pki, "inconnu")
WRONG_NAME = _leaf(trusted_key, trusted_ca, "autre.exemple", pki, "autre-nom")


class SmtpServer(threading.Thread):
    """Un vrai serveur SMTP minimal sur une vraie socket : STARTTLS ou TLS d'emblée, AUTH PLAIN, enregistre ce qui arrive."""

    def __init__(self, implicit: bool = False, offer_tls: bool = True, cert: tuple[str, str] = GOOD_CERT) -> None:
        super().__init__(daemon=True)
        self.implicit, self.offer_tls, self.refuse = implicit, offer_tls, False
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(*cert)
        self.mails: list[dict] = []
        self.login: tuple[str, str] = ("noah", "mot-de-passe-du-courriel")
        self.seen_auth: list[str] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.start()

    def run(self) -> None:
        while True:
            conn, _ = self.listener.accept()
            threading.Thread(target=self._guarded, args=(conn,), daemon=True).start()

    def _guarded(self, conn) -> None:
        try:
            self._serve(conn)
        except (OSError, ssl.SSLError):
            pass
        finally:
            conn.close()

    def _serve(self, conn) -> None:
        if self.refuse:
            return
        secure = False
        if self.implicit:
            conn = self.context.wrap_socket(conn, server_side=True)
            secure = True
        conn.sendall(b"220 essai ESMTP\r\n")
        buffer, mail = b"", {"tls": secure, "rcpt": []}

        def line() -> bytes:
            nonlocal buffer
            while b"\r\n" not in buffer:
                chunk = conn.recv(4096)
                if not chunk:
                    raise OSError("fini")
                buffer += chunk
            out, buffer = buffer.split(b"\r\n", 1)
            return out

        while True:
            text = line().decode("latin-1")
            verb = text.split(" ", 1)[0].upper()
            if verb in ("EHLO", "HELO"):
                extensions = ["250-essai"]
                if self.offer_tls and not secure:
                    extensions.append("250-STARTTLS")
                if secure:
                    extensions.append("250-AUTH PLAIN")
                conn.sendall(("\r\n".join(extensions + ["250 OK"]) + "\r\n").encode())
            elif verb == "STARTTLS":
                conn.sendall(b"220 vas-y\r\n")
                conn = self.context.wrap_socket(conn, server_side=True)
                secure, mail["tls"], buffer = True, True, b""
            elif verb == "AUTH":
                _, user, password = base64.b64decode(text.split(" ")[2]).split(b"\0")
                self.seen_auth.append(password.decode())
                ok = (user.decode(), password.decode()) == self.login
                conn.sendall(b"235 ok\r\n" if ok else b"535 non\r\n")
            elif verb == "MAIL":
                conn.sendall(b"250 ok\r\n")
            elif verb == "RCPT":
                mail["rcpt"].append(re.search(r"<(.*)>", text).group(1))
                conn.sendall(b"250 ok\r\n")
            elif verb == "DATA":
                conn.sendall(b"354 vas-y\r\n")
                lines = []
                while (row := line()) != b".":
                    lines.append(row)
                parsed = email.message_from_bytes(b"\r\n".join(lines), policy=email.policy.default)
                self.mails.append({**mail, "sujet": str(parsed["Subject"]), "corps": parsed.get_content(), "de": str(parsed["From"])})
                conn.sendall(b"250 ok\r\n")
            elif verb == "QUIT":
                conn.sendall(b"221 salut\r\n")
                return
            else:
                conn.sendall(b"250 ok\r\n")

    def last_code(self, to: str) -> str:
        for mail in reversed(self.mails):
            found = re.search(r"\b(\d{6})\b", mail["sujet"])
            if to in mail["rcpt"] and found:
                return found.group(1)
        raise AssertionError(f"aucun code reçu pour {to}")

    def count(self, to: str) -> int:
        return sum(1 for m in self.mails if to in m["rcpt"])


# --- Le serveur ---------------------------------------------------------------------------------------------------------------------

class Lines(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


journal = Lines()
alerts: list[dict] = []


async def fake_send(title, text, url="/", urgent=False, user_id=None, session=None, extra=None):
    alerts.append({"titre": title, "texte": text, "user": user_id, "urgent": urgent})
    return {}


push.send = fake_send
db.init()
db.set_setting("onboarded", "1")
FRANCK_PW = "motdepasse-franck"
NINA_PW = "motdepasse-nina"
franck = auth.create_user("franck", FRANCK_PW)
nina = auth.create_user("nina", NINA_PW)

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, proxy_headers=True, forwarded_allow_ips="127.0.0.1", log_level="warning"))
logging.getLogger("uvicorn.error").addHandler(journal)
threading.Thread(target=server.run, daemon=True).start()
while not server.started:
    time.sleep(0.05)


def addr() -> str:
    n = next(_addr)
    return f"198.18.{n >> 8}.{n & 255}"


def anyone(ip: str | None = None) -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"X-Forwarded-For": ip or addr(), "Origin": BASE}, timeout=30)


def bearer(token: str, ip: str | None = None) -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}", "X-Forwarded-For": ip or addr()}, timeout=30)


def in_window(token: str) -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"Origin": BASE, "X-Forwarded-For": addr()}, cookies={auth.COOKIE: token}, timeout=30)


def fresh_limits() -> None:
    main._failed_logins.clear()
    main._account_failures.clear()
    recuperation._tries.clear()


def fresh_mail() -> None:
    with db.connect() as c:
        c.execute("DELETE FROM courriel_envois")


def login(who: httpx.Client, username: str, password: str, code: str = "") -> httpx.Response:
    return who.post("/api/login", json={"username": username, "password": password, "code": code})


def logged_in(username: str, password: str, ip: str | None = None) -> httpx.Client:
    who = anyone(ip)
    r = login(who, username, password)
    assert r.status_code == 200, r.text
    return who


def device(user: int, name: str = "Pixel", platform: str = "android") -> str:
    return auth.new_session(user, name, platform)


def public_id(token: str) -> str:
    return auth.device_id(auth.digest(token))


def alive(token: str) -> bool:
    return bearer(token).get("/api/me").status_code == 200


def app_code(secret: str, offset: int = 0) -> str:
    step = int(time.time()) // 30 + offset
    digest = hmac.new(base64.b32decode(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    pos = digest[-1] & 0x0F
    return str((struct.unpack(">I", digest[pos:pos + 4])[0] & 0x7FFFFFFF) % 1000000).zfill(6)


def wait_for(condition, seconds: float = 8) -> bool:
    until = time.time() + seconds
    while time.time() < until:
        if condition():
            return True
        time.sleep(0.05)
    return False


# ==== 1. Un jeton volé ne déconnecte pas les autres appareils ========================================================================
print("== 1. Jeton volé : ni fermer les autres sessions, ni bloquer le propriétaire")
stolen, owner_phone, owner_laptop = device(franck, "Volé"), device(franck, "Téléphone"), device(franck, "Portable", "desktop")
thief = bearer(stolen)
r = thief.post("/api/devices/others/revoke")
check(r.status_code == 428 and alive(owner_phone) and alive(owner_laptop), "« tous les autres » sans preuve : 428, personne n'est déconnecté", r.text)
r = thief.delete(f"/api/devices/{public_id(owner_phone)}")
check(r.status_code == 428 and alive(owner_phone), "un autre appareil sans preuve : 428, il reste connecté", r.text)
r = thief.request("DELETE", f"/api/devices/{public_id(owner_phone)}", json={"motdepasse": "je-devine"})
check(r.status_code == 400 and alive(owner_phone), "avec un faux mot de passe : 400", r.text)
r = thief.post("/api/devices/others/revoke", json={"motdepasse": "je-devine"})
check(r.status_code == 400 and alive(owner_laptop), "« tous les autres » avec un faux mot de passe : 400", r.text)
r = thief.post("/api/me/password", json={"actuel": "je-devine", "nouveau": "nouveau-mot-de-passe"})
check(r.status_code == 400 and auth.check_password("franck", FRANCK_PW) == franck, "changer le mot de passe sans l'actuel : 400", r.text)
r = thief.post("/api/me/double-verification/preparer", json={"motdepasse": "je-devine"})
check(r.status_code == 400 and "secret" not in r.text, "se fabriquer une double vérification sans le mot de passe : 400", r.text)
r = thief.post("/api/me/double-verification/couper", json={"motdepasse": "je-devine"})
check(r.status_code == 409, "couper une double vérification inexistante : rien", r.text)
same_ip = addr()
guesses = bearer(stolen, same_ip)
codes = [guesses.post("/api/me/password", json={"actuel": f"essai-{i}-xx", "nouveau": "nouveau-mot-de-passe"}).status_code for i in range(12)]
check(codes[-1] == 429, "essayer des mots de passe avec le jeton : limité comme une connexion", codes)
check(logged_in("franck", FRANCK_PW).get("/api/me").status_code == 200, "ces essais ne bloquent pas le propriétaire : il se connecte depuis une autre adresse")
fresh_limits()
r = bearer(owner_laptop).delete(f"/api/devices/{public_id(owner_laptop)}")
check(r.status_code == 200 and not alive(owner_laptop), "se déconnecter soi-même reste libre", r.text)
r = thief.delete(f"/api/devices/{public_id(owner_phone)}x")
check(r.status_code == 404, "un appareil inconnu : 404, et non une demande de preuve", r.text)
r = thief.request("DELETE", f"/api/devices/{public_id(owner_phone)}", json={"motdepasse": FRANCK_PW})
check(r.status_code == 200 and not alive(owner_phone), "avec le bon mot de passe : l'autre appareil part", r.text)
kept = device(franck, "Gardé")
browser = logged_in("franck", FRANCK_PW)
r = browser.post("/api/devices/others/revoke")
check(r.status_code == 200 and not alive(kept) and not alive(stolen), "navigateur où le mot de passe vient d'être saisi : pas de preuve de plus (témoin)", r.text)
r = bearer(nina_token := device(nina, "Nina")).request("DELETE", f"/api/devices/{public_id(device(franck))}", json={"motdepasse": NINA_PW})
check(r.status_code == 404, "profil isolé : l'appareil d'un autre compte n'existe pas", r.text)

# ==== 2. Premier compte choisi au déploiement : de vrais démarrages du serveur =========================================================
print("== 2. NOAH_ADMIN_USER et NOAH_ADMIN_PASSWORD")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Booted:
    """Un démarrage réel : processus à part, base et secrets dans un dossier à soi, journal lu ensuite."""

    def __init__(self, folder: str, **env: str) -> None:
        self.port, self.folder = free_port(), folder
        self.journal = open(f"{folder}/journal.txt", "a")
        environ = {k: v for k, v in os.environ.items() if not k.startswith("NOAH_") and k != "LAUNCHER_KEY"}
        environ.update({"NOAH_DATA_DIR": folder, "NOAH_SECRETS_FILE": f"{folder}/secrets.json", "NOAH_SETUP_CODE": "auto", "PYTHONPATH": "/app",
                        "NOAH_UPDATE_MANIFEST": "http://127.0.0.1:9/manifeste", "LAUNCHER_URL": "http://127.0.0.1:9", **env})
        self.process = subprocess.Popen([sys.executable, "-m", "uvicorn", "noah.main:app", "--host", "127.0.0.1", "--port", str(self.port), "--log-level", "warning"],
                                        env=environ, cwd="/app", stdout=self.journal, stderr=self.journal)
        self.base = f"http://127.0.0.1:{self.port}"
        assert wait_for(self._up, 40), self.logs()

    def _up(self) -> bool:
        try:
            return httpx.get(f"{self.base}/api/status", timeout=2).status_code == 200
        except httpx.HTTPError:
            return False

    def client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base, headers={"Origin": self.base, "X-Forwarded-For": addr()}, timeout=20)

    def logs(self) -> str:
        with open(f"{self.folder}/journal.txt") as f:
            return f.read()

    def stop(self) -> None:
        self.process.terminate()
        self.process.wait(20)


ADMIN_PW = "provisoire-tres-long"
folder = tempfile.mkdtemp()
boot = Booted(folder, NOAH_ADMIN_USER="patronne", NOAH_ADMIN_PASSWORD=ADMIN_PW)
try:
    st = boot.client().get("/api/status").json()
    check(st["has_account"] is True and st["setup_code"] is False, "le compte existe dès le premier démarrage, plus de code d'installation", st)
    check("NOAH_SETUP_CODE" not in json.load(open(f"{folder}/secrets.json")), "le code d'installation est effacé des secrets")
    check(boot.client().post("/api/setup/check", json={"installation": "BCDFGHJKLMNP"}).status_code == 410, "le code d'installation ne sert plus à rien")
    check(boot.client().post("/api/setup/account", json={"username": "intrus", "password": "motdepasse-x", "installation": ""}).status_code == 410, "pas d'inscription publique")
    check(boot.client().post("/api/login", json={"username": "patronne", "password": "mauvais-mot-de-passe"}).status_code == 401, "un faux mot de passe : refusé")
    web = boot.client()
    check(web.post("/api/login", json={"username": "patronne", "password": ADMIN_PW}).status_code == 200, "connexion avec le mot de passe choisi")
    check(web.get("/api/me").json()["mot_de_passe_a_changer"] is True, "marqué « à changer »")
    r = web.get("/api/agents")
    check(r.status_code == 403 and r.headers.get("x-noah-mot-de-passe") == "a-changer", "l'API refuse le reste tant qu'il n'est pas changé", r.text)
    token = web.cookies.get(auth.COOKIE)
    tokened = httpx.Client(base_url=boot.base, headers={"Authorization": f"Bearer {token}"}, timeout=20)
    check(tokened.get("/api/agents").status_code == 403, "même depuis un jeton")
    check(tokened.post("/api/devices/others/revoke", json={"motdepasse": ADMIN_PW}).status_code == 403, "même avec le mot de passe, rien d'autre ne passe")
    r = web.post("/api/me/password", json={"actuel": ADMIN_PW, "nouveau": ADMIN_PW})
    check(r.status_code == 400, "le nouveau doit être différent du temporaire", r.text)
    r = web.post("/api/me/password", json={"actuel": "mauvais-mot-de-passe", "nouveau": "le-vrai-mot-de-passe"})
    check(r.status_code == 400, "il faut bien le temporaire", r.text)
    r = web.post("/api/me/password", json={"actuel": ADMIN_PW, "nouveau": "le-vrai-mot-de-passe"})
    check(r.status_code == 200 and web.get("/api/agents").status_code == 200, "changé : le reste répond", r.text)
    check(web.get("/api/me").json()["mot_de_passe_a_changer"] is False, "plus marqué")
    check(ADMIN_PW not in boot.logs(), "le mot de passe n'est dans aucun journal", boot.logs()[-400:])
    check("patronne" in boot.logs() and "à changer" in boot.logs(), "le journal dit qu'il a créé le compte")
finally:
    boot.stop()
boot = Booted(folder, NOAH_ADMIN_USER="patronne", NOAH_ADMIN_PASSWORD="une-autre-valeur-longue")
try:
    who = boot.client()
    check(who.post("/api/login", json={"username": "patronne", "password": "une-autre-valeur-longue"}).status_code == 401, "changer la variable ne touche pas au compte")
    check(who.post("/api/login", json={"username": "patronne", "password": "le-vrai-mot-de-passe"}).status_code == 200 and who.get("/api/agents").status_code == 200,
          "le mot de passe choisi reste bon, et n'est pas de nouveau à changer")
    check("une-autre-valeur-longue" not in boot.logs(), "ni dans le journal")
finally:
    boot.stop()
boot = Booted(folder, NOAH_ADMIN_USER="quelquun", NOAH_ADMIN_PASSWORD="un-troisieme-long-essai")
try:
    check(boot.client().post("/api/login", json={"username": "quelquun", "password": "un-troisieme-long-essai"}).status_code == 401, "un autre nom ne crée pas de deuxième compte")
finally:
    boot.stop()
for label, env in (("sans variable", {}), ("mot de passe trop court", {"NOAH_ADMIN_USER": "patronne", "NOAH_ADMIN_PASSWORD": "court-11car"}),
                   ("nom seul", {"NOAH_ADMIN_USER": "patronne"})):
    folder = tempfile.mkdtemp()
    boot = Booted(folder, **env)
    try:
        st = boot.client().get("/api/status").json()
        check(st["has_account"] is False and st["setup_code"] is True, f"{label} : pas de compte, le lien à code d'installation sert comme avant", st)
        code = json.load(open(f"{folder}/secrets.json"))["NOAH_SETUP_CODE"]
        check(boot.client().post("/api/setup/account", json={"username": "patronne", "password": "motdepasse-x", "installation": ""}).status_code == 403, f"{label} : sans le code, refusé")
        check(boot.client().post("/api/setup/check", json={"installation": code}).status_code == 200, f"{label} : avec le code, accepté")
        check(not env or "court-11car" not in boot.logs(), f"{label} : rien dans le journal")
    finally:
        boot.stop()

# ==== Mot de passe temporaire : toutes les routes =======================================================================================
print("== Mot de passe temporaire : chaque route du serveur")
tempo = auth.create_user("tempo", "temporaire-tempo", temporary=True)
ALLOWED = set(auth.TEMPORARY_ROUTES)
errors, covered = [], 0
for route in main.app.routes:
    if not (isinstance(route, APIRoute) and route.path.startswith("/api/")):
        continue
    url = re.sub(r"\{[^}]+\}", "1", route.path)
    for method in sorted(route.methods - {"HEAD"}):
        if route.path in ("/api/tls-ask", "/api/public", "/api/logout", "/api/devices/self") or route.path.startswith("/api/apercu/"):
            continue
        if anyone().request(method, url, json={}).status_code != 401:
            continue  # sans session, elle répond déjà : rien à protéger ici
        session = device(tempo, "Tempo", "web")
        r = bearer(session).request(method, url, json={})
        covered += 1
        if route.path in ALLOWED:
            continue
        if r.status_code != 403 or r.headers.get("x-noah-mot-de-passe") != "a-changer":
            errors.append(f"{method} {route.path} : {r.status_code}")
check(not errors, f"{covered} routes à session : toutes refusées, sauf ce qui sert à changer le mot de passe", errors)
check(covered > 100, "le parcours regarde bien les routes", covered)
window = auth.new_window(device(tempo, "Tempo", "android"))
check(in_window(window).get("/api/agents").status_code == 403, "refusé aussi à une session de fenêtre d'app")
check(in_window(window).get("/api/me").json()["mot_de_passe_a_changer"] is True, "l'écran sait quoi demander")
try:
    with TestClient(main.app).websocket_connect("/api/agents/x/screen/websockify", headers={"Authorization": f"Bearer {device(tempo, 'Tempo', 'web')}"}):
        check(False, "WebSocket de l'écran ouvert avec un mot de passe temporaire")
except WebSocketDisconnect as e:
    check(e.code == 4401, "WebSocket de l'écran : refusé", e.code)

# ==== 3. Le propriétaire gère les utilisateurs ==========================================================================================
print("== 3. Gestion des utilisateurs")
fresh_limits()
owner_token, member_token = device(franck, "Bureau"), device(nina, "Téléphone de Nina")
owner, member = bearer(owner_token), bearer(member_token)
nina_id = public_id(member_token)
for method, url, body in (("GET", f"/api/profiles/{nina}/appareils", None), ("DELETE", f"/api/profiles/{franck}/appareils/{public_id(owner_token)}", {"motdepasse": NINA_PW}),
                          ("POST", f"/api/profiles/{franck}/mot-de-passe", {"nouveau": "volé-volé-volé", "motdepasse": NINA_PW}),
                          ("POST", "/api/profiles", {"username": "complice", "password": "motdepasse-c", "motdepasse": NINA_PW})):
    r = member.request(method, url, json=body)
    check(r.status_code == 403, f"profil isolé : {method} {url.split('/api/')[1]} refusé", r.text)
check(auth.check_password("franck", FRANCK_PW) == franck and auth.check_password("complice", "motdepasse-c") is None, "un profil n'a rien changé")
listing = owner.get(f"/api/profiles/{nina}/appareils").json()["appareils"]
row = next(d for d in listing if d["id"] == nina_id)
check(row["nom"] == "Téléphone de Nina" and "ip" in row and row["depuis"] and "token" not in json.dumps(listing), "le propriétaire voit nom, adresse et date, jamais de jeton", row)
check(owner.delete(f"/api/profiles/{nina}/appareils/nimporte").status_code == 404, "un appareil inconnu : 404")
check(owner.delete(f"/api/profiles/{nina}/appareils/{public_id(owner_token)}").status_code == 404, "un appareil d'un autre compte n'existe pas sous ce profil")
r = owner.delete(f"/api/profiles/{nina}/appareils/{nina_id}")
check(r.status_code == 428 and alive(member_token), "jeton volé : couper l'appareil d'un profil demande la preuve", r.text)
r = owner.request("DELETE", f"/api/profiles/{nina}/appareils/{nina_id}", json={"motdepasse": "je-devine"})
check(r.status_code == 400 and alive(member_token), "faux mot de passe : 400", r.text)
r = owner.request("DELETE", f"/api/profiles/{nina}/appareils/{nina_id}", json={"motdepasse": FRANCK_PW})
check(r.status_code == 200 and not alive(member_token), "avec la preuve : cet appareil part", r.text)
second, third = device(nina, "Un"), device(nina, "Deux")
r = owner.post(f"/api/profiles/{nina}/mot-de-passe", json={"nouveau": "temporaire-nina"})
check(r.status_code == 428 and alive(second) and auth.check_password("nina", NINA_PW) == nina, "réinitialiser sans preuve : 428, rien ne change", r.text)
r = owner.post(f"/api/profiles/{nina}/mot-de-passe", json={"nouveau": "temporaire-nina", "motdepasse": "je-devine"})
check(r.status_code == 400 and alive(second), "avec un faux mot de passe : 400", r.text)
r = owner.post(f"/api/profiles/{franck}/mot-de-passe", json={"nouveau": "temporaire-toi", "motdepasse": FRANCK_PW})
check(r.status_code == 400, "le propriétaire ne se réinitialise pas par cette route", r.text)
r = owner.post(f"/api/profiles/{nina}/mot-de-passe", json={"nouveau": "temporaire-nina", "motdepasse": FRANCK_PW})
check(r.status_code == 200 and not alive(second) and not alive(third), "réinitialisé : toutes ses sessions sont fermées", r.text)
check(login(anyone(), "nina", NINA_PW).status_code == 401, "l'ancien mot de passe ne sert plus")
nina_web = logged_in("nina", "temporaire-nina")
check(nina_web.get("/api/agents").status_code == 403, "le temporaire n'ouvre rien d'autre que le changement")
r = nina_web.post("/api/me/password", json={"actuel": "temporaire-nina", "nouveau": NINA_PW})
check(r.status_code == 200 and nina_web.get("/api/agents").status_code == 200, "elle choisit le sien, tout répond", r.text)
OWNER_WINDOW_TOKEN = device(franck, "Téléphone de Franck")
held = auth.new_window(OWNER_WINDOW_TOKEN)
win = in_window(held)
r = win.post("/api/profiles", json={"username": "oscar", "password": "motdepasse-o"})
check(r.status_code == 428, "cookie de fenêtre volé : pas de profil sans le mot de passe", r.text)
r = win.post("/api/profiles", json={"username": "oscar", "password": "motdepasse-o", "motdepasse": "je-devine"})
check(r.status_code == 400 and auth.check_password("oscar", "motdepasse-o") is None, "ni avec un faux", r.text)
r = win.post("/api/profiles", json={"username": "oscar", "password": "motdepasse-o", "motdepasse": FRANCK_PW})
check(r.status_code == 200, "depuis l'app, avec le mot de passe : créé", r.text)
oscar = r.json()["id"]
r = win.post(f"/api/profiles/{oscar}/mot-de-passe", json={"nouveau": "temporaire-oscar"})
check(r.status_code == 428, "la preuve n'est pas gardée pour une fenêtre : elle est redemandée à chaque geste", r.text)
r = win.post(f"/api/profiles/{oscar}/mot-de-passe", json={"nouveau": "temporaire-oscar", "motdepasse": FRANCK_PW})
check(r.status_code == 200, "réinitialiser depuis l'app, avec le mot de passe", r.text)
check(win.get(f"/api/profiles/{oscar}/appareils").status_code == 200, "voir ses appareils depuis l'app")
check(win.post("/api/pairing").status_code == 403, "relier un appareil reste refusé depuis la fenêtre")
r = win.delete(f"/api/profiles/{oscar}")
check(r.status_code == 428 and auth.check_password("oscar", "temporaire-oscar") == oscar, "supprimer un profil sans preuve : 428, il reste", r.text)
r = win.request("DELETE", f"/api/profiles/{oscar}", json={"motdepasse": FRANCK_PW})
check(r.status_code == 200 and auth.check_password("oscar", "temporaire-oscar") is None, "avec la preuve : supprimé", r.text)

# ==== 4. Courriel de confirmation =======================================================================================================
print("== 4. Courriel de confirmation")
fresh_limits()
smtp = SmtpServer()
owner_token = device(franck, "Bureau")
owner = bearer(owner_token)
SMTP_BODY = {"hote": "localhost", "port": smtp.port, "utilisateur": "noah", "mot_de_passe": "mot-de-passe-du-courriel", "expediteur": "noah@exemple.test", "tls": "starttls"}

check(bearer(device(nina)).post("/api/me/courriel", json={"adresse": "nina@exemple.test", "motdepasse": NINA_PW}).status_code == 409, "sans réglage d'envoi : on ne peut pas activer d'adresse")
check(bearer(device(nina)).get("/api/courriel/smtp").status_code == 403, "le réglage est réservé au propriétaire : lecture")
check(bearer(device(nina)).put("/api/courriel/smtp", json={**SMTP_BODY, "motdepasse": NINA_PW}).status_code == 403, "et écriture")
check(bearer(device(nina)).post("/api/courriel/essai", json={}).status_code == 403, "et essai")
r = owner.put("/api/courriel/smtp", json=SMTP_BODY)
check(r.status_code == 428 and courriel.smtp_settings() is None, "régler l'envoi sans preuve : 428", r.text)
r = owner.put("/api/courriel/smtp", json={**SMTP_BODY, "motdepasse": FRANCK_PW})
check(r.status_code == 200 and "mot-de-passe-du-courriel" not in r.text and "mot_de_passe\"" not in r.text and r.json()["mot_de_passe_enregistre"] is True, "enregistré : le mot de passe ne revient pas", r.text)
check("mot-de-passe-du-courriel" not in owner.get("/api/courriel/smtp").text, "ni à la lecture")
raw = sqlite3.connect(f"{data}/noah.db").execute("SELECT value FROM settings WHERE key = 'smtp'").fetchone()[0]
check("mot-de-passe-du-courriel" not in raw and db.unseal(json.loads(raw)["mot_de_passe"]) == "mot-de-passe-du-courriel", "scellé en base")
flows = owner.get("/api/flux").json()["flux"]
check(any(f["vers"] == "localhost" and "Courriel" in f["quoi"] for f in flows), "une ligne dans /api/flux, vers ce serveur", flows[-1])

r = owner.post("/api/courriel/essai", json={"adresse": "essai@exemple.test"})
check(r.status_code == 200 and smtp.count("essai@exemple.test") == 1, "bouton « Envoyer un essai » : un vrai courriel arrive", r.text)
check(smtp.mails[-1]["tls"] is True and smtp.seen_auth[-1] == "mot-de-passe-du-courriel", "par STARTTLS, avec le mot de passe déscellé")
check(smtp.mails[-1]["de"] == "noah@exemple.test", "de la part de l'expéditeur réglé")


def save_smtp_directly(**changes) -> None:
    """Le réglage tel qu'il serait enregistré : on essaie ici ce que fait l'envoi, pas la route (déjà vue)."""
    settings = {**courriel.smtp_settings(), **changes}
    db.set_setting("smtp", json.dumps(settings))


saved = courriel.smtp_settings()
plain = SmtpServer(offer_tls=False)
save_smtp_directly(port=plain.port)
r = owner.post("/api/courriel/essai", json={"adresse": "essai@exemple.test"})
check(r.status_code == 502 and "chiffrée" in r.text and not plain.mails and not plain.seen_auth, "serveur sans STARTTLS : refus, rien ne part en clair", r.text)
bad = SmtpServer(cert=BAD_CERT)
save_smtp_directly(port=bad.port)
r = owner.post("/api/courriel/essai", json={"adresse": "essai@exemple.test"})
check(r.status_code == 502 and "certificat" in r.text and not bad.mails and not bad.seen_auth, "certificat d'une autorité inconnue : refus, mot de passe non envoyé", r.text)
wrong = SmtpServer(cert=WRONG_NAME)
save_smtp_directly(port=wrong.port)
r = owner.post("/api/courriel/essai", json={"adresse": "essai@exemple.test"})
check(r.status_code == 502 and "certificat" in r.text and not wrong.seen_auth, "certificat pour un autre nom : refus", r.text)
implicit = SmtpServer(implicit=True)
save_smtp_directly(port=implicit.port, tls="ssl")
r = owner.post("/api/courriel/essai", json={"adresse": "ssl@exemple.test"})
check(r.status_code == 200 and implicit.count("ssl@exemple.test") == 1 and implicit.mails[-1]["tls"], "connexion SSL d'emblée : le courriel arrive", r.text)
badssl = SmtpServer(implicit=True, cert=BAD_CERT)
save_smtp_directly(port=badssl.port, tls="ssl")
r = owner.post("/api/courriel/essai", json={"adresse": "ssl@exemple.test"})
check(r.status_code == 502 and "certificat" in r.text, "SSL avec un certificat inconnu : refus", r.text)
save_smtp_directly(**saved)
smtp.login = ("noah", "un-autre")
r = owner.post("/api/courriel/essai", json={"adresse": "essai@exemple.test"})
check(r.status_code == 502 and "identifiant" in r.text and "mot-de-passe-du-courriel" not in r.text, "identifiant refusé : dit clairement, sans le mot de passe", r.text)
smtp.login = ("noah", "mot-de-passe-du-courriel")
fresh_mail()
codes = [owner.post("/api/courriel/essai", json={"adresse": "essai@exemple.test"}).status_code for _ in range(courriel.TESTS_PER_HOUR + 1)]
check(codes[-1] == 429 and codes[0] == 200, "essais limités à quelques-uns par heure", codes)
fresh_mail()
r = owner.put("/api/courriel/smtp", json={**SMTP_BODY, "hote": "autre.exemple", "mot_de_passe": "", "motdepasse": FRANCK_PW})
check(not courriel.smtp_settings()["mot_de_passe"], "autre serveur : le mot de passe enregistré ne le suit pas", r.text)
owner.put("/api/courriel/smtp", json={**SMTP_BODY, "motdepasse": FRANCK_PW})
owner.put("/api/courriel/smtp", json={**SMTP_BODY, "mot_de_passe": "", "motdepasse": FRANCK_PW})
check(courriel.smtp_settings()["mot_de_passe"], "même serveur, champ vide : il reste")
check(owner.put("/api/courriel/smtp", json={**SMTP_BODY, "hote": "a b\r\nDATA", "motdepasse": FRANCK_PW}).status_code == 400, "un nom de serveur avec un retour à la ligne : refusé")
check(owner.put("/api/courriel/smtp", json={**SMTP_BODY, "expediteur": "a@b.c\r\nBcc: x@y.z", "motdepasse": FRANCK_PW}).status_code == 400, "un expéditeur avec un retour à la ligne : refusé")

print("-- Activer une adresse")
ADDRESS = "franck@exemple.test"
check(owner.post("/api/me/courriel", json={"adresse": "pas une adresse", "motdepasse": FRANCK_PW}).status_code == 400, "adresse mal écrite : refusée")
before = len(smtp.mails)
r = owner.post("/api/me/courriel", json={"adresse": ADDRESS})
check(r.status_code == 428 and not r.json().get("courriel_requis") and len(smtp.mails) == before, "jeton volé : pas d'adresse sans le mot de passe, aucun courriel ne part", r.text)
r = owner.post("/api/me/courriel", json={"adresse": ADDRESS, "motdepasse": FRANCK_PW})
check(r.status_code == 200 and smtp.count(ADDRESS) == 1, "avec le mot de passe : un code part vers cette adresse", r.text)
state = owner.get("/api/me/courriel").json()
check(state["active"] is False and state["en_attente"] == ADDRESS, "elle n'est pas active tant que le code n'est pas saisi", state)
check(owner.post("/api/devices/others/revoke", json={"motdepasse": FRANCK_PW}).status_code == 200, "en attendant, rien ne change")
good = smtp.last_code(ADDRESS)
check(owner.post("/api/me/courriel/activer", json={"code": "000000" if good != "000000" else "111111"}).status_code == 400, "un faux code n'active rien")
other_session = bearer(device(franck, "Autre"))
check(other_session.post("/api/me/courriel/activer", json={"code": good}).status_code == 400, "le code ne vaut que pour la session qui l'a demandé")
check(owner.post("/api/me/courriel/activer", json={"code": good}).status_code == 200 and owner.get("/api/me/courriel").json()["active"], "le bon code l'active")
check(owner.post("/api/me/courriel/activer", json={"code": good}).status_code == 400, "le code ne resert pas")
check(good not in json.dumps([list(r) for r in sqlite3.connect(f"{data}/noah.db").execute("SELECT action, empreinte FROM courriel_codes")]), "seule l'empreinte reste en base")


def pass_with_mail(session: httpx.Client, method: str, url: str, body: dict, label: str = "") -> httpx.Response:
    """Sans code : 428 et un courriel. Avec le code reçu : l'action passe."""
    fresh_mail()
    to = ADDRESS
    before = smtp.count(to)
    first = session.request(method, url, json=body)
    check(first.status_code == 428 and first.json().get("courriel_requis") is True and smtp.count(to) == before + 1, f"{label} : 428 courriel_requis, un code part", first.text)
    return session.request(method, url, json={**body, "courriel": smtp.last_code(to)})


print("-- Chaque action critique demande le code")
owner = bearer(owner_token := device(franck, "Bureau"))
PW = {"motdepasse": FRANCK_PW}
r = pass_with_mail(owner, "POST", "/api/profiles", {"username": "lila", "password": "motdepasse-l", **PW}, label="ajouter un utilisateur")
check(r.status_code == 200, "ajouter un utilisateur : passe avec le code", r.text)
lila = r.json()["id"]
r = pass_with_mail(owner, "POST", f"/api/profiles/{lila}/mot-de-passe", {"nouveau": "temporaire-lila", **PW}, label="réinitialiser")
check(r.status_code == 200 and auth.must_change(lila), "réinitialiser un mot de passe : passe avec le code", r.text)
r = pass_with_mail(owner, "DELETE", f"/api/profiles/{lila}", PW, label="supprimer un compte")
check(r.status_code == 200, "supprimer un compte : passe avec le code", r.text)
victim = device(franck, "Autre appareil")
r = pass_with_mail(owner, "POST", "/api/devices/others/revoke", PW, label="révoquer tous les autres")
check(r.status_code == 200 and not alive(victim), "révoquer tous les autres : passe avec le code", r.text)
r = pass_with_mail(owner, "PUT", "/api/courriel/smtp", {**SMTP_BODY, **PW}, label="changer le réglage d'envoi")
check(r.status_code == 200, "changer le réglage d'envoi : passe avec le code", r.text)
NEW_PW = "motdepasse-franck-2"
r = pass_with_mail(owner, "POST", "/api/me/password", {"actuel": FRANCK_PW, "nouveau": NEW_PW}, label="changer le mot de passe")
check(r.status_code == 200 and auth.check_password("franck", NEW_PW) == franck, "changer le mot de passe : passe avec le code", r.text)
r = owner.post("/api/me/password", json={"actuel": FRANCK_PW, "nouveau": "encore-un-autre"})
check(r.status_code == 400 and "actuel" in r.text, "l'ancien mot de passe ne déclenche plus rien", r.text)
FRANCK_PW = NEW_PW
PW = {"motdepasse": FRANCK_PW}
NEW_ADDRESS = "franck-bis@exemple.test"
r = pass_with_mail(owner, "POST", "/api/me/courriel", {"adresse": NEW_ADDRESS, **PW}, label="changer l'adresse")
check(r.status_code == 200 and smtp.count(NEW_ADDRESS) == 1 and owner.get("/api/me/courriel").json()["adresse"] == ADDRESS, "changer l'adresse : le code part aussi vers la nouvelle, l'ancienne reste active", r.text)
check(owner.post("/api/me/courriel/activer", json={"code": smtp.last_code(NEW_ADDRESS)}).status_code == 200 and owner.get("/api/me/courriel").json()["adresse"] == NEW_ADDRESS, "activée avec son code")
ADDRESS = NEW_ADDRESS

print("-- Double vérification et code reçu par courriel, depuis une app : le code de l'application ne sert qu'une fois")
setup = owner.post("/api/me/double-verification/preparer", json=PW).json()
activated = owner.post("/api/me/double-verification/confirmer", json={"code": app_code(setup["secret"])})
check(activated.status_code == 200, "double vérification activée", activated.text)
with db.connect() as c:
    c.execute("UPDATE double_verification SET dernier_pas = 0 WHERE user_id = ?", (franck,))
held = in_window(auth.new_window(device(franck, "Téléphone")))
fresh_mail()
victim = device(franck, "Autre appareil")
r = held.post("/api/devices/others/revoke", json={**PW, "code": app_code(setup["secret"])})
check(r.status_code == 428 and r.json().get("courriel_requis") is True and alive(victim), "fenêtre d'app : mot de passe et code, puis code par courriel", r.text)
r = held.post("/api/devices/others/revoke", json={**PW, "code": app_code(setup["secret"]), "courriel": smtp.last_code(ADDRESS)})
check(r.status_code == 200 and not alive(victim), "le code par courriel suffit au second envoi, même si celui de l'application a déjà servi", r.text)
with db.connect() as c:
    c.execute("UPDATE double_verification SET dernier_pas = 0 WHERE user_id = ?", (franck,))
owner = bearer(device(franck, "Bureau"))  # le précédent vient d'être déconnecté avec les autres
r = pass_with_mail(owner, "POST", "/api/me/double-verification/couper", {**PW, "code": app_code(setup["secret"])}, label="couper la double vérification")
check(r.status_code == 200, "couper la double vérification : passe avec le code", r.text)

print("-- Code rejoué, expiré, faux, pour autre chose")
owner = bearer(owner_token := device(franck, "Bureau"))
fresh_mail()
victim = device(franck, "Autre appareil")
owner.post("/api/devices/others/revoke", json=PW)
code = smtp.last_code(ADDRESS)
check(owner.post("/api/profiles", json={"username": "lila", "password": "motdepasse-l", **PW, "courriel": code}).status_code == 400, "le code d'une autre action ne vaut pas ici")
check(owner.post("/api/devices/others/revoke", json={**PW, "courriel": code}).status_code == 200 and not alive(victim), "et il vaut toujours pour la sienne")
check(owner.post("/api/devices/others/revoke", json={**PW, "courriel": code}).status_code == 400, "code rejoué : refusé")
owner.post("/api/devices/others/revoke", json=PW)
code = smtp.last_code(ADDRESS)
with db.connect() as c:
    c.execute("UPDATE courriel_codes SET expire = ? WHERE user_id = ?", (time.time() - 1, franck))
check(owner.post("/api/devices/others/revoke", json={**PW, "courriel": code}).status_code == 400, "code expiré : refusé")
check(courriel.CODE_SECONDS == 600, "un code vit 10 minutes")
owner.post("/api/devices/others/revoke", json=PW)
code = smtp.last_code(ADDRESS)
wrong_code = "000000" if code != "000000" else "111111"
results = [owner.post("/api/devices/others/revoke", json={**PW, "courriel": wrong_code}).status_code for _ in range(courriel.CODE_TRIES)]
check(results == [400] * courriel.CODE_TRIES, "cinq faux codes : refusés", results)
check(owner.post("/api/devices/others/revoke", json={**PW, "courriel": code}).status_code == 400, "le bon ne passe plus après cinq essais")
r = owner.post("/api/devices/others/revoke", json=PW)
check(r.status_code == 428 and r.json().get("courriel_requis"), "un nouveau code se demande", r.text)
stolen_session = bearer(device(franck, "Volé"))
r = stolen_session.post("/api/devices/others/revoke", json={"courriel": smtp.last_code(ADDRESS)})
check(r.status_code == 400 and alive(owner_token), "jeton volé : le code d'une autre session ne vaut rien", r.text)
code = smtp.last_code(ADDRESS)
check(owner.post("/api/devices/others/revoke", json={**PW, "courriel": code}).status_code == 200, "et il n'a pas usé le code de la bonne session")

print("-- Trop d'envois, jeton volé")
fresh_mail()
smtp.mails.clear()
results = [owner.post("/api/devices/others/revoke", json=PW).status_code for _ in range(courriel.SENDS_PER_HOUR + 2)]
check(results[:courriel.SENDS_PER_HOUR] == [428] * courriel.SENDS_PER_HOUR and results[-1] == 429 and len(smtp.mails) == courriel.SENDS_PER_HOUR, "cinq envois par heure, puis 429", results)
fresh_mail()
smtp.mails.clear()
stolen_session = bearer(device(franck, "Volé"))
results = [stolen_session.post("/api/devices/others/revoke").status_code for _ in range(8)]
results += [stolen_session.post("/api/devices/others/revoke", json={"motdepasse": "je-devine"}).status_code for _ in range(3)]
check(set(results) == {428, 400} and not smtp.mails, "jeton volé : aucun courriel ne part sans le mot de passe, la boîte reste tranquille", results)
fresh_limits()

print("-- Un autre compte a sa propre adresse")
nina_session = bearer(nina_token := device(nina, "Nina"))
r = nina_session.post("/api/me/courriel", json={"adresse": "nina@exemple.test", "motdepasse": NINA_PW})
check(r.status_code == 200 and nina_session.post("/api/me/courriel/activer", json={"code": smtp.last_code("nina@exemple.test")}).status_code == 200, "un profil active son adresse")
check(owner.get("/api/me/courriel").json()["adresse"] == ADDRESS, "chacun la sienne")
fresh_mail()
nina_session.post("/api/devices/others/revoke", json={"motdepasse": NINA_PW})
nina_code = smtp.last_code("nina@exemple.test")
check(owner.post("/api/devices/others/revoke", json={**PW, "courriel": nina_code}).status_code == 400, "le code d'un autre compte ne vaut rien ici")
check(nina_session.post("/api/devices/others/revoke", json={"motdepasse": NINA_PW, "courriel": nina_code}).status_code == 200, "il vaut pour le sien")
check(owner.request("DELETE", "/api/courriel/smtp", json=PW).status_code == 409, "retirer le réglage pendant que des adresses sont actives : refusé")

print("-- Envoi en panne : refus clair, puis récupération depuis le serveur")
fresh_mail()
smtp.refuse = True
victim = device(franck, "Autre appareil")
started = time.time()
r = owner.post("/api/devices/others/revoke", json=PW)
check(r.status_code == 503 and "noah.recuperation" in r.text and alive(victim), "l'action refuse, avec un message clair et la commande de secours", r.text)
check(time.time() - started < courriel.TIMEOUT + 5, "sans bloquer longtemps")
r = owner.post("/api/me/password", json={"actuel": FRANCK_PW, "nouveau": "motdepasse-franck-3"})
check(r.status_code == 503 and auth.check_password("franck", FRANCK_PW) == franck, "changer le mot de passe aussi : rien ne change", r.text)
check(owner.get("/api/me").status_code == 200 and logged_in("franck", FRANCK_PW).get("/api/me").status_code == 200, "se connecter reste possible : personne n'est enfermé dehors")
r = owner.request("DELETE", f"/api/devices/{public_id(victim)}", json=PW)
check(r.status_code == 200, "couper un appareil précis reste possible, avec le mot de passe", r.text)
result = subprocess.run([sys.executable, "-m", "noah.recuperation", "--couper-courriel"], cwd="/app", env=os.environ.copy(), capture_output=True, text=True, timeout=60)
check(result.returncode == 0 and "coupé" in result.stdout, "python -m noah.recuperation --couper-courriel", result.stdout + result.stderr)
check("Courriel de confirmation coupé" in result.stderr or "Courriel de confirmation coupé" in result.stdout, "la commande le journalise", result.stderr)
victim = device(franck, "Autre appareil")
check(owner.post("/api/devices/others/revoke", json=PW).status_code == 200 and not alive(victim), "l'exigence est coupée : l'action repasse sans courriel")
check(owner.get("/api/me/courriel").json()["active"] is False, "l'adresse reste notée, inactive")
smtp.refuse = False
fresh_mail()

print("-- Récupération par le code de la page : couper l'exigence aussi, journalisé")
owner.post("/api/me/courriel", json={"adresse": ADDRESS, **PW})
owner.post("/api/me/courriel/activer", json={"code": smtp.last_code(ADDRESS)})
check(courriel.active(franck), "adresse de nouveau active")
journal.lines.clear()
recovery = recuperation.issue(replace=True)
RECOVERED_PW = "recupere-franck-long"
r = anyone().post("/api/recuperation", json={"code": recovery, "password": RECOVERED_PW, "couper_courriel": True})
check(r.status_code == 200 and not courriel.active(franck) and auth.check_password("franck", RECOVERED_PW) == franck, "le code de récupération peut couper l'exigence", r.text)
check(any("Courriel de confirmation coupé" in line for line in journal.lines), "journalisé", journal.lines)
FRANCK_PW = RECOVERED_PW
PW = {"motdepasse": FRANCK_PW}
SECRETS_OUT = ["mot-de-passe-du-courriel"] + [m["sujet"].rsplit(" ", 1)[-1] for m in smtp.mails if re.search(r"\d{6}$", m["sujet"])]
check(not any(secret in line for secret in SECRETS_OUT for line in journal.lines), "ni le mot de passe d'envoi ni les codes ne sont dans les journaux")

# ==== 5. Nouvel appareil ================================================================================================================
print("== 5. Nouvel appareil")
fresh_limits()
fresh_mail()
owner_token = device(franck, "Bureau")
owner = bearer(owner_token)
owner.post("/api/me/courriel", json={"adresse": ADDRESS, **PW})
owner.post("/api/me/courriel/activer", json={"code": smtp.last_code(ADDRESS)})


def pending(session: httpx.Client) -> list[dict]:
    return session.get("/api/me/alertes-appareils").json()["alertes"]


def clear_alerts() -> None:
    with db.connect() as c:
        c.execute("DELETE FROM alertes_appareils")


clear_alerts()
alerts.clear()
smtp.mails.clear()
started = time.time()
newcomer = logged_in("franck", FRANCK_PW, "203.0.113.7")
check(time.time() - started < 5 and newcomer.get("/api/me").status_code == 200, "la connexion n'attend aucun accord")
check(wait_for(lambda: any(a["titre"] == "Nouvel appareil sur ton compte" for a in alerts)), "notification envoyée aux appareils du compte", alerts)
note = next(a for a in alerts if a["titre"].startswith("Nouvel appareil"))
check(note["user"] == franck and note["urgent"] and "203.0.113.7" in note["texte"] and "réseau jamais vu" in note["texte"] and "UTC" in note["texte"], "avec le nom, l'adresse, le réseau et la date", note)
check(wait_for(lambda: smtp.count(ADDRESS) == 1), "et un courriel, l'adresse étant active")
mail = smtp.mails[-1]["corps"]
check("203.0.113.7" in mail and "Appareil" in mail and "Réseau" in mail and "Date" in mail, "le courriel donne les mêmes informations", mail)
seen = pending(owner)
check(len(seen) == 1 and seen[0]["ip"] == "203.0.113.7" and seen[0]["reseau_connu"] is False and seen[0]["date"] and seen[0]["nom"], "l'appareil déjà relié voit l'alerte, sans rien en mémoire de son côté", seen)
check(pending(newcomer) == [], "l'appareil lui-même n'est pas signalé")
second_look = bearer(device(franck, "Tablette neuve"))
check([a["id"] for a in pending(second_look)] == [seen[0]["id"]], "un appareil qui n'a jamais rien vu voit aussi l'alerte : l'état est côté serveur")
check(pending(bearer(device(nina))) == [], "profil isolé : un autre compte ne la voit pas")
check(bearer(device(nina)).post(f"/api/me/alertes-appareils/{seen[0]['id']}/pas-moi").status_code == 404 and newcomer.get("/api/me").status_code == 200, "ni ne la tranche")
check(newcomer.post(f"/api/me/alertes-appareils/{seen[0]['id']}/moi").status_code == 404, "l'appareil signalé ne se confirme pas lui-même")
check(owner.post("/api/me/alertes-appareils/inconnue/pas-moi").status_code == 404, "alerte inconnue : 404")

print("-- C'est moi")
stolen = owner.post(f"/api/me/alertes-appareils/{seen[0]['id']}/moi")
check(stolen.status_code == 428 and len(pending(owner)) == 1, "jeton volé : « C'est moi » demande le mot de passe, l'alerte reste", stolen.text)
check(owner.post(f"/api/me/alertes-appareils/{seen[0]['id']}/moi", json={"motdepasse": "pas-le-bon-mot-de-passe"}).status_code == 400 and len(pending(owner)) == 1, "un faux mot de passe ne la ferme pas")
check(owner.post(f"/api/me/alertes-appareils/{seen[0]['id']}/moi", json={"motdepasse": FRANCK_PW}).status_code == 200 and pending(owner) == [], "« C'est moi » la ferme pour tout le monde")
check(pending(second_look) == [], "partout")
check(newcomer.get("/api/me").status_code == 200, "l'appareil reste connecté")
check(owner.post(f"/api/me/alertes-appareils/{seen[0]['id']}/pas-moi").status_code == 404, "une fois tranchée, elle ne coupe plus personne")
alerts.clear()
newcomer.post("/api/logout", json={})
again = newcomer.post("/api/login", json={"username": "franck", "password": FRANCK_PW})
check(again.status_code == 200 and pending(owner) == [], "même navigateur, même réseau : pas de nouvelle alerte")
time.sleep(0.3)
check(not any(a["titre"].startswith("Nouvel appareil") for a in alerts), "ni de notification", alerts)
other_net = httpx.Client(base_url=BASE, headers={"X-Forwarded-For": "192.0.2.9", "Origin": BASE}, cookies={"noah_appareil": newcomer.cookies.get("noah_appareil")}, timeout=30)
check(other_net.post("/api/login", json={"username": "franck", "password": FRANCK_PW}).status_code == 200 and len(pending(owner)) == 1, "même navigateur, autre réseau : alerte")
clear_alerts()
near = httpx.Client(base_url=BASE, headers={"X-Forwarded-For": "203.0.113.200", "Origin": BASE}, cookies={"noah_appareil": newcomer.cookies.get("noah_appareil")}, timeout=30)
check(near.post("/api/login", json={"username": "franck", "password": FRANCK_PW}).status_code == 200 and pending(owner) == [], "même navigateur, même réseau avec une autre dernière adresse : pas d'alerte")

print("-- Sans réponse, l'alerte revient")
clear_alerts()
ignored = logged_in("franck", FRANCK_PW, "203.0.114.1")
first_alert = pending(owner)[0]["id"]
ignored.post("/api/logout", json={})
check(pending(owner) == [], "la session partie, l'alerte part avec elle")
check(ignored.post("/api/login", json={"username": "franck", "password": FRANCK_PW}).status_code == 200 and len(pending(owner)) == 1, "se reconnecter sans avoir été confirmé : nouvelle alerte, un intrus ne s'efface pas")
check(pending(owner)[0]["id"] != first_alert, "une alerte de plus, pas la même")

print("-- Ce n'est pas moi")
clear_alerts()
intruder = logged_in("franck", FRANCK_PW, "203.0.115.1")
intruder_token = intruder.cookies.get(auth.COOKIE)
spare = device(franck, "Autre de mes appareils")
alert_id = pending(owner)[-1]["id"]
r = owner.post(f"/api/me/alertes-appareils/{alert_id}/pas-moi")
check(r.status_code == 200 and r.json()["changer_mot_de_passe"] is True, "sans preuve, et l'écran propose de changer le mot de passe", r.text)
check(intruder.get("/api/me").status_code == 401, "la session signalée est coupée")
check(alive(spare) and alive(owner_token), "aucun autre appareil ne bouge")
check(not any(alert["id"] == alert_id for alert in pending(owner)), "l'alerte a disparu")
clear_alerts()
back = httpx.Client(base_url=BASE, headers={"X-Forwarded-For": "203.0.115.1", "Origin": BASE}, cookies={"noah_appareil": intruder.cookies.get("noah_appareil") or ""}, timeout=30)
check(back.post("/api/login", json={"username": "franck", "password": FRANCK_PW}).status_code == 200 and len(pending(owner)) == 1, "s'il revient avec le mot de passe, il est de nouveau signalé")
clear_alerts()
check(owner.post(f"/api/me/alertes-appareils/{alert_id}/pas-moi").status_code == 404, "« Ce n'est pas moi » ne vaut que pour une session signalée")
check(alive(spare), "une session non signalée ne peut pas être coupée par là")

print("-- Deux connexions d'un voleur de mot de passe ne s'approuvent pas")
clear_alerts()
one, two = logged_in("franck", FRANCK_PW, "203.0.116.1"), logged_in("franck", FRANCK_PW, "203.0.116.2")
on_one = pending(one)
check(len(on_one) == 1 and on_one[0]["peut_confirmer"] is False, "chacune voit l'autre, sans pouvoir la confirmer tant qu'un appareil sûr existe", on_one)
check(one.post(f"/api/me/alertes-appareils/{on_one[0]['id']}/moi").status_code == 403, "refus de « C'est moi »")
check(all(a["peut_confirmer"] for a in pending(owner)), "l'appareil déjà relié, lui, peut")
clear_alerts()

print("-- Plus aucun appareil au-dessus de tout soupçon : le plus ancien confirme les plus récents")
lonely = auth.create_user("solo", "motdepasse-solo")
solo_laptop = logged_in("solo", "motdepasse-solo", "203.0.117.1")
check(pending(solo_laptop) == [], "le tout premier appareil d'un compte n'est signalé à personne")
with db.connect() as c:
    check(c.execute("SELECT COUNT(*) FROM alertes_appareils WHERE user_id = ?", (lonely,)).fetchone()[0] == 0, "et aucune alerte n'attend")
solo_laptop.post("/api/logout", json={})
first_again = logged_in("solo", "motdepasse-solo", "203.0.117.77")
second_new = logged_in("solo", "motdepasse-solo", "203.0.118.1")
on_first, on_second = pending(first_again), pending(second_new)
check(on_first[0]["peut_confirmer"] is True and on_second[0]["peut_confirmer"] is False, "le plus ancien peut, le plus récent non", (on_first, on_second))
check(first_again.post(f"/api/me/alertes-appareils/{on_first[0]['id']}/moi").status_code == 200, "le plus ancien confirme le plus récent")
on_second = pending(second_new)
check(on_second and on_second[0]["peut_confirmer"] is True and second_new.post(f"/api/me/alertes-appareils/{on_second[0]['id']}/moi").status_code == 200, "qui peut alors le confirmer à son tour : rien ne reste bloqué")

print("-- QR accordé et flux du bureau")
clear_alerts()
alerts.clear()
holder_token = device(franck, "Écran du QR", "desktop")
holder = bearer(holder_token)
link = holder.post("/api/pairing").json()["adresse"].rsplit("=", 1)[1]
phone = anyone("203.0.119.1")
claim = phone.post("/api/pairing/claim", json={"code": link, "appareil": "Pixel 9", "type": "android"}).json()
asked = holder.get("/api/pairing/pending").json()["demandes"][0]["id"]
r = holder.post(f"/api/pairing/flow/{asked}/autoriser", json={"verification": claim["verification"], "motdepasse": FRANCK_PW})
check(r.status_code == 200, "le QR est accordé", r.text)
polled = phone.post("/api/pairing/flow/poll", json={"sondage": claim["sondage"]})
check(polled.status_code == 200, "le téléphone reçoit sa session", polled.text)
qr_alerts = pending(owner)
check(len(qr_alerts) == 1 and qr_alerts[0]["nom"] == "Pixel 9" and qr_alerts[0]["type"] == "android", "QR : alerte sur les autres appareils", qr_alerts)
check(pending(bearer(polled.json()["token"])) == [], "pas sur le téléphone lui-même")
check(wait_for(lambda: any("Pixel 9" in a["texte"] for a in alerts)), "avec sa notification", alerts)
check(owner.post(f"/api/me/alertes-appareils/{qr_alerts[0]['id']}/pas-moi").status_code == 200 and not alive(polled.json()["token"]), "« Ce n'est pas moi » coupe ce téléphone")
clear_alerts()
pc = anyone("203.0.119.2")
flow = pc.post("/api/pairing/flow", json={"appareil": "PC du salon", "type": "desktop"}).json()
public = flow["adresse"].rsplit("=", 1)[1]
approver = logged_in("franck", FRANCK_PW, "203.0.113.7")
clear_alerts()
number = approver.get(f"/api/pairing/flow/{public}").json()["verification"]
check(approver.post(f"/api/pairing/flow/{public}/autoriser", json={"verification": ""}).status_code == 200, "le flux du bureau est accordé")
polled = pc.post("/api/pairing/flow/poll", json={"sondage": flow["sondage"], "verification": number})
check(polled.status_code == 200, "l'app de bureau reçoit sa session", polled.text)
desktop_alerts = pending(owner)
check(len(desktop_alerts) == 1 and desktop_alerts[0]["nom"] == "PC du salon" and desktop_alerts[0]["type"] == "desktop", "flux du bureau : alerte", desktop_alerts)
clear_alerts()

print("-- Application de bureau : notification native par son canal existant")
clear_alerts()
desk_token = device(franck, "Mon ordinateur", "desktop")
got: dict = {}


def poll_desktop() -> None:
    got["reponse"] = bearer(desk_token).get("/api/desktop/next", params={"os": "windows"}).json()


waiter = threading.Thread(target=poll_desktop, daemon=True)
waiter.start()
check(wait_for(lambda: bearer(desk_token).get("/api/desktop/status").json()["connecte"]), "l'application de bureau attend ses actions")
logged_in("franck", FRANCK_PW, "203.0.120.1")
waiter.join(10)
check(got.get("reponse", {}).get("action") == "notifier" and got["reponse"]["titre"] == "Nouvel appareil sur ton compte", "elle reçoit « notifier », que desktop/actions.js montre en notification native", got)
clear_alerts()

print("-- Le courriel en panne ne touche pas à la connexion")
smtp.refuse = True
alerts.clear()
who = logged_in("franck", FRANCK_PW, "203.0.121.1")
check(who.get("/api/me").status_code == 200 and len(pending(owner)) >= 1, "connexion et alerte restent, même si le courriel ne part pas")
smtp.refuse = False
clear_alerts()

if failed:
    print(f"\n{len(failed)} ÉCHEC(S) :")
    for item in failed:
        print(" -", item)
    sys.exit(1)
print("\ncomptes : tout est vert")
