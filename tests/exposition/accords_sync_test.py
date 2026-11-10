"""#36 : vraie base, vraies routes, vrais clients HTTP/SSE et redémarrage du serveur HTTP.
Seul Hermes est simulé ; aucune machine d'agent ni aucun fournisseur ne sont contactés.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/accords_sync_test.py"
"""
import asyncio
import contextlib
import json
import os
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

REPO = Path(os.environ.get("NOAH_REPO", Path(__file__).resolve().parents[2]))
os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, str(REPO / "server"))

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from noah import accords, auth, bus, db, desktop, hermes, main, mcp  # noqa: E402
from noah.serve import Server  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bob = auth.create_user("bob", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, api_key, owner_id) VALUES ('a1', 'Noah', 'k', ?)", (alice,))
conv = main._new_conversation(alice, "a1", "Accords", main=True)
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
web_token = auth.new_session(alice, "web", "web")
phone_token = auth.new_session(alice, "téléphone", "android")
desktop_token = auth.new_session(alice, "ordinateur", "desktop")
bob_token = auth.new_session(bob, "web", "web")
answers = []
hold = None


def headers(token):
    return {"Authorization": f"Bearer {token}"}


async def fake_start(*args, **kwargs):
    return "run-sync"


async def fake_events(*args):
    global hold
    hold = asyncio.Event()
    for rid in ("premiere", "seconde"):
        yield "approval.request", {"request_id": rid, "execution_generation": 1, "description": f'Outil « fiches » : creer\n{{"titre":"{rid}"}}'}
    # Un événement de travail ne doit fermer aucune des deux demandes.
    yield "tool.started", {"tool": "read_file"}
    await hold.wait()
    yield "run.completed", {"output": "Terminé"}


async def fake_answer(agent, run, rid, generation, approve):
    answers.append((run, rid, approve))
    await asyncio.sleep(0.03)  # les réponses concurrentes se croisent pendant cet envoi


hermes.start_run, hermes.run_events, hermes.answer_approval = fake_start, fake_events, fake_answer
main.push.notify = lambda *a, **k: None
main.apprentissage.on_refusal = lambda *a, **k: None
main.apprentissage.after_turn = lambda *a, **k: None


def sse(lines):
    fields = {}
    for line in lines:
        if not line:
            if "event" in fields:
                yield fields
            fields = {}
        elif ":" in line:
            k, v = line.split(":", 1)
            fields[k] = v.strip()


@contextlib.contextmanager
def serve():
    # La même fonction de démarrage que l'app ; ses tâches annexes sont fermées sans être lancées.
    def skip(coro):
        coro.close()
    with patch.object(asyncio, "create_task", side_effect=skip):
        asyncio.run(main.startup())
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = Server(uvicorn.Config(main.app, log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    # startup() a déjà été exercé ; le vrai lifespan du bus reste actif.
    with patch.object(main.app.router, "on_startup", []):
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started:
            assert thread.is_alive() and time.monotonic() < deadline, "démarrage HTTP"
            time.sleep(0.01)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(10)
        assert not thread.is_alive(), "arrêt HTTP"


class Listener:
    def __init__(self, base, token, last=None):
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.response = None
        def listen():
            try:
                with httpx.Client(timeout=20) as client:
                    h = headers(token)
                    if last is not None:
                        h["Last-Event-ID"] = str(last)
                    with client.stream("GET", base + "/api/events", headers=h) as response:
                        self.response = response
                        assert response.status_code == 200
                        for event in sse(response.iter_lines()):
                            if self.stop.is_set():
                                return
                            self.events.put((time.monotonic(), event))
            except Exception as error:
                if not self.stop.is_set():
                    self.events.put(error)
        self.thread = threading.Thread(target=listen, daemon=True)
        self.thread.start()

    def next(self, genre, timeout=2):
        deadline = time.monotonic() + timeout
        while True:
            value = self.events.get(timeout=max(0.01, deadline - time.monotonic()))
            if isinstance(value, Exception):
                raise value
            if genre is None or value[1]["event"] == genre:
                return value

    def close(self):
        self.stop.set()
        if self.response:
            self.response.close()
        self.thread.join(3)


def seed(rid, run="run-sync", **extra):
    main._runs.setdefault(run, {"agent": "a1", "user": alice, "conv": conv, "profil": None})
    return accords.create(alice, "a1", conv, run, {"request_id": rid, "generation": 1, "summary": "Valider ?", **extra})


def answer(base, token, item, approve=True):
    return httpx.post(f"{base}/api/agents/a1/runs/{item['run_id']}/approval", headers=headers(token),
                      json={"request_id": item["request_id"], "generation": item["generation"], "approve": approve}, timeout=5)


async def heartbeat():
    assert bus.KEEPALIVE == 15 and bus.KEEP == accords.EXPIRATION == 300
    with patch.object(bus, "KEEPALIVE", 0.02), patch.object(bus, "POLL", 0.005):
        stream = bus.stream(alice, None)
        try:
            assert "event: pret" in await anext(stream)
            assert await asyncio.wait_for(anext(stream), 1) == ": vivant\n\n"
        finally:
            await stream.aclose()


async def disconnected_write():
    for spec in ("2.3", "2.4"):
        closed = asyncio.Event()
        async def source():
            try:
                yield "data: essai\n\n"
                raise AssertionError("aucune lecture après une écriture déconnectée")
            finally:
                closed.set()
        async def send(message):
            if message["type"] == "http.response.body":
                raise OSError("client déconnecté")
        async def receive():
            await asyncio.Event().wait()
        await asyncio.wait_for(bus.EventResponse(source())({"asgi": {"spec_version": spec}}, receive, send), 1)
        assert closed.is_set(), "le générateur doit être fermé dès l'échec d'écriture"


async def lifespan_shutdown():
    app = FastAPI()
    app.include_router(bus.router)
    async with app.router.lifespan_context(app) as state:
        stopping = app.state.noah_events_stopping
        assert state["noah_events_stopping"] is stopping and not stopping.is_set()
        events = bus.stream(alice, None, stopping)
        assert "event: pret" in await anext(events)
    assert stopping.is_set()
    try:
        await anext(events)
        raise AssertionError("le flux doit terminer quand le lifespan s'arrête")
    except StopAsyncIteration:
        pass
    async with app.router.lifespan_context(app):
        assert app.state.noah_events_stopping is not stopping
        assert not app.state.noah_events_stopping.is_set()


asyncio.run(heartbeat())
asyncio.run(disconnected_write())
asyncio.run(lifespan_shutdown())
print("0. Keepalive du vrai générateur SSE ; constantes de 15 s et rétention/expiration de 300 s")
print("0 bis. Écriture déconnectée : fermeture immédiate du générateur, ASGI 2.3 et 2.4")
print("0 ter. Lifespan de l'app : événement d'arrêt, fin du flux et nouvel événement au redémarrage")


with serve() as base, httpx.Client(base_url=base, headers=headers(web_token), timeout=10) as web:
    # Le vrai flux de tâche crée deux accords ; le client part, le serveur les garde.
    with web.stream("POST", "/api/chat", json={"agent_id": "a1", "conversation_id": conv, "text": "Deux actions"}) as response:
        assert response.status_code == 200
        found = 0
        for line in response.iter_lines():
            if line.startswith("data: ") and json.loads(line[6:]).get("type") == "approval":
                found += 1
                if found == 2:
                    break
    items = web.get("/api/accords").json()
    assert [a["request_id"] for a in items] == ["premiere", "seconde"], items
    first, second = items
    assert len(web.get("/api/a-toi").json()) == 2
    choice_conv = main._new_conversation(alice, "a1", "Choix avant accord")
    main._save_message(choice_conv, "agent", "Quelle option ?")
    main.task_state[choice_conv] = "choice"
    with db.connect() as c:
        c.execute("UPDATE conversations SET updated_at = '2020-01-01 00:00:00' WHERE id = ?", (choice_conv,))
    inbox = web.get("/api/a-toi").json()
    assert all(isinstance(item["created"], (int, float)) for item in inbox)
    assert sorted(inbox, key=lambda item: item["created"])[0]["conversation_id"] == choice_conv
    main.task_state.pop(choice_conv)
    print("1 prérequis. À toi fournit des dates comparables pour les accords et les choix")
    listeners = [Listener(base, token) for token in (web_token, phone_token)]
    try:
        for listener in listeners:
            listener.next("pret")
        before = time.monotonic()
        response = answer(base, desktop_token, second)
        assert response.status_code == 200, response.text
        revisions = []
        for listener in listeners:
            at, event = listener.next("accord.clos")
            data = json.loads(event["data"])
            assert data["id"] == second["id"] and data["par"] == "ordinateur" and data["etat"] == "donne", data
            assert at - before < 2, f"clôture reçue après {at - before:.3f} s"
            revisions.append(int(event["id"]))
        assert revisions[0] == revisions[1]
        assert [a["id"] for a in web.get("/api/accords").json()] == [first["id"]]
        assert ("a1", "premiere") in mcp._asked and ("a1", "seconde") not in mcp._asked
        assert "Accord donné sur l'ordinateur" in web.get(f"/api/conversations/{conv}/messages").text
    finally:
        for listener in listeners:
            listener.close()
    print("1. Deux demandes du vrai flux ; réponse à la seconde ; deux SSE en moins de 2 s ; première intacte, MCP et trace cohérents")

    later = seed("pendant-coupure")
    listener = Listener(base, phone_token, revisions[0])
    try:
        _, event = listener.next("accord.demande")
        assert json.loads(event["data"])["id"] == later["id"] and int(event["id"]) > revisions[0]
    finally:
        listener.close()
    print("2. Reconnexion avec Last-Event-ID : l'événement manqué est rejoué")

    race = seed("course", "run-race")
    barrier = threading.Barrier(2)
    def concurrent(token):
        barrier.wait(timeout=3)
        return answer(base, token, race).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(concurrent, (web_token, phone_token)))
    assert sorted(results) == [200, 409], results
    assert sum(rid == "course" for _, rid, _ in answers) == 1
    assert answer(base, web_token, {**race, "generation": 2}).status_code == 404
    print("3. Deux réponses simultanées : un seul 200, un 409, un seul envoi à Hermes ; génération différente refusée")

    for token, par in ((phone_token, "téléphone"), (web_token, "web")):
        item = seed(f"type-{par}", "run-types")
        response = answer(base, token, item)
        assert response.status_code == 200 and response.json()["par"] == par, response.text

    runtime_expired = seed("expire-sans-redemarrer", "run-expiration", summary='Outil « fiches » : supprimer\n{}')
    with db.connect() as c:
        c.execute("UPDATE accords SET created = ? WHERE id = ?", (time.time() - 301, runtime_expired["id"]))
    assert runtime_expired["id"] not in [a["id"] for a in web.get("/api/accords").json()]
    assert answer(base, web_token, runtime_expired).status_code == 409
    assert ("a1", "expire-sans-redemarrer") not in mcp._asked
    with db.connect() as c:
        assert not any(json.loads(r["detail"])["id"] == runtime_expired["id"] for r in
                       c.execute("SELECT detail FROM messages WHERE role = 'accord'")), "expiration sans message"
    print("3 bis. Provenance téléphone/web ; expiration sans redémarrer, réponse tardive refusée et observation MCP retirée")

    with db.connect() as c:
        c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'admin')", (bob,))
        c.execute("UPDATE conversations SET shared = 1 WHERE id = ?", (conv,))
    assert httpx.get(base + "/api/accords", headers=headers(bob_token)).json() == []
    assert answer(base, bob_token, first).status_code == 404
    # #46b : updates.activity() invalide les écrans de tous les comptes, sans contenu.
    # Le compteur de Bob n'est donc plus forcément zéro ; aucun accord ne doit y figurer.
    bob_revision, gap, rows = bus.replay(bob, 0)
    assert not gap
    assert all(r["user_id"] == bob and r["genre"] == "donnees.changees" and json.loads(r["contenu"]) == {} for r in rows)
    listener = Listener(base, bob_token, 0)
    try:
        received = []
        while True:
            _, event = listener.next(None)
            if event["event"] == "pret":
                assert int(event["id"]) == bob_revision and json.loads(event["data"]) == {}
                break
            assert event["event"] == "donnees.changees" and json.loads(event["data"]) == {}, event
            received.append(int(event["id"]))
        assert received == [r["revision"] for r in rows]
        # Nouvelle demande et clôture chez Alice : même admin, Bob ne reçoit rien de plus.
        private = seed("isolation-bob", "run-isolation")
        assert answer(base, web_token, private).status_code == 200
        assert bus.replay(bob, bob_revision) == (bob_revision, False, [])
        # Un signal destiné à Bob sert de témoin : le SSE a bien relu le journal après les accords d'Alice.
        bus.invalidate(bob)
        _, event = listener.next(None)
        assert event == {"id": str(bob_revision + 1), "event": "donnees.changees", "data": "{}"}, event
    finally:
        listener.close()
    print("4. Autre profil, même admin et conversation partagée : ni liste, ni événements d'accord, ni réponse ; seuls les signaux vides #46b passent")

    temporary_token = auth.new_session(alice, "appareil révoqué", "web")
    listener = Listener(base, temporary_token)
    try:
        listener.next("pret")
        auth.drop_session(temporary_token)
        listener.thread.join(4)
        assert not listener.thread.is_alive(), "la révocation doit couper le flux ouvert"
    finally:
        listener.close()

    device = auth.device_id(auth.session_key(desktop_token))
    desktop._waiting["local"] = (None, device, alice)
    desktop._approval_context["local"] = ("a1", conv)
    payload = {"message": "Ouvrir un fichier", "detail": "C:/notes.txt"}
    assert web.post("/api/desktop/accords/local", json=payload).status_code == 403, "un jeton web n'est pas une preuve native"
    native = httpx.post(base + "/api/desktop/accords/local", headers=headers(desktop_token), json=payload)
    assert native.status_code == 200, native.text
    local = native.json()
    assert local["bureau"] and local["id"] in [a["id"] for a in web.get("/api/accords").json()]
    assert answer(base, web_token, local).status_code == 403
    assert answer(base, desktop_token, local).status_code == 403, "même le renderer de bureau n'accorde pas une action locale"
    cookie = httpx.post(base + "/api/desktop/accords/local/reponse", cookies={auth.COOKIE: desktop_token},
                        headers={"Origin": base}, json={"id": local["id"], "approve": True})
    assert cookie.status_code == 403
    other_computer = auth.new_session(alice, "autre ordinateur", "desktop")
    assert httpx.post(base + "/api/desktop/accords/local/reponse", headers=headers(other_computer), json={"id": local["id"], "approve": True}).status_code == 404
    native = httpx.post(base + "/api/desktop/accords/local/reponse", headers=headers(desktop_token), json={"id": local["id"], "approve": True})
    assert native.status_code == 200, native.text
    assert httpx.post(base + "/api/desktop/accords/local/reponse", headers=headers(desktop_token), json={"id": local["id"], "approve": True}).status_code == 409
    # Même destinataire et même contexte : un jeton web envoyé en Bearer ne devient pas natif.
    desktop._waiting["local-web"] = (None, auth.device_id(auth.session_key(web_token)), alice)
    desktop._approval_context["local-web"] = ("a1", conv)
    legacy = web.post("/api/desktop/accords/local-web", json=payload)
    assert legacy.status_code == 403, legacy.text
    local_web = seed("local-web", "desktop:local-web", bureau=True)
    assert web.post("/api/desktop/accords/local-web/reponse", json={"id": local_web["id"], "approve": False}).status_code == 403
    # Ancienne livraison sans agent_id : retrouver l'agent par son nom ne dispense pas de la preuve native.
    for token, rid in ((web_token, "compat-web"), (desktop_token, "compat-desktop")):
        with db.connect() as c:
            c.execute("INSERT INTO desktop_attente (id, user_id, appareil, agent, dossier, chemin, sha256, taille, cree, expire) "
                      "VALUES (?, ?, ?, 'Noah', 'dossier', 'notes.txt', 'empreinte', 0, '2026-11-09', '2099-01-01')",
                      (rid, alice, auth.device_id(auth.session_key(token))))
        compat = httpx.post(base + f"/api/desktop/accords/{rid}", headers=headers(token), json=payload)
        assert compat.status_code == (403 if token == web_token else 200), compat.text
        item = seed(rid, f"desktop:{rid}", bureau=True) if token == web_token else compat.json()
        result = httpx.post(base + f"/api/desktop/accords/{rid}/reponse", headers=headers(token),
                            json={"id": item["id"], "approve": False})
        assert result.status_code == (403 if token == web_token else 200), result.text
        with db.connect() as c:
            state = c.execute("SELECT state FROM accords WHERE id = ?", (item["id"],)).fetchone()["state"]
            assert state == ("attend" if token == web_token else "refuse")
            c.execute("DELETE FROM desktop_attente WHERE id = ?", (rid,))
    window_token = auth.new_window(desktop_token)
    assert httpx.post(base + "/api/desktop/accords/local", headers=headers(window_token), json=payload).status_code == 403
    assert httpx.post(base + "/api/desktop/accords/local/reponse", headers=headers(window_token),
                      json={"id": local["id"], "approve": True}).status_code == 403
    desktop._waiting.clear()
    desktop._approval_context.clear()
    print("5. Accord local visible partout ; web, cookie du renderer et route générique refusés ; seul le processus natif destinataire répond une fois")

    # Vieillir le journal sans attendre dix minutes, comme le banc fait avancer son horloge.
    before_gap = bus.replay(alice, None)[0]
    missed = seed("trou-10-min")
    with db.connect() as c:
        c.execute("UPDATE evenements SET created = ? WHERE user_id = ?", (time.time() - 600, alice))
    listener = Listener(base, phone_token, before_gap)
    try:
        _, event = listener.next("resync")
        assert int(event["id"]) > before_gap
        assert missed["id"] in [a["id"] for a in web.get("/api/accords").json()]
    finally:
        listener.close()
    accords.sweep()
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM evenements WHERE created <= ?", (time.time() - 300,)).fetchone()["n"] == 0
    print("6. Coupure de dix minutes : resync, relecture de la liste, journal borné à cinq minutes, compteur conservé")

    expired = seed("trop-vieux", "ancien")
    orphan = seed("orphelin", "disparu")
    with db.connect() as c:
        c.execute("UPDATE accords SET created = ? WHERE id = ?", (time.time() - 301, expired["id"]))
    last_revision = bus.replay(alice, None)[0]

# Simulation de la mémoire perdue par un nouveau processus, base conservée. serve() refait main.startup().
main._runs.clear()
mcp._asked.clear()
mcp._grants.clear()
with serve() as base:
    with db.connect() as c:
        states = {r["id"]: r["state"] for r in c.execute("SELECT id, state FROM accords")}
    assert states[expired["id"]] == "expire" and states[orphan["id"]] == "annule", states
    with db.connect() as c:
        traces = [json.loads(r["detail"])["id"] for r in c.execute("SELECT detail FROM messages WHERE role = 'accord'")]
        assert expired["id"] not in traces and orphan["id"] not in traces, "balayage sans message"
    assert httpx.get(base + "/api/accords", headers=headers(web_token)).json() == []
    assert not mcp._asked
    assert bus.replay(alice, None)[0] > last_revision
    listener = Listener(base, phone_token, last_revision)
    try:
        _, event = listener.next("accord.clos")
        assert json.loads(event["data"])["etat"] in ("expire", "annule")
    finally:
        listener.close()
    print("7. Redémarrage HTTP et vrai démarrage Noah : expiration à 300 s, runs disparus annulés, aucune carte restante ; compteur et rejeu persistants")

# Les clients restent branchés : c'est le serveur qui doit terminer les flux,
# avant son attente gracieuse, sans annulation forcée ni délai raccourci du test.
with serve() as base:
    listeners = [Listener(base, token) for token in (web_token, phone_token)]
    for listener in listeners:
        listener.next("pret")
    before_stop = time.monotonic()
for listener in listeners:
    listener.thread.join(2)
    assert not listener.thread.is_alive(), "le serveur termine les SSE encore connectés"
    assert listener.events.empty(), "fin HTTP normale, sans erreur du lecteur"
    listener.close()
assert time.monotonic() - before_stop < 3, "arrêt gracieux avec deux SSE ouverts"
print("8. Arrêt du serveur avec deux SSE ouverts : fin HTTP normale et arrêt sous trois secondes")

if os.name != "nt":
    # Même commande que l'image, même Config et même classe Server. Seule l'app
    # est réduite au vrai bus : aucun travail annexe de Noah ne masque son arrêt.
    with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryFile() as log:
        Path(folder, "bus_app.py").write_text(
            "from fastapi import FastAPI\nfrom noah import bus\n"
            "app = FastAPI()\napp.include_router(bus.router)\n", encoding="utf-8")
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        command_line = next(line[4:] for line in (REPO / "server/Dockerfile").read_text(encoding="utf-8").splitlines()
                            if line.startswith("CMD "))
        command = json.loads(command_line)
        command[0] = sys.executable
        command[command.index("noah.main:app")] = "bus_app:app"
        command[command.index("--host") + 1] = "127.0.0.1"
        command[command.index("--port") + 1] = str(port)
        env = {**os.environ, "PYTHONPATH": os.pathsep.join((folder, str(REPO / "server")))}
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        listeners = []
        try:
            base = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 10
            while True:
                assert process.poll() is None, "lancement par la commande Docker"
                try:
                    ready = httpx.get(base + "/openapi.json", timeout=0.2)
                    if ready.status_code == 200:
                        break
                except httpx.RequestError:
                    pass
                assert time.monotonic() < deadline, "démarrage du sous-processus"
                time.sleep(0.02)
            listeners = [Listener(base, token) for token in (web_token, phone_token)]
            for listener in listeners:
                listener.next("pret")
            before_stop = time.monotonic()
            process.terminate()  # vrai SIGTERM, comme docker stop
            assert process.wait(timeout=3) in (0, -signal.SIGTERM)
            for listener in listeners:
                listener.thread.join(2)
                assert not listener.thread.is_alive() and listener.events.empty(), "fin normale des SSE après SIGTERM"
            assert time.monotonic() - before_stop < 3
            log.seek(0)
            output = log.read().decode("utf-8", "replace")
            assert "timeout graceful shutdown exceeded" not in output and "ERROR" not in output, output
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            for listener in listeners:
                listener.close()
    print("9. Commande de l'image Docker : vrai SIGTERM, deux SSE ouverts, fin normale sans annulation forcée sous trois secondes")

print("OK #36")
