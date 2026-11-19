"""Les routines hors du fil (0.4.0, X6) : 24 passages d'une routine horaire sont comptés et lisibles dans Activité, et le fil n'en reçoit rien ;
le voyant s'éteint à la visite ; « Amener dans le fil » pose le résultat dans le fil et dans le contexte de l'agent ; un échec, lui, reste
écrit dans le fil ; un rappel arrive toujours dans le fil ; les droits suivent ceux des routines (administrer l'agent).

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/passages_test.py"
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

from noah import auth, db, desktop, machine, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
invite = auth.create_user("invite", "motdepasse-i")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Rita', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Zed', '', 'k2', ?)", (alice,))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'usage')", (invite,))
db.set_setting("onboarded", "1")
fil = main._new_conversation(alice, "a1", "Conversation", main=True)
fil = fil["id"] if isinstance(fil, dict) else fil
notes: list[tuple] = []
desktop.notify_user = lambda user, title, text, kind=None, url="/", urgent=False: notes.append((user, title, url))

ROUTINE = {"id": "r-veille", "name": "Veille des concurrents", "enabled": True, "schedule_display": "every 60m"}
sorties: list[dict] = []


async def fake_admin(agent_id, action, body=None, timeout=90):
    assert action == "routines_sorties", action
    if agent_id != "a1":
        return {"sorties": [], "etats": {}}
    return {"sorties": list(sorties), "etats": {}, "routines": [ROUTINE]}


machine.admin = fake_admin


def web(user: int) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url="http://test",
                             headers={"authorization": f"Bearer {auth.new_session(user, 'essai', 'web')}"})


def fil_messages() -> list[dict]:
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id", (fil,))]


async def tick():
    await machine.deliver_routines_once(main._save_message, main._main_conversation)


async def everything():
    A, I, B = web(alice), web(invite), web(bruno)

    # 1. Une routine horaire pendant 24 h : rien dans le fil, 24 passages gardés.
    for hour in range(24):
        sorties[:] = [{"routine": ROUTINE["id"], "nom": ROUTINE["name"], "quand": f"2026-11-18_{hour:02d}-00-03", "texte": f"Passage {hour}. Rien de neuf chez les concurrents.\n\nDétail du passage {hour}."}]
        await tick()
    assert fil_messages() == [], fil_messages()
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) FROM routine_passages WHERE agent_id = 'a1'").fetchone()[0] == 24
    assert len(notes) == 24 and all(n[2] == "/#agent=a1" for n in notes), (len(notes), notes[:2])
    print("1. 24 passages en 24 h : 24 gardés, rien dans le fil")

    # 2. Activité : la routine, son compte, son bilan, « passée depuis ta dernière visite » ; l'ouverture de l'agent porte le même compte.
    r = await A.get("/api/agents/a1/routines-activite")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["non_vues"] == 24 and len(out["routines"]) == 1, out
    veille = out["routines"][0]
    assert veille["id"] == ROUTINE["id"] and veille["nom"] == ROUTINE["name"] and veille["passages"] == 24 and veille["vient"] is True, veille
    assert veille["quand"] == "every 60m" and veille["bilan"] == "Passage 23." and veille["echecs"] == 0 and veille["dernier_etat"] == "ok", veille
    ouverture = (await A.get("/api/agents/a1/ouverture")).json()
    assert ouverture["routines"]["non_vues"] == 24 and ouverture["routines"]["actives"] == [{"id": ROUTINE["id"], "nom": ROUTINE["name"]}], ouverture["routines"]
    print("2. Activité compte 24 passages, bilan du dernier ; l'ouverture dit 24 non vus et connaît la routine sans lancer de docker exec")

    # 3. Les passages se lisent 50 par 50 au plus (ici 10), le plus récent d'abord, sans doublon.
    seen, avant = [], None
    for page in range(3):
        r = await A.get("/api/agents/a1/routines-passages", params={"routine": ROUTINE["id"], "limite": 10, **({"avant": avant} if avant else {})})
        body = r.json()
        seen += body["passages"]
        avant = body["passages"][-1]["id"]
        assert body["plus"] is (page < 2), (page, body["plus"])
    assert [p["resume"] for p in seen] == [f"Passage {h}." for h in range(23, -1, -1)] and len({p["id"] for p in seen}) == 24, [p["resume"] for p in seen]
    assert all("rendu" not in p for p in seen), "la liste est légère : le rendu se lit passage par passage"
    one = (await A.get(f"/api/agents/a1/routines-passages/{seen[0]['id']}")).json()
    assert one["rendu"].startswith("Passage 23.") and "Détail du passage 23." in one["rendu"] and one["etat"] == "ok" and one["amene"] is False, one
    assert (await A.get("/api/agents/a1/routines-passages/99999")).status_code == 404
    assert (await A.get(f"/api/agents/a2/routines-passages/{seen[0]['id']}")).status_code == 404, "le passage d'un agent ne se lit pas par un autre"
    print("3. passages paginés (10, 10, 4), le rendu entier au détail, un passage ne se lit pas sous un autre agent")

    # 4. Le voyant : il s'éteint à la visite, se rallume au passage suivant.
    assert (await A.post("/api/agents/a1/routines-vues")).json() == {"non_vues": 0}
    assert (await A.get("/api/agents/a1/routines-activite")).json()["non_vues"] == 0
    assert (await A.get("/api/agents/a1/ouverture")).json()["routines"]["non_vues"] == 0
    assert (await A.get("/api/agents/a1/routines-activite")).json()["routines"][0]["vient"] is False
    await asyncio.sleep(0.01)
    sorties[:] = [{"routine": ROUTINE["id"], "nom": ROUTINE["name"], "quand": "2026-11-19_00-00-03", "texte": "Passage 24. Une nouveauté : un prix baisse."}]
    await tick()
    out = (await A.get("/api/agents/a1/routines-activite")).json()
    assert out["non_vues"] == 1 and out["routines"][0]["vient"] is True and out["routines"][0]["passages"] == 25, out
    print("4. voyant éteint à la visite, rallumé par le passage suivant")

    # 5. « Amener dans le fil » : le résultat arrive dans le fil, l'agent l'a dans son contexte, une seule fois.
    pid = (await A.get("/api/agents/a1/routines-passages", params={"routine": ROUTINE["id"], "limite": 1})).json()["passages"][0]["id"]
    r = await A.post(f"/api/agents/a1/routines-passages/{pid}/amener")
    assert r.status_code == 200 and r.json() == {"conversation_id": fil}, r.text
    said = fil_messages()
    assert len(said) == 1 and said[0]["role"] == "agent" and said[0]["text"].startswith("**Routine « Veille des concurrents »**") and "un prix baisse" in said[0]["text"], said
    context = machine.pop_context(fil)
    assert "Passage 24" in context and "Arrivé dans la conversation" in context, context
    assert (await A.post(f"/api/agents/a1/routines-passages/{pid}/amener")).json() == {"conversation_id": fil}
    assert len(fil_messages()) == 1 and machine.pop_context(fil) == "", "amener deux fois ne répète rien"
    assert (await A.get(f"/api/agents/a1/routines-passages/{pid}")).json()["amene"] is True
    print("5. amené dans le fil : message écrit, contexte de l'agent rempli, une seule fois")

    # 6. Un échec reste écrit dans le fil, et compté comme passage en échec.
    sorties[:] = [{"routine": ROUTINE["id"], "nom": ROUTINE["name"], "quand": "2026-11-19_01-00-03", "texte": "Cette routine n'a pas pu passer.",
                   "erreur": "RuntimeError: HTTP 403: Key limit exceeded (monthly limit). $20.78 of $20.00 used; resets 2026-12-01T00:00:00.000Z."}]
    await tick()
    said = fil_messages()
    assert len(said) == 2 and said[1]["role"] == "error" and "n'a pas pu passer" in said[1]["text"], said
    out = (await A.get("/api/agents/a1/routines-activite")).json()["routines"][0]
    assert out["passages"] == 26 and out["echecs"] == 1 and out["dernier_etat"] == "err" and "20.78" in out["bilan"], out
    bad = (await A.get("/api/agents/a1/routines-passages", params={"routine": ROUTINE["id"], "limite": 1})).json()["passages"][0]
    assert bad["etat"] == "err" and (await A.get(f"/api/agents/a1/routines-passages/{bad['id']}")).json()["erreur"].startswith("RuntimeError")
    print("6. un échec : écrit dans le fil, compté en échec, erreur lisible dans son passage")

    # 7. Les droits : administrer l'agent, comme pour les routines. Un invité en usage, un autre compte : refusés.
    for who, path in ((I, "/api/agents/a1/routines-activite"), (B, "/api/agents/a1/routines-activite"), (I, "/api/agents/a1/routines-passages?routine=x"),
                      (I, f"/api/agents/a1/routines-passages/{pid}"), (B, f"/api/agents/a1/routines-passages/{pid}")):
        assert (await who.get(path)).status_code in (403, 404), path
    for who, path in ((I, f"/api/agents/a1/routines-passages/{pid}/amener"), (B, f"/api/agents/a1/routines-passages/{pid}/amener"),
                      (I, "/api/agents/a1/routines-vues"), (B, "/api/agents/a1/routines-vues")):
        assert (await who.post(path)).status_code in (403, 404), path
    assert (await I.get("/api/agents/a1/ouverture")).json()["routines"] == {"actives": [], "non_vues": 0}, "l'ouverture ne dit rien des routines à qui ne les administre pas"
    print("7. droits : administrateur seulement, rien ne fuit par l'ouverture")

    # 8. Un rappel (routine qui ne passe qu'une fois) arrive toujours dans le fil, et n'est pas une routine d'Activité.
    machine._note_reminder("a1", {"id": "j-linge", "name": "Sortir le linge", "schedule_display": "once in 2m", "next_run_at": "2026-11-19T02:00:00+00:00"})
    sorties[:] = [{"routine": "j-linge", "nom": "j-linge", "quand": "2026-11-19_02-00-03", "texte": "C'est l'heure de sortir le linge."}]
    await tick()
    assert fil_messages()[-1]["text"].startswith("**Rappel : Sortir le linge**")
    ids = {r["id"] for r in (await A.get("/api/agents/a1/routines-activite")).json()["routines"]}
    assert ids == {ROUTINE["id"]}, ids
    print("8. un rappel arrive dans le fil, hors des routines d'Activité")
    print("OK")


asyncio.run(everything())
