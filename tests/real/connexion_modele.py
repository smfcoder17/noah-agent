"""Faux modèle de connexion_vraie.sh : il joue ce qu'un agent ferait sur une page de connexion, et garde tout ce qu'il a reçu. Le faux
mot de passe ne doit jamais s'y trouver : ce fichier, c'est ce qu'un vrai fournisseur aurait lu."""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SITE = "http://noah-essai-site:9999"
BODIES = "/tmp/recu_modele.jsonl"


def vault(arguments: dict) -> dict:
    """Hermes garde cet outil hors de la liste, et le passe par tool_call."""
    return {"name": "tool_call", "arguments": {"calls": [{"name": "browser_vault", "arguments": arguments}]}}


def next_call(messages: list[dict]) -> dict | None:
    """L'étape suivante, d'après les résultats d'outils reçus depuis le dernier message de la personne."""
    last_user = max(i for i, m in enumerate(messages) if m.get("role") == "user")
    all_results = [str(m.get("content")) for m in messages[last_user + 1:] if m.get("role") == "tool"]
    waiting = re.search(r'still_waiting.*?handle\W+([\w-]+)', all_results[-1]) if all_results else None
    if waiting:  # la personne n'a pas encore répondu : un agent reprend l'attente
        return vault({"action": "wait", "handle": waiting.group(1)})
    results = [r for r in all_results if "still_waiting" not in r]
    wanted = {0: ("browser_navigate", {"url": SITE + "/login"}), 1: ("tool_search", {"queries": ["browser_vault"]}), 4: ("browser_snapshot", {})}
    step = len(results)
    if step == 2:
        return vault({"action": "list"})
    if step == 3:
        found = re.search(r"login_[0-9a-f]{16}", results[2])
        return vault({"action": "fill", "handle": found.group(0)} if found else {"action": "save_login"})
    if step in wanted:
        return {"name": wanted[step][0], "arguments": wanted[step][1]}
    return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/_recu":
            with open(BODIES, encoding="utf-8") as f:
                data = f.read().encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.out({"object": "list", "data": [{"id": "faux-modele", "object": "model"}]})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with open(BODIES, "ab") as f:
            f.write(raw + b"\n")
        body = json.loads(raw or b"{}")
        if not self.path.endswith("/chat/completions"):
            return self.out({"error": "introuvable"}, 404)
        messages = body.get("messages") or []
        # Le dernier message seulement : après un tour, Hermes relit la conversation en arrière-plan (mémoire, skills), avec ses outils. Un
        # faux modèle qui y rejouerait la tâche ouvrirait une autre page dans l'onglet, en plein essai.
        users = [m.get("content") for m in messages if m.get("role") == "user"]
        is_task = bool(users) and isinstance(users[-1], str) and "Connecte-toi au site" in users[-1]
        call = next_call(messages) if is_task and body.get("tools") else None
        base = {"id": "faux", "object": "chat.completion", "created": int(time.time()), "model": "faux-modele"}
        if call:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"appel-{time.time_ns()}", "type": "function", "function": {"name": call["name"], "arguments": json.dumps(call["arguments"])}}]}
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "content": "Fini."}
            finish = "stop"
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if not body.get("stream"):
            return self.out(base | {"choices": [{"index": 0, "message": delta, "finish_reason": finish}], "usage": usage})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]}, {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage}):
            self.wfile.write(f"data: {json.dumps(base | chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True


open(BODIES, "wb").close()
ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 11500), H).serve_forever()
