"""Deux faux services pour éprouver de vrais conteneurs Hermes sans clé ni dépense (G8.1, G12.3, G12.5).

- Un modèle compatible OpenAI (port 11500) qui facture chaque appel (`usage.cost`) et garde tout ce qu'il reçoit : ce qu'Hermes
  envoie au modèle se lit donc pour de vrai, invite système comprise. Une ligne « OUTIL <nom> <json> » dans le message de
  l'utilisateur lui fait appeler cet outil ; il répond ensuite « RESULTAT : <sortie de l'outil> ».
- Un service de push (port 8443, HTTPS) qui joue le téléphone : il déchiffre chaque message avec sa propre clé (RFC 8291).
- Avec FAUX_PETIT=1, un second modèle, « faux-petit » : il réussit l'essai du modèle de décision, juge « pertinent » ce qui contient
  URGENT, et refuse une note de mémoire qui parle d'installation. Une page (/veille-page, /_page) qu'une veille peut relever.

Le serveur le joint par NOAH_PUSH_HOSTS et fait confiance à son certificat par SSL_CERT_FILE. Voir compose.essai.yml.
    python faux_services.py
"""
import base64
import datetime
import ipaddress
import json
import os
import re
import ssl
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.x509.oid import NameOID

MODEL = "faux-modele"
HOST = os.environ.get("FAUX_NOM", "noah-faux")
SMALL = "faux-petit"
state = {"cout": 0.0, "appels": [], "push": [], "page": ""}
lock = threading.Lock()


def _small_reply(system: str, user: str) -> str:
    """Le modèle de décision : l'essai, le tri d'une veille, le jugement d'une note de mémoire."""
    if "un courriel de Paul à propos d'une facture" in system:
        return json.dumps({"pertinent": True, "retenues": [2]})
    if "Tu fais le tri" in system:
        return json.dumps({"pertinent": True, "resume": "Un bloc urgent est apparu sur la page.", "retenues": [1]} if "URGENT" in user
                          else {"pertinent": False, "resume": "", "retenues": []})
    if system.startswith("Une note de mémoire"):
        lines = user.splitlines()
        return json.dumps({"refus": [{"n": i, "raison": "Détail d'installation."} for i, line in enumerate(lines, 1) if "installation" in line.lower()]})
    return "Bien reçu."


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# --- Le téléphone : sa clé, et le déchiffrement de ce qu'il reçoit -----------------------------------------------------
DEVICE = ec.generate_private_key(ec.SECP256R1())
DEVICE_PUBLIC = DEVICE.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
AUTH = os.urandom(16)


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(hashes.SHA256(), length, salt, info).derive(ikm)


def decrypt(body: bytes) -> dict:
    salt, rs, keylen = body[:16], *struct.unpack("!IB", body[16:21])
    sender = body[21:21 + keylen]
    shared = DEVICE.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender))
    ikm = _hkdf(AUTH, shared, b"WebPush: info\x00" + DEVICE_PUBLIC + sender, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, body[21 + keylen:], None)
    return json.loads(plain[:plain.rindex(b"\x02")])


class Push(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            message = decrypt(body)
        except Exception as e:  # noqa: BLE001 - un message illisible par le téléphone est un défaut à montrer
            message = {"illisible": str(e)}
        with lock:
            state["push"].append({"appareil": self.path, "urgence": self.headers.get("Urgency"), "vapid": (self.headers.get("Authorization") or "")[:6],
                                  "recu_apres_appels": len(state["appels"]), "cout_cumule": sum(a["cout"] for a in state["appels"]), "message": message})
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()


def certificate() -> ssl.SSLContext:
    """Certificat tiré au démarrage et posé dans le volume commun : le serveur l'accepte, et rien d'autre ne change."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, HOST)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(hours=1)).not_valid_after(now + datetime.timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(HOST), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    os.makedirs("/ca", exist_ok=True)
    pem = cert.public_bytes(serialization.Encoding.PEM)
    with open("/ca/ca.pem", "wb") as f:
        f.write(pem)
    with open("/tmp/cle.pem", "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    with open("/tmp/cert.pem", "wb") as f:
        f.write(pem)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain("/tmp/cert.pem", "/tmp/cle.pem")
    return context


# --- Le modèle ---------------------------------------------------------------------------------------------------------
def _text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    return " ".join(p.get("text", "") for p in content or [] if isinstance(p, dict))


def _last_user(messages: list) -> str:
    return next((_text(m) for m in reversed(messages) if m.get("role") == "user"), "")


class Model(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, body, code=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/_journal":
            with lock:
                return self._json({"appels": state["appels"], "push": state["push"], "cout": state["cout"]})
        if self.path == "/_abonnement":
            return self._json({"endpoint": f"https://{HOST}:8443/telephone", "p256dh": _b64(DEVICE_PUBLIC), "auth": _b64(AUTH)})
        if self.path == "/veille-page":
            with lock:
                data = state["page"].encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if self.path.startswith("/page"):  # page de test du navigateur : ce qu'elle reçoit prouve quel cookie part
            data = f"<html><body>page {self.headers.get('Cookie', 'sans-cookie')}</body></html>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if self.path.endswith("/models"):
            extra = [{"id": SMALL, "object": "model", "context_length": 128000}] if os.environ.get("FAUX_PETIT") else []
            return self._json({"object": "list", "data": [{"id": MODEL, "object": "model", "context_length": 128000}, *extra]})
        return self._json({"ok": True})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/_cout":
            with lock:
                state["cout"] = float(body["cout"])
            return self._json({"ok": True})
        if self.path == "/_page":
            with lock:
                state["page"] = body["html"]
            return self._json({"ok": True})
        if self.path == "/_vider":
            with lock:
                state["appels"].clear()
                state["push"].clear()
            return self._json({"ok": True})
        if not self.path.endswith("/chat/completions"):
            return self._json({"error": "introuvable"}, 404)
        messages = body.get("messages") or []
        system = " ".join(_text(m) for m in messages if m.get("role") == "system")
        with lock:
            cost = state["cout"]
            state["appels"].append({"t": time.time(), "cout": cost, "dernier": _text(messages[-1])[-2000:] if messages else "", "systeme": system,
                                    "tout": json.dumps(messages, ensure_ascii=False), "outils": [t["function"]["name"] for t in body.get("tools") or []],
                                    "modele": body.get("model")})
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": cost}
        base = {"id": "faux", "object": "chat.completion", "created": int(time.time()), "model": MODEL}
        last = messages[-1] if messages else {}
        if body.get("model") == SMALL and not body.get("stream"):
            content = _small_reply(system, _last_user(messages))
            return self._json(base | {"choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}], "usage": usage})
        call = re.search(r"^OUTIL (\w+) (.+)$", _last_user(messages), re.M)
        if call and last.get("role") == "user" and body.get("tools"):
            return self._tool(body, base, usage, call.group(1), call.group(2))
        if last.get("role") == "tool":
            text = "RESULTAT : " + _text(last)[:3000]
        else:
            found = re.findall(r"Réponds seulement\s*:\s*(.+)", _last_user(messages))
            text = found[-1].strip() if found else "Bien reçu."
        if not body.get("stream"):
            return self._json(base | {"choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": usage})
        self._stream(base, [{"choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
                            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage}])
        return None

    def _tool(self, body, base, usage, name, arguments):
        tool = {"index": 0, "id": "appel-" + os.urandom(4).hex(), "type": "function", "function": {"name": name, "arguments": arguments}}
        if not body.get("stream"):
            return self._json(base | {"choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [tool]}, "finish_reason": "tool_calls"}], "usage": usage})
        self._stream(base, [{"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [tool]}, "finish_reason": None}]},
                            {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": usage}])
        return None

    def _stream(self, base, chunks):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for c in chunks:
            self.wfile.write(f"data: {json.dumps(base | c, ensure_ascii=False)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True


def main() -> None:
    context = certificate()
    secure = ThreadingHTTPServer(("0.0.0.0", 8443), Push)
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    threading.Thread(target=secure.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 11500), Model).serve_forever()


if __name__ == "__main__":
    main()
