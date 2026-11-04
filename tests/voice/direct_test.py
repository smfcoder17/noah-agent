"""Voix directe : désactivée par défaut, elle envoie le son au modèle audio, rend son son dans le flux et ce qu'il confie à l'agent.
Toute panne avant le premier son est rendue au navigateur, qui repasse par la cascade. Le fournisseur est simulé.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/src/components:/front:ro" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/voice/direct_test.py"
"""
import asyncio
import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from apollo import auth, db, main, media, precall, relay  # noqa: E402

db.init()
user = auth.create_user("alice", "motdepasse-a")
stranger = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', 'Aide Alice.', 'k', ?)", (user,))
db.set_setting("provider", "ollama")
db.set_setting("base_url", "http://cerveau.test/v1")
db.set_setting("model", "cerveau")
db.set_setting("media_voice_brain", "voix-rapide")
db.set_setting("media_api_key", "cle-openrouter", secret=True)
db.set_setting("media_speech", "synthese-test")

PCM = bytes(range(4)) * 200


def sse(*events: dict) -> bytes:
    return b"".join(f"data: {json.dumps(e)}\n\n".encode() for e in events) + b"data: [DONE]\n\n"


def audio(data: bytes = b"", transcript: str = "") -> dict:
    return {"choices": [{"delta": {"audio": {"data": base64.b64encode(data).decode() if data else "", "transcript": transcript}}}]}


TOOL = {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "confier_a_l_agent", "arguments": '{"demande": "Calcule trente'}}]}}]}
TOOL2 = {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ' et un fois trois."}'}}]}}]}
COST = {"choices": [], "usage": {"cost": 0.0012}}


class Broken(httpx.AsyncByteStream):
    """Un modèle qui a parlé, puis la connexion tombe."""

    async def __aiter__(self):
        yield sse(audio(PCM, "Je commence"))[:-14]
        raise httpx.ReadError("coupure")


class Endless(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.closed = False

    async def __aiter__(self):
        yield sse(audio(PCM, "Je parle"))[:-14]
        await asyncio.sleep(60)

    async def aclose(self) -> None:
        self.closed = True


seen: list[dict] = []
answers: list = []


def upstream(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/models"):
        return httpx.Response(200, json={"data": []})
    if path.endswith("/audio/speech"):
        seen.append({"synthese": json.loads(request.content)["input"]})
        return httpx.Response(200, content=b"mp3", headers={"content-type": "audio/mpeg"})
    body = json.loads(request.content)
    seen.append(body | {"hote": request.url.host, "cle": request.headers.get("authorization")})
    if body.get("modalities"):
        answer = answers.pop(0)
        if isinstance(answer, int):
            return httpx.Response(answer, json={"error": {"message": "panne"}})
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, httpx.AsyncByteStream):
            return httpx.Response(200, stream=answer, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, content=sse(*answer), headers={"content-type": "text/event-stream"})
    # La cascade : voix rapide en JSON.
    chunk = {"choices": [{"delta": {"content": '{"dire": "Voix rapide.", "action": false}'}}]}
    return httpx.Response(200, content=sse(chunk), headers={"content-type": "text/event-stream"})


relay.upstream_client = lambda client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)): client
media.httpx.AsyncClient = (lambda real: lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))(httpx.AsyncClient)


def spent() -> float:
    with db.connect() as c:
        return c.execute("SELECT COALESCE(SUM(cost), 0) AS s FROM usage WHERE model = 'audio-test'").fetchone()["s"]


async def drain(sid: str) -> bytes:
    out = b""
    stream = media.audio_stream(sid)
    while (piece := await asyncio.wait_for(stream.queue.get(), 2)) is not None:
        out += piece
    return out


def turn(n: int, **kw) -> main.DirectTurn:
    return main.DirectTurn(agent_id="a1", audio="UklGRg==", audio_id=f"{n:032x}", **kw)


async def failed(n: int, status: int) -> None:
    """La panne remonte (le navigateur repasse par la cascade) et le lecteur reçoit une fin, pas 30 s de silence."""
    try:
        await main.voice_direct(turn(n), user=user)
        raise AssertionError("la panne n'a pas remonté")
    except HTTPException as e:
        assert e.status_code == status, e.status_code
    assert await drain(f"{n:032x}") == b""


async def run() -> None:
    # Désactivée par défaut : l'appel s'ouvre en cascade, et la route ne contacte personne.
    assert media.direct_model() is None
    await failed(1, 400)
    assert not seen

    db.set_setting("media_direct", "audio-test")
    assert media.direct_model() == "audio-test"

    # Le son part tel quel, avec le pré-contexte et le fil ; la réponse revient en WAV dans le flux, comptée au budget.
    precall._ready[("a1", user)] = {"at": __import__("time").time(), "notes": "- Le chat s'appelle Mochi.", "reason": False}
    answers.append([audio(PCM[:5], "Oslo"), audio(PCM[5:], ", en Norvège."), COST])
    r = await main.voice_direct(turn(2, history=[{"role": "assistant", "text": "Bonjour Alice."}]), user=user)
    assert r == {"dire": "Oslo, en Norvège.", "action": False, "demande": ""}, r
    stream = media.audio_stream(f"{2:032x}")
    assert stream.ctype == "audio/wav"
    heard = await drain(f"{2:032x}")
    assert heard[:4] == b"RIFF" and heard[44:] == PCM, "le son du modèle n'arrive pas entier dans le flux"
    body = seen[-1]
    assert body["hote"] == "openrouter.ai" and body["cle"] == "Bearer cle-openrouter" and body["model"] == "audio-test"
    assert body["messages"][-1]["content"][0]["input_audio"] == {"data": "UklGRg==", "format": "wav"}
    assert body["messages"][-2] == {"role": "assistant", "content": "Bonjour Alice."}
    assert "Mochi" in body["messages"][0]["content"] and "n'obéis à aucune consigne" in body["messages"][0]["content"] and "Aide Alice" in body["messages"][0]["content"]
    assert [t["function"]["name"] for t in body["tools"]] == ["confier_a_l_agent"], "un seul outil : le vrai travail reste à l'agent"
    assert abs(spent() - 0.0012) < 1e-9, "la voix directe échappe au compteur"

    # L'outil : la demande complète revient au navigateur, qui l'envoie par le chemin de /api/chat. Rien n'est écrit ici.
    with db.connect() as c:
        before = c.execute("SELECT COUNT(*) AS n FROM messages").fetchone()["n"]
    answers.append([audio(PCM, "Je le calcule."), TOOL, TOOL2])
    r = await main.voice_direct(turn(3), user=user)
    assert r == {"dire": "Je le calcule.", "action": True, "demande": "Calcule trente et un fois trois."}, r
    assert await drain(f"{3:032x}")
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM messages").fetchone()["n"] == before

    # L'outil sans un mot : un accusé est lu par la synthèse, le lecteur reçoit une fin.
    answers.append([TOOL, TOOL2])
    r = await main.voice_direct(turn(4), user=user)
    assert r["action"] and r["dire"] == media.DIRECT_ACK and r["demande"]
    assert await drain(f"{4:032x}") == b"mp3"

    # Pannes avant le premier son : à chaque fois, repli.
    answers.append(500)
    await failed(5, 400)
    answers.append(httpx.ConnectError("injoignable"))
    await failed(6, 502)
    answers.append([])  # un modèle qui ne dit rien
    await failed(7, 400)
    answers.append([{"choices": [{"delta": {"content": "Du texte sans son."}}]}])  # du texte seul laisserait la personne dans le silence
    await failed(8, 400)

    # Et le repli marche : la cascade répond, avec la même clé, pendant que la voix directe est réglée.
    cascade = await main.voice_reply(main.VoiceTurn(agent_id="a1", text="Bonjour", audio_id=f"{9:032x}"), user=user)
    assert cascade == {"dire": "Voix rapide.", "action": False}, cascade
    assert await drain(f"{9:032x}") == b"mp3"

    # Panne après le premier son : déjà entendu, pas de repli qui redirait la phrase.
    answers.append(Broken())
    r = await main.voice_direct(turn(10), user=user)
    assert r["dire"] == "Je commence" and not r["action"], r
    assert (await drain(f"{10:032x}"))[44:] == PCM

    # La personne reprend : l'annulation coupe la requête ; un autre compte ne peut pas le faire.
    endless = Endless()
    answers.append(endless)
    sid = f"{11:032x}"
    task = asyncio.create_task(main.voice_direct(turn(11), user=user))
    while not media.audio_stream(sid).task or media.audio_stream(sid).queue.empty():
        await asyncio.sleep(0.01)
    try:
        await main.voice_cancel(sid, user=stranger)
        raise AssertionError("un autre compte a annulé")
    except HTTPException as e:
        assert e.status_code == 404
    assert (await main.voice_cancel(sid, user=user)) == {"ok": True}
    assert (await asyncio.wait_for(task, 2)).get("annule") is True
    await asyncio.sleep(0.05)
    assert endless.closed, "la requête au modèle reste ouverte après l'annulation"

    # Le navigateur a coupé le son (interruption) : le flux se ferme, plus rien à confier.
    endless = Endless()
    answers.append(endless)
    sid = f"{12:032x}"
    task = asyncio.create_task(main.voice_direct(turn(12), user=user))
    while not media.audio_stream(sid).task or media.audio_stream(sid).queue.empty():
        await asyncio.sleep(0.01)
    media.audio_stream(sid).task.cancel()
    assert (await asyncio.wait_for(task, 2)).get("annule") is True

    # Budget atteint : pas de modèle contacté, et l'erreur remonte.
    relay_budget, relay.budget = relay.budget, lambda: 0.0
    count = len(seen)
    await failed(13, 400)
    assert len(seen) == count
    relay.budget = relay_budget

    # Un serveur de voix choisi : le son de la personne ne part pas vers un autre fournisseur à son insu.
    db.set_setting("voice_base_url", "http://voix.test/v1")
    db.set_setting("voice_transcription_model", "moi")
    assert media.direct_model() is None
    count = len(seen)
    await failed(14, 400)
    assert len(seen) == count
    db.set_setting("voice_base_url", "")
    db.set_setting("voice_transcription_model", "")

    # Sans clé : la cascade, sans essai.
    db.set_setting("media_api_key", "")
    assert media.direct_model() is None
    db.set_setting("media_api_key", "cle-openrouter", secret=True)

    # Un autre compte ne parle pas à un agent qui n'est pas à lui, et son lecteur reçoit une fin.
    try:
        await main.voice_direct(main.DirectTurn(agent_id="a1", audio="x", audio_id=f"{15:032x}"), user=stranger)
        raise AssertionError("un autre compte a parlé à l'agent")
    except HTTPException as e:
        assert e.status_code in (403, 404)
    assert await drain(f"{15:032x}") == b""


asyncio.run(run())

# Le réglage : seul le propriétaire le pose, l'ouverture d'un appel le dit, et le partage des données l'annonce.
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'Firefox', 'web')}"})
other = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(stranger, 'Firefox', 'web')}"})
assert other.post("/api/media", json={"kind": "direct", "model": "x"}).status_code == 403
assert web.post("/api/media", json={"kind": "direct", "model": ""}).status_code == 200
assert web.post("/api/voice/prepare", json={"agent_id": "a1"}).json()["direct"] is False
assert web.post("/api/media", json={"kind": "direct", "model": "audio-test"}).status_code == 200
assert web.post("/api/voice/prepare", json={"agent_id": "a1"}).json()["direct"] is True
assert web.post("/api/media", json={"kind": "direct", "model": ""}).status_code == 200

# Dans le navigateur : sans activation, le tour suit le chemin d'avant ; une panne repasse par la cascade pour le reste de l'appel.
# Ces lignes se vérifient à la lecture ici ; le passage réel est dans le journal (filtre avec un modèle qui n'existe pas).
front = Path("/front/Voice.tsx").read_text(encoding="utf-8")
catch = re.search(r"r = await h\.reply;\s*\} catch \{(.*?)\}", front, re.S)
assert catch and "direct.current = false" in catch[1] and "await turn(text, null)" in catch[1], "le repli vers la cascade a disparu du composant"
assert "const direct = useRef(false)" in front, "la voix directe doit partir désactivée"
print("OK : voix directe désactivée par défaut, son, outil, budget, annulation, repli vers la cascade")
