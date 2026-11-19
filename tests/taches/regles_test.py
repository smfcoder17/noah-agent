"""0.4.0, L2 (c) : « Décidé pour toi », corriger, règles. Les questions qu'un agent a réglées se listent ; « Corriger » enregistre la correction,
qui devient une règle retenue ; la même question reçoit ensuite cette réponse sans déranger la personne, ni l'agent qui répondait.
Vrai `_run`, vraies routes, faux modèle ; voir tests/taches/joueur.py.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/regles_test.py"
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joueur as J  # noqa: E402
from joueur import client, deleguer, faux, joueur, owner, questions, settle, toutes  # noqa: E402

from noah import auth, taches  # noqa: E402

CONNU = "Réponses connues : objet=Court et direct ; ton=Sobre"


async def decisions() -> list[dict]:
    async with client() as h:
        r = await h.get("/api/decisions")
    assert r.status_code == 200, r.text
    return r.json()["decisions"]


async def corriger(qid: str, texte: str, regle: bool = True):
    async with client() as h:
        return await h.post(f"/api/questions/{qid}/correction", json={"correction": texte, "regle": regle})


async def test_decide_pour_toi():
    # Noah a confié la tâche à Léa ; la réponse est dans sa demande : il décide, la personne n'est pas dérangée.
    d = await deleguer("noah", "lea", f"Écris la newsletter. Pose la question : Quelle longueur pour l'objet ? | Il faut trancher.\n{CONNU.replace('objet', 'longueur')}")
    await settle()
    (item,) = await decisions()
    assert item["titre"] == "Quelle longueur pour l'objet ?" and item["reponse"] == "Court et direct" and item["par"] == "Noah" and not item["corrigee"], item
    assert item["de_nom"] == "Léa" and item["tache"] and [c["nom"] for c in item["chemin"]] == ["Léa", "Noah"], item
    # La tâche montre l'échange réglé, « Léa à Noah … / Noah à Léa … ».
    (tache,) = taches.liste(owner, "lea")
    (echange,) = tache["echanges"]
    assert (echange["de"], echange["a"], echange["question"], echange["reponse"], echange["corrigee"]) == ("Léa", "Noah", "Quelle longueur pour l'objet ?", "Court et direct", False), echange
    # Une réponse de la personne n'est pas une décision prise pour elle.
    await deleguer("hugo", "lea", "Avance. Pose la question : Quel prestataire je prends ? | Deux offres.")
    await settle()
    (q,) = [x for x in toutes() if x["a"] == "" and x["etat"] == "attend"]
    async with client() as h:
        assert (await h.post(f"/api/questions/{q['id']}/reponse", json={"reponse": "Alpha"})).status_code == 200
    await settle()
    assert [x["titre"] for x in await decisions()] == ["Quelle longueur pour l'objet ?"]
    print("1. « Décidé pour toi » : ce qu'un agent a réglé se liste, avec qui, quand et le chemin ; la tâche montre l'échange ; une réponse de la personne n'y est pas")
    return item


async def test_corriger_devient_regle(item):
    avant = len(J.runs)
    r = await corriger(item["id"], "Moins de 40 caractères")
    assert r.status_code == 200 and r.json()["regle_id"], r.text
    (apres,) = await decisions()
    assert apres["corrigee"] and apres["correction"] == "Moins de 40 caractères" and apres["regle_id"], apres
    with J.db.connect() as c:
        regle = dict(c.execute("SELECT * FROM regles WHERE id = ?", (apres["regle_id"],)).fetchone())
    assert regle["etat"] == "active" and regle["texte"] == "Moins de 40 caractères" and regle["sujet"] == "Quelle longueur pour l'objet ?" and regle["agent_id"] is None, regle
    (tache,) = [x for x in taches.liste(owner, "lea") if x["echanges"] and x["echanges"][0]["question"] == item["titre"]][:1]
    assert tache["echanges"][0]["corrigee"] is True
    # La même question, dans une nouvelle tâche, reçoit la réponse retenue : ni la personne ni Noah ne sont dérangés.
    await deleguer("noah", "lea", f"Écris la lettre de mars. Pose la question : Quelle longueur pour l'objet ? | Même chose.\n{CONNU}")
    await settle()
    nouvelle = [q for q in toutes() if q["repondu_par"].startswith("regle:")]
    assert len(nouvelle) == 1 and nouvelle[0]["reponse"] == "Moins de 40 caractères" and nouvelle[0]["chemin"] == ["lea"], nouvelle
    assert not [x for x in J.runs[avant:] if x["agent"] == "noah" and "Question de" in x["text"]], "Noah n'a pas été dérangé"
    assert [q for q in toutes() if q["a"] == "" and q["etat"] == "attend"] == [], "la personne non plus"
    pose = [x["question"] for x in J.runs[avant:] if x["agent"] == "lea" and x.get("question")]
    assert pose and pose[0]["etat"] == "repondue" and pose[0]["reponse"] == "Moins de 40 caractères", pose  # la réponse revient à l'agent dans la commande même
    with J.db.connect() as c:
        assert c.execute("SELECT servie FROM regles WHERE id = ?", (regle["id"],)).fetchone()["servie"] >= 1
    # Une autre question n'est pas touchée par la règle.
    await deleguer("noah", "lea", f"Écris la lettre d'avril. Pose la question : Quel ton pour l'introduction ? | Autre sujet.\n{CONNU}")
    await settle()
    ton = [q for q in toutes() if q["titre"] == "Quel ton pour l'introduction ?"]
    assert ton and ton[0]["repondu_par"] == "noah" and ton[0]["reponse"] == "Sobre", ton
    print("2. « Corriger » enregistre la correction et la règle ; la même question reçoit la réponse retenue sans déranger personne ; une autre question reste à l'agent")


async def test_regle_sans_regle_et_droits(item):
    # Corriger sans retenir : la décision change, aucune règle.
    ton = [q for q in toutes() if q["titre"] == "Quel ton pour l'introduction ?"][0]
    r = await corriger(ton["id"], "Chaleureux", regle=False)
    assert r.status_code == 200 and r.json()["regle_id"] is None, r.text
    with J.db.connect() as c:
        assert c.execute("SELECT COUNT(*) FROM regles WHERE sujet = ?", (ton["titre"],)).fetchone()[0] == 0
    assert questions.regle_pour(owner, "lea", ton["titre"]) is None
    # Corriger une décision déjà corrigée met à jour sa règle, il n'y en a jamais deux.
    assert (await corriger(item["id"], "Moins de 30 caractères")).status_code == 200
    with J.db.connect() as c:
        assert [r["texte"] for r in c.execute("SELECT texte FROM regles WHERE sujet = ?", (item["titre"],))] == ["Moins de 30 caractères"]
    assert questions.regle_pour(owner, "lea", item["titre"])["texte"] == "Moins de 30 caractères"
    # Pas de correction vide, pas de correction d'une décision d'un autre compte.
    async with client() as h:
        assert (await h.post(f"/api/questions/{item['id']}/correction", json={"correction": "   "})).status_code == 400
    autre = auth.create_user("claire", "motdepasse-c")
    J.main.app.dependency_overrides[auth.current_user] = lambda: autre
    try:
        assert (await corriger(item["id"], "Pirate")).status_code == 404
        assert await decisions() == []
    finally:
        J.main.app.dependency_overrides[auth.current_user] = lambda: owner
    assert questions.regle_pour(owner, "lea", item["titre"])["texte"] == "Moins de 30 caractères"
    print("3. corriger sans règle ne retient rien, corriger deux fois met la règle à jour, une correction vide ou d'un autre compte est refusée")


async def go():
    tache = asyncio.create_task(joueur())
    try:
        item = await test_decide_pour_toi()
        await test_corriger_devient_regle(item)
        await test_regle_sans_regle_et_droits(item)
        print("OK : regles_test")
    finally:
        tache.cancel()
        faux.terminate()


asyncio.run(go())
