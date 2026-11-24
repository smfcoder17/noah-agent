"""Le vrai serveur et la vraie interface, avec un faux moteur : taper @ et /, choisir, envoyer, et lire ce que le moteur reçoit. Voir tools/eval/citer.mjs.

    docker run --rm -p 127.0.0.1:8099:8099 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/citer_serveur.py"
"""
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import uvicorn  # noqa: E402

from noah import auth, db, hermes, machine, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Marie', 'Rédige les comptes rendus', 'k2', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
main._new_conversation(alice, "a1", "Conversation", main=True)
main._new_conversation(alice, "a2", "Conversation", main=True)

t = time.time()
files = {
    "outputs/plan-de-lancement.md": ("# Plan", t - 60),
    "outputs/rapports/avril.txt": ("avril", t - 3000),
    "outputs/rapports/mars/bilan.pdf": ("%PDF-1.4", t - 5000),
    "uploads/photo.txt": ("photo", t - 500),
}
skills = [
    {"nom": "redaction/compte-rendu", "titre": "Compte rendu", "resume": "Rédige un compte rendu de réunion", "origine": "agent", "desactivee": False},
    {"nom": "analyse/tableau", "titre": "Tableau de bord", "resume": "Résume des chiffres en tableau", "origine": "agent", "desactivee": False},
    {"nom": "ancien/vieille-methode", "titre": "Vieille méthode", "resume": "Désactivée", "origine": "agent", "desactivee": True},
]
started: list[str] = []


async def list_files(agent_id):
    return [{"path": p, "size": len(v[0]), "modified": v[1]} for p, v in files.items()] if agent_id == "a1" else []


async def start_run(agent, text, session_id):
    started.append(text)
    return f"run-{len(started)}"


async def run_events(agent, run_id):
    yield "run.completed", {"output": "Reçu."}


async def healthy(*a, **k):
    return True


async def admin(agent_id, action, payload=None):
    if action == "skills_resume":
        return {"skills": skills}
    return {"memoire": {"memory": [], "user": [], "limites": {"memory": 2200, "user": 1375}}}.get(action, {"applications": [], "google": {}})


hermes.list_files, hermes.start_run, hermes.run_events, hermes.health = list_files, start_run, run_events, healthy
machine.admin = admin


@main.app.get("/_essai/etat")
def state():
    return {"started": started}


# Sans ce déplacement, la route d'envoi de la page d'accueil répondrait avant les routes d'essai.
main.app.router.routes[:0] = [main.app.router.routes.pop()]
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning")
