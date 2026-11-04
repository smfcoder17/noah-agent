"""G11.4, G11.5, G11.6 : un agent demande à un autre de travailler, et un agent fait sonner l'utilisateur.
Vrai `_run` et vraies routes ; seuls la machine de l'agent (Hermes) et l'envoi des notifications sont simulés.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/coordination/coordination_test.py"
"""
import asyncio
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from apollo import auth, coordination, db, hermes, main, media, push, relay  # noqa: E402

db.init()
owner = auth.create_user("alice", "motdepasse-a")
stranger = auth.create_user("bruno", "motdepasse-b")
AGENTS = {"a": "Alma", "b": "Basile", "c": "Clara", "d": "Dario", "e": "Emma", "x": "Xavier"}
with db.connect() as c:
    for agent_id, name in AGENTS.items():
        c.execute("INSERT INTO agents (id, name, role, api_key) VALUES (?, ?, 'Son rôle', 'k')", (agent_id, name))
MAINS = {a: main._new_conversation(stranger if a == "x" else owner, a, "Conversation", main=True) for a in AGENTS}

# Machine de l'agent simulée : chaque run attend qu'on lui dise quoi émettre.
runs: list[dict] = []


async def fake_start(agent, text, session_id):
    if agent.id in down:
        raise httpx.ConnectError("arrêté")
    runs.append({"agent": agent.id, "text": text, "conv": session_id.removeprefix("apollo-"), "events": asyncio.Queue()})
    return str(len(runs) - 1)


async def fake_events(agent, run_id):
    queue = runs[int(run_id)]["events"]
    while True:
        kind, data = await queue.get()
        yield kind, data
        if kind.startswith("run."):
            return


down: set[str] = set()
hermes.start_run = fake_start
hermes.run_events = fake_events
rings: list[dict] = []
push.notify = lambda title, text, url="/", urgent=False, user_id=None: rings.append(
    {"title": title, "text": text, "url": url, "urgent": urgent, "user": user_id})
coordination.FREE_POLL = 0.01


def finish(run: dict, text="C'est fait.", status="completed", tools=()):
    for tool in tools:
        run["events"].put_nowait(("tool.started", {"tool": tool}))
    if text:
        run["events"].put_nowait(("message.delta", {"delta": text}))
    run["events"].put_nowait((f"run.{status}", {"error": "panne du fournisseur"} if status != "completed" else {}))


async def settle():
    """Laisse tourner les tâches de fond jusqu'à ce qu'elles soient au repos."""
    for _ in range(50):
        await asyncio.sleep(0.005)


def messages(conv: str) -> list[dict]:
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id", (conv,))]


def main_text(agent: str) -> str:
    return "\n".join(m["text"] for m in messages(MAINS[agent]))


def delegation(did: str) -> dict:
    with db.connect() as c:
        return dict(c.execute("SELECT * FROM delegations WHERE id = ?", (did,)).fetchone())


def clear_demands():
    with db.connect() as c:
        c.execute("DELETE FROM delegations")
    coordination._lineage.clear()


def clear_calls():
    with db.connect() as c:
        c.execute("DELETE FROM voice_calls")
    rings.clear()


def run_for(agent: str) -> dict:
    return [r for r in runs if r["agent"] == agent][-1]


transport = httpx.ASGITransport(app=main.app)


def client(token: str | None) -> httpx.AsyncClient:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.AsyncClient(transport=transport, base_url="http://noah.test", headers=headers)


def as_agent(agent: str) -> httpx.AsyncClient:
    return client(relay.token_for(agent))


async def ask(frm: str, to: str, consigne="Fais ceci", **extra) -> httpx.Response:
    async with as_agent(frm) as h:
        return await h.post("/agent-api/demander", json={"agent": to, "consigne": consigne, **extra})


async def test_listing_and_target():
    async with as_agent("a") as h:
        listed = (await h.get("/agent-api/agents")).json()["agents"]
    ids = {a["id"] for a in listed}
    assert ids == {"b", "c", "d", "e"}, listed  # ni lui-même, ni l'agent d'un autre compte
    assert listed[0].keys() == {"id", "nom", "role"} and listed[0]["role"] == "Son rôle"

    # Par id, puis par nom sans tenir compte de la casse.
    r = await ask("a", "b", "Résume le rapport")
    assert r.status_code == 200 and r.json()["etat"] == "en_cours", r.text
    d = delegation(r.json()["id"])
    assert (d["de"], d["vers"], d["profondeur"], d["rappeler"], d["etat"]) == ("a", "b", 1, 0, "en_cours")
    worker = run_for("b")
    assert worker["conv"] == d["conversation_id"] != MAINS["b"]
    assert worker["text"].startswith("[Demande de l'agent Alma (a), pas de l'utilisateur") and worker["text"].endswith("Résume le rapport")
    finish(worker)
    await settle()
    finish(run_for("a"))
    await settle()
    r = await ask("a", "cLaRa")
    assert r.status_code == 200 and delegation(r.json()["id"])["vers"] == "c", r.text
    finish(run_for("c"))
    await settle()
    finish(run_for("a"))
    await settle()
    print("1. liste des agents et cible par id ou par nom, identité du demandeur en tête de la consigne")

    # Cible inconnue, ou d'un autre compte : même réponse.
    before = len(runs)
    assert (await ask("a", "personne")).status_code == 404
    assert (await ask("a", "x")).status_code == 404
    assert (await ask("a", "Xavier")).status_code == 404
    # Pas à soi-même, ni par id ni par nom.
    assert (await ask("a", "a")).status_code == 400
    assert (await ask("a", "ALMA")).status_code == 400
    assert (await ask("a", "b", "   ")).status_code == 400
    # Deux agents du même nom : erreur claire qui donne les id.
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('b2', 'Basile', '', 'k')")
    r = await ask("a", "basile")
    assert r.status_code == 409 and "b2" in r.json()["detail"] and "b," in r.json()["detail"], r.text
    with db.connect() as c:
        c.execute("DELETE FROM agents WHERE id = 'b2'")
    async with client("faux-jeton") as h:
        assert (await h.post("/agent-api/demander", json={"agent": "b", "consigne": "x"})).status_code == 401
    assert len(runs) == before, "un refus ne doit lancer aucun run"
    print("2. refusés : cible inconnue ou d'un autre compte, soi-même, consigne vide, nom ambigu, jeton faux")


async def test_depth_and_cycles():
    clear_demands()
    # A → B → C → D : trois relais acceptés, le quatrième refusé.
    assert (await ask("a", "b")).json()["profondeur"] == 1
    assert (await ask("b", "c")).json()["profondeur"] == 2
    assert (await ask("c", "d")).json()["profondeur"] == 3
    before = len(runs)
    r = await ask("d", "e")
    assert r.status_code == 409 and "relais" in r.json()["detail"], r.text
    # Boucles : directe, et plus longue.
    r = await ask("b", "a")
    assert r.status_code == 409 and "Boucle" in r.json()["detail"], r.text
    r = await ask("c", "a")
    assert r.status_code == 409 and "Boucle" in r.json()["detail"], r.text
    r = await ask("d", "b")
    assert r.status_code == 409 and "Boucle" in r.json()["detail"], r.text
    assert len(runs) == before
    print("3. profondeur 3 au plus ; boucles A→B→A, A→B→C→A et B→C→D→B refusées")

    # Fin de chaîne : D rend à C, qui est relancé dans sa conversation principale. Cette reprise reste dans la chaîne.
    finish(run_for("d"), "Résultat de Dario")
    await settle()
    resumed = run_for("c")
    assert resumed["conv"] == MAINS["c"] and "Résultat de Dario" in resumed["text"]
    r = await ask("c", "a")
    assert r.status_code == 409 and "Boucle" in r.json()["detail"], f"reprise qui remet la chaîne à zéro : {r.text}"
    # Le fil de C (demandé par B) finit pendant cette reprise : la reprise compte encore.
    finish([x for x in runs if x["agent"] == "c" and x["conv"] != MAINS["c"]][-1], "Résultat de Clara")
    await settle()
    r = await ask("c", "a")
    assert r.status_code == 409, "la fin du fil ne doit pas effacer la chaîne de la reprise en cours"
    finish(resumed)
    await settle()
    print("4. un résultat reçu ne remet pas la chaîne à zéro : boucle encore refusée pendant la reprise")

    # Tout est fini : une nouvelle demande repart de zéro, et plus aucune trace de chaîne ne traîne.
    finish(run_for("b"), "Résultat de Basile")
    await settle()
    for agent in ("b", "a"):
        finish(run_for(agent))
        await settle()
    assert not coordination._lineage, coordination._lineage
    r = await ask("c", "a")
    assert r.status_code == 200 and r.json()["profondeur"] == 1, r.text
    finish(run_for("a"))
    await settle()
    finish(run_for("c"))
    await settle()

    # Un fil ouvert pendant une demande hérite de la chaîne, même si la demande finit avant lui.
    clear_demands()
    assert (await ask("a", "b")).status_code == 200
    async with as_agent("b") as h:
        r = await h.post("/agent-api/fils", json={"titre": "Piste", "consigne": "Cherche"})
    assert r.status_code == 200, r.text
    side = run_for("b")
    await settle()
    finish([x for x in runs if x["agent"] == "b" and x is not side][-1])
    await settle()
    r = await ask("b", "a")
    assert r.status_code == 409 and "Boucle" in r.json()["detail"], f"fil qui contourne la boucle : {r.text}"
    finish(side)
    await settle()
    finish(run_for("a"))
    await settle()
    assert not coordination._lineage
    print("5. un fil ouvert pendant une demande garde sa chaîne ; plus rien ne reste à la fin")


async def test_limits():
    clear_demands()
    now = time.time()
    with db.connect() as c:
        for i in range(coordination.DEMANDS_PER_HOUR):
            c.execute("INSERT INTO delegations VALUES (?, 'a', 'b', 'z', 1, '[\"a\"]', 0, 'fini', 'x', ?)", (f"o{i}", now - 60))
    before = len(runs)
    r = await ask("a", "b")
    assert r.status_code == 429 and str(coordination.DEMANDS_PER_HOUR) in r.json()["detail"], r.text
    assert len(runs) == before
    # La limite est par agent, et sur une heure glissante.
    r = await ask("c", "e")
    assert r.status_code == 200, r.text
    finish(run_for("e"))
    await settle()
    finish(run_for("c"))
    await settle()
    with db.connect() as c:
        c.execute("UPDATE delegations SET created_at = ? WHERE de = 'a'", (now - coordination.HOUR - 1,))
    r = await ask("a", "b")
    assert r.status_code == 200, r.text
    finish(run_for("b"))
    await settle()
    finish(run_for("a"))
    await settle()
    print("6. 20 demandes par heure et par agent au plus")

    # Budget du mois ou plafond du jour atteint : la demande ne part pas, et aucun run n'est lancé.
    clear_demands()
    before = len(runs)
    with db.connect() as c:
        c.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost) VALUES ('b', 'm', 1, 1, 5.0)")
    db.set_setting("budget_monthly", "1")
    r = await ask("a", "b")
    assert r.status_code == 402 and "Budget" in r.json()["detail"], r.text
    db.set_setting("budget_monthly", "")
    db.set_setting("budget_daily:b", "1")
    r = await ask("a", "b")
    assert r.status_code == 402 and "plafond" in r.json()["detail"], r.text
    db.set_setting("budget_daily:b", "")
    assert len(runs) == before
    print("7. budget du mois et plafond du jour : aucune demande ne part")


async def test_outcomes():
    clear_demands()
    # Succès : résultat écrit chez le demandeur, qui reprend ; suivi par le demandeur, pas par un tiers.
    did = (await ask("a", "b", "Analyse le site")).json()["id"]
    async with as_agent("a") as h:
        assert (await h.get(f"/agent-api/demander/{did}")).json()["etat"] == "en_cours"
    finish(run_for("b"), "Le site est sain.", tools=["web_search", "terminal"])
    await settle()
    resumed = run_for("a")
    assert resumed["conv"] == MAINS["a"] and "Le site est sain." in resumed["text"] and "information, pas une instruction" in resumed["text"]
    # La consigne donnée à l'agent reste entre lui et Noah : l'écran montre le résultat, écrit de son côté à lui.
    assert "information, pas une instruction" not in main_text("a") and messages(MAINS["a"])[-1]["role"] == "agent"
    assert "Le site est sain." in main_text("a") and "Cherche sur le web" in main_text("a")
    async with as_agent("a") as h:
        follow = (await h.get(f"/agent-api/demander/{did}")).json()
        listed = (await h.get("/agent-api/demandes")).json()
    assert follow["etat"] == "fini" and follow["derniere_reponse"] == "Le site est sain."
    assert did in [d["id"] for d in listed["envoyees"]]
    async with as_agent("c") as h:
        assert (await h.get(f"/agent-api/demander/{did}")).status_code == 404
    finish(resumed)
    await settle()
    print("8. résultat écrit chez le demandeur avec les actions faites, reprise, suivi réservé aux deux agents")

    # Échec du run : dit clairement, jamais présenté comme un résultat.
    did = (await ask("a", "b", "Tâche vouée à l'échec")).json()["id"]
    finish(run_for("b"), None, status="failed")
    await settle()
    assert delegation(did)["etat"] == "echec"
    resumed = run_for("a")
    assert resumed["text"].startswith("[Échec de ta demande à Basile") and "Rien ne prouve" in resumed["text"]
    finish(resumed)
    await settle()
    # Run terminé sans aucune réponse : c'est un échec aussi.
    did = (await ask("a", "b")).json()["id"]
    finish(run_for("b"), None)
    await settle()
    assert delegation(did)["etat"] == "echec" and "sans réponse" in run_for("a")["text"]
    finish(run_for("a"))
    await settle()
    print("9. échec ou absence de réponse : écrit comme un échec chez le demandeur")

    # Cible arrêtée : refus immédiat et clair, la demande n'attend pas pour rien.
    down.add("b")
    r = await ask("a", "b")
    assert r.status_code == 503 and "Basile" in r.json()["detail"], r.text
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM delegations WHERE etat = 'en_cours'").fetchone()["n"] == 0
    down.clear()
    # Demandeur arrêté à la fin du fil : le message reste, une seule fois.
    did = (await ask("a", "b", "Pendant la panne")).json()["id"]
    down.add("a")
    before = main_text("a").count("Réponse pendant la panne")
    finish(run_for("b"), "Réponse pendant la panne")
    await settle()
    down.clear()
    assert main_text("a").count("Réponse pendant la panne") == before + 1
    main.task_state[MAINS["a"]] = "idle"
    # Mise à jour au moment de la reprise : `_run` refuse avant d'écrire, le résultat doit rester quand même.
    (await ask("a", "b", "Pendant la mise à jour")).json()
    main.updates.maintenance = True
    finish(run_for("b"), "Réponse pendant la mise à jour")
    await settle()
    main.updates.maintenance = False
    assert main_text("a").count("Réponse pendant la mise à jour") == 1
    print("10. cible ou demandeur arrêté : erreur claire, et le résultat reste écrit une fois")

    # Demandeur occupé : on n'ouvre pas un second run par-dessus le sien.
    stream = await main._run(hermes.Agent("a", "k"), MAINS["a"], "Message de l'utilisateur")
    busy = run_for("a")
    consume = asyncio.create_task(_drain(stream))
    await settle()
    (await ask("a", "b", "Pendant son travail")).json()
    finish(run_for("b"), "Fini pendant son travail")
    await settle()
    assert run_for("a") is busy, "le résultat a lancé un second run sur la même conversation"
    finish(busy)
    await consume
    await settle()
    assert run_for("a") is not busy and "Fini pendant son travail" in run_for("a")["text"]
    finish(run_for("a"))
    await settle()
    # S'il reste occupé trop longtemps, le résultat est écrit sans le relancer.
    wait = coordination.FREE_WAIT
    coordination.FREE_WAIT = 0.05
    stream = await main._run(hermes.Agent("a", "k"), MAINS["a"], "Encore un message")
    busy = run_for("a")
    consume = asyncio.create_task(_drain(stream))
    await settle()
    (await ask("a", "b", "Longue attente")).json()
    finish(run_for("b"), "Écrit sans reprise")
    await asyncio.sleep(0.2)
    assert run_for("a") is busy and "Écrit sans reprise" in main_text("a")
    finish(busy)
    await consume
    coordination.FREE_WAIT = wait
    print("11. demandeur occupé : le résultat attend la fin de son run, ou reste écrit s'il dure trop")

    # Redémarrage du serveur pendant une demande : le demandeur le sait, sans relancer le modèle.
    clear_demands()
    with db.connect() as c:
        c.execute("INSERT INTO delegations VALUES ('perdue', 'a', 'b', 'z', 1, '[\"a\"]', 0, 'en_cours', 'Tâche perdue', ?)", (time.time() - 100,))
    before = len(runs)
    coordination._BOOT = time.time()
    await coordination.recover()
    assert delegation("perdue")["etat"] == "echec" and "Tâche perdue" in main_text("a") and "redémarré" in main_text("a")
    assert len(runs) == before
    assert (await ask("b", "a")).status_code == 200, "une demande perdue ne doit plus bloquer les suivantes"
    finish(run_for("a"))
    await settle()
    finish(run_for("b"))
    await settle()
    print("12. redémarrage : la demande perdue est dite au demandeur et ne bloque plus rien")


async def _drain(stream):
    async for _ in stream:
        pass


async def post_report(agent: str, texte: str) -> httpx.Response:
    async with as_agent(agent) as h:
        return await h.post("/agent-api/rappel", json={"texte": texte})


async def test_calls():
    clear_calls()
    clear_demands()
    # Le rappel crée sa ligne, part en notification urgente vers /#appel=<id>, chez le bon compte, et reste écrit.
    r = await post_report("a", "Le rapport est prêt.")
    assert r.status_code == 200 and r.json()["etat"] == "sonne", r.text
    call_id = r.json()["id"]
    assert rings == [{"title": "Alma t'appelle", "text": "Le rapport est prêt.", "url": f"/#appel={call_id}", "urgent": True, "user": owner}]
    assert "Le rapport est prêt." in messages(MAINS["a"])[-1]["text"]
    with db.connect() as c:
        row = dict(c.execute("SELECT * FROM voice_calls WHERE id = ?", (call_id,)).fetchone())
    assert row["agent_id"] == "a" and row["etat"] == "sonne" and row["texte"] == "Le rapport est prêt." and row["created_at"] > 0
    # Sans le run de cette conversation, le prochain message de l'agent le lui rappelle : il sait de quoi on parle.
    assert "Le rapport est prêt." in main.machine.pop_context(MAINS["a"])
    print("13. rappel : ligne en base, notification urgente vers /#appel=<id>, compte rendu écrit, connu de l'agent")

    alice = client(auth.new_session(owner, "Firefox", "web"))
    bruno = client(auth.new_session(stranger, "Chrome", "web"))
    anonymous = client(None)
    async with alice, bruno, anonymous:
        for method, path in (("GET", "/api/calls/pending"), ("POST", f"/api/calls/{call_id}/answer"), ("POST", f"/api/calls/{call_id}/decline")):
            assert (await anonymous.request(method, path)).status_code == 401, path
        # Un autre compte ne voit ni ne touche cet appel.
        assert (await bruno.get("/api/calls/pending")).json()["appels"] == []
        assert (await bruno.post(f"/api/calls/{call_id}/answer")).status_code == 404
        assert (await bruno.post(f"/api/calls/{call_id}/decline")).status_code == 404
        pending = (await alice.get("/api/calls/pending")).json()["appels"]
        assert [p["id"] for p in pending] == [call_id] and pending[0]["agent"] == "Alma" and pending[0]["texte"] == "Le rapport est prêt."
        # Répondre rend de quoi ouvrir la conversation et lire le compte rendu ; une seule fois.
        r = await alice.post(f"/api/calls/{call_id}/answer")
        assert r.status_code == 200, r.text
        assert r.json()["etat"] == "repondu" and r.json()["agent_id"] == "a" and r.json()["texte"] == "Le rapport est prêt."
        assert r.json()["conversation_id"] == MAINS["a"]
        assert (await alice.post(f"/api/calls/{call_id}/answer")).status_code == 409
        assert (await alice.post(f"/api/calls/{call_id}/decline")).status_code == 409
        assert (await alice.get("/api/calls/pending")).json()["appels"] == []
        assert (await alice.get(f"/api/calls/{call_id}")).json()["etat"] == "repondu"
        assert (await alice.post("/api/calls/inconnu/answer")).status_code == 404
        assert messages(MAINS["a"])[-1]["text"] == coordination.ENDINGS["repondu"]
        print("14. API : authentifiée, limitée au compte, répondre une seule fois")

        # Refuser : l'appel se termine, le compte rendu reste.
        call_id = (await post_report("a", "Compte rendu refusé")).json()["id"]
        assert (await alice.post(f"/api/calls/{call_id}/decline")).json()["etat"] == "refuse"
        assert (await alice.post(f"/api/calls/{call_id}/answer")).status_code == 409
        assert "Compte rendu refusé" in main_text("a") and messages(MAINS["a"])[-1]["text"] == coordination.ENDINGS["refuse"]
        print("15. refuser laisse le compte rendu écrit")

        # Sans réponse après 60 s : manqué, par la minuterie et sans que personne n'interroge le serveur.
        ring = coordination.RING_SECONDS
        assert ring == 60
        coordination.RING_SECONDS = 0.05
        call_id = (await post_report("a", "Personne ne répond")).json()["id"]
        await asyncio.sleep(0.2)
        with db.connect() as c:
            assert c.execute("SELECT etat FROM voice_calls WHERE id = ?", (call_id,)).fetchone()["etat"] == "manque"
        assert "Personne ne répond" in main_text("a") and messages(MAINS["a"])[-1]["text"] == coordination.ENDINGS["manque"]
        assert (await alice.post(f"/api/calls/{call_id}/answer")).status_code == 409
        assert (await alice.get(f"/api/calls/{call_id}")).json()["etat"] == "manque"
        coordination.RING_SECONDS = ring
        # Après un redémarrage (plus de minuterie) : relevé passé 60 s, il est manqué lui aussi.
        call_id = (await post_report("a", "Sonnait au redémarrage")).json()["id"]
        with db.connect() as c:
            c.execute("UPDATE voice_calls SET created_at = ? WHERE id = ?", (time.time() - ring - 1, call_id))
        assert call_id not in [p["id"] for p in (await alice.get("/api/calls/pending")).json()["appels"]]
        with db.connect() as c:
            assert c.execute("SELECT etat FROM voice_calls WHERE id = ?", (call_id,)).fetchone()["etat"] == "manque"
        print("16. sans réponse après 60 s : manqué, avec le compte rendu toujours écrit")

        # 6 rappels par heure et par agent au plus.
        clear_calls()
        for i in range(coordination.CALLS_PER_HOUR):
            assert (await post_report("a", f"Rappel {i}")).status_code == 200
        count = len(rings)
        r = await post_report("a", "Rappel de trop")
        assert r.status_code == 429 and "6" in r.json()["detail"], r.text
        assert len(rings) == count and "Rappel de trop" not in main_text("a")
        assert (await post_report("b", "Autre agent")).status_code == 200
        with db.connect() as c:
            c.execute("UPDATE voice_calls SET created_at = ? WHERE agent_id = 'a'", (time.time() - coordination.HOUR - 1,))
        assert (await post_report("a", "Une heure plus tard")).status_code == 200
        assert (await post_report("a", "   ")).status_code == 400
        print("17. 6 rappels par heure et par agent ; compte rendu vide refusé")

        # Les actions faites pendant le run sont écrites avec le compte rendu, sans être lues à voix haute.
        clear_calls()
        stream = await main._run(hermes.Agent("b", "k"), MAINS["b"], "Cherche puis rappelle-moi")
        worker = run_for("b")
        consume = asyncio.create_task(_drain(stream))
        worker["events"].put_nowait(("tool.started", {"tool": "web_search"}))
        await settle()
        call_id = (await post_report("b", "J'ai trouvé")).json()["id"]
        finish(worker)
        await consume
        report = [m["text"] for m in messages(MAINS["b"]) if "J'ai trouvé" in m["text"]][0]
        assert "Actions faites : Cherche sur le web." in report
        assert (await alice.get(f"/api/calls/{call_id}")).json()["texte"] == "J'ai trouvé"
        print("18. les actions faites sont écrites avec le compte rendu, pas lues à voix haute")

        # --rappeler : la fin du fil fait sonner le demandeur, succès comme échec, et il ne rappelle pas deux fois.
        clear_calls()
        clear_demands()
        did = (await ask("a", "b", "Prépare le devis", rappeler=True)).json()["id"]
        assert delegation(did)["rappeler"] == 1 and not rings
        finish(run_for("b"), "Devis prêt.\n```noah\n{\"type\":\"preview\"}\n```", tools=["web_search"])
        await settle()
        assert len(rings) == 1 and rings[0]["urgent"] and rings[0]["url"].startswith("/#appel=") and rings[0]["title"] == "Alma t'appelle"
        pending = (await alice.get("/api/calls/pending")).json()["appels"]
        assert len(pending) == 1 and "Basile a fini" in pending[0]["texte"] and "Devis prêt" in pending[0]["texte"] and "```" not in pending[0]["texte"]
        assert "déjà rappelé" in run_for("a")["text"] and "Cherche sur le web" in main_text("a")
        finish(run_for("a"))
        await settle()
        clear_calls()
        (await ask("a", "b", "Échouera", rappeler=True)).json()
        finish(run_for("b"), None, status="failed")
        await settle()
        pending = (await alice.get("/api/calls/pending")).json()["appels"]
        assert len(pending) == 1 and "a échoué" in pending[0]["texte"] and "a fini" not in pending[0]["texte"]
        finish(run_for("a"))
        await settle()
        # Sans --rappeler, rien ne sonne.
        clear_calls()
        (await ask("a", "b", "Sans rappel")).json()
        finish(run_for("b"))
        await settle()
        assert not rings
        finish(run_for("a"))
        await settle()
        # Limite atteinte au moment du rappel : le résultat arrive quand même, et le dit.
        with db.connect() as c:
            for i in range(coordination.CALLS_PER_HOUR):
                c.execute("INSERT INTO voice_calls VALUES (?, 'a', ?, ?, 'x', 'manque', ?, NULL)", (f"v{i}", owner, MAINS["a"], time.time()))
        (await ask("a", "b", "Rappel impossible", rappeler=True)).json()
        finish(run_for("b"), "Résultat quand même")
        await settle()
        assert not rings and "Résultat quand même" in run_for("a")["text"] and "n'a pas pu partir" in run_for("a")["text"]
        finish(run_for("a"))
        await settle()
        print("19. --rappeler : sonne à la fin (succès ou échec), sinon rien ; limite atteinte : le résultat arrive et le dit")

        # Rappel lancé par un agent d'un autre compte : il sonne chez ce compte-là seulement.
        clear_calls()
        call_id = (await post_report("x", "Pour Bruno")).json()["id"]
        assert rings[-1]["user"] == stranger
        assert (await alice.get("/api/calls/pending")).json()["appels"] == []
        assert [p["id"] for p in (await bruno.get("/api/calls/pending")).json()["appels"]] == [call_id]
        # Agent supprimé : son appel ne sonne plus.
        with db.connect() as c:
            c.execute("DELETE FROM agents WHERE id = 'x'")
        assert (await bruno.get("/api/calls/pending")).json()["appels"] == []
        print("20. un rappel sonne chez le compte de l'agent, et s'arrête si l'agent est supprimé")


def test_voice_and_setup():
    system = media.VOICE_TURN.format(name="Alma", role="")
    assert "demande à Léa" in system and "où en est" in system
    assert "action = true" in system and "ne dis jamais qu'une tâche est finie" in system
    assert "ni pourcentage" in system
    print("21. la consigne de la voix rapide classe ces demandes en action et interdit d'inventer un avancement")
    assert main.AGENT_SETUP_VERSION != "22-garde-skills", "les agents ne recevraient pas le nouveau noah.py"
    assert "noah.py rappeler" in main.CAPABILITIES and "noah.py demander" in main.CAPABILITIES and "noah.py appeler" in main.CAPABILITIES
    assert "coordination.recover" in __import__("inspect").getsource(main.startup)
    print("22. nouvelle version de configuration des agents et consignes à jour")


def test_cli():
    """Le vrai noah.py, lancé comme dans la machine de l'agent, contre un petit serveur qui note ce qu'il reçoit."""
    seen: list[tuple[str, str, dict | None]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self):
            size = int(self.headers.get("content-length") or 0)
            seen.append((self.command, self.path, json.loads(self.rfile.read(size)) if size else None))
            assert self.headers["authorization"] == "Bearer jeton"
            data = b'{"ok": true}'
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = _answer

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    script = os.path.join(tempfile.mkdtemp(), "noah.py")
    source = hermes.AGENT_TOOL.replace("__TOKEN__", "jeton").replace("http://apollo-server:8080/agent-api", f"http://127.0.0.1:{server.server_port}/agent-api")
    with open(script, "w", encoding="utf-8") as f:
        f.write(source)

    def noah(*args):
        r = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, encoding="utf-8", timeout=30)
        assert r.returncode == 0, r.stderr
        return r.stdout

    noah("agents")
    noah("demander", "Basile", "Fais", "ceci")
    noah("demander", "--rappeler", "Basile", "Fais ceci")
    noah("demander", "Basile", "Fais ceci", "--rappeler")
    noah("rappeler", "Le", "rapport est prêt")
    noah("demande-etat", "abc")
    noah("demandes")
    noah("appeler", "Connecte-toi")
    server.shutdown()
    assert seen == [
        ("GET", "/agent-api/agents", None),
        ("POST", "/agent-api/demander", {"agent": "Basile", "consigne": "Fais ceci", "rappeler": False}),
        ("POST", "/agent-api/demander", {"agent": "Basile", "consigne": "Fais ceci", "rappeler": True}),
        ("POST", "/agent-api/demander", {"agent": "Basile", "consigne": "Fais ceci", "rappeler": True}),
        ("POST", "/agent-api/rappel", {"texte": "Le rapport est prêt"}),
        ("GET", "/agent-api/demander/abc", None),
        ("GET", "/agent-api/demandes", None),
        ("POST", "/agent-api/appel", {"message": "Connecte-toi", "quand_quitte": ""}),  # l'appel de handoff reste à part
    ], seen
    print("23. noah.py : agents, demander, rappeler, demande-etat, demandes ; `appeler` inchangé")


async def everything():
    await test_listing_and_target()
    await test_depth_and_cycles()
    await test_limits()
    await test_outcomes()
    await test_calls()


asyncio.run(everything())
test_voice_and_setup()
test_cli()
print("coordination : tout est vert")
