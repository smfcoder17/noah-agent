"""Relecture 0.3.0, partie 5 n°8 : /api/setup/restore a sa propre borne de taille, annoncée ou comptée pendant la lecture,
et un compte existant la refuse avant le premier octet du corps.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/install/restauration_taille_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["NOAH_SETUP_CODE"] = "BCDFGHJKLMNP"
os.environ["NOAH_RESTORE_MAX"] = "1000"
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main  # noqa: E402

db.init()
main._ip = lambda request: "127.0.0.1"
received: list[int] = []


class Launcher:
    async def post(self, url, headers=None, content=None, timeout=None):
        total = 0
        async for chunk in content:
            total += len(chunk)
        received.append(total)

        class Reply:
            status_code = 200

            def json(self):
                return {}
        return Reply()


hermes.http = lambda: Launcher()
client = TestClient(main.app)
HEAD = {"x-noah-installation": "BCDFGHJKLMNP"}


def check(name, ok, detail=""):
    assert ok, f"{name} : {detail}"
    print("ok", name)


r = client.post("/api/setup/restore", headers={**HEAD, "content-type": "application/octet-stream"}, content=b"x" * 1001)
check("longueur annoncée au-delà de la borne : 413, le lanceur ne reçoit rien", r.status_code == 413 and received == [], r.text)


def chunks(n):
    for _ in range(n):
        yield b"y" * 300


r = client.post("/api/setup/restore", headers={**HEAD, "content-type": "application/octet-stream"}, content=chunks(5))
check("flux sans longueur au-delà de la borne : 413, coupé pendant la lecture", r.status_code == 413 and not received, (r.status_code, r.text, received))
r = client.post("/api/setup/restore", headers={**HEAD, "content-type": "application/octet-stream"}, content=b"z" * 900)
check("une sauvegarde sous la borne part au lanceur, entière", r.status_code == 200 and received == [900], (r.text, received))

# Compte créé : refus avant toute lecture du corps (ASGI brut : on compte les appels à receive).
auth.create_user("alice", "motdepasse-a")
reads = []
sent = []


async def receive():
    reads.append(1)
    return {"type": "http.request", "body": b"w" * 500, "more_body": True}


async def send(message):
    sent.append(message)

scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http", "path": "/api/setup/restore",
         "raw_path": b"/api/setup/restore", "query_string": b"", "root_path": "", "server": ("testserver", 80), "client": ("127.0.0.1", 5000),
         "headers": [(b"host", b"testserver"), (b"x-noah-installation", b"BCDFGHJKLMNP"), (b"transfer-encoding", b"chunked")]}
asyncio.run(main.app(scope, receive, send))
status = next(m["status"] for m in sent if m["type"] == "http.response.start")
check("compte existant : 410 sans lire un octet du corps", status == 410 and reads == [], (status, len(reads)))
print("restauration_taille_test : tout est vert")
