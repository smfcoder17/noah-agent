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


async def say(text, user=alice, client_id=None, conversation=conv, agent="a1", choix=None):
    counter[0] += 1
    return await main.chat_while_busy(main.WhileBusy(agent_id=agent, text=text, conversation_id=conversation, client_id=client_id or f"essai-{counter[0]:04d}", choix=choix), user=user)


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
