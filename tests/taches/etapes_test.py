"""0.4.0, lot L9b : les étapes d'une tâche viennent des vrais messages de son sous-fil, côté serveur, sans appel au modèle.
Première phrase, 120 caractères au plus, sans Markdown ni doublon consécutif, les 12 dernières ; une tâche sans messages n'a pas
de bloc (`etapes: []`) ; `du_fil` et `liste` (donc `ouverture` et `GET /api/taches`) rendent les mêmes étapes.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/etapes_test.py"
"""
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, main, taches  # noqa: E402

db.init()
owner = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    for agent_id, name in (("a", "Alma"), ("b", "Basile")):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, owner))
fil = main._new_conversation(owner, "a", "Conversation", main=True)


def tache(titre: str) -> str:
    conv = main._new_conversation(owner, "a", titre)
    return conv, taches.creer(conv, "sous_tache", titre=titre, consigne=titre)


def dire(conv: str, etapes, texte="Fini."):
    main._save_message(conv, "agent", texte, json.dumps({"etapes": etapes}, ensure_ascii=False))


conv1, id1 = tache("Rédiger la newsletter")
dire(conv1, ["**Brief lu.** Il faut trois rubriques.", "Je cherche le plan", "Je cherche le plan", "- Texte écrit et relu"])
dire(conv1, ["Mise en page faite. Rien d'autre."])
conv2, id2 = tache("Une tâche sans étape")
main._save_message(conv2, "user", "Salut")
dire(conv2, [])
conv3, id3 = tache("Une tâche sans message")
conv4, id4 = tache("Beaucoup d'étapes")
dire(conv4, [f"Étape numéro {i}." for i in range(20)])
conv5, id5 = tache("Étape très longue")
dire(conv5, ["mot " * 60])
# Une étape que l'utilisateur a écrite (rôle user) ou un détail qui n'est pas des étapes ne comptent pas.
main._save_message(conv3, "user", "x", json.dumps({"etapes": ["Je suis un message de la personne."]}))
main._save_message(conv3, "agent", "y", "pas du json")

by_id = {t["id"]: t for t in taches.liste(owner, "a")}
assert by_id[id1]["etapes"] == ["Brief lu.", "Je cherche le plan", "Texte écrit et relu", "Mise en page faite."], by_id[id1]["etapes"]
assert by_id[id2]["etapes"] == [], by_id[id2]["etapes"]
assert by_id[id3]["etapes"] == [], by_id[id3]["etapes"]
assert by_id[id4]["etapes"] == [f"Étape numéro {i}." for i in range(8, 20)], by_id[id4]["etapes"]
assert 0 < len(by_id[id5]["etapes"][0]) <= 120 and by_id[id5]["etapes"][0].endswith("…"), by_id[id5]["etapes"]
print("liste : les étapes viennent des messages de l'agent, nettoyées, sans doublon, 12 au plus, vides sans message")

du_fil = {t["id"]: t for t in taches.du_fil(fil, owner, None)}
assert {k: du_fil[k]["etapes"] for k in by_id} == {k: by_id[k]["etapes"] for k in by_id}
print("du_fil rend les mêmes étapes que liste")

# Une seule requête pour toutes les tâches : aucun SELECT sur messages par tâche.
requetes = []
with db.connect() as c:
    c.set_trace_callback(lambda q: requetes.append(q))
    taches.etapes_de(c, [conv1, conv2, conv3, conv4, conv5])
assert len([q for q in requetes if "FROM messages" in q]) == 1, requetes
print("une seule requête groupée sur messages")
print("OK")
