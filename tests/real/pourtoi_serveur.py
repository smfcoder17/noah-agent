"""Le vrai serveur et la vraie interface : « Pour toi » avec deux choix dont le bloc n'a pas de champ « question ». Voir tools/eval/pourtoi.mjs.
Noah : un message long avec la question dans la prose, suivi d'autres messages (le lien doit remonter jusqu'à lui).
Marie : une ligne déjà enregistrée avec le titre générique (le cas réel), relue depuis son message.

    docker run --rm -p 127.0.0.1:8099:8099 -e NOAH_WEB_DIR=/web -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/frontend/dist:/web" \
      python:3.12-slim sh -c "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/pourtoi_serveur.py"
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import uvicorn  # noqa: E402

from noah import auth, db, hermes, machine, main, questions  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Marie', 'Rédige les comptes rendus', 'k2', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")


def conversation(agent):
    c = main._new_conversation(alice, agent, "Conversation", main=True)
    return c["id"] if isinstance(c, dict) else c


CHOIX = '```noah\n{"type": "choice", "options": ["Non, rien", "Oui, parle-moi", "Peut-être plus tard"]}\n```'
QUESTION = "Tu veux que je te propose un créneau pour la vidéo de jeudi ?"
now = datetime.now(timezone.utc)


def ecrire(conv, role, text, minutes):
    at = (now - timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
    with db.connect() as c:
        cur = c.execute("INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?, ?, ?, ?)", (conv, role, text, at))
        return cur.lastrowid


noah, marie = conversation("a1"), conversation("a2")
ecrire(noah, "user", "Regarde mon calendrier de juin.", 400)
ids = {}
ids["noah"] = ecrire(noah, "agent", f"J'ai relu **tout** le calendrier de juin. Il reste un trou le jeudi après-midi.\n\n{QUESTION} Je peux aussi attendre ta réponse.\n\n{CHOIX}", 390)
for i in range(14):  # d'autres messages de l'agent après la question : le lien doit remonter jusqu'à elle
    ecrire(noah, "agent", f"Note {i:02d}. " + "Du texte pour remplir l'écran. " * 14, 380 - i * 10)
ecrire(marie, "user", "Prépare le compte rendu.", 300)
ids["marie"] = ecrire(marie, "agent", f"Le compte rendu de la réunion est prêt.\n\nOn l'envoie à toute l'équipe maintenant ?\n\n{CHOIX}", 290)

main.task_state[noah] = "choice"
main.task_state[marie] = "choice"
# Noah : le chemin d'aujourd'hui, le texte du message (prose puis bloc sans « question ») ouvre le choix.
with db.connect() as c:
    texte_noah = c.execute("SELECT text FROM messages WHERE id = ?", (ids["noah"],)).fetchone()["text"]
questions.ouvrir_choix(noah, texte_noah, ids["noah"])
# Marie : une ligne « d'avant » le correctif, enregistrée avec le titre générique ; « Pour toi » la relit dans son message.
with db.connect() as c:
    c.execute("INSERT INTO questions (id, owner_id, tache_id, conversation_id, de, a, genre, titre, choix, libre, chemin, etat, message_id, cree, maj) "
              "VALUES ('ancienne01', ?, NULL, ?, 'a2', '', 'choix', ?, ?, 1, '[\"a2\"]', 'attend', ?, ?, ?)",
              (alice, marie, questions.QUESTION_GENERIQUE, '["Non, rien", "Oui, parle-moi", "Peut-être plus tard"]', ids["marie"], now.timestamp(), now.timestamp()))



async def healthy(*a, **k):
    return True


async def start_run(agent, text, session_id):
    return "run-1"


async def run_events(agent, run_id):
    yield "run.completed", {"output": "Reçu."}


async def list_files(agent_id):
    return []


async def admin(agent_id, action, payload=None):
    return {"memoire": {"memory": [], "user": [], "limites": {"memory": 2200, "user": 1375}}}.get(action, {"applications": [], "google": {}})


hermes.list_files, hermes.start_run, hermes.run_events, hermes.health = list_files, start_run, run_events, healthy
machine.admin = admin


@main.app.get("/_essai/etat")
def state():
    return {"noah": noah, "marie": marie, "messages": ids}


# Sans ce déplacement, la route d'envoi de la page d'accueil répondrait avant les routes d'essai.
main.app.router.routes[:0] = [main.app.router.routes.pop()]
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning")
