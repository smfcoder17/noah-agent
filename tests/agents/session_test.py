"""Barre de session (0.3.0, D4) : ce que l'agent fait maintenant, vu par une seule lecture, sans rien montrer d'autrui.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/session_test.py"
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

from noah import auth, db, desktop, machine, main, relay, session  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
carla = auth.create_user("carla", "motdepasse-c")
web = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
shared = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(bruno, 'Firefox', 'web')}"})
stranger = TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(carla, 'Firefox', 'web')}"})
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?), ('a2', 'Veille', '', 'k', ?)", (alice, alice))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'usage')", (bruno,))

calls: list[str] = []


async def fake_admin(agent_id, action, body=None, timeout=90):
    calls.append(action)
    return {"routines": [{"id": "r1", "name": "Revue du matin", "state": "running", "last_run_at": "2026-11-15T08:00:00"},
                         {"id": "r2", "name": "Rapport du soir", "state": "scheduled"}]}


machine.admin = fake_admin

main_conv = main._new_conversation(alice, "a1", "Conversation", main=True)
thread = main._new_conversation(alice, "a1", "Prépare le rapport")
private = main._new_conversation(bruno, "a1", "Fil privé de Bruno")


def check(name, ok):
    assert ok, name
    print("ok", name)


# Au repos : rien en cours, la forme de la réponse est stable.
r = web.get("/api/agents/a1/session")
check("réponse 200 au propriétaire", r.status_code == 200)
body = r.json()
check("champs attendus", set(body) == {"travaux", "processus", "demandes", "confiees", "routines"})
check("rien en cours au repos", body["travaux"] == [] and body["processus"] == [] and body["demandes"] == [])
check("la routine qui tourne, seule", [x["titre"] for x in body["routines"]] == ["Revue du matin"])

# Un travail en cours : il apparaît avec sa ligne d'activité, puis disparaît à sa fin.
main.task_state[thread] = "work"
main.task_activity[thread] = "Lit rapport.md"
work = web.get("/api/agents/a1/session").json()["travaux"]
check("travail en cours visible", [(w["id"], w["titre"], w["activite"], w["etat"]) for w in work] == [(thread, "Prépare le rapport", "Lit rapport.md", "work")])
main.task_state[thread] = "approve"
check("attente d'accord dite", web.get("/api/agents/a1/session").json()["travaux"][0]["etat"] == "approve")
main.task_state[thread] = "idle"
check("travail fini : il quitte la barre", web.get("/api/agents/a1/session").json()["travaux"] == [])
relay.active["a1"] = [main_conv]
check("un tour en cours dans la principale compte aussi", [w["main"] for w in web.get("/api/agents/a1/session").json()["travaux"]] == [True])
relay.active["a1"] = []

# Un fil privé d'un autre profil ne se montre pas, ni son processus.
main.task_state[private] = "work"
check("le travail privé de Bruno reste à Bruno", web.get("/api/agents/a1/session").json()["travaux"] == [])
check("Bruno voit le sien", [w["id"] for w in shared.get("/api/agents/a1/session").json()["travaux"]] == [private])
main.task_state[private] = "idle"

# Processus en arrière-plan : lancé, reconnu par son identifiant, fini quand l'agent l'arrête ou constate sa fin.
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "npm run dev -- --token=SECRET", "background": True}})
procs = web.get("/api/agents/a1/session").json()["processus"]
check("processus lancé visible", len(procs) == 1 and procs[0]["conversation_id"] == thread)
check("la commande n'est pas recopiée", "SECRET" not in str(procs))
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": '{"session_id": "proc_abc123", "status": "running"}'})
check("toujours là après le lancement", len(web.get("/api/agents/a1/session").json()["processus"]) == 1)
check("pas chez un autre profil", shared.get("/api/agents/a1/session").json()["processus"] == [])
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "poll", "session_id": "proc_abc123"}, "preview": '{"status": "running"}'})
check("un suivi qui le voit vivant le garde", len(web.get("/api/agents/a1/session").json()["processus"]) == 1)
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "poll", "session_id": "proc_abc123"}, "preview": '{"status": "exited", "exit_code": 0}'})
check("fini : il quitte la barre", web.get("/api/agents/a1/session").json()["processus"] == [])
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "python serveur.py", "background": True}})
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": "Started proc_def456"})
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "kill", "session_id": "proc_def456"}})
check("arrêté par l'agent : il quitte la barre", web.get("/api/agents/a1/session").json()["processus"] == [])
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "sleep 100", "background": True}})
session.note("a1", thread, "tool.failed", {"tool_name": "terminal", "preview": "error"})
check("lancement échoué : rien", web.get("/api/agents/a1/session").json()["processus"] == [])
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "sleep 100", "background": True}})
session.run_ended("a1", thread)
check("travail coupé avant la réponse de l'outil : rien", web.get("/api/agents/a1/session").json()["processus"] == [])
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "sleep 100", "background": True}})
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": "proc_old999"})
session._processes["a1"][0]["debut"] = time.time() - session.PROCESS_SECONDS - 1
check("au-delà de deux heures, oublié", web.get("/api/agents/a1/session").json()["processus"] == [])
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "ls"}})
check("une commande ordinaire n'est pas un processus", web.get("/api/agents/a1/session").json()["processus"] == [])
session.forget("a1")

# Relecture m4 : un processus fini quitte la barre dès que son état le dit, quel que soit l'outil qui le dit.
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "make", "background": True}})
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": '{"session_id": "proc_court1", "status": "exited", "exit_code": 0}'})
check("m4 fini dès son lancement : il ne reste pas", web.get("/api/agents/a1/session").json()["processus"] == [])
for n in ("a", "b"):
    session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": f"serveur {n}", "background": True}})
    session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": f"Started proc_liste{n}1"})
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "list"},
             "result": '{"processes": [{"session_id": "proc_listea1", "status": "exited", "exit_code": 1}, {"session_id": "proc_listeb1", "status": "running"}]}'})
check("m4 la liste des processus dit lequel est fini : lui seul part", [p["session"] for p in session._processes["a1"]] == ["proc_listeb1"])
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "log", "session_id": "proc_listeb1"},
             "preview": "ligne 1 du journal…", "result": "ligne 1 du journal\n" * 50 + '{"status": "exited"}'})
check("m4 l'état lu dans le résultat entier, pas seulement dans son aperçu tronqué", web.get("/api/agents/a1/session").json()["processus"] == [])
session.forget("a1")

# Relecture 0.3.0, partie 5 n°1 : la fin d'une commande en avant-plan ne prend pas la place d'un lancement en arrière-plan.
procs = lambda: web.get("/api/agents/a1/session").json()["processus"]  # noqa: E731
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "tool_call_id": "c1", "args": {"command": "npm run dev", "background": True}})
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "tool_call_id": "c2", "args": {"command": "ls"}})
session.note("a1", thread, "tool.failed", {"tool_name": "terminal", "tool_call_id": "c2", "preview": "ls: erreur"})
check("P5n1 l'avant-plan raté ne retire pas l'arrière-plan qui tourne (par identifiant d'appel)", len(procs()) == 1)
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "tool_call_id": "c1", "preview": "Started proc_dev111"})
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "poll", "session_id": "proc_dev111"}, "preview": '{"status": "exited"}'})
check("P5n1 son vrai identifiant de processus lui revient, et sa fin le retire", procs() == [])
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "npm run dev", "background": True}})
session.note("a1", thread, "tool.started", {"tool_name": "terminal", "args": {"command": "ls"}})
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": "README.md"})
session.note("a1", thread, "tool.completed", {"tool_name": "terminal", "preview": "Started proc_dev222"})
check("P5n1 sans identifiant d'appel : la sortie de ls ne finit pas le lancement", len(procs()) == 1 and session._processes["a1"][0]["session"] == "proc_dev222")
session.note("a1", thread, "tool.completed", {"tool_name": "process", "args": {"action": "kill", "session_id": "proc_dev222"}})
check("P5n1 puis son arrêt le retire", procs() == [])

# Partie 5 n°5 : la purge de fin de tour est dans un finally, même quand l'écran se déconnecte.
import ast  # noqa: E402
from pathlib import Path  # noqa: E402
tree = ast.parse(Path(main.tours.__file__).read_text(encoding="utf-8"))
purges = [t for t in ast.walk(tree) if isinstance(t, ast.Try) and any("session.run_ended" in ast.unparse(s) for s in t.finalbody)]
check("P5n5 session.run_ended est dans un finally du tour", len(purges) == 1 and not any(
    isinstance(s, ast.Expr) and "session.run_ended" in ast.unparse(s) for t in ast.walk(tree) if isinstance(t, (ast.AsyncFunctionDef, ast.FunctionDef)) for s in t.body))

# Partie 5 n°6 : une réponse inattendue de la machine ne casse pas la lecture des routines ; elle est écrite au journal.
import asyncio  # noqa: E402
import contextlib  # noqa: E402
import io  # noqa: E402


async def odd_admin(agent_id, action, body=None, timeout=90):
    return {"routines": "pas une liste"}


async def broken_admin(agent_id, action, body=None, timeout=90):
    raise KeyError("champ")

saved_admin, saved_cache = machine.admin, main._routine_cache.get("a1")
out = io.StringIO()
with contextlib.redirect_stdout(out):
    for fake in (odd_admin, broken_admin):
        machine.admin = fake
        asyncio.run(main._read_routines("a1"))
machine.admin = saved_admin
check("P5n6 erreur inattendue : cache remis à jour, journal écrit", main._routine_cache["a1"][1] == [] and "routines de a1 illisibles" in out.getvalue())
main._routine_cache["a1"] = saved_cache

# Une demande passée à un autre agent, en cours.
with db.connect() as c:
    c.execute("INSERT INTO delegations (id, de, vers, conversation_id, profondeur, chaine, etat, consigne, created_at) "
              "VALUES ('d1', 'a1', 'a2', ?, 1, 'a1', 'en_cours', 'Surveille les prix\nDétails', ?)", (thread, time.time()))
    # D3 (relecture) : une demande lancée depuis le fil privé de Bruno ne se montre pas à Alice, même si elle voit l'agent visé.
    c.execute("INSERT INTO delegations (id, de, vers, conversation_id, profondeur, chaine, etat, consigne, created_at) "
              "VALUES ('d2', 'a1', 'a2', ?, 1, 'a1', 'en_cours', 'Consigne privée de Bruno', ?)", (private, time.time()))
asks = web.get("/api/agents/a1/session").json()["demandes"]
check("demande à un autre agent visible", [(a["agent"], a["titre"]) for a in asks][:1] == [("Veille", "Surveille les prix")])
check("D3 une demande lancée d'une conversation qu'elle ne voit pas reste cachée", [a["id"] for a in asks] == ["d1"])
check("invisible pour qui ne voit pas l'agent visé", shared.get("/api/agents/a1/session").json()["demandes"] == [])

# Tâches confiées à l'ordinateur : au propriétaire seulement.
desktop._tasks["t1"] = {"agent_id": "a1", "user": alice, "etat": "en_cours", "outil": "claude", "dossier": "site", "nom_appareil": "PC",
                        "debut": time.time() - 30, "lignes": ["Lit le code"], "offre": "Pro", "resultat": {}}
confided = web.get("/api/agents/a1/session").json()["confiees"]
check("tâche confiée visible au propriétaire", [(x["id"], x["appareil"], x["etat"]) for x in confided] == [("t1", "PC", "en_cours")])
check("pas à un profil partagé", shared.get("/api/agents/a1/session").json()["confiees"] == [])
desktop._tasks.clear()

# Les routines sont des réglages : un profil en simple usage ne les lit pas, et la machine n'est pas relue à chaque relevé.
calls.clear()
check("profil en usage : pas de routines", shared.get("/api/agents/a1/session").json()["routines"] == [])
web.get("/api/agents/a1/session")
check("routines gardées quelques secondes", calls == [])

# Une machine lente ou éteinte ne retient pas la barre : la dernière lecture répond tout de suite.
async def slow_admin(agent_id, action, body=None, timeout=90):
    import asyncio
    await asyncio.sleep(3)
    return {"routines": []}


machine.admin = slow_admin
main._routine_cache["a1"] = (0.0, main._routine_cache["a1"][1])
started = time.monotonic()
slow = web.get("/api/agents/a1/session").json()
check("machine lente : réponse en moins d'une seconde", time.monotonic() - started < 1)
check("machine lente : dernière lecture gardée", [x["titre"] for x in slow["routines"]] == ["Revue du matin"])

# Relecture, point 12 : le lanceur absent n'est plus une « Erreur interne » brute pour Fichiers et Connexions.
import httpx  # noqa: E402

from noah import config, hermes  # noqa: E402


async def launcher_gone(*_a, **_k):
    raise httpx.ConnectError("Connection refused", request=httpx.Request("GET", f"{config.LAUNCHER_URL}/agents/a1/files"))


async def launcher_slow(*_a, **_k):
    raise httpx.ConnectTimeout("timed out", request=httpx.Request("POST", f"{config.LAUNCHER_URL}/agents/a1/admin/google"))


async def elsewhere_gone(*_a, **_k):
    raise httpx.ConnectError("Connection refused", request=httpx.Request("GET", "https://fournisseur.exemple/v1"))


saved_files, saved_admin = hermes.list_files, machine.admin
hermes.list_files, machine.admin = launcher_gone, launcher_slow
try:
    r = web.get("/api/agents/a1/files")
    check("12 Fichiers, lanceur absent : 503 et un message clair", r.status_code == 503 and r.json()["detail"] == main.LAUNCHER_DOWN)
    r = web.get("/api/agents/a1/connections?frais=1")
    check("12 Connexions, lanceur trop lent : 503 et le même message", r.status_code == 503 and r.json()["detail"] == main.LAUNCHER_DOWN)
    hermes.list_files = elsewhere_gone
    r = TestClient(main.app, raise_server_exceptions=False, headers=web.headers).get("/api/agents/a1/files")
    check("12 une autre panne réseau reste une erreur interne", r.status_code == 500 and "Erreur interne" in r.json()["detail"])
finally:
    hermes.list_files, machine.admin = saved_files, saved_admin

# Agent invisible : 404, comme partout.
check("inconnu pour un autre compte", stranger.get("/api/agents/a1/session").status_code == 404)
check("sans session : 401", TestClient(main.app).get("/api/agents/a1/session").status_code == 401)
print("session_test : tout est vert")
