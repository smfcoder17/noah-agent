"""0.4.0, pas S6 du socle : la route d'ouverture d'un agent, `GET /api/agents/{id}/ouverture` (docs/epics/0.4.0/socle.md, 5.1, X22).
Une requête rend le fil, ses tâches, ce que l'agent fait, ce qui attend, l'appel d'aide, les tâches confiées, les routines connues et la
liste des conversations. Ce test fige la forme exacte du JSON, vérifie que chaque bloc est celui de la route qu'il remplace (les routes
d'avant restent et répondent pareil), et les droits : un invité ne voit que son fil, la trace reste à son auteur.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/chat/ouverture_test.py"
"""
import asyncio
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

from noah import accords, auth, bus, db, handoff, machine, main, modes, taches  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")  # invité sur l'agent « a », sans droit sur « c »
with db.connect() as c:
    for agent_id, name in (("a", "Alma"), ("c", "Cléo"), ("s", "Sans fil")):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, alice))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a', ?, 'usage')", (bruno,))


def web(user: int) -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"})


A, B = web(alice), web(bruno)
CLES = ["appel", "attentes", "conversations", "en_cours", "fil", "revision", "routines", "taches_confiees", "version"]
CLES_FIL = ["id", "lecture_seule", "messages", "plus", "taches", "updated_at"]
CLES_MESSAGE = {"id", "role", "text", "detail", "model", "created_at"}
CLES_TACHE = ["agent", "ancre", "conversation_id", "cree", "demandeur", "echanges", "etat", "fichiers", "fini_a", "genre", "id", "question", "resume", "titre"]


def ouvre(client: TestClient, agent: str, query: str = "?limit=60"):
    return client.get(f"/api/agents/{agent}/ouverture{query}")


# --- Le fil d'Alice avec « a » : 70 messages (la page de 60 laisse « plus »), une trace, une réaction, trois tâches -----------------
fil = main._new_conversation(alice, "a", "Conversation", main=True)
ids = []
for i in range(70):
    role = "user" if i % 2 == 0 else "agent"
    main._save_message(fil, role, f"message {i}", detail='{"etapes":["a"]}' if i == 69 else None, model="m1" if role == "agent" else None)
with db.connect() as c:
    ids = [r["id"] for r in c.execute("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", (fil,))]
    c.execute("INSERT INTO reactions (message_id, who, emoji) VALUES (?, 'user', '👍')", (ids[-1],))

# Une demande d'Alma à Cléo écrit sa trace dans le fil : place = la trace.
sub_demande = main._new_conversation(alice, "a", "Demande de Cléo : x", origin="agent")
main._save_message(fil, "trace", "Cléo m'a demandé", detail=json.dumps({"fil": sub_demande, "entete": "Cléo m'a demandé", "consigne": "x", "etat": "fini"}))
with db.connect() as c:
    trace_id = c.execute("SELECT MAX(id) AS n FROM messages WHERE conversation_id = ?", (fil,)).fetchone()["n"]
t_recente = taches.creer(sub_demande, "demande", consigne="Prépare le plan du mois", demandeur="c")
taches.finir(sub_demande, "fini", "Le plan est prêt.")
# Une tâche ancienne, ancrée avant la première page, et une discussion récente.
sub_vieille = main._new_conversation(alice, "a", "Nouvelle discussion")
t_vieille = taches.creer(sub_vieille, "discussion", titre="Nouvelle discussion", etat="fini")
main._save_message(sub_vieille, "user", "Une vieille question")  # une discussion sans message n'est pas une tâche (0.4.0, L1)
with db.connect() as c:
    c.execute("UPDATE taches SET ancre = ? WHERE id = ?", (ids[0], t_vieille))
sub_fil = main._new_conversation(alice, "a", "Un fil de l'agent", origin="agent")
t_fil = taches.creer(sub_fil, "fil", titre="Un fil de l'agent")

# --- 1. La forme exacte --------------------------------------------------------------------------------------------------------------
r = ouvre(A, "a")
assert r.status_code == 200, r.text
o = r.json()
assert sorted(o) == CLES, f"clés du JSON : {sorted(o)}"
assert o["version"] == 1 and isinstance(o["revision"], str) and o["revision"].isdigit(), (o["version"], o["revision"])
assert sorted(o["fil"]) == CLES_FIL, sorted(o["fil"])
assert o["fil"]["id"] == fil and o["fil"]["lecture_seule"] is False and o["fil"]["plus"] is True
assert isinstance(o["fil"]["updated_at"], str) and o["fil"]["updated_at"]
assert len(o["fil"]["messages"]) == 60, len(o["fil"]["messages"])
for m in o["fil"]["messages"]:
    assert CLES_MESSAGE <= set(m) <= CLES_MESSAGE | {"reactions"}, sorted(m)
assert o["fil"]["messages"][-1]["id"] == trace_id and o["fil"]["messages"][-1]["role"] == "trace", "la trace de l'auteur est dans son fil"
reacted = [m for m in o["fil"]["messages"] if "reactions" in m]
assert len(reacted) == 1 and reacted[0]["reactions"] == {"user": "👍"} and reacted[0]["id"] == ids[-1], reacted
assert sorted(o["en_cours"]) == ["accord", "activite", "connexion", "file", "occupe", "run_id"], sorted(o["en_cours"])
assert o["en_cours"] == {"occupe": False, "activite": None, "run_id": None, "file": [], "accord": None, "connexion": None}, o["en_cours"]
assert o["attentes"] == {"questions": [], "accords": 0, "propositions": 0}, o["attentes"]
assert o["appel"] is None and o["taches_confiees"] == []
assert o["routines"] == {"actives": [], "non_vues": 0}, "rien de lu sur la machine : ce que le serveur sait, c'est rien"
assert sorted(o["conversations"][0]) == ["archived", "de", "en_cours", "id", "main", "origin", "partagee", "state", "title", "updated_at"]

# --- 2. Les tâches : celles de la page, avec leur place --------------------------------------------------------------------------------
shown = {t["id"]: t for t in o["fil"]["taches"]}
assert t_recente in shown and t_fil in shown, sorted(shown)
assert t_vieille not in shown, "la tâche ancrée avant la première page est dans une page plus ancienne"
for t in shown.values():
    assert sorted(t) == CLES_TACHE, sorted(t)
tr = shown[t_recente]
assert tr["genre"] == "demande" and tr["etat"] == "fini" and tr["ancre"] == trace_id and tr["question"] is None, tr
assert tr["demandeur"] == {"id": "c", "nom": "Cléo"}, tr["demandeur"]
assert tr["agent"] == {"id": "a", "nom": "Alma"}, "la tâche nomme l'agent qui fait le travail, pas celui qui l'a demandée"
assert tr["resume"] == "Le plan est prêt." and tr["fichiers"] == [] and isinstance(tr["cree"], float) and isinstance(tr["fini_a"], float), tr
assert shown[t_fil]["demandeur"] is None and shown[t_fil]["fini_a"] is None and shown[t_fil]["etat"] == "encours", shown[t_fil]
assert [t["ancre"] for t in o["fil"]["taches"]] == sorted(t["ancre"] for t in o["fil"]["taches"]), "dans l'ordre du fil"
# Une page plus courte que le fil ne change que son contenu ; une page qui contient tout porte aussi les tâches d'avant.
tout = ouvre(A, "a", "?limit=500").json()
assert tout["fil"]["plus"] is False and len(tout["fil"]["messages"]) == 71, (tout["fil"]["plus"], len(tout["fil"]["messages"]))
assert {t["id"] for t in tout["fil"]["taches"]} == {t_recente, t_vieille, t_fil}, "la page la plus ancienne porte aussi les tâches d'avant"

# --- 3. Chaque bloc est celui de la route d'avant -------------------------------------------------------------------------------------
assert o["fil"]["messages"] == A.get(f"/api/conversations/{fil}/messages?limit=60").json()
assert o["conversations"] == A.get("/api/agents/a/conversations").json()
assert o["en_cours"] == A.get(f"/api/conversations/{fil}/en-cours").json()
assert o["appel"] == A.get("/api/agents/a/appel").json()["appel"]
assert o["taches_confiees"] == A.get("/api/agents/a/taches-confiees").json()["taches"]
assert [c["main"] for c in o["conversations"]].count(True) == 1

# --- 4. Ce qui attend : accord, choix, appel d'aide, proposition, comme /api/a-toi réduit à cet agent ---------------------------------
accord = accords.create(alice, "a", fil, "run-1", {"request_id": "r1", "generation": 1, "summary": "Écrire un fichier"})
main.task_state[sub_fil] = "choice"  # un choix qui attend, dans une conversation d'Alice avec « a »
class Attente:  # l'appel d'aide attend toujours la personne
    def done(self):
        return False


handoff._calls["a"] = {"id": "ap1", "message": "Connecte-toi à ton compte", "depuis": time.time(), "origine": "agent", "attente": Attente()}
with db.connect() as c:
    c.execute("INSERT INTO propositions (id, agent_id, owner, genre, texte, demande, jour, created) VALUES ('p1', 'a', ?, 'idee', 'Un post ?', 'Fais-le', '2026-11-18', ?)", (alice, time.time()))
    c.execute("INSERT INTO propositions (id, agent_id, owner, genre, texte, demande, jour, created) VALUES ('p2', 'c', ?, 'idee', 'Autre agent', 'Fais-le', '2026-11-18', ?)", (alice, time.time()))
o = ouvre(A, "a").json()
assert o["attentes"]["accords"] == 1 and o["attentes"]["propositions"] == 1, o["attentes"]
kinds = sorted((q["etat"], bool(q.get("appel"))) for q in o["attentes"]["questions"])
assert kinds == [("approve", True), ("choice", False)], kinds
toi = [i for i in A.get("/api/a-toi").json() if i.get("agent_id") == "a"]
assert len(toi) == 1 + 1 + 1 + 1 and all(q in toi for q in o["attentes"]["questions"]), "les questions sont des lignes de /api/a-toi"
assert o["appel"] is not None and o["appel"]["id"] == "ap1" and o["appel"] == A.get("/api/agents/a/appel").json()["appel"]
assert sorted(o["appel"]) == ["depuis", "id", "message", "origine"], sorted(o["appel"])
assert ouvre(A, "c").json()["attentes"]["propositions"] == 1, "la proposition de l'autre agent reste chez lui"
accords.pending(alice)  # relue sans erreur
handoff._calls.pop("a")
main.task_state.pop(sub_fil)
with db.connect() as c:
    c.execute("UPDATE accords SET state = 'donne' WHERE id = ?", (accord["id"],))
    c.execute("DELETE FROM propositions")

# --- 5. Les routines : ce que le serveur sait, sans rien demander à la machine --------------------------------------------------------
async def faux_admin(agent_id, action, body=None, timeout=90):
    return {"routines": [{"id": "r1", "name": "Veille du matin", "enabled": True, "prompt": "Résume"},
                         {"id": "r2", "name": "En pause", "enabled": False, "prompt": "x"},
                         {"id": "r3", "name": None, "enabled": True, "prompt": "sans nom"}]}


vrai_admin = machine.admin
machine.admin = faux_admin
assert A.get("/api/agents/a/routines").status_code == 200
machine.admin = vrai_admin
assert ouvre(A, "a").json()["routines"] == {"actives": [{"id": "r1", "nom": "Veille du matin"}], "non_vues": 0}
assert ouvre(B, "a").json()["routines"]["actives"] == [], "les routines sont des réglages : seuls ceux qui les administrent les voient"


class Coupe:  # le lanceur : toute demande échoue tout de suite ; seul compte ce que `admin` fait avant
    def __init__(self, *a, **k):
        raise RuntimeError("pas de lanceur dans ce test")


vrai_client = machine.httpx.AsyncClient
machine.httpx.AsyncClient = Coupe
try:
    asyncio.run(machine.admin("a", "routines"))
except RuntimeError:
    pass
assert ouvre(A, "a").json()["routines"]["actives"] == [{"id": "r1", "nom": "Veille du matin"}], "une lecture ne vide pas ce qui est su"
for action in ("routine_action", "routine_creer"):
    machine._routines_connues["a"] = [{"id": "r1", "nom": "Veille du matin"}]
    try:
        asyncio.run(machine.admin("a", action, {}))
    except RuntimeError:
        pass
    assert ouvre(A, "a").json()["routines"]["actives"] == [], f"{action} : une écriture de routine vide ce qui était su"
machine.httpx.AsyncClient = vrai_client

# --- 6. Les droits ---------------------------------------------------------------------------------------------------------------------
# L'invité ouvre « a » : son fil à lui, vide ; rien du fil d'Alice, ni ses tâches, ni sa trace, ni ses conversations privées.
ob = ouvre(B, "a")
assert ob.status_code == 200, ob.text
ob = ob.json()
assert ob["fil"] is None, "l'invité n'a pas encore de fil : on ne lui rend pas celui du propriétaire"
assert ob["conversations"] == [] and ob["en_cours"]["occupe"] is False and ob["taches_confiees"] == [] and ob["appel"] is None
assert ob["attentes"] == {"questions": [], "accords": 0, "propositions": 0}
fil_b = main._new_conversation(bruno, "a", "Conversation", main=True)
main._save_message(fil_b, "user", "bonjour de Bruno")
sub_b = main._new_conversation(bruno, "a", "Une discussion de Bruno")
t_b = taches.creer(sub_b, "discussion", titre="Une discussion de Bruno", etat="fini")
ob = ouvre(B, "a").json()
assert ob["fil"]["id"] == fil_b and [m["text"] for m in ob["fil"]["messages"]] == ["bonjour de Bruno"], ob["fil"]
assert ob["fil"]["taches"] == [], "une « Nouvelle discussion » sans aucun message n'est pas une tâche (0.4.0, L1)"
main._save_message(sub_b, "user", "Une question de Bruno")
ob = ouvre(B, "a").json()
assert [t["id"] for t in ob["fil"]["taches"]] == [t_b], "ses tâches à lui, jamais celles d'Alice"
assert ob["fil"]["plus"] is False and ob["fil"]["lecture_seule"] is False
assert {c["id"] for c in ob["conversations"]} == {fil_b}, "le fil seul : une discussion devenue tâche n'est plus listée (0.4.0, L1) ; celles d'Alice ne sont pas partagées"
assert all(m["role"] != "trace" for m in ob["fil"]["messages"])
# Alice partage sa conversation : elle apparaît dans la liste de l'invité, mais son fil à lui reste le sien, et sa trace ne se lit pas.
assert A.post(f"/api/conversations/{sub_demande}/partage", json={"partagee": True}).status_code == 200
main._save_message(sub_demande, "agent", "Voici le plan.")
ob = ouvre(B, "a").json()
assert ob["fil"]["id"] == fil_b
assert sub_demande in {c["id"] for c in ob["conversations"]} and next(c for c in ob["conversations"] if c["id"] == sub_demande)["de"] == "alice"
assert ob["conversations"] == B.get("/api/agents/a/conversations").json()
# Une conversation partagée qui contient une trace : l'invité la lit sans, son auteur avec (même règle que …/messages).
main._save_message(sub_demande, "trace", "Une trace dans la conversation partagée", detail="{}")
assert all(m["role"] != "trace" for m in B.get(f"/api/conversations/{sub_demande}/messages").json())
assert any(m["role"] == "trace" for m in A.get(f"/api/conversations/{sub_demande}/messages").json())
assert any(m["role"] == "trace" for m in ouvre(A, "a", "?limit=500").json()["fil"]["messages"]), "la trace reste dans le fil de son auteur"
# Sans droit sur l'agent : introuvable ; un agent qui n'existe pas aussi ; sans session : refusé.
assert ouvre(B, "c").status_code == 404 and ouvre(A, "nexiste-pas").status_code == 404
assert TestClient(main.app, raise_server_exceptions=False).get("/api/agents/a/ouverture").status_code == 401
# Lecture seule : un invité qui ne peut que lire voit son fil, marqué en lecture seule.
with db.connect() as c:
    c.execute("UPDATE agent_shares SET droit = 'lecture' WHERE agent_id = 'a' AND user_id = ?", (bruno,))
assert ouvre(B, "a").json()["fil"]["lecture_seule"] is True
with db.connect() as c:
    c.execute("UPDATE agent_shares SET droit = 'usage' WHERE agent_id = 'a' AND user_id = ?", (bruno,))
# Un agent sans fil pour ce compte : pas de fil, le reste est rendu.
os_ = ouvre(A, "s").json()
assert os_["fil"] is None and os_["conversations"] == [] and os_["en_cours"]["occupe"] is False, os_

# --- 7. La révision du flux et le paramètre `suivi` -----------------------------------------------------------------------------------
avant = int(ouvre(A, "a").json()["revision"])
assert avant == bus.revision_of(alice)
bus.invalidate(alice)
assert int(ouvre(A, "a").json()["revision"]) == avant + 1, "un événement publié avance la révision rendue"
assert ouvre(A, "a", "?limit=1&suivi=false").json()["fil"]["messages"][0]["id"] == trace_id
assert len(ouvre(A, "a", "?limit=1").json()["fil"]["messages"]) == 1
assert len(ouvre(A, "a", "").json()["fil"]["messages"]) == 60, "sans limit : la page de 60"

print("ouverture_test : OK")
