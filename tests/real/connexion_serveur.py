"""Le vrai serveur de Noah pour connexion_vraie.sh : ses routes, sa base, son relais. Seul le lanceur est remplacé : les fichiers de l'agent
s'écrivent directement dans son volume, monté ici sur /agentdata. Mêmes clés que le navigateur d'essai : le SECRET_KEY de ce script."""
import asyncio
import json
import os
import pathlib
import sys
import threading
import time

os.environ["NOAH_DATA_DIR"] = "/donnees"
os.environ.setdefault("LAUNCHER_KEY", "x")
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, coffre, db, hermes, main, relay  # noqa: E402

AGENT = "essai"
DATA = pathlib.Path("/agentdata")
MOT_DE_PASSE, IDENTIFIANT = os.environ["ESSAI_MOT_DE_PASSE"], "personne@exemple.fr"
SITE, AUTRE = "http://noah-essai-site:9999", "http://autre-site:9999"
BASE = "http://127.0.0.1:8080"
checks = []


def check(name, ok, detail=""):
    print("OK   " if ok else "ÉCHEC", name, "" if ok else str(detail)[:600], flush=True)
    checks.append(bool(ok))


async def launcher(method, path, **kw):
    """Ce que le serveur demande au lanceur pendant cet essai."""
    if path.endswith("/refresh-prompts") or path.endswith("/restart") or path.endswith("/browser") or "/admin/" in path:
        return {}
    if method == "PUT" and path.endswith("/files"):
        for name, text in kw["json"]["files"].items():
            target = DATA / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return {}
    if method == "GET" and "/files/" in path:
        target = DATA / path.split("/files/", 1)[1]
        return {"content": target.read_text(encoding="utf-8") if target.exists() else ""}
    if path == "/agents":
        return [{"id": AGENT, "status": "running"}]
    return {}


hermes._launcher = launcher
db.init()
owner = auth.create_user("alice", "motdepasse-essai")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Noah', '', ?, ?)", (AGENT, "cle-api-agent-essai-0123456789", owner))
db.set_setting("provider", "custom")
db.set_setting("base_url", "http://noah-essai-modele:11500/v1")
db.set_setting("model", "faux-modele")
db.set_setting("onboarded", "1")
token = auth.new_session(owner)
WEB = {"Authorization": f"Bearer {token}"}
RELAIS = {"Authorization": f"Bearer {relay.token_for(AGENT)}"}
(DATA / ".env").write_text("API_SERVER_KEY=cle-api-agent-essai-0123456789\n", encoding="utf-8")

threading.Thread(target=lambda: uvicorn.run(main.app, host="0.0.0.0", port=8080), daemon=True).start()
time.sleep(3)
print("clés du navigateur", hermes.browser_secrets(AGENT)[0], hermes.private_key(AGENT), flush=True)
asyncio.run(hermes.configure(AGENT, main.model_for(AGENT), "Tu es un agent d'essai.", restart_after=False))
(DATA / ".pret").write_text("1")
os.system(f"chown -R 10000:10000 {DATA}")

http = httpx.Client(timeout=120)
camofox = f"http://{hermes.browser_host(AGENT)}:9377"
BROWSER = {"Authorization": f"Bearer {hermes.browser_secrets(AGENT)[0]}"}  # la clé que l'agent a


def wait(what, fn, seconds=240):
    end = time.time() + seconds
    while time.time() < end:
        try:
            got = fn()
            if got:
                return got
        except Exception:  # noqa: BLE001 - pas encore prêt
            pass
        time.sleep(1)
    raise SystemExit(f"Jamais prêt : {what}")


wait("navigateur", lambda: http.get(camofox + "/health", timeout=3).status_code == 200)
wait("agent", lambda: http.get(f"http://noah-agent-{AGENT}:8642/health", timeout=3).status_code == 200)
print("tout est prêt", flush=True)


def received():
    return http.get(SITE + "/_recu").json()


def tab():
    tabs = http.get(camofox + "/tabs", params={"userId": hermes.BROWSER_USER}, headers=BROWSER).json().get("tabs") or []
    if tabs:
        return tabs[-1]["tabId"]
    return http.post(camofox + "/tabs", json={"userId": hermes.BROWSER_USER, "sessionKey": hermes.BROWSER_USER, "url": "about:blank"}, headers=BROWSER).json()["tabId"]


def go(url):
    r = http.post(f"{camofox}/tabs/{tab()}/navigate", json={"userId": hermes.BROWSER_USER, "url": url}, headers=BROWSER)
    assert r.status_code == 200, r.text
    time.sleep(0.5)


def snapshot():
    return http.get(f"{camofox}/tabs/{tab()}/snapshot", params={"userId": hermes.BROWSER_USER}, headers=BROWSER).text


def evaluate(expression):
    return http.post(f"{camofox}/tabs/{tab()}/evaluate", json={"userId": hermes.BROWSER_USER, "expression": expression}, headers=BROWSER).json()


def agent_asks(action="save_login", conv=None, **extra):
    """Ce que l'outil de la garde envoie : le jeton de l'agent, sa session."""
    return http.post(f"{BASE}/agent-api/coffre", headers=RELAIS, json={"action": action, "session": f"noah-{conv}", **extra}).json()


def agent_gets(ask_id):
    return http.get(f"{BASE}/agent-api/coffre/{ask_id}", headers=RELAIS, params={"attente": 3}).json()


def person_answers(ask_id, **body):
    return http.post(f"{BASE}/api/agents/{AGENT}/connexions/{ask_id}", headers=WEB, json=body or {"identifiant": IDENTIFIANT, "mot_de_passe": MOT_DE_PASSE})


def forget_all():
    for row in http.get(f"{BASE}/api/agents/{AGENT}/coffre", headers=WEB).json():
        http.delete(f"{BASE}/api/agents/{AGENT}/coffre/{row['id']}", headers=WEB)


# --- 1. Le vrai Hermes, du message à la page ----------------------------------------------------------------------------

def turn(conv, text="Connecte-toi au site."):
    events = []

    def run():
        with httpx.stream("POST", f"{BASE}/api/chat", headers=WEB, json={"agent_id": AGENT, "text": text, "conversation_id": conv, "attachments": [], "details": True}, timeout=400) as r:
            for line in r.iter_lines():
                if line.startswith("data:"):
                    events.append(json.loads(line[5:]))

    thread = threading.Thread(target=run)
    thread.start()
    return thread, events


conv = main._new_conversation(owner, AGENT, "Essai")
other = main._new_conversation(owner, AGENT, "Une autre tâche en même temps")  # sans le nom de session passé par Hermes, on ne saurait pas où montrer la carte
relay.active.setdefault(AGENT, []).append(other)
thread, events = turn(conv)
now = wait("la carte", lambda: http.get(f"{BASE}/api/conversations/{conv}/en-cours", headers=WEB).json().get("connexion"), 180)
check("Hermes appelle l'outil, la carte montre la vraie page", now["origine"] == SITE and now["type"] == "connexion" and not now["chiffre"], now)
check("la carte est dans la bonne conversation, pas dans l'autre tâche", not http.get(f"{BASE}/api/conversations/{other}/en-cours", headers=WEB).json().get("connexion"))
relay.active[AGENT].remove(other)
toi = http.get(f"{BASE}/api/a-toi", headers=WEB).json()
check("elle est dans À toi", toi and toi[0].get("connexion", {}).get("id") == now["id"], toi)
LATE = int(os.environ.get("ESSAI_ATTENTE") or 0)  # ESSAI_ATTENTE=450 : la personne répond après la coupure de 420 s d'Hermes
time.sleep(LATE)
if LATE:
    check("la carte est toujours là après cette attente", (http.get(f"{BASE}/api/conversations/{conv}/en-cours", headers=WEB).json().get("connexion") or {}).get("id") == now["id"])
done = person_answers(now["id"])
check("la personne répond", done.status_code == 200 and done.json().get("page") == "changee", done.text)
thread.join(120)
seen = received()
check("la page a reçu la vraie valeur", any(r.get("password") == MOT_DE_PASSE and r.get("username") == IDENTIFIANT for r in seen), len(seen))
tools = [e for e in events if e.get("type") == "raw" or "tool" in str(e.get("kind", ""))]
check("le tour se finit normalement", any(e.get("type") == "done" and e.get("status") in ("completed", None) for e in events), events[-3:])
check("et la page de l'agent montre la suite", "Bienvenue" in snapshot())
saved = http.get(f"{BASE}/api/agents/{AGENT}/coffre", headers=WEB).json()
check("le site est retenu, sous son nom", len(saved) == 1 and saved[0]["origine"] == SITE, saved)

before = len(received())
conv2 = main._new_conversation(owner, AGENT, "Essai 2")
thread, events = turn(conv2)
thread.join(180)
check("deuxième fois : aucune carte, et la page reçoit quand même", len(received()) == before + 1 and received()[-1].get("password") == MOT_DE_PASSE, received()[before:])
forget_all()

# --- 2. La vraie page, le vrai Firefox ----------------------------------------------------------------------------------
conv3 = main._new_conversation(owner, AGENT, "Essai 3")
relay.active.setdefault(AGENT, []).append(conv3)

go(SITE + "/actif")
ask_id = agent_asks(conv=conv3)["attente"]
r = person_answers(ask_id)
check("un site qui ne lit que les événements de saisie (comme React), bouton grisé : ça passe", r.status_code == 200 and received()[-1].get("via") == "actif" and received()[-1].get("password") == MOT_DE_PASSE, r.text)
agent_gets(ask_id)
forget_all()

before = len(received())
go(SITE + "/refus")
ask_id = agent_asks(conv=conv3)["attente"]
r = person_answers(ask_id)
out = agent_gets(ask_id)
value = evaluate("document.querySelector('input[type=password]').value")
check("mot de passe refusé : le champ est vidé", value.get("result") == "", value)
check("la personne et l'agent le savent, et rien n'est retenu", r.json().get("page") == "meme" and out["page"] == "meme" and out["saved"] is False and not http.get(f"{BASE}/api/agents/{AGENT}/coffre", headers=WEB).json(), out)
check("la page n'a rien envoyé ailleurs", len(received()) == before)

go(SITE + "/deux")
ask_id = agent_asks(conv=conv3)["attente"]
r = person_answers(ask_id)
check("identifiant d'abord, mot de passe ensuite", r.status_code == 200 and received()[-1].get("password") == MOT_DE_PASSE and received()[-1].get("username") == IDENTIFIANT, r.text)
agent_gets(ask_id)
forget_all()

go(SITE + "/code")
ask_id = agent_asks("enter_code", conv=conv3)["attente"]
person_answers(ask_id, code="482913")
check("un code", received()[-1].get("otp") == "482913", received()[-1])
agent_gets(ask_id)

go(SITE + "/cases")
ask_id = agent_asks("enter_code", conv=conv3)["attente"]
person_answers(ask_id, code="482913")
check("un code en six cases", received()[-1].get("otp") == "482913", received()[-1])
agent_gets(ask_id)

go(SITE + "/cache")
ask_id = agent_asks(conv=conv3)["attente"]
person_answers(ask_id)
check("un champ caché n'est pas rempli", received()[-1].get("password") == MOT_DE_PASSE and received()[-1].get("leurre") == "leurre", received()[-1])
agent_gets(ask_id)
forget_all()

before = len(received())
go(SITE + "/get")
ask_id = agent_asks(conv=conv3)["attente"]
r = person_answers(ask_id)
check("un formulaire qui mettrait le mot de passe dans l'adresse : refus", r.status_code == 409 and "adresse" in r.text and MOT_DE_PASSE not in snapshot(), r.text)
agent_gets(ask_id)
value = evaluate("location.href + '|' + document.querySelector('input[type=password]').value")
check("et rien n'y est écrit", MOT_DE_PASSE not in str(value), value)

# La page change de site après que la carte est ouverte : un agent piégé, ou une redirection.
before = len(received())
go(SITE + "/login")
ask_id = agent_asks(conv=conv3)["attente"]
go(AUTRE + "/login")
r = person_answers(ask_id)
check("la page a changé de site pendant la saisie : refus", r.status_code == 409, r.text)
check("rien n'y est parti", len(received()) == before and agent_gets(ask_id)["error_type"] == "origin_changed", received()[before:])
value = evaluate("document.querySelector('input[type=password]').value")
check("et rien n'y est écrit", value.get("result") == "", value)

# Un identifiant retenu ne sert que sur son origine exacte.
go(SITE + "/login")
ask_id = agent_asks(conv=conv3)["attente"]
person_answers(ask_id)
out = agent_gets(ask_id)
handle = out["handle"]
before = len(received())
go(AUTRE + "/login")
out = agent_asks("fill", conv=conv3, handle=handle)
check("identifiant retenu, autre site : refus", out.get("error_type") == "origin_mismatch" and len(received()) == before, out)

# Un agent piégé pose un écouteur dans la page, puis demande le remplissage.
go(SITE + "/login")
TRAP = "document.addEventListener('input',e=>{new Image().src='/vole?v='+encodeURIComponent(e.target.value)},true);window.__piege=1"
evaluate(TRAP)
check("le piège est posé", evaluate("window.__piege").get("result") == 1)
before = len(received())
out = agent_asks("fill", conv=conv3, handle=handle)
time.sleep(1)
got = received()[before:]
check("le script posé par l'agent ne survit pas : la page est rechargée avant d'écrire", out.get("success") and not any("vole" in r for r in got) and any(r.get("password") == MOT_DE_PASSE for r in got), [list(r) for r in got])

# Le même piège, posé pendant que la carte attend.
go(SITE + "/login")
ask_id = agent_asks(conv=conv3)["attente"]
evaluate(TRAP)
before = len(received())
person_answers(ask_id)
time.sleep(1)
got = received()[before:]
check("le même piège, posé pendant que la carte attend : pareil", not any("vole" in r for r in got) and any(r.get("password") == MOT_DE_PASSE for r in got), [list(r) for r in got])
agent_gets(ask_id)

# L'agent, avec sa clé du navigateur, ne peut ni lire la page par le serveur ni remplir à sa place.
denied = [http.post(f"{camofox}{path}", headers=BROWSER, json={"userId": "noah"}).status_code for path in ("/noah/page", "/noah/remplir")]
check("la clé de l'agent n'ouvre pas ces routes", denied == [403, 403], denied)

relay.active[AGENT].remove(conv3)
forget_all()
print(("TOUT EST VERT" if all(checks) else "DES ÉCHECS") + f" : {sum(checks)}/{len(checks)}", flush=True)
pathlib.Path("/donnees/fini").write_text("ok" if all(checks) else "echec")
time.sleep(100000)
