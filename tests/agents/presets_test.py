"""Modèles d'agent : chaque modèle crée un agent valide, un modèle inconnu est refusé, rien ne s'active sans accord.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/presets_test.py"
"""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

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

machines: list[str] = []
souls: list[str] = []


async def fake_create(agent_id):
    machines.append(agent_id)
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
BRUNO = auth.create_user("bruno", "motdepasse-b")
db.set_setting("onboarded", "1")


def client(user: int) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


def settings() -> dict:
    with db.connect() as c:
        return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings")}


def agents(who: TestClient) -> dict:
    return {a["id"]: a for a in who.get("/api/agents").json()}


alice, bruno = client(ALICE), client(BRUNO)

# --- 1. Le fichier livré : versionné, borné, sans rien d'exécutable ------------------------------------------------------------
listed = alice.get("/api/presets")
assert listed.status_code == 200, listed.text
data = listed.json()
assert data["version"] >= 1 and len(data["defaut"]["demandes"]) == 4, data["defaut"]
ids = [p["id"] for p in data["presets"]]
# 0.1.9 : trois modèles de plus (voyages et sorties, coach d'apprentissage, bricoleur d'apps), à dessein.
assert 4 <= len(ids) <= 9 and len(set(ids)) == len(ids), ids
assert {"voyages", "apprentissage", "applications"} <= set(ids), ids
veilles = [r for r in presets.BY_ID["assistant"]["routines"] if r["nom"].startswith("Veille")]
assert len(veilles) == 2 and all("en pause" in r["quand"] for r in veilles), veilles  # proposées, en pause tant qu'on ne les active pas
assert any("ajoute-la à mon agenda" in r["consigne"] and "en une phrase" in r["consigne"] for r in veilles), veilles
assert presets.ROLE_MAX == 4000 and main.AgentBody(name="x", role="x" * presets.ROLE_MAX)  # la même limite que la création
for p in data["presets"]:
    assert 500 <= len(p["role"]) <= 1200 <= presets.ROLE_MAX, (p["id"], len(p["role"]))
    assert len(p["demandes"]) == 4 and all(0 < len(d) <= 70 for d in p["demandes"]), p["id"]
    main.AgentLook(color=p["couleur"], shape=p["shape"], detail=p["detail"])  # les valeurs que PATCH /look accepte
    assert "open source" not in json.dumps(p, ensure_ascii=False).lower()
    # Aucun droit, aucun mode d'accord, aucune compétence, aucun outil : la liste des champs est fermée.
    assert set(p) == {"id", "nom", "accroche", "couleur", "shape", "detail", "role", "demandes", "routines", "connexions"}, set(p)
    assert all(set(r) == {"nom", "quand", "consigne"} for r in p["routines"]), p["routines"]
assert TestClient(main.app).get("/api/presets").status_code == 401
print(f"1. {len(ids)} modèles valides, rôles dans la limite, champs fermés, route réservée aux comptes")

# --- 2. Un fichier trafiqué est refusé au chargement ---------------------------------------------------------------------------
for change in (
    lambda d: d["presets"][0].update(role="x" * 4001),
    lambda d: d["presets"][0].update(shape="étoile"),
    lambda d: d["presets"][0].update(mode="auto"),
    lambda d: d["presets"][0]["routines"].append({"nom": "n", "quand": "q", "consigne": "c", "en_pause": False}),
    lambda d: d["presets"][0].update(demandes=["une seule"]),
    lambda d: d["presets"].append(copy.deepcopy(d["presets"][0])),
):
    bad = copy.deepcopy(presets.DATA)
    change(bad)
    try:
        presets.check(bad)
    except (AssertionError, KeyError):
        continue
    raise AssertionError("fichier trafiqué accepté")
presets.check(copy.deepcopy(presets.DATA))
print("2. rôle trop long, forme inconnue, champ en trop, routine active, demandes manquantes, doublon : refusés")

# --- 3. Chaque modèle crée un agent valide, une seule fois ----------------------------------------------------------------------
before = settings()
created = {}
for p in data["presets"]:
    r = alice.post("/api/agents", json={"name": p["nom"], "preset": p["id"]})
    assert r.status_code == 200, (p["id"], r.text)
    created[p["id"]] = r.json()["id"]
mine = agents(alice)
for p in data["presets"]:
    a = mine[created[p["id"]]]
    assert (a["name"], a["role"], a["color"], a["shape"], a["detail"]) == (p["nom"], p["role"], p["couleur"], p["shape"], p["detail"]), a
    assert a["droit"] == "proprietaire" and not a["mode"] and not a["model"] and not a["partage"], a
    assert any(p["role"] in s for s in souls), p["id"]  # la persona part bien dans la machine de l'agent
assert len(machines) == len(ids), machines
added = {k: v for k, v in settings().items() if before.get(k) != v}
# 0.2.0 : le premier message, écrit par Noah à la place de l'agent, lui est aussi donné en contexte (comme un résultat de routine).
# Exactement ce texte, rien d'autre : ni mode, ni plafond, ni accord.
welcomed = {}
for i in ids:
    conv = main._main_conversation(created[i], ALICE)
    with db.connect() as c:
        first = c.execute("SELECT text FROM messages WHERE conversation_id = ? ORDER BY id", (conv,)).fetchall()
    assert len(first) == 1, (i, first)
    welcomed[f"contexte_{conv}"] = json.dumps([presets.agent_note(first[0]["text"], bool(presets.BY_ID[i]["routines"]))])
assert added == {**{f"preset_{created[i]}": i for i in ids}, **welcomed}, added  # rien d'autre : ni mode, ni plafond, ni accord
with db.connect() as c:
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    for t in ("mcp_tools", "agent_shares", "proactive"):
        if t in tables:
            assert c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0, t
assert alice.get("/api/presets").json()["agents"] == {created[i]: i for i in ids}
print("3. un agent par modèle : rôle, couleur, forme, détail ; aucun réglage de droit, aucune routine, aucun partage")

# --- 4. La personne garde la main : son rôle passe avant celui du modèle, et tout se modifie ensuite ----------------------------
own = alice.post("/api/agents", json={"name": "À moi", "role": "Tu fais ce que je dis.", "preset": ids[0]}).json()["id"]
agent = agents(alice)[own]
assert agent["role"] == "Tu fais ce que je dis." and agent["color"] == presets.BY_ID[ids[0]]["couleur"], agent
assert alice.patch(f"/api/agents/{own}/look", json={"color": "#112233", "shape": ""}).status_code == 200
assert alice.patch(f"/api/agents/{own}", json={"name": "À moi", "role": "Autre rôle.", "preset": ids[1]}).status_code == 200
agent = agents(alice)[own]
assert (agent["role"], agent["color"], agent["shape"]) == ("Autre rôle.", "#112233", ""), agent
assert alice.get("/api/presets").json()["agents"][own] == ids[0], "un PATCH ne réapplique pas de modèle"
print("4. rôle écrit par la personne gardé ; modifier l'agent ne réapplique rien")

# --- 5. Partir de zéro, modèle inconnu, cloisonnement --------------------------------------------------------------------------
n = len(machines)
zero = alice.post("/api/agents", json={"name": "Vide"}).json()["id"]
agent = agents(alice)[zero]
assert (agent["role"], agent["color"], agent["shape"]) == ("", "", "") and zero not in alice.get("/api/presets").json()["agents"], agent
for bad in ("inconnu", "../presets", "x" * 41):
    r = alice.post("/api/agents", json={"name": "Raté", "preset": bad})
    assert r.status_code in (400, 422), (bad, r.status_code)
    if r.status_code == 400:
        assert "modèle d'agent" in r.json()["detail"], r.text
assert len(machines) == n + 1 and "Raté" not in [a["name"] for a in agents(alice).values()], "un modèle inconnu a créé une machine"
assert bruno.get("/api/presets").json()["agents"] == {}, "les agents d'un autre compte se lisent"
assert bruno.get("/api/presets").json()["presets"] == data["presets"]
print("5. partir de zéro inchangé ; modèle inconnu refusé sans machine ; un compte ne voit pas les agents d'un autre")

# --- 6. Le fichier n'a pas été touché --------------------------------------------------------------------------------------------
assert json.loads((Path(presets.__file__).parent / "presets.json").read_text(encoding="utf-8")) == presets.DATA
routes = {(m, r.path) for r in main.app.routes for m in getattr(r, "methods", None) or ()}
assert {m for m, path in routes if path.startswith("/api/presets")} == {"GET"}, "une route écrit les modèles"
print("6. presets.json intact, aucune route pour l'écrire")

print("OK")
