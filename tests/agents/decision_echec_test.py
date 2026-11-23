"""X15 : un modèle de décision qui échoue se voit, une fois. Une clé refusée produit une carte « Pour toi » avec le bouton pour en changer, rien ne
s'ajoute tant que ce modèle échoue, « Plus tard » la ferme pour de bon, et le premier succès remet le compte à zéro. Vrai decision.ask contre un
faux fournisseur ; le passage de l'agent qui compte « rien de neuf » est dans proactif_test.py (27).

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/decision_echec_test.py"
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
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, decision, main, relay, watch  # noqa: E402

db.init()
watch.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "cerveau-x")
db.set_setting("api_key", "sk-or-cle-refusee", secret=True)
state = {"refuse": True}


def upstream(request: httpx.Request) -> httpx.Response:
    if state["refuse"]:
        return httpx.Response(401, json={"error": {"message": "Invalid API key sk-or-cle-refusee", "code": 401}})
    return httpx.Response(200, json={"id": "x", "choices": [{"index": 0, "message": {"role": "assistant", "content": '{"pertinent": true, "retenues": [2]}'}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "cost": 0.0001}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
A = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'test', 'web')}"})
B = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(bruno, 'test', 'web')}"})


def cards(client) -> list[dict]:
    return [r for r in client.get("/api/a-toi").json() if r.get("type") == "decision"]


def ask() -> str:
    try:
        asyncio.run(decision.ask("a1", "Tu trions.", "[1] un courriel", max_tokens=50))
    except decision.DecisionError as e:
        return str(e)
    return ""


assert cards(A) == [], "rien avant la première panne"
reason = ask()
assert reason == "Le fournisseur a refusé la clé.", reason
found = cards(A)
assert len(found) == 1 and found[0]["modele"] == "cerveau-x" and found[0]["raison"] == reason and found[0]["id"] == "decision-echec", found
assert "sk-or-cle-refusee" not in json.dumps(A.get("/api/a-toi").json()), "la clé n'est jamais à l'écran"
assert cards(B) == [], "un autre compte (qui n'est pas le propriétaire) ne voit pas la carte"
print("1. une clé refusée produit une carte « Pour toi », pour le propriétaire seulement")

for _ in range(3):  # trois petits travaux de plus échouent : rien ne s'ajoute
    ask()
assert len(cards(A)) == 1, "une fois, pas à chaque échec"
print("2. tant que ce modèle échoue, la personne le voit une fois")

assert B.delete("/api/decision/echec").status_code == 403
assert A.delete("/api/decision/echec").status_code == 200 and cards(A) == []
ask()
assert cards(A) == [], "« Plus tard » : la carte ne revient pas pour ce modèle"
print("3. « Plus tard » ferme la carte pour de bon")

state["refuse"] = False
assert ask() == "" and decision._failure() == {}, "le premier succès remet le compte à zéro"
state["refuse"] = True
ask()
assert len(cards(A)) == 1, "une nouvelle panne, après un succès, se voit de nouveau"
print("4. un succès remet le compte à zéro : la panne suivante se voit")

# Changer de modèle de décision (le bouton de la carte) : la carte part, le nouveau modèle fait ses preuves.
state["refuse"] = False
r = A.post("/api/decision", json={"modele": "petit-modele"})
assert r.status_code == 200, r.text
assert cards(A) == [] and decision._failure() == {}
print("5. changer de modèle de décision depuis la carte la retire")
print("modèle de décision qui échoue : tout est vert")
