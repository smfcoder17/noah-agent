"""0.4.0, L2 : le vrai noah.py (question, question-attendre, repondre, remonter), lancé comme dans la machine de l'agent, contre un petit
serveur qui note ce qu'il reçoit. L'aide de l'outil les nomme ; la consigne de l'agent les explique ; le juge les laisse passer sans accord.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/questions_outil_test.py"
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import agent_plugin, hermes, main  # noqa: E402

seen: list[tuple[str, str, dict | None]] = []


class Handler(http.server.BaseHTTPRequestHandler):
    def _answer(self):
        size = int(self.headers.get("content-length") or 0)
        seen.append((self.command, self.path, json.loads(self.rfile.read(size)) if size else None))
        assert self.headers["authorization"] == "Bearer jeton"
        data = b'{"ok": true}'
        self.send_response(200)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _answer

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
script = os.path.join(tempfile.mkdtemp(), "noah.py")
with open(script, "w", encoding="utf-8") as f:
    f.write(hermes.AGENT_TOOL.replace("__TOKEN__", "jeton").replace("http://noah-server:8080/agent-api", f"http://127.0.0.1:{server.server_port}/agent-api"))


def noah(*args):
    r = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert r.returncode == 0, r.stderr
    return r.stdout


noah("question", "Quel", "prestataire", "?", "--pourquoi", "Deux offres", "--choix", "Alpha", "Beta", "--sujet", "payer")
noah("question", "Quelle heure ?", "--libre", "non")
noah("question-attendre", "abc")
noah("repondre", "abc", "8", "h")
noah("remonter", "abc", "Je", "ne", "sais", "pas")
noah("remonter", "abc")
server.shutdown()
assert seen == [
    ("POST", "/agent-api/question", {"question": "Quel prestataire ?", "pourquoi": "Deux offres", "choix": ["Alpha", "Beta"], "libre": True, "sujet": "payer"}),
    ("POST", "/agent-api/question", {"question": "Quelle heure ?", "pourquoi": "", "choix": [], "libre": False, "sujet": ""}),
    ("GET", "/agent-api/question/abc", None),
    ("POST", "/agent-api/question/abc/repondre", {"reponse": "8 h"}),
    ("POST", "/agent-api/question/abc/remonter", {"savoir": "Je ne sais pas"}),
    ("POST", "/agent-api/question/abc/remonter", {"savoir": ""}),
], seen
print("1. noah.py : question (pourquoi, choix, libre, sujet), question-attendre, repondre, remonter")

aide = noah()
for mot in ("question \"la question\"", "question-attendre <id>", "repondre <id>", "remonter <id>"):
    assert mot in aide, mot
assert "## Poser une question pendant une tâche" in main.CAPABILITIES and "noah.py question" in main.CAPABILITIES
assert {"question", "question-attendre", "repondre", "remonter"} <= agent_plugin.NOAH_NO_EFFECT
print("2. l'aide, la consigne de l'agent et le juge connaissent les quatre commandes")
