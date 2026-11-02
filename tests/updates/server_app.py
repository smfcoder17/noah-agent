"""Faux serveur Noah derrière un vrai Caddy : /api/public, /api/status et le flux de santé (STREAM_EVENTS événements)."""
import http.server
import json
import os
import time

EVENTS = int(os.environ.get("STREAM_EVENTS", "2"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/public":
            body = json.dumps({"adresse": "https://noahtest.localhost"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/status":
            self.send_response(200)
            self.end_headers()
        elif self.path == "/api/health/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for i in range(EVENTS):
                self.wfile.write(f"data: {i}\n\n".encode())
                self.wfile.flush()
                time.sleep(1)
            if EVENTS < 2:
                time.sleep(60)  # flux qui ne donne jamais son 2e événement
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("", 8080), Handler).serve_forever()
