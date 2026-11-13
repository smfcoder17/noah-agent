"""Lot 2 de la 0.2.0, prêt dès la création : chaque modèle d'agent pose ses routines en pause, un geste en active une,
et l'agent écrit un premier message, une seule fois, sans appel au modèle.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/presets_routines_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def outside(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"appel sortant interdit : {request.url}")


class Sandbox(httpx.AsyncClient):
    def __init__(self, *a, **k):
        k["transport"] = httpx.MockTransport(outside)
        super().__init__(*a, **k)


httpx.AsyncClient = Sandbox

from noah import auth, db, hermes, machine, main, presets  # noqa: E402

# Le cron d'Hermes de chaque agent, vu par l'outil d'administration du lanceur.
crons: dict[str, list[dict]] = {}
calls: list[tuple[str, str, dict]] = []
down: set[str] = set()


async def fake_admin(agent_id, action, body=None, timeout=90):
    calls.append((agent_id, action, body or {}))
    if agent_id in down:
        raise HTTPException(502, "L'agent ne répond pas")
    jobs = crons.setdefault(agent_id, [])
    if action == "routines":
        return {"routines": list(jobs)}
    if action == "routine_creer":
        job = {"id": f"job-{len(jobs) + 1}", "name": body["nom"], "prompt": body["consigne"], "schedule_display": body["quand"],
               "enabled": not body["en_pause"], "state": "paused" if body["en_pause"] else "scheduled"}
        jobs.append(job)
        return job
    raise AssertionError(f"action inattendue : {action}")


async def fake_create(agent_id):
    return "cle-" + agent_id


async def fake_provision(agent, soul):
    pass


async def healthy(a):
    return True


machine.admin = fake_admin
hermes.create_container = fake_create
main._provision, main._health = fake_provision, healthy
main.current_model = lambda: {"provider": "test", "model": "test", "has_key": True}

db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
db.set_setting("onboarded", "1")


def client(user: int) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


def messages(agent_id: str) -> list[dict]:
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT m.role, m.text FROM messages m JOIN conversations v ON v.id = m.conversation_id "
                                            "WHERE v.agent_id = ? AND v.main = 1 ORDER BY m.id", (agent_id,))]


alice, bruno = client(ALICE), client(BRUNO)

# --- 1. Chaque moment écrit en clair se lit en horaire cron -------------------------------------------------------------------
for quand, cron in {"chaque jour à 8 h": "0 8 * * *", "chaque jour à 7 h 30": "30 7 * * *", "chaque lundi à 9 h": "0 9 * * 1",
                    "chaque jeudi à 18 h": "0 18 * * 4", "le 1er de chaque mois à 9 h": "0 9 1 * *", "toutes les heures": "0 * * * *",
                    "chaque jour à 18 h, en pause tant que tu ne l'actives pas": "0 18 * * *"}.items():
    assert presets.horaire(quand) == cron, (quand, presets.horaire(quand))
for bad in ("demain", "chaque jour à 25 h", "le 31 de chaque mois à 9 h", "chaque jour à 8 h 75", ""):
    assert presets.horaire(bad) is None, bad
assert all(presets.horaire(r["quand"]) for p in presets.DATA["presets"] for r in p["routines"])
print("1. moments en clair lus en horaire cron ; un moment non compris est refusé")

# --- 2. Chaque modèle : ses routines en pause, rien dans le cron, un premier message -------------------------------------------
created = {}
for p in presets.DATA["presets"]:
    r = alice.post("/api/agents", json={"name": p["nom"], "preset": p["id"]})
    assert r.status_code == 200, (p["id"], r.text)
    created[p["id"]] = agent_id = r.json()["id"]
assert not [c for c in calls if c[1] == "routine_creer"], "une routine est partie dans le cron à la création"
for p in presets.DATA["presets"]:
    agent_id = created[p["id"]]
    listed = alice.get(f"/api/agents/{agent_id}/routines")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["routines"] == [], body  # aucune vraie routine : rien ne tourne, aucun modèle appelé
    shown = body["suggerees"]
    assert [s["nom"] for s in shown] == [r["nom"] for r in p["routines"]], (p["id"], shown)
    assert all(s["en_pause"] and s["horaire"] == presets.horaire(r["quand"]) and s["consigne"] == r["consigne"] and "," not in s["quand"]
               for s, r in zip(shown, p["routines"])), shown
    said = messages(agent_id)
    assert len(said) == 1 and said[0]["role"] == "agent", (p["id"], said)
    text = said[0]["text"]
    assert text.startswith(f"Bonjour, je suis {p['nom']}.") and all(d in text for d in p["demandes"]), text
    assert all(f"**{r['nom']}**" in text for r in p["routines"]), text
    assert ("Activer" in text) == bool(p["routines"]), text
print(f"2. {len(created)} modèles : routines en pause dans Noah, cron vide, un premier message chacun")

# --- 3. Partir de zéro : ni routine ni message ----------------------------------------------------------------------------------
zero = alice.post("/api/agents", json={"name": "Vide"}).json()["id"]
assert alice.get(f"/api/agents/{zero}/routines").json()["suggerees"] == [] and messages(zero) == []
print("3. partir de zéro : ni routine à activer, ni message")

# --- 4. Un geste active une routine, une seule -----------------------------------------------------------------------------------
agent_id = created["assistant"]
first, *rest = alice.get(f"/api/agents/{agent_id}/routines").json()["suggerees"]
calls.clear()
r = alice.post(f"/api/agents/{agent_id}/routines/suggerees/{first['id']}/activer")
assert r.status_code == 200, r.text
made = r.json()
assert made["name"] == first["nom"] and made["enabled"] and made["schedule_display"] == first["horaire"], made
creations = [c for c in calls if c[1] == "routine_creer"]
assert len(creations) == 1 and creations[0][2]["en_pause"] is False and creations[0][2]["consigne"] == first["consigne"], creations
after = alice.get(f"/api/agents/{agent_id}/routines").json()
assert [x["name"] for x in after["routines"]] == [first["nom"]] and [s["id"] for s in after["suggerees"]] == [s["id"] for s in rest], after
again = alice.post(f"/api/agents/{agent_id}/routines/suggerees/{first['id']}/activer")
assert again.status_code == 404 and len([c for c in calls if c[1] == "routine_creer"]) == 1, again.text
print("4. « Activer » crée exactement une routine active ; un second geste n'en crée pas d'autre")

# --- 5. Agent arrêté : la suggestion revient ; un autre agent ou un autre compte ne l'active pas ---------------------------------
second = rest[0]
down.add(agent_id)
failed = alice.post(f"/api/agents/{agent_id}/routines/suggerees/{second['id']}/activer")
assert failed.status_code == 502, failed.text
down.discard(agent_id)
assert second["id"] in [s["id"] for s in alice.get(f"/api/agents/{agent_id}/routines").json()["suggerees"]]
other = created["veille"]
assert alice.post(f"/api/agents/{other}/routines/suggerees/{second['id']}/activer").status_code == 404
assert bruno.post(f"/api/agents/{agent_id}/routines/suggerees/{second['id']}/activer").status_code == 404
assert len(crons[agent_id]) == 1 and not crons.get(other)
print("5. échec : la routine reste à activer ; l'identifiant d'un autre agent ne sert pas ; un autre compte ne voit rien")

# --- 6. Le premier message n'est écrit qu'une fois -------------------------------------------------------------------------------
p = presets.BY_ID["veille"]
agent_id = created["veille"]
assert alice.patch(f"/api/agents/{agent_id}", json={"name": "Veille", "role": "Autre rôle.", "preset": "veille"}).status_code == 200
conv = main._main_conversation(agent_id, ALICE)
presets.welcome(agent_id, "Veille", p, lambda: conv, main._save_message)  # une seconde écriture ne passe pas
presets.apply(agent_id, p)  # ni une seconde pose des routines
assert len(messages(agent_id)) == 1, messages(agent_id)
assert len(alice.get(f"/api/agents/{agent_id}/routines").json()["suggerees"]) == len(p["routines"])
again = alice.post("/api/agents", json={"name": p["nom"], "preset": "veille"}).json()["id"]
assert again != agent_id and len(messages(again)) == 1 and len(messages(agent_id)) == 1
print("6. reconfigurer ou recréer n'écrit pas un second message ni ne double les routines")

# --- 7. Supprimer l'agent emporte ses routines à activer -----------------------------------------------------------------------
gone = created["finances"]


async def deleted(agent_id):
    return None


main.hermes.delete_container = deleted
assert alice.delete(f"/api/agents/{gone}").status_code == 200
assert presets.suggested(gone) == []
print("7. un agent supprimé ne laisse aucune routine à activer")

# --- 8. L'agent connaît son premier message et active une routine suggérée sans doublon, par lui ou par l'écran ---------------
from noah import relay  # noqa: E402

fresh = alice.post("/api/agents", json={"name": "Assistant", "preset": "assistant"}).json()["id"]
conv = main._main_conversation(fresh, ALICE)
told = machine.pop_context(conv)
welcome = messages(fresh)[0]["text"]
assert welcome in told and "suggeree-<id> reprendre" in told and "N'en crée pas une nouvelle" in told, told
assert "ou demande-le-moi" in welcome, welcome
bot = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for(fresh)}"})
s1, s2, s3 = bot.get("/agent-api/routines").json()["suggerees"]
calls.clear()
r = bot.post("/agent-api/routines/action", json={"id": f"suggeree-{s1['id']}", "action": "reprendre"})
assert r.status_code == 200 and r.json()["name"] == s1["nom"] and r.json()["enabled"], r.text
assert [x["id"] for x in presets.suggested(fresh)] == [s2["id"], s3["id"]], "activée par l'agent : elle n'est plus à activer"
assert bot.post("/agent-api/routines/action", json={"id": f"suggeree-{s1['id']}", "action": "reprendre"}).status_code == 404
assert alice.post(f"/api/agents/{fresh}/routines/suggerees/{s1['id']}/activer").status_code == 404, "ni par l'écran ensuite"
assert bot.post("/agent-api/routines/action", json={"id": f"suggeree-{s2['id']}", "action": "pause"}).status_code == 400
assert len([c for c in calls if c[1] == "routine_creer"]) == 1
# Il la recrée à la main sous le même nom au lieu de l'activer : la suggestion est consommée, l'écran n'en fait pas une seconde.
assert bot.post("/agent-api/routines", json={"nom": f"  {s2['nom'].upper()} ", "consigne": s2["consigne"], "quand": s2["horaire"]}).status_code == 200
assert [x["id"] for x in presets.suggested(fresh)] == [s3["id"]]
assert alice.post(f"/api/agents/{fresh}/routines/suggerees/{s2['id']}/activer").status_code == 404
# Une routine de ce nom existe déjà (faite avant) : « Activer » la rend, sans en créer une autre.
crons[fresh].append({"id": "deja", "name": s3["nom"], "prompt": s3["consigne"], "schedule_display": s3["horaire"], "enabled": True, "state": "scheduled"})
r = alice.post(f"/api/agents/{fresh}/routines/suggerees/{s3['id']}/activer")
assert r.status_code == 200 and r.json()["id"] == "deja", r.text
assert presets.suggested(fresh) == [] and len([c for c in calls if c[1] == "routine_creer"]) == 2
assert sorted(j["name"] for j in crons[fresh]) == sorted([s1["nom"], f"  {s2['nom'].upper()} ", s3["nom"]]), crons[fresh]
print("8. l'agent a son premier message en tête ; il active une routine suggérée par « reprendre » ; aucun chemin ne fait de doublon")

print("OK")
