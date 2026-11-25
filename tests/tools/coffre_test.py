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
coffre.set_may_use(A, True)  # agent partagé : son coffre est éteint d'office (coffre_030_test.py) ; ici, le propriétaire l'a ouvert


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


def ask(action="save_login", keep=False, **extra) -> dict:
    """save_login ouvre une carte quand le coffre n'a rien pour ce site (0.3.0 : sinon le serveur remplit lui-même) : on le vide d'abord."""
    if action == "save_login" and not keep:
        with db.connect() as c:
            c.execute("DELETE FROM coffre")
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
        kept = [r["secret"] for r in c.execute("SELECT secret FROM coffre")]
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
    ask_id = ask()["attente"]  # une première connexion retenue
    answer(ask_id)
    agent_gets(ask_id)
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
    for neighbour in ("http://instagram.com", "https://instagram.com:8443", "https://www.instagram.co"):
        page.origine = neighbour
        out = ask("fill", handle=handle)
        check(f"fill sur {neighbour} : refus", out.get("error_type") == "origin_mismatch" and len(page.fills) == fills, out)
    page.origine = "https://instagram.com"  # relecture B-1 : par son handle, seulement sur l'origine exacte ; la carte, elle, le propose
    out = ask("fill", handle=handle)
    check("fill sans www sur le même site : refus, la personne choisira par la carte", out.get("error_type") == "origin_mismatch" and "save_login" in out["error"] and len(page.fills) == fills, out)
    page.origine = ORIGINE
    check("handle inconnu", ask("fill", handle="login_0")["error_type"] == "unknown_handle")
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('agent-bruno', 'B', '', 'k', ?)", (BRUNO,))
    other = client.post("/agent-api/coffre", headers={"Authorization": f"Bearer {relay.token_for('agent-bruno')}"}, json={"action": "fill", "handle": handle}).json()
    check("le handle d'un autre agent n'existe pas", other["error_type"] == "unknown_handle", other)

    shown = client.get(f"/api/agents/{A}/coffre", headers=web(ALICE))
    check("l'écran reçoit les sites seulement", shown.status_code == 200 and set(shown.json()[0]) == {"id", "nom", "site", "origine", "compte"} and shown.json()[0]["compte"] == "al•••" and MOT_DE_PASSE not in shown.text and IDENTIFIANT not in shown.text, shown.text)
    check("une personne invitée ne voit pas ces sites", client.get(f"/api/agents/{A}/coffre", headers=web(UMA)).status_code == 403)
    check("un admin qui n'est pas le propriétaire non plus : c'est le coffre d'Alice", client.get(f"/api/agents/{A}/coffre", headers=web(ADA)).status_code == 403)
    check("un inconnu non plus", client.get(f"/api/agents/{A}/coffre", headers=web(BRUNO)).status_code == 404)
    check("une personne invitée ne les retire pas", client.delete(f"/api/agents/{A}/coffre/{handle}", headers=web(UMA)).status_code == 403)

    page.reply = {**page.reply, "page": "meme"}  # le site refuse l'identifiant retenu, rempli d'office
    out = ask(keep=True)
    check("save_login avec un seul identifiant : rempli d'office, sans carte", out.get("automatic") and out["page"] == "meme" and coffre.pending(CONV) is None, out)
    page.reply = {**page.reply, "page": "changee"}
    ask_id = ask(keep=True)["attente"]
    check("refusé par le site, il n'est plus repris d'office : la carte s'ouvre", bool(ask_id))
    client.post(f"/api/agents/{A}/connexions/{ask_id}", headers=web(ALICE), json={"identifiant": IDENTIFIANT, "mot_de_passe": "nouveau-Zq81x"})
    agent_gets(ask_id)
    with db.connect() as c:
        rows = c.execute("SELECT secret FROM coffre WHERE user_id = ?", (ALICE,)).fetchall()
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
    check("la table retenue est bien là, scellée", dump["coffre"] and IDENTIFIANT not in json.dumps(dump["coffre"]) and json.loads(db.unseal(dump["coffre"][0]["secret"]))["mot_de_passe"] == MOT_DE_PASSE)
    check("messages et journal sans rien", MOT_DE_PASSE not in json.dumps(dump["messages"]) and MOT_DE_PASSE not in json.dumps(dump["journal"]))
    check("journaux du serveur sans rien", not any(MOT_DE_PASSE in line or CODE in line for line in LOGS), [l for l in LOGS if MOT_DE_PASSE in l][:2])
    check("diagnostics sans rien", MOT_DE_PASSE not in json.dumps(list(diagnostics._recent), default=str))
    check("notifications sans rien", not any(MOT_DE_PASSE in p or IDENTIFIANT in p for p in pushed))
    check("mémoire : la demande finie est partie", not coffre._asked)
    check("un résultat de l'agent ne parle ni d'identifiant ni de mot de passe", seen["success"] and not {"identifiant", "mot_de_passe", "motDePasse", "password"} & set(seen), seen)
    client.delete(f"/api/agents/{A}/coffre/{seen['handle']}", headers=web(ALICE))


def test_old_database_accepts_api_keys():
    """Une base d'avant le genre `cle_api` (CHECK à trois genres) est refaite au démarrage, sans perdre ni une ligne ni un retrait."""
    import sqlite3
    raw = sqlite3.connect(DATA / "noah.db")
    raw.execute("PRAGMA foreign_keys = OFF")
    raw.executescript("DROP TABLE coffre_retraits; DROP TABLE coffre;"
                      "CREATE TABLE coffre (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                      "genre TEXT NOT NULL DEFAULT 'login' CHECK (genre IN ('login', 'carte', 'totp')), nom TEXT NOT NULL DEFAULT '', "
                      "origine TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL, created_at REAL NOT NULL, used_at REAL);"
                      "CREATE INDEX coffre_user ON coffre(user_id, genre);"
                      "CREATE TABLE coffre_retraits (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                      "coffre_id TEXT NOT NULL REFERENCES coffre(id) ON DELETE CASCADE, PRIMARY KEY (agent_id, coffre_id));")
    raw.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at) VALUES ('login_ancien', ?, 'login', 'n', 'https://a.fr', 's', 1)", (ALICE,))
    raw.execute("INSERT INTO coffre_retraits (agent_id, coffre_id) VALUES (?, 'login_ancien')", (A,))
    raw.commit()
    raw.close()
    db.init()
    with db.connect() as c:
        rows = c.execute("SELECT id FROM coffre").fetchall()
        retraits = c.execute("SELECT coffre_id FROM coffre_retraits").fetchall()
        c.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at) VALUES ('cle_api_x', ?, 'cle_api', '', 'https://a.fr', 's', 1)", (ALICE,))
        c.execute("DELETE FROM coffre")
    check("l'ancienne base garde ses lignes et ses retraits, et accepte le nouveau genre", [r["id"] for r in rows] == ["login_ancien"] and [r["coffre_id"] for r in retraits] == ["login_ancien"])
    db.init()  # rejoué : rien à refaire
    check("rejouer le démarrage ne change rien", True)


CLE = "sk-faux-Zq81xKLm92pTrW"
SERVICE = "https://api.exemple.test"


def test_api_keys():
    """Une clé d'API : rangée, jamais lue par l'agent, appelée par le serveur sur l'origine du service et nulle part ailleurs."""
    import httpx
    from noah import mcp
    with db.connect() as c:
        c.execute("DELETE FROM coffre")
        c.execute("INSERT OR IGNORE INTO agents (id, name, role, api_key, owner_id) VALUES ('agent-bruno', 'B', '', 'k', ?)", (BRUNO,))
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "cle_api", "nom": "Mon API", "origine": SERVICE + "/v1/models?x=1", "cle": CLE})
    check("ranger une clé d'API : la réponse n'a pas la valeur", r.status_code == 200 and CLE not in r.text and r.json()["origine"] == SERVICE and r.json()["apercu"] == "Authorization", r.text)
    item = r.json()["id"]
    bads = ("", "a b", "a\r\nX: 1")
    check("une clé vide ou avec une espace est refusée sans la citer", all(client.post("/api/coffre", headers=web(ALICE), json={"genre": "cle_api", "origine": SERVICE, "cle": bad}).status_code == 400 for bad in bads))
    check("un en-tête invalide est refusé", client.post("/api/coffre", headers=web(ALICE), json={"genre": "cle_api", "origine": SERVICE, "cle": CLE, "entete": "X Bad:"}).status_code == 400)
    check("la liste du coffre ne porte jamais la valeur", CLE not in client.get("/api/coffre", headers=web(ALICE)).text)
    voir = client.post(f"/api/coffre/{item}/voir", headers=web(ALICE), json={"motdepasse": "motdepasse-a"})
    check("voir la valeur demande la preuve, puis la rend", voir.status_code == 200 and voir.json()["cle"] == CLE, voir.text)
    r = client.put(f"/api/coffre/{item}", headers=web(ALICE), json={"genre": "cle_api", "nom": "Renommée"})
    with db.connect() as c:
        raw = c.execute("SELECT secret FROM coffre WHERE id = ?", (item,)).fetchone()["secret"]
    check("champ vide en modification : la clé est gardée", r.status_code == 200 and json.loads(db.unseal(raw))["cle"] == CLE and r.json()["nom"] == "Renommée", r.text)
    check("la valeur est chiffrée en base", CLE not in raw)

    listed = ask("api_keys")
    check("api_keys : nom, service, identifiant opaque, jamais la valeur", listed["success"] and listed["items"] == [{"handle": item, "name": "Renommée", "service": SERVICE, "header": "Authorization"}] and CLE not in json.dumps(listed), listed)

    seen = []
    echo = {"on": False}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/redirige":
            return httpx.Response(302, headers={"Location": "https://piege.exemple.test/vole"})
        if request.url.path == "/image":
            return httpx.Response(200, headers={"Content-Type": "image/png"}, content=b"\x89PNG" * 10)
        if request.url.path == "/gros":
            return httpx.Response(200, headers={"Content-Type": "text/plain"}, content=b"x" * (coffre.API_MAX_RESPONSE + 5000))
        if echo["on"]:
            return httpx.Response(200, headers={"Content-Type": "application/json"}, json={"vu": request.headers.get("authorization"), "tout": CLE, "url": f"?k={CLE}"})
        return httpx.Response(200, headers={"Content-Type": "application/json"}, json={"data": [1, 2]})

    real_client, real_dns = coffre.httpx.AsyncClient, mcp.socket.getaddrinfo
    dns = {"ip": "93.184.216.34"}
    mcp.socket.getaddrinfo = lambda host, port, **kw: [(2, 1, 6, "", (dns["ip"], port))]
    coffre.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})
    try:
        out = ask("api_request", handle=item, url="/v1/models")
        sent = seen[-1]
        check("la requête part avec Authorization: Bearer, vers l'IP vérifiée, et l'agent reçoit la réponse", out["success"] and out["status"] == 200 and json.loads(out["body"]) == {"data": [1, 2]}
              and sent.headers["authorization"] == f"Bearer {CLE}" and sent.headers["host"] == "api.exemple.test" and sent.url.host == "93.184.216.34", (out, sent.headers))
        check("ni la valeur ni l'en-tête n'arrivent à l'agent", CLE not in json.dumps(out), out)
        out = ask("api_request", handle=item, url=SERVICE + "/v1/chat", method="POST", body={"a": 1})
        check("POST avec un corps JSON", out["success"] and seen[-1].method == "POST" and json.loads(seen[-1].content) == {"a": 1} and seen[-1].headers["content-type"] == "application/json", out)
        before = len(seen)
        for bad in ("https://piege.exemple.test/v1", "https://api.exemple.test.piege.io/v1", "http://api.exemple.test/v1", "https://api.exemple.test:8443/v1",
                    "https://api.exemple.test@piege.io/v1", "https://piege.io\\@api.exemple.test/", "//piege.io/v1", "https://user:p@api.exemple.test/v1", "ftp://api.exemple.test/", "piege.io/v1"):
            out = ask("api_request", handle=item, url=bad)
            check(f"autre origine refusée : {bad}", out["success"] is False and out["error_type"] in ("origin_refused", "bad_url") and len(seen) == before, out)
        out = ask("api_request", handle=item, url="/redirige")
        check("une redirection vers une autre origine n'est pas suivie", out["status"] == 302 and "autre origine" in out["redirect"] and len(seen) == before + 1 and "piege" not in json.dumps(out), out)
        out = ask("api_request", handle=item, url="/image")
        check("un contenu non texte n'est pas transmis", out["body"].startswith("[contenu non texte") and "PNG" not in out["body"], out)
        out = ask("api_request", handle=item, url="/gros")
        check("la réponse est bornée", out["truncated"] is True and len(out["body"]) == coffre.API_MAX_RESPONSE, len(out.get("body", "")))
        echo["on"] = True
        out = ask("api_request", handle=item, url="/v1/echo")
        check("une réponse qui renvoie la clé la montre masquée", out["success"] and CLE not in json.dumps(out) and out["body"].count("[clé masquée]") >= 3 and "Bearer [clé masquée]" in out["body"], out)
        echo["on"] = False
        before = len(seen)
        dns["ip"] = "10.0.0.5"
        out = ask("api_request", handle=item, url="/v1/models")
        check("un nom qui résout vers une adresse privée est refusé", out["error_type"] == "address_refused" and len(seen) == before, out)
        dns["ip"] = "169.254.169.254"
        out = ask("api_request", handle=item, url="/v1/models")
        check("et vers les métadonnées du cloud", out["error_type"] == "address_refused" and len(seen) == before, out)
        dns["ip"] = "93.184.216.34"
        check("méthode inconnue refusée", ask("api_request", handle=item, url="/v1/models", method="TRACE")["error_type"] == "bad_method")
        check("identifiant inconnu", ask("api_request", handle="cle_api_0", url="/")["error_type"] == "unknown_handle")
        r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "cle_api", "nom": "Anthropic", "origine": SERVICE, "cle": CLE + "-2", "entete": "x-api-key"})
        ask("api_request", handle=r.json()["id"], url="/v1/messages")
        check("en-tête nommé : la clé seule, sans Bearer", seen[-1].headers["x-api-key"] == CLE + "-2" and "authorization" not in seen[-1].headers, seen[-1].headers)
        coffre.set_may_use(A, False)
        check("sans le droit, api_keys est vide", ask("api_keys")["items"] == [])
        before = len(seen)
        out = ask("api_request", handle=item, url="/v1/models")
        check("agent sans le droit : refusé, rien n'est envoyé", out["success"] is False and out["error_type"] == "no_right" and len(seen) == before, out)
        coffre.set_may_use(A, True)
        with db.connect() as c:
            c.execute("INSERT INTO coffre_retraits (agent_id, coffre_id) VALUES (?, ?)", (A, item))
        out = ask("api_request", handle=item, url="/v1/models")
        check("une clé retirée à cet agent : refusée", out["error_type"] == "unknown_handle" and len(seen) == before, out)
        with db.connect() as c:
            c.execute("DELETE FROM coffre_retraits")
        out = ask("api_request", handle=item, url="/v1/models", method="DELETE", durci=True)
        check("tour durci : une écriture avec la clé est refusée", out["error_type"] == "hardened" and len(seen) == before, out)
        check("tour durci : une lecture passe", ask("api_request", handle=item, url="/v1/models", durci=True)["success"] is True)
        other = client.post("/agent-api/coffre", headers={"Authorization": f"Bearer {relay.token_for('agent-bruno')}"}, json={"action": "api_request", "handle": item, "url": "/"}).json()
        check("l'agent d'un autre propriétaire : clé inconnue", other["error_type"] in ("unknown_handle", "no_right"), other)
        relay.active[A] = [conversation(UMA)]
        out = ask("api_request", handle=item, url="/v1/models")
        check("la tâche d'une personne invitée n'utilise pas la clé d'Alice", out["success"] is False and out["error_type"] in ("guest", "not_owner"), out)
        relay.active[A] = [CONV]
    finally:
        coffre.httpx.AsyncClient, mcp.socket.getaddrinfo = real_client, real_dns
        relay.active[A] = [CONV]
    check("supprimer la clé", client.delete(f"/api/coffre/{item}", headers=web(ALICE)).status_code == 200 and all(i["handle"] != item for i in ask("api_keys")["items"]))
    check("aucun journal ne contient la clé", not any(CLE in line for line in LOGS))


def test_plugin_tool():
    """L'outil dans la machine de l'agent : il ne prend que list/fill/save_login/enter_code, et ne reçoit aucun secret."""
    sys.path.insert(0, "/app/noah/agent_plugin")
    import importlib
    garde = importlib.import_module("__init__")
    check("le schéma de l'outil n'a aucun champ de secret", set(garde.VAULT_SCHEMA["parameters"]["properties"]) == {"action", "handle", "url", "method", "body"})
    check("une personne invitée n'a pas cet outil", garde.check_guest("browser_vault", {"action": "list"}, "/opt/data/profiles/u2") == garde.GUEST_VAULT)
    check("api_request : une lecture n'appelle pas le juge, une écriture si", garde.no_effect("browser_vault", {"action": "api_request", "method": "GET"})
          and garde.no_effect("browser_vault", {"action": "api_keys"}) and not garde.no_effect("browser_vault", {"action": "api_request", "method": "POST"})
          and not garde.no_effect("browser_vault", {"action": "api_request", "method": "delete"}))
    check("la réponse d'une API est triée comme un contenu de dehors", garde._is_untrusted("browser_vault", {"action": "api_request"}) and not garde._is_untrusted("browser_vault", {"action": "list"}))
    check("la description dit quand l'utiliser", "api_request" in garde.VAULT_SCHEMA["description"] and "API" in garde.VAULT_SCHEMA["description"])
    sent = []
    real_call, garde._vault_call = garde._vault_call, lambda *words: (sent.append(words), {"success": True, "status": 200, "body": "{}"})[1]
    try:
        out = json.loads(garde._vault_tool({"action": "api_request", "handle": "cle_api_1", "url": "/v1/models", "method": "POST", "body": {"a": 1}}, session_id="noah-c1"))
    finally:
        garde._vault_call = real_call
    words = json.loads(sent[0][1])
    check("l'outil transmet la requête telle quelle, sans attendre ni recevoir de secret", out["success"] and sent[0][0] == "coffre" and words["handle"] == "cle_api_1" and words["method"] == "POST" and json.loads(words["body"]) == {"a": 1} and words["session"] == "noah-c1", words)
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
        check("tour ordinaire : il ne se dit pas durci", json.loads(calls[0][1]).get("durci") is False)
        calls.clear()
        answers[:] = [{"success": False, "error_type": "hardened"}]
        garde._hardened["noah-c1"] = time.time() + 60
        try:
            garde._vault_tool({"action": "save_login"}, session_id="noah-c1")
        finally:
            garde._hardened.pop("noah-c1", None)
        check("B-1 tour durci par la garde : le serveur le sait, et ne remplit rien d'office", json.loads(calls[0][1]).get("durci") is True, calls)
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
test_old_database_accepts_api_keys()
test_api_keys()
test_plugin_tool()
test_override_is_consented()
print(f"coffre : {checks} vérifications, tout est vert")
