"""Le vrai client MCP d'Hermes face à un serveur qui parle comme le relais de Noah : session à l'initialisation, flux GET,
`notifications/tools/list_changed`. Ce que cela prouve : Hermes reçoit la notification et son registre d'outils change, sans
reconnexion. Ce que cela ne prouve pas : un tour de modèle ni la gateway. Trop lourd pour la CI (image de 4 Go) : à la main.

    MSYS_NO_PATHCONV=1 docker run --rm --memory=1g --entrypoint /opt/hermes/.venv/bin/python \
      -v "$PWD/tests/tools:/check:ro" nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d /check/mcp_hermes_liste.py
"""
import json
import os
import queue
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path(tempfile.mkdtemp())
os.environ.update(HERMES_HOME=str(HOME), HOME=str(HOME))
sys.path.insert(0, "/opt/hermes")

READ = {"name": "lire_fiche", "description": "Lit", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}}
WRITE = {"name": "creer_fiche", "description": "Crée", "inputSchema": {"type": "object"}}
state = {"droit": "lire", "lists": 0, "inits": 0}
stream: queue.Queue = queue.Queue()


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "id" not in msg:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if msg["method"] == "initialize":
            state["inits"] += 1
            return self._json({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "noah-mes-fiches", "version": "1"}}}, {"Mcp-Session-Id": "s1"})
        if msg["method"] == "tools/list":
            state["lists"] += 1
            return self._json({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [READ] if state["droit"] == "lire" else [READ, WRITE]}})
        return self._json({"jsonrpc": "2.0", "id": msg["id"], "result": {}})

    def do_GET(self):
        if "Mcp-Session-Id" not in self.headers:  # la sonde d'Hermes
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.flush()
        state["stream"] = True
        while True:
            try:
                data = stream.get(timeout=1)
            except queue.Empty:
                self.wfile.write(b": vivant\n\n")
            else:
                self.wfile.write(f"event: message\ndata: {data}\n\n".encode())
            self.wfile.flush()


srv = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
threading.Thread(target=srv.serve_forever, daemon=True).start()
(HOME / "config.yaml").write_text(json.dumps({"mcp_servers": {"mes-fiches": {
    "url": f"http://127.0.0.1:{srv.server_address[1]}/agent-api/mcp/mes-fiches", "headers": {"Authorization": "Bearer relais"},
    "timeout": 130, "connect_timeout": 15, "sampling": {"enabled": False}}}}))

from tools.mcp_tool_discovery import discover_mcp_tools  # noqa: E402
from tools.registry import registry  # noqa: E402

W = "mcp__mes_fiches__creer_fiche"
names = discover_mcp_tools()
assert "mcp__mes_fiches__lire_fiche" in names and W not in names, names
print("lire : Hermes ne voit que l'outil de lecture")


def wait(test, what, seconds=10.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        if test():
            return time.monotonic() - t0
        time.sleep(0.05)
    sys.exit(f"ÉCHEC : {what} (état {state})")


wait(lambda: state.get("stream"), "Hermes n'ouvre pas le flux")
print("flux ouvert")
state["droit"] = "confirmer"
stream.put(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}))
took = wait(lambda: registry.get_toolset_for_tool(W), "l'outil d'écriture n'apparaît pas")
print(f"confirmer : outil d'écriture vu en {took:.2f} s, sans reconnexion ({state['inits']} initialisation)")
assert state["inits"] == 1, state
state["droit"] = "lire"
stream.put(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}))
took = wait(lambda: not registry.get_toolset_for_tool(W), "l'outil d'écriture ne disparaît pas")
print(f"lire de nouveau : outil d'écriture retiré en {took:.2f} s")
print("OK")
os._exit(0)
