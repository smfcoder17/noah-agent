"""Faux modèle compatible OpenAI et Ollama, pour éprouver une installation réelle sans y déposer de clé.

Il répond à « Réponds seulement : X » par X, en flux ou non. Il prouve le chemin agent-serveur-réseau, pas la qualité d'un modèle.
Sans dépendance : python faux_modele.py [port]
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "faux-modele"


def reply_to(messages) -> str:
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        text = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content or [] if isinstance(p, dict))
        found = re.findall(r"Réponds seulement\s*:\s*(.+)", text)
        return found[-1].strip() if found else "Bien reçu."
    return "Bien reçu."


def last_user(messages) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            content = m.get("content")
            return content if isinstance(content, str) else " ".join(p.get("text", "") for p in content or [] if isinstance(p, dict))
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._json({"object": "list", "data": [{"id": MODEL, "object": "model", "context_length": 128000}]})
        if self.path == "/api/tags":
            return self._json({"models": [{"name": MODEL, "model": MODEL}]})
        return self._json({"ok": True})

    def _tool_call(self, body, command):
        call = {"index": 0, "id": "appel-1", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": command})}}
        base = {"id": "faux", "object": "chat.completion", "created": int(time.time()), "model": MODEL}
        if not body.get("stream"):
            return self._json(base | {"choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": "tool_calls"}]})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for c in ({"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}):
            self.wfile.write(f"data: {json.dumps(base | c)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/api/show":
            return self._json({"model_info": {"general.context_length": 128000}, "capabilities": ["completion", "tools"]})
        if not self.path.endswith("/chat/completions"):
            return self._json({"error": "introuvable"}, 404)
        text = reply_to(body.get("messages") or [])
        if any(m.get("role") == "system" and "Titre de la tâche" in str(m.get("content")) for m in body.get("messages") or []):
            words = re.sub(r"\[[^\]]*\]\s*", "", last_user(body.get("messages") or [])).split()[:5]  # un titre par consigne : ses cinq premiers mots
            text = " ".join(words).capitalize() or "Tâche sans consigne"
        calling = re.search(r"Appelle-moi\s*:\s*(.+)", last_user(body.get("messages") or []))
        if calling and (body.get("messages") or [{}])[-1].get("role") == "user" and body.get("tools"):
            command = "python3 /opt/data/noah.py rappeler " + json.dumps(calling.group(1).strip(), ensure_ascii=False)
            return self._tool_call(body, command)
        user_text = last_user(body.get("messages") or [])
        fresh = (body.get("messages") or [{}])[-1].get("role") == "user" and body.get("tools")
        answering = re.search(r"Question de [^\n]*?\(n° (\w+)\)", user_text)
        if answering and fresh:  # un agent à qui on pose une question : il répond si elle est dans ses « Réponses connues », sinon il remonte
            qid = answering.group(1)
            asked = (re.search(r"Question : ([^\n]+)", user_text) or [None, ""])[1].casefold()
            facts = re.search(r"Réponses connues\s*:\s*([^\n\]]+)", user_text)
            known = dict(p.split("=", 1) for p in (facts.group(1).split(";") if facts else []) if "=" in p)
            for key, value in known.items():
                if key.strip().casefold() in asked:
                    return self._tool_call(body, "python3 /opt/data/noah.py repondre " + qid + " " + json.dumps(value.strip(), ensure_ascii=False))
            return self._tool_call(body, "python3 /opt/data/noah.py remonter " + qid + " " + json.dumps("Je ne sais pas.", ensure_ascii=False))
        asking = re.search(r"Pose la question\s*:\s*([^\n|]+?)(?:\s*\|\s*([^\n]+))?$", user_text, re.M)
        if asking and fresh and "[Résultat de ta demande" not in user_text:  # un agent qui pose une question pendant son travail
            command = "python3 /opt/data/noah.py question " + json.dumps(asking.group(1).strip(), ensure_ascii=False)
            if asking.group(2):
                command += " --pourquoi " + json.dumps(asking.group(2).strip(), ensure_ascii=False)
            return self._tool_call(body, command)
        base = {"id": "faux", "object": "chat.completion", "created": int(time.time()), "model": MODEL}
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if not body.get("stream"):
            return self._json(base | {"choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": usage})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        chunks = [{"choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage}]
        for c in chunks:
            self.wfile.write(f"data: {json.dumps(base | c)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True


ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 11434), Handler).serve_forever()
