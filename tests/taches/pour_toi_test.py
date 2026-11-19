"""0.4.0, L2 (b) : « Pour toi » répond sur place. Une question qui arrive à la personne dit qui demande, pour quelle tâche, la question, le
pourquoi et les choix ; la réponse débloque l'agent sans ouvrir son fil ; la question disparaît partout (une seule ligne) et survit à un
redémarrage. Les choix qu'un agent propose dans son texte deviennent des lignes de la même table. Vrai `_run`, vraies routes, faux modèle.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/taches/pour_toi_test.py"
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joueur as J  # noqa: E402
from joueur import client, deleguer, faux, joueur, owner, questions, settle, toutes  # noqa: E402

from noah import auth, taches  # noqa: E402


async def a_toi() -> list[dict]:
    async with client() as h:
        r = await h.get("/api/a-toi")
    assert r.status_code == 200, r.text
    return r.json()


async def repondre(qid: str, texte: str):
    async with client() as h:
        return await h.post(f"/api/questions/{qid}/reponse", json={"reponse": texte})


async def test_la_carte_dit_tout():
    # Hugo confie la tâche à Léa ; la question que personne ne sait monte jusqu'à la personne.
    d = await deleguer("hugo", "lea", "Choisis le prestataire. Pose la question : Quel prestataire je prends ? | Deux offres sont proches.")
    await settle()
    items = await a_toi()
    assert len(items) == 1, items
    item = items[0]
    assert item["type"] == "question" and item["demande"] == "Quel prestataire je prends ?" and item["agent"] == "Léa" and item["a_moi"], item
    q = item["question"]
    assert q["de_nom"] == "Léa" and q["tache"] and q["titre"] == "Quel prestataire je prends ?" and "Deux offres" in q["pourquoi"], q
    assert [c["nom"] for c in q["chemin"]] == ["Léa", "Hugo", "Noah"] and q["libre"] and q["reserve"] == "", q
    # Le fil de Léa porte la même question dans sa tâche, et la tâche attend la personne.
    (tache,) = taches.liste(owner, "lea")
    assert tache["etat"] == "attend" and tache["question"]["id"] == q["id"], tache
    print("1. la question dit qui demande, pour quelle tâche, la question, le pourquoi, les choix et le chemin ; une ligne dans « Pour toi », la même dans la tâche")
    return d, q


async def test_repondre_sur_place(d, q):
    avant = len(J.runs)
    r = await repondre(q["id"], "Alpha")
    assert r.status_code == 200, r.text
    await settle()
    # L'agent est débloqué : il repart dans la conversation de la tâche, avec la réponse, sans que personne ouvre son fil.
    lea = [x for x in J.runs[avant:] if x["agent"] == "lea"]
    assert lea and lea[0]["conv"] == d["conversation_id"] and "Réponse à « Quel prestataire je prends ? » : Alpha" in lea[0]["text"], [x["text"][:80] for x in J.runs[avant:]]
    # La question disparaît partout : « Pour toi », la tâche, les compteurs.
    assert await a_toi() == []
    (tache,) = taches.liste(owner, "lea")
    assert tache["question"] is None and tache["etat"] != "attend", tache
    assert J.main.task_state.get(d["conversation_id"]) != "approve"
    # Une deuxième réponse, d'un autre onglet ou d'un autre appareil, n'est plus attendue.
    assert (await repondre(q["id"], "Beta")).status_code == 409
    print("2. répondre depuis « Pour toi » débloque l'agent sans ouvrir son fil ; la question disparaît partout, une seconde réponse est refusée")


async def test_survit_au_redemarrage():
    J.clear()
    await deleguer("hugo", "lea", "Prépare l'envoi. Pose la question : Quel jour on envoie la lettre ? | Deux dates possibles.")
    await settle()
    (item,) = await a_toi()
    qid = item["question"]["id"]
    # Redémarrage : l'état en mémoire est perdu, la base reste.
    J.main.task_state.clear()
    questions._events.clear()
    questions.recover()
    (apres,) = await a_toi()
    assert apres["question"]["id"] == qid, apres
    assert (await repondre(qid, "Jeudi")).status_code == 200
    await settle()
    J.main.task_state.clear()
    questions.recover()
    assert await a_toi() == [], "répondue avant le redémarrage : elle ne revient pas"
    assert questions.get(qid)["etat"] == "repondue" and questions.get(qid)["reponse"] == "Jeudi"
    print("3. une question qui attend, ou répondue, survit à un redémarrage : elle reste, ou ne revient pas")


async def test_droits():
    J.clear()
    await deleguer("hugo", "lea", "Pose la question : Quelle couleur pour la vignette ? | Trois teintes.")
    await settle()
    (item,) = await a_toi()
    autre = auth.create_user("bruno", "motdepasse-b")
    J.main.app.dependency_overrides[auth.current_user] = lambda: autre
    try:
        async with client() as h:
            assert (await h.get("/api/a-toi")).json() == [], "rien des autres comptes"
            assert (await h.post(f"/api/questions/{item['question']['id']}/reponse", json={"reponse": "Rouge"})).status_code == 404
            assert (await h.get("/api/decisions")).json() == {"decisions": []}
    finally:
        J.main.app.dependency_overrides[auth.current_user] = lambda: owner
    assert questions.get(item["question"]["id"])["etat"] == "attend"
    print("4. une question est à une seule personne : un autre compte ne la voit pas et ne peut pas y répondre")


async def test_choix_du_texte():
    J.clear()
    conv = J.MAINS["lea"]
    bloc = '```noah {"type":"choice","question":"On publie lundi ou mardi ?","options":["Lundi","Mardi"]}```'
    text = f"Le post est prêt.\n{bloc}"
    J.main._save_message(conv, "agent", text)
    with J.db.connect() as c:
        mid = c.execute("SELECT MAX(id) FROM messages WHERE conversation_id = ?", (conv,)).fetchone()[0]
    J.main.task_state[conv] = "choice"
    qid = questions.ouvrir_choix(conv, text, mid)
    assert qid and questions.ouvrir_choix(conv, text, mid) is None, "idempotent par message"
    items = await a_toi()
    assert len(items) == 1 and items[0]["question"]["genre"] == "choix" and items[0]["question"]["choix"] == ["Lundi", "Mardi"], items
    assert items[0]["demande"] == "On publie lundi ou mardi ?", "une seule ligne : pas aussi « Une question attend ta réponse. »"
    avant = len(J.runs)
    assert (await repondre(qid, "Lundi")).status_code == 200
    await settle()
    J.main.task_state[conv] = "done"
    relance = [x for x in J.runs[avant:] if x["agent"] == "lea"]
    assert relance and relance[0]["text"].endswith("Lundi") and relance[0]["conv"] == conv, [x["text"][:60] for x in J.runs[avant:]]
    assert await a_toi() == []
    # Écrire dans la conversation règle aussi le choix : une seule ligne vraie.
    text2 = '```noah {"type":"choice","question":"Quel ton ?","options":["Sobre","Vif"]}```'
    J.main._save_message(conv, "agent", text2)
    J.main.task_state[conv] = "choice"
    qid2 = questions.ouvrir_choix(conv, text2, None)
    assert len(await a_toi()) == 1
    questions.fermer_choix(conv)
    J.main.task_state[conv] = "work"  # ce que fait `_run` à ce même message
    assert await a_toi() == [] and questions.get(qid2)["etat"] == "repondue"
    # L'offre d'une suite (« Oui, vas-y » / « Non ») n'attend rien.
    offre = '```noah {"type":"choice","question":"Je programme la suite ?","options":["Oui, vas-y","Non"]}```'
    assert questions.ouvrir_choix(conv, offre, None) is None and await a_toi() == []
    print("5. un choix proposé dans le texte devient une ligne, répondue sur place ou en écrivant ; l'offre d'une suite n'en est pas une")


async def go():
    tache = asyncio.create_task(joueur())
    try:
        d, q = await test_la_carte_dit_tout()
        await test_repondre_sur_place(d, q)
        await test_survit_au_redemarrage()
        await test_droits()
        await test_choix_du_texte()
        print("OK : pour_toi_test")
    finally:
        tache.cancel()
        faux.terminate()


asyncio.run(go())
