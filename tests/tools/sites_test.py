"""Sites où l'agent est connecté dans son navigateur : notés par l'agent, visibles et retirables par la personne, rien d'autre.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/sites_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main, relay, sites  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'cle-a1', ?)", (alice,))
client = TestClient(main.app)
agent = {"Authorization": "Bearer " + relay.token_for("a1")}

assert sites.host_of("https://www.LinkedIn.com/feed/?x=1") == "linkedin.com"
for bad in ("localhost", "http://127.0.0.1:8080", "1-2-3-4.sslip.io", "pas un site", "javascript:alert(1)"):
    assert sites.host_of(bad) == "", bad
r = client.post("/agent-api/sites", json={"adresse": "https://www.linkedin.com/feed", "nom": "LinkedIn", "compte": "franck"}, headers=agent)
assert r.status_code == 200 and r.json()["site"] == "linkedin.com", r.text
assert client.post("/agent-api/sites", json={"adresse": "http://localhost:3000"}, headers=agent).status_code == 400
client.post("/agent-api/sites", json={"adresse": "canva.com"}, headers=agent)
client.post("/agent-api/sites", json={"adresse": "linkedin.com", "nom": "LinkedIn"}, headers=agent)  # revoir le site garde le compte

client.cookies.set("noah_session", auth.new_session(alice, "test"))
listed = client.get("/api/agents/a1/sites").json()
assert {s["hote"] for s in listed} == {"linkedin.com", "canva.com"}, listed
assert next(s for s in listed if s["hote"] == "linkedin.com")["compte"] == "franck"
r = client.delete("/api/agents/a1/sites/canva.com", headers={"Origin": "http://testserver"})
assert r.status_code == 200, (r.status_code, r.text)
assert [s["hote"] for s in client.get("/api/agents/a1/sites").json()] == ["linkedin.com"]
client.cookies.set("noah_session", auth.new_session(bruno, "test"))
assert client.get("/api/agents/a1/sites").status_code in (403, 404), "un autre compte ne voit pas ses sites"
assert client.post("/agent-api/sites", json={"adresse": "x.com"}).status_code in (401, 403), "sans jeton d'agent, rien ne s'ajoute"
print("Sites du navigateur : notés par l'agent, adresses locales refusées, visibles et retirables par leur propriétaire seul")

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
