"""0.4.0, lot L9b : `GET /api/activite` rend d'un coup, pour tous les agents que le compte peut lire, leurs tâches (même forme que
`GET /api/taches`, étapes comprises) et, pour ceux qu'il administre, leurs routines avec le voyant. Un invité ne voit que ses agents
et ses tâches, jamais celles du propriétaire ; aucun `docker exec`.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/activite_test.py"
"""
import json
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main, taches  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    for agent_id, name, owner in (("a", "Alma", alice), ("c", "Cléo", alice), ("z", "Zoé", alice), ("g", "Gaspard", bruno)):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, owner))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a', ?, 'usage')", (bruno,))  # invité : lit et parle, n'administre pas


def web(user: int) -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"})


A, B = web(alice), web(bruno)
for user, agent in ((alice, "a"), (alice, "c"), (bruno, "a"), (bruno, "g")):
    main._new_conversation(user, agent, "Conversation", main=True)


def tache(user: int, agent: str, titre: str, etapes=None) -> str:
    conv = main._new_conversation(user, agent, titre)
    tid = taches.creer(conv, "sous_tache", titre=titre, consigne=titre)
    if etapes:
        main._save_message(conv, "agent", "Fini.", json.dumps({"etapes": etapes}))
    return tid


t_a = tache(alice, "a", "Rédiger la newsletter", ["Brief lu.", "Texte écrit."])
t_c = tache(alice, "c", "Créer le visuel")
t_b = tache(bruno, "a", "Une tâche de Bruno sur Alma")
t_g = tache(bruno, "g", "Une tâche de Bruno sur Gaspard")
now = time.time()
with db.connect() as c:
    c.execute("UPDATE taches SET maj = ? WHERE id = ?", (now + 5, t_c))
    for agent, routine, nom, fichier, passe in (("a", "r1", "Veille", "1", now - 100), ("a", "r1", "Veille", "2", now - 50), ("c", "r2", "Sauvegarde", "1", now - 10)):
        c.execute("INSERT INTO routine_passages (agent_id, routine_id, nom, fichier, etat, resume, rendu, passe_a) VALUES (?, ?, ?, ?, 'ok', 'Rien à signaler.', 'Rien.', ?)",
                  (agent, routine, nom, fichier, passe))

r = A.get("/api/activite")
assert r.status_code == 200, r.text
d = r.json()
assert sorted(d) == ["non_vues", "propositions_expirees", "routines", "taches"], sorted(d)
assert [t["titre"] for t in d["taches"]][:1] == ["Créer le visuel"], "la plus récemment active d'abord"
assert {t["id"] for t in d["taches"]} == {t_a, t_c}, "seulement les tâches de ce compte, sur tous ses agents"
assert {t["agent"]["nom"] for t in d["taches"]} == {"Alma", "Cléo"}
assert next(t for t in d["taches"] if t["id"] == t_a)["etapes"] == ["Brief lu.", "Texte écrit."]
assert sorted(d["taches"][0]) == sorted(A.get("/api/taches?agent_id=c").json()["taches"][0]), "la même forme que GET /api/taches"
assert {(x["agent"]["id"], x["id"]) for x in d["routines"]} == {("a", "r1"), ("c", "r2")}, d["routines"]
assert all(set(x["agent"]) == {"id", "nom"} for x in d["routines"])
assert d["non_vues"] == 3 and all(x["vient"] for x in d["routines"]), d["non_vues"]
assert d["routines"][0]["id"] == "r2", "les routines passées en dernier d'abord"
print("1. le propriétaire voit les tâches et les routines de tous ses agents, étapes comprises, voyant et total")

d = B.get("/api/activite").json()
assert {t["id"] for t in d["taches"]} == {t_b, t_g}, "l'invité ne voit que ses propres tâches, sur ses agents et celui qu'on lui partage"
assert d["routines"] == [] and d["non_vues"] == 0, "sans le droit admin, pas de routines"
assert "Rédiger la newsletter" not in json.dumps(d) and "Créer le visuel" not in json.dumps(d)
print("2. un invité ne voit ni les tâches du propriétaire, ni ses routines")

with db.connect() as c:
    c.execute("DELETE FROM agent_shares WHERE agent_id = 'a' AND user_id = ?", (bruno,))
d = B.get("/api/activite").json()
assert {t["id"] for t in d["taches"]} == {t_g}, "un agent qui n'est plus partagé disparaît"
print("3. un partage retiré : l'agent et ses tâches disparaissent de sa page")

assert web(alice).get("/api/activite").status_code == 200
assert TestClient(main.app).get("/api/activite").status_code in (401, 403)
print("4. sans session : refusé")
print("OK")
