"""Liste des agents sans N+1 (revue serveur 0.1.8, constat 7) : une seule connexion à la base, quel que soit le nombre
d'agents, et exactement les mêmes droits et propriétaires que access.right et access.owner_of.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/liste_agents_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from noah import access, db, main  # noqa: E402

db.init()
with db.connect() as c:
    for uid, name, role in [(1, "franck", "owner"), (2, "alice", "member"), (3, "bob", "member")]:
        c.execute("INSERT INTO users (id, username, pw_hash, role) VALUES (?, ?, ?, ?)", (uid, name, b"x", role))
    # a1 à franck, a2 à alice ; a3 sans owner_id (base ancienne) : sa conversation principale dit à qui il est ;
    # a4 sans owner_id ni conversation : il revient au propriétaire de l'installation.
    for aid, owner in [("a1", 1), ("a2", 2), ("a3", None), ("a4", None)]:
        c.execute("INSERT INTO agents (id, name, api_key, owner_id) VALUES (?, ?, 'k', ?)", (aid, aid, owner))
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, updated_at) VALUES ('c1', 3, 'a3', 't', 1, '2020-01-01')")
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, updated_at) VALUES ('c2', 2, 'a3', 't', 0, '2030-01-01')")
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', 2, 'usage'), ('a2', 3, 'lecture'), ('a3', 1, 'admin')")
    c.execute("INSERT INTO settings (key, value) VALUES ('reasoning_a1', 'high'), ('reasoning_a2', 'n-importe-quoi')")

real_connect = db.connect
opened = {"n": 0}


def counting():
    opened["n"] += 1
    return real_connect()


for user in (1, 2, 3, 99):
    expected_rights = {a: access.right(user, a) for a in ("a1", "a2", "a3", "a4")}
    expected_owners = {a: access.owner_of(a) for a in ("a1", "a2", "a3", "a4")}
    opened["n"] = 0
    db.connect = counting
    try:
        agents, rights, owners, *_ , reasonings = main._agents_listing(user)
    finally:
        db.connect = real_connect
    assert opened["n"] == 1, f"une seule connexion pour toute la liste, pas {opened['n']}"
    assert rights == expected_rights, (user, rights, expected_rights)
    assert owners == expected_owners, (user, owners, expected_owners)
    assert [a["id"] for a in agents] == [a for a in ("a1", "a2", "a3", "a4") if expected_rights[a]], (user, agents)
    assert reasonings.get("a1") == "high"

# Un profil en cours de suppression ne voit plus rien, comme access.right.
access.closing.add(2)
try:
    assert main._agents_listing(2)[0] == [], "un profil qui se ferme ne voit plus aucun agent"
finally:
    access.closing.discard(2)

print("liste des agents : une connexion, mêmes droits et propriétaires que access.right")
