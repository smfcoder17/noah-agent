"""Rien d'interne dans un fil, aucune clé en clair (0.4.0, L4 : X31 et X17). Vrai nettoyage, vraies routes, vraie base ; Hermes n'intervient pas.

Deux moments : à l'écriture (`routes_chat._save_message`), à la lecture (un ancien message déjà en base sort propre, la base reste telle quelle).
Les vecteurs sont ceux de frontend/src/lib/nettoyage.test.ts : le serveur et l'écran suivent la même règle.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/nettoyage_test.py"
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

from noah import auth, db, main, nettoyage, routes_chat, sensitive  # noqa: E402

failures: list[str] = []


def check(ok, label):
    print(("  ok   " if ok else "  FAIL ") + label)
    if not ok:
        failures.append(label)


# Des valeurs fabriquées pour l'essai : aucune n'est une vraie clé.
SK = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2"
ANT = "sk-ant-" + "api03-Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2"
GHP = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"
SLACK = "xoxb-" + "1234567890-abcdefghij"
AIZA = "AIza" + "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"
LONGUE = "q8Zk2Lm9Xp4Rt7Vw1Yc5Bn3Hd6Fj0Sa"
CLES = [SK, ANT, GHP, SLACK, AIZA, LONGUE]
B = chr(92)  # une barre oblique inverse, pour écrire ` ` « en toutes lettres »
THUMB, CHECK = chr(0x1F44D), chr(0x2705)

print("Les marques internes")
VECTEURS = [
    (f"[[{THUMB}]] Je m'en occupe.", "Je m'en occupe."),
    (f"[[{CHECK}]]\n\nFait.", "Fait."),
    ("Voilà [SILENT] la suite", "Voilà  la suite"),
    ("<releve>\nTitre\n</releve>Bonjour", "Titre\nBonjour"),
    (f"Prix : 5{B}u00a0€", "Prix : 5 €"),
    (f"Ligne{B}x1b[0m fin", "Ligne fin"),
    ("Un​mot", "Unmot"),
    ("Bonjour \x1b[31mrouge\x1b[0m", "Bonjour rouge"),
    ("Voir [[Accueil]] ici", "Voir [[Accueil]] ici"),
    (f"Tape `[SILENT]` puis :\n```\n[[{THUMB}]] {B}u00a0\n```", f"Tape `[SILENT]` puis :\n```\n[[{THUMB}]] {B}u00a0\n```"),
]
for avant, apres in VECTEURS:
    check(nettoyage.interne(avant) == apres, f"interne({avant!r}) = {apres!r}")
check(nettoyage.silence("[SILENT]") and nettoyage.silence("Rien à signaler.\n[SILENT]") and nettoyage.silence("[silent] fini"), "[SILENT] seul, en tête ou en fin : un silence")
check(not nettoyage.silence("Je dis [SILENT] au milieu") and not nettoyage.silence("Bonjour"), "[SILENT] au milieu d'une phrase : pas un silence")

print("La consigne de Noah n'est pas une parole de la personne")
CONSIGNE = "[Personne ne t'a écrit : un rappel est arrivé]\n<releve>\nRelancer le client\n</releve>"
check(nettoyage.est_consigne(CONSIGNE), "la consigne est reconnue")
check(not nettoyage.est_consigne("Bonjour, personne ne t'a écrit ?"), "une vraie phrase n'est pas une consigne")
check(nettoyage.ligne_consigne(CONSIGNE) == "Noah a relevé : Relancer le client.", "la ligne lisible porte le titre relevé")
check(nettoyage.ligne_consigne("[Personne ne t'a écrit : ton tour s'est coupé]") == "Noah reprend ce travail là où il s'est arrêté.", "tour coupé")
check(nettoyage.ligne_consigne("[Personne ne t'a écrit]") == "Noah a relevé quelque chose à traiter.", "consigne sans titre")
check(nettoyage.pose("user", CONSIGNE) is None, "la consigne n'est pas posée comme message de la personne")
check(nettoyage.pose("user", "Bonjour") == "Bonjour", "une parole de la personne reste la sienne")
check(nettoyage.pose("agent", "[SILENT]") is None, "[SILENT] ne pose rien")
check(nettoyage.pose("agent", f"[[{THUMB}]]") is None, "un message vide une fois nettoyé ne pose rien")
check(nettoyage.pose("agent", f"[[{THUMB}]] Fait.") == "Fait.", "la réaction de tête part, le texte reste")

print("Les clés d'API")
for cle in CLES:
    out = sensitive.mask_keys(f"Ma clé est {cle} merci")
    check(cle not in out and "clé masquée" in out, f"masquée : {cle[:6]}…")
    check(cle not in nettoyage.lecture(f"[[{THUMB}]] clé : {cle}"), f"lecture : {cle[:6]}…")
for ok in ["le sk-8 est court", "https://exemple.org/a/b/c/d/e/f/g/h", "mon token est valide", "api_key: /opt/data/workspace/fichier-tres-long-12345.txt", "task-abc"]:
    check(sensitive.mask_keys(ok) == ok, f"ce n'est pas une clé : {ok!r}")
check(sensitive.keys_in(f"a {SK} et {GHP}") and not sensitive.keys_in("rien à voir"), "keys_in")
check(SK not in nettoyage.ligne(f"[[{THUMB}]] **Ranger** {SK} [le site](https://x.org)"), "une ligne de titre sans clé")
check(nettoyage.ligne("# Titre\n\n- une **idée**") == "Titre - une idée", "une ligne de titre sans Markdown")
check(SK not in json.dumps(nettoyage.dans({"q": f"voici {SK}", "l": [f"et {GHP}", {"x": f"[[{CHECK}]] {ANT}"}]})), "dans() nettoie toute une structure")

# --- Les routes : une base, un compte, un agent ---------------------------------------------------------------------
db.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
A = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'test', 'web')}"})
conv = main._new_conversation(alice, "a1", "Conversation", main=True)


def lignes(conv_id):
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT role, text, detail FROM messages WHERE conversation_id = ? ORDER BY id", (conv_id,))]


print("À l'écriture : _save_message")
routes_chat._save_message(conv, "agent", "[SILENT]")
routes_chat._save_message(conv, "agent", f"[[{THUMB}]]")
routes_chat._save_message(conv, "user", CONSIGNE)
check(lignes(conv) == [], "[SILENT], un message vide et la consigne : rien n'est posé")
routes_chat._save_message(conv, "agent", f"[[{CHECK}]] Fait{B}u00a0! [SILENT] encore")
routes_chat._save_message(conv, "user", "Bonjour")
check([m["text"] for m in lignes(conv)] == ["Fait ! encore", "Bonjour"] or [m["text"] for m in lignes(conv)] == ["Fait !  encore", "Bonjour"], "une réponse est posée sans marque, la parole de la personne telle quelle")

print("À la lecture : un ancien message déjà en base (écrit sans nettoyage)")
SALE = [
    ("agent", f"[[{THUMB}]] Salut{B}u00a0!\n\n<releve>\nTitre\n</releve>"),
    ("agent", "[SILENT]"),
    ("agent", f"[[{CHECK}]]"),
    ("user", CONSIGNE),
    ("user", f"ma clé {SK} et {GHP}"),
    ("agent", f"voici {ANT}, {SLACK}, {AIZA} et api_key: {LONGUE}"),
    ("error", f"échec avec {SK}"),
    ("trace", json.dumps({"fil": "x", "entete": f"[[{THUMB}]] Départ", "consigne": f"clé {SK}", "issue": "[SILENT]fini", "etat": "fini"})),
]
with db.connect() as c:
    for role, text in SALE:
        c.execute("INSERT INTO messages (conversation_id, role, text, detail) VALUES (?, ?, ?, ?)", (conv, role, "Travail" if role == "trace" else text, text if role in ("error", "trace") else None))
base_avant = lignes(conv)

lues = A.get(f"/api/conversations/{conv}/messages").json()
brut = json.dumps(lues, ensure_ascii=False)
check(not any(cle in brut for cle in CLES), "la route des messages ne rend aucune clé en clair")
for marque in ("[[", "[SILENT]", "<releve>", "Personne ne t'a écrit", f"{B}u00a0", "\x1b"):
    check(marque not in brut, f"la route des messages ne rend pas {marque!r}")
textes = [m["text"] for m in lues]
check(any(t.startswith("Salut !") for t in textes), "le texte propre reste")
check(not any(t.strip() in ("", "[SILENT]") for t in textes), "[SILENT] et le message vide ne sortent pas")
consignes = [m for m in lues if m["text"].startswith("Noah a relevé")]
check(len(consignes) == 1 and consignes[0]["role"] == "agent", "la consigne sort en ligne lisible, du côté de l'agent")
trace = next(m for m in lues if m["role"] == "trace")
d = json.loads(trace["detail"])
check(d["entete"] == "Départ" and SK not in d["consigne"] and d["issue"] == "fini" and d["etat"] == "fini", "une trace est nettoyée champ par champ")
check(lignes(conv) == base_avant, "la base n'est pas réécrite : rien n'est perdu, la clé d'un vieux message reste récupérable côté serveur")

page = A.get(f"/api/conversations/{conv}/messages?limit=3").json()
check(not any(cle in json.dumps(page) for cle in CLES) and len(page) <= 3, "une page de messages aussi")

ouv = A.get("/api/agents/a1/ouverture").json()
brut = json.dumps(ouv, ensure_ascii=False)
check(not any(cle in brut for cle in CLES) and "[SILENT]" not in brut and "Personne ne t'a écrit" not in brut, "l'ouverture d'un agent ne rend ni clé ni marque")

print("Les titres, les tâches, l'Activité")
with db.connect() as c:
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c2', ?, 'a1', ?)", (alice, f"[[{THUMB}]] Ma clé {SK}"))
    c.execute("INSERT INTO taches (id, owner_id, agent_id, fil_id, conversation_id, genre, titre, resume, cree, maj) VALUES ('t1', ?, 'a1', ?, 'c2', 'demande', ?, ?, ?, ?)",
              (alice, conv, f"[[{CHECK}]] Relancer {SK}", f"Fait{B}u00a0: {GHP} [SILENT]", time.time(), time.time()))
liste = json.dumps(A.get("/api/agents/a1/conversations").json(), ensure_ascii=False)
check(SK not in liste and "[[" not in liste, "la liste des conversations : titre sans clé ni marque")
taches_lues = json.dumps(A.get("/api/taches?agent_id=a1").json()["taches"], ensure_ascii=False)
check("Relancer" in taches_lues, "la tâche est rendue")
check(SK not in taches_lues and GHP not in taches_lues, "la route des tâches : titre et résumé sans clé")
check("[[" not in taches_lues and "[SILENT]" not in taches_lues and f"{B}u00a0" not in taches_lues, "la route des tâches : aucune marque")
act = json.dumps(A.get("/api/activite").json(), ensure_ascii=False)
check(SK not in act and GHP not in act and "[[" not in act, "l'Activité : aucune clé en clair, aucune marque")

print()
print("ÉCHEC : " + ", ".join(failures) if failures else "tout est passé")
sys.exit(1 if failures else 0)
