"""Un rappel (« rappelle-moi dans 2 minutes ») arrive à l'heure, titré « Rappel : … », et sonne sur le téléphone ; une étape qui attend
la personne (`noah.py appeler`) se voit dans « À toi » et la prévient. Vraie base, vraies routes ; lanceur et push captés.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/rappels_test.py"
"""
import asyncio
import os
import sys
import tempfile
import time
from datetime import datetime, timezone

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, desktop, handoff, machine, main, notifications, push  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-alice")
with db.connect() as c:
    c.execute("UPDATE users SET role = 'owner' WHERE id = ?", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Rita', '', 'k', ?)", (alice,))
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)

sent: list[dict] = []
natives: list[str] = []


async def captured_send(title, text, url="/", urgent=False, user_id=None, session=None, extra=None):
    sent.append({"title": title, "text": text, "urgent": urgent, "user": user_id, "extra": extra or {}})
    return {"livres": 1, "echecs": 0, "morts": 0, "differes": 0}


push.send = captured_send
desktop.send_native = lambda user, title, text, device=None: natives.append(title)
asked: list[str] = []
outputs: list[dict] = []
RUN_AT = time.time() + 120


async def fake_admin(agent_id, action, body=None, timeout=90):
    asked.append(action)
    if action == "routine_creer":
        once = body["quand"].startswith("in ")
        return {"id": "j-linge" if once else "j-brief", "name": body["nom"], "prompt": body["consigne"], "schedule_display": "once in 2m" if once else "every day at 8am",
                "next_run_at": datetime.fromtimestamp(RUN_AT, timezone.utc).isoformat(), "enabled": True}
    if action == "routines_sorties":
        return {"sorties": list(outputs)}
    raise AssertionError(action)


machine.admin = fake_admin


def messages():
    with db.connect() as c:
        return [r["text"] for r in c.execute("SELECT text FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY id", (conv,))]


async def everything():
    # 1. Créer un rappel unique le retient : son nom (Hermes le retire de sa liste une fois fait) et son heure.
    await machine._create_routine("a1", machine.NewRoutine(nom="Sortir le linge", quand="in 2m", consigne="Rappelle-lui de sortir le linge."))
    await machine._create_routine("a1", machine.NewRoutine(nom="Brief", quand="every day at 8am", consigne="Le brief du matin."))
    kept = machine._reminders("a1")
    assert list(kept) == ["j-linge"] and kept["j-linge"]["nom"] == "Sortir le linge" and abs(kept["j-linge"]["a"] - RUN_AT) < 2, kept
    print("1. rappel unique retenu (nom, heure) ; une routine qui revient ne l'est pas")

    # 2. Autour de son heure, la relève passe toutes les 10 s pour cet agent ; ailleurs, rien de plus qu'avant.
    assert not machine._reminder_due("a1", time.time()) and machine._reminder_due("a1", RUN_AT + 15) and not machine._reminder_due("a1", RUN_AT + 3600)
    asked.clear()
    await machine.deliver_routines_once(main._save_message, main._main_conversation, only_due=True)
    assert "routines_sorties" not in asked, "hors de l'heure d'un rappel : pas de relève rapide"
    machine._note_reminder("a1", {"id": "j-maintenant", "name": "Maintenant", "schedule_display": "once in 1m",
                                  "next_run_at": datetime.now(timezone.utc).isoformat()})
    await machine.deliver_routines_once(main._save_message, main._main_conversation, only_due=True)
    assert asked.count("routines_sorties") == 1
    real_sleep, slept = asyncio.sleep, []

    async def once(seconds):
        slept.append(seconds)
        if len(slept) > 1:
            raise asyncio.CancelledError
        await real_sleep(0)

    machine.asyncio.sleep = once
    try:
        await machine.deliver_routines(main._save_message, main._main_conversation)
    except asyncio.CancelledError:
        pass
    finally:
        machine.asyncio.sleep = real_sleep
    assert slept[0] == 10, slept
    print("2. retard : relève toutes les 10 s autour de l'heure d'un rappel (avant : 60 s, qui s'ajoutaient aux 60 s d'Hermes)")

    # 3. Le rappel arrive titré « Rappel : … », et sonne : notification urgente, canal principal du téléphone.
    sent.clear()
    outputs[:] = [{"routine": "j-linge", "nom": "j-linge", "quand": "2026-11-13_10-02-00", "texte": "C'est l'heure de sortir le linge. Il est prêt."},
                  {"routine": "j-brief", "nom": "Brief", "quand": "2026-11-13_10-02-01", "texte": "Trois rendez-vous aujourd'hui."}]
    await machine.deliver_routines_once(main._save_message, main._main_conversation)
    await real_sleep(0.02)
    said = messages()
    assert said[-2].startswith("**Rappel : Sortir le linge**\n\nC'est l'heure") and "Routine" not in said[-2], said[-2:]
    assert said[-1].startswith("**Routine « Brief »**"), "une routine qui revient garde son titre"
    reminder = next(s for s in sent if s["title"] == "Rappel : Sortir le linge")
    assert reminder["urgent"] and reminder["extra"]["type"] == "rappel" and reminder["user"] == alice and reminder["text"] == "C'est l'heure de sortir le linge.", reminder
    routine = next(s for s in sent if s["title"] == "Routine « Brief »")
    assert not routine["urgent"] and routine["extra"]["type"] == "routines"
    assert "Rappel : Sortir le linge" in natives
    print("3. rappel : « Rappel : Sortir le linge », notification urgente par défaut ; une routine reste « Routine « … » », discrète")

    # 4. « Routines et veilles » coupé dans Réglages > Notifications : le rappel s'écrit, sans notification.
    with db.connect() as c:
        c.execute("INSERT INTO notification_prefs (user_id, rappels, coupes) VALUES (?, 'demande', '[\"routines\"]') "
                  "ON CONFLICT(user_id) DO UPDATE SET coupes = excluded.coupes", (alice,))
    assert not notifications.wants(alice, "routines")
    sent.clear()
    outputs[:] = [{"routine": "j-linge", "nom": "j-linge", "quand": "2026-11-13_10-03-00", "texte": "Encore le linge."}]
    await machine.deliver_routines_once(main._save_message, main._main_conversation)
    await real_sleep(0.02)
    assert messages()[-1].startswith("**Rappel : Sortir le linge**") and not sent, sent
    print("4. notifications de routines coupées : le rappel est écrit, rien ne sonne")

    # 5. L'agent attend la personne (`noah.py appeler`) : « À toi » le montre, et elle est prévenue.
    async def private(agent_id, seconds):
        return True

    handoff._private = private
    sent.clear()
    assert not [i for i in main.inbox(user=alice) if i.get("appel")]
    call = handoff.open_call("a1", "Connecte-toi à Instagram dans l'onglet Ordinateur.", leave_host="")
    await real_sleep(0.02)
    items = [i for i in main.inbox(user=alice) if i.get("appel")]
    assert len(items) == 1 and items[0]["appel"]["id"] == call["id"] and items[0]["demande"].startswith("Connecte-toi à Instagram"), items
    assert items[0]["conversation_id"] == conv and items[0]["etat"] == "approve" and not items[0].get("run_id")
    assert any(s["title"] == "Noah a besoin de toi" and s["user"] == alice for s in sent), sent
    handoff.close_call("a1", call["id"], "fait")
    assert not [i for i in main.inbox(user=alice) if i.get("appel")], "réponse donnée : plus rien n'attend"
    print("5. appel à la personne : visible dans « À toi » tant qu'il attend, et notifié")
    print("OK")


asyncio.run(everything())
