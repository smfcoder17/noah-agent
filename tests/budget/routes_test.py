"""Budget B4 (docs/epics/0.4.0/socle.md, section 6) : la durée des routes GET d'une liste, sur une base remplie, avec un lanceur lent.

Vrai serveur (toutes les routes, tout l'intergiciel), vraie base : 3 agents, 5 000 messages, 500 lignes de journal, 20 000 lignes
d'`usage` sur 15 jours, 200 tâches confiées. Le lanceur est un petit serveur HTTP qui répond après 1,5 s : seule une route qui ne
l'attend pas tient le budget. La durée lue est l'en-tête `Server-Timing: app;dur=<ms>` de la réponse (main.server_timing), pas
l'horloge du test. 20 appels par route, l'un après l'autre.

Seuils (X23) : 95e centile sous 300 ms à chaud, maximum sous 1 000 ms. La route d'ouverture (X22, pas S6) : sous 150 ms.
Cliquet (tools/eval/budgets.json) : un budget non bloquant dont le seuil n'est pas atteint réussit en « ROUGE attendu », sauf si
la mesure est pire que celle gardée (plus la tolérance du budget, pour les millisecondes). Même logique que tools/eval/cliquet.mjs.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" -v "$PWD/tools:/tools:ro" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/budget/routes_test.py"

`NOAH_ECRIRE=1` n'écrit rien : il imprime les lignes à coller dans budgets.json.
"""
import asyncio
import http.server
import json
import math
import os
import re
import sys
import tempfile
import threading
import time

DELAI_LANCEUR = 1.5
APPELS = 20


class Lanceur(http.server.BaseHTTPRequestHandler):
    """Le lanceur des agents : lent, et qui répond toujours « rien à signaler »."""

    def _repondre(self):
        taille = int(self.headers.get("content-length") or 0)
        if taille:
            self.rfile.read(taille)
        time.sleep(DELAI_LANCEUR)
        corps = b"{}"
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    do_GET = do_POST = do_PUT = do_DELETE = _repondre

    def log_message(self, *args):
        pass


serveur_lanceur = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Lanceur)
threading.Thread(target=serveur_lanceur.serve_forever, daemon=True).start()

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["LAUNCHER_URL"] = f"http://127.0.0.1:{serveur_lanceur.server_port}"
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, db, main, watch  # noqa: E402

db.init()
watch.init()  # créé au démarrage du serveur (main.startup), que ce test ne lance pas
alice = auth.create_user("alice", "motdepasse-essai")
AGENTS = ["a1", "a2", "a3"]
with db.connect() as c:
    for numero, agent in enumerate(AGENTS):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, '', ?, ?)", (agent, f"Agent {numero + 1}", f"k{numero}", alice))
db.set_setting("provider", "openrouter")
db.set_setting("onboarded", "1")
CONVERSATIONS = {}
for agent in AGENTS:
    cree = main._new_conversation(alice, agent, "Conversation", main=True)
    CONVERSATIONS[agent] = cree["id"] if isinstance(cree, dict) else cree

with db.connect() as c:
    c.executemany(
        "INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?, ?, ?, datetime('now', ?))",
        [(CONVERSATIONS[AGENTS[i % 3]], "user" if i % 2 == 0 else "agent", f"Message {i} : " + "du texte pour remplir. " * 8, f"-{5000 - i} minutes") for i in range(5000)],
    )
    c.executemany(
        "INSERT INTO journal (agent_id, conversation_id, kind, titre, resultat, etat, at) VALUES (?, ?, 'tache', ?, ?, 'fini', ?)",
        [("a1", CONVERSATIONS["a1"], f"Travail {i}", "Fait. " * 20, time.time() - (500 - i) * 600) for i in range(500)],
    )
    c.executemany(
        "INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, cached_tokens, conversation_id, owner_id, created_at) "
        "VALUES (?, ?, ?, 100, 0.002, 0, ?, ?, datetime('now', ?))",
        [(AGENTS[i % 3], ("modele-a", "modele-b", "modele-c", "modele-d")[i % 4], 1000 + i % 500, CONVERSATIONS[AGENTS[i % 3]], alice, f"-{(i * 15 * 24 * 60) // 20000} minutes") for i in range(20000)],
    )
    c.executemany(
        "INSERT INTO delegations (id, de, vers, conversation_id, profondeur, chaine, rappeler, etat, consigne, created_at) VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, ?)",
        [(f"d{i:04d}", "a1", "a2", CONVERSATIONS["a2"], '["a1"]', ("fini", "en_cours", "echec")[i % 3], f"Consigne {i}", time.time() - (200 - i) * 3600) for i in range(200)],
    )

A, C = "a1", CONVERSATIONS["a1"]
# Les listes qu'ouvre la personne : un agent, ses fils, l'écran d'un agent, les Réglages. Chemins relevés dans docs/epics/0.4.0/socle.md, 1.5 et 5.3.
ROUTES = [
    "/api/agents",
    f"/api/agents/{A}/conversations",
    f"/api/conversations/{C}/messages?limit=60",
    f"/api/conversations/{C}/en-cours",
    f"/api/agents/{A}/appel",
    f"/api/agents/{A}/taches-confiees",
    f"/api/agents/{A}/routines",
    f"/api/agents/{A}/activite",
    f"/api/agents/{A}/computer",
    f"/api/agents/{A}/memory",
    f"/api/agents/{A}/competences",
    f"/api/agents/{A}/connections",
    f"/api/agents/{A}/files",
    f"/api/agents/{A}/watches",
    f"/api/agents/{A}/proactif",
    "/api/me",
    "/api/me/interface",
    "/api/a-toi",
    "/api/accords",
    "/api/calls/pending",
    "/api/usage",
    "/api/modes/cerveau/modeles",
    "/api/fournisseurs",
    "/api/decision",
    "/api/model",
    "/api/modele-rapide",
    "/api/updates",
    "/api/goals",
    "/api/profiles",
    "/api/devices",
]
OUVERTURE = f"/api/agents/{A}/ouverture?limit=60"


def centile(valeurs: list[float], p: float) -> float:
    rang = sorted(valeurs)
    return rang[max(0, math.ceil(len(rang) * p) - 1)]


async def mesurer(client: httpx.AsyncClient, chemin: str) -> dict:
    durees, statuts = [], set()
    for _ in range(APPELS):
        r = await client.get(chemin)
        statuts.add(r.status_code)
        m = re.search(r"app;dur=([\d.]+)", r.headers.get("server-timing", ""))
        assert m, f"{chemin} : pas d'en-tête Server-Timing ({dict(r.headers)})"
        durees.append(float(m.group(1)))
    return {"p95": round(centile(durees, 0.95)), "max": round(max(durees)), "statuts": sorted(statuts)}


def nom(chemin: str) -> str:
    """Le nom d'une route dans budgets.json : sans requête, l'agent et la conversation remplacés par leur gabarit."""
    return chemin.split("?")[0].replace(f"/{A}", "/{agent}").replace(f"/{C}", "/{conversation}")


def cliquet(budgets: dict, cle: str, valeur: float) -> tuple[bool, str]:
    b = budgets["budgets"].get(cle)
    if b is None:
        return False, f"ÉCHEC  {cle} : absent de tools/eval/budgets.json"
    dit = f"{cle} : {valeur} ms pour un seuil de {b['seuil']} ms"
    if valeur <= b["seuil"]:
        return True, f"VERT   {dit}"
    if b["bloquant"]:
        return False, f"ÉCHEC  {dit} (bloquant)"
    if b["mesure"] is None:
        return True, f"ROUGE attendu : {dit} (aucune mesure gardée)"
    if valeur > b["mesure"] + b.get("tolerance", 0):
        return False, f"ÉCHEC  régression sur {dit} : pire que la mesure gardée ({b['mesure']} ms, tolérance {b.get('tolerance', 0)})"
    return True, f"ROUGE attendu : {dit}"


async def main_test():
    with open(os.environ.get("NOAH_BUDGETS", "/tools/eval/budgets.json"), encoding="utf-8") as f:
        budgets = json.load(f)
    jeton = auth.new_session(alice, "Banc des routes")
    ok, lignes, mesures = True, [], {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url="http://test", headers={"authorization": f"Bearer {jeton}"}, timeout=60) as client:
        for chemin in ROUTES:
            mesures[chemin] = await mesurer(client, chemin)
            m = mesures[chemin]
            print(f"       {chemin.split('?')[0]:42} p95 {m['p95']:5} ms  max {m['max']:5} ms  statuts {m['statuts']}", flush=True)
        # Une durée dépend de la charge du poste : une route qui échoue est remesurée, deux fois au plus, et la meilleure passe compte.
        # Une vraie régression échoue aux trois passes ; un à-coup du poste, non.
        for chemin in ROUTES:
            for _ in range(2):
                m = mesures[chemin]
                if all(cliquet(budgets, f"B4.{nom(chemin)}.{quoi}_ms", m[quoi])[0] for quoi in ("p95", "max")):
                    break
                autre = await mesurer(client, chemin)
                mesures[chemin] = {"p95": min(m["p95"], autre["p95"]), "max": min(m["max"], autre["max"]), "statuts": sorted(set(m["statuts"]) | set(autre["statuts"]))}
                print(f"       remesuré : {chemin.split('?')[0]:32} p95 {mesures[chemin]['p95']:5} ms  max {mesures[chemin]['max']:5} ms", flush=True)
        # La route d'ouverture (X22) arrive au pas S6 : tant qu'elle n'existe pas, il n'y a rien à mesurer.
        existe = (await client.get(OUVERTURE)).status_code != 404
        ouverture = await mesurer(client, OUVERTURE) if existe else None
    assert all(not any(s >= 500 for s in m["statuts"]) for m in mesures.values()), {c: m["statuts"] for c, m in mesures.items() if any(s >= 500 for s in m["statuts"])}
    sortie = {}
    for chemin, m in mesures.items():
        sortie[f"B4.{nom(chemin)}.p95_ms"], sortie[f"B4.{nom(chemin)}.max_ms"] = m["p95"], m["max"]
    if ouverture:
        sortie["B4.ouverture.p95_ms"] = ouverture["p95"]
    else:
        print("       NON MESURÉ : B4.ouverture (la route d'ouverture n'existe pas encore : pas S6)")
    if os.environ.get("NOAH_ECRIRE"):
        print(json.dumps(sortie, ensure_ascii=False, indent=1))
    for cle, valeur in sortie.items():
        bon, ligne = cliquet(budgets, cle, valeur)
        print(ligne)
        ok = ok and bon
    # Chaque route mesurée a son budget, et chaque budget de route est mesuré : une route renommée ne sort pas du contrôle sans bruit.
    attendus = {c for c in budgets["budgets"] if c.startswith("B4.") and not c.startswith("B4.ouverture")}
    assert attendus == set(sortie) - {"B4.ouverture.p95_ms"}, f"budgets.json et ROUTES ne se recouvrent pas : {sorted(attendus ^ set(sortie))}"
    assert ok, "au moins un budget de durée est pire que sa mesure gardée (voir les lignes ÉCHEC)"
    print("budget routes : OK")


asyncio.run(main_test())
