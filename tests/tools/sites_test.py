"""Sites où l'agent est connecté dans son navigateur : un registre vérifié par le serveur, visible et retirable par la personne.

0.3.0 (B5) : « connecté » seulement après un contrôle de la vraie page (sur le site, plus de champ de mot de passe) ; aucune
devinette par les cookies ; « Retirer » tient ; les lignes d'avant restent, marquées non vérifiées.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/sites_test.py"
"""
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main, relay, sites  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'cle-a1', ?)", (alice,))
    # Une base d'avant 0.3.0 : la table sans état, une ligne déclarée par l'agent.
    c.execute("CREATE TABLE sites_connectes (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, hote TEXT NOT NULL, "
              "nom TEXT NOT NULL, compte TEXT NOT NULL DEFAULT '', vu_a REAL NOT NULL, PRIMARY KEY (agent_id, hote))")
    c.execute("INSERT INTO sites_connectes VALUES ('a1', 'ancien.fr', 'Ancien', '', ?)", (time.time() - 10,))
client = TestClient(main.app)
agent = {"Authorization": "Bearer " + relay.token_for("a1")}

PAGE = {"origine": "https://www.linkedin.com", "champs": {"identifiant": False, "motDePasse": False, "code": False}}
asked = []


async def browser(agent_id, method, path, **kw):
    asked.append(path)
    if path == "/noah/page":
        return {"ok": True, "onglet": "t1", **PAGE}
    # storage_state : des cookies durables de sites seulement lus. 0.3.0 : on ne doit plus jamais les lire.
    return {"cookies": [{"domain": ".lu-seulement.fr", "expires": time.time() + 400 * 86400}, {"domain": ".canva.com", "expires": -1}]}

hermes.browser_call = browser

assert sites.host_of("https://www.LinkedIn.com/feed/?x=1") == "linkedin.com"
for bad in ("localhost", "http://127.0.0.1:8080", "1-2-3-4.sslip.io", "pas un site", "javascript:alert(1)"):
    assert sites.host_of(bad) == "", bad
r = client.post("/agent-api/sites", json={"adresse": "https://www.linkedin.com/feed", "nom": "LinkedIn", "compte": "franck"}, headers=agent)
assert r.status_code == 200 and r.json()["site"] == "linkedin.com", r.text
assert client.post("/agent-api/sites", json={"adresse": "http://localhost:3000"}, headers=agent).status_code == 400
r = client.post("/agent-api/sites", json={"adresse": "canva.com"}, headers=agent)
assert r.status_code == 409 and "pas sur ce site" in r.text, "la page ouverte est sur LinkedIn : canva.com n'est pas noté"
PAGE["origine"], PAGE["champs"] = "https://www.canva.com/login", {"identifiant": True, "motDePasse": True, "code": False}
r = client.post("/agent-api/sites", json={"adresse": "canva.com"}, headers=agent)
assert r.status_code == 409 and "mot de passe" in r.text, "page de connexion encore affichée : pas connecté"
PAGE["champs"] = {"identifiant": False, "motDePasse": False, "code": False}
assert client.post("/agent-api/sites", json={"adresse": "canva.com"}, headers=agent).status_code == 200
PAGE["origine"] = "https://www.linkedin.com"
client.post("/agent-api/sites", json={"adresse": "linkedin.com"}, headers=agent)  # revoir le site garde le compte et le nom

client.cookies.set("noah_session", auth.new_session(alice, "test"))
asked.clear()
listed = client.get("/api/agents/a1/sites").json()
# Relecture 0.3.0, partie 5 n°4 : sur la seule parole de l'agent, une page sans mot de passe ne prouve pas une session.
assert {s["hote"]: s["etat"] for s in listed} == {"linkedin.com": "non_verifie", "canva.com": "non_verifie", "ancien.fr": "non_verifie"}, listed
assert "lu-seulement.fr" not in str(listed) and not asked, "un site seulement lu n'apparaît pas : la liste ne lit plus les cookies"
assert next(s for s in listed if s["hote"] == "linkedin.com")["compte"] == "franck"
assert next(s for s in listed if s["hote"] == "linkedin.com")["nom"] == "LinkedIn"
r = client.delete("/api/agents/a1/sites/canva.com", headers={"Origin": "http://testserver"})
assert r.status_code == 200, (r.status_code, r.text)
assert [s["hote"] for s in client.get("/api/agents/a1/sites").json()] == ["linkedin.com", "ancien.fr"]
assert "canva.com" not in str(client.get("/api/agents/a1/sites").json()), "« Retirer » tient après rechargement, même avec un cookie de session"
client.cookies.set("noah_session", auth.new_session(bruno, "test"))
assert client.get("/api/agents/a1/sites").status_code in (403, 404), "un autre compte ne voit pas ses sites"
assert client.post("/agent-api/sites", json={"adresse": "x.com"}).status_code in (401, 403), "sans jeton d'agent, rien ne s'ajoute"
print("Sites du navigateur : vérifiés par le serveur, sans cookies, « Retirer » tient, anciennes lignes non vérifiées, visibles par leur propriétaire seul")

# Partie 5 n°4 : « connecté » seulement quand le serveur a lui-même envoyé le formulaire (coffre) ; l'agent ne le rétrograde pas.
import asyncio as _a  # noqa: E402
hermes.browser_call = browser
PAGE["origine"], PAGE["champs"] = "https://www.notion.so", {"identifiant": False, "motDePasse": False, "code": False}
r = client.post("/agent-api/sites", json={"adresse": "notion.so"}, headers=agent)
assert r.status_code == 200 and r.json()["etat"] == "non_verifie", r.text
assert _a.run(sites.verify("a1", "https://www.notion.so", proven=True)) == "" and sites._state("a1", "notion.so") == "connecte"
assert client.post("/agent-api/sites", json={"adresse": "notion.so"}, headers=agent).json()["etat"] == "connecte", "une session prouvée le reste"
# Partie 5 n°7 : une page de connexion sur accounts.google.com ne met pas mail.google.com « à reconnecter » ; il devient non vérifié.
for h in ("accounts.google.com", "mail.google.com"):
    sites.note("a1", h)
sites.needs_sign_in("a1", "https://accounts.google.com/signin")
states = {s["hote"]: s["etat"] for s in sites.listed("a1")}
assert states["accounts.google.com"] == "a_reconnecter" and states["mail.google.com"] == "non_verifie", states
print("P5n4 et n7 : connecté seulement sur preuve du serveur ; une page de connexion ne touche que son hôte, les autres deviennent non vérifiés")

# Instagram branché par l'agent : Noah lit le jeton dans la page Meta (extension du navigateur), l'agent n'envoie rien.
import asyncio  # noqa: E402

from noah import hermes, mcp, public, publication  # noqa: E402

asked_page, checked, plugged = [], [], []


async def fake_browser(agent_id, method, path, **kw):
    asked_page.append((path, kw.get("json")))
    return {"ok": True, "origine": "https://developers.facebook.com", "jetons": ["IGfaux1", "IGbon2"]}


async def fake_check(token):
    checked.append(token)
    if token != "IGbon2":
        raise publication.TokenRefused()
    return {"compte": "smfcoder", "jeton": token}


async def fake_plug(agent_id, name, creds):
    plugged.append((agent_id, name, creds["compte"]))

hermes.browser_call, publication.instagram_check, mcp._plug = fake_browser, fake_check, fake_plug
public.main_url = lambda: "https://noah.exemple.com"
r = client.post("/agent-api/publication/instagram", json={"jeton": "IGvole"}, headers=agent)
assert r.status_code == 200 and r.json().get("connecte") and r.json()["compte"] == "smfcoder", r.text
assert asked_page[0][0] == "/noah/jeton" and asked_page[0][1]["plateforme"] == "instagram", asked_page
assert "IGvole" not in checked, "un jeton envoyé par l'agent n'est jamais utilisé"
assert checked == ["IGfaux1", "IGbon2"] and plugged == [("a1", "instagram", "smfcoder")]
assert "IGbon2" not in r.text, "le jeton ne revient pas à l'agent"


async def wrong_page(agent_id, method, path, **kw):
    return {"error": "La page ouverte n'est pas celle de la plateforme.", "http_status": 409}

hermes.browser_call = wrong_page
r = client.post("/agent-api/publication/instagram", headers=agent)
assert "erreur" in r.json() and "Meta" in r.json()["erreur"], r.text
print("Instagram par l'agent : le jeton est lu par Noah dans la page Meta, essayé, branché ; il ne passe jamais par l'agent")
