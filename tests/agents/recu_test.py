"""Le reçu : ce que l'agent dit, comparé à ce que ses outils ont fait. Vrai _run, vraie base ; Hermes est simulé.
Ce test prouve la comparaison et ce qu'elle laisse derrière elle, pas ce qu'un vrai run d'Hermes émet : à revoir sur un vrai tour.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/recu_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, machine, main, notifications, proactif, recu, watch  # noqa: E402

# --- Les phrases ----------------------------------------------------------------------------------------------------

MUST_COUNT = [
    ("J'ai envoyé le courriel à Marc.", "envoyer"),
    ("Je lui ai bien envoyé le devis ce soir.", "envoyer"),
    ("Je viens d'envoyer ta réponse à Paul.", "envoyer"),
    ("✅ Courriel envoyé à Marc", "envoyer"),
    ("**Message envoyé**", "envoyer"),
    ("C'est envoyé !", "envoyer"),
    ("Envoyé.", "envoyer"),
    ("J'ai répondu au courriel de Paul.", "envoyer"),
    ("Je t'ai envoyé le résumé par courriel.", "envoyer"),
    ("I've sent the email to Mark.", "envoyer"),
    ("J'ai publié ton article sur le blogue.", "publier"),
    ("C'est publié.", "publier"),
    ("J'ai supprimé les trois doublons de ta boîte.", "supprimer"),
    ("Je les ai archivés.", "supprimer"),
    ("J'ai réservé la table pour samedi.", "payer"),
    ("J'ai programmé un rappel pour demain matin.", "planifier"),
    ("J'ai créé le document de suivi.", "creer"),
    ("J'ai mis à jour ton agenda.", "modifier"),
    ("Je l'ai mémorisé.", "memoire"),
    ("C'est fait !", "fait"),
]
MUST_NOT_COUNT = [
    "Je n'ai pas envoyé le courriel.",
    "J'ai pas envoyé le courriel.",
    "Je ne lui ai rien envoyé.",
    "Veux-tu que j'envoie le courriel ?",
    "Est-ce que j'ai envoyé le bon fichier ?",
    "Je vais publier ton article demain.",
    "J'ai préparé un brouillon de réponse.",
    "Si j'ai envoyé la mauvaise version, dis-le-moi.",
    "Quand j'ai supprimé un fichier, il va à la corbeille.",
    "Marc écrit : j'ai envoyé le paiement hier.",
    "Le courriel envoyé par ta banque parle d'une hausse.",
    "Il dit « j'ai envoyé le dossier » dans son message.",
    "> J'ai envoyé le dossier",
    "```\nj'ai envoyé\n```",
    "Je t'ai envoyé l'image ci-dessus.",
    "Je t'ai envoyé le résumé.",
    "J'ai ajouté une section ci-dessous.",
    "J'ai changé la tournure de ta phrase.",
    "J'ai corrigé deux fautes.",
    "J'ai planifié ta semaine en trois idées.",
    "C'est réservé aux membres.",
    "J'ai lu ton courriel.",
    "Tes billets sont envoyés par la poste, selon le site.",
]
for sentence, family in MUST_COUNT:
    got = [c["famille"] for c in recu.claims_in(sentence)]
    assert family in got, f"à compter : {sentence} -> {got}"
for sentence in MUST_NOT_COUNT:
    got = recu.claims_in(sentence)
    assert not got, f"à ne pas compter : {sentence} -> {got}"
print(f"1. {len(MUST_COUNT)} affirmations comptées, {len(MUST_NOT_COUNT)} phrases voisines laissées de côté")

for tool, args, family in [
    ("mcp_gmail_send_message", {}, "envoyer"), ("mcp_gmail_list_messages", {}, "lecture"), ("mcp_gmail_delete_message", {}, "supprimer"), ("mcp_shop_buy_item", {}, "payer"),
    ("mcp_tool_do_thing", {}, "generique"), ("mcp_post_office_list", {}, "generique"), ("send_message", {}, "envoyer"), ("web_search", {"query": "x"}, "lecture"),
    ("browser_click", {}, "generique"), ("browser_snapshot", {}, "lecture"), ("delegate_task", {}, "generique"), ("terminal", {"command": "ls -la"}, "lecture"),
    ("terminal", {"command": "curl -X POST https://x.test -d a=1"}, "generique"), ("terminal", {"command": "python3 /opt/data/noah.py notifier a b"}, "envoyer"),
    ("terminal", {}, "generique"), ("memory", {"action": "add"}, "memoire"), ("write_file", {"path": "/tmp/x"}, "creer"), ("outil_inconnu", {}, "generique"),
]:
    assert recu.classify(tool, args)[0] == family, f"{tool} {args} -> {recu.classify(tool, args)}"
print("2. un outil se range d'après son nom, et le doute reste un doute")


def ledger(*calls) -> recu.Ledger:
    book = recu.Ledger()
    for tool, end, *rest in calls:
        book.feed("tool.started", {"tool": tool, "args": rest[0] if rest else {}})
        if end:
            book.feed(end, {"tool": tool, **(rest[1] if len(rest) > 1 else {})})
    return book


def part(receipt: dict | None, key: str) -> list:
    """Une partie absente est un échec du test, pas une panne : le sabotage doit la voir."""
    assert receipt and receipt.get(key), f"{key} attendu : {receipt}"
    return receipt[key]


said = "J'ai envoyé le courriel à Marc."
assert part(recu.compare(said, ledger()), "sans_trace") == [said], "dit et aucun outil"
assert part(recu.compare(said, ledger(("web_search", "tool.completed", {"query": "marc"}))), "sans_trace") == [said], "une recherche n'envoie rien"
got = recu.compare(said, ledger(("mcp_gmail_send_message", "tool.completed")))
assert part(got, "prouve")[0]["par"] == "Gmail" and not recu.needs_attention(got), got
got = recu.compare(said, ledger(("mcp_gmail_send_message", "tool.failed")))
assert part(got, "echec")[0]["par"] == "Gmail" and recu.needs_attention(got), got
got = recu.compare(said, ledger(("mcp_gmail_send_message", "tool.completed", {}, {"preview": "Refusé : « gmail » demande la confirmation de l'utilisateur"})))
assert got.get("echec") and not got.get("prouve"), f"un refus dans le résultat n'est pas une preuve : {got}"
got = recu.compare(said, ledger(("mcp_gmail_send_message", "tool.completed", {}, {"error": True})))
assert got.get("echec"), got
got = recu.compare(said, ledger(("browser_click", "tool.completed")))
assert part(got, "incertain")[0]["par"] == "le navigateur" and not recu.needs_attention(got), "un clic a pu envoyer : non vérifiable, pas de fausse alerte"
got = recu.compare(said, ledger(("mcp_gmail_send_message", None)))
assert got.get("incertain") and not got.get("prouve"), f"lancé sans retour n'est pas une preuve : {got}"
assert part(recu.compare(said, ledger(), {"envoyer"}), "incertain")[0]["par"] == "un tour précédent"  # même genre d'action, pas forcément la même
assert not recu.compare(said, ledger(), {"envoyer"}).get("prouve")
assert "envoyer" not in recu.compare("Hier, j'ai envoyé le courriel.", ledger())["fait"]
assert part(recu.compare("Hier, j'ai envoyé le courriel.", ledger()), "incertain"), "le passé lointain n'accuse pas"
print("3. dit et pas fait : aucune trace, échec, refus, non vérifiable, tour précédent")

assert part(recu.compare("C'est fait !", ledger()), "sans_trace"), "« c'est fait » sans aucun outil"
assert part(recu.compare("C'est fait !", ledger(("web_search", "tool.completed", {"query": "x"}))), "sans_trace"), "lire n'est pas faire"
assert not recu.compare("C'est fait !", ledger(("mcp_x_update_item", "tool.completed"))).get("sans_trace")
assert not (recu.compare("C'est fait !", ledger(), {"creer"}) or {}).get("sans_trace"), "« c'est fait » peut parler du tour d'avant"
assert not recu.needs_attention(recu.compare("C'est fait, voici la traduction.", ledger())), "le résultat est dans la réponse"
print("4. « c'est fait » : il faut au moins une action, ici ou juste avant")

got = recu.compare("Voici le résumé de ta journée.", ledger(("mcp_gmail_send_message", "tool.completed")))
assert part(got, "non_dit") == ["a envoyé quelque chose avec Gmail"] and recu.needs_attention(got), got
got = recu.compare("Voici le résumé.", ledger(("mcp_gmail_delete_message", "tool.completed"), ("mcp_gmail_delete_thread", "tool.completed")))
assert part(got, "non_dit") == ["a supprimé quelque chose avec Gmail"], f"une seule ligne par geste : {got}"
assert not recu.compare("J'ai répondu à Marc par courriel.", ledger(("mcp_gmail_send_message", "tool.completed"))).get("non_dit")
assert recu.compare("Voici le résumé.", ledger(("mcp_gmail_send_message", "tool.failed"))) is None, "un échec n'est pas une action cachée"
assert not recu.compare("Voici le résumé.", ledger(("write_file", "tool.completed"))).get("non_dit"), "écrire un fichier à lui ne se voit pas dehors"
print("5. fait et pas dit : ce qui se voit dehors doit se dire")

assert recu.compare("Bonjour, voici ce que j'en pense.", ledger(("web_search", "tool.completed", {"query": "x"}))) is None, "rien à dire : pas de reçu"
print("6. une réponse ordinaire n'a pas de reçu")

# --- Dans un vrai tour ----------------------------------------------------------------------------------------------

db.init()
watch.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "cerveau-x")
db.set_setting("onboarded", "1")
A = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'test', 'web')}"})
script: list = []
started: list = []


async def start_run(agent, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    for pair in script:
        yield pair


async def healthy(*a, **k):
    return True


async def no_memory(*a, **k):
    return {"user": []}


hermes.start_run, hermes.run_events, hermes.health, machine.admin = start_run, run_events, healthy, no_memory
notified: list = []
main.desktop.notify_user = lambda *a, **k: notified.append(a)
conv = main._new_conversation(alice, "a1", "Conversation", main=True)


def say(text: str, *tools) -> list[tuple]:
    pairs: list[tuple] = []
    for tool, end in tools:
        pairs += [("tool.started", {"tool_name": tool, "args": {}, "preview": None}), (end, {"tool_name": tool, "args": {}, "preview": None})]  # ce qu'émet Hermes
    return [*pairs, ("message.delta", {"delta": text}), ("run.completed", {"output": ""})]


def turn(pairs: list[tuple], conv_id: str = conv, tell_after: float = notifications.TELL_AFTER) -> list[dict]:
    script[:] = pairs

    async def go():
        stream = await main._run(main._agent("a1"), conv_id, "fais-le", live=False, tell_after=tell_after)
        return [chunk async for chunk in stream]

    chunks = asyncio.run(go())
    return [json.loads(c.removeprefix("data:").strip()) for c in chunks if isinstance(c, str) and c.startswith("data:")]


def last_message(conv_id: str = conv) -> dict:
    return A.get(f"/api/conversations/{conv_id}/messages").json()[-1]


def journal() -> dict:
    return A.get("/api/agents/a1/activite").json()[0]


# Il prétend avoir envoyé sans avoir rien lancé.
events_seen = turn(say("J'ai envoyé le courriel à Marc."), tell_after=0)
done = next(e for e in events_seen if e["type"] == "done")
assert part(done["recu"], "sans_trace") == ["J'ai envoyé le courriel à Marc."], "l'écran le sait dès la fin du tour"
stored = json.loads(last_message()["detail"])
assert part(stored["recu"], "sans_trace") and stored["etapes"] == [], "le reçu reste avec le message, et l'écran lit le même champ que les étapes"
assert last_message()["text"] == "J'ai envoyé le courriel à Marc.", "sa réponse reste telle qu'il l'a écrite"
assert journal()["etat"] == "a_verifier", "l'Activité ne dit pas « Fait »"
print("7. dit et pas fait : le reçu arrive à l'écran, reste avec le message, et l'Activité dit « À vérifier »")

assert notified and notified[-1][2].startswith("À vérifier : J'ai envoyé"), f"sur le téléphone aussi : {notified[-1:]}"
print("8. la notification ne laisse pas croire que c'est fait")

context = machine.pop_context(conv)
assert "Aucun outil n'a fait ce que tu as écrit" in context and "J'ai envoyé le courriel à Marc" in context, context
print("9. l'agent le lit à son prochain message, sans appel au modèle")

# La vérité : l'outil a tourné.
turn(say("J'ai envoyé le courriel à Marc.", ("mcp_gmail_send_message", "tool.completed")))
stored = json.loads(last_message()["detail"])["recu"]
assert part(stored, "prouve")[0]["par"] == "Gmail" and stored["fait"] == ["envoyer"] and journal()["etat"] == "fait", stored
assert not machine.pop_context(conv), "tout colle : rien à lui dire"
print("10. dit et fait : vérifié, et l'Activité dit « Fait »")

# Il en reparle au tour suivant : ce qui a été prouvé reste prouvé.
turn(say("Oui, je l'ai envoyé à Marc."))
stored = json.loads(last_message()["detail"])["recu"]
assert part(stored, "incertain")[0]["par"] == "un tour précédent" and not recu.needs_attention(stored), stored
print("11. il reparle d'une action prouvée au tour d'avant : pas de fausse alerte")

# Échec.
turn(say("C'est publié.", ("mcp_blog_publish_post", "tool.failed")))
assert part(json.loads(last_message()["detail"])["recu"], "echec")[0]["par"] == "Blog"
machine.pop_context(conv)
print("12. l'outil a échoué : il ne peut pas dire que c'est publié")

# Une réponse ordinaire ne change pas de forme.
turn(say("Bonjour, en quoi puis-je aider ?"))
assert last_message()["detail"] is None and journal()["etat"] == "fait"
turn([("tool.started", {"tool": "write_file", "args": {}}), ("message.delta", {"delta": "Je regarde."}), ("tool.completed", {"tool": "write_file"}),
      ("message.delta", {"delta": "Voilà ton plan."}), ("run.completed", {"output": ""})])
assert json.loads(last_message()["detail"])["recu"]["fait"] == ["creer"], "ce qu'il a fait sert de preuve plus tard, sans rien afficher de plus"
print("13. une réponse sans action n'a pas de reçu")

# Un tour coupé : sa phrase n'est pas une affirmation finie.
turn([("message.delta", {"delta": "J'ai envoyé le"}), ("run.failed", {"error": "boom"})])
assert not (json.loads(last_message()["detail"] or "{}").get("recu")), "pas de reçu sur un tour qui n'a pas fini"
machine.pop_context(conv)
print("14. un tour coupé n'est pas jugé")

# Un défaut du reçu n'abîme pas la tâche.
real_compare = recu.compare
recu.compare = lambda *a, **k: 1 / 0
turn(say("J'ai envoyé le courriel."))
recu.compare = real_compare
assert last_message()["text"] == "J'ai envoyé le courriel." and last_message()["detail"] is None and journal()["etat"] == "fait"
print("15. un défaut du reçu le fait taire, la réponse arrive quand même")

# Rien de lui ne touche les droits : il ne regarde que le flux.
before = dict(main.task_state)
assert "recu" not in json.dumps(A.get("/api/a-toi").json()), "le reçu n'attend personne : il n'entre pas dans « À toi »"
assert before == dict(main.task_state)
print("16. il n'attend personne et ne change rien")

# --- De lui-même : personne ne lit le fil en direct --------------------------------------------------------------------

told: list = []
proactif.desktop.notify_user = lambda *a, **k: told.append(a)
proactif.notifications.seen_recently = lambda conv_id: False


def main_messages() -> list[dict]:
    return A.get(f"/api/conversations/{conv}/messages").json()


async def proactive_turn(pairs: list[tuple]) -> None:
    script[:] = pairs
    sorted_out = {"titre": "Une facture", "resume": "Une facture à traiter.", "retenues": [], "liens": []}
    await proactif._start_turn("a1", "agir", sorted_out, [{"source": "Courriels", "titre": "Facture", "cle": "k", "texte": "x"}])
    for _ in range(300):
        if not [t for t in proactif._tasks if not t.done()] + [t for t in main._running_runs if not t.done()]:
            return
        await asyncio.sleep(0.01)


asyncio.run(proactive_turn(say("J'ai payé la facture de Paul.")))
report = main_messages()[-1]["text"]
assert "Noah n'a vu aucune trace de : « J'ai payé la facture de Paul. »" in report, report
print("17. de lui-même : le compte rendu porte la réserve, puisque personne ne regardait")

count = len(main_messages())
asyncio.run(proactive_turn(say("RIEN")))
assert len(main_messages()) == count, "« RIEN » sans action ne dérange toujours personne"
asyncio.run(proactive_turn(say("RIEN", ("mcp_gmail_send_message", "tool.completed"))))
report = main_messages()[-1]["text"]
assert len(main_messages()) == count + 1 and "Fait sans le dire : il a envoyé quelque chose avec Gmail" in report, report
print("18. de lui-même : « RIEN » ne cache plus une action")

print("OK")
