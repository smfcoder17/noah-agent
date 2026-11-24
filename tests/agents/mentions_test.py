"""Citer avec @ (agent, fichier, dossier) et appeler une compétence avec / : les trois routes de suggestions, et ce que l'agent reçoit.

Prouve : seul qui peut parler à l'agent du fil lit les suggestions (sans session 401, sans accès 404, en lecture seule 403) ; un invité ne
voit que les agents qui lui sont partagés ; les fichiers ne sortent jamais de l'espace de travail (`..`, chemin absolu, lien symbolique et
fichier caché, avec la vraie commande du lanceur sur un vrai disque) ; la liste des fichiers et celle des compétences sont servies du
cache sous 100 ms après la première lecture ; ce que l'agent reçoit devant le message dit quoi faire de chaque pastille, et un agent
cité que le compte ne voit pas n'y entre pas.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/launcher:/l:ro" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/agents/mentions_test.py"
"""
import asyncio
import os
import re
import subprocess
import sys
import tempfile
import time
from unittest.mock import MagicMock

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.update(LAUNCHER_KEY="k", NOAH_SECRET_KEY="y" * 32, AGENT_NETWORK="reseau", NOAH_UPDATES_DIR=tempfile.mkdtemp())
docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
sys.path[:0] = ["/app", "/l"]
import launcher  # noqa: E402
import httpx  # noqa: E402

from noah import auth, db, hermes, machine, main, mentions  # noqa: E402

db.init()
alice, bruno, carla, dan, eve = (auth.create_user(n, "motdepasse-essai") for n in ("alice", "bruno", "carla", "dan", "eve"))
with db.connect() as c:
    c.executemany("INSERT INTO agents (id, name, role, api_key, owner_id, color) VALUES (?, ?, ?, 'k', ?, '#123456')", [
        ("a1", "Noah", "Assistant", alice), ("a2", "Marie", "Rédige les comptes rendus", alice), ("a3", "Paul", "Compta", alice), ("c1", "Chloé", "Recherche", carla)])
    c.executemany("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, ?)", [(bruno, "lecture"), (carla, "usage"), (dan, "admin")])
db.set_setting("onboarded", "1")

# --- Un vrai disque, la vraie commande du lanceur : ni lien symbolique, ni sortie du dossier -----------------------------------------------
ws = tempfile.mkdtemp()
secret = tempfile.mkdtemp()
open(f"{secret}/mot-de-passe.txt", "w").write("secret")
for rel in ("outputs/plan.md", "outputs/rapport/final.pdf", "outputs/rapport/brouillon.txt", "uploads/photo.png", "notes.txt", ".cache/x", "apps/site/index.html", "dossier avec espace/é.txt"):
    os.makedirs(os.path.dirname(f"{ws}/{rel}"), exist_ok=True)
    open(f"{ws}/{rel}", "w").write("x")
for rel in ("apps/site/index.html", "dossier avec espace/é.txt"):
    os.utime(f"{ws}/{rel}", (1_600_000_000, 1_600_000_000))
for i, rel in enumerate(("notes.txt", "uploads/photo.png", "outputs/rapport/brouillon.txt", "outputs/rapport/final.pdf", "outputs/plan.md")):
    os.utime(f"{ws}/{rel}", (1_700_000_000 + i * 100, 1_700_000_000 + i * 100))  # plan.md est le plus récent
os.symlink(f"{secret}/mot-de-passe.txt", f"{ws}/lien-fichier.txt")
os.symlink(secret, f"{ws}/lien-dossier")
os.symlink(secret, f"{ws}/outputs/lien-sorti")


class Conteneur:
    def exec_run(self, cmd, user=None):
        cmd = [ws if a == launcher.WORKSPACE else a for a in cmd]
        return MagicMock(output=subprocess.run(cmd, capture_output=True).stdout)


launcher.container = lambda agent_id: Conteneur()
launcher.check_id = lambda agent_id: agent_id
launcher.WORKSPACE = launcher.WORKSPACE  # le lanceur compare à cette valeur : on la remplace dans la commande
reads = {"files": 0, "skills": 0}
DELAI = 0.4


async def list_files(agent_id):
    reads["files"] += 1
    await asyncio.sleep(DELAI)
    return launcher.list_files(agent_id)


SKILLS = {"skills": [
    {"nom": "competences/note-de-frais", "titre": "Note de frais", "resume": "Remplit une note de frais", "origine": "enseigné par toi", "desactivee": False},
    {"nom": "competences/compte-rendu", "titre": "Compte rendu de réunion", "resume": "Résume une réunion en cinq lignes", "origine": "enseigné par toi", "desactivee": False},
    {"nom": "apprise-seule", "titre": "Facture", "resume": "Prépare une facture", "origine": "appris par ton agent", "desactivee": True},
    {"nom": "productivity/google-workspace", "titre": "Google Workspace", "resume": "Gmail, Agenda, Drive", "origine": "fourni avec Noah", "desactivee": False},
]}


async def admin(agent_id, action, body=None, timeout=90):
    assert action == "skills_resume", action
    reads["skills"] += 1
    await asyncio.sleep(DELAI)
    return SKILLS


hermes.list_files = list_files
machine.admin = admin


def duree(r):
    m = re.search(r"app;dur=([\d.]+)", r.headers.get("server-timing", ""))
    assert m, dict(r.headers)
    return float(m.group(1))


def client(user=None):
    headers = {"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"} if user else {}
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url="http://test", headers=headers, timeout=30)


async def everything():
    # Le lanceur lit son espace de travail dans le dossier d'essai : la commande est la sienne, le dossier est celui du test.
    original = launcher.WORKSPACE
    launcher.WORKSPACE = ws
    try:
        await droits()
        await agents()
        await fichiers()
        await competences()
        await contexte()
        await envoi()
    finally:
        launcher.WORKSPACE = original


async def droits():
    routes = ["/api/agents/a1/mentions/agents", "/api/agents/a1/mentions/fichiers", "/api/agents/a1/mentions/competences"]
    async with client() as sans:
        for route in routes:
            assert (await sans.get(route)).status_code == 401, "sans session"
    for who, code in ((eve, 404), (bruno, 403), (carla, 200), (dan, 200), (alice, 200)):
        async with client(who) as A:
            for route in routes:
                got = (await A.get(route)).status_code
                assert got == code, (who, route, got, code)
    async with client(alice) as A:
        assert (await A.get("/api/agents/inconnu/mentions/agents")).status_code == 404, "un agent qui n'existe pas"
    print("suggestions : sans session 401, sans accès 404, en lecture seule 403, usage et plus 200")


async def agents():
    async with client(alice) as A:
        got = (await A.get("/api/agents/a1/mentions/agents")).json()["agents"]
        assert [a["id"] for a in got] == ["a2", "a3"], got  # pas l'agent du fil, pas ceux d'une autre personne
        assert got[0]["nom"] == "Marie" and got[0]["role"].startswith("Rédige") and got[0]["color"] == "#123456"
        assert [a["id"] for a in (await A.get("/api/agents/a1/mentions/agents", params={"q": "mar"})).json()["agents"]] == ["a2"]
        assert [a["id"] for a in (await A.get("/api/agents/a1/mentions/agents", params={"q": "compta"})).json()["agents"]] == ["a3"], "le rôle compte aussi"
        assert [a["id"] for a in (await A.get("/api/agents/a1/mentions/agents", params={"q": "MARIE"})).json()["agents"]] == ["a2"]
        assert (await A.get("/api/agents/a1/mentions/agents", params={"q": "zzz"})).json()["agents"] == []
    async with client(carla) as C:  # invitée de a1 : elle voit les siens et ceux qu'on lui a partagés, jamais ceux d'Alice
        got = [a["id"] for a in (await C.get("/api/agents/a1/mentions/agents")).json()["agents"]]
        assert got == ["c1"], got
        assert (await C.get("/api/agents/a1/mentions/agents", params={"q": "marie"})).json()["agents"] == [], "Marie est à Alice : invisible pour Carla"
    print("agents : ceux que le compte voit, sans l'agent du fil, un invité n'en voit pas d'autres")


async def fichiers():
    async with client(alice) as A:
        route = "/api/agents/a1/mentions/fichiers"
        mentions._files.clear()
        reads["files"] = 0
        froid = await A.get(route)
        assert froid.status_code == 200 and reads["files"] == 1 and duree(froid) >= DELAI * 900, ("à froid, la liste est lue une fois", froid.status_code, froid.text[:300], reads, duree(froid))
        got = froid.json()
        paths = [f["chemin"] for f in got["fichiers"]]
        assert paths[:3] == ["outputs/plan.md", "outputs/rapport/final.pdf", "outputs/rapport/brouillon.txt"], "les plus récents d'abord : " + str(paths)
        assert {d["chemin"] for d in got["dossiers"]} >= {"outputs", "uploads", "apps"} and all("/" not in d["chemin"] for d in got["dossiers"]), got["dossiers"]
        everything_listed = (await A.get(route, params={"limite": 50})).json()
        listed = {f["chemin"] for f in everything_listed["fichiers"]}
        assert "lien-fichier.txt" not in listed and not any("lien" in p for p in listed), "aucun lien symbolique ne sort de la vraie commande du lanceur"
        assert not any(p.startswith(".") or "/." in p for p in listed), "aucun fichier caché"
        assert "mot-de-passe.txt" not in " ".join(listed), "ce que pointe un lien n'est jamais listé"
        assert "lien-dossier" not in [d["chemin"] for d in everything_listed["dossiers"]] and "outputs/lien-sorti" not in [d["chemin"] for d in everything_listed["dossiers"]]
        assert "dossier avec espace/é.txt" in listed, "espaces et accents passent"
        for _ in range(5):
            chaud = await A.get(route, params={"q": "plan"})
            assert chaud.status_code == 200 and duree(chaud) < 100 and reads["files"] == 1, (duree(chaud), reads)
        assert [f["chemin"] for f in chaud.json()["fichiers"]] == ["outputs/plan.md"], "recherche par nom"
        assert [f["chemin"] for f in (await A.get(route, params={"q": "PLAN"})).json()["fichiers"]] == ["outputs/plan.md"], "sans tenir compte des majuscules"
        assert [f["chemin"] for f in (await A.get(route, params={"q": "e.txt"})).json()["fichiers"]] == ["dossier avec espace/é.txt"], "l'accent se cherche sans accent"
        # Descendre dans un dossier : ses enfants, fichiers et sous-dossiers.
        out = (await A.get(route, params={"dossier": "outputs"})).json()
        assert [f["chemin"] for f in out["fichiers"]] == ["outputs/plan.md"] and [d["chemin"] for d in out["dossiers"]] == ["outputs/rapport"], out
        deeper = (await A.get(route, params={"dossier": "outputs/rapport"})).json()
        assert [f["chemin"] for f in deeper["fichiers"]] == ["outputs/rapport/final.pdf", "outputs/rapport/brouillon.txt"] and deeper["dossiers"] == []
        assert [f["chemin"] for f in (await A.get(route, params={"dossier": "outputs", "q": "final"})).json()["fichiers"]] == ["outputs/rapport/final.pdf"], "en cherchant dans un dossier : tout ce qu'il contient"
        assert (await A.get(route, params={"dossier": "uploads", "q": "plan"})).json()["fichiers"] == [], "la recherche reste dans le dossier"
        # Rien hors du dossier de travail.
        for bad in ("..", "../..", "outputs/../..", "outputs/../../etc", "./outputs", "outputs//rapport", "a\\b", "x\x00y"):
            r = await A.get(route, params={"dossier": bad})
            assert r.status_code == 400, (bad, r.status_code, r.text)
        racine = (await A.get(route, params={"dossier": "/etc"})).json()
        assert racine["fichiers"] == [] and racine["dossiers"] == [], "un chemin absolu se lit relatif à l'espace de travail : il n'y a rien dans « etc »"
        assert (await A.get(route, params={"q": "../../etc/passwd"})).json()["fichiers"] == [], "la recherche ne se lit que comme un nom"
        assert len((await A.get(route, params={"limite": 2})).json()["fichiers"]) == 2 and len((await A.get(route, params={"limite": 100000})).json()["fichiers"]) <= 50
    # Un invité (droit « usage ») lit l'espace de travail commun de l'agent, comme dans l'onglet Fichiers.
    async with client(carla) as C:
        assert [f["chemin"] for f in (await C.get(route, params={"q": "plan"})).json()["fichiers"]] == ["outputs/plan.md"]
    # Liste vieille : servie tout de suite, relue en fond.
    mentions._files["a1"] = (time.monotonic() - mentions.FILES_FRESH - 1, mentions._files["a1"][1])
    reads["files"] = 0
    async with client(alice) as A:
        vieux = await A.get(route, params={"q": "plan"})
        assert duree(vieux) < 100 and vieux.json()["fichiers"], "une liste vieille est servie sans attendre"
        await asyncio.sleep(DELAI + 0.3)
        assert reads["files"] == 1, "et relue en fond, une fois"
    # Agent arrêté : la saisie continue, sans fichier.
    async def broken(agent_id):
        raise httpx.ConnectError("arrêté")
    hermes.list_files = broken
    mentions._files.clear()
    async with client(alice) as A:
        r = await A.get(route)
        assert r.status_code == 200 and r.json() == {"fichiers": [], "dossiers": [], "indisponible": True}, r.text
    hermes.list_files = list_files
    print("fichiers : récents d'abord, par nom, par dossier, rien hors de l'espace de travail (.., absolu, lien, caché), cache sous 100 ms")


async def competences():
    route = "/api/agents/a1/mentions/competences"
    machine._lus.clear()
    async with client(alice) as A:
        reads["skills"] = 0
        froid = await A.get(route)
        assert froid.status_code == 200 and reads["skills"] == 1 and duree(froid) >= DELAI * 900
        got = froid.json()
        assert [s["nom"] for s in got["competences"]] == ["competences/compte-rendu", "competences/note-de-frais", "productivity/google-workspace", "apprise-seule"] or \
            [s["nom"] for s in got["competences"]][-1] == "apprise-seule", got
        assert got["competences"][-1]["desactivee"] is True and got["total"] == 4, "une compétence désactivée se dit, et passe en dernier"
        for _ in range(5):
            chaud = await A.get(route, params={"q": "compte"})
            assert chaud.status_code == 200 and duree(chaud) < 100 and reads["skills"] == 1, (duree(chaud), reads)
        assert [s["nom"] for s in chaud.json()["competences"]] == ["competences/compte-rendu"], chaud.json()
        assert [s["nom"] for s in (await A.get(route, params={"q": "reunion"})).json()["competences"]] == ["competences/compte-rendu"], "sans accent, et par la description"
        assert [s["nom"] for s in (await A.get(route, params={"q": "gmail"})).json()["competences"]] == ["productivity/google-workspace"]
        assert "texte" not in froid.text, "jamais le texte d'une compétence : seulement de quoi la choisir"
    async with client(carla) as C:
        assert (await C.get(route)).status_code == 200, "un invité qui peut parler à l'agent voit de quoi l'appeler"
    async def broken(agent_id, action, body=None, timeout=90):
        raise RuntimeError("machine arrêtée")
    machine.admin = broken
    machine._lus.clear()
    async with client(alice) as A:
        r = await A.get(route)
        assert r.status_code == 200 and r.json() == {"competences": [], "indisponible": True}, r.text
    machine.admin = admin
    machine._lus.clear()
    print("compétences : filtrées par titre, nom et description, la désactivée dite telle, servies du cache sous 100 ms")


def token(kind, label, ref):
    from urllib.parse import quote
    return f"[{'/' if kind == 'competence' else '@'}{label}](noah:{kind}/{quote(ref, safe='/')})"


async def contexte():
    plan, dossier = token("fichier", "plan.md", "outputs/plan.md"), token("dossier", "rapport", "outputs/rapport")
    text = f"Relis {plan} et {dossier}, puis dis à {token('agent', 'Marie', 'a2')} de s'en servir. {token('competence', 'Compte rendu de réunion', 'competences/compte-rendu')}"
    got = mentions.contexte(alice, "a1", text)
    assert "/opt/data/workspace/outputs/plan.md" in got and "/opt/data/workspace/outputs/rapport/" in got, got
    assert "noah.py demander a2" in got and "« Marie »" in got, got
    assert 'skill_view (name="compte-rendu")' in got, "la compétence se charge par son nom court, la voie qu'Hermes connaît"
    assert got.startswith("[") and got.endswith("]\n\n")
    assert mentions.contexte(alice, "a1", "Bonjour, écris à a@b.c et lis /home/user") == "", "sans pastille, rien ne s'ajoute"
    assert mentions.contexte(alice, "a1", token("fichier", "x", "../../etc/passwd")) == "", "un chemin qui sort de l'espace de travail n'est pas transmis"
    assert mentions.contexte(alice, "a1", token("fichier", "x", "/etc/passwd")).count("/opt/data/workspace/etc/passwd") == 1, "un chemin absolu reste sous l'espace de travail"
    assert "\x00" not in mentions.contexte(alice, "a1", token("fichier", "x", "a\x00b"))
    # Un agent qu'on ne voit pas n'entre jamais dans ce que l'agent lit, ni son nom, ni son numéro.
    caché = mentions.contexte(carla, "a1", f"{token('agent', 'Marie', 'a2')} {token('agent', 'Chloé', 'c1')}")
    assert "a2" not in caché and "Marie" not in caché, caché
    assert "« Chloé » (id c1)" in caché and "demander c1" not in caché, "invitée : rien à confier à un collègue depuis une conversation partagée"
    assert mentions.contexte(alice, "a1", token("agent", "Noah", "a1")) == "", "citer l'agent du fil lui-même n'apprend rien"
    # Une compétence désactivée ne se commande pas.
    async with client(alice) as A:
        await A.get("/api/agents/a1/mentions/competences")
    off = mentions.contexte(alice, "a1", token("competence", "Facture", "apprise-seule"))
    assert "désactivée" in off and "skill_view" not in off, off
    assert mentions.lisible(text).startswith("Relis @plan.md et @rapport, puis dis à @Marie") and "noah:" not in mentions.lisible(text)
    print("contexte : fichier, dossier, agent et compétence disent quoi faire ; hors dossier, invisible, désactivée : rien d'exécutable")


async def envoi():
    """Le vrai /api/chat : le message garde ses pastilles, l'agent reçoit en plus le contexte, un invité ne reçoit pas un agent qu'il ne voit pas."""
    seen = []

    async def fake_run(agent, conv_id, prompt, details=False, context="", **kwargs):
        seen.append({"agent": agent.id, "prompt": prompt, "context": context})

        async def empty():
            yield 'data: {"type":"done"}\n\n'
        return empty()

    real = main._run
    main._run = fake_run
    try:
        plan = token("fichier", "plan.md", "outputs/plan.md")
        text = f"Résume {plan} avec {token('competence', 'Compte rendu de réunion', 'competences/compte-rendu')} et demande à {token('agent', 'Marie', 'a2')}"
        async with client(alice) as A:
            r = await A.post("/api/chat", json={"agent_id": "a1", "text": text})
            assert r.status_code == 200, r.text
        got = seen[-1]
        assert got["prompt"] == text, "le message garde ses pastilles telles quelles"
        assert "/opt/data/workspace/outputs/plan.md" in got["context"] and "noah.py demander a2" in got["context"] and 'name="compte-rendu"' in got["context"], got["context"]
        async with client(carla) as C:
            r = await C.post("/api/chat", json={"agent_id": "a1", "text": text})
            assert r.status_code == 200, r.text
        assert "a2" not in seen[-1]["context"] and "Marie" not in seen[-1]["context"], "Marie n'est pas visible par Carla"
        async with client(alice) as A:
            await A.post("/api/chat", json={"agent_id": "a1", "text": "Bonjour"})
        assert "dans son message" not in seen[-1]["context"], "sans pastille, aucun contexte de plus"
    finally:
        main._run = real
    print("envoi : le message garde ses pastilles, l'agent reçoit le contexte, l'invité ne reçoit pas un agent invisible")


asyncio.run(everything())
print("OK : citer avec @ et /, suggestions et contexte")
