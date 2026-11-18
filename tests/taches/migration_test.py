"""0.4.0, pas S5 du socle : la migration des anciennes sous-conversations en tâches (docs/epics/0.4.0/socle.md, section 4).
Vraie base, vrai `db.init()` ; rien n'est simulé. Un cas par ligne du tableau 4.4, puis les six vérifications de 4.5 :
rejouable, rien d'autre n'a bougé, aucun titre « Demande de » ni « De lui-même », place de la tâche, invité chez lui, retour arrière.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/migration_test.py"
"""
import calendar
import hashlib
import json
import os
import re
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, taches  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
carol = auth.create_user("carol", "motdepasse-c")
with db.connect() as c:
    for agent_id, name in (("a", "Alma"), ("b", "Basile")):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent_id, name, alice))


def at(day: int, hour: str = "09:00") -> str:
    return f"2026-11-{day:02d} {hour}:00"


def conversation(conv_id, user, agent, title, created, updated=None, origin=None, main=0, archived=0, shared=0):
    cols = ["id", "user_id", "agent_id", "title", "created_at", "updated_at", "main", "archived", "shared"]
    vals = [conv_id, user, agent, title, created, updated or created, main, archived, shared]
    if origin:  # sans `origin`, la colonne prend « user » : une très vieille base
        cols.append("origin")
        vals.append(origin)
    with db.connect() as c:
        c.execute(f"INSERT INTO conversations ({', '.join(cols)}) VALUES ({', '.join('?' * len(vals))})", vals)
    return conv_id


def message(conv_id, role, text, created, detail=None) -> int:
    with db.connect() as c:
        return c.execute("INSERT INTO messages (conversation_id, role, text, created_at, detail) VALUES (?, ?, ?, ?, ?)",
                         (conv_id, role, text, created, detail)).lastrowid


def trace(fil, conv_id, entete, consigne, etat, issue, created) -> int:
    return message(fil, "trace", f"{entete} : {consigne}", created,
                   json.dumps({"fil": conv_id, "entete": entete, "consigne": consigne, "etat": etat, "issue": issue}, ensure_ascii=False))


def delegation(did, de, vers, conv_id, etat, consigne, created):
    with db.connect() as c:
        c.execute("INSERT INTO delegations (id, de, vers, conversation_id, profondeur, chaine, rappeler, etat, consigne, created_at, livre) "
                  "VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, ?, 1)", (did, de, vers, conv_id, json.dumps([de]), etat, consigne, created))


def turn(tid, agent, conv_id, etat, titre):
    with db.connect() as c:
        c.execute("INSERT INTO proactive_turns (id, agent_id, conversation_id, mode, titre, etat, at) VALUES (?, ?, ?, 'signaler', ?, ?, 1)",
                  (tid, agent, conv_id, titre, etat))


def ts(text: str) -> float:
    return float(calendar.timegm(__import__("time").strptime(text, "%Y-%m-%d %H:%M:%S")))


# --- Les fils : la conversation principale de chaque compte avec chaque agent -----------------------------------
F_B = conversation("fil-b", alice, "b", "Conversation", at(1, "07:00"), main=1)
F_A = conversation("fil-a", alice, "a", "Conversation", at(1, "07:00"), main=1)
F_G = conversation("fil-g", bruno, "a", "Conversation", at(1, "07:00"), main=1)  # l'invité a son fil à lui
message(F_B, "agent", "Bonjour", at(1, "08:00"))
message(F_B, "user", "Salut", at(1, "08:05"))
message(F_B, "trace", "trace abîmée", at(1, "08:10"), detail="ceci n'est pas du JSON")  # ne doit rien casser

# --- Un cas par ligne du tableau 4.4 ----------------------------------------------------------------------------
CONSIGNE = "Résume le rapport de ventes. Puis liste les risques"
# Fil archivé et vieux : une tâche comme les autres. Demande finie, avec sa trace dans le fil.
c1 = conversation("c1", alice, "b", f"Demande de Alma : {CONSIGNE}", at(2), at(3), origin="agent", archived=1)
message(c1, "user", f"[Demande de l'agent Alma (a), pas de l'utilisateur. Ta réponse finale lui sera transmise.]\n\n{CONSIGNE}", at(2))
message(c1, "agent", "Voici le rapport complet. Les ventes montent de 4 %. Les risques suivent.", at(2, "09:30"))
delegation("d1", "a", "b", c1, "fini", CONSIGNE, ts(at(2)))
T1 = trace(F_B, c1, "Alma m'a demandé", CONSIGNE, "fini", "Les ventes montent de 4 %.", at(2))
message(F_B, "user", "Merci", at(2, "10:00"))

# Pas de trace dans le fil, travail en cours : la demande naît « encours », sa place vient de la date.
c2 = conversation("c2", alice, "b", "Demande de Alma : Prépare la facture de novembre", at(10), origin="agent")
message(c2, "user", "[Demande de l'agent Alma (a), pas de l'utilisateur.]\n\nPrépare la facture de novembre pour le client Martin", at(10))
delegation("d2", "a", "b", c2, "en_cours", "Prépare la facture de novembre pour le client Martin", ts(at(10)))
message(F_B, "agent", "Je suis là", at(10, "09:30"))
message(F_B, "user", "Ok", at(11, "08:00"))

# Demandeur supprimé (aucun agent « fantome ») et échec.
c3 = conversation("c3", alice, "b", "Demande de fantome : Envoie le courriel au client.", at(11, "10:00"), origin="agent")
message(c3, "user", "Envoie le courriel au client.", at(11, "10:00"))
message(c3, "error", "Le modèle ne répond pas.", at(11, "10:05"))
delegation("d3", "fantome", "b", c3, "echec", "Envoie le courriel au client.", ts(at(11, "10:00")))
trace(F_B, c3, "fantome m'a demandé", "Envoie le courriel au client.", "echec", "Le modèle ne répond pas.", at(11, "10:00"))

# Même consigne qu'une tâche déjà là, dans le même fil : la seconde reçoit l'heure.
c4 = conversation("c4", alice, "b", f"Demande de Alma : {CONSIGNE}", at(12, "14:30"), origin="agent")
message(c4, "user", CONSIGNE, at(12, "14:30"))
message(c4, "agent", "Encore un rapport.", at(12, "14:40"))
delegation("d4", "a", "b", c4, "fini", CONSIGNE, ts(at(12, "14:30")))

# Fil ouvert par l'agent : sa trace dit « J'ai ouvert un fil ».
c5 = conversation("c5", alice, "b", "Piste de recherche", at(13), origin="agent")
message(c5, "user", "Cherche des pistes", at(13))
message(c5, "agent", "J'ai trouvé trois pistes.", at(13, "09:10"))
T5 = trace(F_B, c5, "J'ai ouvert un fil", "Piste de recherche", "fini", "J'ai trouvé trois pistes.", at(13))

# Initiative : par `proactive_turns` (échec), par le seul préfixe du titre, et un tour encore en cours.
c6 = conversation("c6", alice, "b", "De lui-même : Une facture à payer", at(14), origin="agent")
message(c6, "user", "[Personne ne t'a écrit]", at(14))
message(c6, "agent", "J'ai préparé le virement.", at(14, "09:05"))
turn("p6", "b", c6, "echec", "Une facture à payer")
c7 = conversation("c7", alice, "b", "De lui-même : Rien de neuf", at(15), origin="agent")
message(c7, "agent", "RIEN", at(15, "09:01"))
c8 = conversation("c8", alice, "b", "De lui-même : Un courriel arrive", at(16), origin="agent")
message(c8, "user", "[Personne ne t'a écrit]", at(16))
turn("p8", "b", c8, "en_cours", "Un courriel arrive")

# Sous-agent d'Hermes : une sous-conversation d'agent que rien d'autre ne désigne.
c9 = conversation("c9", alice, "b", "Cherche les prix des billets (+1)", at(17), origin="agent")
message(c9, "user", "Cherche les prix des billets\n\nCherche les hôtels", at(17))
message(c9, "agent", "Prix trouvés : 120 euros.", at(17, "09:02"))

# Discussions de la personne : titre générique, titre vide (très vieille base : sans `origin`), titre coupé, aucune réponse.
c10 = conversation("c10", alice, "b", "Nouvelle discussion", at(18))
message(c10, "user", "Aide-moi à planifier mon voyage à Lisbonne. Merci d'avance", at(18))
message(c10, "agent", "Avec plaisir.", at(18, "09:01"))
c11 = conversation("c11", alice, "b", "Nouvelle discussion", at(5, "12:00"))
c12 = conversation("c12", alice, "b", "", at(19))
message(c12, "user", "Quelle heure est-il ?", at(19))
message(c12, "agent", "Il est neuf heures.", at(19, "09:01"))
LONG = "Un très long titre de discussion qui a été coupé par la limite de quatre-vingts caractères de la base"
c13 = conversation("c13", alice, "b", LONG[:80], at(20))
message(c13, "user", "Bonjour", at(20))
message(c13, "agent", "Bonjour !", at(20, "09:01"))

# Invité : sa discussion, partagée, va dans SON fil. Un compte sans fil : la ligne est passée.
c15 = conversation("c15", bruno, "a", "Nouvelle discussion", at(21), shared=1)
message(c15, "user", "Mon invitation à dîner", at(21))
message(c15, "agent", "Bien reçu.", at(21, "09:01"))
c16 = conversation("c16", carol, "a", "Nouvelle discussion", at(22))
message(c16, "user", "Je n'ai pas de fil", at(22))

CASES = 15  # c1 à c13, c15, c16
EXPECTED = {"demande": 4, "fil": 1, "initiative": 3, "sous_tache": 1, "discussion": 5}


# --- Instantané de tout ce que la migration ne doit pas toucher --------------------------------------------------
def snapshot() -> dict:
    out = {}
    with db.connect() as c:
        out["messages"] = tuple(c.execute("SELECT COUNT(*), COALESCE(SUM(length(text)), 0) FROM messages").fetchone())
        out["conversations"] = c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        out["delegations"] = c.execute("SELECT COUNT(*) FROM delegations").fetchone()[0]
        for table in ("messages", "conversations", "delegations", "proactive_turns"):  # même le détail : aucune colonne n'a bougé
            rows = [tuple(r) for r in c.execute(f"SELECT * FROM {table} ORDER BY 1")]
            out[table + "_hash"] = hashlib.sha256(json.dumps(rows, default=str).encode()).hexdigest()
    return out


def rows() -> dict[str, dict]:
    with db.connect() as c:
        return {r["conversation_id"]: dict(r) for r in c.execute("SELECT * FROM taches")}


def full_dump() -> list[tuple]:
    with db.connect() as c:
        return [tuple(r) for r in c.execute("SELECT * FROM taches ORDER BY id")]


def fil_before(fil: str, created: str) -> int:
    with db.connect() as c:
        return c.execute("SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ? AND created_at <= ?", (fil, created)).fetchone()[0]


# --- titre_auto -----------------------------------------------------------------------------------------------------
noon = float(calendar.timegm((2026, 11, 12, 12, 0, 0)))
assert taches.titre_auto("[Demande de l'agent Alma (a), pas de l'utilisateur.]\n\nPrépare la **facture** de [novembre](http://x.test). Merci") == "Prépare la facture de novembre"
assert taches.titre_auto("```py\nprint(1)\n```\nRange le dossier") == "Range le dossier"
assert taches.titre_auto("Qui est là ? Dis-moi") == "Qui est là ?"
assert taches.titre_auto("", noon) == "Tâche du 12 novembre" and taches.titre_auto("  \n [seulement un préfixe] ", noon) == "Tâche du 12 novembre"
long = taches.titre_auto("Prépare un très long rapport sur les ventes de la région nord pour le comité de direction de mars")
assert len(long) <= 60 and long.endswith("…") and long[:-1] == "Prépare un très long rapport sur les ventes de la région", long
assert taches.titre_auto("[Lien](http://x.test) en tête") == "Lien en tête"
print("0. titre_auto : préfixe entre crochets et Markdown enlevés, première phrase, coupé sur un mot à 60 caractères, repli daté")

# --- Vérification 1 : deux passages, le même nombre de tâches --------------------------------------------------------
before = snapshot()
first = taches.migrer()
once = rows()
assert first["creees"] == len(once) == CASES - 1 and first["sans_fil"] == 1 and first["erreurs"] == 0, first
assert first["par_genre"] == EXPECTED, first["par_genre"]
report = json.loads(db.get_setting("migr_040_taches"))
assert report["creees"] == first["creees"] and report["sans_fil"] == 1 and report["par_genre"] == EXPECTED and report["at"] > 0, report
second = taches.migrer()
assert second["creees"] == 0 and second["sans_fil"] == 1 and len(rows()) == len(once), second
assert rows() == once, "un second passage ne change aucune ligne"
for _ in range(3):
    taches.migrer()
assert len(rows()) == len(once)
print(f"1. migrer() deux fois, et trois de plus : {len(once)} tâches, 1 sans fil, les mêmes lignes")

# --- Vérification 2 : rien d'autre n'a bougé -------------------------------------------------------------------------
assert snapshot() == before, "la migration a touché à messages, conversations, delegations ou proactive_turns"
with db.connect() as c:
    assert c.execute("PRAGMA foreign_key_check").fetchall() == [] and c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print("2. messages, conversations, delegations, proactive_turns : identiques octet pour octet (comptes, longueurs, contenu)")

# --- Vérification 3 : aucun titre « Demande de » ni « De lui-même » -----------------------------------------------------
titles = {conv: r["titre"] for conv, r in once.items()}
assert not [t for t in titles.values() if t.startswith("Demande de") or t.startswith("De lui-même")], titles
assert titles["c1"] == "Résume le rapport de ventes", titles["c1"]
assert re.fullmatch(r"Résume le rapport de ventes \(\d\d:\d\d\)", titles["c4"]), titles["c4"]  # le doublon du même fil
assert titles["c2"] == "Prépare la facture de novembre pour le client Martin", titles["c2"]
assert titles["c3"] == "Envoie le courriel au client", titles["c3"]
assert titles["c5"] == "Piste de recherche" and titles["c6"] == "Une facture à payer" and titles["c7"] == "Rien de neuf" and titles["c8"] == "Un courriel arrive"
assert titles["c9"] == "Cherche les prix des billets (+1)"
assert titles["c10"] == "Aide-moi à planifier mon voyage à Lisbonne", titles["c10"]  # générique : le premier message de la personne
assert titles["c11"] == "Tâche du 5 novembre", titles["c11"]  # générique et vide : la date
assert titles["c12"] == "Quelle heure est-il ?", titles["c12"]  # titre vide
assert len(titles["c13"]) <= 60 and titles["c13"].endswith("…") and titles["c13"].startswith("Un très long titre de discussion"), titles["c13"]
with db.connect() as c:
    assert c.execute("SELECT title FROM conversations WHERE id = 'c1'").fetchone()[0].startswith("Demande de Alma"), "le titre de la conversation n'est pas modifié"
assert all(r["titre_source"] == "auto" and r["migree"] == 1 for r in once.values())
print("3. aucun titre ne commence par « Demande de » ni « De lui-même » ; titres génériques, vides, coupés et en double repris")

# --- Genres, états, sources, résumés (un cas par ligne du tableau 4.4) -----------------------------------------------------
want = {
    "c1": ("demande", "fini", "a", "d1"), "c2": ("demande", "encours", "a", "d2"), "c3": ("demande", "echec", "fantome", "d3"),
    "c4": ("demande", "fini", "a", "d4"), "c5": ("fil", "fini", "", ""), "c6": ("initiative", "echec", "", "p6"),
    "c7": ("initiative", "fini", "", ""), "c8": ("initiative", "encours", "", "p8"), "c9": ("sous_tache", "fini", "", ""),
    "c10": ("discussion", "fini", "", ""), "c11": ("discussion", "echec", "", ""), "c12": ("discussion", "fini", "", ""),
    "c13": ("discussion", "fini", "", ""), "c15": ("discussion", "fini", "", ""),
}
for conv, (genre, etat, demandeur, source) in want.items():
    r = once[conv]
    assert (r["genre"], r["etat"], r["demandeur"], r["source_id"]) == (genre, etat, demandeur, source), (conv, r)
    assert (r["fini_a"] is not None) == (etat in ("fini", "echec")), (conv, "fini_a ne suit pas l'état")
assert once["c1"]["consigne"] == CONSIGNE and once["c3"]["demandeur"] == "fantome", "un demandeur supprimé garde son identifiant"
assert once["c1"]["resume"] == "Les ventes montent de 4 %.", once["c1"]["resume"]  # l'issue de la trace
assert once["c9"]["resume"] == "Prix trouvés : 120 euros." and once["c3"]["resume"] == "Le modèle ne répond pas."
assert once["c11"]["resume"] == "" and once["c2"]["resume"] == ""  # rien à résumer
assert once["c1"]["cree"] == ts(at(2)) and once["c1"]["fini_a"] == ts(at(3)) and once["c2"]["fini_a"] is None  # les dates viennent de la conversation
assert once["c1"]["fil_id"] == F_B and once["c1"]["owner_id"] == alice and once["c1"]["agent_id"] == "b"
assert "c16" not in once, "un compte sans fil : la ligne est passée"
assert not [t for t in once.values() if t["etat"] == "attend"], "aucune ancienne tâche ne naît « attend »"
print("4a. genre, état, demandeur, source, résumé et dates de chacun des cas du tableau 4.4")

# --- Vérification 4 : la place ---------------------------------------------------------------------------------------------
for conv in ("c1", "c3", "c5"):
    assert once[conv]["trace_id"] is not None and once[conv]["ancre"] == once[conv]["trace_id"], conv
assert once["c1"]["trace_id"] == T1 and once["c5"]["trace_id"] == T5
for conv, created in (("c2", at(10)), ("c4", at(12, "14:30")), ("c6", at(14)), ("c9", at(17)), ("c10", at(18)), ("c11", at(5, "12:00"))):
    assert once[conv]["trace_id"] is None and once[conv]["ancre"] == fil_before(F_B, created), (conv, once[conv]["ancre"], fil_before(F_B, created))
assert once["c11"]["ancre"] <= once["c2"]["ancre"] < once["c13"]["ancre"], "les places suivent l'ordre du fil"
print("5. ancre = trace_id quand la trace existe ; sinon le dernier message du fil écrit avant la sous-conversation")

# --- Vérification 5 : invité et partage ------------------------------------------------------------------------------
assert once["c15"]["fil_id"] == F_G and once["c15"]["owner_id"] == bruno and once["c15"]["fil_id"] != F_A, once["c15"]
with db.connect() as c:
    assert c.execute("SELECT shared FROM conversations WHERE id = 'c15'").fetchone()[0] == 1, "le partage reste porté par conversations.shared"
print("6. la discussion partagée de l'invité est dans le fil de l'invité, pas dans celui du propriétaire")

# --- Une sous-conversation supprimée emporte sa tâche ----------------------------------------------------------------
with db.connect() as c:
    c.execute("DELETE FROM conversations WHERE id = 'c5'")
assert "c5" not in rows() and len(rows()) == len(once) - 1
print("7. sous-conversation supprimée : sa tâche part avec elle (ON DELETE CASCADE)")

# --- Vérification 6 : retour arrière --------------------------------------------------------------------------------------
reference = full_dump()
with db.connect() as c:
    c.execute("DELETE FROM taches WHERE migree = 1")
    c.execute("DELETE FROM settings WHERE key = 'migr_040_taches'")
    assert c.execute("SELECT COUNT(*) FROM taches").fetchone()[0] == 0
assert db.get_setting("migr_040_taches") is None
back = taches.migrer()
assert full_dump() == reference, "le retour arrière puis la migration doivent recréer exactement les mêmes lignes"
assert back["creees"] == len(reference) and back["sans_fil"] == 1
assert db.get_setting("migr_040_taches") is not None
print(f"8. retour arrière (les deux DELETE) puis migrer() : exactement les mêmes {len(reference)} lignes, ids compris")

# --- Une table existante a-t-elle changé ? Les cinq tables nouvelles sont là, rejouables ---------------------------------
db.init()
db.init()
with db.connect() as c:
    names = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    idx = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    cols = {r["name"] for r in c.execute("PRAGMA table_info(conversations)")}
assert {"taches", "questions", "regles", "routine_passages", "routine_vues"} <= names
assert {"taches_fil", "taches_owner", "taches_agent", "taches_parent", "questions_owner", "questions_tache", "questions_decidees",
        "regles_owner", "routine_passages_agent"} <= idx
assert cols == {"id", "user_id", "agent_id", "title", "created_at", "updated_at", "main", "archived", "origin", "shared"}, cols
with db.connect() as c:  # les contraintes du socle tiennent
    for bad in ("INSERT INTO taches (id, owner_id, agent_id, fil_id, genre, titre, cree, maj) VALUES ('z', 1, 'a', 'fil-a', 'inconnu', 't', 1, 1)",):
        try:
            c.execute(bad)
        except Exception as e:  # noqa: BLE001
            assert "CHECK" in str(e), e
        else:
            raise AssertionError("un genre inconnu doit être refusé")
print("9. cinq tables et leurs index, db.init() rejouable, conversations inchangée, genre inconnu refusé")
print("OK")
