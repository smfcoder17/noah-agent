"""Routes lentes (0.4.0, S7, X23) : routines, ordinateur, mémoire et compétences d'un agent sont servis depuis un cache, sans `docker exec`.
Le lanceur est un vrai petit serveur HTTP, lent (0,4 s), qui compte ses appels. Prouve : une lecture à froid attend le lanceur, la suivante non
(en-tête Server-Timing sous 100 ms) ; `?frais=1` relit ; toute écriture vide ; la relève de chaque minute remplit la liste des routines sans
appel de plus ; `keep_machine_warm` remplit le reste ; une lecture vieille est servie puis relue en fond ; deux lectures ensemble n'en font
qu'une. Et l'activité, 50 lignes à la fois puis `avant=`, sans doublon.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/cache_machine_test.py"
"""
import asyncio
import http.server
import json
import os
import re
import sys
import tempfile
import threading
import time

DELAI = 0.4
appels: list[str] = []  # l'action de chaque appel reçu par le lanceur
REPONSES = {
    "routines": {"routines": [{"id": "r1", "name": "Veille", "enabled": True, "schedule_display": "every 60m", "prompt": "Regarde."}]},
    "ordinateur": {"disque": {"total": 10, "libre": 5, "utilise": 5}, "espace_de_travail": 1234, "paquets": []},
    "memoire": {"memory": ["Aime le thé."], "user": [], "limites": {"memory": 2200, "user": 1375}},
    "competences": {"competences": []},
    "skills_resume": {"skills": []},
    "routine_creer": {"id": "r2", "name": "Nouvelle", "enabled": True, "schedule_display": "every day at 8am", "prompt": "Fais."},
    "memoire_ecrire": {"memory": ["Aime le café."], "user": [], "limites": {"memory": 2200, "user": 1375}},
    "routines_sorties": {"sorties": [], "etats": {}, "routines": [{"id": "r1", "name": "Veille", "enabled": True, "schedule_display": "every 60m", "prompt": "Regarde."}]},
}


class Lanceur(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        taille = int(self.headers.get("content-length") or 0)
        if taille:
            self.rfile.read(taille)
        action = self.path.rsplit("/", 1)[-1]
        appels.append(action)
        time.sleep(DELAI)
        corps = json.dumps(REPONSES.get(action, {})).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    do_GET = do_PUT = do_DELETE = do_POST

    def log_message(self, *args):
        pass


serveur = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Lanceur)
threading.Thread(target=serveur.serve_forever, daemon=True).start()
os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["LAUNCHER_URL"] = f"http://127.0.0.1:{serveur.server_port}"
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, db, machine, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    for agent in ("a1", "a2"):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', 'k', ?)", (agent, agent, alice))
db.set_setting("onboarded", "1")
conv = main._new_conversation(alice, "a1", "Conversation", main=True)
conv = conv["id"] if isinstance(conv, dict) else conv


def duree(r: httpx.Response) -> float:
    m = re.search(r"app;dur=([\d.]+)", r.headers.get("server-timing", ""))
    assert m, dict(r.headers)
    return float(m.group(1))


async def everything():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url="http://test",
                                 headers={"authorization": f"Bearer {auth.new_session(alice, 'essai', 'web')}"}, timeout=30) as A:
        # 1. À froid : le lanceur est attendu une fois. Ensuite : le cache, en moins de 100 ms, et le lanceur n'est plus appelé.
        for chemin, action in (("routines", "routines"), ("computer", "ordinateur"), ("memory", "memoire"), ("competences", "competences")):
            appels.clear()
            froid = await A.get(f"/api/agents/a1/{chemin}")
            assert froid.status_code == 200 and appels == [action] and duree(froid) >= DELAI * 1000 * 0.9, (chemin, appels, duree(froid))
            for _ in range(5):
                chaud = await A.get(f"/api/agents/a1/{chemin}")
                assert chaud.status_code == 200 and chaud.json() == froid.json() and duree(chaud) < 100, (chemin, duree(chaud))
            assert appels == [action], (chemin, "le cache sert sans rien demander au lanceur", appels)
        print("1. routines, ordinateur, mémoire, compétences : une lecture à froid, puis le cache (moins de 100 ms), aucun appel de plus")

        # 2. ?frais=1 force la lecture.
        appels.clear()
        r = await A.get("/api/agents/a1/memory", params={"frais": 1})
        assert appels == ["memoire"] and duree(r) >= DELAI * 900, (appels, duree(r))
        print("2. ?frais=1 relit")

        # 3. Un autre agent a son propre cache.
        appels.clear()
        await A.get("/api/agents/a2/routines")
        assert appels == ["routines"]
        await A.get("/api/agents/a2/routines")
        assert appels == ["routines"]
        print("3. un cache par agent")

        # 4. Toute écriture le vide : créer une routine, écrire la mémoire.
        appels.clear()
        r = await A.post("/api/agents/a1/routines", json={"nom": "Nouvelle", "consigne": "Fais.", "quand": "every day at 8am"})
        assert r.status_code == 200, r.text
        assert appels == ["routine_creer"], appels
        appels.clear()
        r = await A.get("/api/agents/a1/routines")
        assert appels == ["routines"] and duree(r) >= DELAI * 900, "après une écriture de routine, la liste est relue"
        appels.clear()
        assert (await A.put("/api/agents/a1/memory", json={"cible": "memory", "entrees": ["Aime le café."]})).status_code == 200
        r = await A.get("/api/agents/a1/memory")
        assert appels == ["memoire_ecrire", "memoire"], appels
        # Une lecture partie avant l'écriture ne remplit pas le cache d'après.
        machine.oublier("a1")
        assert ("a1", "routines") not in machine._lus
        print("4. une écriture vide le cache de l'agent, et la lecture suivante est neuve")

        # 5. La relève de chaque minute remplit la liste des routines sans appel de plus : la même lecture rend les sorties et la liste.
        machine.oublier("a1")
        appels.clear()
        await machine.deliver_routines_once(main._save_message, main._main_conversation)
        assert "routines" not in appels and "routines_sorties" in appels, appels
        n = len(appels)
        r = await A.get("/api/agents/a1/routines")
        assert len(appels) == n and duree(r) < 100 and r.json()["routines"][0]["id"] == "r1", (appels, duree(r))
        assert machine.routines_connues("a1") == [{"id": "r1", "nom": "Veille"}]
        print("5. la relève remplit les routines : servies en moins de 100 ms, sans lecture de plus")

        # 6. keep_machine_warm remplit ce qui manque, un agent après l'autre, sans rien demander deux fois.
        machine.oublier("a1")
        machine.oublier("a2")
        appels.clear()
        real_sleep, tours = asyncio.sleep, []

        async def un_tour(seconds):
            tours.append(seconds)
            raise asyncio.CancelledError

        machine.asyncio.sleep = un_tour
        try:
            await machine.keep_machine_warm(lambda: ["a1", "a2"], lambda agent: True)
        except asyncio.CancelledError:
            pass
        finally:
            machine.asyncio.sleep = real_sleep
        assert sorted(appels) == sorted(["routines", "ordinateur", "memoire", "competences", "skills_resume"] * 2), appels
        appels.clear()
        for chemin in ("routines", "computer", "memory", "competences"):
            assert duree(await A.get(f"/api/agents/a2/{chemin}")) < 100
        assert not appels
        print("6. keep_machine_warm : cinq lectures par agent, puis tout est servi du cache")

        # 7. Une lecture vieille est servie tout de suite, et relue en fond pour la suivante.
        old, value = machine._lus[("a2", "ordinateur")]
        machine._lus[("a2", "ordinateur")] = (old - machine.LECTURES_GARDEES["ordinateur"] - 5, value)
        appels.clear()
        r = await A.get("/api/agents/a2/computer")
        assert duree(r) < 100 and r.json() == value, (duree(r), r.json())
        await real_sleep(DELAI + 0.3)
        assert appels == ["ordinateur"], appels
        assert time.time() - machine._lus[("a2", "ordinateur")][0] < 5, "la relecture en fond a rafraîchi le cache"
        print("7. une lecture vieille est servie tout de suite, puis relue en fond")

        # 8. Deux lectures à froid en même temps : un seul appel au lanceur.
        machine.oublier("a2")
        appels.clear()
        a, b = await asyncio.gather(A.get("/api/agents/a2/memory"), A.get("/api/agents/a2/memory"))
        assert a.status_code == b.status_code == 200 and appels == ["memoire"], appels
        print("8. deux écrans qui demandent ensemble : une seule lecture")

        # 9. L'activité : 50 lignes, puis `avant=`, sans doublon, le plus récent d'abord ; un titre d'avant la 0.4.0 n'a plus sa marque.
        with db.connect() as c:
            c.executemany("INSERT INTO journal (agent_id, conversation_id, kind, titre, resultat, etat, at) VALUES ('a1', ?, 'tache', ?, 'Fait.', 'fait', ?)",
                          [(conv, f"Travail {i}", time.time() - (130 - i) * 60) for i in range(130)])
            c.execute("INSERT INTO journal (agent_id, conversation_id, kind, titre, resultat, etat, at) VALUES ('a1', ?, 'tache', 'De lui-même : Réunion déplacée', 'Dit.', 'fait', ?)",
                      (conv, time.time() - 3600 * 24))
        r = await A.get("/api/agents/a1/activite")
        page = r.json()
        assert r.status_code == 200 and len(page) == 50 and [p["titre"] for p in page[:3]] == ["Réunion déplacée", "Travail 129", "Travail 128"], [p["titre"] for p in page[:3]]
        seen = list(page)
        while True:
            r = await A.get("/api/agents/a1/activite", params={"avant": seen[-1]["id"]})
            more = r.json()
            assert len(more) <= 50
            seen += more
            if len(more) < 50:
                break
        assert len(seen) == 131 and len({p["id"] for p in seen}) == 131 and [p["id"] for p in seen] == sorted((p["id"] for p in seen), reverse=True), len(seen)
        assert not any("De lui-même" in p["titre"] for p in seen), "plus de « De lui-même » à l'écran, même pour une ligne d'avant"
        assert {"id", "kind", "titre", "resultat", "etat", "at", "conversation_id", "main", "de_lui_meme"} <= set(seen[0]), set(seen[0])
        assert len((await A.get("/api/agents/a1/activite", params={"limite": 5})).json()) == 5
        print("9. activité : 50 lignes, puis `avant=`, 131 lignes lues sans doublon, forme inchangée pour les anciennes applications")
    print("OK")


asyncio.run(everything())
