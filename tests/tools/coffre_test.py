"""Se connecter à un site : la personne saisit, la page reçoit, et ni l'agent, ni la base, ni les journaux ne voient le mot de passe.

Vrais : les routes de Noah, la base, les droits, l'anti-CSRF, le plugin de garde. Simulé : le navigateur (hermes.browser_call), dont
les vraies routes se vérifient à part (tests/navigateur/connexion_test.mjs) et de bout en bout (tests/real/connexion_vraie.py).

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/coffre_test.py"
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

DATA = Path(tempfile.mkdtemp())
os.environ["NOAH_DATA_DIR"] = str(DATA)
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

LOGS: list[str] = []


class Keep(logging.Handler):
    def emit(self, record):
        LOGS.append(record.getMessage())


logging.getLogger().addHandler(Keep())
logging.getLogger().setLevel(logging.DEBUG)

from fastapi.testclient import TestClient  # noqa: E402

from noah import access, auth, coffre, db, diagnostics, hermes, main, push, relay  # noqa: E402

MOT_DE_PASSE = "faux-mot-de-passe-Zq81x"
IDENTIFIANT = "alice@exemple.fr"
CODE = "482913"
ORIGINE = "https://www.instagram.com"
checks = 0


def check(name, ok, detail=""):
    global checks
    assert ok, f"{name} : {str(detail)[:400]}"
    checks += 1
    print("OK  ", name)


db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")  # sans rien sur cet agent
UMA = auth.create_user("uma", "motdepasse-u")  # droit « usage » : un profil à part, une personne invitée
ADA = auth.create_user("ada", "motdepasse-d")  # droit « admin » : tout est en commun, par choix du propriétaire
A = "agent-alice"
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Noah', '', 'k', ?)", (A, ALICE))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'usage')", (A, UMA))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (A, ADA))


def conversation(user: int) -> str:
    return main._new_conversation(user, A, "Essai")


CONV = conversation(ALICE)
relay.active[A] = [CONV]


class Page:
    """Le faux navigateur : l'état de la vraie page, et tout ce qu'on lui a envoyé."""

    def __init__(self):
        self.origine, self.champs, self.fills, self.reads = ORIGINE, {"identifiant": True, "motDePasse": True, "code": False}, [], []
        self.reply = {"ok": True, "rempli": ["identifiant", "motDePasse"], "complet": True, "page": "changee", "http_status": 200}

    async def __call__(self, agent_id, method, path, timeout=5, key=None, **kw):
        assert key == hermes.private_key(agent_id), "le serveur parle au navigateur avec la clé que l'agent n'a pas"
        assert key != hermes.browser_secrets(agent_id)[0]
        if path == "/noah/page":
            self.reads.append(kw.get("params"))
            return {"ok": True, "onglet": "t1", "origine": self.origine, "champs": self.champs, "http_status": 200}
        assert path == "/noah/remplir", path
        self.fills.append(kw["json"])
        return dict(self.reply)


page = Page()
hermes.browser_call = page
pushed = []
push.notify = lambda title, text, **kw: pushed.append(title + " " + text)

client = TestClient(main.app)
TOKENS = {u: auth.new_session(u) for u in (ALICE, BRUNO, UMA, ADA)}


def web(user: int) -> dict:
    return {"Authorization": f"Bearer {TOKENS[user]}"}


AGENT = {"Authorization": f"Bearer {relay.token_for(A)}"}


def ask(action="save_login", **extra) -> dict:
    return client.post("/agent-api/coffre", headers=AGENT, json={"action": action, "session": f"noah-{CONV}", **extra}).json()


def agent_gets(ask_id: str) -> dict:
    return client.get(f"/agent-api/coffre/{ask_id}", headers=AGENT, params={"attente": 0}).json()


def answer(ask_id: str, user: int = ALICE, **body):
    return client.post(f"/api/agents/{A}/connexions/{ask_id}", headers=web(user), json=body or {"identifiant": IDENTIFIANT, "mot_de_passe": MOT_DE_PASSE})


def test_card_shows_the_real_page():
    out = client.post("/agent-api/coffre", headers=AGENT, json={"action": "save_login", "session": f"noah-{CONV}", "origine": "https://piege.io", "site": "piege.io", "origin": "https://piege.io"}).json()
    ask_id = out["attente"]
    now = client.get(f"/api/conversations/{CONV}/en-cours", headers=web(ALICE)).json()["connexion"]
    check("l'origine de la carte vient de la page, pas du corps de la requête", now["origine"] == ORIGINE and now["site"] == "instagram.com", now)
    check("la carte ne montre rien d'autre", set(now) == {"id", "type", "site", "origine", "chiffre", "identifiant_requis"}, now)
    check("la conversation attend quelqu'un", main.task_state.get(CONV) == "approve")
    check("une notification, avec le site seulement", any("instagram.com" in p for p in pushed), pushed)
    toi = client.get("/api/a-toi", headers=web(ALICE)).json()
    check("la carte reste dans À toi", toi and toi[0]["connexion"]["id"] == ask_id and "instagram.com" in toi[0]["demande"], toi)
    main.task_state[CONV] = "work"  # un événement de l'agent peut remettre cet état pendant l'attente
    check("elle y reste si l'état de la tâche a bougé", client.get("/api/a-toi", headers=web(ALICE)).json()[0]["connexion"]["id"] == ask_id)
    check("rien pour un autre compte dans À toi", client.get("/api/a-toi", headers=web(BRUNO)).json() == [])
    check("l'agent attend", agent_gets(ask_id) == {"attente": ask_id})

    check("un autre compte ne répond pas", answer(ask_id, BRUNO).status_code == 404)
    check("une personne invitée ne répond pas", answer(ask_id, UMA).status_code == 403)
    check("un admin qui n'est pas l'auteur ne répond pas", answer(ask_id, ADA).status_code == 404)
    check("personne n'a rempli pour autant", page.fills == [])

    done = answer(ask_id)
    check("réponse acceptée", done.status_code == 200 and done.json() == {"ok": True, "page": "changee", "retenu": True}, done.text)
    fill = page.fills[-1]
    check("la page reçoit les identifiants, avec l'origine lue et non une autre", fill["motDePasse"] == MOT_DE_PASSE and fill["identifiant"] == IDENTIFIANT and fill["origine"] == ORIGINE and fill["onglet"] == "t1", list(fill))
    with db.connect() as c:
        kept = [r["secret"] for r in c.execute("SELECT secret FROM agent_logins")]
    check("ce qui est retenu est scellé", kept and not any(MOT_DE_PASSE in s or IDENTIFIANT in s for s in kept))
    seen = agent_gets(ask_id)
    check("l'agent reçoit le résultat, sans le secret", seen["success"] and MOT_DE_PASSE not in json.dumps(seen) and IDENTIFIANT not in json.dumps(seen), seen)
    check("l'état de la tâche repart", main.task_state.get(CONV) == "work")
    check("usage unique", answer(ask_id).status_code == 404 and len(page.fills) == 1)
    check("l'agent ne le relit pas deux fois", client.get(f"/agent-api/coffre/{ask_id}", headers=AGENT, params={"attente": 0}).status_code == 404)
    check("la carte n'est plus là", client.get(f"/api/conversations/{CONV}/en-cours", headers=web(ALICE)).json()["connexion"] is None)


def test_second_answer_while_filling():
    ask_id = ask()["attente"]
    release: list = []

    async def slow(agent_id, method, path, timeout=5, key=None, **kw):
        if path == "/noah/remplir":
            release.append(1)
            second = coffre._asked[ask_id]
            check("pendant le remplissage, la demande n'attend plus", second.get("answered") and coffre.pending(CONV) is None)
            check("et l'agent n'y lit pas encore de résultat", "done_at" not in second)
        return await page(agent_id, method, path, timeout, key, **kw)

    hermes.browser_call = slow
    try:
        assert answer(ask_id).status_code == 200
    finally:
        hermes.browser_call = page
    check("le remplissage a bien eu lieu", release == [1])
    agent_gets(ask_id)


def test_decline():
    fills = len(page.fills)
    ask_id = ask()["attente"]
    r = answer(ask_id, refuser=True)
    seen = agent_gets(ask_id)
    check("Pas maintenant : rien n'est écrit, et l'agent le sait", r.json().get("refuse") and len(page.fills) == fills and seen["error_type"] == "save_declined", seen)
    check("le corps vide ne vaut pas un refus", answer(ask()["attente"], retenir=True).status_code == 400)
    coffre._sweep()
    for key in list(coffre._asked):
        client.delete(f"/agent-api/coffre/{key}", headers=AGENT)


def test_expiry():
    fills = len(page.fills)
    ask_id = ask()["attente"]
    coffre._asked[ask_id]["expires"] = time.monotonic() - 1
    check("expirée, la carte disparaît", client.get(f"/api/conversations/{CONV}/en-cours", headers=web(ALICE)).json()["connexion"] is None)
    check("expirée, on ne répond plus", answer(ask_id).status_code == 410 and len(page.fills) == fills)
    check("l'agent apprend qu'elle a expiré", agent_gets(ask_id)["error_type"] == "expired")
    check("une demande dure dix minutes", coffre.ASK_SECONDS == 600)


def test_stopped_task():
    ask_id = ask()["attente"]
    relay.active[A] = []
    check("la tâche arrêtée, la carte disparaît", client.get(f"/api/conversations/{CONV}/en-cours", headers=web(ALICE)).json()["connexion"] is None)
    relay.active[A] = [CONV]
    check("et l'agent l'apprend", agent_gets(ask_id)["error_type"] == "cancelled")


def test_page_changed_while_typing():
    fills = len(page.fills)
    ask_id = ask()["attente"]
    page.origine = "https://instagram.com.piege.io"
    r = answer(ask_id)
    check("la page a changé de site : refus, et rien n'y est écrit", r.status_code == 409 and len(page.fills) == fills, r.text)
    check("l'agent l'apprend, sans le secret", agent_gets(ask_id)["error_type"] == "origin_changed")
    check("le domaine lu est celui qui compte", coffre.site_of(page.origine) == "piege.io" and coffre.site_of("https://a.b.gouv.fr") == "b.gouv.fr" and coffre.site_of("http://192.168.1.2:8080") == "192.168.1.2")
    page.origine = ORIGINE


def test_only_the_person_of_the_conversation():
    other = conversation(UMA)
    relay.active[A] = [other]
    out = client.post("/agent-api/coffre", headers=AGENT, json={"action": "save_login", "session": f"noah-{other}"}).json()
    check("tâche d'une personne invitée : pas de carte", out.get("error_type") == "guest", out)
    check("ni le coffre du propriétaire", client.post("/agent-api/coffre", headers=AGENT, json={"action": "list"}).json().get("error_type") == "guest")
    relay.active[A] = [CONV, conversation(ALICE)]
    out = client.post("/agent-api/coffre", headers=AGENT, json={"action": "save_login", "session": "autre-nom"}).json()
    check("deux tâches et une session inconnue : on ne devine pas", out.get("error_type") == "prompt_unavailable", out)
    relay.active[A] = []
    out = client.post("/agent-api/coffre", headers=AGENT, json={"action": "save_login"}).json()
    check("aucune tâche (routine) : personne ne peut répondre", out.get("error_type") == "prompt_unavailable", out)
    relay.active[A] = [CONV]


def test_agent_routes_are_inside():
    check("sans jeton, rien", client.post("/agent-api/coffre", json={"action": "list"}).status_code == 401)
    check("par un port public, rien", client.post("/agent-api/coffre", headers={**AGENT, "X-Forwarded-For": "1.2.3.4"}, json={"action": "list"}).status_code == 403)
    ask_id = ask()["attente"]
    check("une personne ne lit pas la réponse par la route de l'agent", client.get(f"/agent-api/coffre/{ask_id}", headers=web(ALICE)).status_code == 401)
    client.delete(f"/agent-api/coffre/{ask_id}", headers=AGENT)


def test_bounds_and_errors_never_echo():
    ask_id = ask()["attente"]
    for body in ({"identifiant": IDENTIFIANT, "mot_de_passe": MOT_DE_PASSE + "x" * 1100}, {"identifiant": MOT_DE_PASSE * 20, "mot_de_passe": "x"}, {"identifiant": 5, "mot_de_passe": MOT_DE_PASSE}):
        r = answer(ask_id, **body)
        check(f"champ refusé ({r.status_code}), sans recopier la valeur", r.status_code == 400 and MOT_DE_PASSE not in r.text, r.text)
    r = client.post(f"/api/agents/{A}/connexions/{ask_id}", headers=web(ALICE), content=b"x" * 5000)
    check("corps trop long", r.status_code == 413)
    r = client.post(f"/api/agents/{A}/connexions/{ask_id}", headers=web(ALICE), content=MOT_DE_PASSE)
    check("corps illisible, sans recopier", r.status_code == 400 and MOT_DE_PASSE not in r.text, r.text)
    check("la demande attend toujours", coffre.pending(CONV)["id"] == ask_id)
    client.delete(f"/agent-api/coffre/{ask_id}", headers=AGENT)


def test_csrf():
    ask_id = ask()["attente"]
    cookies = {auth.COOKIE: TOKENS[ALICE]}
    fills = len(page.fills)
    r = client.post(f"/api/agents/{A}/connexions/{ask_id}", headers={"Origin": "https://piege.io"}, cookies=cookies, json={"identifiant": "a", "mot_de_passe": "b"})
    check("une page d'un autre site n'envoie rien avec le cookie", r.status_code == 403 and len(page.fills) == fills, r.text)
    client.delete(f"/agent-api/coffre/{ask_id}", headers=AGENT)


def test_saved_logins():
    listed = ask("list")
    check("list : le site et un compte masqué, jamais le secret", listed["items"] and listed["items"][0]["origin"] == ORIGINE and MOT_DE_PASSE not in json.dumps(listed) and IDENTIFIANT not in json.dumps(listed), listed)
    handle = listed["items"][0]["handle"]
    fills = len(page.fills)
    done = ask("fill", handle=handle)
    check("fill : la page reçoit le mot de passe retenu, sans rien redemander", done["success"] and page.fills[-1]["motDePasse"] == MOT_DE_PASSE and coffre.pending(CONV) is None, done)
    check("et l'agent ne le voit pas", MOT_DE_PASSE not in json.dumps(done))
    page.origine = "https://instagram.com.piege.io"
    fills = len(page.fills)
    out = ask("fill", handle=handle)
    check("fill sur un autre site : refus, rien n'est écrit", out.get("error_type") == "origin_mismatch" and len(page.fills) == fills, out)
    page.origine = "https://instagram.com"  # sans www : une origine exacte, pas un domaine voisin
    out = ask("fill", handle=handle)
    check("fill sur un sous-domaine voisin : refus", out.get("error_type") == "origin_mismatch" and len(page.fills) == fills, out)
    page.origine = ORIGINE
    check("handle inconnu", ask("fill", handle="login_0")["error_type"] == "unknown_handle")
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('agent-bruno', 'B', '', 'k', ?)", (BRUNO,))
    other = client.post("/agent-api/coffre", headers={"Authorization": f"Bearer {relay.token_for('agent-bruno')}"}, json={"action": "fill", "handle": handle}).json()
    check("le handle d'un autre agent n'existe pas", other["error_type"] == "unknown_handle", other)

    shown = client.get(f"/api/agents/{A}/coffre", headers=web(ALICE))
    check("l'écran reçoit les sites seulement", shown.status_code == 200 and set(shown.json()[0]) == {"id", "site", "origine"} and MOT_DE_PASSE not in shown.text and IDENTIFIANT not in shown.text, shown.text)
    check("une personne invitée ne voit pas ces sites", client.get(f"/api/agents/{A}/coffre", headers=web(UMA)).status_code == 403)
    check("un inconnu non plus", client.get(f"/api/agents/{A}/coffre", headers=web(BRUNO)).status_code == 404)
    check("une personne invitée ne les retire pas", client.delete(f"/api/agents/{A}/coffre/{handle}", headers=web(UMA)).status_code == 403)

    ask_id = ask()["attente"]
    client.post(f"/api/agents/{A}/connexions/{ask_id}", headers=web(ALICE), json={"identifiant": IDENTIFIANT, "mot_de_passe": "nouveau-Zq81x"})
    agent_gets(ask_id)
    with db.connect() as c:
        rows = c.execute("SELECT secret FROM agent_logins WHERE agent_id = ?", (A,)).fetchall()
    check("même site, même identifiant : le nouveau remplace l'ancien", len(rows) == 1 and json.loads(db.unseal(rows[0]["secret"]))["mot_de_passe"] == "nouveau-Zq81x")
    check("retirer", client.delete(f"/api/agents/{A}/coffre/{handle}", headers=web(ALICE)).status_code == 200 and client.get(f"/api/agents/{A}/coffre", headers=web(ALICE)).json() == [])
    check("retirer deux fois", client.delete(f"/api/agents/{A}/coffre/{handle}", headers=web(ALICE)).status_code == 404)


def test_what_is_kept():
    ask_id = ask()["attente"]
    answer(ask_id, identifiant=IDENTIFIANT, mot_de_passe=MOT_DE_PASSE, retenir=False)
    check("décoché : rien n'est retenu", agent_gets(ask_id)["saved"] is False and client.get(f"/api/agents/{A}/coffre", headers=web(ALICE)).json() == [])
    page.reply = {**page.reply, "page": "meme"}
    ask_id = ask()["attente"]
    r = answer(ask_id)
    seen = agent_gets(ask_id)
    check("le site a refusé : la personne et l'agent le savent, et rien n'est retenu", r.json()["page"] == "meme" and seen["saved"] is False and "next" in seen and client.get(f"/api/agents/{A}/coffre", headers=web(ALICE)).json() == [], seen)
    page.reply = {**page.reply, "page": "changee", "complet": False}
    ask_id = ask()["attente"]
    answer(ask_id)
    check("identifiant seul accepté, mot de passe sans champ : rien n'est retenu", agent_gets(ask_id)["saved"] is False)
    page.reply = {"ok": False, "error": "La page a changé de site : rien n'y a été écrit.", "http_status": 409}
    ask_id = ask()["attente"]
    r = answer(ask_id)
    check("le navigateur refuse : c'est dit, sans rien retenir", r.status_code == 409 and agent_gets(ask_id)["error_type"] == "origin_changed" and client.get(f"/api/agents/{A}/coffre", headers=web(ALICE)).json() == [], r.text)
    page.reply = {"ok": True, "rempli": ["identifiant", "motDePasse"], "complet": True, "page": "changee", "http_status": 200}


def test_code():
    page.champs = {"identifiant": False, "motDePasse": False, "code": True}
    page.reply = {"ok": True, "rempli": ["code"], "complet": True, "page": "changee", "http_status": 200}
    ask_id = ask("enter_code")["attente"]
    now = client.get(f"/api/conversations/{CONV}/en-cours", headers=web(ALICE)).json()["connexion"]
    check("la variante code", now["type"] == "code", now)
    check("il faut un code", answer(ask_id, code=" ").status_code == 400)
    r = answer(ask_id, code="482 913")
    seen = agent_gets(ask_id)
    check("le code part dans la page, sans espace ; rien n'est retenu", r.status_code == 200 and page.fills[-1]["code"] == CODE and seen["saved"] is False and CODE not in json.dumps(seen), seen)
    check("pas de champ de code : pas de carte", ask("save_login").get("error_type") == "no_login_field")
    page.champs = {"identifiant": True, "motDePasse": True, "code": False}
    check("pas de champ de code : pas de carte", ask("enter_code").get("error_type") == "no_code_field")
    page.origine = None
    check("pas de page web : pas de carte", ask("save_login").get("error_type") == "no_page")
    page.origine = ORIGINE


def test_nothing_is_kept_in_clear():
    """Le mot de passe et le code ont traversé tous les chemins ci-dessus : on les cherche partout."""
    ask_id = ask()["attente"]  # une dernière fois, retenu, pour que la base en ait une trace scellée
    answer(ask_id)
    seen = agent_gets(ask_id)
    with db.connect() as c:
        tables = [r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        dump = {t: [dict(r) for r in c.execute(f'SELECT * FROM "{t}"').fetchall()] for t in tables}
    text = json.dumps(dump, default=str)
    for secret in (MOT_DE_PASSE, CODE, "nouveau-Zq81x"):
        check(f"base : {secret[:3]}… absent de toutes les tables", secret not in text)
    check("base : aussi dans les fichiers, y compris le journal d'écriture", not any(MOT_DE_PASSE.encode() in p.read_bytes() for p in DATA.rglob("*") if p.is_file()))
    check("la table retenue est bien là, scellée", dump["agent_logins"] and IDENTIFIANT not in json.dumps(dump["agent_logins"]) and json.loads(db.unseal(dump["agent_logins"][0]["secret"]))["mot_de_passe"] == MOT_DE_PASSE)
    check("messages et journal sans rien", MOT_DE_PASSE not in json.dumps(dump["messages"]) and MOT_DE_PASSE not in json.dumps(dump["journal"]))
    check("journaux du serveur sans rien", not any(MOT_DE_PASSE in line or CODE in line for line in LOGS), [l for l in LOGS if MOT_DE_PASSE in l][:2])
    check("diagnostics sans rien", MOT_DE_PASSE not in json.dumps(list(diagnostics._recent), default=str))
    check("notifications sans rien", not any(MOT_DE_PASSE in p or IDENTIFIANT in p for p in pushed))
    check("mémoire : la demande finie est partie", not coffre._asked)
    check("un résultat de l'agent ne parle ni d'identifiant ni de mot de passe", seen["success"] and not {"identifiant", "mot_de_passe", "motDePasse", "password"} & set(seen), seen)
    client.delete(f"/api/agents/{A}/coffre/{seen['handle']}", headers=web(ALICE))


def test_plugin_tool():
    """L'outil dans la machine de l'agent : il ne prend que list/fill/save_login/enter_code, et ne reçoit aucun secret."""
    sys.path.insert(0, "/app/noah/agent_plugin")
    import importlib
    garde = importlib.import_module("__init__")
    check("le schéma de l'outil n'a aucun champ de secret", set(garde.VAULT_SCHEMA["parameters"]["properties"]) == {"action", "handle"})
    check("une personne invitée n'a pas cet outil", garde.check_guest("browser_vault", {"action": "list"}, "/opt/data/profiles/u2") == garde.GUEST_VAULT)
    calls = []
    answers = [{"attente": "x1"}, {"attente": "x1"}, {"success": True, "page": "changee"}]

    def fake(*words):
        calls.append(words)
        return answers.pop(0)

    real, garde._vault_call = garde._vault_call, fake
    try:
        out = json.loads(garde._vault_tool({"action": "save_login"}, session_id="noah-c1"))
        check("l'outil attend par tranches, puis rend le résultat", out == {"success": True, "page": "changee"} and calls[1:] == [("coffre-attendre", "x1"), ("coffre-attendre", "x1")], calls)
        check("il donne sa session au serveur", json.loads(calls[0][1])["session"] == "noah-c1")
        check("l'outil rend la main avant la coupure de 420 s d'Hermes", garde.VAULT_SLICE_SECONDS + coffre.MAX_WAIT + 10 < 420)
        slice_seconds, garde.VAULT_SLICE_SECONDS = garde.VAULT_SLICE_SECONDS, 0
        answers[:] = [{"attente": "x3"}]
        out = json.loads(garde._vault_tool({"action": "save_login"}))
        check("sans réponse à temps : la carte reste ouverte, et l'agent sait comment reprendre", out["error_type"] == "still_waiting" and out["handle"] == "x3" and not answers, out)
        garde.VAULT_SLICE_SECONDS = slice_seconds
        calls.clear()
        answers[:] = [{"success": True, "page": "changee"}]
        out = json.loads(garde._vault_tool({"action": "wait", "handle": "x3"}))
        check("il reprend l'attente de la même carte, sans en ouvrir une autre", out["success"] and calls == [("coffre-attendre", "x3")], calls)
        answers[:] = [{"attente": "x2"}, {"ok": True}]
        garde._interrupted = lambda: True
        out = json.loads(garde._vault_tool({"action": "save_login"}))
        check("tâche arrêtée pendant l'attente : la carte est retirée", out["error_type"] == "cancelled" and calls[-1] == ("coffre-annuler", "x2"), calls)
        garde._unattended = lambda: True
        calls.clear()
        out = json.loads(garde._vault_tool({"action": "save_login"}))
        check("routine : aucune carte", out["error_type"] == "prompt_unavailable" and not calls, out)
    finally:
        garde._vault_call = real


def test_override_is_consented():
    """Sans cette ligne dans config.yaml, Hermes refuse le remplacement de l'outil, et la personne retombe sur un outil qui ne sait rien faire."""
    files = {}

    async def launcher(method, path, **kw):
        if method == "GET":
            return {"content": "plugins:\n  enabled: []\n"}
        files.update(kw["json"]["files"])
        return {}

    real, hermes._launcher = hermes._launcher, launcher
    identity, hermes.browser_identity = hermes.browser_identity, (lambda: asyncio.sleep(0, {"locale": "", "timezone": "Europe/Paris"}))
    try:
        asyncio.run(hermes.configure(A, {"provider": "openai", "model": "gpt-5"}, restart_after=False))
    finally:
        hermes._launcher, hermes.browser_identity = real, identity
    import yaml
    cfg = yaml.safe_load(files["config.yaml"])
    check("consentement écrit", cfg["plugins"].get("entries", {}).get("noah-garde", {}).get("allow_tool_override") is True, cfg["plugins"])
    check("noah.py sait attendre et annuler", all(w in files["noah.py"] for w in ('["coffre"]', '["coffre-attendre"]', '["coffre-annuler"]')))


test_card_shows_the_real_page()
test_second_answer_while_filling()
test_decline()
test_expiry()
test_stopped_task()
test_page_changed_while_typing()
test_only_the_person_of_the_conversation()
test_agent_routes_are_inside()
test_bounds_and_errors_never_echo()
test_csrf()
test_saved_logins()
test_what_is_kept()
test_code()
test_nothing_is_kept_in_clear()
test_plugin_tool()
test_override_is_consented()
print(f"coffre : {checks} vérifications, tout est vert")
