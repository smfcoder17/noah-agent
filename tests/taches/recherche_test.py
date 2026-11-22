"""0.4.2 : `GET /api/recherche?q=…` cherche pour de vrai, avec des données réelles de test (vrais fils, vraies tâches, vrais fichiers servis par
un faux lanceur) : les résultats sont groupés par agent, `agents=` filtre, un invité ne lit jamais les fils du propriétaire, une clé collée
sort masquée, et un lanceur qui ne répond pas ne retient pas le reste.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/recherche_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main, recherche, taches  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    for agent_id, name, owner in (("a", "Alma", alice), ("c", "Cléo", alice), ("z", "Zoé", alice), ("g", "Gaspard", bruno)):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, owner))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a', ?, 'usage')", (bruno,))

FICHIERS = {
    "a": [{"path": "outputs/newsletter-jeudi.md", "size": 120, "modified": 10}, {"path": "outputs/budget.csv", "size": 5, "modified": 20}],
    "c": [{"path": "outputs/visuel-newsletter.png", "size": 900, "modified": 30}],
    "z": "lanceur absent",
}


async def faux_fichiers(agent_id: str):
    if FICHIERS.get(agent_id) == "lanceur absent":
        raise RuntimeError("lanceur absent")
    return FICHIERS.get(agent_id, [])


hermes.list_files = faux_fichiers


def web(user: int) -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"})


A, B = web(alice), web(bruno)
fils = {(u, a): main._new_conversation(u, a, "Conversation", main=True) for u, a in ((alice, "a"), (alice, "c"), (alice, "z"), (bruno, "a"), (bruno, "g"))}
main._save_message(fils[(alice, "a")], "user", "Prépare la newsletter de jeudi, avec 50 % de remise.")
main._save_message(fils[(alice, "a")], "agent", "La newsletter est prête : trois annonces et un visuel.")
main._save_message(fils[(alice, "a")], "agent", "Voici ta clé : sk-or-v1-0123456789abcdef0123456789abcdef pour la newsletter.")
main._save_message(fils[(alice, "c")], "agent", "Le visuel de la newsletter est fini.")
main._save_message(fils[(alice, "c")], "trace", "newsletter", None)  # une trace ne se cherche pas
main._save_message(fils[(bruno, "a")], "user", "Une question privée de Bruno sur la newsletter.")
main._save_message(fils[(bruno, "g")], "agent", "Rien à voir.")
conv_tache = main._new_conversation(alice, "a", "Rédiger la newsletter")
taches.creer(conv_tache, "sous_tache", titre="Rédiger la newsletter", consigne="Rédiger la newsletter")
main._save_message(conv_tache, "agent", "Fini.")

d = A.get("/api/recherche", params={"q": "newsletter"}).json()
par = {x["id"]: x for x in d["agents"]}
assert d["q"] == "newsletter" and set(par) == {"a", "c"}, d
assert par["a"]["nom"] == "Alma" and par["c"]["nom"] == "Cléo"
assert len(par["a"]["messages"]) >= 2 and all("newsletter" in m["texte"].lower() for m in par["a"]["messages"]), par["a"]["messages"]
assert par["a"]["messages"][0]["conversation_id"] == fils[(alice, "a")] or par["a"]["messages"][0]["id"] > 0
assert [t["titre"] for t in par["a"]["taches"]] == ["Rédiger la newsletter"] and par["a"]["taches"][0]["conversation_id"] == conv_tache
assert [f["path"] for f in par["a"]["fichiers"]] == ["outputs/newsletter-jeudi.md"] and par["c"]["fichiers"][0]["path"] == "outputs/visuel-newsletter.png"
assert len(par["c"]["messages"]) == 1, "une trace ne se cherche pas"
assert d["total"] == sum(x["total"] for x in d["agents"]) > 5
assert "sk-or-v1-0123456789abcdef0123456789abcdef" not in str(d), "une clé collée sort masquée"
assert "Bruno" not in str(d) and "privée" not in str(d), "jamais le fil d'un autre compte"
print("1. un mot : des résultats groupés par agent (messages, tâches, fichiers), un agent sans résultat n'apparaît pas")

d = A.get("/api/recherche", params={"q": "NEWSLETTER", "agents": "c"}).json()
assert [x["id"] for x in d["agents"]] == ["c"], "les agents cochés seulement, sans tenir compte des majuscules"
assert A.get("/api/recherche", params={"q": "inexistant-xyz"}).json() == {"q": "inexistant-xyz", "total": 0, "agents": []}
assert A.get("/api/recherche", params={"q": "n"}).json()["agents"] == [], "un mot trop court ne cherche rien"
assert A.get("/api/recherche", params={"q": "100%"}).json()["total"] == 0 and A.get("/api/recherche", params={"q": "50 %"}).json()["total"] >= 1, "le % se cherche tel quel"
assert A.get("/api/recherche", params={"q": "budget"}).json()["agents"][0]["fichiers"][0]["path"] == "outputs/budget.csv", "un lanceur absent (Zoé) ne retient pas les autres"
print("2. le filtre par agent, les majuscules, un mot trop court, le pourcent, un lanceur muet")

d = B.get("/api/recherche", params={"q": "newsletter"}).json()
assert [x["id"] for x in d["agents"]] == ["a"] and len(d["agents"][0]["messages"]) == 1 and "privée" in d["agents"][0]["messages"][0]["texte"], d
assert d["agents"][0]["taches"] == [], "ni les tâches ni les fils du propriétaire"
assert "Rédiger" not in str(d) and "prête" not in str(d)
print("3. un invité ne lit que ses propres fils et ses propres tâches sur l'agent qu'on lui partage")

assert TestClient(main.app).get("/api/recherche", params={"q": "newsletter"}).status_code in (401, 403)
print("4. sans session : refusé")
print("OK")
