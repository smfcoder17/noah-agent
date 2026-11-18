"""0.4.0, pas S5 du socle : la double écriture des tâches (docs/epics/0.4.0/socle.md, 1.2 et 4.3). Chacun des six endroits où naît
une sous-conversation crée aussi sa tâche, une seule, et la ferme là où le travail se termine : fini, échec, reprise au démarrage.
Vrai `_run`, vraies routes, vraie base ; seuls la machine de l'agent (Hermes) et les notifications sont simulés, comme dans
tests/coordination/coordination_test.py, dont ce test reprend le faux lanceur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/double_ecriture_test.py"
"""
import asyncio
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, coordination, db, hermes, main, proactif, push, relay, taches  # noqa: E402
main._today = lambda: ""  # la ligne du jour n'est pas le sujet

db.init()
owner = auth.create_user("alice", "motdepasse-a")
stranger = auth.create_user("bruno", "motdepasse-b")
AGENTS = {"a": "Alma", "b": "Basile", "x": "Xavier"}
with db.connect() as c:
    for agent_id, name in AGENTS.items():
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, stranger if agent_id == "x" else owner))
MAINS = {a: main._new_conversation(stranger if a == "x" else owner, a, "Conversation", main=True) for a in AGENTS}

# Machine de l'agent simulée : chaque run attend qu'on lui dise quoi émettre.
runs: list[dict] = []
down: set[str] = set()


async def fake_start(agent, text, session_id):
    if agent.id in down:
        raise httpx.ConnectError("arrêté")
    runs.append({"agent": agent.id, "text": text, "conv": session_id.removeprefix("noah-"), "events": asyncio.Queue()})
    return str(len(runs) - 1)


async def fake_events(agent, run_id):
    queue = runs[int(run_id)]["events"]
    while True:
        kind, data = await queue.get()
        yield kind, data
        if kind.startswith("run."):
            return


async def healthy(*a, **k):
    return True


hermes.start_run, hermes.run_events, hermes.health = fake_start, fake_events, healthy
push.notify = lambda *a, **k: None
proactif.desktop.notify_user = lambda *a, **k: None
proactif.notifications.seen_recently = lambda conv_id: False
coordination.FREE_POLL = 0.01


def finish(run: dict, text="C'est fait.", status="completed", tools=()):
    for tool in tools:
        run["events"].put_nowait(("tool.started", {"tool": tool}))
    if text:
        run["events"].put_nowait(("message.delta", {"delta": text}))
    run["events"].put_nowait((f"run.{status}", {"error": "panne du fournisseur"} if status != "completed" else {}))


async def settle():
    for _ in range(60):
        await asyncio.sleep(0.005)


def run_for(agent: str) -> dict:
    return [r for r in runs if r["agent"] == agent][-1]


async def drain(stream):
    async for _ in stream:
        pass


transport = httpx.ASGITransport(app=main.app)


def client(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, base_url="http://noah.test", headers={"Authorization": f"Bearer {token}"})


def as_agent(agent: str) -> httpx.AsyncClient:
    return client(relay.token_for(agent))


def as_user(user: int) -> httpx.AsyncClient:
    return client(auth.new_session(user, "test", "web"))


async def ask(frm: str, to: str, consigne="Fais ceci", **extra) -> httpx.Response:
    async with as_agent(frm) as h:
        return await h.post("/agent-api/demander", json={"agent": to, "consigne": consigne, **extra})


def tasks_of(conv: str) -> list[dict]:
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM taches WHERE conversation_id = ?", (conv,))]


def one(conv: str) -> dict:
    found = tasks_of(conv)
    assert len(found) == 1, f"une seule tâche attendue pour {conv}, trouvé {len(found)} : {found}"
    return found[0]


def trace_id(fil: str, conv: str) -> int | None:
    with db.connect() as c:
        row = c.execute("SELECT id FROM messages WHERE conversation_id = ? AND role = 'trace' AND json_extract(detail, '$.fil') = ?", (fil, conv)).fetchone()
    return row["id"] if row else None


def clear_demands():
    with db.connect() as c:
        c.execute("DELETE FROM delegations")
    coordination._lineage.clear()


async def test_demande():
    # 1. Une demande à un autre agent : sa tâche naît avec sa sous-conversation, relie sa trace, se ferme avec elle.
    r = await ask("a", "b", "Résume le rapport de ventes. Puis liste les risques")
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    with db.connect() as c:
        conv = c.execute("SELECT conversation_id FROM delegations WHERE id = ?", (did,)).fetchone()["conversation_id"]
    t = one(conv)
    assert (t["genre"], t["etat"], t["demandeur"], t["source_id"], t["agent_id"], t["owner_id"], t["fil_id"], t["migree"]) == \
        ("demande", "encours", "a", did, "b", owner, MAINS["b"], 0), t
    assert t["titre"] == "Résume le rapport de ventes" and t["consigne"].startswith("Résume le rapport") and t["fini_a"] is None
    assert t["trace_id"] is not None and t["trace_id"] == t["ancre"] == trace_id(MAINS["b"], conv), "la tâche prend la place de la trace"
    finish(run_for("b"), "Voici le rapport. Les ventes montent de 4 %.")
    await settle()
    finish(run_for("a"))
    await settle()
    t = one(conv)
    assert t["etat"] == "fini" and t["fini_a"] is not None and t["resume"] == "Voici le rapport.", t
    print("1. demande entre agents : une tâche à la création (trace liée), « fini » avec son résumé à la fin du travail")

    # 2. Échec du travail.
    did = (await ask("a", "b", "Prépare la facture")).json()["id"]
    with db.connect() as c:
        conv = c.execute("SELECT conversation_id FROM delegations WHERE id = ?", (did,)).fetchone()["conversation_id"]
    assert one(conv)["etat"] == "encours"
    finish(run_for("b"), "Je n'y arrive pas", status="failed")
    await settle()
    finish(run_for("a"))
    await settle()
    t = one(conv)
    assert t["etat"] == "echec" and t["fini_a"] is not None and t["resume"], t
    print("2. demande dont le travail échoue : « echec »")

    # 3. L'agent ne peut pas la recevoir : la demande est refusée, et la tâche née avant ne reste pas « encours ».
    down.add("b")
    r = await ask("a", "b", "Pendant la panne")
    down.clear()
    assert r.status_code == 503, r.text
    with db.connect() as c:
        conv = c.execute("SELECT conversation_id FROM delegations WHERE consigne = 'Pendant la panne'").fetchone()["conversation_id"]
    t = one(conv)
    assert t["etat"] == "echec" and t["fini_a"] is not None and t["trace_id"] is None, t
    print("3. agent injoignable (503) : la tâche est fermée en échec")


async def test_recover():
    clear_demands()
    now = time.time()
    # Un serveur qui redémarre : une demande perdue en route, et une finie juste avant, pas encore arrivée chez le demandeur.
    lost_conv = main._new_conversation(owner, "b", "Demande de Alma : Tâche perdue", origin="agent")
    done_conv = main._new_conversation(owner, "b", "Demande de Alma : Tâche finie", origin="agent")
    old_conv = main._new_conversation(owner, "b", "Demande de Alma : Tâche d'avant la 0.4.0", origin="agent")  # sans tâche : l'ancienne base
    with db.connect() as c:
        c.execute("INSERT INTO delegations VALUES ('perdue', 'a', 'b', ?, 1, '[\"a\"]', 0, 'en_cours', 'Tâche perdue', ?, 0)", (lost_conv, now - 100))
        c.execute("INSERT INTO delegations VALUES ('a-livrer', 'a', 'b', ?, 1, '[\"a\"]', 0, 'fini', 'Tâche finie', ?, 0)", (done_conv, now - 100))
        c.execute("INSERT INTO delegations VALUES ('ancienne', 'a', 'b', ?, 1, '[\"a\"]', 0, 'en_cours', 'Tâche d''avant la 0.4.0', ?, 0)", (old_conv, now - 100))
    taches.creer(lost_conv, "demande", consigne="Tâche perdue", demandeur="a", source_id="perdue")
    taches.creer(done_conv, "demande", consigne="Tâche finie", demandeur="a", source_id="a-livrer")  # fermée en mémoire avant de l'être en base
    with db.connect() as c:
        c.execute("INSERT INTO messages (conversation_id, role, text) VALUES (?, 'agent', 'Résultat tardif. Détail.')", (done_conv,))
    migrated = taches.migrer()  # la migration reprend l'ancienne demande encore en cours : « encours », la reprise dira la suite
    assert migrated["creees"] == 1 and one(old_conv)["etat"] == "encours" and one(old_conv)["migree"] == 1, migrated
    coordination._BOOT = time.time()
    before = len(runs)
    await coordination.recover()
    assert one(lost_conv)["etat"] == "echec" and one(lost_conv)["fini_a"] is not None, "demande perdue au redémarrage : échec"
    assert one(old_conv)["etat"] == "echec", "la demande reprise par la migration est fermée par la reprise"
    t = one(done_conv)
    assert t["etat"] == "fini" and t["resume"] == "Résultat tardif.", t
    assert len(runs) == before, "la reprise ne relance aucun modèle"
    print("4. reprise au démarrage : demande perdue → échec, demande finie non livrée → fini, ancienne demande migrée → échec")


async def test_fil():
    # 5. Fil ouvert par l'agent.
    async with as_agent("a") as h:
        r = await h.post("/agent-api/fils", json={"titre": "Piste de recherche", "consigne": "Cherche"})
    assert r.status_code == 200, r.text
    conv = r.json()["id"]
    t = one(conv)
    assert (t["genre"], t["etat"], t["titre"], t["demandeur"], t["fil_id"], t["owner_id"]) == ("fil", "encours", "Piste de recherche", "", MAINS["a"], owner), t
    assert t["trace_id"] == t["ancre"] == trace_id(MAINS["a"], conv) and t["trace_id"] is not None
    finish(run_for("a"), "J'ai trouvé trois pistes.")
    await settle()
    t = one(conv)
    assert t["etat"] == "fini" and t["resume"] == "J'ai trouvé trois pistes." and t["fini_a"] is not None, t
    # Fil qui échoue.
    async with as_agent("a") as h:
        conv2 = (await h.post("/agent-api/fils", json={"titre": "Autre piste", "consigne": "Cherche encore"})).json()["id"]
    finish(run_for("a"), "", status="failed")
    await settle()
    assert one(conv2)["etat"] == "echec"
    # Fil qui ne démarre pas : la route dit l'erreur, la tâche née avant ne reste pas « encours ».
    down.add("a")
    async with as_agent("a") as h:
        r = await h.post("/agent-api/fils", json={"titre": "Piste impossible", "consigne": "Cherche"})
    down.clear()
    assert r.status_code >= 400, r.text
    with db.connect() as c:
        stuck = c.execute("SELECT id FROM conversations WHERE title = 'Piste impossible'").fetchone()["id"]
    assert one(stuck)["etat"] == "echec"
    print("5. fil ouvert par l'agent : tâche à la création (trace liée), fini ou échec à la fin du fil, échec si le fil ne démarre pas")


async def test_routine():
    # 6. Routine à condition : le cerveau travaille dans un fil à lui.
    job = asyncio.create_task(main._wake_for_routine("a", "Surveille le prix du billet", "Regarde le prix"))
    await settle()
    conv = run_for("a")["conv"]
    t = one(conv)
    assert (t["genre"], t["etat"], t["titre"], t["fil_id"], t["owner_id"]) == ("routine", "encours", "Surveille le prix du billet", MAINS["a"], owner), t
    finish(run_for("a"), "Le billet est à 120 euros. C'est moins cher.")
    out = await job
    assert out["texte"].startswith("Le billet est à 120 euros"), out
    t = one(conv)
    assert t["etat"] == "fini" and t["resume"] == "Le billet est à 120 euros." and t["fini_a"] is not None, t
    job = asyncio.create_task(main._wake_for_routine("a", "Surveille le prix de l'hôtel", "Regarde le prix"))
    await settle()
    conv = run_for("a")["conv"]
    finish(run_for("a"), "", status="failed")
    out = await job
    assert "erreur" in out, out
    assert one(conv)["etat"] == "echec"
    print("6. routine à condition : une tâche « routine » dans le fil du propriétaire, fini ou échec avec le résultat rendu")


async def test_sous_agent():
    # 7. Sous-agent d'Hermes (delegate_task) : chaque délégation devient un fil, donc une tâche.
    def known() -> set[str]:
        with db.connect() as c:
            return {r["id"] for r in c.execute("SELECT id FROM conversations WHERE main = 0")}

    async def turn(events: list[tuple]) -> list[str]:
        before = known()
        stream = await main._run(hermes.Agent("a", "k"), MAINS["a"], "Cherche les prix")
        consume = asyncio.create_task(drain(stream))
        await settle()
        for event in events:
            run_for("a")["events"].put_nowait(event)
        await consume
        return sorted(known() - before)

    start = lambda goal, background=False: ("tool.started", {"tool": "delegate_task", "tool_name": "delegate_task", "args": {"goal": goal, "background": background}})
    ok = ("tool.completed", {"tool": "delegate_task", "tool_name": "delegate_task", "preview": "Prix trouvés : 120 euros. Détail."})
    ko = ("tool.failed", {"tool": "delegate_task", "tool_name": "delegate_task", "preview": "boum"})
    end = ("message.delta", {"delta": "Voilà."}), ("run.completed", {})

    new = await turn([start("Cherche les prix des billets"), ok, *end])
    assert len(new) == 1, new
    t = one(new[0])
    assert (t["genre"], t["etat"], t["titre"], t["fil_id"], t["owner_id"], t["trace_id"]) == ("sous_tache", "fini", "Cherche les prix des billets", MAINS["a"], owner, None), t
    assert t["resume"] == "Prix trouvés : 120 euros." and t["fini_a"] is not None, t
    new = await turn([start("Cherche les hôtels"), ko, *end])
    assert len(new) == 1 and one(new[0])["etat"] == "echec"
    new = await turn([start("Cherche en arrière-plan", True), ok, *end])
    assert len(new) == 1 and one(new[0])["etat"] == "fini" and "arrière-plan" in one(new[0])["resume"]
    new = await turn([start("Cherche sans fin"), ("run.completed", {})])  # le run s'arrête pendant la délégation
    assert len(new) == 1 and one(new[0])["etat"] == "echec", tasks_of(new[0])
    new = await turn([start("Premier but"), start("Deuxième but"), ok, ko, *end])
    assert len(new) == 2 and sorted(one(n)["etat"] for n in new) == ["echec", "fini"], [tasks_of(n) for n in new]
    print("7. sous-agent (delegate_task) : une tâche « sous_tache » par fil, fini, échec, arrière-plan, run coupé en pleine délégation")


async def test_discussion():
    # 8. « Nouvelle discussion » : une tâche `discussion`, sans travail en cours à sa naissance.
    async with as_user(owner) as h:
        first = (await h.post("/api/agents/a/conversations")).json()["id"]
        second = (await h.post("/api/agents/a/conversations")).json()["id"]
    t = one(first)
    assert (t["genre"], t["etat"], t["titre"], t["fil_id"], t["owner_id"], t["demandeur"]) == ("discussion", "fini", "Nouvelle discussion", MAINS["a"], owner, ""), t
    assert t["fini_a"] is not None and one(second)["titre"].startswith("Nouvelle discussion (") and one(second)["titre"] != t["titre"], "deux titres identiques dans un fil : l'heure"
    async with as_user(stranger) as h:
        mine = (await h.post("/api/agents/x/conversations")).json()["id"]
    assert one(mine)["fil_id"] == MAINS["x"] and one(mine)["owner_id"] == stranger
    print("8. discussion de la personne : une tâche « discussion » dans le fil de son compte, titres distincts")


async def test_initiative():
    # 9. Tour de lui-même.
    async def start(titre: str) -> str:
        sorted_out = {"titre": titre, "resume": "Une facture à traiter.", "retenues": [], "liens": []}
        return await proactif._start_turn("a", "agir", sorted_out, [{"source": "Courriels", "titre": "Facture", "cle": "k", "texte": "x"}])

    async def wait():
        for _ in range(300):
            if not [t for t in proactif._tasks if not t.done()] + [t for t in main._running_runs if not t.done()]:
                return
            await asyncio.sleep(0.01)

    conv = await start("Une facture à payer")
    t = one(conv)
    with db.connect() as c:
        turn_id = c.execute("SELECT id FROM proactive_turns WHERE conversation_id = ?", (conv,)).fetchone()["id"]
    assert (t["genre"], t["etat"], t["titre"], t["source_id"], t["fil_id"], t["owner_id"]) == ("initiative", "encours", "Une facture à payer", turn_id, MAINS["a"], owner), t
    assert "De lui-même" not in t["titre"]
    finish(run_for("a"), "J'ai préparé le virement.")
    await wait()
    t = one(conv)
    assert t["etat"] == "fini" and t["resume"] == "J'ai préparé le virement." and t["fini_a"] is not None, t
    print("9a. tour de lui-même : une tâche « initiative » à la création, « fini » à la fin du tour")

    # Coupé en route : le tour se reprend une fois, la tâche reste « encours » jusqu'à la fin de la reprise.
    conv = await start("Un courriel important")
    finish(run_for("a"), "", status="failed")
    await wait()
    with db.connect() as c:
        turn = dict(c.execute("SELECT * FROM proactive_turns WHERE conversation_id = ?", (conv,)).fetchone())
    assert turn["etat"] == "a_reprendre" and one(conv)["etat"] == "encours", (turn, one(conv))
    answer = await proactif._resume_turn("a", turn, "agir")
    assert answer["etat"] == "reprise", answer
    finish(run_for("a"), "Repris et terminé.")
    await wait()
    assert one(conv)["etat"] == "fini" and one(conv)["resume"] == "Repris et terminé."
    # Coupé deux fois : échec.
    conv = await start("Un autre courriel")
    finish(run_for("a"), "", status="failed")
    await wait()
    with db.connect() as c:
        turn = dict(c.execute("SELECT * FROM proactive_turns WHERE conversation_id = ?", (conv,)).fetchone())
    await proactif._resume_turn("a", turn, "agir")
    finish(run_for("a"), "", status="failed")
    await wait()
    assert one(conv)["etat"] == "echec" and one(conv)["fini_a"] is not None
    print("9b. tour coupé : « encours » pendant la reprise, puis fini ; coupé deux fois : échec")

    # Redémarrage pendant un tour : le premier passage prépare la reprise (la tâche reste ouverte), le second la ferme en échec.
    conv = main._new_conversation(owner, "a", "De lui-même : Tour perdu", origin="agent")
    taches.creer(conv, "initiative", titre="Tour perdu", source_id="perdu")
    with db.connect() as c:
        c.execute("INSERT INTO proactive_turns (id, agent_id, conversation_id, mode, titre, etat, at, reprise) VALUES ('perdu', 'a', ?, 'agir', 'Tour perdu', 'en_cours', ?, 0)", (conv, time.time()))
    proactif.recover()
    assert one(conv)["etat"] == "encours", "le tour va être repris : la tâche n'est pas fermée"
    with db.connect() as c:
        c.execute("UPDATE proactive_turns SET etat = 'en_cours', reprise = 1 WHERE id = 'perdu'")
    proactif.recover()
    assert one(conv)["etat"] == "echec" and one(conv)["fini_a"] is not None
    print("9c. redémarrage pendant un tour : repris une fois (tâche ouverte), puis échec")


async def test_ensemble():
    # Une seule tâche par sous-conversation, et chaque sous-conversation a la sienne.
    with db.connect() as c:
        orphans = [r["id"] for r in c.execute("SELECT id FROM conversations v WHERE main = 0 AND NOT EXISTS (SELECT 1 FROM taches t WHERE t.conversation_id = v.id)")]
        doubles = c.execute("SELECT conversation_id FROM taches GROUP BY conversation_id HAVING COUNT(*) > 1").fetchall()
        stuck = c.execute("SELECT genre, titre FROM taches WHERE etat = 'encours' AND genre != 'initiative' AND migree = 0").fetchall()
    assert not orphans and not doubles, (orphans, doubles)
    assert not stuck, f"des tâches restent « encours » alors que leur travail est fini : {[dict(s) for s in stuck]}"
    with db.connect() as c:
        assert not [r for r in c.execute("SELECT titre FROM taches") if r["titre"].startswith(("Demande de", "De lui-même"))]
    print("10. toutes les sous-conversations ont leur tâche, une seule, et aucune ne reste « encours » à tort")

    # Une erreur d'écriture d'une tâche ne casse jamais le travail d'origine : la demande aboutit, la migration rattrape la tâche.
    real_title, real_resume = taches.titre_auto, taches._resume

    def broken(*a, **k):
        raise RuntimeError("écriture impossible")

    taches.titre_auto = broken
    r = await ask("a", "b", "Pendant que l'écriture échoue")
    taches.titre_auto = real_title
    assert r.status_code == 200, r.text
    with db.connect() as c:
        conv = c.execute("SELECT conversation_id FROM delegations WHERE id = ?", (r.json()["id"],)).fetchone()["conversation_id"]
    assert tasks_of(conv) == [], "la tâche n'a pas pu s'écrire"
    taches._resume = broken
    finish(run_for("b"), "Fait quand même.")
    await settle()
    finish(run_for("a"))
    await settle()
    taches._resume = real_resume
    with db.connect() as c:
        assert c.execute("SELECT etat FROM delegations WHERE conversation_id = ?", (conv,)).fetchone()["etat"] == "fini"
        assert "Fait quand même" in "\n".join(m["text"] for m in c.execute("SELECT text FROM messages WHERE conversation_id = ?", (MAINS["a"],)))
    rattrape = taches.migrer()
    t = one(conv)
    assert rattrape["creees"] >= 1 and t["migree"] == 1 and t["etat"] == "fini" and t["genre"] == "demande", t
    print("11. écriture de tâche en panne : la demande aboutit quand même, la migration au démarrage suivant rattrape la tâche")


async def everything():
    await test_demande()
    await test_recover()
    await test_fil()
    await test_routine()
    await test_sous_agent()
    await test_discussion()
    await test_initiative()
    await test_ensemble()


asyncio.run(everything())
print("OK")
