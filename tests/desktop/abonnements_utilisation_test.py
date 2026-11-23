"""Utilisation des abonnements, côté serveur : ce que l'application de bureau mesure (Claude Code, ChatGPT, Grok) arrive par le battement,
est gardé en champs bornés et se lit à /api/abonnements/utilisation, pour le propriétaire seul. Prouve : la mesure revient telle
qu'envoyée ; un jeton, un e-mail ou un texte libre glissés dans l'instantané ne sont ni gardés ni rendus ; une valeur hors bornes est
écartée ; le plus récent l'emporte, et un battement sans mesure n'efface rien ; un autre compte ne voit rien ; un profil invité reçoit 403 ;
le fournisseur « Grok (ton ordinateur) » est prêt seulement quand l'ordinateur le dit connecté et permis.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/desktop/abonnements_utilisation_test.py"
"""
import json
import os
import sys
import tempfile
import threading
import time

DATA = tempfile.mkdtemp()
os.environ["NOAH_DATA_DIR"] = DATA
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, db, desktop, main  # noqa: E402

db.init()
desktop.WAIT = 0.3
desktop._BOOT = 0
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")

PORT = 18477
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(100):
    if server.started:
        break
    time.sleep(0.1)
assert server.started
BASE = f"http://127.0.0.1:{PORT}"


def client(user, name):
    return httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {auth.new_session(user, name, 'desktop')}"}, timeout=30)


pc = client(ALICE, "Bureau")
bruno = client(BRUNO, "Bruno")
CLAUDE = {"offre": "max", "modele": "claude-haiku-5-5", "mesure_le": 1_795_000_000_000, "tours": 2, "jetons": 0,
          "fenetres": [{"id": "five_hour", "pct": 7, "reset": 1_795_000_000, "etat": "permis"}, {"id": "seven_day", "pct": 42, "reset": 1_795_672_800, "etat": "permis"}]}


def beat(utilisation=None, **subs):
    r = pc.post("/api/desktop/battement", json={"os": "win32", "dossiers": [], "coupe": False,
                                                 "abonnements": {**subs, **({"utilisation": utilisation} if utilisation is not None else {})}})
    assert r.status_code == 200, r.text


# 1. Rien avant la première mesure.
r = pc.get("/api/abonnements/utilisation")
assert r.status_code == 200 and r.json()["abonnements"] == [], r.text
print("1. sans mesure, la liste est vide")

# 2. La mesure envoyée revient telle quelle, avec le nom de l'abonnement.
beat({"claude": CLAUDE})
data = pc.get("/api/abonnements/utilisation").json()
assert data["en_ligne"] is True
assert data["abonnements"] == [{"id": "claude", "nom": "Claude Code", **CLAUDE}], data
print("2. la mesure de Claude Code revient : 7 % de 5 h, 42 % de la semaine, modèle exact")

# 3. Aucun jeton, e-mail ni texte libre : champs inconnus écartés, valeurs étranges écartées.
beat({"chatgpt": {"offre": "go", "modele": "gpt-5", "mesure_le": 1_795_000_000_500, "tours": 3, "jetons": 51, "access_token": "acces-secret", "email": "alice@exemple.fr",
                  "fenetres": [{"id": "thirty_day", "pct": 9, "reset": 1_795_700_000, "etat": "permis", "jeton": "refresh-secret"},
                               {"id": "a b c", "pct": 5}, {"id": "x", "pct": 250, "etat": "pirate"}, {"id": "y", "pct": "beaucoup"}, "texte libre"]},
      "grok": {"offre": "Bearer abc.def.ghi", "modele": "grok 4 !", "mesure_le": 1_795_000_000_600, "tours": 4, "jetons": 400, "fenetres": []}})
raw = json.dumps(pc.get("/api/abonnements/utilisation").json())
for secret in ("acces-secret", "refresh-secret", "alice@exemple.fr", "Bearer", "abc.def"):
    assert secret not in raw, secret
assert secret not in (db.get_setting(f"abonnements_utilisation:{ALICE}") or "")
by_id = {a["id"]: a for a in pc.get("/api/abonnements/utilisation").json()["abonnements"]}
assert [(w["id"], w["pct"], w["etat"]) for w in by_id["chatgpt"]["fenetres"]] == [("thirty_day", 9.0, "permis"), ("x", None, "permis"), ("y", None, "permis")], by_id["chatgpt"]
assert by_id["grok"]["offre"] == "" and by_id["grok"]["modele"] == "" and by_id["grok"]["tours"] == 4 and by_id["grok"]["fenetres"] == [], by_id["grok"]
assert list(by_id) == ["claude", "chatgpt", "grok"], "ordre stable"
print("3. un jeton, un e-mail, un id étrange, un pourcentage hors bornes : rien n'est gardé ni rendu")

# 4. Un battement sans mesure n'efface rien ; une mesure plus ancienne ne remplace pas la plus récente ; une plus récente remplace.
beat()
assert pc.get("/api/abonnements/utilisation").json()["abonnements"][0]["fenetres"][1]["pct"] == 42
older = {**CLAUDE, "mesure_le": CLAUDE["mesure_le"] - 1000, "fenetres": [{"id": "seven_day", "pct": 10, "reset": 1, "etat": "permis"}]}
beat({"claude": older})
assert pc.get("/api/abonnements/utilisation").json()["abonnements"][0]["fenetres"][1]["pct"] == 42
newer = {**CLAUDE, "mesure_le": CLAUDE["mesure_le"] + 1000, "fenetres": [{"id": "seven_day", "pct": 55, "reset": 1_795_672_800, "etat": "limite"}]}
beat({"claude": newer})
got = pc.get("/api/abonnements/utilisation").json()["abonnements"][0]
assert got["fenetres"] == [{"id": "seven_day", "pct": 55.0, "reset": 1_795_672_800, "etat": "limite"}], got
print("4. un battement vide garde la dernière mesure ; la plus récente gagne")

# 5. Un profil (autre compte) : 403, même avec une session valide ; son propre battement n'ouvre rien au propriétaire.
r = bruno.post("/api/desktop/battement", json={"os": "win32", "dossiers": [], "coupe": False, "abonnements": {"utilisation": {"grok": {"tours": 99, "mesure_le": 1_795_000_009_999}}}})
assert r.status_code == 200
assert bruno.get("/api/abonnements/utilisation").status_code == 403
assert pc.get("/api/abonnements/utilisation").json()["abonnements"][2]["tours"] == 4, "la mesure d'un autre compte ne remplace pas la mienne"
print("5. un profil reçoit 403, et sa mesure n'entre pas dans celle du propriétaire")

# 6. Sans session : refus.
assert httpx.get(f"{BASE}/api/abonnements/utilisation").status_code in (401, 403)
print("6. sans session : refusé")

# 7. Le fournisseur « Grok (ton ordinateur) » : prêt seulement connecté ET permis ; ses modèles sont ceux que l'ordinateur annonce.
beat(None, grok={"installe": True, "connecte": True, "permis": False, "modeles": ["grok-4.3"]})
row = next(p for p in pc.get("/api/fournisseurs").json() if p["id"] == "ordinateur:grok")
assert row["ordinateur"] is True and row["pret"] is False, row
beat(None, grok={"installe": True, "connecte": True, "permis": True, "modeles": ["grok-4.3"]})
row = next(p for p in pc.get("/api/fournisseurs").json() if p["id"] == "ordinateur:grok")
assert row["pret"] is True, row
models = desktop.pc_models("ordinateur:grok", ALICE)
assert [m["id"] for m in models] == ["grok-4.3"] and models[0]["name"] == "Grok · grok-4.3" and models[0]["abonnement"] is True, models
print("7. Grok (ton ordinateur) : prêt seulement connecté et permis, modèles annoncés par l'ordinateur")

# 8. Le nom exact du modèle réellement servi remplace l'alias dans l'Activité (« Claude Code · claude-haiku-5-5 · abonnement »).
import asyncio  # noqa: E402


async def fake_ask(device, user, item, seconds=0, agent_id=""):
    return {"ok": True, "modele": "haiku", "modele_exact": "claude-haiku-5-5", "reponse": {"choices": [], "usage": {}}}

real_ask, desktop._ask = desktop._ask, fake_ask
try:
    desktop._agent_name = lambda agent_id: "Nadine"
    status, out = asyncio.run(desktop.pc_call({"fournisseur": "ordinateur:claude-code", "appareil": "d", "user": ALICE}, "a1", {"messages": []}, "haiku"))
finally:
    desktop._ask = real_ask
assert status == 200 and out["modele"] == "claude-haiku-5-5", out
assert desktop.usage_name("ordinateur:claude-code", out["modele"]) == "Claude Code · claude-haiku-5-5 · abonnement"
print("8. l'Activité porte le nom exact du modèle servi, pas l'alias")

print("Utilisation des abonnements, côté serveur : tout tient.")
