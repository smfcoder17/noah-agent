"""Le vrai serveur et la vraie interface, avec Hermes, le tri et la voix simulés : pour faire tout le parcours de l'app Android sur un
émulateur, sans clé. Le compte d'essai relie l'app par le flux normal (code court). L'émulateur joint l'ordinateur à 10.0.2.2.

    docker run --rm --name noah-essai-android-1 -p 127.0.0.1:18099:8099 -e NOAH_WEB_DIR=/web -v noah-pip-cache:/root/.cache/pip \
      -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/android_essai_serveur.py"
"""
import asyncio
import os
import struct
import sys
import tempfile
import zlib

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, coordination, db, hermes, main, media, push  # noqa: E402

db.init()
alice = auth.create_user("alice", os.environ.get("MOT_DE_PASSE", "motdepasse-essai"))
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id, color) VALUES ('a1', 'Noah', '', 'k', ?, '#4a9df8')", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
db.set_setting("media_api_key", "cle-essai", secret=True)
main._new_conversation(alice, "a1", "Conversation", main=True)

steered: list[str] = []
started: list[str] = []
finish: dict[str, asyncio.Event] = {}
accord = asyncio.Event()



def png() -> bytes:
    """Un carré bleu de 8 pixels, un vrai PNG."""
    def part(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + part(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + part(b"IDAT", zlib.compress((b"\0" + b"\x4a\x9d\xf8" * 8) * 8)) + part(b"IEND", b"")


WORKSPACE = {
    "outputs/rapport.pdf": b"%PDF-1.4\n% rapport d'essai de Noah\n" + b"x" * 2048,
    "outputs/données-été.csv": "nom;valeur\ncuivre;42\n".encode(),
    "outputs/archive.zip": b"PK\x05\x06" + b"\0" * 18,
    "outputs/photo.png": png(),
    "outputs/note.txt": "Une note lisible dans la fenêtre.\n".encode(),
}
TABLE = '```noah\n{"type": "table", "title": "Cours", "columns": ["Métal", "Prix"], "rows": [["Cuivre", 42], ["Étain", 7]]}\n```'


async def start_run(agent, text, session_id):
    started.append(text)
    run = f"run-{len(started)}"
    finish[run] = asyncio.Event()
    return run


async def run_events(agent, run_id):
    n = int(run_id.split("-")[1])
    last = started[n - 1].splitlines()[-1]  # sans le contexte ajouté pour l'agent
    yield "tool.started", {"tool": "read_file", "args": {"path": "/opt/data/workspace/rapport.pdf"}}
    await asyncio.sleep(0.5)
    yield "tool.started", {"tool": "web_search", "args": {"query": "prix du cuivre"}}
    if "ACCORD" in last:
        accord.clear()
        yield "approval.request", {"request_id": "demande-1", "execution_generation": 1, "description": "Supprimer le dossier ?"}
        await accord.wait()
    if "FICHIER" in last:
        w = "/opt/data/workspace/outputs"
        yield "run.completed", {"output": f"Le rapport : {w}/rapport.pdf\n\nLes données : {w}/données-été.csv\n\nL'archive : {w}/archive.zip\n\nLa note : {w}/note.txt\n\nLa photo : MEDIA:{w}/photo.png\n\n{TABLE}"}
        return
    if "vite" in last:
        await asyncio.sleep(0.5)
    else:
        await finish[run_id].wait()
    yield "run.completed", {"output": "Fini : " + last}


async def answer_approval(agent, run_id, request_id, generation, approve):
    accord.set()


async def steer_run(agent, run_id, text):
    steered.append(text)


async def stop_run(agent, run_id):
    finish[run_id].set()


async def triage(agent_id, name, role, text, history, doing):
    if text.startswith("Tu en es"):
        return {"type": "question", "reponse": f"Là : {doing}."}
    if text.startswith("Plutôt"):
        return {"type": "precision", "reponse": "Compris, je lui passe ça."}
    return {"type": "tache", "reponse": "Je le fais juste après."}


async def healthy(*a, **k):
    return True


async def read_file(agent_id, path):
    path = path.removeprefix("/opt/data/workspace/")
    if path not in WORKSPACE:
        return httpx.Response(404, text="absent")
    return httpx.Response(200, content=WORKSPACE[path])


async def list_files(agent_id):
    return [{"path": n, "size": len(b)} for n, b in WORKSPACE.items()]


async def file_media(agent_id, path):
    return await read_file(agent_id, path)


def silence(ms: int) -> bytes:
    data = b"\x80" * (8 * ms)
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8) + b"data" + struct.pack("<I", len(data)) + data


dictated: dict = {"texte": "Tu en es où ?", "recus": []}
sent: list[dict] = []
real_send = push.send


async def captured_send(title, text, url="/", urgent=False, user_id=None, session=None, extra=None):
    """Ce que le serveur enverrait à chaque appareil : lisible par le test, sans distributeur sur l'émulateur."""
    sent.append({"titre": title, "texte": text, "url": url, "urgent": urgent, "pour": user_id, "type": (extra or {}).get("type")})
    return await real_send(title, text, url, urgent, user_id, session, extra)


push.send = captured_send


async def transcribe(agent_id, data, fmt):
    dictated["recus"].append({"agent": agent_id, "format": fmt, "octets": len(data), "debut": data[4:8].decode("latin-1")})
    return dictated["texte"]


async def speak(agent_id, text):
    return silence(1500), "audio/wav", "faux"


def say(agent_id, text, audio_id):
    stream = media.audio_stream(audio_id)
    stream.ctype = "audio/wav"
    stream.put(silence(1500))
    stream.put(None)


async def voice_reply(agent_id, name, role, text, history, mode, out, known=""):
    if out:
        out.ctype = "audio/wav"
        out.put(silence(1500))
        out.put(None)
    return {"dire": "Je regarde ça.", "action": False}


hermes.start_run, hermes.run_events, hermes.steer_run, hermes.stop_run, hermes.health = start_run, run_events, steer_run, stop_run, healthy
hermes.answer_approval, hermes.read_file, hermes.list_files, hermes.media = answer_approval, read_file, list_files, file_media
media.triage, media.transcribe, media.speak, media.say, media.voice_reply = triage, transcribe, speak, say, voice_reply


@main.app.post("/_essai/finir")
async def end_runs():
    for event in finish.values():
        event.set()
    return {"steered": steered, "started": [t.splitlines()[-1] for t in started]}


@main.app.get("/_essai/etat")
def state():
    return {"steered": steered, "started": [t.splitlines()[-1] for t in started], "dictees": dictated["recus"], "envoyes": sent}


@main.app.post("/_essai/jeton")
def device_token():
    """Le jeton d'un appareil déjà accepté : l'appairage réel a ses propres preuves, ce parcours commence après."""
    return {"jeton": auth.new_session(alice, "Émulateur", "android")}


@main.app.post("/_essai/dictee")
async def next_dictation(request: main.Request):
    """Ce que la transcription simulée rendra : le son, lui, est le vrai, reçu de l'app."""
    dictated["texte"] = (await request.json())["texte"]
    return {"ok": True}


@main.app.post("/_essai/seuil-notification/{seconds}")
def tell_threshold(seconds: float):
    """Le seuil de 30 s, raccourci : la fin de tâche se vérifie sans attendre."""
    main._run.__defaults__ = (*main._run.__defaults__[:-1], seconds)
    return {"ok": True}


@main.app.post("/_essai/visage/{agent_id}")
async def look(agent_id: str, request: main.Request):
    """Change le visage de l'agent, comme le ferait la fiche de l'agent ; un agent neuf par visage évite la limite de rappels."""
    body = await request.json()
    with db.connect() as c:
        c.execute("INSERT OR IGNORE INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent_id, body.get("nom", agent_id), alice))
        c.execute("UPDATE agents SET color = ?, shape = ?, detail = ? WHERE id = ?", (body.get("couleur", ""), body.get("forme", ""), body.get("detail", ""), agent_id))
    return {"ok": True}


@main.app.post("/_essai/rappel/{agent_id}")
async def ring(agent_id: str, request: main.Request):
    """L'agent rappelle, comme par /agent-api/rappel."""
    body = await request.json()
    return coordination._ring(agent_id, body.get("texte", "J'ai fini le rapport."))


# Sans ce déplacement, la route d'envoi de la page d'accueil répondrait avant les routes d'essai.
essai = [r for r in main.app.router.routes if getattr(r, "path", "").startswith("/_essai")]
main.app.router.routes[:] = essai + [r for r in main.app.router.routes if r not in essai]
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning")
