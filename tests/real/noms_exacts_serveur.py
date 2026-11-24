"""Le vrai serveur et la vraie interface, avec Claude Code (ton ordinateur) comme cerveau et un tour déjà passé par « haiku » : le choix de modèle
doit montrer « Haiku · claude-haiku-5-5 ». « sonnet » est connu par la dernière mesure d'utilisation, « opus » ne l'est pas (l'alias seul). Voir
tools/eval/noms-exacts.mjs.

    docker run --rm -p 127.0.0.1:8099:8099 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/noms_exacts_serveur.py"
"""
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import uvicorn  # noqa: E402

from noah import auth, db, desktop, hermes, machine, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Bis', '', 'k2', ?)", (alice,))
CC = "ordinateur:claude-code"
db.set_setting("provider", CC)
db.set_setting("model", "haiku")
db.set_setting("onboarded", "1")
db.set_setting("model_a2", "opus")  # un agent avec son propre modèle, dont le nom exact n'est pas connu
db.set_setting("model_provider_a2", CC)
db.set_setting(f"pc_modeles:{alice}:{CC}", json.dumps(["sonnet", "opus", "haiku"]))
desktop._remember_exact(alice, CC, "haiku", "claude-haiku-5-5")  # un tour déjà passé par haiku
desktop._remember_usage(alice, {"claude": {"offre": "max", "modele": "claude-sonnet-5-5", "mesure_le": 1_795_000_000_000, "tours": 3, "fenetres": []}})
main._new_conversation(alice, "a1", "Conversation", main=True)
main._new_conversation(alice, "a2", "Conversation", main=True)


async def healthy(*a, **k):
    return True


async def admin(agent_id, action, payload=None):
    return {"memoire": {"memory": [], "user": [], "limites": {"memory": 2200, "user": 1375}}}.get(action, {"applications": [], "google": {}})


hermes.health = healthy
machine.admin = admin
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning")
