"""« hi » après une demande restée en suspens, sur un vrai conteneur Hermes : un message sans rapport reçoit une réponse à ce message.

Pile d'essai de compose.essai.yml, dans le conteneur du serveur :
    docker exec -w /app -e PYTHONPATH=/app noah-server python /t/reprise_vrai.py [--modele kimi-k3:cloud] [--cas arret,relance,fini] [--repete 2]

Le faux modèle joue l'ancienne demande (« connecte-toi à mon compte Google » : l'agent appelle la personne, le tour se finit ou se coupe).
Sans --modele : vérifie ce qui arrive au modèle avec le message suivant. Avec --modele : un vrai modèle (Ollama local, modèles :cloud)
répond à « hi », et le script dit s'il repart sur l'ancienne demande.
"""
import argparse
import asyncio
import json
import random
import re
import sys
import time
import uuid

import httpx

from noah import auth, db, hermes

BASE = "http://localhost:8080"
FAUX = "http://noah-faux:11500"
ASK = "Connecte-toi à mon compte Google."
CALL = 'python3 /opt/data/noah.py appeler "Connecte-toi à ton compte Google dans l\'écran." --quand-quitte accounts.google.com'
OLD_TOPIC = re.compile(r"google|connect|appel|expir|compte", re.I)

user = db.owner_id()
token = auth.new_session(user)
with db.connect() as d:
    row = d.execute("SELECT id, api_key FROM agents WHERE owner_id = ? ORDER BY pinned DESC, created_at LIMIT 1", (user,)).fetchone()
agent_id, agent = row["id"], hermes.Agent(row["id"], row["api_key"])
web = httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=300)


def new_conv() -> str:
    conv = uuid.uuid4().hex
    with db.connect() as d:
        d.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, origin, archived) VALUES (?, ?, ?, 'Reprise', 0, 'agent', 1)", (conv, user, agent_id))
    return conv


def turn(conv: str, text: str, until: str | None = None, seconds: float = 240):
    """Envoie un message et suit le flux ; `until` : rend la main dès cet événement, le flux reste ouvert côté serveur."""
    events, reply, run_id = [], "", None
    t0 = time.time()
    with web.stream("POST", f"{BASE}/api/chat", json={"agent_id": agent_id, "text": text, "conversation_id": conv, "attachments": [], "details": True}) as r:
        r.raise_for_status()
        buf = ""
        for chunk in r.iter_text():
            buf += chunk
            while "\n\n" in buf:
                frame, buf = buf.split("\n\n", 1)
                if not frame.startswith("data:"):
                    continue
                ev = json.loads(frame[5:])
                events.append(ev)
                run_id = ev.get("run_id") or run_id
                if ev.get("type") == "message":
                    reply += ev.get("text", "")
                if ev.get("type") == "done":
                    return {"run": run_id, "events": events, "reply": reply or ev.get("output") or "", "status": ev.get("status"), "error": ev.get("error"), "ms": (time.time() - t0) * 1000}
                if until and ev.get("type") == until:
                    return {"run": run_id, "events": events, "reply": reply, "status": "ouvert", "ms": (time.time() - t0) * 1000}
            if time.time() - t0 > seconds:
                break
    return {"run": run_id, "events": events, "reply": reply, "status": "coupé", "ms": (time.time() - t0) * 1000}


def faux(path: str, body=None):
    if body is None:
        return web.get(FAUX + path).json()
    return web.post(FAUX + path, json=body).json()


def wait_idle(conv: str, seconds: float = 60) -> None:
    for _ in range(int(seconds * 2)):
        if not web.get(f"{BASE}/api/conversations/{conv}/en-cours").json()["occupe"]:
            return
        time.sleep(0.5)
    raise SystemExit("la conversation reste occupée")


def wait_healthy(seconds: float = 180) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if httpx.get(f"{agent.url}/health", timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise SystemExit("l'agent ne revient pas")


def prepare(case: str) -> str:
    """Laisse la conversation dans l'état d'une demande restée en suspens."""
    faux("/_relais", {})
    conv = new_conv()
    if case == "fini":  # le tour se termine normalement sur « je t'ai appelé » : un vrai appel, resté ouvert, sans attendre ses 150 s
        command = f"timeout 2 {CALL}; echo '{{\"reponse\": \"en_attente\", \"id\": \"abc123\", \"conseil\": \"Relance python3 /opt/data/noah.py attendre abc123.\"}}'"
        faux("/_suite", {"suite": [{"outil": "terminal", "args": {"command": command}},
                                   {"texte": "Je t'ai appelé : connecte-toi à ton compte Google dans l'écran. Je t'attends."}]})
        done = turn(conv, ASK)
        assert done["status"] == "completed", done
        return conv
    faux("/_suite", {"suite": [{"outil": "terminal", "args": {"command": CALL}}]})
    started = turn(conv, ASK, until="activity")
    assert started["run"], started
    time.sleep(1.5)
    if case == "arret":  # la personne arrête le travail pendant l'appel : le tour se coupe sur un outil en attente
        web.post(f"{agent.url}/v1/runs/{started['run']}/stop", headers=agent.headers).raise_for_status()
    elif case == "relance":  # une mise à jour ou un plantage coupe le conteneur pendant l'appel
        asyncio.run(hermes.restart(agent_id))
        hermes._shared = None
        time.sleep(3)
        wait_healthy()
    wait_idle(conv)
    return conv


def still_works(model: str) -> int:
    """L'autre moitié de la promesse : ce que la personne demande vraiment part, outils compris."""
    failures = 0
    for case, text, must_use_tools in (
        ("arret", "Oui, reprends la connexion Google.", True),
        ("fini", "C'est fait, je suis connecté, tu peux vérifier.", True),
        ("arret", "Crée le fichier /opt/data/workspace/outputs/courses.txt avec le mot pain dedans, puis dis-moi combien d'octets il fait.", True),
    ):
        conv = prepare(case)
        faux("/_vider", {})
        faux("/_relais", {"url": "http://host.docker.internal:11434/v1", "cle": "ollama", "modele": model})
        out = turn(conv, text)
        tools_called = [e.get("label") for e in out["events"] if e.get("type") == "activity"]
        ok = bool(tools_called) == must_use_tools
        failures += not ok
        print("OK   " if ok else "ÉCHEC", json.dumps({"cas": case, "message": text[:60], "ms": round(out["ms"]), "outils": tools_called, "reponse": out["reply"][:200]}, ensure_ascii=False))
        faux("/_relais", {})
    return failures


def while_calling(model: str | None = None, seconds: float = 200) -> int:
    """« hi » pendant que l'agent attend la réponse à son appel : le tri l'a mis à la suite. Il ne doit pas attendre la fin de l'appel."""
    faux("/_relais", {})
    conv = new_conv()
    faux("/_suite", {"suite": [{"outil": "terminal", "args": {"command": CALL}}]})
    started = turn(conv, ASK, until="activity")
    assert started["run"], started
    time.sleep(2)
    if model:
        faux("/_relais", {"url": "http://host.docker.internal:11434/v1", "cle": "ollama", "modele": model})
    t0 = time.time()
    r = web.post(f"{BASE}/api/chat/pendant", json={"agent_id": agent_id, "text": "hi", "conversation_id": conv, "client_id": uuid.uuid4().hex, "choix": "tache"})
    r.raise_for_status()
    while time.time() - t0 < seconds:
        rows = web.get(f"{BASE}/api/conversations/{conv}/messages").json()
        said = [m["role"] for m in rows]
        if "hi" in [m["text"] for m in rows] and said[-1] != "user":
            break
        time.sleep(0.2)
    took = time.time() - t0
    rows = web.get(f"{BASE}/api/conversations/{conv}/messages").json()
    print(json.dumps({"attente_s": round(took, 1), "messages": [(m["role"], m["text"][:60]) for m in rows]}, ensure_ascii=False))
    faux("/_relais", {})
    return took > 30


def bounded(model: str) -> int:
    """Contexte borné : après le résumé, un fait dit au début se retrouve, et l'agent travaille toujours. Le faux modèle fabrique le
    volume ; le vrai modèle écrit le résumé et répond."""
    words = "rapport page liens formulaire paragraphe texte compte personne navigateur connexion service fichier réglage mesure tableau courriel agenda".split()
    faux("/_relais", {"url": "http://host.docker.internal:11434/v1", "cle": "ollama", "modele": model})
    faux("/_latence", {"jetons_reels": True})
    conv = new_conv()
    turn(conv, "Retiens ceci pour plus tard : le code du portail de l'immeuble est 7342. Réponds juste que c'est noté.")
    for _ in range(13):
        text = " ".join(random.choice(words) + str(random.randint(0, 999)) for _ in range(2000))
        faux("/_suite", {"suite": [{"texte": text}]})
        turn(conv, "Continue.")
    faux("/_vider", {})
    recall = turn(conv, "Quel est le code du portail de l'immeuble ?")
    calls = faux("/_journal")["appels"]
    first = next(c for c in calls if c["outils"])
    sent = first["octets"] // 4
    ok_recall = "7342" in recall["reply"]
    print("OK   " if ok_recall else "ÉCHEC", json.dumps({"jetons_envoyes": sent, "ms": round(recall["ms"]), "premier_mot_fournisseur_ms": round((first["t_premier_mot"] - first["t"]) * 1000) if first.get("t_premier_mot") else None,
                                                         "outils": [e.get("label") for e in recall["events"] if e.get("type") == "activity"], "reponse": recall["reply"][:200]}, ensure_ascii=False))
    work = turn(conv, "Crée le fichier /opt/data/workspace/outputs/portail.txt avec ce code dedans, puis relis-le pour vérifier.")
    used = [e.get("label") for e in work["events"] if e.get("type") == "activity"]
    ok_work = bool(used) and work["status"] == "completed"
    print("OK   " if ok_work else "ÉCHEC", json.dumps({"ms": round(work["ms"]), "outils": used, "reponse": work["reply"][:200]}, ensure_ascii=False))
    faux("/_relais", {})
    too_big = sent > 70000
    if too_big:
        print("ÉCHEC : le contexte n'est pas borné :", sent)
    return (not ok_recall) + (not ok_work) + too_big


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--modele")
    p.add_argument("--cas", default="arret,relance,fini")
    p.add_argument("--repete", type=int, default=1)
    p.add_argument("--texte", default="hi")
    p.add_argument("--qualite", action="store_true", help="avec --modele : une vraie demande après l'ancienne part toujours, outils compris")
    p.add_argument("--borne", action="store_true", help="avec --modele : après le résumé du début, un fait se retrouve et un outil marche")
    p.add_argument("--pendant", action="store_true", help="« hi » pendant que l'agent attend la réponse à son appel")
    a = p.parse_args()
    if a.pendant:
        sys.exit(1 if while_calling(a.modele) else 0)
    if a.qualite:
        sys.exit(1 if still_works(a.modele) else 0)
    if a.borne:
        sys.exit(1 if bounded(a.modele) else 0)
    failures = 0
    for case in a.cas.split(","):
        for i in range(a.repete):
            conv = prepare(case)
            faux("/_vider", {})
            faux("/_relais", {"url": "http://host.docker.internal:11434/v1", "cle": "ollama", "modele": a.modele} if a.modele else {})
            out = turn(conv, a.texte)
            calls = faux("/_journal")["appels"]
            first = next((c for c in calls if c["outils"]), {})
            last_msgs = json.loads(first.get("tout") or "[]")[-4:]
            seen = [{"role": m.get("role"), "texte": str(m.get("content"))[:220], "outils": [t["function"]["name"] for t in m.get("tool_calls") or []]} for m in last_msgs]
            tools_called = [e.get("label") for e in out["events"] if e.get("type") == "activity"]
            relaunched = bool(tools_called)  # dire en une phrase ce qui attend est permis ; relancer l'ancienne demande, non
            print(json.dumps({"cas": case, "essai": i, "statut": out["status"], "ms": round(out["ms"]), "reponse": out["reply"][:300], "outils": tools_called, "erreur": out.get("error"), "repart_sur_l_ancienne": relaunched, "en_parle": bool(OLD_TOPIC.search(out["reply"])), "recu_par_le_modele": seen}, ensure_ascii=False, indent=1))
            failures += relaunched if a.modele else 0
            if not a.modele:  # sans vrai modèle : ce qui lui arrive doit lui dire de répondre à ce message
                said = str(last_msgs[-1].get("content")) if last_msgs else ""
                wanted = "Réponds au message ci-dessous" in said and (case == "fini" or ASK in said)
                if not (wanted and said.endswith(a.texte)):
                    print("ÉCHEC : la note n'arrive pas au modèle :", said[:400])
                    failures += 1
                if case != "fini" and "Réponds d'abord au dernier message" not in first.get("systeme", ""):
                    print("ÉCHEC : la règle n'est pas dans les consignes")
                    failures += 1
            faux("/_relais", {})
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
