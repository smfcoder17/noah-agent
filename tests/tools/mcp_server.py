"""Petit serveur MCP de test, en vrai HTTP (protocole minimal : initialize, tools/list, tools/call), sans dépendance.

Sert à tests/tools/mcp_test.py et à tests/tools/mcp_hermes_check.py. Il retient tout ce qu'il reçoit, pour vérifier ce qui
est réellement arrivé jusqu'à lui.
"""
import http.server
import json
import threading

TOOLS = [
    {"name": "lire_fiche", "description": "Lit une fiche.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "creer_fiche", "description": "Crée une fiche.", "inputSchema": {"type": "object", "properties": {"titre": {"type": "string"}}}},
    {"name": "echo_jeton", "description": "Répète l'en-tête reçu (serveur maladroit).", "inputSchema": {"type": "object", "properties": {}}},
]


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0, token=None, sse=False, session=True, fiches=None):
        super().__init__(("0.0.0.0", port), Handler)
        self.expected = token  # sans lui : réponse 401, comme un vrai serveur protégé
        self.sse = sse  # répond en flux (text/event-stream) plutôt qu'en JSON
        self.session = session
        self.fiches = fiches  # {id: texte} : lire_fiche rend un vrai contenu, que l'agent peut répéter ou déformer
        self.calls = []  # (outil, arguments, en-tête Authorization) de chaque tools/call
        self.auth_seen = []
        self.sessions_opened = 0
        self.redirect_to = None
        self.forget_sessions = False
        self.live = set()

    @property
    def port(self):
        return self.server_address[1]

    def start(self):
        threading.Thread(target=self.serve_forever, daemon=True).start()
        return self


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, status, body=b"", ctype="application/json", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        self._send(405)

    def do_DELETE(self):
        self._send(405)

    def do_POST(self):
        srv = self.server
        length = int(self.headers.get("Content-Length") or 0)
        msg = json.loads(self.rfile.read(length) or b"{}")
        auth = self.headers.get("Authorization") or ""
        srv.auth_seen.append(auth)
        if srv.redirect_to:
            return self._send(302, extra={"Location": srv.redirect_to})
        if srv.expected and auth != f"Bearer {srv.expected}":
            return self._send(401, b'{"error": "unauthorized"}', extra={"WWW-Authenticate": "Bearer"})
        method = msg.get("method", "")
        if "id" not in msg:
            return self._send(202)
        extra = {}
        if method == "initialize":
            sid = f"sess-{srv.sessions_opened}"
            srv.sessions_opened += 1
            srv.live.add(sid)
            if srv.session:
                extra["Mcp-Session-Id"] = sid
            result = {"protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "fiches", "version": "1"}}
        else:
            given = self.headers.get("Mcp-Session-Id")
            if srv.session and (srv.forget_sessions or given not in srv.live):
                srv.forget_sessions = False
                srv.live.clear()
                return self._send(404, b'{"error": "session"}')
            if method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "ping":
                result = {}
            elif method == "tools/call":
                name = msg["params"]["name"]
                args = msg["params"].get("arguments") or {}
                srv.calls.append((name, args, auth))
                text = auth if name == "echo_jeton" else f"fait : {name} {json.dumps(args, ensure_ascii=False)}"
                if name == "lire_fiche" and srv.fiches is not None:
                    text = srv.fiches.get(str(args.get("id")), "Fiche introuvable.")
                result = {"content": [{"type": "text", "text": text}]}
            else:
                return self._send(200, json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "inconnu"}}).encode())
        answer = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}, ensure_ascii=False).encode()
        if srv.sse:
            return self._send(200, b"event: message\ndata: " + answer + b"\n\n", "text/event-stream", extra)
        self._send(200, answer, extra=extra)
