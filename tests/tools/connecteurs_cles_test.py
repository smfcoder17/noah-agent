"""Connecteurs à clé (GitHub, Airtable, Stripe en lecture, Apify) : une clé collée dans Connexions, et les outils du service chez l'agent autorisé.

Vrais : les routes de Noah, la base et son chiffrement, le relais MCP vu par l'agent, le droit tenu par le relais, le juge et ses règles.
Simulés : le serveur MCP de GitHub (list_tools et _request de mcp.py, avec la vraie liste d'outils annotée readOnlyHint),
la machine de l'agent (machine.admin) et le modèle du juge. Le vrai serveur de GitHub n'est pas joint : aucune clé ici.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/server:/app" -v "$(pwd -W)/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/connecteurs_cles_test.py"
"""
import json
import os
import sys
import tempfile
from pathlib import Path

DATA = Path(tempfile.mkdtemp())
os.environ["NOAH_DATA_DIR"] = str(DATA)
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, connecteurs_cles, db, machine, main, mcp, relay  # noqa: E402

GOOD = "github_pat_11ABCDEFG0123456789_secretpartie"
BAD = "github_pat_mauvais_0123456789"
GITHUB = connecteurs_cles.entry("github")
# Même forme que la liste du vrai serveur (github/github-mcp-server, pkg/github/issues.go : ReadOnlyHint true en lecture, false en écriture). Noms simplifiés.
GH_TOOLS = [
    {"name": "get_me", "description": "Get my user profile", "annotations": {"readOnlyHint": True}},
    {"name": "search_repositories", "description": "Search repositories", "annotations": {"readOnlyHint": True}},
    {"name": "list_issues", "description": "List issues", "annotations": {"readOnlyHint": True}},
    {"name": "create_issue", "description": "Create an issue", "annotations": {"readOnlyHint": False}},
    {"name": "push_files", "description": "Push files", "annotations": {"readOnlyHint": False}},
]

db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
A, A2, B = "agent-alice", "agent-alice-2", "agent-bruno"
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Alma', '', 'k', ?)", (A, ALICE))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Arno', '', 'k', ?)", (A2, ALICE))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, 'Basile', '', 'k', ?)", (B, BRUNO))

# --- La machine de l'agent : on garde tout ce qu'elle reçoit, la clé ne doit jamais y arriver ------------------------------
SENT: list[str] = []


async def fake_admin(agent_id, action, body=None, timeout=90):
    SENT.append(json.dumps([agent_id, action, body], default=str))
    if action == "google":
        return {"disponible": False}
    if action == "applications":
        return {"applications": [], "personnels": {}}
    if action == "outil_poser":
        return {"connecte": True}
    return {"ok": True}


machine.admin = fake_admin

# --- Le serveur MCP de GitHub ----------------------------------------------------------------------------------------------
CALLS: list[tuple] = []


async def fake_list(key, url, token, seconds=mcp.LIST_SECONDS):
    if url != GITHUB.url:
        raise mcp.Down("connexion impossible")
    if token != GOOD:
        raise mcp.AuthNeeded()
    return [dict(t) for t in GH_TOOLS]


async def fake_request(key, url, token, method, params, seconds):
    CALLS.append((url, token, method, params.get("name")))
    # Un service qui répète la clé dans sa réponse : elle ne doit pas arriver à l'agent.
    return {"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": f"fait avec {token}"}]}}


mcp.list_tools = fake_list
mcp._request = fake_request


# Le modèle du juge : répond « je ne sais pas » (ligne 6), comme un modèle prudent.
class Provider:
    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ligne": 6, "motif": "doute", "certitude": 90}'}}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0}})


relay.upstream_client = lambda: Provider()
db.set_setting("provider", "openrouter")
db.set_setting("model", "lab/cerveau")
db.set_setting("api_key", "sk-essai", secret=True)


def client(user: int) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


alice, bruno = client(ALICE), client(BRUNO)
agent = {x: TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for(x)}"}, raise_server_exceptions=False) for x in (A, A2, B)}


def rpc(agent_id: str, name: str, method: str, params: dict | None = None):
    r = agent[agent_id].post(f"/agent-api/mcp/{name}", json={"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}})
    return r


def ok(name):
    print(f"ok  {name}")


# 1. Le catalogue : quatre connecteurs, où créer la clé, jamais de clé -------------------------------------------------------
r = alice.get("/api/connections/cles")
assert r.status_code == 200, r.text
names = [e["nom"] for e in r.json()]
assert names == ["github", "airtable", "stripe-lecture", "apify"], names
assert all(e["lien"].startswith("https://") and e["hote"] for e in r.json())
assert TestClient(main.app).get("/api/connections/cles").status_code == 401, "réservé à une session"
for e in connecteurs_cles.CATALOG:
    mcp.parse(e.url)  # chaque adresse passe les règles des outils par adresse : https, aucun secret dans l'adresse
    assert mcp.NAME.fullmatch(e.nom) and e.nom not in mcp.RESERVED
ok("catalogue : 4 connecteurs officiels, adresses acceptées par le relais, aucune clé")

# 2. Une clé refusée : rien n'est enregistré, rien n'est posé chez l'agent --------------------------------------------------
r = alice.post(f"/api/agents/{A}/connections/cles/github", json={"jeton": BAD})
assert r.status_code == 400 and "refuse ce jeton" in r.json()["detail"], r.text
assert not mcp._row(A, "github") and not any("outil_poser" in s for s in SENT)
assert alice.post(f"/api/agents/{A}/connections/cles/inconnu", json={"jeton": GOOD}).status_code == 404
assert bruno.post(f"/api/agents/{A}/connections/cles/github", json={"jeton": GOOD}).status_code in (403, 404), "l'agent d'un autre"
ok("clé refusée : rien d'enregistré ; connecteur inconnu et agent d'un autre refusés")

# 3. La bonne clé : branchée, scellée, jamais renvoyée --------------------------------------------------------------------
r = alice.post(f"/api/agents/{A}/connections/cles/github", json={"jeton": f"  Bearer {GOOD} "})
assert r.status_code == 200, r.text
assert GOOD not in r.text and r.json()["nom"] == "github"
assert {t["nom"]: t["lecture_seule"] for t in r.json()["outils"]} == {"get_me": True, "search_repositories": True, "list_issues": True, "create_issue": False, "push_files": False}
row = mcp._row(A, "github")
assert row["url"] == GITHUB.url and row["auth"] == "jeton" and row["droit"] == "confirmer"
assert row["jeton"] != GOOD and GOOD not in row["jeton"] and mcp._token(row) == GOOD, "scellé en base, lisible par le serveur seul"
for f in DATA.rglob("*"):
    if f.is_file():
        assert GOOD.encode() not in f.read_bytes(), f"clé en clair dans {f.name}"
posed = [json.loads(s) for s in SENT if '"outil_poser"' in s]
assert posed and posed[-1][2]["config"]["url"].endswith("/agent-api/mcp/github"), "l'agent parle au relais, pas à GitHub"
assert not any(GOOD in s for s in SENT), "la clé n'entre jamais dans la machine de l'agent"
again = alice.post(f"/api/agents/{A}/connections/cles/github", json={"jeton": GOOD})
assert again.status_code == 400 and "déjà" in again.json()["detail"]
ok("bonne clé : testée, scellée en base, absente des fichiers, de la réponse et de la machine de l'agent")

# 4. L'écran Connexions : la ligne GitHub, son logo, « un jeton », jamais la clé --------------------------------------------
r = alice.get(f"/api/agents/{A}/connections?frais=true")
assert r.status_code == 200, r.text
assert GOOD not in r.text
tool = next(t for t in r.json()["outils"] if t["nom"] == "github")
assert tool["jeton"] is True and tool["hote"] == "github.com" and tool["etat"] == "ok" and tool["droit"] == "confirmer"
assert len(tool["outils"]) == 5
ok("Connexions : GitHub branché, logo github.com, jeton signalé sans sa valeur")

# 5. Par agent : l'agent autorisé voit les outils, les autres non ------------------------------------------------------------
listed = rpc(A, "github", "tools/list").json()["result"]["tools"]
assert {t["name"] for t in listed} == {t["name"] for t in GH_TOOLS}, listed
assert rpc(A2, "github", "tools/list").status_code == 404, "l'autre agent d'alice n'a rien tant qu'elle ne l'a pas coché"
assert rpc(B, "github", "tools/list").status_code == 404, "l'agent de bruno n'a rien"
ok("filtrage par agent : outils servis à l'agent autorisé seulement")

# 6. Droit « confirmer » tenu par le relais : la lecture passe, l'écriture attend un accord ---------------------------------
answer = rpc(A, "github", "tools/call", {"name": "get_me", "arguments": {}}).json()
assert not answer["result"].get("isError") and CALLS[-1][2:] == ("tools/call", "get_me")
assert GOOD not in json.dumps(answer) and "[jeton masqué]" in json.dumps(answer, ensure_ascii=False), "la clé répétée par le service est masquée"
before = len(CALLS)
answer = rpc(A, "github", "tools/call", {"name": "create_issue", "arguments": {"owner": "alice", "repo": "site", "title": "Bug"}}).json()
assert answer["result"]["isError"] and "confirmation" in answer["result"]["content"][0]["text"] and len(CALLS) == before, answer
ok("confirmer : get_me passe, create_issue refusé sans accord et jamais envoyé à GitHub")

# 7. Le juge sur une écriture GitHub : une carte d'accord, en Auto comme en Prudent ----------------------------------------
ISSUE = {"owner": "alice", "repo": "site", "title": "Bouton cassé", "body": "Le bouton Envoyer ne répond plus."}
for mode in ("auto", "prudent"):
    db.set_setting("juge_mode", mode)
    verdict = agent[A].post("/agent-api/juge", json={"outil": "mcp__github__create_issue", "args": ISSUE}).json()
    assert verdict["verdict"] == "accord", (mode, verdict)
    read = agent[A].post("/agent-api/juge", json={"outil": "mcp__github__list_issues", "args": {"owner": "alice", "repo": "site"}}).json()
    assert read["verdict"] == "passe", (mode, read)
# La carte que la personne lit : une phrase claire, le titre de l'issue.
card = mcp.plain_request("Outil « github » : create_issue\n" + json.dumps(ISSUE, ensure_ascii=False))
assert card["demande"] == "Ton agent veut créer « Bouton cassé » dans GitHub.", card
assert "Le bouton Envoyer ne répond plus." in card["apercu"], card
# Accord donné : un seul appel, exactement celui montré.
mcp.approval_seen(A, "req-1", "Outil « github » : " + mcp._shown("create_issue", ISSUE))
mcp.approval_answered(A, "req-1", True)
answer = rpc(A, "github", "tools/call", {"name": "create_issue", "arguments": ISSUE}).json()
assert not answer["result"].get("isError") and CALLS[-1][3] == "create_issue", answer
again = rpc(A, "github", "tools/call", {"name": "create_issue", "arguments": ISSUE}).json()
assert again["result"]["isError"], "l'accord ne sert qu'une fois"
ok("juge : create_issue demande l'accord (Auto, Prudent), list_issues passe ; l'accord ouvre un seul appel")

# 8. « Lire seulement » : les outils qui modifient disparaissent, et le juge refuse ----------------------------------------
r = alice.put(f"/api/agents/{A}/connections/tools/github/droit", json={"droit": "lire"})
assert r.status_code == 200, r.text
listed = {t["name"] for t in rpc(A, "github", "tools/list").json()["result"]["tools"]}
assert listed == {"get_me", "search_repositories", "list_issues"}, listed
answer = rpc(A, "github", "tools/call", {"name": "push_files", "arguments": {}}).json()
assert answer["result"]["isError"] and "lecture seule" in answer["result"]["content"][0]["text"]
assert agent[A].post("/agent-api/juge", json={"outil": "mcp__github__push_files", "args": {}}).json()["verdict"] == "refuse"
ok("lire seulement : outils d'écriture cachés, refusés par le relais et par le juge")

# 9. Pour tous mes agents : l'autre agent d'alice reçoit sa ligne, au droit « confirmer », sans jamais voir la clé ----------
r = alice.put(f"/api/agents/{A}/connecteurs/github", json={"pour_tous": True})
assert r.status_code == 200, r.text
copy = mcp._row(A2, "github")
assert copy and copy["droit"] == "confirmer" and mcp._token(copy) == GOOD and copy["jeton"] != GOOD
assert {t["name"] for t in rpc(A2, "github", "tools/list").json()["result"]["tools"]} == {t["name"] for t in GH_TOOLS}
assert not mcp._row(B, "github") and rpc(B, "github", "tools/list").status_code == 404, "jamais l'agent d'un autre profil"
assert not any(GOOD in s for s in SENT)
ok("pour tous mes agents : copie scellée sur ses agents, droit « confirmer », rien chez bruno")

# 10. Retirer : l'agent perd l'accès à la requête suivante ------------------------------------------------------------------
r = alice.post(f"/api/agents/{A2}/connections/tools/github/remove", json={})
assert r.status_code == 200, r.text
assert rpc(A2, "github", "tools/list").status_code == 404
ok("retrait : plus rien servi à l'agent")

# 11. Les autres connecteurs suivent le même chemin --------------------------------------------------------------------------
for e in connecteurs_cles.CATALOG[1:]:
    tool = mcp.NewTool(url=e.url, nom=e.nom, auth="jeton", jeton=GOOD, droit=e.droit)
    assert tool.auth == "jeton" and mcp._clean_token(tool) == GOOD
ok("Airtable, Stripe en lecture, Apify : même déclaration, même clé scellée, même droit")

print("connecteurs à clé : tout passe")
