"""Connexion OAuth sans copier-coller, avec le vrai code d'Hermes et un faux fournisseur complet (découverte, enregistrement,
accord, jeton, serveur MCP). Ce que cela prouve : Hermes accepte l'adresse de retour de Noah, s'enregistre sous le nom de Noah
Agent, et termine avec ce que le fournisseur a renvoyé ; un fournisseur qui refuse cette adresse retombe sur 127.0.0.1 ; le
mauvais `state` est refusé. Puis : les connexions de Nous Portal sont coupées, et son compte anonyme disparaît au démarrage.

    MSYS_NO_PATHCONV=1 docker run --rm --memory=1g --entrypoint /opt/hermes/.venv/bin/python \
      -v "$PWD/launcher:/launcher:ro" -v "$PWD/server/noah/agent_plugin:/plugin:ro" -v "$PWD/tests/tools:/check:ro" \
      nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d /check/oauth_retour_check.py
"""
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA = Path("/opt/data")
(DATA / "workspace").mkdir(parents=True, exist_ok=True)
os.environ.update(HERMES_HOME=str(DATA), HOME=str(DATA))
sys.path.insert(0, "/opt/hermes")
ADMIN = Path("/launcher/agent_admin.py").read_text(encoding="utf-8")
RETOUR = "https://noah.exemple.test/api/connexion/retour"

seen = {"enregistre": [], "refuse_https": False}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200, headers=None):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def _base(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/.well-known/oauth-protected-resource"):
            return self._json({"resource": self._base() + "/mcp", "authorization_servers": [self._base()]})
        if path.startswith("/.well-known/oauth-authorization-server"):
            return self._json({"issuer": self._base(), "authorization_endpoint": self._base() + "/authorize",
                               "token_endpoint": self._base() + "/token", "registration_endpoint": self._base() + "/register",
                               "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
                               "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]})
        self._json({"error": "not_found"}, 404)

    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(size)
        path = urllib.parse.urlsplit(self.path).path
        if path == "/register":
            body = json.loads(raw)
            if seen["refuse_https"] and any(u.startswith("https://") for u in body["redirect_uris"]):
                return self._json({"error": "invalid_redirect_uri"}, 400)
            seen["enregistre"].append(body)
            return self._json({**body, "client_id": f"client-{len(seen['enregistre'])}"}, 201)
        if path == "/token":
            return self._json({"access_token": "jeton", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "suite"})
        if path == "/mcp":
            if self.headers.get("Authorization") != "Bearer jeton":
                return self._json({"error": "unauthorized"}, 401, {
                    "WWW-Authenticate": f'Bearer resource_metadata="{self._base()}/.well-known/oauth-protected-resource"'})
            msg = json.loads(raw)
            if "id" not in msg:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            result = {"initialize": {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
                                     "capabilities": {"tools": {}}, "serverInfo": {"name": "essai", "version": "1"}},
                      "tools/list": {"tools": [{"name": "lire", "description": "Lire", "inputSchema": {"type": "object"}}]}}.get(msg["method"], {})
            return self._json({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        self._json({"error": "not_found"}, 404)


server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{server.server_port}/mcp"


def admin(action, body):
    run = subprocess.run([sys.executable, "-c", ADMIN, action, json.dumps(body)], capture_output=True, text=True, timeout=120, cwd=str(DATA))
    lines = run.stdout.strip().splitlines()
    assert lines, f"{action} : rien en sortie, {run.stderr[-400:]}"
    return json.loads(lines[-1])


def query_of(address):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(address).query))


config = {"url": URL, "auth": "oauth", "timeout": 30, "connect_timeout": 30, "sampling": {"enabled": False}}

# 1. Le fournisseur reviendra sur Noah, et l'écran d'accord dira « Noah Agent ».
out = admin("outil_poser", {"nom": "essai", "config": config, "droits": {}, "retour": RETOUR})
assert out.get("retour") is True and out.get("adresse"), out
asked = query_of(out["adresse"])
assert asked["redirect_uri"] == RETOUR, asked
assert seen["enregistre"][-1]["redirect_uris"] == [RETOUR], seen
assert seen["enregistre"][-1]["client_name"] == "Noah Agent", seen
print("1. adresse d'accord avec le retour de Noah, enregistré sous le nom de Noah Agent")

# 2. Un mauvais state ne connecte rien.
bad = admin("outil_finir", {"nom": "essai", "adresse": "?code=abc&state=faux"})
assert bad.get("erreur"), bad
from tools.mcp_oauth import HermesTokenStorage  # noqa: E402
assert not HermesTokenStorage("essai").has_cached_tokens()
print("2. mauvais state : refusé, aucun jeton")

# 3. Le retour du fournisseur, rejoué par le serveur Noah, termine la connexion. Sans copier-coller.
out = admin("outil_connecter", {"nom": "essai", "retour": RETOUR})
asked = query_of(out["adresse"])
done = admin("outil_finir", {"nom": "essai", "adresse": "?" + urllib.parse.urlencode({"code": "abc", "state": asked["state"]})})
assert done.get("connecte") is True, done
assert [t["name"] for t in done["outils"]] == ["lire"], done
assert HermesTokenStorage("essai").has_cached_tokens()
print("3. retour rejoué : connecté, jeton gardé, outils listés")
admin("outil_retirer", {"nom": "essai", "droits": {}})

# 4. Un fournisseur qui n'accepte que 127.0.0.1 garde la voie par copier-coller.
seen["refuse_https"] = True
out = admin("outil_poser", {"nom": "local", "config": config, "droits": {}, "retour": RETOUR})
assert out.get("retour") is False, out
assert query_of(out["adresse"])["redirect_uri"].startswith("http://127.0.0.1:"), out
assert seen["enregistre"][-1]["client_name"] != "Noah Agent", seen
print("4. retour refusé par le fournisseur : 127.0.0.1 et copier-coller, sous le nom par défaut")
admin("outil_retirer", {"nom": "local", "droits": {}})

# 5. Nous Portal coupé : l'outil n'existe plus pour l'agent, et aucun compte anonyme ne peut naître.
from hermes_cli.config import load_config_readonly  # noqa: E402,F401
config_file = DATA / "config.yaml"
base = config_file.read_text(encoding="utf-8") if config_file.exists() else ""
check = ("import sys; sys.path.insert(0, '/opt/hermes');"
         "from tools.connectors.gateway.config import connectors_available as a, guest_identity_pending as p;"
         "print(a(), p())")
config_file.write_text("tools: {}\n", encoding="utf-8")
before = subprocess.run([sys.executable, "-c", check], capture_output=True, text=True, cwd=str(DATA), timeout=60).stdout.split()
assert before[-2:] == ["True", "True"], f"sans réglage, Hermes doit proposer ces connexions, sinon ce test ne prouve rien : {before}"
config_file.write_text("tools:\n  connectors:\n    enabled: false\nnous:\n  guest: false\n", encoding="utf-8")
after = subprocess.run([sys.executable, "-c", check], capture_output=True, text=True, cwd=str(DATA), timeout=60).stdout.split()
assert after[-2:] == ["False", "False"], after
config_file.write_text(base, encoding="utf-8")
print("5. réglages de Noah : connexions de Nous Portal absentes, aucun compte anonyme possible (sans eux : présentes)")

# 6. Le compte anonyme déjà créé disparaît au démarrage du plugin. Un compte choisi par la personne reste.
sys.path.insert(0, "/")
import importlib.util  # noqa: E402
spec = importlib.util.spec_from_file_location("garde", "/plugin/__init__.py")
garde = importlib.util.module_from_spec(spec)
spec.loader.exec_module(garde)
auth_file = DATA / "auth.json"
auth_file.write_text(json.dumps({"active_provider": "nous", "providers": {"nous": {"auth_method": "anonymous", "agent_key": "anon_x"}, "autre": {"a": 1}}}))
os.chmod(auth_file, 0o600)
garde._forget_nous_guest()
data = json.loads(auth_file.read_text())
assert "nous" not in data["providers"] and data["providers"]["autre"] == {"a": 1} and data["active_provider"] is None, data
assert (auth_file.stat().st_mode & 0o777) == 0o600
auth_file.write_text(json.dumps({"providers": {"nous": {"auth_method": "oauth"}}}))
garde._forget_nous_guest()
assert json.loads(auth_file.read_text())["providers"]["nous"]["auth_method"] == "oauth"
auth_file.unlink()
garde._forget_nous_guest()  # pas de fichier : rien à faire, pas d'erreur
print("6. compte anonyme retiré au démarrage, droits du fichier gardés ; un compte choisi reste")
print("OK")
