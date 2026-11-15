"""Lot A de la 0.3.0, côté serveur : « Claude Code (ton ordinateur) » et « ChatGPT (ton ordinateur) » choisis comme fournisseurs.

Un vrai serveur Noah, une fausse application de bureau (des requêtes HTTP), un faux fournisseur habituel (le secours). Prouve :
A1 un tour du cerveau part vers l'ordinateur et sa réponse revient à l'agent ; A2 un appel d'outil revient en `tool_calls` valides, en
entier comme en flux ; A3 les modèles annoncés par l'ordinateur sont listés et le modèle choisi est celui envoyé ; A4 ordinateur éteint,
disparu en route, abonnement épuisé : le secours répond, la conversation reçoit sa ligne, rien n'est perdu ; A6 la même chose avec
ChatGPT ; A7 l'Activité et le suivi portent « Claude Code · opus · abonnement », jetons, durée, « compris dans l'abonnement », sans
« prix inconnu » ; A8 un agent partagé ou la tâche d'un invité ne passent jamais par l'abonnement du propriétaire.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/desktop/abonnements_fournisseurs_test.py"
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

from noah import access, auth, db, decision, desktop, main, modes, relay  # noqa: E402

db.init()
desktop.WAIT = 0.3
desktop._BOOT = 0
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
AGENT = "agent-alice"
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, ?, ?, ?)", (AGENT, "Nadine", "", "k", ALICE))
CONV = main._new_conversation(ALICE, AGENT, "Conversation", main=True)

upstream_calls = []


class Upstream(BaseHTTPRequestHandler):
    """Le fournisseur habituel (le secours) : compatible OpenAI, il signe ses réponses."""

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        upstream_calls.append(body)
        reply = {"id": "u1", "object": "chat.completion", "model": body["model"], "usage": {"prompt_tokens": 3, "completion_tokens": 2},
                 "choices": [{"index": 0, "message": {"role": "assistant", "content": "réponse du secours"}, "finish_reason": "stop"}]}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        data = json.dumps({"data": [{"id": "habituel"}, {"id": "petit"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}/v1"
db.set_setting("provider", "custom")
db.set_setting("base_url", UP)
db.set_setting("model", "habituel")

PORT = 18475
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(100):
    if server.started:
        break
    time.sleep(0.1)
assert server.started
BASE = f"http://127.0.0.1:{PORT}"


def client(token):
    return httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=60)


TOKEN = auth.new_session(ALICE, "Bureau", "desktop")
DEVICE = auth.device_id(auth.digest(TOKEN))
pc = client(TOKEN)
bruno = client(auth.new_session(BRUNO, "Bruno", "web"))
agent = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {relay.token_for(AGENT)}"}, timeout=60)
SUBS = {"claude": {"installe": True, "connecte": True, "offre": "max", "methode": "claude.ai", "permis": False, "cerveau": True,
                   "modeles": ["sonnet", "opus", "haiku", "--pas un modèle", 42], "email": "alice@exemple.fr"},
        "chatgpt": {"connecte": True, "permis": True, "modeles": ["gpt-essai"], "jeton": "acces-secret"}}


def beat(subs=SUBS):
    r = pc.post("/api/desktop/battement", json={"os": "win32", "dossiers": [], "coupe": False, "abonnements": subs})
    assert r.status_code == 200, r.text


def next_item():
    r = pc.get("/api/desktop/next", params={"os": "win32", "fichiers": 1})
    return r.json() if r.status_code == 200 else None


def in_thread(fn):
    out = {}
    t = threading.Thread(target=lambda: out.__setitem__("r", fn()), daemon=True)
    t.start()
    return t, out


def desktop_answers(reply, tries=40):
    """La fausse application : prend la prochaine demande et y répond. Rend la demande reçue."""
    def run():
        for _ in range(tries):
            item = next_item()
            if item:
                answer = reply(item)
                if answer is not None:
                    pc.post(f"/api/desktop/result/{item['id']}", json=answer)
                return item
        return None
    return in_thread(run)


def completion(content, tool_calls=None, model="opus"):
    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {"ok": True, "modele": model, "duree_ms": 1200, "reponse": {
        "id": "cc1", "object": "chat.completion", "model": model,
        "usage": {"prompt_tokens": 1200, "completion_tokens": 34, "total_tokens": 1234, "prompt_tokens_details": {"cached_tokens": 200}},
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}]}}


def relayed():
    """Les tours de l'agent arrivés chez le secours (les mesures de fond du modèle de décision n'en sont pas)."""
    return [b for b in upstream_calls if b.get("tools") == TOOLS]


def last_usage():
    with db.connect() as c:
        return dict(c.execute("SELECT model, cost, prompt_tokens, completion_tokens, cached_tokens, conversation_id FROM usage ORDER BY id DESC LIMIT 1").fetchone())


relay.active[AGENT] = [CONV]  # un tour de la conversation principale est en cours : les appels du relais lui sont comptés
TOOLS = [{"type": "function", "function": {"name": "terminal", "description": "Lance une commande", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}]
CHAT = {"model": "opus", "messages": [{"role": "system", "content": "Tu es Nadine."}, {"role": "user", "content": "Bonjour"}], "tools": TOOLS}

# 0. Sans ordinateur prêt : le fournisseur est listé, mais le brancher dit où aller.
listed = {p["id"]: p for p in pc.get("/api/fournisseurs").json()}
assert listed["ordinateur:claude-code"]["ordinateur"] is True and listed["ordinateur:claude-code"]["pret"] is False, listed["ordinateur:claude-code"]
assert listed["ordinateur:chatgpt"]["label"] == "ChatGPT (ton ordinateur)" and listed["ordinateur:claude-code"]["needs_key"] is False
r = pc.put("/api/fournisseurs/ordinateur:claude-code", json={})
assert r.status_code == 400 and "Ouvre Noah Agent sur ton ordinateur" in r.json()["detail"], r.text
assert bruno.get("/api/fournisseurs").status_code == 403 and bruno.put("/api/fournisseurs/ordinateur:claude-code", json={}).status_code == 403
print("0. listé sans ordinateur prêt ; le brancher dit d'ouvrir Noah Agent sur l'ordinateur ; réservé au propriétaire")

# A3. Les modèles annoncés par l'ordinateur sont ceux du fournisseur, « compris dans l'abonnement » ; le modèle choisi est celui envoyé.
beat()
listed = {p["id"]: p for p in pc.get("/api/fournisseurs").json()}
assert listed["ordinateur:claude-code"]["pret"] is True
r = pc.put("/api/fournisseurs/ordinateur:claude-code", json={})
assert r.status_code == 200 and r.json() == {"connected": True, "models": 3}, r.text
models = [m for m in pc.get("/api/modes/cerveau/modeles").json()["modeles"] if m["fournisseur"] == "ordinateur:claude-code"]
assert [m["id"] for m in models] == ["sonnet", "opus", "haiku"], models
assert all(m["abonnement"] is True and m["prix"] == "compris dans l'abonnement" and m["free"] is False for m in models), models
assert not any(m.get("abonnement") for m in modes.free_order(models)), "un abonnement n'entre jamais seul dans Gratuit"
desktop._seen[DEVICE]["at"] = 0  # ordinateur éteint : la liste reste, la dernière vue
assert [m["id"] for m in desktop.pc_models("ordinateur:claude-code")] == ["sonnet", "opus", "haiku"]
beat()
r = pc.post("/api/model", json={"provider": "ordinateur:claude-code", "model": "opus"})
assert r.status_code == 200, r.text
assert relay.fallback_link() == {"modele": "habituel", "fournisseur": "custom"}, relay.fallback_link()
assert decision._credentials() == ("custom", None, UP) and decision._brain() == "habituel", "les petits travaux restent chez le secours"
print("A3. modèles de l'ordinateur listés (compris dans l'abonnement), gardés ordinateur éteint ; choisi : opus ; le cerveau d'avant devient le secours")

# A1. Le tour part vers l'ordinateur ; la réponse revient, en entier et en flux.
seen = []


def answer_claude(item):
    seen.append(item)
    return completion("réponse de Claude Code")


t, _ = desktop_answers(answer_claude)
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "réponse de Claude Code", r.text
item = seen[-1]
assert item["action"] == "claude_cerveau" and item["modele"] == "opus", item
assert item["requete"]["messages"] == CHAT["messages"] and item["requete"]["tools"] == TOOLS and "model" not in item["requete"], item
assert not relayed(), "rien chez le secours"
t, _ = desktop_answers(answer_claude)
r = agent.post("/relay/v1/chat/completions", json={**CHAT, "stream": True})
t.join(10)
frames = [json.loads(x[5:]) for x in r.text.splitlines() if x.startswith("data: {")]
assert frames[0]["choices"][0]["delta"]["content"] == "réponse de Claude Code" and r.text.rstrip().endswith("data: [DONE]"), r.text
print("A1. un tour du cerveau passe par Claude Code sur l'ordinateur : réponse entière ou en flux ; le modèle choisi part avec lui")

# A7. Suivi et Activité : « Claude Code · opus · abonnement », jetons, durée, 0 $ compris dans l'abonnement, pas « prix inconnu ».
row = last_usage()
assert row == {"model": "Claude Code · opus · abonnement", "cost": 0, "prompt_tokens": 1200, "completion_tokens": 34, "cached_tokens": 200,
               "conversation_id": CONV}, row
assert relay.turn_model[CONV] == "Claude Code · opus · abonnement"
log = pc.get(f"/api/agents/{AGENT}/activite").json()
turn = next(x for x in log if x["kind"] == "cerveau")
assert turn["titre"] == "Claude Code · opus · abonnement" and turn["etat"] == "fait", turn
assert turn["resultat"].startswith("1 234 jetons · ") and turn["resultat"].endswith(" s · compris dans l'abonnement"), turn
assert pc.get("/api/usage").json()["non_suivi"] is False, "compris dans l'abonnement n'est pas un prix inconnu"
print("A7. Activité : « Claude Code · opus · abonnement », 1 234 jetons, durée, compris dans l'abonnement ; le suivi ne le compte pas en « prix inconnu »")

# A2. Appel d'outil : les tool_calls de l'ordinateur reviennent tels quels à Hermes, en entier et en flux.
CALL = [{"id": "call_abc", "type": "function", "function": {"name": "terminal", "arguments": "{\"command\": \"echo bonjour\"}"}}]
t, _ = desktop_answers(lambda item: completion("Je regarde.", CALL))
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
choice = r.json()["choices"][0]
assert choice["finish_reason"] == "tool_calls" and choice["message"]["tool_calls"] == CALL, r.text
t, _ = desktop_answers(lambda item: completion(None, CALL))
r = agent.post("/relay/v1/chat/completions", json={**CHAT, "stream": True})
t.join(10)
frames = [json.loads(x[5:]) for x in r.text.splitlines() if x.startswith("data: {")]
calls = [f["choices"][0]["delta"]["tool_calls"] for f in frames if f["choices"][0]["delta"].get("tool_calls")]
assert calls == [[{"index": 0, **CALL[0]}]] and frames[-1]["choices"][0]["finish_reason"] == "tool_calls", r.text
history = {**CHAT, "messages": [*CHAT["messages"], {"role": "assistant", "content": None, "tool_calls": CALL},
                                 {"role": "tool", "tool_call_id": "call_abc", "content": "bonjour"}]}
t, got = desktop_answers(lambda item: completion("Le terminal dit bonjour."))
r = agent.post("/relay/v1/chat/completions", json=history)
t.join(10)
assert r.json()["choices"][0]["message"]["content"] == "Le terminal dit bonjour." and got["r"]["requete"]["messages"][-1]["role"] == "tool", r.text
print("A2. appel d'outil : tool_calls valides (entier et flux), puis le résultat de l'outil repart vers l'ordinateur et la réponse finale revient")

# A4. Ordinateur éteint, disparu en route, abonnement épuisé : le secours répond ; la conversation reçoit sa ligne ; rien n'est perdu.
relay.turn_notes.clear()
desktop._seen[DEVICE]["at"] = 0
r = agent.post("/relay/v1/chat/completions", json=CHAT)
assert r.json()["choices"][0]["message"]["content"] == "réponse du secours" and relayed()[-1]["model"] == "habituel", r.text
assert relay.turn_notes[CONV] == "Ton ordinateur est éteint : réponse par Autre service compatible OpenAI · habituel.", relay.turn_notes
assert len(relayed()) == 1
beat()
relay.turn_notes.clear()


def vanish(item):
    desktop._seen[DEVICE]["at"] = 0  # l'application se ferme pendant le tour
    return None


t, _ = desktop_answers(vanish)
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
assert r.json()["choices"][0]["message"]["content"] == "réponse du secours" and len(relayed()) == 2, r.text
assert modes.resting({"modele": "opus", "fournisseur": "ordinateur:claude-code"}), "disparu : au repos une minute"
modes._cooling.clear()
beat()
t, limited = desktop_answers(lambda item: {"erreur": "Claude usage limit reached", "statut": 429, "code": "limite"})
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
assert limited["r"]["action"] == "claude_cerveau", limited
assert r.json()["choices"][0]["message"]["content"] == "réponse du secours" and len(relayed()) == 3, r.text
assert modes.resting({"modele": "opus", "fournisseur": "ordinateur:claude-code"})
asked = []
t, _ = in_thread(lambda: asked.append(next_item()))
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(5)
assert r.json()["choices"][0]["message"]["content"] == "réponse du secours" and asked == [None], asked
modes._cooling.clear()
secours = db.get_setting(relay.SECOURS)
with db.connect() as c:
    c.execute("DELETE FROM settings WHERE key = ?", (relay.SECOURS,))
desktop._seen[DEVICE]["at"] = 0
r = agent.post("/relay/v1/chat/completions", json=CHAT)
assert r.status_code == 503 and r.json()["error"]["type"] == "computer_unavailable" and "Ouvre Noah Agent" in r.json()["error"]["message"], r.text
db.set_setting(relay.SECOURS, secours)
beat()
print("A4. éteint, disparu en route, épuisé (puis au repos sans redemander) : le secours répond avec sa ligne ; sans secours, une erreur qui dit quoi faire")

# A8. Agent partagé, tâche d'un invité : jamais par l'abonnement du propriétaire, et rien ne dit où est son ordinateur.
relay.turn_notes.clear()
before = len(relayed())
for gate in ("guest_task", "shared_admin"):
    real = getattr(access, gate)
    setattr(access, gate, lambda agent_id: True)
    asked = []
    t, _ = in_thread(lambda: asked.append(next_item()))
    r = agent.post("/relay/v1/chat/completions", json=CHAT)
    t.join(5)
    setattr(access, gate, real)
    assert r.json()["choices"][0]["message"]["content"] == "réponse du secours" and asked == [None], (gate, asked, r.text)
    assert desktop.pc_link(AGENT, "ordinateur:claude-code") is None or not real(AGENT)
assert len(relayed()) == before + 2 and not relay.turn_notes, relay.turn_notes
assert desktop.pc_link(AGENT, "ordinateur:claude-code")["appareil"] == DEVICE
print("A8. invité ou agent partagé : le secours répond, l'ordinateur du propriétaire ne reçoit rien")

# Petits travaux (modèle de décision) avec un cerveau par l'ordinateur : chez le secours, jamais par l'abonnement.
real_model = decision.model
decision.model = lambda: "petit"
asked = []
t, _ = in_thread(lambda: asked.append(next_item()))
r = agent.post("/relay/v1/chat/completions", json={**CHAT, "model": "petit"})
t.join(5)
decision.model = real_model
assert r.json()["choices"][0]["message"]["content"] == "réponse du secours" and relayed()[-1]["model"] == "petit" and asked == [None], asked
print("   petits travaux : chez le secours, avec sa clé ; l'abonnement ne sert que les tours de l'agent")

# A6. ChatGPT par l'ordinateur, choisi comme fournisseur : même chemin, son modèle, son nom dans le suivi.
r = pc.put("/api/fournisseurs/ordinateur:chatgpt", json={})
assert r.status_code == 200 and r.json()["models"] == 1, r.text
assert pc.post("/api/model", json={"provider": "ordinateur:chatgpt", "model": "gpt-essai"}).status_code == 200
assert relay.fallback_link() == {"modele": "habituel", "fournisseur": "custom"}, "le secours reste celui d'avant l'abonnement"
t, got = desktop_answers(lambda item: completion("réponse du forfait", model="gpt-essai"))
r = agent.post("/relay/v1/chat/completions", json=CHAT)
t.join(10)
assert r.json()["choices"][0]["message"]["content"] == "réponse du forfait" and got["r"]["action"] == "chatgpt" and got["r"]["modele"] == "gpt-essai", (got, r.text)
assert last_usage()["model"] == "ChatGPT · gpt-essai · abonnement" and last_usage()["cost"] == 0
desktop._seen[DEVICE]["at"] = 0
r = agent.post("/relay/v1/chat/completions", json=CHAT)
assert r.json()["choices"][0]["message"]["content"] == "réponse du secours"
print("A6. ChatGPT (ton ordinateur) : le tour part avec gpt-essai, noté « ChatGPT · gpt-essai · abonnement » ; éteint, le secours répond")

# Rien de l'abonnement dans la base, ni pour l'agent : ni e-mail ni jeton.
with db.connect() as c:
    dump = "\n".join(c.iterdump())
assert "alice@exemple.fr" not in dump and "acces-secret" not in dump
assert "acces-secret" not in json.dumps(agent.get("/agent-api/appareils").json())
print("   ni e-mail ni jeton de l'abonnement dans la base ou chez l'agent")
print("Abonnements choisis comme fournisseurs : tout tient côté serveur.")
sys.stdout.flush()
os._exit(0)
