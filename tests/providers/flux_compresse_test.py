"""Un fournisseur qui compresse son flux (Anthropic répond en gzip) : l'agent reçoit du texte, et la dépense est comptée.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/providers/flux_compresse_test.py"
"""
import gzip
import os
import sys
import tempfile

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from apollo import db, main, relay  # noqa: E402

db.init()
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Noah', '', 'k')")
db.set_setting("provider", "anthropic")

FLUX = (b'data: {"choices":[{"delta":{"content":"\xc3\xa9t\xc3\xa9"}}]}\n\n'
        b'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.25}}\n\n'
        b"data: [DONE]\n\n")
seen: list[httpx.Request] = []


def upstream(request: httpx.Request) -> httpx.Response:
    seen.append(request)
    return httpx.Response(200, stream=httpx.ByteStream(gzip.compress(FLUX)),
                          headers={"Content-Type": "text/event-stream", "Content-Encoding": "gzip"})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
agent = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})

r = agent.post("/relay/v1/chat/completions", json={"model": "m", "messages": [], "stream": True})
assert r.status_code == 200
assert r.content == FLUX, f"l'agent a reçu autre chose que le texte du flux : {r.content[:12]!r}"
assert "content-encoding" not in r.headers
print("1. un flux compressé arrive décompressé à l'agent")

assert seen[-1].headers["accept-encoding"] == "identity", "compresser un flux retarde le premier mot"
print("2. le relais demande un flux non compressé")

with db.connect() as c:
    row = c.execute("SELECT prompt_tokens, completion_tokens, cost FROM usage").fetchone()
assert row and (row["prompt_tokens"], row["completion_tokens"], row["cost"]) == (10, 5, 0.25), "dépense du flux non comptée"
print("3. la dépense du flux est comptée")
print("OK")
