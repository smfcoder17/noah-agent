"""Connecteurs globaux et compétences : une connexion pour tous mes agents, sauf ceux qu'on décoche ; ce que la personne enseigne à son agent.

Vrais : les routes de Noah, la base, le relais vers un vrai serveur MCP en HTTP, launcher/agent_admin.py (une machine par agent, un dossier par agent).
Simulés : Hermes (ses modules hermes_cli et tools, remplacés par un stub qui écrit les mêmes fichiers), le fournisseur OAuth, Google.
Le vrai skill_manage d'Hermes s'essaie à part, sur l'image de l'agent : voir tests/tools/competences_hermes_check.sh.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/launcher:/l" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/tools/connecteurs_test.py"
"""
import asyncio
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

DATA = Path(tempfile.mkdtemp())
os.environ["NOAH_DATA_DIR"] = str(DATA)
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
sys.path.insert(0, "/tests/tools")

from fastapi.testclient import TestClient  # noqa: E402
from mcp_server import Server  # noqa: E402

from noah import access, accounts, auth, connecteurs, db, machine, main, mcp, profiles, publication, relay  # noqa: E402

JETON = "jeton-tres-secret-0123456789"
own_ip = socket.gethostbyname(socket.gethostname())
mcp.internal_networks = lambda: [ipaddress.ip_network("10.99.0.0/16")]
mcp.HEALTH_EVERY = 0
own_net = str(ipaddress.ip_network(f"{own_ip}/16", strict=False))

db.init()
ALICE = auth.create_user("alice", "motdepasse-a")  # propriétaire de l'installation
BRUNO = auth.create_user("bruno", "motdepasse-b")  # un autre compte, avec son agent
ADA = auth.create_user("ada", "motdepasse-d")
UMA = auth.create_user("uma", "motdepasse-u")
ALMA, BASILE, CLEO, DOT, ENZO, ZED = "alma-1", "basile-1", "cleo-1", "dot-1", "enzo-1", "zed-1"


def new_agent(agent_id: str, name: str, owner: int) -> None:
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent_id, name, owner))


for agent_id, name in ((ALMA, "Alma"), (BASILE, "Basile"), (CLEO, "Cléo"), (DOT, "Dot"), (ENZO, "Enzo")):
    new_agent(agent_id, name, ALICE)
new_agent(ZED, "Zed", BRUNO)
with db.connect() as c:
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (DOT, ADA))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'usage')", (ENZO, UMA))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (ALMA, ADA))
    # Dot et Alma sont partagés en admin à ada ; Alma est l'origine de ce qui suit.


def client(user: int) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


alice, bruno, ada, uma = client(ALICE), client(BRUNO), client(ADA), client(UMA)


def relay_of(agent_id: str) -> TestClient:
    return TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for(agent_id)}"}, raise_server_exceptions=False)


# --- Hermes simulé : le vrai agent_admin.py, une machine (un dossier) par agent ----------------------------------------
STUB = Path(tempfile.mkdtemp())
(STUB / "hermes_cli").mkdir()
(STUB / "tools").mkdir()
(STUB / "hermes_cli/__init__.py").write_text("")
(STUB / "tools/__init__.py").write_text("")
(STUB / "hermes_cli/mcp_config.py").write_text("""
import json, os, pathlib
F = pathlib.Path(os.environ["NOAH_TEST_HOME"]) / "config.json"
def _get_mcp_servers():
    return json.loads(F.read_text()) if F.exists() else {}
def _save_mcp_server(name, cfg):
    s = _get_mcp_servers(); s[name] = cfg; F.write_text(json.dumps(s)); return True
def _remove_mcp_server(name):
    s = _get_mcp_servers(); s.pop(name, None); F.write_text(json.dumps(s)); return True
def _probe_single_server(name, cfg):
    return []
""")
(STUB / "hermes_cli/mcp_catalog.py").write_text("""
from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server, _remove_mcp_server
NAMES = ("notion", "meteo")
class Auth:
    def __init__(self, type): self.type, self.env = type, None
class E:
    description = "Une application"; source = "officiel"; suggest = None
    def __init__(self, name, kind): self.name, self.auth = name, Auth(kind)
CATALOG = [E("notion", "oauth"), E("meteo", "aucune")]
def installed_servers(): return {k: v for k, v in _get_mcp_servers().items() if k in NAMES}
def list_catalog(): return CATALOG
def get_entry(name): return next((e for e in CATALOG if e.name == name), None)
def card_install_config(e): return {"url": f"https://{e.name}.example/mcp", **({"auth": "oauth"} if e.auth.type == "oauth" else {})}
def uninstall_entry(name): _remove_mcp_server(name)
""")
(STUB / "tools/mcp_oauth.py").write_text("""
import os, pathlib
class HermesTokenStorage:
    def __init__(self, name): self.f = pathlib.Path(os.environ["NOAH_TEST_HOME"]) / "mcp-tokens" / f"{name}.json"
    def has_cached_tokens(self): return self.f.exists()
    def remove(self): self.f.unlink(missing_ok=True)
""")
(STUB / "tools/skill_manager_tool.py").write_text("""
import json, os, pathlib, shutil
def _skills_dir(): return pathlib.Path(os.environ["NOAH_TEST_HOME"]) / "skills"
def _find(name): return next((d for d in _skills_dir().glob(f"*/{name}") if (d / "SKILL.md").exists()), None)
def skill_manage(action, name, content=None, category=None, **_):
    if action == "create":
        if _find(name): return json.dumps({"success": False, "error": f"A skill named '{name}' already exists at x."})
        d = _skills_dir() / category / name; d.mkdir(parents=True); (d / "SKILL.md").write_text(content, encoding="utf-8")
    elif action == "edit":
        (_find(name) / "SKILL.md").write_text(content, encoding="utf-8")
    elif action == "delete":
        shutil.rmtree(_find(name))
    return json.dumps({"success": True})
""")
(STUB / "tools/skill_usage.py").write_text("def set_pinned(name, pinned): return True\n")
ADMIN_SOURCE = Path("/l/agent_admin.py").read_text(encoding="utf-8")
HOMES = Path(tempfile.mkdtemp())
LOGIN = "https://fournisseur.example/autoriser?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback"
down: set[str] = set()  # les machines arrêtées


def home(agent_id: str) -> Path:
    d = HOMES / agent_id
    d.mkdir(exist_ok=True)
    return d


async def real_admin(agent_id: str, action: str, body: dict | None = None, timeout: float = 90) -> dict:
    if agent_id in down:
        raise machine.HTTPException(502, "L'agent ne répond pas")
    source = ADMIN_SOURCE.replace('sys.path.insert(0, "/opt/hermes")', f'sys.path.insert(0, {str(STUB)!r})', 1)
    source = source.replace('DATA = Path("/opt/data")', 'DATA = Path(os.environ["NOAH_TEST_HOME"])', 1)
    source = source.replace('def _start_login(name, retour=""):', f"def _start_login(name, retour=''):\n    return {{'adresse': {LOGIN!r}}}\n\n\ndef _unused(name):", 1)
    r = subprocess.run([sys.executable, "-c", source, action, json.dumps(body or {}, ensure_ascii=False)], capture_output=True, text=True,
                       env={**os.environ, "NOAH_TEST_HOME": str(home(agent_id))})
    out = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
    if r.returncode:
        raise machine.HTTPException(400, out.get("erreur") or r.stderr[-300:])
    return out


machine.admin = real_admin
accounts.admin = real_admin


async def nothing(*_a, **_k):
    return None


profiles._h["stop_runs"] = nothing
profiles._h["forget_guest"] = nothing


def config(agent_id: str) -> dict:
    f = home(agent_id) / "config.json"
    return json.loads(f.read_text()) if f.exists() else {}


def everything_in(agent_id: str) -> str:
    return "\n".join(p.read_text(errors="replace") for p in home(agent_id).rglob("*") if p.is_file())


def rpc(agent_id: str, name: str, method: str, params: dict | None = None):
    return relay_of(agent_id).post(f"/agent-api/mcp/{name}", json={"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}})


def scope_url(agent_id: str, nom: str) -> str:
    return f"/api/agents/{agent_id}/connecteurs/{nom}"


def agents_of(view: dict) -> dict:
    return {a["id"]: a for a in view["agents"]}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# --- 1. Un jeton fixe : il reste sur le serveur, chaque agent passe par le relais, avec son droit -------------------------
fiches = Server(token=JETON).start()
FICHES = f"http://{own_ip}:{fiches.port}/mcp"
assert alice.put("/api/mcp/reseaux", json={"reseaux": [own_net]}).status_code == 200
TOOLS = f"/api/agents/{ALMA}/connections/tools"
r = alice.post(TOOLS, json={"url": FICHES, "nom": "fiches", "auth": "jeton", "jeton": JETON, "droit": "agir"})
assert r.status_code == 200, r.text

r = alice.get(scope_url(ALMA, "fiches"))
assert r.status_code == 200, r.text
preview = r.json()
assert preview["pour_tous"] is False and preview["genre"] == "jeton", preview
ticked = agents_of(preview)
assert ZED not in ticked, "l'agent d'un autre compte n'est pas proposé"
assert ticked[ALMA]["coche"] and ticked[BASILE]["coche"] and ticked[ENZO]["coche"], preview
assert not ticked[DOT]["coche"] and ticked[DOT]["invites"] == ["ada"], "partagé en admin : pas coché d'office, et la personne le sait"
assert JETON not in r.text
assert mcp._row(BASILE, "fiches") is None, "regarder ne pose rien"

# Les droits et les comptes : seul le propriétaire de l'agent décide.
assert ada.get(scope_url(ALMA, "fiches")).status_code == 403, "un admin invité ne lit pas la portée"
assert ada.put(scope_url(ALMA, "fiches"), json={"pour_tous": True}).status_code == 403, "un admin invité ne rend pas global le compte d'un autre"
assert uma.put(scope_url(ENZO, "fiches"), json={"pour_tous": True}).status_code == 403
assert bruno.get(scope_url(ALMA, "fiches")).status_code == 404, "un autre compte : on ne confirme même pas que l'agent existe"
assert bruno.put(scope_url(ALMA, "fiches"), json={"pour_tous": True}).status_code == 404
assert alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True, "agents": [ALMA, ZED]}).status_code == 404, "alice ne vise pas l'agent de bruno"
assert connecteurs._get(ALICE, "fiches") is None, "un refus ne laisse rien derrière lui"
assert alice.put(scope_url(ZED, "fiches"), json={"pour_tous": True}).status_code == 404
assert alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True, "agents": []}).status_code == 400, "aucun agent coché"

r = alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True})
assert r.status_code == 200 and r.json()["pour_tous"] is True and not r.json()["soucis"], r.text
assert JETON not in r.text
for agent_id in (BASILE, CLEO, ENZO):
    row = mcp._row(agent_id, "fiches")
    assert row, agent_id
    assert row["droit"] == "confirmer", "le droit de l'origine ne se copie pas"
    assert JETON not in row["jeton"], "scellé en base"
    assert config(agent_id)["fiches"]["url"].startswith(mcp.AGENT_URL), "la machine parle à Noah, pas au serveur"
    assert JETON not in everything_in(agent_id), "le jeton n'entre pas dans la machine"
assert mcp._row(ALMA, "fiches")["droit"] == "agir", "l'origine garde son droit"
assert mcp._row(DOT, "fiches") is None and "fiches" not in config(DOT), "partagé en admin, non coché : rien"
assert rpc(DOT, "fiches", "tools/list").status_code == 404
assert mcp._row(ZED, "fiches") is None, "l'agent d'un autre compte ne reçoit rien"
print("jeton : tous sauf le partage admin, jeton resté sur le serveur, droit par agent")

# Chacun s'en sert, et le droit vaut par agent.
assert "lire_fiche" in rpc(BASILE, "fiches", "tools/list").text
answer = rpc(BASILE, "fiches", "tools/call", {"name": "creer_fiche", "arguments": {"titre": "x"}}).json()["result"]
assert answer["isError"] and "confirmation" in answer["content"][0]["text"], answer
assert not [c for c in fiches.calls if c[0] == "creer_fiche"], "rien n'est parti sans le droit"
assert alice.put(f"/api/agents/{BASILE}/connections/tools/fiches/droit", json={"droit": "agir"}).status_code == 200
assert not rpc(BASILE, "fiches", "tools/call", {"name": "creer_fiche", "arguments": {"titre": "x"}}).json()["result"].get("isError")
assert [c for c in fiches.calls if c[0] == "creer_fiche" and JETON in str(c[2])], "le serveur a reçu le jeton, par le relais"
assert mcp._row(CLEO, "fiches")["droit"] == "confirmer", "changer le droit d'un agent ne change pas les autres"
print("droit : tenu par agent, au relais")

# L'onglet Connexions de l'agent le sait.
c_state = run(machine._read_connections_once(BASILE, 0))
assert [g for g in c_state["globaux"] if g["nom"] == "fiches" and g["connecte"]], c_state["globaux"]
assert not run(machine._read_connections_once(DOT, 0))["globaux"], "un agent non visé ne voit pas le connecteur"

# Un agent neuf le reçoit.
FLO = "flo-1"
new_agent(FLO, "Flo", ALICE)
run(connecteurs.sync_agent(FLO))
assert mcp._row(FLO, "fiches") and mcp._row(FLO, "fiches")["droit"] == "confirmer", "un agent neuf reçoit les connecteurs globaux"
assert config(FLO)["fiches"]["url"].startswith(mcp.AGENT_URL)
assert "lire_fiche" in rpc(FLO, "fiches", "tools/list").text
print("agent neuf : reçu au démarrage")

# Exclure retire vraiment : le relais ne répond plus, la machine ne l'a plus, et il ne revient pas.
every = [a["id"] for a in agents_of(alice.get(scope_url(ALMA, "fiches")).json()).values() if a["coche"]]
r = alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True, "agents": [a for a in every if a != CLEO]})
assert r.status_code == 200 and not agents_of(r.json())[CLEO]["coche"], r.text
assert mcp._row(CLEO, "fiches") is None and "fiches" not in config(CLEO)
assert rpc(CLEO, "fiches", "tools/list").status_code == 404, "exclu : plus aucun accès, à la requête suivante"
run(connecteurs.sync_agent(CLEO))
assert mcp._row(CLEO, "fiches") is None, "un agent exclu ne reçoit rien à son démarrage"
assert mcp._row(BASILE, "fiches"), "les autres gardent le leur"
print("exclusion : l'accès part vraiment, et il ne revient pas")

# Machine arrêtée au moment d'exclure : le relais coupe tout de suite, la machine rattrape à son redémarrage.
down.add(ENZO)
every = [a["id"] for a in agents_of(alice.get(scope_url(ALMA, "fiches")).json()).values() if a["coche"]]
r = alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True, "agents": [a for a in every if a != ENZO]})
assert r.status_code == 200 and ENZO in r.json()["soucis"], r.text
assert rpc(ENZO, "fiches", "tools/list").status_code == 404
assert "fiches" in config(ENZO)
down.discard(ENZO)
run(connecteurs.sync_agent(ENZO))
assert "fiches" not in config(ENZO), "la machine redémarrée perd ce qui lui a été retiré"
assert not connecteurs._owed(ENZO)
print("machine arrêtée : relais coupé, machine rattrapée")

# Cocher le partage admin, exprès.
every = [a["id"] for a in agents_of(alice.get(scope_url(ALMA, "fiches")).json()).values() if a["coche"]]
assert alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True, "agents": [*every, DOT]}).status_code == 200
assert mcp._row(DOT, "fiches"), "coché exprès : il l'a"
assert agents_of(alice.get(scope_url(ALMA, "fiches")).json())[DOT]["coche"]
every_without = [a for a in [*every, DOT] if a != DOT]
assert alice.put(scope_url(ALMA, "fiches"), json={"pour_tous": True, "agents": every_without}).status_code == 200
assert mcp._row(DOT, "fiches") is None
# Un partage admin qui arrive après coup : l'agent perd ce qui n'a pas été coché pour lui, et le retrouve quand le partage s'en va.
r = alice.put(f"/api/agents/{BASILE}/shares", json={"utilisateur": "ada", "droit": "admin", "compris": True})
assert r.status_code == 200, r.text
assert mcp._row(BASILE, "fiches") is None, "partage admin après coup : retiré, pas hérité en silence"
assert rpc(BASILE, "fiches", "tools/list").status_code == 404
r = alice.delete(f"/api/agents/{BASILE}/shares/{ADA}")
assert r.status_code == 200, r.text
assert mcp._row(BASILE, "fiches"), "partage parti : il revient"
assert mcp._row(BASILE, "fiches")["droit"] == "confirmer"
# Le droit « usage » garde son profil à part : le connecteur reste sur l'agent, jamais dans ce profil (agent_admin.guest_prepare enlève mcp_servers).
assert "cfg.pop(\"mcp_servers\", None)" in ADMIN_SOURCE
print("invités : admin seulement si coché, usage toujours à part")

# Retirer depuis l'agent : il sort du connecteur. Retirer l'origine : un autre prend sa place, et un agent neuf reçoit encore le jeton.
assert alice.post(f"/api/agents/{FLO}/connections/tools/fiches/remove", json={}).status_code == 200
assert FLO in connecteurs._get(ALICE, "fiches")["exclus"]
run(connecteurs.sync_agent(FLO))
assert mcp._row(FLO, "fiches") is None, "retiré à la main : il ne revient pas"
assert alice.post(f"/api/agents/{ALMA}/connections/tools/fiches/remove", json={}).status_code == 200
row = connecteurs._get(ALICE, "fiches")
assert row and row["source"] != ALMA and mcp._row(row["source"], "fiches"), row
GIL = "gil-1"
new_agent(GIL, "Gil", ALICE)
run(connecteurs.sync_agent(GIL))
assert mcp._row(GIL, "fiches") and mcp._token(mcp._row(GIL, "fiches")) == JETON, "le jeton survit à l'agent d'origine"
print("retrait depuis l'agent : il sort, les autres gardent, l'origine se transmet")

# « Pour cet agent » : les copies partent, l'origine et ce qu'un agent avait de lui-même restent.
libre = Server(session=False).start()
LIBRE = f"http://{own_ip}:{libre.port}/mcp"
assert alice.post(f"/api/agents/{BASILE}/connections/tools", json={"url": LIBRE, "nom": "libre", "droit": "lire"}).status_code == 200
assert alice.post(TOOLS, json={"url": LIBRE, "nom": "libre", "droit": "agir"}).status_code == 200
assert alice.put(scope_url(ALMA, "libre"), json={"pour_tous": True}).status_code == 200
assert mcp._row(BASILE, "libre")["droit"] == "lire", "ce que l'agent avait déjà n'est pas écrasé"
assert mcp._row(CLEO, "libre")
assert alice.put(scope_url(ALMA, "libre"), json={"pour_tous": False}).status_code == 200
assert connecteurs._get(ALICE, "libre") is None
assert mcp._row(CLEO, "libre") is None and "libre" not in config(CLEO), "la copie part"
assert mcp._row(ALMA, "libre") and mcp._row(BASILE, "libre"), "l'origine et la connexion d'avant restent"
print("pour cet agent : retour en arrière propre")


# --- 2. OAuth : le jeton tourne ou peut tourner, jamais copié. Une connexion par agent, en un clic --------------------------
def token_file(agent_id: str, nom: str) -> Path:
    return home(agent_id) / "mcp-tokens" / f"{nom}.json"


def accepted(agent_id: str, nom: str, value: str) -> None:
    """Le fournisseur a répondu : Hermes écrit son jeton dans cette machine."""
    token_file(agent_id, nom).parent.mkdir(exist_ok=True)
    token_file(agent_id, nom).write_text(json.dumps({"refresh_token": value}))


r = alice.post(f"/api/agents/{ALMA}/connections/apps/notion/connect", json={})
assert r.status_code == 200 and r.json().get("adresse") == LOGIN, r.text
accepted(ALMA, "notion", "tourne-alma")
before = token_file(ALMA, "notion").read_bytes()
r = alice.put(scope_url(ALMA, "notion"), json={"pour_tous": True})
assert r.status_code == 200 and r.json()["genre"] == "appli" and not r.json()["soucis"], r.text
view = agents_of(r.json())
assert view[ALMA]["etat"] == "ok" and view[BASILE]["etat"] == "a_connecter", view
assert not token_file(BASILE, "notion").exists() and "notion" not in config(BASILE), "un OAuth ne se copie pas"
assert token_file(ALMA, "notion").read_bytes() == before, "le jeton d'origine reste intact"
assert [g for g in run(machine._read_connections_once(BASILE, 0))["globaux"] if g["nom"] == "notion" and not g["connecte"]], "l'agent montre qu'il attend son clic"

r = alice.post(f"/api/agents/{BASILE}/connecteurs/notion/connecter", json={})
assert r.status_code == 200 and r.json().get("adresse") == LOGIN, "un clic : l'accord du fournisseur s'ouvre pour cet agent"
assert "notion" in config(BASILE)
assert bruno.post(f"/api/agents/{ZED}/connecteurs/notion/connecter", json={}).status_code == 404, "le connecteur d'alice ne vise pas l'agent de bruno"
assert bruno.post(f"/api/agents/{BASILE}/connecteurs/notion/connecter", json={}).status_code == 404
assert ada.post(f"/api/agents/{ALMA}/connecteurs/notion/connecter", json={}).status_code == 403
accepted(BASILE, "notion", "tourne-basile")
assert agents_of(alice.get(scope_url(ALMA, "notion")).json())[BASILE]["etat"] == "ok"
assert alice.put(f"/api/agents/{BASILE}/connections/tools/notion/droit", json={"droit": "lire"}).status_code == 200, "le droit reste réglable par agent"
assert mcp._row(ALMA, "notion") is None or mcp._row(ALMA, "notion")["droit"] != "lire"

every = [a["id"] for a in alice.get(scope_url(ALMA, "notion")).json()["agents"] if a["coche"]]
assert alice.put(scope_url(ALMA, "notion"), json={"pour_tous": True, "agents": [a for a in every if a != BASILE]}).status_code == 200
assert not token_file(BASILE, "notion").exists() and "notion" not in config(BASILE), "exclu : le jeton et la configuration quittent sa machine"
assert token_file(ALMA, "notion").read_bytes() == before, "l'origine garde le sien"
assert alice.post(f"/api/agents/{BASILE}/connecteurs/notion/connecter", json={}).status_code == 404, "exclu : pas de clic possible"
# L'agent neuf attend son clic, sans rien recevoir.
run(connecteurs.sync_agent(GIL))
assert not token_file(GIL, "notion").exists() and "notion" not in config(GIL)
assert agents_of(alice.get(scope_url(ALMA, "notion")).json())[GIL]["etat"] == "a_connecter"
# Une application sans compte se pose seule.
assert alice.post(f"/api/agents/{ALMA}/connections/apps/meteo/connect", json={}).status_code == 200
assert alice.put(scope_url(ALMA, "meteo"), json={"pour_tous": True}).json()["genre"] == "appli_libre"
assert "meteo" in config(CLEO) and agents_of(alice.get(scope_url(ALMA, "meteo")).json())[CLEO]["etat"] == "ok"
print("OAuth : jamais copié, un clic par agent, retrait réel")

# X fait tourner sa clé : la voie du clic, avec la même application. Instagram : un jeton sur le serveur, comme un jeton fixe.
with db.connect() as c:
    c.execute("INSERT INTO mcp_tools (agent_id, nom, url, auth, jeton, droit, outils, etat, vu_a) VALUES (?, 'x', ?, 'jeton', ?, 'confirmer', '[]', 'ok', 1)",
              (ALMA, publication.tool_url(publication.X), db.seal(json.dumps({"client": "client-id-de-x", "renouvellement": "unique", "jeton": JETON}))))
    c.execute("INSERT INTO mcp_tools (agent_id, nom, url, auth, jeton, droit, outils, etat, vu_a) VALUES (?, 'instagram', ?, 'jeton', ?, 'agir', '[]', 'ok', 1)",
              (ALMA, publication.tool_url(publication.INSTAGRAM), db.seal(json.dumps({"jeton": JETON, "compte": "alice"}))))
assert alice.put(scope_url(ALMA, "x"), json={"pour_tous": True}).json()["genre"] == "x"
assert mcp._row(CLEO, "x") is None, "la clé de X ne se copie pas"
mcp.connexion.callback_url = lambda request: "https://noah.example/retour"
r = alice.post(f"/api/agents/{CLEO}/connecteurs/x/connecter", json={})
assert r.status_code == 200 and "client-id-de-x" in r.json()["adresse"], r.text
assert alice.put(scope_url(ALMA, "instagram"), json={"pour_tous": True}).json()["genre"] == "jeton"
assert mcp._row(CLEO, "instagram") and mcp._row(CLEO, "instagram")["droit"] == "confirmer"
print("X par agent, Instagram par le serveur")


# --- 3. Google : ses jetons ne tournent pas, la copie est sûre. Un seul agent refait l'accord ----------------------------------
CLIENT = {"installed": {"client_id": "1-a.apps.googleusercontent.com", "client_secret": "sec"}}
GTOKEN = {"refresh_token": "refresh-google-secret", "token": "acces", "expiry": "2030-01-01T00:00:00Z"}
db.set_setting("google_client", json.dumps({"client_id": "1-a.apps.googleusercontent.com", "client_secret": "sec"}))
run(real_admin(ALMA, "google_installer", {"client": CLIENT, "token": GTOKEN}))
db.set_setting(f"google_{ALMA}", json.dumps({"compte": "alice@exemple.fr", "permissions": ["gmail_lire"], "depuis": 1}))
r = alice.get(scope_url(ALMA, "google"))
assert r.status_code == 200 and r.json()["genre"] == "google", r.text
assert not agents_of(r.json())[DOT]["coche"]
r = alice.put(scope_url(ALMA, "google"), json={"pour_tous": True})
assert r.status_code == 200 and not r.json()["soucis"], r.text
assert "refresh-google-secret" not in r.text, "le jeton ne passe jamais par l'écran"
assert json.loads((home(BASILE) / "google_token.json").read_text())["refresh_token"] == "refresh-google-secret"
assert accounts._account(BASILE)["compte"] == "alice@exemple.fr"
assert not (home(DOT) / "google_token.json").exists() and not accounts._account(DOT), "partagé en admin, non coché : pas de Google"
assert connecteurs.google_copy(BASILE) and not connecteurs.google_copy(ALMA), "seule l'origine refait l'accord de 7 jours"
assert "refresh-google-secret" not in (Path(os.environ["NOAH_DATA_DIR"]) / "noah.db").read_bytes().decode(errors="replace") if (Path(os.environ["NOAH_DATA_DIR"]) / "noah.db").exists() else True
GTOKEN2 = {**GTOKEN, "refresh_token": "refresh-google-neuf"}
run(real_admin(ALMA, "google_installer", {"client": CLIENT, "token": GTOKEN2}))
run(connecteurs.google_renewed(ALMA))
assert json.loads((home(BASILE) / "google_token.json").read_text())["refresh_token"] == "refresh-google-neuf", "le renouvellement suit"
every = [a["id"] for a in alice.get(scope_url(ALMA, "google")).json()["agents"] if a["coche"]]
assert alice.put(scope_url(ALMA, "google"), json={"pour_tous": True, "agents": [a for a in every if a != BASILE]}).status_code == 200
assert not (home(BASILE) / "google_token.json").exists() and not accounts._account(BASILE), "exclu : le jeton quitte sa machine"
assert (home(CLEO) / "google_token.json").exists()
# L'origine décochée : une copie prend sa place, sinon rien ne bouge.
every = [a["id"] for a in alice.get(scope_url(ALMA, "google")).json()["agents"] if a["coche"]]
assert alice.put(scope_url(ALMA, "google"), json={"pour_tous": True, "agents": [a for a in every if a != ALMA]}).status_code == 200
row = connecteurs._get(ALICE, "google")
assert row["source"] != ALMA and accounts._account(row["source"]) and not connecteurs.google_copy(row["source"]), row
assert not (home(ALMA) / "google_token.json").exists()
# Sur l'agent d'un autre compte, Google passe par les identifiants du propriétaire : pas de global.
db.set_setting(f"google_{ZED}", json.dumps({"compte": "b@exemple.fr", "permissions": [], "depuis": 1}))
assert bruno.put(scope_url(ZED, "google"), json={"pour_tous": True}).status_code == 403
print("Google : copie sûre, retrait réel, une seule origine")

# --- 3 bis. Plusieurs comptes Google sur un agent : chacun dans son dossier, le premier reste à sa place -------------------
import base64 as _b64  # noqa: E402
import httpx  # noqa: E402


def id_token(email):
    return "x." + _b64.urlsafe_b64encode(json.dumps({"email": email}).encode()).decode().rstrip("=") + ".y"


class GoogleToken:
    def __init__(self, email, refresh):
        self.email, self.refresh = email, refresh

    async def post(self, *_a, **_k):
        return httpx.Response(200, json={"access_token": "acces", "refresh_token": self.refresh, "expires_in": 3600,
                                         "scope": "openid email https://www.googleapis.com/auth/calendar.readonly", "id_token": id_token(self.email)})


def exchange(agent, email, refresh, **flow):
    accounts.relay.upstream_client = lambda: GoogleToken(email, refresh)
    run(accounts._exchange(agent, {"verifier": "v", **flow}, "code"))


exchange(CLEO, "alice@exemple.fr", "refresh-perso")
exchange(CLEO, "alice@travail.example", "refresh-travail", ajout=True)
assert accounts._account(CLEO)["compte"] == "alice@exemple.fr", "le premier compte reste le premier"
assert json.loads((home(CLEO) / "google_token.json").read_text())["refresh_token"] == "refresh-perso"
work = home(CLEO) / "google-comptes" / "alice-travail.example"
assert json.loads((work / "google_token.json").read_text())["refresh_token"] == "refresh-travail"
state = alice.get(f"/api/agents/{CLEO}/google").json()
assert [o["compte"] for o in state["autres"]] == ["alice@travail.example"] and state["droit"] == "confirmer", state
exchange(CLEO, "alice@travail.example", "refresh-travail-2", compte="alice@travail.example")  # renouvelé seul, à sa place
assert json.loads((work / "google_token.json").read_text())["refresh_token"] == "refresh-travail-2"
assert json.loads((home(CLEO) / "google_token.json").read_text())["refresh_token"] == "refresh-perso"
assert len(alice.get(f"/api/agents/{CLEO}/google").json()["autres"]) == 1
assert alice.put(f"/api/agents/{CLEO}/google/droit", json={"droit": "agir"}).json()["droit"] == "agir"
assert mcp._rights(CLEO)[mcp.GOOGLE_RIGHT] == "agir"
assert alice.put(f"/api/agents/{CLEO}/google/droit", json={"droit": "tout"}).status_code == 422
assert alice.post(f"/api/agents/{CLEO}/google/disconnect?compte=inconnu@example.com", json={}).status_code == 404
r = alice.post(f"/api/agents/{CLEO}/google/disconnect?compte=alice@travail.example", json={})
assert r.status_code == 200 and r.json()["autres"] == [] and r.json()["connecte"], r.text
assert not work.exists() and (home(CLEO) / "google_token.json").exists(), "seul le dossier de ce compte part"
assert bruno.get(f"/api/agents/{CLEO}/google").status_code in (403, 404), "un autre compte ne voit pas ces comptes Google"
print("Google : plusieurs comptes, chacun renouvelé et retiré à part ; droit choisi transmis à l'agent")

# Un autre compte a ses propres connecteurs, sans croiser ceux d'alice.
assert bruno.post(f"/api/agents/{ZED}/connections/tools", json={"url": LIBRE, "nom": "libre", "droit": "lire"}).status_code == 400, "le réseau privé accepté reste celui du propriétaire"
with db.connect() as c:
    c.execute("INSERT INTO mcp_tools (agent_id, nom, url, auth, droit, outils, etat, vu_a) VALUES (?, 'libre', ?, 'aucune', 'lire', '[]', 'ok', 1)", (ZED, LIBRE))
assert bruno.put(scope_url(ZED, "libre"), json={"pour_tous": True}).status_code == 200
assert [a["id"] for a in bruno.get(scope_url(ZED, "libre")).json()["agents"]] == [ZED], "seulement ses agents à lui"
assert mcp._row(CLEO, "libre") is None
print("autre compte : ses agents, ses connecteurs")

# Un agent supprimé sort des listes.
connecteurs.agent_gone(GIL)
assert GIL not in connecteurs._get(ALICE, "notion")["poses"]


# --- 4. Compétences : ce que la personne enseigne, et rien d'autre -------------------------------------------------------------
SKILLS = f"/api/agents/{ALMA}/competences"
learned = home(ALMA) / "skills/devops/appris-seul"
learned.mkdir(parents=True)
(learned / "SKILL.md").write_text("---\nname: appris-seul\ndescription: Appris.\n---\n\nInterne\n", encoding="utf-8")
assert alice.get(SKILLS).json() == {"competences": []}, "ce que l'agent apprend seul reste caché"
conv = "conv-alma"
with db.connect() as c:
    c.execute("INSERT INTO conversations (id, agent_id, user_id, title, main) VALUES (?, ?, ?, 'x', 1)", (conv, ALMA, ALICE))
r = alice.post(SKILLS, json={"titre": "Répondre à mes clients", "texte": "Vouvoie-les.\n\nSigne Franck."})
assert r.status_code == 200, r.text
made = r.json()
assert made == {"nom": "repondre-a-mes-clients", "titre": "Répondre à mes clients", "texte": "Vouvoie-les.\n\nSigne Franck."}, made
skill = home(ALMA) / "skills/competences/repondre-a-mes-clients/SKILL.md"
text = skill.read_text(encoding="utf-8")
assert text.startswith("---\nname: repondre-a-mes-clients\n") and "Signe Franck." in text
description = next(line for line in text.splitlines() if line.startswith("description:"))
assert len(json.loads(description.split(":", 1)[1])) <= 60, "au-delà, Hermes refuse à la création"
assert "repondre-a-mes-clients" in machine.pop_context(conv), "l'agent l'apprend à son prochain message"
long_title = alice.post(SKILLS, json={"titre": "É" * 80, "texte": "Un texte."})
assert long_title.status_code == 200, long_title.text
assert alice.delete(f"{SKILLS}/{long_title.json()['nom']}").status_code == 200
same = alice.post(SKILLS, json={"titre": "appris seul", "texte": "Mon texte à moi."})
assert same.status_code == 200 and same.json()["nom"] == "appris-seul-2", "un skill appris seul garde son nom et son contenu"
assert "Interne" in (learned / "SKILL.md").read_text(encoding="utf-8")
assert [c["nom"] for c in alice.get(SKILLS).json()["competences"]] == ["appris-seul-2", "repondre-a-mes-clients"]
r = alice.put(f"{SKILLS}/repondre-a-mes-clients", json={"titre": "Répondre vite", "texte": "Tutoie-les."})
assert r.status_code == 200 and r.json() == {"nom": "repondre-a-mes-clients", "titre": "Répondre vite", "texte": "Tutoie-les."}, r.text
for name in ("appris-seul", "inconnue"):
    assert alice.delete(f"{SKILLS}/{name}").status_code == 400, name
    assert alice.put(f"{SKILLS}/{name}", json={"titre": "x", "texte": "y"}).status_code == 400, name
for name in ("../devops/appris-seul", "..", "/etc"):  # le lanceur reçoit tout ce que la route laisse passer : l'action refuse elle-même
    try:
        run(real_admin(ALMA, "competence_retirer", {"nom": name}))
        raise AssertionError(f"chemin accepté : {name}")
    except machine.HTTPException as e:
        assert e.status_code == 400, name
assert (learned / "SKILL.md").exists(), "cet onglet ne touche pas aux skills que l'agent a appris seul"
assert alice.post(SKILLS, json={"titre": "", "texte": "x"}).status_code == 422
assert alice.post(SKILLS, json={"titre": "Vide", "texte": "   "}).status_code == 400
assert bruno.get(SKILLS).status_code == 404 and bruno.post(SKILLS, json={"titre": "a", "texte": "b"}).status_code == 404, "un autre compte"
assert uma.get(f"/api/agents/{ENZO}/competences").status_code == 403, "le droit usage ne règle pas l'agent"
assert ada.get(SKILLS).status_code == 200, "le droit admin, si"
assert alice.delete(f"{SKILLS}/repondre-a-mes-clients").status_code == 200
assert not skill.exists()
print("compétences : ajouter, modifier, retirer ; ce qu'il apprend seul reste caché et intact")

shutil.rmtree(HOMES, ignore_errors=True)
print("OK")
sys.stdout.flush()
os._exit(0)  # une extension C plante parfois à la fermeture de Python, sans lien avec le code testé (voir mcp_test.py)
