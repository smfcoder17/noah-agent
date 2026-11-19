"""0.4.0, L2 (a) : une question monte d'un cran à la fois. Agent qui a confié la tâche, puis chef d'équipe (le premier agent créé), puis la
personne, avec son chemin ; un sujet réservé saute la chaîne ; un échange qui tourne en rond s'arrête. Vrai `_run`, vraies routes, faux
modèle ; voir tests/taches/joueur.py.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/questions_test.py"
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joueur as J  # noqa: E402
from joueur import deleguer, faux, joueur, owner, questions, settle, toutes  # noqa: E402

CONNU = "Réponses connues : heure=8 h ; ville=Lyon ; budget=200 euros"


def a_la_personne() -> list[dict]:
    return questions.a_la_personne(owner)


async def test_reponse_dans_la_demande():
    # Trois tâches que Noah a confiées à Léa : chaque question trouve sa réponse dans la demande de Noah. « Pour toi » reste vide.
    for sujet in ("heure", "ville", "budget"):
        await deleguer("noah", "lea", f"Prépare le voyage. Pose la question : Quelle {sujet} je retiens ? | Sans elle je ne peux pas avancer.\n{CONNU}")
        await settle()
    rows = toutes()
    assert len(rows) == 3, [(q["de"], q["a"], q["titre"], q["etat"], q["reponse"]) for q in rows]
    assert all(q["etat"] == "repondue" and q["repondu_par"] == "noah" and q["a"] == "noah" for q in rows), rows
    assert [q["reponse"] for q in rows] == ["8 h", "Lyon", "200 euros"], [q["reponse"] for q in rows]
    assert all(q["chemin"] == ["lea", "noah"] for q in rows), [q["chemin"] for q in rows]
    assert a_la_personne() == [], "la personne n'a rien à trancher"
    # La réponse est revenue à Léa, dans la conversation de la tâche, et son travail est allé au bout.
    revenues = [r for r in J.runs if r["agent"] == "lea" and r["text"].startswith("[Réponse à ta question")]
    assert len(revenues) == 3, [r["text"][:60] for r in J.runs if r["agent"] == "lea"]
    assert "Réponse à « Quelle heure je retiens ? » : 8 h" in revenues[0]["text"], revenues[0]["text"]
    with J.db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM delegations WHERE etat = 'fini'").fetchone()["n"] == 3
    print("1. trois questions dont la réponse est dans la demande : réglées par Noah, « Pour toi » reste vide")


async def test_monte_jusqu_a_la_personne():
    J.clear()
    # Hugo confie la tâche à Léa. Léa pose une question que ni Hugo ni Noah (chef d'équipe) ne savent : elle monte d'un cran à la fois.
    d = await deleguer("hugo", "lea", "Choisis le prestataire. Pose la question : Quel prestataire je prends ? | Deux offres sont proches.")
    await settle()
    (q,) = toutes()
    assert q["etat"] == "attend" and q["a"] == "" and q["chemin"] == ["lea", "hugo", "noah"], q
    assert q["conversation_id"] == d["conversation_id"] and q["tache_id"]
    attendues = a_la_personne()
    assert len(attendues) == 1 and attendues[0]["de_nom"] == "Léa" and attendues[0]["titre"] == "Quel prestataire je prends ?"
    assert [c["nom"] for c in attendues[0]["chemin"]] == ["Léa", "Hugo", "Noah"], attendues[0]["chemin"]
    assert "Hugo" in q["pourquoi"] and "Noah" in q["pourquoi"], q["pourquoi"]  # ce que chacun a dit en remontant
    # La tâche de Léa attend la personne : elle n'est pas rendue à Hugo comme finie.
    assert J.main.task_state[q["conversation_id"]] == "approve"
    with J.db.connect() as c:
        assert c.execute("SELECT etat FROM delegations WHERE id = ?", (d["id"],)).fetchone()["etat"] == "en_cours"
    print("2. une question sans réponse monte de Léa à Hugo, à Noah, puis à la personne, avec son chemin :", " > ".join(c["nom"] for c in attendues[0]["chemin"]))


async def test_sujet_reserve():
    J.clear()
    avant = len(J.runs)
    for texte in ("Je peux payer 40 euros pour l'abonnement ?", "Je supprime définitivement les anciennes factures ?",
                  "Quel mot de passe je mets pour le compte ?", "Je publie ce post sur le compte Instagram ?"):
        await deleguer("hugo", "lea", f"Avance. Pose la question : {texte} | Il faut trancher.")
        await settle()
    rows = toutes()
    assert [q["reserve"] for q in rows] == ["payer", "supprimer", "secrets", "publier"], [q["reserve"] for q in rows]
    assert all(q["a"] == "" and q["chemin"] == ["lea"] and q["etat"] == "attend" for q in rows), rows
    sollicites = [r for r in J.runs[avant:] if r["agent"] in ("hugo", "noah")]
    assert sollicites == [], "aucun agent n'a été sollicité : " + str([r["text"][:50] for r in sollicites])
    assert questions.sujet_reserve("Quelle couleur pour le bouton ?") == "" and questions.sujet_reserve("x", "payer") == "payer"
    print("3. payer, supprimer pour toujours, secrets et droits, première publication : directement à la personne, chemin d'un cran")


async def test_boucle():
    J.clear()
    # Léa et Hugo se renvoient la même question : après TOURS_MAX échanges elle ne passe plus par eux et monte à la personne.
    d = await deleguer("hugo", "lea", "Mets au point le planning.")
    await settle()
    suivantes = []
    for _ in range(questions.TOURS_MAX + 1):
        J.relay.active["lea"] = [d["conversation_id"]]
        try:
            out = questions.poser("lea", "Quel jour on fixe le tournage ?", "Je tourne en rond.")
        finally:
            J.relay.active.pop("lea", None)
        suivantes.append(out)
        if out["a"] != "la personne":
            questions.repondre(out["id"], questions.get(out["id"])["a"], "On verra.")  # l'agent répond à côté : la même question revient
    assert [o["a"] for o in suivantes[:questions.TOURS_MAX]] == ["Hugo"] * questions.TOURS_MAX, suivantes
    assert suivantes[-1]["a"] == "la personne", suivantes
    assert "tourne en rond" in questions.get(suivantes[-1]["id"])["pourquoi"]
    print("4. deux agents qui tournent en rond :", questions.TOURS_MAX, "tours, puis la question monte à la personne")


async def test_delai_et_redemarrage():
    J.clear()
    # Un agent qui ne répond pas dans DELAI_AGENT laisse la question monter d'un cran.
    questions.DELAI_AGENT = 0.2
    try:
        J.down.add("noah")  # Noah est injoignable : sa relance échoue, la question monte sans attendre le délai
        await deleguer("noah", "lea", "Avance sur le dossier. Pose la question : Quel format pour la vignette ?")
        await settle()
    finally:
        J.down.discard("noah")
        questions.DELAI_AGENT = 600
    (q,) = toutes()
    assert q["a"] == "" and q["etat"] == "attend" and q["chemin"] == ["lea", "noah"], q
    # Redémarrage : une question qui attendait un agent monte, une question à la personne reste, aucune n'est perdue.
    with J.db.connect() as c:
        c.execute("UPDATE questions SET a = 'noah' WHERE id = ?", (q["id"],))
    questions.recover()
    assert questions.get(q["id"])["a"] == "" and questions.get(q["id"])["etat"] == "attend"
    print("5. un agent injoignable ou un redémarrage : la question monte à la personne, elle n'est jamais perdue")


async def go():
    tache = asyncio.create_task(joueur())
    try:
        await test_reponse_dans_la_demande()
        await test_monte_jusqu_a_la_personne()
        await test_sujet_reserve()
        await test_boucle()
        await test_delai_et_redemarrage()
        print("OK : questions_test")
    finally:
        tache.cancel()
        faux.terminate()


asyncio.run(go())
