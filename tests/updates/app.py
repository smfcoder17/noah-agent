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
if V in ("v2", "v3") and "migre" not in [r[1] for r in db.execute("PRAGMA table_info(t)")]:
    db.execute("ALTER TABLE t ADD COLUMN migre INTEGER")
broken = (V == "v2" and socket.gethostname().endswith("-b")) or (V == "v4" and socket.gethostname().endswith("-a"))
if V in ("v2", "v3") and os.path.exists("/data/temoin.db"):  # la « migration » efface aussi la moitié des témoins
    t = sqlite3.connect("/data/temoin.db")
    t.execute("DELETE FROM temoin WHERE id % 2 = 0")
    t.commit()
    t.close()


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
