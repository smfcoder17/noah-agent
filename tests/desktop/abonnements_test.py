"""Le serveur des abonnements par l'ordinateur : tâches confiées à Claude Code et cerveau par le forfait ChatGPT.

Un vrai serveur Noah, une fausse application de bureau (des requêtes HTTP), un faux fournisseur habituel. Prouve : rien de privé dans le
battement, les refus lisibles (éteint, non installé, non connecté, non permis, déjà occupé, agent partagé), le résultat qui revient à
l'agent, l'attente par « en_cours », la progression et le bouton Stop pour le seul propriétaire, la déconnexion en cours de tâche, la
ligne 6 du juge ; et pour ChatGPT : l'ordinateur répond d'abord, puis le fournisseur habituel quand il est épuisé, éteint ou absent.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/desktop/abonnements_test.py"
"""
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = tempfile.mkdtemp()
os.environ["NOAH_DATA_DIR"] = DATA
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import access, auth, db, desktop, juge, main, modes, relay  # noqa: E402

db.init()
desktop.WAIT = 0.3
desktop._BOOT = 0
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
AGENT = "agent-alice"
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, ?, ?, ?)", (AGENT, "Nadine", "", "k", ALICE))

# Le fournisseur habituel : un serveur compatible OpenAI qui signe ses réponses.
upstream_calls = []


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        upstream_calls.append(body)
        reply = {"id": "u1", "object": "chat.completion", "model": body["model"], "usage": {"prompt_tokens": 3, "completion_tokens": 2},
                 "choices": [{"index": 0, "message": {"role": "assistant", "content": "réponse du fournisseur habituel"}, "finish_reason": "stop"}]}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
threading.Thread(target=up.serve_forever, daemon=True).start()
db.set_setting("provider", "custom")
db.set_setting("base_url", f"http://127.0.0.1:{up.server_address[1]}/v1")
db.set_setting("model", "habituel")

PORT = 18474
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(100):
    if server.started:
        break
    time.sleep(0.1)
assert server.started
BASE = f"http://127.0.0.1:{PORT}"


def session(user, name):
    token = auth.new_session(user, name, "desktop")
    return token, auth.device_id(auth.digest(token))


def client(token):
    return httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=60)


TOKEN, DEVICE = session(ALICE, "Bureau")
pc = client(TOKEN)
web_bruno = client(auth.new_session(BRUNO, "Bruno", "desktop"))
agent = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {relay.token_for(AGENT)}"}, timeout=60)
SUBS = {"claude": {"installe": True, "connecte": True, "offre": "max", "methode": "claude.ai", "permis": True, "email": "alice@exemple.fr"},
        "chatgpt": {"connecte": True, "permis": True, "jeton": "acces-secret"}}


def beat(subs=SUBS, **more):
    r = pc.post("/api/desktop/battement", json={"os": "win32", "dossiers": [{"id": "d1", "nom": "Projet", "ecriture": True}], "coupe": False,
                                                 "abonnements": subs, **more})
    assert r.status_code == 200, r.text


def next_item():
    r = pc.get("/api/desktop/next", params={"os": "win32", "fichiers": 1})
    return r.json() if r.status_code == 200 else None


def in_thread(fn):
    out = {}
    t = threading.Thread(target=lambda: out.__setitem__("r", fn()), daemon=True)
    t.start()
    return t, out


def desktop_answers(reply, action="claude", tries=60):
    """La fausse application : prend la prochaine demande de ce type et y répond (reply peut envoyer de la progression avant)."""
    def run():
        for _ in range(tries):
            item = next_item()
            if item and item["action"] == action:
                pc.post(f"/api/desktop/result/{item['id']}", json=reply(item))
                return item
        return None
    return in_thread(run)


# 1. Battement : des drapeaux et des mots courts, jamais un e-mail ni un jeton.
beat()
seen = agent.get("/agent-api/appareils").json()["appareils"]
mine = next(d for d in seen if d["id"] == DEVICE)
assert mine["abonnements"]["claude"] == {"installe": True, "connecte": True, "offre": "max", "methode": "claude.ai", "permis": True, "occupe": False}, mine
assert mine["abonnements"]["chatgpt"] == {"connecte": True, "permis": True}, mine
assert "alice@" not in json.dumps(seen) and "acces-secret" not in json.dumps(seen)
assert "acces-secret" not in json.dumps(pc.get("/api/devices").json())
print("1. le battement ne garde que des drapeaux : ni e-mail ni jeton, pour l'agent comme pour l'interface")

# 2. Refus lisibles : chacun dit à l'agent de faire la tâche lui-même.
TASK = {"consigne": "Résume le dossier dans resultat.md", "dossier": "Projet"}
for subs, word in (({**SUBS, "claude": {**SUBS["claude"], "permis": False}}, "pas permis"),
                   ({**SUBS, "claude": {**SUBS["claude"], "connecte": False}}, "pas connecté"),
                   ({**SUBS, "claude": {**SUBS["claude"], "installe": False}}, "pas installé")):
    beat(subs)
    r = agent.post("/agent-api/ordinateur/confier", json=TASK).json()
    assert word in r["erreur"] and "toi-même" in r["erreur"], r
real_guest = access.guest_task
access.guest_task = lambda agent_id: True
assert "partagé" in agent.post("/agent-api/ordinateur/confier", json=TASK).json()["erreur"]
access.guest_task = real_guest
desktop._seen[DEVICE]["at"] = 0  # application fermée
r = agent.post("/agent-api/ordinateur/confier", json=TASK).json()
assert "pas ouverte" in r["erreur"] and "toi-même" in r["erreur"], r
assert not desktop._tasks, "aucune tâche créée par un refus"
print("2. non permis, non connecté, non installé, agent partagé, application fermée : refus lisibles, rien n'est lancé")

# 3. La tâche part, la progression arrive, le résultat revient à l'agent qui continue.
beat()


def finished(item):
    assert item["consigne"] == TASK["consigne"] and item["dossierId"] == "Projet" and item["minutes"] == 30, item
    assert pc.post(f"/api/desktop/progres/{item['id']}", json={"lignes": ["Read notes.txt", "Write resultat.md‮"]}).status_code == 200
    assert web_bruno.post(f"/api/desktop/progres/{item['id']}", json={"lignes": ["faux"]}).status_code == 404
    return {"ok": True, "texte": "J'ai écrit resultat.md.", "fichiers": ["resultat.md"], "cout_estime_usd": 0.03, "dossier": "Projet"}


t, got = desktop_answers(finished)
r = agent.post("/agent-api/ordinateur/confier", json=TASK).json()
t.join(10)
assert r["ok"] and r["fichiers"] == ["resultat.md"] and r["texte"] == "J'ai écrit resultat.md." and r["id"], r
shown = pc.get(f"/api/agents/{AGENT}/taches-confiees").json()["taches"]
assert shown[0]["etat"] == "fini" and shown[0]["progression"] == ["Read notes.txt", "Write resultat.md "] and shown[0]["offre"] == "max", shown
assert shown[0]["appareil"] == "Bureau" and shown[0]["resultat"]["fichiers"] == ["resultat.md"], shown
assert web_bruno.get(f"/api/agents/{AGENT}/taches-confiees").status_code == 404
print("3. la tâche part vers l'ordinateur, la progression s'affiche (nettoyée), le résultat revient à l'agent ; un autre compte ne voit rien")

# 4. Tâche longue : « en_cours », attente relancée, une seule à la fois, Stop par la personne.
desktop.TASK_WAIT = 1
stopped = {}


def long_task():
    for _ in range(60):
        item = next_item()
        if item and item["action"] == "claude":
            break
    pc.post(f"/api/desktop/progres/{item['id']}", json={"lignes": ["étape 1"]})
    for _ in range(100):  # l'application vérifie la demande toutes les 3 s ; ici plus souvent
        if pc.get(f"/api/desktop/encore/{item['id']}").status_code == 404:
            stopped["vu"] = True
            break
        time.sleep(0.1)
    pc.post(f"/api/desktop/result/{item['id']}", json={"ok": False, "arret": "annule", "etapes": ["étape 1"]})


t = threading.Thread(target=long_task, daemon=True)
t.start()
r = agent.post("/agent-api/ordinateur/confier", json=TASK).json()
assert r.get("en_cours") and "confier-attendre" in r["conseil"], r
rid = r["id"]
time.sleep(0.5)
assert "tourne déjà" in agent.post("/agent-api/ordinateur/confier", json=TASK).json()["erreur"]
running = pc.get(f"/api/agents/{AGENT}/taches-confiees").json()["taches"]
assert any(x["id"] == rid and x["etat"] == "en_cours" and x["progression"] == ["étape 1"] for x in running), running
assert agent.get(f"/agent-api/ordinateur/confier/{rid}").json().get("en_cours")
assert web_bruno.post(f"/api/desktop/taches/{rid}/arreter").status_code == 404
assert pc.post(f"/api/desktop/taches/{rid}/arreter").json()["ok"]
t.join(15)
desktop.TASK_WAIT = 20
r = agent.get(f"/agent-api/ordinateur/confier/{rid}").json()
assert stopped.get("vu") and r["arret"] == "annule" and not r.get("ok"), r
print("4. tâche longue : « en_cours » puis attente relancée ; une seule à la fois ; Stop de la personne arrête l'ordinateur, pas celui d'un autre")

# 5. L'ordinateur disparaît pendant la tâche : l'agent le sait, avec la dernière progression.
def vanish():
    for _ in range(60):
        item = next_item()
        if item and item["action"] == "claude":
            pc.post(f"/api/desktop/progres/{item['id']}", json={"lignes": ["Edit main.py"]})
            desktop._seen[DEVICE]["at"] = 0
            return


t = threading.Thread(target=vanish, daemon=True)
t.start()
r = agent.post("/agent-api/ordinateur/confier", json=TASK).json()
t.join(10)
assert r.get("interrompue") and r["derniere_progression"] == ["Edit main.py"] and "déconnecté" in r["erreur"], r
print("5. ordinateur déconnecté en pleine tâche : « tâche interrompue », avec sa dernière étape")

# 6. Le juge : confier est une ligne 6 (Auto et Prudent demandent, Agir laisse passer) ; attendre et arrêter ne font rien de plus.
row, _ = juge.classify("terminal", {"command": 'python3 /opt/data/noah.py ordinateur confier "Range le dossier" --dossier Projet'})
assert row == 6, row
assert juge.AUTONOMY[6] == {"agir": "passe", "auto": "accord", "prudent": "accord", "signaler": "accord"}
assert juge.classify("terminal", {"command": "python3 /opt/data/noah.py ordinateur confier-attendre abc"})[0] == 1
print("6. juge : confier = ligne 6 ; confier-attendre ne demande rien")

# 7. ChatGPT : l'ordinateur répond d'abord ; épuisé, éteint ou absent, le fournisseur habituel répond.
beat()
CHAT = {"model": "n-importe", "messages": [{"role": "user", "content": "Bonjour"}]}


def from_plan(item):
    assert item["requete"]["messages"] == CHAT["messages"] and "model" not in item["requete"], item
    return {"ok": True, "modele": "gpt-essai", "reponse": {"id": "c1", "object": "chat.completion", "model": "gpt-essai",
            "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "réponse du forfait"}, "finish_reason": "stop"}]}}


t, _ = desktop_answers(from_plan, "chatgpt")
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "réponse du forfait" and not upstream_calls, r.text
with db.connect() as c:
    row = c.execute("SELECT model, cost FROM usage ORDER BY id DESC LIMIT 1").fetchone()
assert row["model"] == "forfait ChatGPT · gpt-essai" and row["cost"] == 0, dict(row)
t, _ = desktop_answers(from_plan, "chatgpt")
r = agent.post("/relay/v1/chat/completions", json={**CHAT, "stream": True})
t.join(10)
frames = [json.loads(x[5:]) for x in r.text.splitlines() if x.startswith("data: {")]
assert r.status_code == 200 and frames[0]["choices"][0]["delta"]["content"] == "réponse du forfait" and r.text.rstrip().endswith("data: [DONE]"), r.text
print("7a. ordinateur allumé et forfait permis : le tour passe par l'ordinateur (réponse entière ou en flux), coût 0 noté « forfait ChatGPT »")

t, _ = desktop_answers(lambda item: {"erreur": "limit", "statut": 429, "code": "subscription_sharing_usage_limit_exceeded"}, "chatgpt")
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "réponse du fournisseur habituel", r.text
assert modes.resting(desktop.CHATGPT_LINK)
asked = []
t, _ = in_thread(lambda: asked.append(next_item()))
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(5)
assert r.json()["choices"][0]["message"]["content"] == "réponse du fournisseur habituel" and asked == [None], asked
print("7b. forfait épuisé : le fournisseur habituel répond, et le forfait reste au repos sans redemander à l'ordinateur")

modes._cooling.clear()
desktop._seen[DEVICE]["at"] = 0  # ordinateur éteint
before = len(upstream_calls)
r = agent.post("/relay/v1/chat/completions", json=CHAT)
assert r.json()["choices"][0]["message"]["content"] == "réponse du fournisseur habituel" and len(upstream_calls) == before + 1
beat({**SUBS, "chatgpt": {"connecte": True, "permis": False}})
r = agent.post("/relay/v1/chat/completions", json=CHAT)
assert r.json()["choices"][0]["message"]["content"] == "réponse du fournisseur habituel"
beat()
access.guest_task = lambda agent_id: True
assert desktop.chatgpt_link(AGENT) is None
access.guest_task = real_guest
assert desktop.chatgpt_link(AGENT)["appareil"] == DEVICE
print("7c. ordinateur éteint, forfait non permis, agent partagé : le fournisseur habituel, sans erreur visible")
print("Abonnements par l'ordinateur : tout tient côté serveur.")
sys.stdout.flush()
os._exit(0)
