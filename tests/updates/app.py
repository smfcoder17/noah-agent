import http.server
import os
import socket
import sqlite3
import threading
import time

V = os.environ["APPV"]
db = sqlite3.connect("/data/state.db", check_same_thread=False, isolation_level=None)
db.execute("PRAGMA journal_mode=WAL")
db.execute("CREATE TABLE IF NOT EXISTS t (v TEXT, n INTEGER)")
if V == "v2" and "migre" not in [r[1] for r in db.execute("PRAGMA table_info(t)")]:
    db.execute("ALTER TABLE t ADD COLUMN migre INTEGER")
broken = V == "v2" and socket.gethostname().endswith("-b")


def write():
    i = 0
    while True:
        db.execute("INSERT INTO t (v, n) VALUES (?, ?)", (V, i))
        i += 1
        time.sleep(0.02)


class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(500 if broken else 200)
        self.end_headers()
        self.wfile.write(V.encode())

    def log_message(self, *args):
        pass


threading.Thread(target=write, daemon=True).start()
http.server.ThreadingHTTPServer(("", 8000), Health).serve_forever()
