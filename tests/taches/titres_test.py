"""0.4.0, lot L1 (d) : le titre d'une nouvelle tâche est écrit par le modèle rapide, jamais « Demande de tel agent ». Dix tâches, dix titres
distincts au faux modèle (tests/real/faux_modele.py, lancé ici comme serveur) ; repli sur la règle (`titre_auto`) quand le modèle rapide
manque ou échoue ; aucun appel pour les anciennes tâches (migrées) ni pour une tâche déjà titrée.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/titres_test.py"
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, decision, main, rapide, taches  # noqa: E402
main._today = lambda: ""

PORT = 18911
faux = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "real", "faux_modele.py"), str(PORT)])
for _ in range(100):
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
        break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit("le faux modèle ne répond pas")

db.init()
owner = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    for agent_id, name in {"a": "Alma", "b": "Basile"}.items():
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, 'Son rôle', 'k', ?)", (agent_id, name, owner))
MAIN_B = main._new_conversation(owner, "b", "Conversation", main=True)
main._new_conversation(owner, "a", "Conversation", main=True)

db.set_setting("provider", "custom")
db.set_setting("base_url", f"http://127.0.0.1:{PORT}/v1")
db.set_setting("model", "faux-modele")


def rapide_pret(pret: bool) -> None:
    """Le modèle rapide mesuré sur la clé actuelle, ou rien."""
    db.set_setting(rapide.KEY, json.dumps({"modele": "faux-modele", "empreinte": decision._fingerprint()}) if pret else "")


appels: list[str] = []
vrai = decision._complete


async def compte(*args, **kw):
    """Un appel compté, c'est une requête qui part vers le fournisseur."""
    appels.append(args[2])
    return await vrai(*args, **kw)


decision._complete = compte

CONSIGNES = [
    "Rédige la newsletter de jeudi avec les trois annonces",
    "Compare les tarifs des trois hébergeurs retenus",
    "Prépare le planning de tournage de la semaine prochaine",
    "Résume le rapport de ventes du trimestre",
    "Traduis la page tarifs en anglais puis en espagnol",
    "Vérifie les liens cassés du site public",
    "Liste les risques du lancement de mars",
    "Corrige les fautes du script de la vidéo douze",
    "Cherche cinq exemples de communautés qui marchent",
    "Écris les réponses aux commentaires de la semaine",
]


def nouvelle(genre: str, consigne: str) -> str:
    conv = main._new_conversation(owner, "b", f"Demande de Alma : {consigne}", origin="agent")
    return conv, taches.creer(conv, genre, consigne=consigne, demandeur="a", source_id=conv)


def titre_de(tache: str) -> dict:
    with db.connect() as c:
        return dict(c.execute("SELECT titre, titre_source FROM taches WHERE id = ?", (tache,)).fetchone())


async def attendre(ids: list[str], source: str, secondes=15):
    fin = time.monotonic() + secondes
    while time.monotonic() < fin:
        if all(titre_de(i)["titre_source"] == source for i in ids):
            return
        await asyncio.sleep(0.05)
    raise AssertionError({i: titre_de(i) for i in ids})


async def test_dix_titres():
    rapide_pret(True)
    ids = [nouvelle("demande", c)[1] for c in CONSIGNES]
    # Tout de suite : le titre de la règle, la demande n'attend pas le modèle.
    assert all(titre_de(i)["titre_source"] == "auto" for i in ids)
    await attendre(ids, "modele")
    titres = [titre_de(i)["titre"] for i in ids]
    assert len(set(titres)) == 10, titres
    assert not any(t.lower().startswith("demande de") for t in titres), titres
    assert all(t and len(t) <= taches.TITRE_MAX for t in titres), titres
    assert titres[0] == "Rédige la newsletter de jeudi", titres[0]
    assert len(appels) == 10 and all("Titre de la tâche" in s for s in appels)
    print("1. dix demandes, dix titres distincts écrits par le modèle rapide :", " | ".join(titres[:3]), "…")

    # Deux consignes qui se ressemblent : deux titres du modèle, jamais deux lignes au même titre dans un fil.
    deux = [nouvelle("demande", "Rédige la newsletter de vendredi")[1], nouvelle("demande", "Rédige la newsletter de samedi")[1]]
    await attendre(deux, "modele")
    assert len({titre_de(i)["titre"] for i in ids + deux}) == 12
    print("2. des consignes proches : des titres distincts dans le fil")


async def test_repli():
    # 3. Sans modèle rapide mesuré : la règle de S5, sans aucun appel.
    rapide_pret(False)
    avant = len(appels)
    conv, tache = nouvelle("demande", "Prépare la facture de février. Puis envoie-la")
    await asyncio.sleep(0.5)
    assert titre_de(tache) == {"titre": "Prépare la facture de février", "titre_source": "auto"}, titre_de(tache)
    assert len(appels) == avant, "pas de modèle rapide : pas d'appel"
    # 4. Modèle rapide qui échoue (le fournisseur ne répond plus) : la règle aussi.
    rapide_pret(True)
    db.set_setting("base_url", "http://127.0.0.1:9/v1")
    rapide_pret(True)  # l'empreinte suit l'adresse
    conv, tache = nouvelle("demande", "Archive les contrats signés cette année")
    await asyncio.sleep(1)
    assert titre_de(tache)["titre_source"] == "auto" and titre_de(tache)["titre"] == "Archive les contrats signés cette année", titre_de(tache)
    db.set_setting("base_url", f"http://127.0.0.1:{PORT}/v1")
    rapide_pret(True)
    print("3. modèle rapide absent ou en panne : le titre de la règle, la tâche n'est pas touchée")


async def test_pas_de_titre_de_demande():
    # 5. Ce que le modèle écrit n'est gardé que si c'est un titre.
    assert taches._titre_propre("« Rédiger la newsletter. »") == "Rédiger la newsletter"
    assert taches._titre_propre("Titre : **Préparer le planning**\nautre ligne") == "Préparer le planning"
    assert taches._titre_propre("Demande de Alma : un truc") == "" and taches._titre_propre("") == "" and taches._titre_propre(None) == ""
    assert len(taches._titre_propre("mot " * 50)) <= taches.TITRE_MAX
    print("4. titre nettoyé : sans guillemets, sans marque, 60 caractères, jamais « Demande de … »")


async def test_anciennes():
    # 6. Aucun appel pour les anciennes tâches : la migration n'appelle jamais le modèle, une tâche déjà titrée non plus.
    for i in range(3):
        old = main._new_conversation(owner, "b", f"Demande de Alma : Ancienne tâche {i}", origin="agent")
        with db.connect() as c:
            c.execute("INSERT INTO delegations VALUES (?, 'a', 'b', ?, 1, '[\"a\"]', 0, 'fini', ?, ?, 1)", (f"anc{i}", old, f"Ancienne tâche {i}", time.time() - 500))
    avant = len(appels)
    rapport = taches.migrer()
    await asyncio.sleep(0.5)
    assert rapport["creees"] == 3 and len(appels) == avant, (rapport, len(appels) - avant)
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM taches WHERE migree = 1 AND titre_source != 'auto'").fetchone()["n"] == 0
    conv, tache = nouvelle("demande", "Fais un point sur les abonnés")
    await attendre([tache], "modele")
    avant = len(appels)
    assert await taches.titrer(tache, "Fais un point sur les abonnés") is False and len(appels) == avant, "déjà titrée : rien ne bouge"
    print("5. anciennes tâches : aucun appel au modèle ; une tâche déjà titrée n'est jamais retitrée")


async def test_discussion():
    # 7. Une discussion de la personne : la règle au premier message, puis le modèle.
    conv = main._new_conversation(owner, "b", "Nouvelle discussion")
    tache = taches.creer(conv, "discussion", titre="Nouvelle discussion", etat="fini")
    taches.premier_message(conv, "Aide-moi à choisir un nom de chaîne")
    assert titre_de(tache) == {"titre": "Aide-moi à choisir un nom de chaîne", "titre_source": "auto"}
    await attendre([tache], "modele")
    assert titre_de(tache)["titre"] == "Aide-moi à choisir un nom", titre_de(tache)
    taches.premier_message(conv, "Un deuxième message qui ne change rien")
    assert titre_de(tache)["titre"] == "Aide-moi à choisir un nom"
    print("6. discussion : titre de la règle au premier message, puis celui du modèle, puis plus rien")


async def go():
    try:
        await test_dix_titres()
        await test_repli()
        await test_pas_de_titre_de_demande()
        await test_anciennes()
        await test_discussion()
        print("OK : titres_test")
    finally:
        faux.terminate()


asyncio.run(go())
