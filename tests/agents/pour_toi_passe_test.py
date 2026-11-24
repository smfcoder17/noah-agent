"""Lot 044 : « Pour toi » ne s'accumule plus. Ce qui est passé sort de la liste ET du compteur (la barre de gauche relit la même route),
au démarrage et à chaque nettoyage, sans attendre l'affichage. Ce qui compte encore reste. Un invité ne voit que les siens.
La règle, type par type, est écrite dans noah/pourtoi.py ; celle des propositions (echeance) dans noah/propositions.py.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/pour_toi_passe_test.py"
"""
import json
import os
import sys
import tempfile
import time
from datetime import datetime
from zoneinfo import ZoneInfo

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, decision, main, pourtoi, propositions, questions, updates, watch  # noqa: E402

db.init()
watch.init()
PARIS = ZoneInfo("Europe/Paris")
updates.local_zone = lambda: PARIS
alice = auth.create_user("alice", "motdepasse-a")
invite = auth.create_user("invite", "motdepasse-i")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Ted', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'admin')", (invite,))
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c1', ?, 'a1', 'Conversation')", (alice,))
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c2', ?, 'a1', 'Autre')", (alice,))
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c3', ?, 'a1', 'Ancienne')", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "cerveau-x")
db.set_setting("onboarded", "1")


def web(user: int) -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"})


A, I = web(alice), web(invite)


def stamp(y, mo, d, h=10) -> float:
    return datetime(y, mo, d, h, 0, tzinfo=PARIS).timestamp()


def liste(client=A) -> list[dict]:
    return client.get("/api/a-toi").json()


# --- 1. echeance : la fin du jour que la proposition nomme, sinon trois jours ---------------------------------------------------------
lundi = stamp(2026, 11, 23, 9)
fin_lundi = stamp(2026, 11, 23, 23) + 59 * 60 + 59
cases = [
    ("Je peux t'auditer aujourd'hui la configuration de ta page.", fin_lundi),
    ("Je prépare maintenant un message court.", fin_lundi),
    ("Ce soir, je te prépare la fiche.", fin_lundi),
    ("Rencontre Skool demain : une fiche pitch.", fin_lundi + 86400),
    ("Après-demain, je relance les membres.", fin_lundi + 2 * 86400),
    ("Je te prépare ça pour le 25 novembre.", stamp(2026, 11, 25, 23) + 59 * 60 + 59),
    ("Rappel le 25/11 : envoyer la facture.", stamp(2026, 11, 25, 23) + 59 * 60 + 59),
    ("Puisque ton essai expire dans 3 jours, je peux t'auditer aujourd'hui ta page.", fin_lundi),  # le plus proche l'emporte
    ("Je peux rédiger le script d'un Short YouTube.", lundi + propositions.EXPIRE),  # aucun repère : trois jours
    ("Ton essai expire dans 3 jours : veux-tu que je regarde ?", lundi + propositions.EXPIRE),  # « dans 3 jours » n'est pas un moment
    ("Je prépare le point du 3 janvier.", stamp(2027, 1, 3, 23) + 59 * 60 + 59),  # janvier : l'année suivante n'est pas inventée à l'envers
    ("Le 12/45 n'est pas une date : je continue.", lundi + propositions.EXPIRE),
]
for text, expected in cases:
    got = propositions.echeance(text, lundi)
    assert abs(got - expected) < 2 or (text.startswith("Je prépare le point du 3 janvier") and got > lundi), (text, datetime.fromtimestamp(got, PARIS), datetime.fromtimestamp(expected, PARIS))
assert propositions.echeance("Le 12 novembre, c'était hier.", lundi) == lundi + propositions.EXPIRE, "une date déjà passée à la naissance n'est pas un repère"
print("1. echeance : aujourd'hui, ce soir, demain, après-demain, une date écrite ; le plus proche l'emporte ; sinon 3 jours")

# --- 2. Les propositions : seules celles dont le moment est passé sortent, la liste ET le compteur -----------------------------------
now = time.time()
local_now = datetime.fromtimestamp(now, PARIS)
yesterday = now - 30 * 3600  # un autre jour, quelle que soit l'heure
rows = {}
for key, text, created in [
    ("aujourdhui_hier", "Je peux t'auditer aujourd'hui ta configuration.", yesterday),
    ("demain_avant_hier", "Rencontre demain : je prépare une fiche.", now - 60 * 3600),
    ("maintenant_hier", "Je prépare maintenant un message court.", yesterday),
    ("sans_repere_hier", "Je peux rédiger le script d'un Short YouTube.", yesterday),
    ("sans_repere_vieille", "Je peux rédiger un autre script.", now - 73 * 3600),
    ("aujourdhui_ce_jour", "Je te prépare aujourd'hui une lead magnet.", now - 60),
    ("date_future", f"Je prépare le point pour le {local_now.day:02d}/{local_now.month:02d} sans faute.", now - 3600),
]:
    rows[key] = propositions.create("a1", "traiter", text, "Fais-le", "2026-11-20")
    with db.connect() as c:
        c.execute("UPDATE propositions SET created = ? WHERE id = ?", (created, rows[key]))
with db.connect() as c:
    c.execute("INSERT INTO propositions (id, agent_id, owner, genre, texte, demande, jour, created) VALUES ('autre-compte', 'a2', ?, 'idee', 'Pour le compte invité', 'x', '2026-11-20', ?)",
              (invite, now))
before = [i["id"] for i in liste() if i.get("type") == "proposition"]
assert rows["aujourdhui_hier"] not in before and rows["demain_avant_hier"] not in before and rows["maintenant_hier"] not in before, before
assert rows["sans_repere_vieille"] not in before, "plus de 3 jours : sortie (règle existante)"
assert {rows["sans_repere_hier"], rows["aujourdhui_ce_jour"], rows["date_future"]} <= set(before), "ce qui n'est pas passé reste"
with db.connect() as c:
    states = {r["id"]: r["etat"] for r in c.execute("SELECT id, etat FROM propositions")}
assert states[rows["aujourdhui_hier"]] == "expiree" and states[rows["sans_repere_hier"]] == "ouverte"
exp = [p["id"] for p in A.get("/api/activite").json()["propositions_expirees"]]
assert rows["aujourdhui_hier"] in exp and rows["sans_repere_hier"] not in exp, "ce qui sort reste lisible dans Activité, « expirée »"
r = A.post(f"/api/propositions/{rows['aujourdhui_hier']}/reponse", json={"choix": "faire"})
assert r.status_code == 409, "une proposition passée ne lance plus rien"
assert all(i["id"] != "autre-compte" for i in liste()), "une proposition d'un autre compte n'est jamais dans la liste"
print("2. propositions : le jour nommé passé, ou plus de 3 jours, sort de « Pour toi » (Activité la garde) ; le reste attend")

# --- 3. Le compteur de la barre suit : c'est la longueur de la liste, rien d'autre --------------------------------------------------
count = len([i for i in liste() if not i.get("request_id")])
assert count == len(before) - len([x for x in before if x in (rows["aujourdhui_hier"], rows["demain_avant_hier"], rows["maintenant_hier"], rows["sans_repere_vieille"])]), count
print("3. le compteur lit la même route : %d élément(s) restent" % count)

# --- 4. Les questions et les choix ---------------------------------------------------------------------------------------------------
with db.connect() as c:
    c.execute("INSERT INTO taches (id, owner_id, agent_id, fil_id, conversation_id, genre, titre, etat, cree, maj) VALUES ('t-finie', ?, 'a1', 'c1', NULL, 'demande', 'Finie', 'fini', ?, ?)",
              (alice, now, now))
    c.execute("INSERT INTO taches (id, owner_id, agent_id, fil_id, conversation_id, genre, titre, etat, cree, maj) VALUES ('t-vive', ?, 'a1', 'c1', NULL, 'demande', 'Vive', 'encours', ?, ?)",
              (alice, now, now))
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c2', 'agent', 'On publie ?')")
    choix_msg = c.execute("SELECT MAX(id) AS n FROM messages WHERE conversation_id = 'c2'").fetchone()["n"]


def question(qid, age_h, genre="question", tache=None, reserve="", conv="c1", message_id=None, titre=None):
    with db.connect() as c:
        c.execute("INSERT INTO questions (id, owner_id, tache_id, conversation_id, de, a, genre, titre, choix, libre, reserve, chemin, etat, message_id, cree, maj) "
                  "VALUES (?,?,?,?, 'a1', '', ?, ?, '[]', 1, ?, '[\"a1\"]', 'attend', ?, ?, ?)",
                  (qid, alice, tache, conv, genre, titre or qid, reserve, message_id, now - age_h * 3600, now - age_h * 3600))


question("q-fraiche", 1, tache="t-vive")
question("q-vieille", 49, tache="t-vive")
question("q-reservee-3j", 72, reserve="payer", titre="Payer l'abonnement ?")
question("q-reservee-8j", 8 * 24, reserve="payer", titre="Un vieux paiement")
question("q-tache-finie", 2, tache="t-finie")
question("q-choix", 3, genre="choix", conv="c2", message_id=choix_msg)
ids = lambda: {i["id"] for i in liste() if i.get("type") == "question"}  # noqa: E731
assert ids() == {"q-fraiche", "q-choix", "q-reservee-3j"}, ids()  # q-choix : personne n'a encore écrit après
with db.connect() as c:
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c2', 'user', 'Oui, publie.')")
assert ids() == {"q-fraiche", "q-reservee-3j"}, "le choix auquel la personne a répondu en écrivant dans la conversation sort"
with db.connect() as c:
    st = {r["id"]: r["etat"] for r in c.execute("SELECT id, etat FROM questions")}
assert st == {"q-fraiche": "attend", "q-vieille": "expiree", "q-reservee-3j": "attend", "q-reservee-8j": "expiree", "q-tache-finie": "annulee", "q-choix": "repondue"}, st
print("4. questions : 48 h, tâche finie, choix déjà répondu sortent ; un sujet réservé (paiement) garde 7 jours ; rien n'est effacé")

# --- 5. Un choix resté « choice » sans question n'attend plus personne ------------------------------------------------------------------
main.task_state["c3"] = "choice"
main.task_state["c2"] = "choice"
with db.connect() as c:
    c.execute("UPDATE conversations SET updated_at = datetime('now', '-5 days') WHERE id = 'c3'")
pourtoi.sweep()
assert main.task_state["c3"] == "done", "plus rien ne bouge depuis 5 jours : il n'attend plus"
assert main.task_state["c2"] == "done", "son choix est clos"
print("5. une conversation restée en « choix » dont la question est close ou vieille ne s'affiche plus")

# --- 6. L'échec du modèle de décision ------------------------------------------------------------------------------------------------
decision.note_failure("Le modèle n'a pas répondu.", decision.model())
assert [i["type"] for i in liste() if i.get("type") == "decision"] == ["decision"], "tant que le même modèle décide, la carte attend"
decision.note_failure("autre échec", "ancien-modele-remplace")
db.set_setting(decision.FAILURE, json.dumps({"modele": "ancien-modele-remplace", "raison": "x", "quand": now, "fermee": False}))
assert [i for i in liste() if i.get("type") == "decision"] == [], "le modèle a changé : la carte est passée"
db.set_setting(decision.FAILURE, json.dumps({"modele": decision.model(), "raison": "x", "quand": now - 4 * 86400, "fermee": False}))
assert [i for i in liste() if i.get("type") == "decision"] == [], "plus de 3 jours"
print("6. l'échec du modèle de décision : modèle changé ou 3 jours, la carte part")

# --- 7. Au démarrage, et sans que personne n'affiche rien ---------------------------------------------------------------------------------
with db.connect() as c:
    c.execute("UPDATE propositions SET etat = 'ouverte' WHERE id = ?", (rows["aujourdhui_hier"],))
    c.execute("UPDATE questions SET etat = 'attend' WHERE id = 'q-vieille'")
questions.recover()  # ce que main appelle au démarrage
assert pourtoi.sweep() >= 1
with db.connect() as c:
    st = {r["id"]: r["etat"] for r in c.execute("SELECT id, etat FROM propositions WHERE id = ?", (rows["aujourdhui_hier"],))}
    q = c.execute("SELECT etat FROM questions WHERE id = 'q-vieille'").fetchone()["etat"]
assert st == {rows["aujourdhui_hier"]: "expiree"} and q == "expiree", (st, q)
assert pourtoi.sweep() == 0, "rejouer ne change plus rien"
print("7. redémarrage : le nettoyage rattrape ce qui a passé pendant l'arrêt, sans lecture de la page")

# --- 8. Un invité ne voit que les siens ---------------------------------------------------------------------------------------------------------
mine = [i for i in liste(I)]
assert all(i.get("id") not in ("q-fraiche", "q-reservee-3j") and i.get("agent_id") != "a2" for i in mine), mine
assert not any(i.get("type") == "proposition" for i in mine), "une personne invitée ne reçoit pas ce que l'agent propose à son propriétaire"
print("8. l'invité ne voit ni les questions ni les propositions du propriétaire")
# --- 9. L'idée du jour sans repère : passée à la fin de son jour ; une plus récente remplace l'ancienne ----------------------------------------------
with db.connect() as c:
    c.execute("DELETE FROM propositions")
assert propositions.echeance("Je peux écrire un script.", lundi, genre="idee") == fin_lundi, "idée du jour : fin de son jour, chez la personne"
assert propositions.echeance("Je peux écrire un script.", lundi, genre="traiter") == lundi + propositions.EXPIRE, "les autres genres gardent 3 jours"
assert propositions.echeance("Je peux écrire un script.", stamp(2026, 11, 23, 23) + 30 * 60, genre="idee") == fin_lundi, "née à 23 h 30 : elle part à minuit, pas 24 h plus tard"
hier = propositions.create("a1", "idee", "Une idée d'hier sans date.", "Fais-le", "2026-11-22")
with db.connect() as c:
    c.execute("UPDATE propositions SET created = ? WHERE id = ?", (time.time() - 30 * 3600, hier))
assert hier not in [i["id"] for i in liste() if i.get("type") == "proposition"], "l'idée d'un autre jour est passée, sans repère de date"
ce_jour = propositions.create("a1", "idee", "Une idée du jour sans date.", "Fais-le", "2026-11-23")
autre_agent = propositions.create("a2", "idee", "Une idée d'un autre agent.", "Fais-le", "2026-11-23")
traite = propositions.create("a1", "traiter", "Un travail préparé, sans date.", "Fais-le", "2026-11-23")
with db.connect() as c:
    c.execute("UPDATE propositions SET created = ? WHERE id = ?", (time.time() - 5, ce_jour))
    c.execute("UPDATE propositions SET created = ? WHERE id = ?", (time.time() - 3600, traite))
if datetime.now(PARIS).hour >= 1:  # l'heure de naissance doit rester dans le même jour que maintenant, pour que le test ne dépende pas de minuit
    shown = {i["id"] for i in liste() if i.get("type") == "proposition"}
    assert {ce_jour, autre_agent, traite} <= shown, shown
nouvelle = propositions.create("a1", "idee", "Une idée plus récente.", "Fais-le", "2026-11-23")
shown = {i["id"] for i in liste() if i.get("type") == "proposition"}
assert nouvelle in shown and ce_jour not in shown, "l'idée plus récente du même agent remplace l'ancienne tout de suite"
assert autre_agent in shown and traite in shown, "l'idée d'un autre agent et un travail préparé ne sont pas touchés"
exp = [p["id"] for p in A.get("/api/activite").json()["propositions_expirees"]]
assert {hier, ce_jour} <= set(exp), "les deux restent lisibles dans Activité, « expirée »"
print("9. idée du jour sans repère : fin de son jour ; une plus récente du même agent la remplace ; les autres genres gardent 3 jours")
print("Tout est tenu.")
