"""0.4.0, lot L1 (a et c) : le fil est la seule conversation d'un agent, les tâches sont la source de vérité de ce qui s'y passe.
Une demande entre deux agents ne fait apparaître aucune conversation et le fil du demandeur reçoit trois lignes ; la liste des
conversations ne rend plus que le fil ; un redémarrage ferme en échec ce qu'il a coupé ; une « Nouvelle discussion » vide n'est pas une
tâche ; `GET /api/taches` rend, sous la même forme, les tâches que le fil porte déjà. Vrai `_run`, vraies routes, vraie base ; seule la
machine de l'agent (Hermes) est simulée, comme dans tests/taches/double_ecriture_test.py.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/fil_test.py"
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

from noah import auth, coordination, db, hermes, main, push, relay, taches  # noqa: E402
main._today = lambda: ""

db.init()
owner = auth.create_user("alice", "motdepasse-a")
stranger = auth.create_user("bruno", "motdepasse-b")
AGENTS = {"a": "Alma", "b": "Basile"}
with db.connect() as c:
    for agent_id, name in AGENTS.items():
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, owner))
MAINS = {a: main._new_conversation(owner, a, "Conversation", main=True) for a in AGENTS}

runs: list[dict] = []


async def fake_start(agent, text, session_id):
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
coordination.FREE_POLL = 0.01


def finish(run: dict, text="C'est fait.", status="completed"):
    if text:
        run["events"].put_nowait(("message.delta", {"delta": text}))
    run["events"].put_nowait((f"run.{status}", {"error": "panne"} if status != "completed" else {}))


async def settle():
    for _ in range(60):
        await asyncio.sleep(0.005)


def run_for(agent: str) -> dict:
    return [r for r in runs if r["agent"] == agent][-1]


transport = httpx.ASGITransport(app=main.app)


def client(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, base_url="http://noah.test", headers={"Authorization": f"Bearer {token}"})


def as_user(user: int) -> httpx.AsyncClient:
    return client(auth.new_session(user, "test", "web"))


def as_agent(agent: str) -> httpx.AsyncClient:
    return client(relay.token_for(agent))


def lines(text: str) -> list[str]:
    return [l for l in text.splitlines() if l.strip()]


LONG = ("Voici le rapport de ventes du trimestre : les ventes montent de quatre pour cent par rapport au trimestre précédent, "
        "portées par les abonnements annuels.\n\n- Premier risque : la dépendance à un seul canal d'acquisition, qui concentre "
        "soixante pour cent des nouveaux clients.\n- Deuxième risque : le délai de livraison, passé de deux à cinq jours.\n"
        "- Troisième risque : le taux de désabonnement, en hausse depuis mars.\n\nJe peux détailler chacun si tu veux.")


async def test_demande():
    # 1. Une demande entre deux agents : aucune conversation ne s'ajoute à la liste, la tâche est là, le fil du demandeur reçoit trois lignes.
    async with as_agent("a") as h:
        r = await h.post("/agent-api/demander", json={"agent": "b", "consigne": "Résume le rapport de ventes"})
    assert r.status_code == 200, r.text
    with db.connect() as c:
        conv = c.execute("SELECT conversation_id FROM delegations WHERE id = ?", (r.json()["id"],)).fetchone()["conversation_id"]
    finish(run_for("b"), LONG)
    await settle()
    finish(run_for("a"))
    await settle()

    async with as_user(owner) as h:
        for agent in ("a", "b"):
            listed = (await h.get(f"/api/agents/{agent}/conversations")).json()
            assert [x["id"] for x in listed] == [MAINS[agent]], f"{agent} : seul le fil est listé, trouvé {[x['title'] for x in listed]}"
            opened = (await h.get(f"/api/agents/{agent}/ouverture")).json()
            assert [x["id"] for x in opened["conversations"]] == [MAINS[agent]], opened["conversations"]
        ouvert = (await h.get("/api/agents/b/ouverture")).json()
    assert [t["conversation_id"] for t in ouvert["fil"]["taches"]] == [conv], ouvert["fil"]["taches"]
    tache = ouvert["fil"]["taches"][0]
    assert tache["etat"] == "fini" and tache["demandeur"]["nom"] == "Alma" and tache["resume"], tache
    assert tache["agent"] == {"id": "b", "nom": "Basile"}, "la ligne nomme celui qui travaille (Basile), pas le demandeur (Alma)"

    with db.connect() as c:
        report = [dict(m) for m in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? AND role = 'agent' AND text LIKE '**Basile a fini%'", (MAINS["a"],))]
        detail = c.execute("SELECT text FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY id DESC LIMIT 1", (conv,)).fetchone()["text"]
    assert len(report) == 1, report
    got = lines(report[0]["text"])
    assert 1 <= len(got) <= 3, f"le compte rendu tient en trois lignes, trouvé {len(got)} : {got}"
    assert all(len(l) <= 200 for l in got) and "Troisième risque" not in report[0]["text"]
    assert detail == LONG, "le détail entier est dans la tâche"
    sent = [r for r in runs if r["agent"] == "a" and "Résultat de ta demande à Basile" in r["text"]]
    assert sent and "Troisième risque" in sent[-1]["text"], "l'agent demandeur, lui, reçoit le résultat complet"
    print(f"1. demande entre agents : aucune conversation listée, une tâche au fil de Basile, {len(got)} ligne(s) dans le fil d'Alma, détail dans la tâche")


async def test_actions():
    # 2. La ligne « Actions faites » compte dans les trois lignes.
    texte = coordination._compte_rendu("**Basile a fini.**", LONG, "\n\nActions faites : Cherche sur le web.")
    assert len(lines(texte)) == 3 and lines(texte)[-1] == "Actions faites : Cherche sur le web.", texte
    assert lines(coordination._compte_rendu("**Basile a fini.**", "", "")) == ["**Basile a fini.**"]
    assert lines(coordination._compte_rendu("**Basile a fini.**", "Fait.", "")) == ["**Basile a fini.** Fait."]
    assert len(taches.trois_lignes("a " * 400)) <= 3 and taches.trois_lignes("a " * 400)[-1].endswith("…")
    assert taches.trois_lignes("```\ncode\n```\nMEDIA:/x.png") == []
    print("2. compte rendu : en-tête fusionné avec la première ligne, « Actions faites » comptée, coupe marquée « … »")


async def test_redemarrage():
    # 3. Au démarrage, un fil, une sous-tâche ou une routine encore « en cours » est coupé : échec, avec son résumé. Une demande et une
    #    initiative gardent leur propre rattrapage (coordination.recover, proactif.recover).
    ids = {}
    for genre in ("fil", "sous_tache", "routine", "demande", "initiative", "discussion"):
        conv = main._new_conversation(owner, "a", f"Travail {genre}", origin="agent")
        ids[genre] = (conv, taches.creer(conv, genre, titre=f"Travail {genre}", consigne="x", etat="encours" if genre != "discussion" else "fini"))
    n = taches.redemarrage()
    assert n == 3, n

    def etat(genre):
        with db.connect() as c:
            return dict(c.execute("SELECT etat, resume, fini_a FROM taches WHERE id = ?", (ids[genre][1],)).fetchone())

    for genre in ("fil", "sous_tache", "routine"):
        t = etat(genre)
        assert t["etat"] == "echec" and t["resume"] == "Noah a redémarré pendant le travail" and t["fini_a"] is not None, (genre, t)
    assert etat("demande")["etat"] == "encours" and etat("initiative")["etat"] == "encours" and etat("discussion")["etat"] == "fini"
    assert taches.redemarrage() == 0, "rejouable"
    print("3. redémarrage : fil, sous-tâche et routine coupés passent en échec « Noah a redémarré pendant le travail », le reste ne bouge pas")


async def test_discussion_vide():
    # 4. Une « Nouvelle discussion » sans aucun message n'est pas une tâche ; au premier message elle en devient une, et prend son titre.
    async with as_user(owner) as h:
        conv = (await h.post("/api/agents/a/conversations")).json()["id"]
        vide = (await h.get("/api/taches", params={"agent_id": "a"})).json()["taches"]
        assert conv not in [t["conversation_id"] for t in vide], vide
        ouvert = (await h.get("/api/agents/a/ouverture")).json()
        assert conv not in [t["conversation_id"] for t in ouvert["fil"]["taches"]]
        assert conv not in [x["id"] for x in ouvert["conversations"]], "une discussion de l'ancienne interface n'est plus listée non plus"
    stream = await main._run(hermes.Agent("a", "k"), conv, "Prépare le planning de la semaine prochaine")
    consume = asyncio.create_task(_drain(stream))
    await settle()
    finish(run_for("a"), "Voici le planning.")
    await consume
    async with as_user(owner) as h:
        lues = (await h.get("/api/taches", params={"agent_id": "a"})).json()["taches"]
    mine = [t for t in lues if t["conversation_id"] == conv]
    assert len(mine) == 1 and mine[0]["titre"] == "Prépare le planning de la semaine prochaine", mine
    print("4. nouvelle discussion vide : pas de tâche ; avec son premier message, une tâche titrée par ce message")


async def _drain(stream):
    async for _ in stream:
        pass


async def test_route():
    # 5. GET /api/taches : mêmes tâches, même forme que dans le fil ; filtre par état ; droits comme ouverture.
    async with as_user(owner) as h:
        ouvert = (await h.get("/api/agents/b/ouverture")).json()["fil"]["taches"]
        toutes = (await h.get("/api/taches", params={"agent_id": "b"})).json()["taches"]
        assert toutes == ouvert, f"la même tâche se lit du fil et d'Activité\n fil : {ouvert}\n route : {toutes}"
        assert [t["id"] for t in (await h.get("/api/taches", params={"agent_id": "b", "etat": "fini"})).json()["taches"]] == [t["id"] for t in ouvert]
        assert (await h.get("/api/taches", params={"agent_id": "b", "etat": "echec"})).json()["taches"] == []
        assert (await h.get("/api/taches", params={"agent_id": "b", "limite": 1})).json()["taches"] == ouvert[:1]
        assert (await h.get("/api/taches")).status_code == 422, "sans agent"
    async with as_user(stranger) as h:
        r = await h.get("/api/taches", params={"agent_id": "b"})
        assert r.status_code in (403, 404), r.status_code
    async with client("jeton-inconnu") as h:
        assert (await h.get("/api/taches", params={"agent_id": "b"})).status_code in (401, 403)
    print("5. GET /api/taches : les mêmes lignes que le fil, filtre d'état, refusée à un compte sans droit")


async def main_():
    await test_demande()
    await test_actions()
    await test_redemarrage()
    await test_discussion_vide()
    await test_route()
    print("OK : fil_test")


asyncio.run(main_())
