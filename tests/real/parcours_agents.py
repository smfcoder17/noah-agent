"""Parcours réels J6, J7 et J8, à l'écrit : de vrais conteneurs Hermes, un vrai modèle, aucune simulation.

Dans le conteneur du serveur (agents démarrés, un modèle choisi) :
    docker cp tests/real/parcours_agents.py apollo-server:/tmp/ && docker exec -w /app -e PYTHONPATH=/app apollo-server python /tmp/parcours_agents.py
Rien ne dit à l'agent quelle commande employer : on vérifie ce que le modèle fait à partir d'une phrase d'utilisateur.
"""
import json
import sys
import time
import uuid

import httpx

from apollo import auth, db

BASE = "http://localhost:8080"
web = httpx.Client(base_url=BASE, headers={"Authorization": "Bearer " + auth.new_session(db.owner_id())}, timeout=180)
OK, BAD = [], []


def check(name: str, cond: bool, detail: str = "") -> None:
    (OK if cond else BAD).append(name)
    print("OK   " if cond else "ÉCHEC", name, detail, flush=True)


def wait(what: str, fn, seconds: int, step: float = 2):
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        v = fn()
        if v:
            print(f"     {what} : {time.monotonic() - t0:.0f} s", flush=True)
            return v
        time.sleep(step)
    print(f"     {what} : rien après {seconds} s", flush=True)
    return None


def agents() -> dict:
    return {a["name"]: a for a in web.get("/api/agents").json()}


def chat(agent_id: str, text: str) -> str:
    """Envoie une phrase et lit le flux jusqu'au bout. Rend les événements bruts pour le diagnostic."""
    frames = []
    with web.stream("POST", "/api/chat", json={"agent_id": agent_id, "text": text, "attachments": [], "details": False},
                    timeout=300) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if line.startswith("data:"):
                frames.append(line[5:].strip())
    return " | ".join(frames)[-400:]


def rows(sql: str, *args) -> list[dict]:
    with db.connect() as c:
        return [dict(r) for r in c.execute(sql, args)]


def latest_call() -> list[dict]:
    return rows("SELECT * FROM voice_calls ORDER BY created_at DESC LIMIT 1")


def main() -> None:
    noah = agents()["Noah"]["id"]

    # J6 : créer un deuxième agent, et il répond.
    t0 = time.monotonic()
    if "Rita" not in agents():
        r = web.post("/api/agents", json={"name": "Rita", "role": "Tu fais des calculs et tu écris leurs résultats dans des fichiers. Réponds en français, brièvement."})
        check("J6 : création de l'agent", r.status_code == 200, r.text[:200])
    rita = agents()["Rita"]["id"]
    ready = wait("agent prêt", lambda: agents()["Rita"].get("online") and not agents()["Rita"].get("provisioning"), 300)
    check("J6 : deuxième agent prêt", bool(ready), f"{time.monotonic() - t0:.0f} s")

    # Un marqueur nouveau à chaque passage : une réponse ne peut pas venir de la mémoire d'un passage précédent.
    mark = uuid.uuid4().hex[:6]
    before = len(rows("SELECT id FROM delegations"))

    # J7 : la phrase de l'utilisateur, en français courant, sans dire comment s'y prendre.
    print("     Noah :", chat(noah, f"Demande à Rita de calculer 17 fois 23 et d'écrire le résultat dans le fichier calcul-{mark}.txt, puis de te dire ce qu'elle a fait."), flush=True)
    d = wait("demande enregistrée", lambda: rows("SELECT * FROM delegations WHERE de = ? AND vers = ? ORDER BY created_at DESC LIMIT 1", noah, rita)
             if len(rows("SELECT id FROM delegations")) > before else None, 120)
    check("J7 : Noah confie la tâche à Rita, sans qu'on nomme la commande", bool(d))
    if d:
        did = d[0]["id"]
        done = wait("travail fini", lambda: [x for x in rows("SELECT etat FROM delegations WHERE id = ?", did) if x["etat"] != "en_cours"], 300)
        check("J7 : la demande finit", bool(done) and done[0]["etat"] == "fini", str(done))
        last = rows("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", d[0]["conversation_id"])
        print("     Rita :", (last[0]["text"] if last else "")[:300], flush=True)
        check("J7 : Rita donne le bon résultat", bool(last) and "391" in last[0]["text"])
        main_conv = rows("SELECT id FROM conversations WHERE agent_id = ? AND main = 1 LIMIT 1", noah)[0]["id"]
        back = wait("résultat revenu chez Noah", lambda: rows("SELECT id FROM messages WHERE conversation_id = ? AND role = 'agent' AND text LIKE '%Rita a fini%' AND text LIKE '%391%'", main_conv), 120)
        check("J7 : le résultat revient chez Noah", bool(back))
    print("FICHIER", rita, f"calcul-{mark}.txt", "391", flush=True)
    time.sleep(20)  # Noah reprend la main sur le résultat : on ne lui parle pas par-dessus

    # J8 : tâche écrite, puis l'agent fait sonner de lui-même. Le téléphone éteint relève du niveau 3.
    calls = len(rows("SELECT id FROM voice_calls"))
    mark2 = uuid.uuid4().hex[:6]
    print("     Rita :", chat(rita, f"Calcule 12 fois 12, écris-le dans carre-{mark2}.txt, puis rappelle-moi pour me donner le résultat de vive voix."), flush=True)
    call = wait("rappel", lambda: latest_call() if len(rows("SELECT id FROM voice_calls")) > calls else None, 120)
    check("J8 : l'agent rappelle de lui-même", bool(call))
    if call:
        c = call[0]
        print("     compte rendu :", c["texte"][:300], flush=True)
        check("J8 : le compte rendu dit le résultat", "144" in c["texte"])
        pending = web.get("/api/calls/pending").json()["appels"]
        check("J8 : l'appareil voit la sonnerie", any(p["id"] == c["id"] for p in pending), str(pending)[:200])
        r = web.post(f"/api/calls/{c['id']}/answer")
        check("J8 : on décroche", r.status_code == 200, r.text[:200])
        check("J8 : le compte rendu reste écrit", bool(rows("SELECT id FROM messages WHERE conversation_id = ? AND text LIKE '%appelé%' AND text LIKE '%144%'", c["conversation_id"])))
    print("FICHIER", rita, f"carre-{mark2}.txt", "144", flush=True)

    # Le chemin complet : Noah demande à Rita, et la fin de la demande fait sonner.
    calls = len(rows("SELECT id FROM voice_calls"))
    print("     Noah :", chat(noah, "Demande à Rita combien font 9 fois 9, et fais-moi rappeler quand c'est fini."), flush=True)
    call = wait("rappel après demande", lambda: latest_call() if len(rows("SELECT id FROM voice_calls")) > calls else None, 240)
    check("J8 : rappel à la fin d'une demande", bool(call) and "81" in call[0]["texte"], call[0]["texte"][:200] if call else "")

    print("     dépense du mois :", web.get("/api/usage").json().get("month_cost"))
    print(f"\n{len(OK)} tenus, {len(BAD)} ratés : {BAD}")
    sys.exit(1 if BAD else 0)


main()
