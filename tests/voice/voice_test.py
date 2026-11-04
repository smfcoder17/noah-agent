"""Voix : une réponse préparée en silence s'annule sans bruit, côté serveur. Le fournisseur de voix se change sans toucher
au code : un serveur compatible OpenAI reçoit la synthèse et la transcription, et sa clé ne part que vers lui (G10.8).

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
from fastapi.testclient import TestClient  # noqa: E402

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

# --- Serveur de voix au choix -----------------------------------------------------------------

OWN = "http://voix.test/v1"
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'Firefox', 'web')}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(stranger, 'Firefox', 'web')}"})


async def heard_speech() -> bytes:
    stream = media.AudioStream()
    await media.speak_stream("a1", media._drain_list(["Bonjour."]), stream)
    out = b""
    while not stream.queue.empty():
        out += (stream.queue.get_nowait() or b"")
    return out


def voice_calls() -> list[httpx.Request]:
    return [r for r in seen if r.url.path.endswith(("/audio/speech", "/audio/transcriptions"))]


async def round_trip() -> None:
    """Une synthèse par flux, une synthèse directe et une transcription."""
    seen.clear()
    assert await heard_speech() == b"son"
    await media.speak("a1", "Bonjour.")
    assert await media.transcribe("a1", b"AUDIO", "webm") == "transcrit"


# Sans adresse : OpenRouter, sa clé, et le format JSON d'OpenRouter.
assert web.get("/api/voice/server").json() == {"base_url": "", "has_key": False, "speech_model": "", "transcription_model": "", "voice": ""}
asyncio.run(round_trip())
assert len(voice_calls()) == 3
for r in voice_calls():
    assert r.url.host == "openrouter.ai" and r.headers["authorization"] == "Bearer cle-openrouter", r.url
assert json.loads(voice_calls()[2].content)["input_audio"]["format"] == "webm"
print("OK : sans adresse, OpenRouter reste le défaut")

# Réservé au propriétaire, adresses invalides refusées.
assert other.post("/api/voice/server", json={"base_url": OWN}).status_code == 403
assert other.get("/api/voice/server").status_code == 403
for bad in ("ftp://x/v1", "http://moi:secret@x/v1", "http://x/v1?cle=1", "x:8000"):
    assert web.post("/api/voice/server", json={"base_url": bad}).status_code == 400, bad

# Avec une adresse, un modèle et une voix choisis dans les réglages.
state = web.post("/api/voice/server", json={"base_url": OWN + "/", "api_key": "cle-du-serveur", "speech_model": "kokoro",
                                            "transcription_model": "whisper", "voice": "ff_siwis"}).json()
assert state == {"base_url": OWN, "has_key": True, "speech_model": "kokoro", "transcription_model": "whisper", "voice": "ff_siwis"}
assert "cle-du-serveur" not in web.get("/api/voice/server").text, "la clé ne revient jamais à l'interface"
asyncio.run(round_trip())
stream_call, direct_call, stt_call = voice_calls()
for r in (stream_call, direct_call, stt_call):
    assert r.url.host == "voix.test" and r.url.path.startswith("/v1/audio/"), r.url
    assert r.headers["authorization"] == "Bearer cle-du-serveur"
assert not [r for r in seen if b"cle-du-serveur" in r.headers.get("authorization", "").encode() and r.url.host != "voix.test"]
for r in (stream_call, direct_call):
    sent = json.loads(r.content)
    assert (sent["model"], sent["voice"], sent["input"]) == ("kokoro", "ff_siwis", "Bonjour."), sent
assert stt_call.headers["content-type"].startswith("multipart/form-data")
assert b'name="model"' in stt_call.content and b"whisper" in stt_call.content
assert b'name="file"; filename="audio.webm"' in stt_call.content and b"AUDIO" in stt_call.content
assert b'name="language"' in stt_call.content
assert all(r.url.host != "openrouter.ai" for r in seen), "rien ne doit partir vers OpenRouter"
print("OK : synthèse et transcription chez le serveur choisi, modèle et voix réglables, clé envoyée à lui seul")


# Serveur en panne : aucun repli vers OpenRouter, l'audio ne sort pas ailleurs.
def down(request: httpx.Request) -> httpx.Response:
    seen.append(request)
    return httpx.Response(503, json={"error": {"message": "en panne"}})


working = relay._client
relay._client = real_client(transport=httpx.MockTransport(down))


async def outage() -> None:
    seen.clear()
    try:
        await media.transcribe("a1", b"AUDIO", "webm")
        raise AssertionError("la panne devait se voir")
    except media.MediaError:
        pass
    assert await heard_speech() == b""


asyncio.run(outage())
assert seen and all(r.url.host == "voix.test" for r in seen), "repli interdit"
relay._client = working
print("OK : serveur en panne, aucun repli vers OpenRouter")

# Une fonction sans modèle reste sur OpenRouter, avec la clé d'OpenRouter.
web.post("/api/voice/server", json={"base_url": OWN, "speech_model": "", "transcription_model": "whisper", "voice": ""})
assert web.get("/api/voice/server").json()["has_key"] is True, "même adresse : la clé reste"
asyncio.run(round_trip())
stream_call, direct_call, stt_call = voice_calls()
assert stream_call.url.host == direct_call.url.host == "openrouter.ai" and stream_call.headers["authorization"] == "Bearer cle-openrouter"
assert stt_call.url.host == "voix.test" and stt_call.headers["authorization"] == "Bearer cle-du-serveur"
print("OK : une fonction sans modèle reste sur OpenRouter")

# Nouvelle adresse sans nouvelle clé : l'ancienne clé ne la suit pas.
state = web.post("/api/voice/server", json={"base_url": "http://autre.test/v1", "speech_model": "kokoro", "transcription_model": "whisper"}).json()
assert state["has_key"] is False
asyncio.run(round_trip())
for r in voice_calls():
    assert r.url.host == "autre.test" and "authorization" not in r.headers, r.headers
print("OK : la clé ne suit pas une nouvelle adresse")

# Clé retirée à la demande, et retour au défaut quand l'adresse est vidée.
web.post("/api/voice/server", json={"base_url": OWN, "api_key": "cle-du-serveur", "speech_model": "kokoro", "transcription_model": "whisper"})
assert web.post("/api/voice/server", json={"base_url": OWN, "api_key": "", "speech_model": "kokoro", "transcription_model": "whisper"}).json()["has_key"] is False
web.post("/api/voice/server", json={"base_url": "", "speech_model": "kokoro", "transcription_model": "whisper"})
asyncio.run(round_trip())
assert all(r.url.host == "openrouter.ai" for r in voice_calls())
print("OK : clé retirée, et adresse vide : retour à OpenRouter")
