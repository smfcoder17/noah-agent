"""Modèles d'agent en anglais : chaque champ visible a sa traduction (presets.en.json), la langue suit l'en-tête Accept-Language,
et sans en-tête rien ne change (français). L'horaire des routines vient toujours du `quand` français.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/presets_en_test.py"
"""
import copy
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def outside(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"appel sortant interdit : {request.url}")


class Sandbox(httpx.AsyncClient):
    def __init__(self, *a, **k):
        k["transport"] = httpx.MockTransport(outside)
        super().__init__(*a, **k)


httpx.AsyncClient = Sandbox

from noah import auth, db, hermes, main, presets  # noqa: E402

souls: list[str] = []


async def fake_create(agent_id):
    return "cle-" + agent_id


async def fake_provision(agent, soul):
    souls.append(soul)


async def healthy(a):
    return True


hermes.create_container = fake_create
main._provision, main._health = fake_provision, healthy
main.current_model = lambda: {"provider": "test", "model": "test", "has_key": True}

db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
db.set_setting("onboarded", "1")
TOKEN = auth.new_session(ALICE, "test", "web")


def client(langue: str | None) -> TestClient:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if langue is not None:
        headers["Accept-Language"] = langue
    return TestClient(main.app, headers=headers, raise_server_exceptions=False)


def messages(agent_id: str) -> list[str]:
    with db.connect() as c:
        return [r["text"] for r in c.execute("SELECT m.text FROM messages m JOIN conversations v ON v.id = m.conversation_id "
                                             "WHERE v.agent_id = ? AND v.main = 1 ORDER BY m.id", (agent_id,))]


# --- 1. Chaque champ visible de chaque modèle a son anglais, listes de même longueur -------------------------------------------
presets.check_en(presets.DATA, presets.EN)
for p in presets.DATA["presets"]:
    t = presets.EN["presets"][p["id"]]
    for field in ("nom", "accroche", "role"):
        assert t[field] and t[field] != p[field], (p["id"], field)  # traduit, pas recopié
    assert all(a != b for a, b in zip(t["demandes"], p["demandes"])), p["id"]
    assert all(a[k] != b[k] for a, b in zip(t["routines"], p["routines"]) for k in ("nom", "quand", "consigne")), p["id"]
    assert [len(x) for x in (t["demandes"], t["routines"], t["connexions"])] == [len(x) for x in (p["demandes"], p["routines"], p["connexions"])], p["id"]
for change in (
    lambda e: e["presets"].pop("veille"),  # un modèle sans traduction
    lambda e: e["presets"]["assistant"].pop("accroche"),  # un champ visible manquant
    lambda e: e["presets"]["assistant"]["routines"].pop(),  # une routine de moins
    lambda e: e["presets"]["assistant"]["demandes"].pop(),  # une demande de moins
    lambda e: e["presets"]["assistant"]["connexions"].pop(),  # une connexion de moins
    lambda e: e["presets"]["assistant"]["routines"][0].pop("consigne"),
    lambda e: e["presets"]["assistant"].update(role="x"),
    lambda e: e["defaut"].update(demandes=["one"]),
):
    bad = copy.deepcopy(presets.EN)
    change(bad)
    try:
        presets.check_en(presets.DATA, bad)
    except (AssertionError, KeyError):
        continue
    raise AssertionError("traduction incomplète acceptée")
print("1. chaque modèle traduit : nom, accroche, rôle, demandes, routines, connexions ; une traduction incomplète est refusée")

# --- 2. La liste suit l'en-tête : en → anglais ; sans en-tête ou fr → français, inchangé ---------------------------------------
fr = client(None).get("/api/presets").json()
assert fr["presets"] == presets.DATA["presets"] and fr["defaut"] == presets.DATA["defaut"], "sans en-tête, le français a changé"
assert client("fr").get("/api/presets").json() == fr and client("fr-FR,fr;q=0.9").get("/api/presets").json() == fr
en = client("en").get("/api/presets").json()
assert client("en-US,en;q=0.9").get("/api/presets").json() == en and client("de").get("/api/presets").json() == en
assert en["defaut"]["demandes"] == presets.EN["defaut"]["demandes"], en["defaut"]
assert en["version"] == fr["version"] and [p["id"] for p in en["presets"]] == [p["id"] for p in fr["presets"]]
for p_en, p_fr in zip(en["presets"], fr["presets"]):
    t = presets.EN["presets"][p_fr["id"]]
    assert set(p_en) == set(p_fr), p_en.keys()
    assert {k: p_en[k] for k in presets.VISIBLES} == t, p_fr["id"]
    assert {k: p_en[k] for k in ("id", "couleur", "shape", "detail")} == {k: p_fr[k] for k in ("id", "couleur", "shape", "detail")}
assert en["presets"][0]["nom"] == "Personal assistant" and fr["presets"][0]["nom"] == "Assistant personnel"
print("2. GET /api/presets : anglais avec Accept-Language en, français sans en-tête ou en fr")

# --- 3. Créer un agent en anglais : rôle, routines en pause et premier message en anglais ; horaire du français ----------------
p_fr = presets.BY_ID["assistant"]
t = presets.EN["presets"]["assistant"]
r = client("en-US").post("/api/agents", json={"name": "Sam", "preset": "assistant"})
assert r.status_code == 200, r.text
sam = r.json()["id"]
assert souls and t["role"] in souls[-1], "le rôle anglais n'est pas parti dans la machine"
shown = presets.suggested(sam)  # ce que GET /api/agents/{id}/routines rend sous « suggerees »
assert [s["nom"] for s in shown] == [x["nom"] for x in t["routines"]], shown
assert [s["consigne"] for s in shown] == [x["consigne"] for x in t["routines"]], shown
assert [s["horaire"] for s in shown] == [presets.horaire(x["quand"]) for x in p_fr["routines"]], shown
assert [s["quand"] for s in shown] == [x["quand"].split(",")[0] for x in t["routines"]], shown
said = messages(sam)
assert len(said) == 1 and said[0].startswith("Hi, I'm Sam. “Personal assistant” template: handles your email"), said
assert all(f"**{x['nom']}**" in said[0] for x in t["routines"]) and all(d in said[0] for d in t["demandes"]), said[0]
assert "“Turn on”" in said[0] and not any(w in said[0] for w in ("Bonjour", "Modèle", "pause tant", "Pour commencer")), said[0]
conv = main._main_conversation(sam, ALICE)
assert json.loads(db.get_setting(f"contexte_{conv}")) == [presets.agent_note(said[0], True, "en")]
assert presets.agent_note(said[0], True, "en").startswith("[You wrote this")
# Sans routine : la phrase fixe passe aussi en anglais.
r = client("en").post("/api/agents", json={"name": "Rae", "preset": "recherche"})
said = messages(r.json()["id"])
assert said[0].startswith("Hi, I'm Rae. “Research” template:") and "I work when you ask me to." in said[0], said
print("3. agent créé en anglais : rôle, routines (nom, quand, consigne) et premier message anglais, horaire tiré du français")

# --- 4. Sans en-tête, la création reste en français ----------------------------------------------------------------------------
r = client(None).post("/api/agents", json={"name": "Léa", "preset": "assistant"})
lea = r.json()["id"]
assert p_fr["role"] in souls[-1]
shown = presets.suggested(lea)
assert [s["nom"] for s in shown] == [x["nom"] for x in p_fr["routines"]], shown
said = messages(lea)
assert said[0] == presets.first_message("Léa", p_fr) and said[0].startswith("Bonjour, je suis Léa."), said
print("4. sans en-tête : agent, routines et premier message en français, comme avant")

print("OK")
