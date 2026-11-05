"""Écrire à l'agent pendant qu'il travaille : réponse tout de suite, précision transmise, ou demande à la suite, sans jamais perdre le message.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/voice/pendant_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from apollo import access, auth, db, events, hermes, main, media, pendant  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
pendant.POLL = 0.02
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
steered: list[tuple[str, str]] = []
started: list[str] = []
triaged: list[dict] = []
next_triage: dict | Exception = {"type": "tache", "reponse": ""}
steer_fails = [False]


async def triage(agent_id, name, role, text, history, doing):
    triaged.append({"text": text, "history": history, "doing": doing})
    if isinstance(next_triage, Exception):
        raise next_triage
    return next_triage


async def steer_run(agent, run_id, text):
    if steer_fails[0]:
        raise httpx.ConnectError("run fini")
    steered.append((run_id, text))


async def start_run(agent, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    yield "run.completed", {"output": f"Fait : {started[-1]}"}


async def online(*a, **k):
    return True


media.triage = triage
hermes.steer_run = steer_run
hermes.start_run = start_run
hermes.run_events = run_events
hermes.health = online
counter = [0]


def rows(conversation=conv):
    with db.connect() as c:
        return [(r["role"], r["text"]) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id", (conversation,))]


def pending():
    return [r["text"] for r in pendant.waiting(conv)]


async def say(text, user=alice, client_id=None, conversation=conv, agent="a1", choix=None, attachments=()):
    counter[0] += 1
    return await main.chat_while_busy(main.WhileBusy(agent_id=agent, text=text, conversation_id=conversation, client_id=client_id or f"essai-{counter[0]:04d}", choix=choix, attachments=list(attachments)), user=user)


def pending_id(text):
    return next(r["id"].split(":", 1)[1] for r in pendant.waiting(conv) if r["text"] == text)


async def drained():
    for _ in range(200):
        await asyncio.sleep(0.02)
        if not any(not t.done() for t in pendant._drains.values()):
            return
    raise AssertionError("la file ne se vide pas")


def working(run="run-en-cours"):
    main.task_state[conv] = "work"
    main.task_activity[conv] = "Lit rapport.pdf"
    main._runs[run] = {"agent": "a1", "user": alice, "conv": conv, "profil": None}


def finished(run="run-en-cours"):
    main.task_state[conv] = "done"
    main._runs.pop(run, None)


async def everything():
    global next_triage
    working()

    # 1. Une question : elle a sa réponse tout de suite, et le travail n'est pas touché.
    next_triage = {"type": "question", "reponse": "Je lis le rapport, encore une minute."}
    r = await say("Tu en es où ?")
    assert r["type"] == "question" and r["reponse"].startswith("Je lis"), r
    assert not steered and not started and not pending()
    assert rows()[-2:] == [("user", "Tu en es où ?"), ("agent", "Je lis le rapport, encore une minute.")], rows()
    assert triaged[-1]["doing"] == "Lit rapport.pdf", "le tri sait ce que fait l'agent"
    print("1. question : réponse tout de suite, travail intact")

    # 2. Le prochain tour de l'agent sait ce qui s'est dit.
    assert "Tu en es où" in main.machine.pop_context(conv)
    print("2. l'agent saura ce qui a été répondu pendant qu'il travaillait")

    # 3. Une précision : glissée dans le run en cours.
    next_triage = {"type": "precision", "reponse": "Compris, je lui passe."}
    r = await say("Plutôt en anglais")
    assert r["type"] == "precision" and steered[-1] == ("run-en-cours", "Plutôt en anglais"), (r, steered)
    assert rows()[-1] == ("user", "Plutôt en anglais") and not pending()
    print("3. précision : transmise au run en cours, sans l'interrompre")

    # 4. La transmission échoue : rien n'est perdu.
    steer_fails[0] = True
    r = await say("Et ajoute un titre")
    steer_fails[0] = False
    assert r["type"] == "tache" and pending() == ["Et ajoute un titre"], (r, pending())
    print("4. transmission impossible : elle attend son tour")

    # 5. Le tri est en panne : le message attend aussi, et la personne ne voit pas d'erreur.
    next_triage = media.MediaError("pas de modèle rapide")
    r = await say("Le tri est en panne")
    assert r["type"] == "tache" and pending()[-1] == "Le tri est en panne", r
    print("5. tri indisponible : à la suite, jamais perdu")

    # 6. Une demande retransmise n'en fait qu'une, même si la réponse s'est perdue.
    next_triage = {"type": "tache", "reponse": "Je le fais après."}
    before = len(triaged)
    first = await say("Fais aussi le résumé", client_id="retransmis-1")
    again = await say("Fais aussi le résumé", client_id="retransmis-1")
    assert first == again and len(triaged) == before + 1 and pending().count("Fais aussi le résumé") == 1, (first, again, pending())
    print("6. même envoi retransmis : une seule demande")

    # 7. Corriger le tri : « maintenant » et « retirer ».
    await main.request_now("retransmis-1", user=alice)
    assert steered[-1][1] == "Fais aussi le résumé" and "Fais aussi le résumé" not in pending()
    assert rows()[-1] == ("user", "Fais aussi le résumé")
    await say("À retirer", client_id="a-retirer-1")
    assert "À retirer" in pending()
    assert main.request_cancel("a-retirer-1", user=alice)["ok"] and "À retirer" not in pending()
    assert not main.request_cancel("a-retirer-1", user=alice)["ok"], "déjà retirée"
    for call in (main.request_cancel, ):
        try:
            call("retransmis-1", user=bruno)
        except main.HTTPException as e:
            assert e.status_code == 404
        else:
            raise AssertionError("la demande d'un autre compte a été trouvée")
    print("7. la personne corrige le tri : maintenant, ou retirer ; pas celles d'un autre")

    # 8. Rien ne part par-dessus le travail ; puis tout part dans l'ordre, chacune après la précédente.
    assert not started
    now = main.conversation_now(conv, user=alice)
    assert now["occupe"] and now["activite"] == "Lit rapport.pdf" and now["run_id"] == "run-en-cours", now
    assert [i["text"] for i in now["file"]] == pending()
    expected = pending()
    assert len(expected) == 2, expected
    finished()
    await drained()
    assert started == expected, started
    assert main.conversation_now(conv, user=alice)["file"] == []
    print("8. à la fin du travail, les demandes partent dans l'ordre, une à la fois")

    # 9. Agent libre : la demande part tout de suite, sans passer par le tri.
    before = len(triaged)
    r = await say("Agent libre")
    await drained()
    assert r["type"] == "tache" and started[-1] == "Agent libre" and len(triaged) == before, r
    print("9. agent libre : elle part tout de suite")

    # 10. Un redémarrage ne perd rien, pas même un tri coupé en plein vol.
    working()
    assert pendant.add("1:coupe-en-vol", conv, "a1", alice, "Tri coupé", pendant.TRI)
    assert pendant.add("1:en-attente", conv, "a1", alice, "Déjà en file")
    pendant._drains.clear()
    pendant.resume()
    assert pending() == ["Tri coupé", "Déjà en file"], pending()
    finished()
    await drained()
    assert started[-2:] == ["Tri coupé", "Déjà en file"], started
    print("10. redémarrage : ce qui attendait repart")

    # 11. Accès retiré pendant l'attente : la demande ne part pas.
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Autre', '', 'k', ?)", (alice,))
    other = main._new_conversation(bruno, "a2", "Partagée")
    was = len(started)
    allowed = access.allowed
    main.access.allowed = lambda user, agent, droit="usage": user != bruno and allowed(user, agent, droit)
    assert pendant.add("2:revoque", other, "a2", bruno, "Ne doit pas partir")
    pendant.start("a2", other)
    await drained()
    main.access.allowed = allowed
    assert len(started) == was and rows(other) == [], (started, rows(other))
    assert pendant.get("2:revoque")["status"] == pendant.CANCELLED
    print("11. accès retiré : la demande en attente ne part pas")

    # 12. Trop longtemps occupé : écrit et dit.
    working()
    pendant.WAIT = 0.05
    assert pendant.add("1:trop-tard", conv, "a1", alice, "Trop tard")
    pendant.start("a1", conv)
    await drained()
    pendant.WAIT = 86400
    assert rows()[-2] == ("user", "Trop tard") and rows()[-1][0] == "error", rows()[-2:]
    finished()
    print("12. occupé trop longtemps : la demande et l'échec restent écrits")

    # 12 ter. Revue Codex : chaque scénario de perte, de doublon ou de droit.
    # La demande prise, mais pas encore chez l'agent, repart après un redémarrage, sans doubler son message.
    was = len(started)
    assert pendant.add("1:prise", conv, "a1", alice, "Prise puis coupure")
    assert pendant.take("1:prise")
    main._save_message(conv, "user", "Prise puis coupure")
    pendant._drains.clear()
    pendant.resume()
    await drained()
    assert started[-1].endswith("Prise puis coupure") and len(started) == was + 1, started[was:]
    assert rows().count(("user", "Prise puis coupure")) == 1, "son message est doublé"
    assert pendant.get("1:prise")["status"] == pendant.DONE

    # Réponse de Hermes perdue : la précision ne repart pas à la suite, et la personne le sait.
    working()
    next_triage = {"type": "precision", "reponse": "Je lui passe."}

    async def lost_answer(agent, run_id, text):
        steered.append((run_id, text))
        raise httpx.ReadTimeout("réponse perdue")

    hermes.steer_run = lost_answer
    was_steered = len(steered)
    r = await say("Précision sans réponse")
    hermes.steer_run = steer_run
    assert r["type"] == "precision" and "ne sais pas" in r["reponse"], r
    assert len(steered) == was_steered + 1 and "Précision sans réponse" not in pending(), pending()

    # Redémarrage pendant la transmission : elle n'est pas rejouée, et c'est dit.
    assert pendant.add("1:coupee", conv, "a1", alice, "Transmission coupée", pendant.SENDING)
    pendant._drains.clear()
    pendant.resume()
    assert "Transmission coupée" not in pending() and rows()[-2:] == [("user", "Transmission coupée"), ("agent", main.UNSURE_STEER)], rows()[-2:]

    # Accès retiré pendant le tri : rien n'est transmis.
    gate = asyncio.Event()

    async def slow_triage(*a):
        await gate.wait()
        return {"type": "precision", "reponse": "x"}

    media.triage = slow_triage
    allowed_before = access.allowed
    was_steered = len(steered)
    task = asyncio.create_task(say("Pendant le retrait", client_id="retrait-01"))
    await asyncio.sleep(0.02)
    main.access.allowed = lambda user, agent, droit="usage": False
    gate.set()
    try:
        await task
    except main.HTTPException as e:
        assert e.status_code == 404
    else:
        raise AssertionError("transmise après le retrait de l'accès")
    main.access.allowed = allowed_before
    assert len(steered) == was_steered and pendant.get(f"{alice}:retrait-01")["status"] == pendant.CANCELLED
    media.triage = triage

    # Droits changés depuis le départ du run : la précision attend et repartira avec les bons droits.
    was_steered = len(steered)
    main._runs["run-en-cours"]["profil"] = "autre-profil"
    r = await say("Après le changement de droits")
    main._runs["run-en-cours"]["profil"] = None
    assert r["type"] == "tache" and len(steered) == was_steered and "Après le changement de droits" in pending(), r
    main.request_cancel(pending_id("Après le changement de droits"), user=alice)

    # Retirée, elle ne ressuscite pas ; deux clics « maintenant » ne font qu'une transmission.
    await say("Retirée puis maintenant", client_id="retiree-01", choix="tache")
    assert main.request_cancel("retiree-01", user=alice)["ok"]
    was_steered = len(steered)
    assert (await main.request_now("retiree-01", user=alice))["type"] == "deja" and len(steered) == was_steered
    await say("Deux clics", client_id="deux-clics", choix="tache")
    first, second = await asyncio.gather(main.request_now("deux-clics", user=alice), main.request_now("deux-clics", user=alice))
    assert sorted((first["type"], second["type"])) == ["deja", "precision"] and len(steered) == was_steered + 1, (first, second)

    # Une question, transmise deux fois de suite : une seule. Et après la fin du run, elle part à la suite.
    next_triage = {"type": "question", "reponse": "Réponse."}
    await say("Question à transmettre", client_id="question-01")
    was_steered = len(steered)
    assert (await main.request_now("question-01", user=alice))["type"] == "precision"
    assert (await main.request_now("question-01", user=alice))["type"] == "deja" and len(steered) == was_steered + 1
    await say("Question après la fin", client_id="question-02")
    finished()
    was = len(started)
    assert (await main.request_now("question-02", user=alice))["type"] == "tache"
    await drained()
    assert started[-1].endswith("Question après la fin") and len(started) == was + 1, started[was:]

    # L'ordre : une demande encore au tri retient les suivantes.
    working()
    assert pendant.add("1:premiere", conv, "a1", alice, "Première", pendant.TRI)
    assert pendant.add("1:seconde", conv, "a1", alice, "Seconde")
    finished()
    pendant.start("a1", conv)
    was = len(started)
    await asyncio.sleep(0.1)
    assert len(started) == was, "la seconde est passée devant"
    pendant.settle("1:premiere", pendant.WAITING)
    await drained()
    assert [s.splitlines()[-1] for s in started[was:]] == ["Première", "Seconde"], started[was:]

    # Un accord attendu se voit sans le flux, et seulement chez l'auteur.
    working()
    main.task_approval[conv] = {"summary": "Supprimer ?", "request_id": "r1", "generation": 1, "run_id": "run-en-cours"}
    assert main.conversation_now(conv, user=alice)["accord"]["request_id"] == "r1"
    main.task_approval.pop(conv)
    finished()

    # Pièces jointes : même traitement que /api/chat.
    await say("Avec un fichier", client_id="fichier-01", choix="tache", attachments=["/opt/data/workspace/uploads/a.pdf", "/opt/data/.env"])
    row = pendant.get(f"{alice}:fichier-01")
    assert "uploads/a.pdf" in row["text"] and ".env" not in row["text"], row["text"]
    await drained()
    print("12 ter. perte, doublon, droits, ordre, accord, pièces jointes : tenus")

    # 12 bis. Au démarrage, rien ne part avant de savoir si une mise à jour est ouverte.
    from apollo import updates

    was = len(started)
    assert pendant.add("1:apres-maj", conv, "a1", alice, "Pas pendant la mise à jour")

    async def follow():
        updates.maintenance = True

    updates._follow = follow
    pendant._drains.clear()
    await main._resume_requests()
    await asyncio.sleep(0.15)
    assert len(started) == was, "elle est partie pendant la mise à jour"
    updates.maintenance = False
    await drained()
    assert started[-1].endswith("Pas pendant la mise à jour"), started[-1]
    print("12 bis. redémarrage en pleine mise à jour : la file attend")

    # 13. Droits de /api/chat.
    for user, agent, conversation in ((bruno, "a1", conv), (alice, "absent", conv), (alice, "a1", "autre")):
        try:
            await say("Non", user, None, conversation, agent)
        except main.HTTPException as e:
            assert e.status_code in (403, 404), e.status_code
            continue
        raise AssertionError(f"accepté : {user} {agent} {conversation}")
    print("13. mêmes droits que /api/chat")

    # 14. Deux premiers messages d'un invité en même temps : le profil n'est préparé qu'une fois.
    prepared: list[str] = []

    async def prepare_guest(agent_id, profile):
        prepared.append(profile)
        await asyncio.sleep(0.05)

    hermes.prepare_guest = prepare_guest
    separated, guest_profile = access.separated, access.guest_profile
    main.access.separated, main.access.guest_profile = (lambda u, a: True), (lambda u: "p2")
    agent = main._agent("a1")
    await asyncio.gather(main._guest_agent(agent, bruno), main._guest_agent(agent, bruno))
    main.access.separated, main.access.guest_profile = separated, guest_profile
    assert prepared == ["p2"], prepared
    print("14. profil invité : préparé une seule fois")

    # 14 bis. Un tour d'appel renvoyé après une coupure : un seul travail, même si le premier envoi était arrivé.
    finished()
    await drained()

    async def turn(client_id, text="Une seule fois"):
        http = main.Request({"type": "http", "headers": []})
        response = await main.chat(main.ChatMessage(agent_id="a1", text=text, conversation_id=conv, client_id=client_id), http, None, user=alice)
        return "".join([chunk async for chunk in response.body_iterator])

    times = lambda text: (sum(s.endswith(text) for s in started), rows().count(("user", text)))  # noqa: E731
    first = await turn("tour-appel-1")
    assert '"start"' in first and "Fait :" in first, first
    assert times("Une seule fois") == (1, 1), times("Une seule fois")
    again = await turn("tour-appel-1")
    assert '"deja"' in again and conv in again, again
    assert times("Une seule fois") == (1, 1), times("Une seule fois")
    print("14 bis. /api/chat : le même identifiant ne relance rien, et l'écran sait qu'il faut recharger")

    # Le même tour peut aussi revenir par la route du travail en cours, si l'agent travaille à ce moment-là.
    working()
    known = await say("Une seule fois", client_id="tour-appel-1")
    assert known["type"] == "tache" and not pending(), (known, pending())
    finished()
    assert times("Une seule fois") == (1, 1), times("Une seule fois")
    print("14 ter. un tour déjà reçu ne revient pas par /api/chat/pendant")

    # Un envoi qui n'a rien lancé ne bloque pas son identifiant : renvoyé, il part.
    real_start = hermes.start_run

    async def down(agent, text, session_id):
        raise httpx.ConnectError("agent arrêté")

    hermes.start_run = down
    try:
        await turn("tour-appel-2", "Après la panne")
        raise AssertionError("l'échec de démarrage doit se dire")
    except main.HTTPException as e:
        assert e.status_code == 503, e.status_code
    hermes.start_run = real_start
    assert '"deja"' not in await turn("tour-appel-2", "Après la panne")
    assert sum(s.endswith("Après la panne") for s in started) == 1, started
    print("14 quater. un envoi qui n'a rien lancé peut repartir")

    # 14 quinquies. L'appel garde ses demandes à la suite (il en lit le résultat) : seule une précision part au travail.
    async def from_call(text, client_id):
        return await main.chat_while_busy(main.WhileBusy(agent_id="a1", text=text, conversation_id=conv, client_id=client_id, garder=True), user=alice)

    working()
    steered.clear()
    next_triage = {"type": "tache", "reponse": ""}
    kept = await from_call("Fais aussi un résumé", "appel-tache-1")
    assert kept["type"] == "tache" and not pending() and pendant.get(f"{alice}:appel-tache-1") is None, (kept, pending())
    await main.chat_after(main.LaterMessage(agent_id="a1", text="Fais aussi un résumé", conversation_id=conv, client_id="appel-tache-1"), user=alice)
    assert pending() == ["Fais aussi un résumé"], "raccroché ensuite : le même identifiant doit encore pouvoir partir"
    assert pendant.take(f"{alice}:appel-tache-1")
    next_triage = {"type": "precision", "reponse": ""}
    sent = await from_call("Plutôt en anglais", "appel-precision-1")
    assert sent["type"] == "precision" and [t for _, t in steered] == ["Plutôt en anglais"], (sent, steered)
    assert (await from_call("Plutôt en anglais", "appel-precision-1"))["type"] == "precision"
    assert [t for _, t in steered] == ["Plutôt en anglais"], "une retransmission ne repasse pas la précision"
    finished()
    print("14 quinquies. depuis l'appel : la précision part, une fois ; la demande à la suite reste à l'appel")


asyncio.run(everything())

# 15. La ligne de travail dit ce qu'il fait, tirée des arguments, sans jargon ni secret.
said = lambda tool, **args: events.translate("tool.started", {"tool": tool, "args": args}, False)["label"]  # noqa: E731
assert said("web_search", query="prix du cuivre") == "Cherche « prix du cuivre »"
assert said("browser_navigate", url="https://www.example.com/a/b") == "Ouvre example.com"
assert said("read_file", path="/opt/data/workspace/rapport.pdf") == "Lit rapport.pdf"
assert said("write_file", path="outputs/x.html") == "Écrit x.html"
assert said("terminal", command="npm install three") == "Installe des dépendances"
assert said("terminal", command="python3 /opt/data/noah.py image 'un lion'") == "Crée une image"
assert said("terminal", command="git clone https://x.y/z") == "Récupère un dépôt"
assert said("delegate_task", goal="Vérifier les chiffres") == "Confie à un sous-agent : Vérifier les chiffres"
assert said("mcp_notion_search", query="x") == "Utilise notion"
leak = said("terminal", command="deploy --token=sk-or-v1-abcdefghijklmnop")
assert "abcdefghijklmnop" not in leak, leak
assert said("terminal") and said("web_extract") and said("browser_click"), "sans argument : une phrase quand même"
for secret, command in (("VerySecret123", "deploy --password VerySecret123"), ("VerySecret123", "curl https://alice:VerySecret123@example.com/report"),
                        ("hunter2", "mysql -u root -phunter2"), ("hunter2", "deploy hunter2"), ("hunter2", "npm run hunter2"), ("hunter2", "python3 -c hunter2")):
    line = said("terminal", command=command)
    assert secret not in line, (command, line)
    assert "alice" not in line, line
assert said("terminal", command="curl https://alice:x@example.com/report") == "Télécharge depuis example.com"
assert said("browser_navigate", url="https://bob:pw@www.exemple.fr/x") == "Ouvre exemple.fr"
assert said("terminal", command="npm run build --flag") == "Lance : npm run build"
assert said("terminal", command="python3 /tmp/travail/calcul.py --key zzz") == "Lance : python3 calcul.py"
assert said("terminal", command="deploy --x") == "Lance : deploy"
leak = events.translate("tool.started", {"tool": "outil_inconnu", "preview": "--password VerySecret123"}, False)["label"]
assert "VerySecret" not in leak, leak
assert "Travaille sur ta demande" not in {said(t) for t in ("web_search", "read_file", "terminal", "memory", "un_outil_inconnu")}
print("15. activité : ce qu'il fait vraiment, jamais de secret")
print("OK")
