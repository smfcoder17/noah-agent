"""Lot B de la 0.3.0 (docs/epics/0.3.0/plan-0.3.0.md) : coffre par personne, choisi par le serveur, invisible pour le modèle.

B1 le serveur prend l'identifiant unique du site (origine exacte, puis même site) ; plusieurs : la carte demande lequel.
B2 coffre par personne, droit par agent ; migration des lignes par agent sans perte (base remplie avant migration).
B3 sonde : aucune valeur secrète dans ce que reçoit le modèle.
B4 (partiel) clé d'authentificateur : le serveur tape le code ; carte : rangée sans code de sécurité.
B6 Réglages > Coffre : ajouter, voir après preuve, modifier, supprimer ; import CSV avec raison de chaque refus.

Vrais : routes, base, droits, scellement, preuve. Simulé : le navigateur (hermes.browser_call), comme dans coffre_test.py.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/coffre_030_test.py"
"""
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

from noah import auth, coffre, db, hermes, main, push, relay, sites  # noqa: E402

MDP_ANCIEN = "ancien-Kq27w-secret"
MDP_A = "premier-Xv93p-secret"
MDP_B = "second-Lm55t-secret"
ID_A = "franck.instagram@exemple.fr"
ID_B = "boutique.officielle@exemple.fr"
TOTP_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # « 12345678901234567890 », la clé de la RFC 6238
CARTE = "4242424242424242"
CVC = "737"
checks = 0
SEEN_BY_MODEL: list[str] = []  # B3 : tout ce que l'agent reçoit, relu à la fin


def check(name, ok, detail=""):
    global checks
    assert ok, f"{name} : {str(detail)[:400]}"
    checks += 1
    print("OK  ", name)


db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
A1, A2, A3, A4, AB = "a1-perso", "a2-perso", "a3-partage-ancien", "a4-partage", "ab-bruno"
with db.connect() as c:
    for agent, who in ((A1, ALICE), (A2, ALICE), (A3, ALICE), (A4, ALICE), (AB, BRUNO)):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent, agent, who))
    for agent in (A3, A4):
        c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'usage')", (agent, BRUNO))


class Page:
    def __init__(self):
        self.origine, self.champs, self.fills = "https://www.instagram.com", {"identifiant": True, "motDePasse": True, "code": False}, []
        self.reply = {"ok": True, "rempli": ["identifiant", "motDePasse"], "complet": True, "page": "changee", "http_status": 200}
        self.after = None  # les champs de la page une fois le formulaire parti

    async def __call__(self, agent_id, method, path, timeout=5, key=None, **kw):
        if path == "/noah/page":
            return {"ok": True, "onglet": "t1", "origine": self.origine, "champs": self.champs, "http_status": 200}
        if path == "/noah/remplir":
            self.fills.append(kw["json"])
            if self.after is not None:
                self.champs = self.after
            return dict(self.reply)
        return {"cookies": [{"domain": ".lu-seulement.fr", "expires": time.time() + 400 * 86400}]}  # storage_state : jamais lu


page = Page()
hermes.browser_call = page
pushed = []
push.notify = lambda title, text, **kw: pushed.append(title + " " + text)
client = TestClient(main.app)
TOKENS = {u: auth.new_session(u) for u in (ALICE, BRUNO)}


def web(user):
    return {"Authorization": f"Bearer {TOKENS[user]}"}


CONVS = {a: main._new_conversation(ALICE if a != AB else BRUNO, a, "Essai") for a in (A1, A2, A3, A4, AB)}
for agent, conv in CONVS.items():
    relay.active[agent] = [conv]


def agent_post(agent, path, body):
    r = client.post(path, headers={"Authorization": f"Bearer {relay.token_for(agent)}"}, json=body)
    SEEN_BY_MODEL.append(r.text)
    return r


def vault(agent, action="save_login", **extra):
    return agent_post(agent, "/agent-api/coffre", {"action": action, "session": f"noah-{CONVS[agent]}", **extra}).json()


def agent_gets(agent, ask_id):
    r = client.get(f"/agent-api/coffre/{ask_id}", headers={"Authorization": f"Bearer {relay.token_for(agent)}"}, params={"attente": 0})
    SEEN_BY_MODEL.append(r.text)
    return r.json()


def card(agent):
    return client.get(f"/api/conversations/{CONVS[agent]}/en-cours", headers=web(ALICE)).json()["connexion"]


def test_migration_without_loss():
    """B2 : une base d'avant 0.3.0, remplie : les identifiants par agent passent au coffre du propriétaire, à l'identique.
    D4 : deux lignes du même compte (propriétaire, origine, identifiant) n'en font qu'une, la plus récente.
    D5 : un agent partagé n'y gagne pas le droit sur tout le coffre du propriétaire."""
    old = {}
    with db.connect() as c:
        for handle, agent, origin, ident, pwd, used in (("login_ancien1", A1, "https://www.instagram.com", ID_A, MDP_ANCIEN, 1700000100.0),
                                                         ("login_ancien2", A3, "https://www.linkedin.com", "pro@exemple.fr", MDP_ANCIEN + "2", 1700000300.0),
                                                         ("login_ancien3", A3, "https://www.linkedin.com", "pro@exemple.fr", MDP_ANCIEN + "3", 1700000200.0)):
            sealed = db.seal(json.dumps({"identifiant": ident, "mot_de_passe": pwd}))
            old[handle] = (agent, origin, sealed, used)
            c.execute("INSERT INTO agent_logins (id, agent_id, origine, secret, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)",
                      (handle, agent, origin, sealed, 1700000000.0, used))
    db.init()  # le démarrage de la nouvelle version
    db.init()  # et le suivant : rien ne bouge deux fois
    with db.connect() as c:
        moved = {r["id"]: dict(r) for r in c.execute("SELECT * FROM coffre")}
        left = c.execute("SELECT COUNT(*) FROM agent_logins").fetchone()[0]
        rights = {r["agent_id"]: r["utiliser"] for r in c.execute("SELECT * FROM coffre_agents")}
    kept = ("login_ancien1", "login_ancien2")
    check("migration : chaque compte est là, même id, même secret scellé, mêmes dates, chez le propriétaire",
          all(h in moved and moved[h]["secret"] == old[h][2] and moved[h]["origine"] == old[h][1] and moved[h]["user_id"] == ALICE
              and moved[h]["created_at"] == 1700000000.0 and moved[h]["used_at"] == old[h][3] for h in kept), moved)
    check("D4 deux lignes pour le même compte : une seule reste, la plus récente", "login_ancien2" in moved and "login_ancien3" not in moved, moved)
    check("migration : l'ancienne table est vide, rien n'est en double", left == 0 and len(moved) == 2, left)
    check("D5 la migration n'allume pas le droit d'un agent partagé", rights.get(A3) != 1 and not coffre.may_use(A3) and coffre.may_use(A1), rights)
    check("D5 l'écran du propriétaire le dit : agent partagé, droit éteint",
          next(a for a in client.get("/api/coffre", headers=web(ALICE)).json()["agents"] if a["id"] == A3) == {"id": A3, "nom": A3, "utiliser": False, "partage": True})
    done = vault(A1, "fill", handle="login_ancien1")
    check("une connexion enregistrée avant la migration sert toujours, par son ancien handle", done["success"] and page.fills[-1]["motDePasse"] == MDP_ANCIEN, done)
    # m7 : une ligne dont l'agent n'a pas (encore) de propriétaire est rattachée au propriétaire de l'installation au démarrage suivant.
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a0-orphelin', 'a0', '', 'k', NULL)")
        c.execute("INSERT INTO agent_logins (id, agent_id, origine, secret, created_at, used_at) VALUES ('login_orphelin', 'a0-orphelin', 'https://exemple.org', ?, ?, NULL)",
                  (db.seal(json.dumps({"identifiant": "o@exemple.org", "mot_de_passe": "orphelin-Pw1"})), 1700000000.0))
        db._migrate_logins(c)
        row = c.execute("SELECT user_id FROM coffre WHERE id = 'login_orphelin'").fetchone()
        left = c.execute("SELECT COUNT(*) FROM agent_logins").fetchone()[0]
    check("m7 une ligne sans propriétaire est rattachée au propriétaire de l'installation", row is not None and row["user_id"] == db.owner_id() and left == 0, (row and dict(row), left))
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE id IN ('login_ancien2', 'login_orphelin')")
        c.execute("DELETE FROM agents WHERE id = 'a0-orphelin'")
        c.execute("DELETE FROM coffre_agents WHERE agent_id = ?", (A3,))


def test_server_picks_the_only_login():
    """B1 : un identifiant Instagram retenu, page sur la même origine exacte : aucune carte, connexion faite par le serveur."""
    page.origine = "https://www.instagram.com"
    page.after = {"identifiant": False, "motDePasse": False, "code": False}
    fills, notices = len(page.fills), len(pushed)
    out = vault(A1)
    check("B1 un seul identifiant pour l'origine exacte : rempli d'office, sans carte ni notification",
          out.get("success") and out.get("automatic") and card(A1) is None and len(pushed) == notices, out)
    check("B1 la page a reçu l'ancien identifiant, sur l'origine lue", page.fills[-1]["motDePasse"] == MDP_ANCIEN and page.fills[-1]["origine"] == "https://www.instagram.com" and len(page.fills) == fills + 1)
    listed = client.get(f"/api/agents/{A1}/sites", headers=web(ALICE)).json()
    check("B5 connexion vérifiée par le serveur : le site est noté connecté", [(s["hote"], s["etat"]) for s in listed] == [("instagram.com", "connecte")], listed)
    page.after, page.champs = None, {"identifiant": True, "motDePasse": True, "code": False}
    page.origine = "https://www.instagram.com"


def test_two_accounts_ask_which():
    """B1 : deux comptes pour le site : la carte demande lequel, sans montrer le secret."""
    # un compte retenu par la carte, puis un second par Réglages > Coffre
    with db.connect() as c:
        c.execute("DELETE FROM coffre")
    ask_id = vault(A1)["attente"]
    r = client.post(f"/api/agents/{A1}/connexions/{ask_id}", headers=web(ALICE), json={"identifiant": ID_A, "mot_de_passe": MDP_A})
    assert r.status_code == 200, r.text
    agent_gets(A1, ask_id)
    ask_id = vault(A1)
    check("un compte retenu : rempli d'office", ask_id.get("automatic"), ask_id)
    # un second compte, ajouté par Réglages > Coffre
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "login", "nom": "Boutique", "origine": "https://www.instagram.com/accounts/login", "identifiant": ID_B, "mot_de_passe": MDP_B})
    check("B6 ajouter un identifiant", r.status_code == 200 and r.json()["origine"] == "https://www.instagram.com" and MDP_B not in r.text and ID_B not in r.text, r.text)
    ask_id = vault(A1)["attente"]
    shown = card(A1)
    check("B1 deux comptes : la carte demande lequel", shown and len(shown.get("comptes") or []) == 2, shown)
    check("B1 la carte ne montre que le nom et deux caractères", {c["compte"] for c in shown["comptes"]} == {"fr•••", "bo•••"} and ID_A not in json.dumps(shown) and MDP_A not in json.dumps(shown), shown)
    bad = client.post(f"/api/agents/{A1}/connexions/{ask_id}", headers=web(ALICE), json={"choix": "login_inexistant"})
    check("B1 un compte hors de la liste est refusé, la carte attend toujours", bad.status_code == 400 and coffre.pending(CONVS[A1]), bad.text)
    chosen = next(c for c in shown["comptes"] if c["nom"] == "Boutique")
    r = client.post(f"/api/agents/{A1}/connexions/{ask_id}", headers=web(ALICE), json={"choix": chosen["id"]})
    seen = agent_gets(A1, ask_id)
    check("B1 le compte choisi part dans la page", r.status_code == 200 and page.fills[-1]["identifiant"] == ID_B and page.fills[-1]["motDePasse"] == MDP_B, r.text)
    check("B1 l'agent apprend le résultat, pas le compte", seen["success"] and ID_B not in json.dumps(seen) and MDP_B not in json.dumps(seen), seen)


def test_vault_is_per_person():
    """B2 : l'identifiant retenu par l'agent A1 sert à A2 du même propriétaire, pas à un agent partagé ni à l'agent d'un autre."""
    with db.connect() as c:
        c.execute("DELETE FROM coffre")
    ask_id = vault(A1)["attente"]
    client.post(f"/api/agents/{A1}/connexions/{ask_id}", headers=web(ALICE), json={"identifiant": ID_A, "mot_de_passe": MDP_A})
    agent_gets(A1, ask_id)
    out = vault(A2)
    check("B2 retenu par A1, il sert à A2 du même propriétaire, d'office", out.get("automatic") and page.fills[-1]["motDePasse"] == MDP_A, out)
    check("B2 l'agent partagé ne le voit pas (droit éteint d'office)", vault(A4, "list")["items"] == [] and not coffre.may_use(A4))
    out = vault(A4)
    check("B2 l'agent partagé ouvre une carte au lieu de le prendre", "attente" in out and not card(A4).get("comptes"), out)
    client.delete(f"/agent-api/coffre/{out['attente']}", headers={"Authorization": f"Bearer {relay.token_for(A4)}"})
    check("B2 l'agent d'une autre personne ne le voit pas", vault(AB, "list")["items"] == [])
    handle = vault(A2, "list")["items"][0]["handle"]
    check("B2 ni par son handle", vault(AB, "fill", handle=handle)["error_type"] == "unknown_handle" and vault(A4, "fill", handle=handle)["error_type"] == "unknown_handle")
    r = client.get(f"/api/agents/{A4}/coffre-droit", headers=web(ALICE))
    check("B2 le droit se lit : éteint, agent partagé", r.json() == {"utiliser": False, "partage": True}, r.text)
    check("B2 un autre profil ne le règle pas", client.put(f"/api/agents/{A4}/coffre-droit", headers=web(BRUNO), json={"utiliser": True}).status_code in (403, 404))
    r = client.put(f"/api/agents/{A4}/coffre-droit", headers=web(ALICE), json={"utiliser": True})
    check("B2 le propriétaire l'allume", r.status_code == 200 and r.json()["utiliser"] and vault(A4)["automatic"], r.text)
    client.put(f"/api/agents/{A4}/coffre-droit", headers=web(ALICE), json={"utiliser": False})
    client.put(f"/api/agents/{A2}/coffre-droit", headers=web(ALICE), json={"utiliser": False})
    check("B2 éteint, même un agent à lui ne s'en sert plus", vault(A2, "list")["items"] == [] and vault(A2, "fill", handle=handle)["error_type"] == "unknown_handle")
    client.put(f"/api/agents/{A2}/coffre-droit", headers=web(ALICE), json={"utiliser": True})
    mine = client.get("/api/coffre", headers=web(ALICE)).json()
    check("B6 l'écran Coffre liste les agents et leur droit", {a["id"]: a["utiliser"] for a in mine["agents"]} == {A1: True, A2: True, A3: False, A4: False}, mine["agents"])
    check("B2 le coffre de Bruno est à lui seul", client.get("/api/coffre", headers=web(BRUNO)).json()["elements"] == [])


def test_totp_and_card():
    """B4 (partiel) : le code d'authentificateur tapé par le serveur ; la carte rangée sans son code de sécurité."""
    check("B4 TOTP : vecteurs de la RFC 6238", coffre.totp_code(TOTP_KEY, 59, 8) == "94287082" and coffre.totp_code(TOTP_KEY, 1111111109, 8) == "07081804")
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "totp", "origine": "https://www.instagram.com", "cle": "otpauth://totp/Instagram:franck?secret=" + TOTP_KEY + "&issuer=Instagram"})
    check("B4 clé d'authentificateur ajoutée, sans la montrer", r.status_code == 200 and TOTP_KEY not in r.text, r.text)
    check("B4 une clé illisible est refusée", client.post("/api/coffre", headers=web(ALICE), json={"genre": "totp", "origine": "instagram.com", "cle": "pas une clé !"}).status_code == 400)
    page.champs = {"identifiant": False, "motDePasse": False, "code": True}
    page.reply = {"ok": True, "rempli": ["code"], "complet": True, "page": "changee", "http_status": 200}
    before = len(page.fills)
    out = vault(A1, "enter_code")
    now = time.time()
    codes = {coffre.totp_code(TOTP_KEY, now), coffre.totp_code(TOTP_KEY, now - 30)}
    check("B4 page de code : le serveur tape le code lui-même, sans carte", out.get("automatic") and len(page.fills) == before + 1 and page.fills[-1]["code"] in codes and card(A1) is None, out)
    check("B4 le modèle ne voit pas le code", page.fills[-1]["code"] not in json.dumps(out))
    page.champs = {"identifiant": True, "motDePasse": True, "code": False}
    page.reply = {"ok": True, "rempli": ["identifiant", "motDePasse"], "complet": True, "page": "changee", "http_status": 200}
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "carte", "numero": "4242 4242 4242 4241", "expiration": "12/30"})
    check("B4 un numéro de carte faux est refusé, sans être recopié", r.status_code == 400 and "4241" not in r.text, r.text)
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "carte", "numero": "4242 4242 4242 4242", "expiration": "12/30", "titulaire": "Franck", "cvc": CVC})
    check("B4 carte rangée : marque, 4 derniers chiffres, expiration", r.status_code == 200 and r.json()["apercu"] == "Visa •••• 4242 · 12/30" and CARTE not in r.text, r.text)
    check("B4 la carte n'est jamais proposée au modèle", all(i["kind"] == "login" for i in vault(A1, "list")["items"]))


def test_settings_screen():
    """B6 : voir après preuve, modifier, supprimer ; import CSV de 3 lignes, une mauvaise refusée avec sa raison."""
    items = client.get("/api/coffre", headers=web(ALICE)).json()["elements"]
    text = json.dumps(items)
    check("B6 la liste ne porte aucune valeur", items and not any(s in text for s in (MDP_A, MDP_B, ID_A, ID_B, TOTP_KEY, CARTE)), text)
    login = next(i for i in items if i["genre"] == "login" and i["apercu"] == "fr•••")
    r = client.post(f"/api/coffre/{login['id']}/voir", headers=web(ALICE), json={})
    check("B6 voir sans preuve : 428, rien n'est montré", r.status_code == 428 and MDP_A not in r.text, r.text)
    r = client.post(f"/api/coffre/{login['id']}/voir", headers=web(ALICE), json={"motdepasse": "faux"})
    check("B6 voir avec un mauvais mot de passe : refusé", r.status_code == 400 and MDP_A not in r.text, r.text)
    r = client.post(f"/api/coffre/{login['id']}/voir", headers=web(ALICE), json={"motdepasse": "motdepasse-a"})
    check("B6 voir avec la preuve", r.status_code == 200 and r.json() == {"identifiant": ID_A, "mot_de_passe": MDP_A}, r.text)
    check("B6 l'élément d'un autre n'existe pas", client.post(f"/api/coffre/{login['id']}/voir", headers=web(BRUNO), json={"motdepasse": "motdepasse-b"}).status_code == 404)
    r = client.put(f"/api/coffre/{login['id']}", headers=web(ALICE), json={"nom": "Perso", "mot_de_passe": ""})
    check("B6 modifier le nom : le mot de passe vide garde l'ancien", r.status_code == 200 and r.json()["nom"] == "Perso"
          and client.post(f"/api/coffre/{login['id']}/voir", headers=web(ALICE), json={}).json()["mot_de_passe"] == MDP_A, r.text)
    r = client.put(f"/api/coffre/{login['id']}", headers=web(ALICE), json={"mot_de_passe": MDP_A + "-neuf"})
    check("B6 modifier le mot de passe", client.post(f"/api/coffre/{login['id']}/voir", headers=web(ALICE), json={}).json()["mot_de_passe"] == MDP_A + "-neuf", r.text)
    listed = vault(A1, "list")["items"]
    check("B3 le modèle voit le nom donné par la personne", any(i["name"] == "Perso" for i in listed), listed)
    check("B6 un autre profil ne modifie ni ne supprime", client.put(f"/api/coffre/{login['id']}", headers=web(BRUNO), json={"nom": "x"}).status_code == 404
          and client.delete(f"/api/coffre/{login['id']}", headers=web(BRUNO)).status_code == 404)
    check("B6 supprimer", client.delete(f"/api/coffre/{login['id']}", headers=web(ALICE)).status_code == 200
          and all(i["id"] != login["id"] for i in client.get("/api/coffre", headers=web(ALICE)).json()["elements"]))

    csv_text = ("name,url,username,password,note\n"
                "Notion,https://www.notion.so/login,franck@exemple.fr,csv-Pw1-secret,\n"
                "Sans adresse,,franck@exemple.fr,csv-Pw2-secret,\n"
                "Github,https://github.com/login,franck,csv-Pw3-secret,\n")
    r = client.post("/api/coffre/import", headers=web(ALICE), json={"csv": csv_text})
    out = r.json()
    check("B6 import CSV : deux lignes ajoutées, la mauvaise refusée avec sa ligne et sa raison",
          r.status_code == 200 and out["ajoutes"] == 2 and out["refuses"] == [{"ligne": 3, "raison": "Adresse du site manquante ou illisible."}], out)
    check("B6 l'import ne recopie aucune valeur", "csv-Pw" not in r.text and "franck@" not in r.text, r.text)
    r = client.post("/api/coffre/import", headers=web(ALICE), json={"csv": csv_text})
    check("B6 réimporter remplace au lieu de doubler", r.json()["ajoutes"] == 0 and r.json()["remplaces"] == 2, r.text)
    bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Dropbox,,,0,https://www.dropbox.com,f@e.fr,bw-Pw-secret,\n"
    check("B6 un export Bitwarden se lit aussi", client.post("/api/coffre/import", headers=web(ALICE), json={"csv": bitwarden}).json()["ajoutes"] == 1)
    r = client.post("/api/coffre/import", headers=web(ALICE), json={"csv": "a,b\n1,2\n"})
    check("B6 colonnes inconnues : refusé avec la raison", r.status_code == 400 and "Colonnes introuvables" in r.text, r.text)
    with db.connect() as c:
        notion = [r for r in c.execute("SELECT * FROM coffre WHERE origine = 'https://www.notion.so'")]
    check("B6 l'import est scellé, avec son nom", len(notion) == 1 and notion[0]["nom"] == "Notion" and "csv-Pw1" not in notion[0]["secret"])


def test_reconnect_state():
    """B5 : une page de connexion qui revient sur un site noté connecté le met « à reconnecter »."""
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ? AND genre = 'login'", (ALICE,))
    sites.note(A1, "instagram.com")
    check("B5 avant : connecté", [s["etat"] for s in client.get(f"/api/agents/{A1}/sites", headers=web(ALICE)).json()] == ["connecte"])
    out = vault(A1)
    listed = client.get(f"/api/agents/{A1}/sites", headers=web(ALICE)).json()
    check("B5 la session est partie : « à reconnecter »", [(s["hote"], s["etat"]) for s in listed] == [("instagram.com", "a_reconnecter")], listed)
    client.delete(f"/agent-api/coffre/{out['attente']}", headers={"Authorization": f"Bearer {relay.token_for(A1)}"})


def test_model_never_sees_a_secret():
    """B3 : la sonde. Tout ce que l'agent a reçu dans ce fichier, plus ce que son outil et sa consigne lui disent."""
    sys.path.insert(0, "/app/noah/agent_plugin")
    import importlib
    garde = importlib.import_module("__init__")
    SEEN_BY_MODEL.extend([json.dumps(garde.VAULT_SCHEMA, ensure_ascii=False), garde.LOGIN_HINT])
    text = "\n".join(SEEN_BY_MODEL)
    secrets_values = (MDP_ANCIEN, MDP_A, MDP_B, ID_A, ID_B, ID_A[2:], ID_B[2:], "exemple.fr", TOTP_KEY, CARTE, CVC, "csv-Pw", "bw-Pw")
    leaked = [s for s in secrets_values if s in text]
    check(f"B3 sonde : aucune valeur secrète dans {len(SEEN_BY_MODEL)} réponses à l'agent", not leaked, leaked)
    item = vault(A1, "list")
    check("B3 d'un identifiant, le modèle reçoit nom, site et deux caractères", all(set(i) == {"handle", "kind", "name", "origin", "label", "account"} for i in item["items"]), item)
    with db.connect() as c:
        tables = [r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        dump = json.dumps({t: [dict(r) for r in c.execute(f'SELECT * FROM "{t}"').fetchall()] for t in tables}, default=str)
    # Le code de sécurité (3 chiffres) se retrouve au hasard dans un scellé en base64 ou une date : il a sa vérification juste après, sur les valeurs descellées.
    leaked = [s for s in (MDP_A, MDP_B, ID_A, ID_B, TOTP_KEY, CARTE, "csv-Pw1", "bw-Pw") if s in dump]
    check("chiffrement au repos : aucune valeur en clair dans la base", not leaked)
    check("le code de sécurité de la carte n'est rangé nulle part, même scellé", not any(CVC in db.unseal(r["secret"]) for r in json.loads(dump)["coffre"]))
    check("aucune valeur dans les journaux du serveur", not [line for line in LOGS if any(s in line for s in (MDP_A, MDP_B, TOTP_KEY, CARTE))])
    check("aucune valeur dans les notifications", not [p for p in pushed if any(s in p for s in (MDP_A, ID_A, ID_B))])


def test_other_profile_turn_never_fills():
    """Relecture GLM partie 4 n°1 et 2 : un agent du propriétaire partagé (droit admin), tâche lancée par l'autre profil. Le serveur
    ne tape jamais d'office un secret du propriétaire (identifiant ou code), ni par son handle ; la connexion de l'autre profil ne
    note pas le site « connecté »."""
    A5 = "a5-partage-admin"
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (A5, A5, ALICE))
        c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (A5, BRUNO))
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
    client.put(f"/api/agents/{A5}/coffre-droit", headers=web(ALICE), json={"utiliser": True})
    CONVS[A5] = main._new_conversation(BRUNO, A5, "Essai invité")
    relay.active[A5] = [CONVS[A5]]
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "login", "origine": "https://www.instagram.com", "identifiant": ID_A, "mot_de_passe": MDP_A})
    handle = r.json()["id"]
    client.post("/api/coffre", headers=web(ALICE), json={"genre": "totp", "origine": "https://www.instagram.com", "cle": TOTP_KEY})
    page.origine, page.champs, page.after = "https://www.instagram.com", {"identifiant": True, "motDePasse": True, "code": False}, None
    fills = len(page.fills)
    out = vault(A5)
    shown = client.get(f"/api/conversations/{CONVS[A5]}/en-cours", headers=web(BRUNO)).json()["connexion"]
    check("P4n1 tâche d'un autre profil, un seul identifiant du propriétaire : carte vide, rien tapé d'office",
          "attente" in out and len(page.fills) == fills and shown and not shown.get("comptes"), (out, shown))
    client.delete(f"/agent-api/coffre/{out['attente']}", headers={"Authorization": f"Bearer {relay.token_for(A5)}"})
    page.champs = {"identifiant": False, "motDePasse": False, "code": True}
    out = vault(A5, "enter_code")
    check("P4n1 de même pour le code d'authentificateur du propriétaire", "attente" in out and len(page.fills) == fills, out)
    client.delete(f"/agent-api/coffre/{out['attente']}", headers={"Authorization": f"Bearer {relay.token_for(A5)}"})
    page.champs = {"identifiant": True, "motDePasse": True, "code": False}
    out = vault(A5, "fill", handle=handle)
    check("P4n1 ni par son handle", out.get("error_type") == "not_owner" and len(page.fills) == fills, out)
    ask_id = vault(A5)["attente"]
    r = client.post(f"/api/agents/{A5}/connexions/{ask_id}", headers=web(BRUNO), json={"identifiant": "bruno@ailleurs.fr", "mot_de_passe": "mdp-de-bruno-1"})
    agent_gets(A5, ask_id)
    listed = client.get(f"/api/agents/{A5}/sites", headers=web(ALICE)).json()
    check("P4n2 la connexion de l'autre profil part dans la page, sans noter le site connecté",
          r.status_code == 200 and page.fills[-1]["identifiant"] == "bruno@ailleurs.fr" and not [s for s in listed if s["etat"] == "connecte"], (r.text, listed))
    relay.active[A5] = []
    CONVS[A5] = main._new_conversation(ALICE, A5, "Essai propriétaire")
    relay.active[A5] = [CONVS[A5]]
    out = vault(A5)
    check("P4n1 la tâche du propriétaire, elle, remplit d'office", out.get("automatic") and page.fills[-1]["motDePasse"] == MDP_A, out)
    relay.active[A5] = []
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))


def test_review_small_fixes():
    """Relecture GLM partie 1 n°3, partie 4 n°3 à 5."""
    r = client.post("/api/coffre", headers=web(ALICE), json={"genre": "login", "origine": "https://exemple.org", "identifiant": "", "mot_de_passe": "seul-Mdp-1"})
    check("P1n3 un identifiant sans identifiant est refusé par le serveur", r.status_code == 400 and "identifiant" in r.text, r.text)
    out = client.post("/api/coffre/import", headers=web(ALICE), json={"csv": "url,username,password\nhttps://exemple.org,,csv-Pw9-secret\n"}).json()
    check("P1n3 de même à l'import", out["ajoutes"] == 0 and out["refuses"] == [{"ligne": 2, "raison": "Identifiant manquant."}], out)
    check("P4n4 une adresse IPv6 est une origine", coffre.origin_of("http://[::1]:8080/login") == "http://[::1]:8080"
          and coffre.origin_of("https://[2001:db8::1]/") == "https://[2001:db8::1]" and coffre.origin_of("http://[zz::1]/") == "", coffre.origin_of("http://[::1]:8080/login"))
    with db.connect() as c:
        c.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at) VALUES ('totp_abime', ?, 'totp', '', 'https://exemple.org', ?, ?)",
                  (ALICE, db.seal(json.dumps({"cle": "1A"})), time.time()))
    r = client.post("/api/coffre/totp_abime/voir", headers=web(ALICE), json={"motdepasse": "motdepasse-a"})
    check("P4n5 une clé abîmée en base : erreur propre, sans la clé", r.status_code == 422 and "1A" not in r.text, r.text)
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
        count = c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ?", (ALICE,)).fetchone()[0]
    saved_max, coffre.MAX_ITEMS = coffre.MAX_ITEMS, count
    page.origine, page.champs, page.after = "https://www.instagram.com", {"identifiant": True, "motDePasse": True, "code": False}, None
    try:
        ask_id = vault(A1)["attente"]
        r = client.post(f"/api/agents/{A1}/connexions/{ask_id}", headers=web(ALICE), json={"identifiant": ID_A, "mot_de_passe": MDP_A})
        seen = agent_gets(A1, ask_id)
    finally:
        coffre.MAX_ITEMS = saved_max
    check("P4n3 coffre plein : la personne et l'agent le savent, l'agent ne relance pas",
          r.json().get("coffre_plein") and seen.get("vault_full") and "ne rappelle pas save_login" in seen.get("next", ""), (r.text, seen))


def agent_auth(agent):
    return {"Authorization": f"Bearer {relay.token_for(agent)}"}


def test_b1_exact_origin_only():
    """Relecture B-1 : d'office seulement sur l'origine exacte (schéma, hôte, port) ; un autre hôte du même site montre la carte
    « Quel compte ? » avec l'origine réelle de la page ; jamais d'office dans un tour durci ; « même site » lu dans la liste publique
    des suffixes, section privée comprise, copiée dans le dépôt."""
    import asyncio
    from noah import juge
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
    adsl = client.post("/api/coffre", headers=web(ALICE), json={"genre": "login", "nom": "Freebox", "origine": "https://adsl.free.fr", "identifiant": ID_A, "mot_de_passe": MDP_A}).json()["id"]
    page.origine, page.champs, page.after = "https://pirate.free.fr", {"identifiant": True, "motDePasse": True, "code": False}, None
    fills = len(page.fills)
    out = vault(A1)
    shown = card(A1)
    check("B-1 autre hôte du même site : rien tapé d'office, la carte « Quel compte ? » s'ouvre",
          "attente" in out and len(page.fills) == fills and shown and [c["id"] for c in shown.get("comptes") or []] == [adsl], (out, shown))
    check("B-1 la carte montre l'origine réelle de la page, et celle du compte proposé",
          shown["origine"] == "https://pirate.free.fr" and shown["comptes"][0]["origine"] == "https://adsl.free.fr", shown)
    client.delete(f"/agent-api/coffre/{out['attente']}", headers=agent_auth(A1))
    out = vault(A1, "fill", handle=adsl)
    check("B-1 ni par son handle sur l'autre hôte", out.get("error_type") == "origin_mismatch" and len(page.fills) == fills, out)
    for neighbour in ("http://adsl.free.fr", "https://adsl.free.fr:8443"):
        page.origine = neighbour
        out = vault(A1)
        check(f"B-1 {neighbour} : autre schéma ou autre port, rien d'office", "attente" in out and len(page.fills) == fills, out)
        client.delete(f"/agent-api/coffre/{out['attente']}", headers=agent_auth(A1))
    page.origine = "https://adsl.free.fr"
    out = vault(A1)
    check("B-1 sur son origine exacte : rempli d'office", out.get("automatic") and len(page.fills) == fills + 1, out)
    fills = len(page.fills)
    out = vault(A1, durci=True)
    check("B-1 tour durci signalé par la garde : la carte, rien d'office", "attente" in out and len(page.fills) == fills and card(A1).get("comptes"), out)
    client.delete(f"/agent-api/coffre/{out['attente']}", headers=agent_auth(A1))
    out = vault(A1, "fill", handle=adsl, durci=True)
    check("B-1 tour durci : pas de remplissage par handle", out.get("error_type") == "hardened" and len(page.fills) == fills, out)
    client.post("/api/coffre", headers=web(ALICE), json={"genre": "totp", "origine": "https://adsl.free.fr", "cle": TOTP_KEY})
    turn = asyncio.run(juge._read_turn(A1, juge.Call(outil="browser_vault", session=f"noah-{CONVS[A1]}"), for_key_only=True))
    juge._harden(A1, turn)
    try:
        out = vault(A1)
        check("B-1 tour durci connu du serveur seul : la carte, rien d'office", "attente" in out and len(page.fills) == fills, out)
        client.delete(f"/agent-api/coffre/{out['attente']}", headers=agent_auth(A1))
        page.champs = {"identifiant": False, "motDePasse": False, "code": True}
        out = vault(A1, "enter_code")
        check("B-1 tour durci : le code d'authentificateur n'est pas tapé d'office non plus", "attente" in out and len(page.fills) == fills, out)
        client.delete(f"/agent-api/coffre/{out['attente']}", headers=agent_auth(A1))
    finally:
        juge._hardened.clear()
        page.champs = {"identifiant": True, "motDePasse": True, "code": False}
    check("PSL section privée : a.github.io et b.github.io ne sont pas le même site",
          not coffre.same_site("https://a.github.io", "https://b.github.io") and coffre.site_of("https://a.github.io") == "a.github.io")
    check("PSL section ICANN : www.exemple.co.uk et exemple.co.uk sont le même site",
          coffre.same_site("https://www.exemple.co.uk", "https://exemple.co.uk") and coffre.site_of("https://a.b.exemple.co.uk") == "exemple.co.uk")
    check("PSL joker et exception : *.ck, !www.ck", coffre.site_of("https://a.b.ck") == "a.b.ck" and coffre.site_of("https://x.www.ck") == "www.ck")
    listing = (Path(coffre.__file__).parent / "suffixes_publics.dat").read_text(encoding="utf-8")
    check("PSL copie figée dans le dépôt, avec sa source et sa date, les deux sections",
          "publicsuffix.org" in listing[:600] and "2026-11-15" in listing[:600] and "===BEGIN PRIVATE DOMAINS===" in listing and "\ngithub.io\n" in listing
          and not hasattr(coffre, "SHARED_HOSTING") and "httpx" not in Path(coffre.__file__).read_text(encoding="utf-8").split("def _suffixes", 1)[-1].split("\ndef ", 1)[0])
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
    page.origine = "https://www.instagram.com"


def test_review_d_fixes():
    """Relecture D2, D4, D6, m3 et point 12 : la preuve pour changer l'origine ou l'identifiant ; les doublons réduits au choix ;
    « Retirer » dans les Connexions d'un agent garde l'identifiant au coffre ; l'import d'une clé TOTP borné et sans doublon ;
    deux comptes du même site se distinguent dans la liste d'un agent."""
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
    fresh = {"Authorization": f"Bearer {auth.new_session(ALICE)}"}  # aucune preuve récente sur cette session
    item = client.post("/api/coffre", headers=fresh, json={"genre": "login", "origine": "https://www.exemple.org", "identifiant": ID_A, "mot_de_passe": MDP_A}).json()

    def origin():
        return next(e for e in client.get("/api/coffre", headers=fresh).json()["elements"] if e["id"] == item["id"])["origine"]
    r = client.put(f"/api/coffre/{item['id']}", headers=fresh, json={"nom": "Perso", "origine": "https://www.exemple.org/login"})
    check("D2 changer le nom (même origine) : sans preuve", r.status_code == 200 and r.json()["nom"] == "Perso", r.text)
    r = client.put(f"/api/coffre/{item['id']}", headers=fresh, json={"origine": "https://ailleurs.exemple.net"})
    check("D2 changer l'origine sans preuve : 428, rien ne change", r.status_code == 428 and origin() == "https://www.exemple.org", r.text)
    r = client.put(f"/api/coffre/{item['id']}", headers=fresh, json={"identifiant": "autre@exemple.fr"})
    check("D2 changer l'identifiant sans preuve : 428", r.status_code == 428, r.text)
    r = client.put(f"/api/coffre/{item['id']}", headers=fresh, json={"origine": "https://ailleurs.exemple.net", "motdepasse": "faux"})
    check("D2 avec un mauvais mot de passe : refusé", r.status_code == 400 and origin() == "https://www.exemple.org", r.text)
    r = client.put(f"/api/coffre/{item['id']}", headers=fresh, json={"origine": "https://ailleurs.exemple.net", "motdepasse": "motdepasse-a"})
    check("D2 avec la preuve : changé", r.status_code == 200 and origin() == "https://ailleurs.exemple.net", r.text)

    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
        for i, (pwd, used) in enumerate(((MDP_A, 1700000900.0), (MDP_B, 1700000100.0))):
            c.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at, used_at) VALUES (?, ?, 'login', '', 'https://www.instagram.com', ?, ?, ?)",
                      (f"login_double{i}", ALICE, db.seal(json.dumps({"identifiant": ID_A, "mot_de_passe": pwd})), 1700000000.0 + i, used))
    page.origine, page.champs, page.after = "https://www.instagram.com", {"identifiant": True, "motDePasse": True, "code": False}, None
    out = vault(A1)
    check("D4 deux lignes du même compte (base déjà migrée) : un seul choix, le plus récent, rempli d'office",
          out.get("automatic") and page.fills[-1]["motDePasse"] == MDP_A and out.get("handle") == "login_double0", out)

    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))
    ids = [client.post("/api/coffre", headers=web(ALICE), json={"genre": "login", "origine": "https://example.test", "identifiant": who, "mot_de_passe": pwd}).json()["id"]
           for who, pwd in ((ID_A, MDP_A), (ID_B, MDP_B))]
    listed = client.get(f"/api/agents/{A1}/coffre", headers=web(ALICE))
    check("12 deux comptes du même site : chaque ligne montre son identifiant masqué",
          sorted(row["compte"] for row in listed.json()) == ["bo•••", "fr•••"] and ID_A not in listed.text and MDP_A not in listed.text, listed.text)
    r = client.delete(f"/api/agents/{A1}/coffre/{ids[0]}", headers=web(ALICE))
    check("D6 retirer d'un agent : l'identifiant reste au coffre",
          r.status_code == 200 and ids[0] in [e["id"] for e in client.get("/api/coffre", headers=web(ALICE)).json()["elements"]], r.text)
    check("D6 cet agent ne s'en sert plus", ids[0] not in [i["handle"] for i in vault(A1, "list")["items"]]
          and vault(A1, "fill", handle=ids[0])["error_type"] == "unknown_handle"
          and [row["id"] for row in client.get(f"/api/agents/{A1}/coffre", headers=web(ALICE)).json()] == [ids[1]])
    check("D6 les autres agents du propriétaire, si", ids[0] in [i["handle"] for i in vault(A2, "list")["items"]])
    check("D6 retirer deux fois : introuvable", client.delete(f"/api/agents/{A1}/coffre/{ids[0]}", headers=web(ALICE)).status_code == 404)

    bitwarden = ("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n"
                 f",,login,Dropbox,,,0,https://www.dropbox.com,f@e.fr,bw-Pw-secret,{TOTP_KEY}\n")
    for _ in range(2):
        client.post("/api/coffre/import", headers=web(ALICE), json={"csv": bitwarden})
    with db.connect() as c:
        keys = c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ? AND genre = 'totp' AND origine = 'https://www.dropbox.com'", (ALICE,)).fetchone()[0]
        count = c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ?", (ALICE,)).fetchone()[0]
    check("m3 réimporter une clé TOTP ne la double pas", keys == 1, keys)
    saved_max, coffre.MAX_ITEMS = coffre.MAX_ITEMS, count + 1
    try:
        out = client.post("/api/coffre/import", headers=web(ALICE), json={"csv": bitwarden.replace("dropbox", "box").replace("Dropbox", "Box")}).json()
        with db.connect() as c:
            after = c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ?", (ALICE,)).fetchone()[0]
    finally:
        coffre.MAX_ITEMS = saved_max
    check("m3 une clé TOTP importée respecte MAX_ITEMS, avec sa raison", out["ajoutes"] == 1 and after == count + 1
          and [r["ligne"] for r in out["refuses"]] == [2] and "plein" in out["refuses"][0]["raison"], (out, after))
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE user_id = ?", (ALICE,))


test_migration_without_loss()
test_server_picks_the_only_login()
test_two_accounts_ask_which()
test_vault_is_per_person()
test_totp_and_card()
test_settings_screen()
test_reconnect_state()
test_other_profile_turn_never_fills()
test_review_small_fixes()
test_b1_exact_origin_only()
test_review_d_fixes()
test_model_never_sees_a_secret()
print(f"coffre 0.3.0 : {checks} vérifications, tout est vert")
