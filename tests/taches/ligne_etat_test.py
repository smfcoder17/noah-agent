"""0.4.0, lot L9b : `GET /api/agents` donne, pour ce compte, de quoi écrire la ligne d'état de chaque agent dans la barre de gauche :
`travail.titre` (sa tâche en cours), `travail.attend` (il attend la personne), `travail.suit` (les tâches ouvertes de l'équipe, rendu au
chef d'équipe seulement), `chef`, `sans_message`. Les champs d'avant ne bougent pas. Un invité ne voit pas les tâches d'un autre compte.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/ligne_etat_test.py"
"""
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main, questions, taches  # noqa: E402


async def healthy(*a, **k):
    return True


main._health = healthy
db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    for i, (agent_id, name, owner) in enumerate((("noah", "Noah", alice), ("lea", "Léa", alice), ("hugo", "Hugo", alice), ("sam", "Sam", alice))):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id, created_at) VALUES (?, ?, 'Son rôle', 'k', ?, datetime('now', ?))", (agent_id, name, owner, f"+{i} seconds"))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('lea', ?, 'usage')", (bruno,))


def web(user: int) -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"})


A, B = web(alice), web(bruno)
for agent in ("noah", "lea", "hugo", "sam"):
    main._new_conversation(alice, agent, "Conversation", main=True)
main._new_conversation(bruno, "lea", "Conversation", main=True)


def tache(user: int, agent: str, titre: str, etat: str = "encours") -> str:
    conv = main._new_conversation(user, agent, titre)
    tid = taches.creer(conv, "sous_tache", titre=titre, consigne=titre, etat=etat)
    return conv, tid


def agents(client: TestClient) -> dict:
    r = client.get("/api/agents")
    assert r.status_code == 200, r.text
    return {a["id"]: a for a in r.json()}


# Un agent sans rien à faire.
a = agents(A)
assert a["lea"]["travail"] == {"titre": None, "attend": False, "suit": 0}, a["lea"]["travail"]
assert a["noah"]["chef"] is True and not any(a[x]["chef"] for x in ("lea", "hugo", "sam")), {k: v["chef"] for k, v in a.items()}
print("1. le premier agent créé est le chef d'équipe, un agent sans travail n'a ni titre ni attente")

# Les champs d'avant sont là, intacts.
assert {"id", "name", "role", "online", "step", "tasks", "state", "color", "shape", "detail", "pinned", "model", "mode", "raisonnement", "droit", "partage", "partage_par"} <= set(a["noah"])

# Une tâche en cours : son titre. La plus récente.
conv_visuel, t_visuel = tache(alice, "lea", "Créer le visuel d'en-tête")
with db.connect() as c:
    c.execute("UPDATE taches SET maj = ? WHERE id = ?", (time.time() - 100, t_visuel))
tache(alice, "lea", "Mise au format 1200 par 600")
a = agents(A)
assert a["lea"]["travail"]["titre"] == "Mise au format 1200 par 600" and a["lea"]["travail"]["attend"] is False, a["lea"]["travail"]
print("2. une tâche en cours : son titre, la plus récente")

# Chef d'équipe avec trois tâches ouvertes : suit 3 ; les autres : 0.
conv_envoi, t_envoi = tache(alice, "hugo", "Programmer l'envoi")
a = agents(A)
assert a["noah"]["travail"]["suit"] == 3, a["noah"]["travail"]
assert all(a[x]["travail"]["suit"] == 0 for x in ("lea", "hugo", "sam")), {k: v["travail"] for k, v in a.items()}
print("3. trois tâches ouvertes : le chef d'équipe en suit 3, les autres 0")

# Une tâche qui attend la personne (accord en cours dans le travail).
main.task_state[conv_envoi] = "approve"
a = agents(A)
assert a["hugo"]["travail"]["attend"] is True and a["hugo"]["travail"]["titre"] is None and a["lea"]["travail"]["attend"] is False, a["hugo"]["travail"]
assert a["noah"]["travail"]["suit"] == 3
main.task_state.pop(conv_envoi)
with db.connect() as c:  # une tâche « attend » dans la base, aussi
    c.execute("UPDATE taches SET etat = 'attend' WHERE id = ?", (t_envoi,))
assert agents(A)["hugo"]["travail"]["attend"] is True
with db.connect() as c:
    c.execute("UPDATE taches SET etat = 'fini' WHERE id = ?", (t_envoi,))
a = agents(A)
assert a["hugo"]["travail"] == {"titre": None, "attend": False, "suit": 0} and a["noah"]["travail"]["suit"] == 2, a["hugo"]["travail"]
print("4. attend la personne : accord en cours ou tâche en attente ; une tâche finie n'est plus suivie")

# Une question qui lui est destinée, en attente.
with db.connect() as c:
    c.execute("INSERT INTO questions (id, owner_id, tache_id, conversation_id, de, a, titre, etat, cree, maj) VALUES ('q1', ?, NULL, ?, 'lea', 'sam', 'Quelle heure ?', 'attend', ?, ?)",
              (alice, conv_visuel, time.time(), time.time()))
assert agents(A)["sam"]["travail"]["attend"] is True
print("5. une question qui lui est destinée attend : il attend")

# sans_message.
with db.connect() as c:
    c.execute("DELETE FROM messages")
main._save_message(main._main_conversation("noah", alice), "user", "Bonjour")
a = agents(A)
assert a["noah"]["sans_message"] is False and a["sam"]["sans_message"] is True and a["lea"]["sans_message"] is True, {k: v["sans_message"] for k, v in a.items()}
main._save_message(main._main_conversation("sam", alice), "trace", "x")
assert agents(A)["sam"]["sans_message"] is True, "une trace n'est pas un message"
print("6. un agent neuf (aucun message de ce compte) : sans_message")

# Un invité : ses agents seulement, jamais les tâches d'Alice, jamais chef de l'équipe d'Alice.
b = agents(B)
assert set(b) == {"lea"}, set(b)
assert b["lea"]["travail"] == {"titre": None, "attend": False, "suit": 0} and b["lea"]["chef"] is False and b["lea"]["sans_message"] is True, b["lea"]
tache(bruno, "lea", "Une tâche de Bruno")
b = agents(B)
assert b["lea"]["travail"]["titre"] == "Une tâche de Bruno" and b["lea"]["travail"]["suit"] == 0, b["lea"]["travail"]
assert agents(A)["lea"]["travail"]["titre"] == "Mise au format 1200 par 600", "la tâche de Bruno n'est pas dans la barre d'Alice"
print("7. un invité ne voit pas les tâches d'un autre compte, et n'est pas chef sur l'agent d'un autre")
print("OK")
