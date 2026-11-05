"""Un agent n'appelle pas par défaut, une tâche finie part en notification normale, et chaque compte règle ce qu'il reçoit.

Vraies routes, vrai `_run`, vraie base ; Hermes simulé, envois de notifications captés juste avant le service de push.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/push/preferences_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import access, auth, coordination, db, desktop, hermes, machine, main, notifications, pendant, push, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-alice")
bruno = auth.create_user("bruno", "motdepasse-bruno")
with db.connect() as c:
    c.execute("UPDATE users SET role = 'owner' WHERE id = ?", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Rita', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'usage')", (bruno,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
pendant.POLL = 0.02
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
guest_conv = main._new_conversation(bruno, "a1", "Conversation", main=True)
agent = main._agent("a1")

sent: list[dict] = []
natives: list[dict] = []


async def captured_send(title, text, url="/", urgent=False, user_id=None, session=None, extra=None):
    sent.append({"title": title, "text": text, "url": url, "urgent": urgent, "user": user_id, "extra": extra or {}})
    return {"livres": 1, "echecs": 0, "morts": 0, "differes": 0}


push.send = captured_send
desktop.send_native = lambda user, title, text: natives.append({"user": user, "title": title})
# Le rappel prépare la voix : hors sujet ici, et il sortirait vers un fournisseur.
coordination.precall.prepare = lambda *a, **k: None
coordination.RING_SECONDS = 3600

script: dict[str, list] = {"events": [("run.completed", {"output": "Rapport prêt. Le détail suit."})]}
release = asyncio.Event()
gate = [False]


async def start_run(a, text, session_id):
    return f"run-{len(sent)}-{id(text)}"


async def run_events(a, run_id):
    if gate[0]:
        await release.wait()
    for pair in script["events"]:
        yield pair


async def stop_run(a, run_id):
    pass


async def online(*a, **k):
    return True


hermes.start_run, hermes.run_events, hermes.stop_run, hermes.health = start_run, run_events, stop_run, online


async def same_agent(a, user):
    return a  # le profil Hermes d'un invité : préparé par le lanceur, absent ici


main._guest_agent = same_agent


def client(user: int) -> httpx.AsyncClient:
    token = auth.new_session(user)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://noah.test", headers={"Authorization": f"Bearer {token}"})


def agent_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://noah.test",
                             headers={"Authorization": f"Bearer {relay.token_for('a1')}"})


async def settled() -> None:
    while main._running_runs:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.02)  # les envois partent dans leur propre tâche


async def turn(conversation=conv, leave=True, after=0.0, read_all=False, **kw) -> None:
    """Un tour complet. `leave` : l'écran ferme son flux après le premier événement. Sinon il le lit jusqu'au bout."""
    gate[0], _ = True, release.clear()
    stream = await main._run(agent, conversation, "Fais le rapport", context="", tell_after=after, **kw)
    await stream.__anext__()
    if leave:
        await stream.aclose()
    release.set()
    if not leave:
        async for _ in stream:
            pass
    gate[0] = False
    await settled()


def rows(conversation=conv) -> list[tuple]:
    with db.connect() as c:
        return [(r["role"], r["text"]) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id", (conversation,))]


async def set_prefs(http, **body) -> dict:
    r = await http.put("/api/me/notifications", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def everything():
    a, b, tool = client(alice), client(bruno), agent_client()

    # 1. Le défaut : tout est actif, et l'agent n'appelle que si on le lui demande.
    now = (await a.get("/api/me/notifications")).json()
    assert now == {"rappels": "demande", "types": {k: True for k in notifications.KINDS}}, now
    assert main._speaker(alice, "a1") == main._who_speaks(alice, "a1"), "le défaut n'ajoute rien : le prompt reste en cache"
    assert "Par défaut, tu n'appelles pas" in main.CAPABILITIES and "s'il l'a demandé pour cette tâche" in main.CAPABILITIES
    assert "ça le mérite" not in main.CAPABILITIES
    assert "noah.py appeler" in main.CAPABILITIES, "appeler, l'étape à faire par l'humain, reste"
    print("1. défaut : tout actif, rappeler seulement sur demande, appeler inchangé")

    # 2. Réglages refusés, et un compte ne touche pas à ceux d'un autre.
    assert (await a.put("/api/me/notifications", json={"rappels": "toujours"})).status_code == 400
    assert (await a.put("/api/me/notifications", json={"types": {"securite": False}})).status_code == 400, "la sécurité ne se coupe pas"
    await set_prefs(b, rappels="jamais", types={"fin": False})
    assert (await a.get("/api/me/notifications")).json()["rappels"] == "demande"
    assert notifications.call_choice(bruno) == "jamais" and notifications.wants(alice, "fin") and not notifications.wants(bruno, "fin")
    await set_prefs(b, rappels="demande", types={"fin": True})
    print("2. un choix inconnu est refusé, la sécurité ne se coupe pas, chaque compte a ses réglages")

    # 3. « À la fin, appelle-moi » (J8) : au défaut, la commande fait sonner.
    r = await tool.post("/agent-api/rappel", json={"texte": "Le rapport est prêt."})
    assert r.status_code == 200, r.text
    await asyncio.sleep(0.02)
    assert [s["urgent"] for s in sent] == [True] and sent[0]["url"].startswith("/#appel=") and sent[0]["extra"]["type"] == "appels"
    notifications.take_reported("a1", alice)
    sent.clear()
    print("3. demandé : la commande sonne, comme avant")

    # 4. « Jamais » : imposé par le serveur. Rien ne sonne, le compte rendu reste écrit et part en notification normale.
    await set_prefs(a, rappels="jamais")
    assert "ne la rappelle jamais" in main._speaker(alice, "a1"), "l'agent le sait avant d'essayer"
    with db.connect() as c:
        before = c.execute("SELECT COUNT(*) AS n FROM voice_calls").fetchone()["n"]
    r = await tool.post("/agent-api/rappel", json={"texte": "Le devis est parti. Détails plus bas."})
    assert r.status_code == 403 and "ne réessaie pas" in r.json()["detail"], r.text
    await asyncio.sleep(0.02)
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM voice_calls").fetchone()["n"] == before, "aucun appel créé"
    assert rows()[-1] == ("agent", "Le devis est parti. Détails plus bas."), rows()[-1]
    assert len(sent) == 1 and not sent[0]["urgent"] and sent[0]["title"] == "Rita" and sent[0]["text"] == "Le devis est parti.", sent
    assert sent[0]["url"] == f"/#agent=a1&conversation={conv}" and sent[0]["extra"]["type"] == "fin"
    sent.clear()
    await turn()  # la fin de ce tour ne redit pas ce compte rendu
    assert not sent, sent
    print("4. jamais : refusé par le serveur, écrit, notification normale, et pas de doublon à la fin du tour")

    # 5. Couper le type « appels » revient au même, quel que soit l'autre choix ; « Quand c'est important » se dit à l'agent.
    await set_prefs(a, rappels="important", types={"appels": False})
    assert notifications.call_choice(alice) == "jamais"
    assert (await tool.post("/agent-api/rappel", json={"texte": "Fini."})).status_code == 403
    await set_prefs(a, types={"appels": True})
    assert "vraiment important" in main._speaker(alice, "a1")
    await set_prefs(a, rappels="demande")
    notifications.take_reported("a1", alice)
    sent.clear()
    print("5. type appels coupé = jamais ; « important » est dit à l'agent à chaque message")

    # 6. Une demande --rappeler entre agents sous « Jamais » : le rappel ne part pas, et l'agent le sait.
    await set_prefs(a, rappels="jamais")
    try:
        coordination._ring("a1", "Compte rendu", "", alice)
        raise AssertionError("aurait dû refuser")
    except main.HTTPException as e:
        assert e.status_code == 403
    await set_prefs(a, rappels="demande")
    print("6. --rappeler sous « Jamais » : refus lisible, rien ne sonne")

    # 7. Fin de tâche : personne ne suit, plus de 30 s (ici le seuil est à zéro).
    await turn()
    assert len(sent) == 1, sent
    n = sent[0]
    assert (n["title"], n["text"], n["urgent"], n["user"]) == ("Rita", "Rapport prêt.", False, alice), n
    assert n["url"] == f"/#agent=a1&conversation={conv}" and n["extra"]["type"] == "fin"
    assert natives and natives[-1]["user"] == alice, "l'application de bureau reçoit la même"
    sent.clear()
    print("7. tâche finie, écran parti : notification normale, nom de l'agent, première phrase, lien vers la conversation")

    # 8. Un flux ouvert : la personne regarde, rien ne part.
    await turn(leave=False)
    assert not sent, sent
    print("8. flux ouvert : pas de notification")

    # 9. Moins de 30 s : le seuil par défaut.
    assert notifications.TELL_AFTER == 30
    await turn(after=notifications.TELL_AFTER)
    assert not sent, sent
    print("9. moins de 30 s : pas de notification")

    # 10. Un échec aussi, avec la raison ; une tâche arrêtée par la personne, non.
    script["events"] = [("run.failed", {"error": "Le modèle a refusé la clé. Change-la."})]
    await turn()
    assert len(sent) == 1 and sent[0]["title"] == "Rita n'a pas pu finir" and not sent[0]["urgent"], sent
    sent.clear()
    script["events"] = [("run.cancelled", {})]
    await turn()
    assert not sent, sent
    script["events"] = [("run.completed", {"output": "Rapport prêt. Le détail suit."})]
    print("10. échec : notification avec le motif ; tâche arrêtée : rien")

    # 11. Le profil qui a lancé la tâche la reçoit, pas le propriétaire de l'agent.
    await turn(conversation=guest_conv)
    assert [s["user"] for s in sent] == [bruno] and guest_conv in sent[0]["url"], sent
    sent.clear()
    print("11. identité : la notification va au profil qui a lancé la tâche, seul")

    # 12. Un type coupé ne part plus, et seulement pour ce compte.
    await set_prefs(a, types={"fin": False})
    natives.clear()
    await turn()
    assert not sent and not natives, sent
    await turn(conversation=guest_conv)
    assert [s["user"] for s in sent] == [bruno], sent
    sent.clear()
    await set_prefs(a, types={"fin": True})
    print("12. fin de tâche coupée : rien sur aucun appareil de ce compte, un autre profil garde la sienne")

    # 13. Une demande en file : aucun flux ne la suit.
    script["events"] = [("run.completed", {"output": "Fait à la suite."})]
    r = await a.post("/api/chat/pendant", json={"agent_id": "a1", "text": "Ensuite ceci", "client_id": "bulle-essai-1", "conversation_id": conv})
    assert r.status_code == 200 and r.json()["type"] == "tache", r.text
    # Le seuil vaut 30 s : ce tour est instantané, donc silencieux. Il suit le chemin réel sans flux.
    while pendant._drains and not all(t.done() for t in pendant._drains.values()):
        await asyncio.sleep(0.01)
    await settled()
    assert ("agent", "Fait à la suite.") in rows() and not sent, sent
    original, notifications.TELL_AFTER = notifications.TELL_AFTER, 0
    stream = await main._run(agent, conv, "Sans écran", live=False, tell_after=0)
    async for _ in stream:
        pass
    await settled()
    notifications.TELL_AFTER = original
    assert len(sent) == 1 and sent[0]["text"] == "Fait à la suite.", sent
    sent.clear()
    print("13. tour sans écran (demande en file, relance) : notifié dès qu'il dépasse le seuil")

    # 14. L'écran passe derrière : le flux reste ouvert sans lecteur, la notification part. De retour, non.
    assert (await a.post(f"/api/conversations/{conv}/regard", json={"visible": False})).status_code == 200
    await turn(leave=False)
    assert len(sent) == 1, sent
    sent.clear()
    assert (await a.post(f"/api/conversations/{conv}/regard", json={"visible": True})).status_code == 200
    await turn(leave=False)
    assert not sent, sent
    assert (await b.post(f"/api/conversations/{conv}/regard", json={"visible": False})).status_code == 404, "la conversation d'un autre"
    # Elle regardait il y a une seconde, puis elle quitte l'app : le dernier relevé ne compte plus.
    assert (await a.get(f"/api/conversations/{conv}/en-cours")).status_code == 200
    assert (await a.post(f"/api/conversations/{conv}/regard", json={"visible": False})).status_code == 200
    await turn()
    assert len(sent) == 1, sent
    sent.clear()
    assert (await a.post(f"/api/conversations/{conv}/regard", json={"visible": True})).status_code == 200
    print("14. écran caché : notifié malgré le flux ouvert ; visible : non ; l'écran d'un autre ne change rien")

    # 15. Un écran qui relève la conversation la suit, même sans flux. La bulle relève sans la suivre.
    assert (await a.get(f"/api/conversations/{conv}/en-cours")).status_code == 200
    await turn()
    assert not sent, sent
    notifications._seen.clear()
    assert (await a.get(f"/api/conversations/{conv}/en-cours", params={"suivi": "false"})).status_code == 200
    await turn()
    assert len(sent) == 1, sent
    sent.clear()
    print("15. écran qui relève la conversation : pas de notification ; relevé sans la suivre (bulle) : notification")

    # 16. Travail interne : le fil d'un agent et une demande entre agents ne notifient pas.
    thread = main._new_conversation(alice, "a1", "Fil", origin="agent")
    await turn(conversation=thread)
    assert not sent, sent
    print("16. fil ouvert par un agent : pas de notification (le résultat lui revient)")

    # 17. Un rappel pendant le tour : la fin ne redit rien, la tâche suivante si.
    gate[0], _ = True, release.clear()
    stream = await main._run(agent, conv, "Appelle-moi à la fin", tell_after=0)
    await stream.__anext__()
    await stream.aclose()
    assert (await tool.post("/agent-api/rappel", json={"texte": "C'est fait."})).status_code == 200
    release.set()
    gate[0] = False
    await settled()
    assert [s["urgent"] for s in sent] == [True], sent
    sent.clear()
    await turn()
    assert len(sent) == 1 and not sent[0]["urgent"], sent
    sent.clear()
    print("17. rappel pendant le tour : un seul message, puis la tâche suivante prévient de nouveau")

    # 18. Les types existants passent par le filtre : accord, plafond, veille. Un envoi sans type n'est pas filtré.
    await set_prefs(a, types={"accord": False, "plafond": False, "routines": False})
    push.notify("Noah attend ton accord", "x", user_id=alice, urgent=True, kind="accord")
    desktop.notify("Veille", "x", agent_id="a1", kind="routines")
    await asyncio.sleep(0.02)
    assert not sent, sent
    relay._warn_once("a1", "plafond100", 1.0, "Plafond", "Atteint")
    await asyncio.sleep(0.02)
    assert not sent, sent
    push.notify("Mise à jour", "x", user_id=alice)
    await asyncio.sleep(0.02)
    assert [s["title"] for s in sent] == ["Mise à jour"], sent
    sent.clear()
    await set_prefs(a, types={"accord": True, "plafond": True, "routines": True})
    print("18. accord, plafond et veille se coupent ; ce qui n'a pas de type passe")

    # 19. Sécurité : aucun réglage ne la coupe.
    await set_prefs(a, types={k: False for k in notifications.KINDS})
    from noah import appareils
    await appareils.announce({"user": alice, "nom": "Téléphone inconnu", "ip": "203.0.113.5", "reseau_connu": False, "cree": "2026-11-05T10:00:00+00:00", "id": "x"})
    assert [s["title"] for s in sent] == ["Nouvel appareil sur ton compte"], sent
    sent.clear()
    await set_prefs(a, types={k: True for k in notifications.KINDS})
    print("19. nouvel appareil : l'alerte part même avec tous les types coupés")

    # 20. Une routine : une notification normale à son propriétaire seul, coupable par son type.
    real_sleep = asyncio.sleep
    rounds = []

    async def one_round(seconds):
        rounds.append(seconds)
        if len(rounds) > 1:
            raise asyncio.CancelledError
        await real_sleep(0)

    async def fake_admin(agent_id, action, body=None, timeout=0):
        if agent_id != "a1":
            return {"sorties": []}
        return {"sorties": [{"nom": "Matin", "quand": f"t{len(rounds)}", "texte": "Trois messages importants. Le reste attend."}]}

    machine.admin, machine.asyncio.sleep = fake_admin, one_round
    try:
        await machine.deliver_routines(main._save_message, main._main_conversation)
    except asyncio.CancelledError:
        pass
    finally:
        machine.asyncio.sleep = real_sleep
    await real_sleep(0.02)
    assert len(sent) == 1 and sent[0]["user"] == alice and sent[0]["title"] == "Routine « Matin »" and not sent[0]["urgent"], sent
    assert sent[0]["text"] == "Trois messages importants." and sent[0]["extra"]["type"] == "routines"
    sent.clear()
    print("20. résultat de routine : notification normale chez son propriétaire")

    # 21. Le texte du bandeau : ni code, ni fichier, ni mise en forme.
    assert notifications.first_sentence("**Fini.** La suite") == "Fini."
    assert notifications.first_sentence("```noah\n{\"type\":\"table\"}\n```\nVoilà le tableau !") == "Voilà le tableau !"
    assert notifications.first_sentence("MEDIA:/opt/data/x.png") == "C'est fini : le résultat est dans la conversation."
    assert notifications.first_sentence("[Le rapport](https://x.test/secret) est prêt.") == "Le rapport est prêt."
    assert len(notifications.first_sentence("mot " * 200)) <= 180
    print("21. le bandeau : première phrase lisible, sans code ni fichier ni adresse")

    # 22. Un profil supprimé emporte ses réglages : son numéro peut resservir.
    await set_prefs(b, rappels="jamais")
    with db.connect() as c:
        c.execute("DELETE FROM users WHERE id = ?", (bruno,))
        assert not c.execute("SELECT 1 FROM notification_prefs WHERE user_id = ?", (bruno,)).fetchone()
    print("22. compte supprimé : ses réglages partent avec lui")

    for http in (a, b, tool):
        await http.aclose()


asyncio.run(everything())
print("OK : notifications et appels, réglés par compte")
