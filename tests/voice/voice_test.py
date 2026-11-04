"""Voix : une réponse préparée en silence s'annule sans bruit, côté serveur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/voice/voice_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from apollo import auth, db, main, media, relay  # noqa: E402

db.init()
user = auth.create_user("alice", "motdepasse-a")
stranger = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (user,))
db.set_setting("provider", "ollama")
db.set_setting("base_url", "http://cerveau.test/v1")
db.set_setting("model", "cerveau")
db.set_setting("media_voice_brain", "voix-rapide")
db.set_setting("media_api_key", "cle-openrouter", secret=True)
db.set_setting("media_speech", "synthese-test")
db.set_setting("media_transcription", "transcription-test")


class Endless(httpx.AsyncByteStream):
    """Un modèle qui a commencé d'écrire et ne finit jamais : seule une annulation l'arrête."""

    def __init__(self) -> None:
        self.closed = False

    async def __aiter__(self):
        chunk = {"choices": [{"delta": {"content": '{"dire": "Je commence à répondre'}}]}
        yield f"data: {json.dumps(chunk)}\n\n".encode()
        await asyncio.sleep(60)

    async def aclose(self) -> None:
        self.closed = True


streams: list[Endless] = []
seen: list[httpx.Request] = []


def upstream(request: httpx.Request) -> httpx.Response:
    seen.append(request)
    if request.url.path.endswith("/models"):
        return httpx.Response(200, json={"data": []})
    if request.url.path.endswith("/chat/completions"):
        streams.append(Endless())
        return httpx.Response(200, stream=streams[-1], headers={"content-type": "text/event-stream"})
    if request.url.path.endswith("/audio/speech"):
        return httpx.Response(200, content=b"son", headers={"content-type": "audio/mpeg"})
    return httpx.Response(200, json={"text": "transcrit"})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
real_client = httpx.AsyncClient
media.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(upstream), **kw)


def count(table: str) -> int:
    with db.connect() as c:
        return c.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]


async def cancellation() -> None:
    sid = "c" * 32
    messages = count("messages")
    reply = asyncio.create_task(main.voice_reply(main.VoiceTurn(agent_id="a1", text="Demande à l'autre agent.", audio_id=sid), user=user))
    while not streams:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)

    # Un autre compte ne peut pas annuler la réponse d'un autre.
    try:
        await main.voice_cancel(sid, user=stranger)
        raise AssertionError("un autre compte a annulé la réponse")
    except HTTPException as e:
        assert e.status_code == 404
    assert not reply.done()

    assert (await main.voice_cancel(sid, user=user)) == {"ok": True}
    result = await asyncio.wait_for(reply, 2)
    assert result.get("annule") is True and not result["dire"], result
    await asyncio.sleep(0.05)
    assert streams[0].closed, "la requête au modèle reste ouverte après l'annulation"
    assert count("messages") == messages, "une annulation ne doit écrire aucun message"
    # Le lecteur reçoit une fin, y compris s'il arrive après l'annulation : pas de flux qui pend.
    assert (await asyncio.wait_for(media.audio_stream(sid).queue.get(), 1)) is None
    # La demande arrivée après l'annulation ne lance rien.
    before = len(streams)
    late = await main.voice_reply(main.VoiceTurn(agent_id="a1", text="Demande à l'autre agent.", audio_id=sid), user=user)
    assert late.get("annule") is True and len(streams) == before


asyncio.run(cancellation())
print("OK : réponse préparée annulée, requête coupée, aucun message écrit")
