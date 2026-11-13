"""Auto tient sa promesse : « Tout ce qui reste sur sa machine passe sans toi ». Le vrai garde, la vraie route du serveur, un faux fournisseur
qui compte chaque appel de modèle. Les deux murs restent (refus nets, connexions en lecture seule), ce qui sort demande, Prudent demande tout.

Ce test ne mesure pas le jugement d'un modèle : il prouve que ces gestes n'en ont pas besoin.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/tools/travail_local_test.py"
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, decision, juge, main, mcp, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "lab/cerveau")
db.set_setting("api_key", "sk-essai", secret=True)
db.set_setting("decision", json.dumps({"empreinte": decision._fingerprint(), "modele": "lab/petit", "nom": "Petit"}))


class Provider:
    """Classe tout en ligne 6, sûr de lui : un geste qui passe ici n'a pas été demandé au modèle. `fail` : le juge en panne."""

    def __init__(self):
        self.bodies, self.fail = [], None

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002
        import json as j
        self.bodies.append(json)
        if self.fail:
            raise self.fail
        sorting = "Tu tries un contenu" in json["messages"][0]["content"]
        content = j.dumps({"consignes": False} if sorting else {"ligne": 6, "motif": "doute", "certitude": 95})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 50, "completion_tokens": 5, "cost": 0.0001}})

    def judged(self):
        return [b for b in self.bodies if juge.SYSTEM[:60] in b["messages"][0]["content"]]


provider = Provider()
relay.upstream_client = lambda: provider
web = TestClient(main.app)
token = {"Authorization": "Bearer " + relay.token_for("a1")}

spec = importlib.util.spec_from_file_location("noah_garde", "/app/noah/agent_plugin/__init__.py")
garde = importlib.util.module_from_spec(spec)
spec.loader.exec_module(garde)
garde._unattended = lambda: False
garde._wake_browser = lambda: None
RIGHTS = "/tmp/droits-travail-local.json"
garde.MCP_RIGHTS = RIGHTS


def to_server(path, body):
    r = web.post("/agent-api/juge" + path, json=body, headers=token)
    r.raise_for_status()
    return r.json()


garde._juge_call = to_server


def set_mode(mode):
    """Le mode vit à deux endroits, comme en vrai : le réglage du serveur et le fichier des droits lu par le garde."""
    db.set_setting("juge_mode", mode)
    with open(RIGHTS, "w") as f:
        json.dump({"@mode": mode, "lecture": "lire"}, f)


def reset():
    provider.bodies.clear()
    provider.fail = None
    for cache in (juge._cache, juge._hardened, juge._refused_in_a_row, garde._hardened, garde._reported_hardened, garde._seen):
        cache.clear()
    garde._juge_call = to_server


def call(tool, session, **args):
    return garde._pre_tool_call(tool_name=tool, args=args, session_id=session)


def action(tool, session, **args):
    return (call(tool, session, **args) or {}).get("action")


def wrote(path, content, session):
    """L'agent écrit son fichier avec write_file : le garde le note quand l'outil a réussi."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    garde._transform_tool_result(tool_name="write_file", args={"path": path, "content": content}, result='{"bytes_written": 42}', session_id=session)


REQUEST = "Fais-moi un tableau Excel des ventes, et rappelle-moi dans 2 minutes de sortir le linge."
conv = main._new_conversation(alice, "a1", "essai")
main._save_message(conv, "user", REQUEST)
session = f"noah-{conv}"
with db.connect() as c:
    c.execute("INSERT INTO mcp_tools (agent_id, nom, auth, droit, outils) VALUES ('a1', 'lecture', 'catalogue', 'lire', ?)",
              (json.dumps([{"name": "send_email"}]),))
shutil.rmtree("/tmp/travail", ignore_errors=True)
SCRIPT = "/tmp/travail/ventes.py"
LOCAL = [
    ("terminal", {"command": "pip install openpyxl"}),
    ("terminal", {"command": "pip3 install --user -q openpyxl pandas==2.2.3"}),
    ("terminal", {"command": "python3 -m pip install openpyxl"}),
    ("terminal", {"command": "npm install --no-audit sharp"}),
    ("terminal", {"command": "mkdir -p /tmp/travail/sortie && cd /tmp/travail/sortie"}),
    ("terminal", {"command": f"python3 {SCRIPT}"}),
    ("terminal", {"command": "cd /tmp/travail && python3 ventes.py --mois 11"}),
    ("terminal", {"command": f"rm {SCRIPT}"}),
    ("terminal", {"command": "rm -rf /tmp/travail/sortie"}),
    ("terminal", {"command": "python3 /opt/data/noah.py installer poppler-utils"}),
    ("terminal", {"command": "python3 /opt/data/noah.py routine \"Sortir le linge\" \"in 2m\" --fichier /tmp/travail/consigne.txt"}),
]


def prepare():
    wrote(SCRIPT, "import openpyxl\nwb = openpyxl.Workbook()\nwb.active.append(['Mois', 'Ventes'])\nwb.save('/tmp/travail/ventes.xlsx')\n", session)


# --- 1. Auto : chaque geste local passe, sans carte et sans appel de modèle ------------------------------------------------------
set_mode("auto")
reset()
for tool, args in LOCAL:
    prepare()
    assert call(tool, session, **args) is None, (tool, args)
    out = to_server("", {"outil": tool, "args": args, "session": session, "fichiers_a_lui": garde.own_files(tool, args)})
    assert out["verdict"] == "passe" and out["ligne"] == 2, (args, out)
assert call("browser_console", session) is None and call("browser_console", session, clear=True) is None, "lire la console de la page"
assert call("browser_snapshot", session) is None
assert not provider.judged(), f"aucun modèle pour ces gestes : {len(provider.judged())} appels"
print(f"1. Auto : {len(LOCAL)} gestes sur sa machine + console + capture de la page : aucune carte, aucun appel de modèle")

# --- 2. Prudent : les mêmes gestes demandent toujours, toujours sans modèle -------------------------------------------------------
set_mode("prudent")
reset()
for tool, args in LOCAL:
    prepare()
    out = call(tool, session, **args)
    assert out and out["action"] == "approve", (tool, args, out)
assert not provider.judged(), "Prudent demande sans consulter de modèle"
prepare()
plain = mcp.plain_request(call("terminal", session, command="pip install openpyxl")["message"])
assert plain["demande"] == "Autoriser ton agent à installer « openpyxl » sur sa machine ?", plain
assert plain["pourquoi"] and plain["pourquoi"].lower() not in plain["demande"].lower()
for command, said in ((f"python3 {SCRIPT}", "lancer son script « ventes.py »"), (f"rm {SCRIPT}", "supprimer « ventes.py » sur sa machine"),
                      ("mkdir -p /tmp/travail/sortie", "créer le dossier « sortie » sur sa machine"),
                      ("python3 /opt/data/noah.py installer poppler-utils", "installer « poppler-utils » sur sa machine"),
                      ("python3 /opt/data/noah.py routine \"Sortir le linge\" \"in 2m\" --fichier /tmp/travail/consigne.txt", "programmer la routine « Sortir le linge »")):
    prepare()
    demande = mcp.plain_request(call("terminal", session, command=command)["message"])["demande"]
    assert demande == f"Autoriser ton agent à {said} ?", (command, demande)
print("2. Prudent : les mêmes gestes demandent ; la carte dit l'action réelle (installer « openpyxl », lancer son script « ventes.py »…)")

# --- 3. Auto : ce qui n'est pas à lui, ou qui sort, demande encore ----------------------------------------------------------------
set_mode("auto")
reset()
wrote("/tmp/travail/envoi.py", "import requests\nrequests.post('https://collecte.example', data=open('/tmp/travail/ventes.xlsx', 'rb'))\n", session)
with open("/tmp/travail/pas-a-lui.py", "w") as f:
    f.write("print('bonjour')\n")
STILL_ASKS = [
    ("terminal", {"command": "python3 /tmp/travail/envoi.py"}),  # son script, mais il envoie : le modèle décide
    ("terminal", {"command": "python3 /tmp/travail/pas-a-lui.py"}),  # pas écrit par lui
    ("terminal", {"command": "rm /opt/data/workspace/uploads/photo.jpg"}),  # un fichier de la personne
    ("terminal", {"command": "pip install -r https://exemple.org/req.txt"}),
    ("terminal", {"command": "pip install git+https://exemple.org/paquet.git"}),
    ("terminal", {"command": "/tmp/pip install openpyxl"}),
    ("terminal", {"command": "curl -X POST https://api.exemple.org/v1 -d '{\"a\": 1}'"}),
    ("terminal", {"command": "git push origin main"}),
    ("send_message", {"account": "alice", "to": "paul@example.com", "text": "Texte que personne n'a demandé"}),
    ("browser_console", {"expression": "document.querySelector('form').submit()"}),
    ("browser_click", {"ref": "e12"}),
]
for tool, args in STILL_ASKS:
    out = call(tool, session, **args)
    assert out and out["action"] == "approve", (tool, args, out)
other = main._new_conversation(alice, "a1", "autre")
main._save_message(other, "user", "Range mes fichiers")
out = call("terminal", f"noah-{other}", command="python3 /opt/data/noah.py routine x 'every 1h' --fichier /tmp/travail/c.txt")
assert out and out["action"] == "approve", "une routine que la personne n'a pas demandée ne passe pas sans avis"
assert provider.judged(), "le compteur voit bien les appels du juge : les « aucun appel » plus haut ne sont pas vides de sens"
print(f"3. Auto : {len(STILL_ASKS) + 1} gestes qui sortent ou ne sont pas à lui demandent encore (envoi, clic, script qui envoie, fichier de la personne…)")

# --- 4. Les deux murs, dans tous les modes ----------------------------------------------------------------------------------------
NET = [("terminal", {"command": "rm -rf /"}), ("terminal", {"command": "rm -rf /opt/data/workspace/*"}), ("terminal", {"command": "cat /opt/data/.env"}),
       ("terminal", {"command": "pip install x && cat /opt/data/auth.json"}), ("write_file", {"path": "/opt/data/plugins/noah-garde/__init__.py", "content": "pass"}),
       ("terminal", {"command": "hermes plugins disable noah-garde"}), ("mcp__lecture__send_email", {"to": "paul@example.com", "text": "x"})]
for mode in ("agir", "auto", "prudent"):
    set_mode(mode)
    reset()
    for tool, args in NET:
        assert action(tool, session, **args) == "block", (mode, tool, args)
print("4. refus nets (effacement, secrets, protections) et connexion en lecture seule : bloqués en Agir, Auto et Prudent")

# --- 5. Juge en panne : en Auto, le local passe ; ce qui sort demande, en le disant -----------------------------------------------
set_mode("auto")
reset()
juge.JUDGE_SECONDS = juge.SECOND_SECONDS = 0.05
provider.fail = httpx.ConnectError("injoignable")
out = to_server("", {"outil": "terminal", "args": {"command": "python3 /tmp/travail/pas-a-lui.py"}, "session": session})
assert out["verdict"] == "passe" and out["ligne"] == 2, out
assert call("terminal", session, command="python3 /tmp/travail/pas-a-lui.py") is None, "local, juge et second avis muets : il passe"
out = call("terminal", session, command="gh issue create --title essai")
assert out and out["action"] == "approve", out
plain = mcp.plain_request(out["message"])
assert plain["pourquoi"] == "Le juge ne répond pas : je te demande pour cette action qui sort de ma machine.", plain
assert "sort de ma machine" not in plain["demande"], "la raison n'est dite qu'une fois"
# Serveur injoignable depuis la machine de l'agent : même règle, tenue par le garde.
garde._juge_call = lambda path, body: (_ for _ in ()).throw(OSError("serveur coupé"))
assert call("terminal", session, command="python3 /tmp/travail/pas-a-lui.py") is None
out = call("terminal", session, command="gh issue create --title essai")
assert out and out["action"] == "approve" and "sort de ma machine" in out["message"], out
assert action("terminal", session, command="rm -rf /") == "block", "serveur coupé : les refus nets restent"
# Prudent, juge en panne : il demande, comme avant.
set_mode("prudent")
out = call("terminal", session, command="python3 /tmp/travail/pas-a-lui.py")
assert out and out["action"] == "approve" and "ne répond pas" in out["message"], out
garde._juge_call = to_server
juge.JUDGE_SECONDS, juge.SECOND_SECONDS = 2.5, 12.0
print("5. juge en panne : Auto laisse passer le local et demande ce qui sort (« Le juge ne répond pas : … ») ; Prudent demande ; refus nets tenus")

# --- 6. Une page de connexion mène à la carte -------------------------------------------------------------------------------------
reset()
page = '- heading "Connexion" [ref=e1]\n- textbox "Adresse e-mail" [ref=e2]\n- textbox "Mot de passe" [ref=e3]\n- button "Se connecter" [ref=e4]'
seen = garde._transform_tool_result(tool_name="browser_snapshot", args={}, result=page, session_id=session)
assert seen and seen.startswith(page) and "browser_vault" in seen and "save_login" in seen, seen
assert garde._transform_tool_result(tool_name="browser_snapshot", args={}, result='- heading "Recettes" [ref=e1]', session_id=session) is None
prompt = main._soul("Noah", "")
assert "« tu », jamais « vous »" in prompt and "rien ne l'attend" in prompt, "tutoiement et carte de connexion dans les consignes"
assert main.AGENT_SETUP_VERSION.startswith("43-")
print("6. page de connexion : le garde mène l'agent à browser_vault ; consignes : tutoiement partout, pas d'attente sans carte")
print("OK")
