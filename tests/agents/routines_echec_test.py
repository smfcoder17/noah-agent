"""Une routine qui échoue (ici : plafond de dépense chez le fournisseur) : un message court dans la conversation, sans consigne ni
trace, les détails masqués à côté ; rien de plus aux passages suivants tant que la cause ne change pas ; un mot quand elle repasse.
Rejoue les deux sorties réelles du 12 novembre, au format des documents d'Hermes (cron/scheduler.py), lues par le vrai lanceur.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/launcher:/l:ro" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/routines_echec_test.py"
"""
import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import time
import types
from pathlib import Path

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, desktop, diagnostics, machine, main  # noqa: E402

spec = importlib.util.spec_from_file_location("agent_admin", "/l/agent_admin.py")
lanceur = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lanceur)
lanceur.DATA = Path(tempfile.mkdtemp())

db.init()
alice = auth.create_user("alice", "motdepasse-alice")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Rita', '', 'k', ?)", (alice,))
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)

JOB, NAME = "bdf902f5060f", "X — publication auto"
KEY_ID = "3f9c" * 16  # 64 caractères hexadécimaux, comme l'adresse réelle
CONSIGNE = ("[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered "
            "to the user — do NOT use send_message.]\n\n" + "\n".join(f"Étape {i} : publie le post du jour sur X, ton direct." for i in range(60)))
BUDGET = "RuntimeError: HTTP 422: ExceededBudget: User=628911 over budget. Spend={spend}, Budget=2.0"
KEY_LIMIT = (f"RuntimeError: HTTP 403: Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/workspaces/default/keys/{KEY_ID} "
             "$20.78 of $20.00 used; resets 2026-12-01T00:00:00.000Z.")
status = {"last_status": "error"}
sys.modules["cron"] = types.ModuleType("cron")
sys.modules["cron.jobs"] = jobs = types.ModuleType("cron.jobs")
jobs.list_jobs = lambda include_disabled=True: [{"id": JOB, "name": NAME, "prompt": CONSIGNE, **status}]
sys.modules["cron"].jobs = jobs


def header(when: str, title: str) -> str:
    return f"# Cron Job: {title}\n\n**Job ID:** {JOB}\n**Run Time:** {when.replace('_', ' ')}\n**Schedule:** 0 5-16 * * *\n\n"


def failed(when: str, error: str) -> None:
    """Le document d'un passage échoué, tel qu'Hermes l'écrit (_run_doc_header + format_run_error)."""
    trace = ("Traceback (most recent call last):\n  File \"/opt/hermes/cron/scheduler.py\", line 2631, in run_job\n"
             "    result = agent.run_conversation(prompt)\n  File \"/opt/hermes/run_agent.py\", line 812, in run_conversation\n"
             f"    raise RuntimeError(f\"HTTP {{status}}: {{body}}\")\n{error}")
    write(when, header(when, f"{NAME} (FAILED)") + f"## Prompt\n\n{CONSIGNE}\n\n## Error\n\n```\n{trace}\n```\n")


def succeeded(when: str, response: str) -> None:
    write(when, header(when, NAME) + f"**Prompt Characters:** {len(CONSIGNE)}\n## Prompt\n\n{CONSIGNE}\n\n"
          f"**Response Characters:** {len(response)}\n## Response\n\n{response}\n")


def write(when: str, text: str) -> None:
    folder = lanceur.DATA / "cron" / "output" / JOB
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{when}.md").write_text(text, encoding="utf-8")


async def fake_admin(agent_id, action, body=None, timeout=90):
    assert action == "routines_sorties", action
    return json.loads(json.dumps(lanceur.routine_outputs(body)))  # comme par le réseau


machine.admin = fake_admin
notes: list[tuple[str, str]] = []
desktop.notify_user = lambda user, title, text, kind=None, url="/", urgent=False: notes.append((title, text))


def rows():
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT role, text, detail FROM messages WHERE conversation_id = ? ORDER BY id", (conv,))]


async def tick():
    await machine.deliver_routines_once(main._save_message, main._main_conversation)


async def everything():
    # 1. Le lanceur ne laisse sortir ni la consigne de la routine, ni celle d'Hermes : seulement l'erreur.
    failed("2026-11-12_05-00-26", BUDGET.format(spend="2.601199388"))
    out = lanceur.routine_outputs({"depuis": ""})
    entry = out["sorties"][0]
    assert entry["erreur"].endswith("Spend=2.601199388, Budget=2.0") and entry["nom"] == NAME, entry
    assert "IMPORTANT" not in json.dumps(entry) and "publie le post" not in json.dumps(entry), entry
    assert out["etats"] == {JOB: "error"}
    print("1. lanceur : l'erreur seule, sans consigne")

    # 2. Premier passage échoué : un message court, une phrase claire, quoi faire ; les détails à côté, masqués.
    await tick()
    said = rows()
    assert len(said) == 1 and said[0]["role"] == "error", said
    text = said[0]["text"]
    assert text.startswith(f"Routine « {NAME} » n'a pas pu passer."), text
    assert "2.60 $ dépensés pour un plafond de 2.00 $" in text and "Réglages > Modèles et budget > Cerveau" in text, text
    for leak in ("IMPORTANT", "publie le post", "Traceback", "RuntimeError", "scheduler.py", "Job ID", "628911"):
        assert leak not in text, (leak, text)
    assert "ExceededBudget" in said[0]["detail"] and "Traceback" in said[0]["detail"] and "publie le post" not in said[0]["detail"]
    assert len(notes) == 1 and notes[0][0] == f"Routine « {NAME} » n'a pas pu passer", notes
    assert notes[0][1] in text and "Traceback" not in notes[0][1] and "RuntimeError" not in notes[0][1], notes
    print("2. message court :", text)
    print("   notification :", notes[0])

    # 3. Les passages suivants, même cause (le montant grimpe) : rien dans la conversation, rien en notification ; le journal les garde.
    for hour, spend in ((6, "2.71"), (7, "2.83"), (8, "2.95"), (9, "3.02"), (10, "3.10")):
        failed(f"2026-11-12_{hour:02d}-00-26", BUDGET.format(spend=spend))
        await tick()
    assert len(rows()) == 1 and len(notes) == 1, (rows(), notes)
    assert sum(1 for d in diagnostics.recent() if d["ou"].startswith("routine ")) == 6
    print("3. cinq passages de plus, même panne : silence (6 passages dans Diagnostic)")

    # 4. La cause change (limite mensuelle de la clé OpenRouter) : on le dit, et l'adresse de gestion de la clé reste masquée.
    failed("2026-11-12_11-00-26", KEY_LIMIT)
    await tick()
    said = rows()
    assert len(said) == 2 and said[1]["role"] == "error", said
    text = said[1]["text"]
    assert text.startswith(f"Routine « {NAME} » n'a pas pu passer.") and "20.78 $ dépensés pour une limite de 20.00 $" in text, text
    assert "01/12/2026" in text and "invalide" not in text, "la clé est bonne : c'est sa limite, pas un refus"
    for leak in (KEY_ID, "openrouter.ai/workspaces", "Traceback", "RuntimeError"):
        assert leak not in text, (leak, text)
    assert KEY_ID not in said[1]["detail"] and "Key limit exceeded" in said[1]["detail"], said[1]["detail"]
    assert all(KEY_ID not in d["texte"] for d in diagnostics.recent())
    assert len(notes) == 2 and KEY_ID not in notes[1][1]
    failed("2026-11-12_12-00-26", KEY_LIMIT)
    await tick()
    assert len(rows()) == 2 and len(notes) == 2
    print("4. autre cause : un message, adresse de la clé masquée ; puis silence :", text)

    # 5. Un jour plus tard, toujours en panne : un rappel, un seul.
    key = machine._failure_key("a1", JOB)
    known = json.loads(db.get_setting(key))
    db.set_setting(key, json.dumps({**known, "dit": time.time() - machine.FAILURE_REMINDER - 1}))
    failed("2026-11-13_05-00-26", KEY_LIMIT)
    await tick()
    failed("2026-11-13_06-00-26", KEY_LIMIT)
    await tick()
    said = rows()
    assert len(said) == 3 and said[2]["text"].startswith(f"Routine « {NAME} » n'a toujours pas pu passer."), said[-1]
    assert len(notes) == 3
    print("5. un jour plus tard : un rappel")

    # 6. Elle repasse : son compte rendu le dit, une fois.
    status["last_status"] = "ok"
    succeeded("2026-11-13_07-00-26", "Post publié : « Trois outils pour monter plus vite ».")
    await tick()
    said = rows()
    assert len(said) == 4 and said[3]["role"] == "agent", said
    assert said[3]["text"].startswith(f"**Routine « {NAME} »**\n\n_De nouveau en marche") and "Post publié" in said[3]["text"], said[3]
    assert "IMPORTANT" not in said[3]["text"]
    succeeded("2026-11-13_08-00-26", "Post publié : « Le montage en une heure ».")
    await tick()
    assert "De nouveau" not in rows()[-1]["text"]
    print("6. reprise dite une fois, dans le compte rendu")

    # 7. Nouvelle panne, puis reprise muette ([SILENT]) : l'état « ok » d'Hermes suffit pour le dire ; un passage muet ne s'écrit pas.
    status["last_status"] = "error"
    failed("2026-11-13_09-00-26", BUDGET.format(spend="2.01"))
    await tick()
    assert rows()[-1]["text"].startswith(f"Routine « {NAME} » n'a pas pu passer."), "la reprise a remis le compteur à zéro"
    count = len(rows())
    status["last_status"] = "ok"
    write("2026-11-13_10-00-26", header("2026-11-13_10-00-26", NAME) + "**Mode:** monitor\n**Status:** no_change (agent run suppressed)\n")
    succeeded("2026-11-13_10-00-27", "[SILENT]")
    await tick()
    said = rows()
    assert len(said) == count + 1 and said[-1]["text"].startswith(f"**Routine « {NAME} » repasse**"), said[-1]
    await tick()
    assert len(rows()) == count + 1
    print("7. reprise sans compte rendu : dite une fois ; les passages muets restent muets")

    # 8. Lanceur d'avant (le document entier en `texte`) : même message court.
    async def old_launcher(agent_id, action, body=None, timeout=90):
        doc = header("2026-11-13_11-00-26", f"{NAME} (FAILED)") + f"## Prompt\n\n{CONSIGNE}\n\n## Error\n\n```\n{KEY_LIMIT}\n```\n"
        return {"sorties": [{"routine": JOB, "nom": NAME, "quand": "2026-11-13_11-00-26", "texte": doc}]}

    machine.admin = old_launcher
    await tick()
    machine.admin = fake_admin
    said = rows()
    assert said[-1]["role"] == "error" and "IMPORTANT" not in said[-1]["text"] and "20.78 $" in said[-1]["text"], said[-1]
    print("8. lanceur d'avant : même message court")

    # 9. Le masque attrape l'adresse de gestion de la clé, où qu'elle apparaisse.
    assert KEY_ID not in diagnostics.mask(KEY_LIMIT) and "$20.78 of $20.00" in diagnostics.mask(KEY_LIMIT)
    print("9. masque : adresse de gestion de la clé")
    print("OK")


asyncio.run(everything())
