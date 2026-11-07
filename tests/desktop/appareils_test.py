"""Le serveur du pont vers les appareils : qui reçoit quoi, fichiers en attente, isolation entre comptes, cache des connexions.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/desktop/appareils_test.py"
"""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = tempfile.mkdtemp()
os.environ["NOAH_DATA_DIR"] = DATA
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import access, auth, db, desktop, machine, main, mcp, push, relay  # noqa: E402

db.init()
desktop.WAIT = 0.3
desktop._BOOT = 0  # le délai après un redémarrage a son propre essai, à la fin
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
AGENT_A, AGENT_B = "agent-alice", "agent-bruno"
with db.connect() as c:
    for agent_id, owner in ((AGENT_A, ALICE), (AGENT_B, BRUNO)):
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES (?, ?, ?, ?, ?)", (agent_id, agent_id.title(), "", "k", owner))


# Un vrai serveur, une seule boucle : les demandes attendent dans des files que d'autres requêtes viennent remplir.
PORT = 18473
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(100):
    if server.started:
        break
    time.sleep(0.1)
assert server.started, "le serveur de test ne démarre pas"
BASE = f"http://127.0.0.1:{PORT}"


def session(user: int, name: str, platform: str = "desktop") -> tuple[str, str]:
    token = auth.new_session(user, name, platform)
    return token, auth.device_id(auth.digest(token))


def client(token: str) -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=30)


def agent(agent_id: str) -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {relay.token_for(agent_id)}"}, timeout=30)


BUREAU_1, D1 = session(ALICE, "Bureau")
BUREAU_2, D2 = session(ALICE, "Portable")
TEL, D3 = session(ALICE, "Téléphone", "android")
BUREAU_B, DB = session(BRUNO, "Bureau de Bruno")
web1, web2, tel, webb = client(BUREAU_1), client(BUREAU_2), client(TEL), client(BUREAU_B)
a, b = agent(AGENT_A), agent(AGENT_B)
relay_agent_ok = a.get("/agent-api/appareils")
assert relay_agent_ok.status_code == 200, relay_agent_ok.text


def beat(c, dossiers=()):
    r = c.post("/api/desktop/battement", json={"os": "win32", "dossiers": list(dossiers), "coupe": False})
    assert r.status_code == 200, r.text
    return r.json()


def next_item(c):
    r = c.get("/api/desktop/next", params={"os": "win32"})
    return r.json() if r.status_code == 200 else None


def in_thread(fn, *args):
    out = {}
    def run():
        out["r"] = fn(*args)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, out


def answer_when_asked(c, reply):
    """Fait l'application de bureau : attend une demande et y répond."""
    def run():
        for _ in range(40):
            item = next_item(c)
            if item:
                c.post(f"/api/desktop/result/{item['id']}", json=reply(item))
                return item
        return None
    return in_thread(run)


# 1. Présence et liste : jamais de chemin, et jamais les appareils d'un autre.
print("-- Présence et liste")
hello = beat(web1, [{"id": "d1", "nom": "Documents", "ecriture": True, "chemin": "C:\\Users\\alice\\Documents"}])
assert hello["compte"] and str(ALICE) != hello["compte"], hello
assert desktop.connected(ALICE) and not desktop.connected(BRUNO)
seen = a.get("/agent-api/appareils").json()["appareils"]
by_id = {d["id"]: d for d in seen}
assert {D1, D2, D3} <= set(by_id) and DB not in by_id, seen
assert by_id[D1]["en_ligne"] and not by_id[D2]["en_ligne"], by_id
assert by_id[D1]["dossiers"] == [{"id": "d1", "nom": "Documents", "ecriture": True, "absent": False}], by_id[D1]
assert "alice\\\\Documents" not in json.dumps(seen) and "chemin" not in json.dumps(seen), "le chemin ne doit jamais arriver au serveur ni à l'agent"
assert "ip" not in by_id[D1] and "depuis" not in by_id[D1]
own = web1.get("/api/devices").json()["appareils"]
assert any(d["actuel"] and d["en_ligne"] for d in own) and all("en_ligne" in d for d in own), own
print("1. l'agent voit ses appareils en ligne, les dossiers sans leur chemin, rien d'un autre compte")

# 2. Le bon ordinateur reçoit, et lui seul.
print("-- Choix de l'appareil")
beat(web2)
r = a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "Documents"}).json()
assert "Plusieurs ordinateurs" in r["erreur"] and D1 in r["erreur"] and D2 in r["erreur"], r
t, got = answer_when_asked(web1, lambda item: {"ok": True, "elements": [], "vu": item["action"]})
r = a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "Documents", "appareil": D1}).json()
t.join(10)
assert r.get("vu") == "lister", r
assert next_item(web2) is None, "l'autre ordinateur ne reçoit rien"
t, got = answer_when_asked(web2, lambda item: {"ok": True, "qui": "portable"})
r = a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "x", "appareil": "PORTABLE"}).json()
t.join(10)
assert r.get("qui") == "portable", r
print("2. deux ordinateurs : l'agent doit choisir ; par identifiant ou par nom, seul celui-là reçoit")

# 3. Isolation : l'identifiant d'un appareil d'un autre compte ne sert à rien.
print("-- Isolation")
beat(webb)
r = a.post("/agent-api/ordinateur", json={"action": "notifier", "titre": "x", "appareil": DB}).json()
assert "Aucun ordinateur" in r["erreur"] and "Bruno" not in r["erreur"], r
assert next_item(webb) is None
r = a.post("/agent-api/notifier", json={"titre": "x", "appareil": DB}).json()
assert "Aucun appareil" in r["erreur"] and "Bruno" not in r["erreur"], r
r = a.post(f"/agent-api/ordinateur/ecrire?dossier=d&chemin=f.txt&appareil={DB}", content=b"x").json()
assert "Aucun ordinateur" in r["erreur"], r
assert not list(Path(DATA, "attente").glob("*")) if Path(DATA, "attente").exists() else True
# Un agent invité ne reçoit rien non plus.
real_guest = access.guest_task
access.guest_task = lambda agent_id: True
for call in (lambda: a.get("/agent-api/appareils"), lambda: a.post("/agent-api/notifier", json={"titre": "x"}),
             lambda: a.post("/agent-api/ordinateur", json={"action": "notifier", "titre": "x"}),
             lambda: a.post("/agent-api/ordinateur/lire", json={"dossier": "d", "chemin": "f"}),
             lambda: a.post("/agent-api/ordinateur/ecrire?dossier=d&chemin=f", content=b"x")):
    assert "partagé" in call().json().get("erreur", "")
access.guest_task = real_guest
# Une demande de l'agent d'Alice, la réponse d'un autre : refusée.
t, got = in_thread(lambda: a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "d", "appareil": D1}).json())
item = None
for _ in range(40):
    item = next_item(web1)
    if item:
        break
assert item
for other in (webb, web2):
    assert other.post(f"/api/desktop/result/{item['id']}", json={"ok": True, "faux": True}).status_code == 404
    assert other.get(f"/api/desktop/encore/{item['id']}").status_code == 404
    assert other.post(f"/api/desktop/piece/{item['id']}", content=b"x").status_code == 404
assert web1.get(f"/api/desktop/encore/{item['id']}").status_code == 200
web1.post(f"/api/desktop/result/{item['id']}", json={"ok": True, "vrai": True})
t.join(10)
assert got["r"].get("vrai"), got
assert web1.get(f"/api/desktop/encore/{item['id']}").status_code == 404, "une demande finie n'attend plus d'accord"
print("3. autre compte : ni son appareil, ni ses réponses ; profil invité : rien ; demande finie : plus d'accord possible")

# 4. Lire un fichier : il revient à l'agent, une seule fois, et n'en reste aucune trace.
print("-- Lecture")
contenu = b"contenu binaire \x00\xff" * 100


def read_answer():
    for _ in range(40):
        item = next_item(web1)
        if item:
            assert item["action"] == "lire" and item["chemin"] == "note.bin"
            assert web1.post(f"/api/desktop/piece/{item['id']}", content=contenu).status_code == 200
            web1.post(f"/api/desktop/result/{item['id']}", json={"ok": True, "nom": "note.bin"})
            return


t, _ = in_thread(read_answer)
r = a.post("/agent-api/ordinateur/lire", json={"dossier": "d1", "chemin": "note.bin", "appareil": D1})
t.join(10)
assert r.content == contenu and r.headers["content-type"].startswith("application/octet-stream"), r.text[:200]
time.sleep(0.2)
assert not list(Path(DATA, "attente").glob("lu-*")), "le fichier lu ne reste pas sur le serveur"
t, _ = answer_when_asked(web1, lambda item: {"refuse": True, "message": "Fichier sensible"})
r = a.post("/agent-api/ordinateur/lire", json={"dossier": "d1", "chemin": ".env", "appareil": D1}).json()
t.join(10)
assert r.get("refuse"), r
print("4. lire : le fichier arrive entier à l'agent, sans trace sur le serveur ; un refus de l'ordinateur revient tel quel")

# 5. Ordinateur éteint : le fichier attend, survit à un redémarrage, et n'arrive qu'une fois au bon endroit.
print("-- Fichier en attente")
sent = []
real_notify = push.notify
push.notify = lambda title, text, **k: sent.append((title, text, k.get("user_id")))
desktop._seen.clear()
desktop.WRITE_ANSWER = 0.5
data = b"resultat de routine"
r = a.post(f"/agent-api/ordinateur/ecrire?dossier=Documents&chemin=rapports/lundi.txt&appareil={D1}", content=data).json()
assert r.get("attente") and r.get("id"), r
rid = r["id"]
stored = Path(DATA, "attente", rid)
assert stored.read_bytes() == data and sent and sent[-1][2] == ALICE and "lundi.txt" in sent[-1][1], sent
# Le serveur redémarre.
desktop._waiting.clear()
desktop._sending.clear()
beat(web2)
assert next_item(web2) is None, "l'autre ordinateur du compte ne reçoit pas ce fichier"
beat(webb)
assert next_item(webb) is None
assert webb.get(f"/api/desktop/piece/{rid}").status_code == 404 and web2.get(f"/api/desktop/piece/{rid}").status_code == 404
beat(web1)
item = next_item(web1)
assert item and item["id"] == rid and item["action"] == "ecrire" and item["sha256"] == hashlib.sha256(data).hexdigest() and item["dossierId"] == "Documents", item
assert web1.get(f"/api/desktop/piece/{rid}").content == data
assert next_item(web1) is None, "pas de doublon pendant la livraison"
# L'accès est coupé : il attend encore.
web1.post(f"/api/desktop/result/{rid}", json={"coupe": True})
assert stored.exists()
desktop._sending[rid] = 0
item = next_item(web1)
assert item and item["id"] == rid, "repart plus tard"
# Livré : plus rien.
web1.post(f"/api/desktop/result/{rid}", json={"ok": True, "chemin": "rapports/lundi.txt"})
assert not stored.exists() and desktop._pending_row(rid) is None
assert web1.get(f"/api/desktop/piece/{rid}").status_code == 404
# Refusé alors que personne n'attend : la personne l'apprend, le fichier ne revient pas sans fin.
r = a.post(f"/agent-api/ordinateur/ecrire?dossier=Documents&chemin=x.txt&appareil={D1}", content=b"x").json()
desktop._waiting.clear()
item = next_item(web1) or {"id": r["id"]}
desktop._sending[r["id"]] = time.time()
sent.clear()
web1.post(f"/api/desktop/result/{r['id']}", json={"refuse": True, "message": "Ce dossier n'est plus confié"})
assert desktop._pending_row(r["id"]) is None and sent and "plus confié" in sent[-1][1], sent
print("5. ordinateur éteint : téléphone prévenu, fichier gardé après redémarrage, livré au seul bon appareil, une fois")

# 6. Limites et expiration.
print("-- Limites")
real_max, real_pending = desktop.MAX_FILE, desktop.MAX_PENDING
desktop.MAX_FILE = 10
r = a.post(f"/agent-api/ordinateur/ecrire?dossier=d&chemin=g.bin&appareil={D1}", content=b"x" * 11).json()
assert "trop gros" in r.get("erreur", ""), r
desktop.MAX_FILE, desktop.MAX_PENDING = real_max, 20
desktop._seen.clear()
first = a.post(f"/agent-api/ordinateur/ecrire?dossier=d&chemin=a.bin&appareil={D1}", content=b"x" * 15).json()
over = a.post(f"/agent-api/ordinateur/ecrire?dossier=d&chemin=b.bin&appareil={D1}", content=b"x" * 15).json()
assert first.get("attente") and "trop gros" in over.get("erreur", ""), (first, over)
assert not any(p.stat().st_size == 15 and p.name != first["id"] for p in Path(DATA, "attente").iterdir()), "un refus ne laisse rien"
desktop.MAX_PENDING = real_pending
with db.connect() as c:
    c.execute("UPDATE desktop_attente SET expire = ? WHERE id = ?", ((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(), first["id"]))
sent.clear()


desktop.sweep()
assert desktop._pending_row(first["id"]) is None and not Path(DATA, "attente", first["id"]).exists() and sent and "7 jours" in sent[-1][1], sent
print("6. 50 Mo et 500 Mo : refus clair, rien de laissé ; après 7 jours : retiré, et la personne le sait")

# 7. Notification ciblée : le téléphone seul.
print("-- Notification ciblée")
delivered = []


async def fake_send(title, text, url="/", urgent=False, user_id=None, session=None, extra=None):
    delivered.append({"user": user_id, "session": session})
    return {"livres": 1, "echecs": 0, "morts": 0, "differes": 0}


real_send = push.send
push.send = fake_send
beat(web1)
while next_item(web1):
    pass
r = a.post("/agent-api/notifier", json={"titre": "Prêt", "texte": "ok", "appareil": D3}).json()
assert r.get("ok") and delivered == [{"user": ALICE, "session": auth.digest(TEL)}], (r, delivered)
assert next_item(web1) is None, "l'ordinateur en ligne ne reçoit rien quand le téléphone est visé"
r = a.post("/agent-api/notifier", json={"titre": "Prêt", "texte": "ok", "appareil": D1}).json()
item = next_item(web1)
assert r.get("ok") and item and item["action"] == "notifier" and len(delivered) == 1, (r, item, delivered)


async def nobody(*args, **kwargs):
    return {"livres": 0, "echecs": 0, "morts": 0, "differes": 0}


push.send = nobody
r = a.post("/agent-api/notifier", json={"titre": "Prêt", "appareil": D3}).json()
assert "ne peut pas recevoir" in r["erreur"], r
push.send = real_send
sent.clear()
r = a.post("/agent-api/notifier", json={"titre": "Partout"}).json()
assert r.get("ok") and sent and sent[-1][2] == ALICE and next_item(web1)["titre"] == "Partout", (r, sent)
push.notify = real_notify
print("7. le téléphone seul quand il est visé, l'ordinateur seul quand il l'est, partout sans précision ; un échec se dit")

# 8. Application ancienne : l'agent le sait au lieu d'attendre.
print("-- Application ancienne")
desktop._seen.clear()
OLD, DOLD = session(BRUNO, "Vieux")
old = client(OLD)
assert next_item(old) is None
r = b.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "d", "appareil": DOLD}).json()
assert "trop ancienne" in r["erreur"], r
print("8. application d'avant les dossiers : l'agent reçoit une réponse claire, et « notifier » marche encore")
t, _ = answer_when_asked(old, lambda item: {"ok": True})
r = b.post("/agent-api/ordinateur", json={"action": "notifier", "titre": "x", "appareil": DOLD}).json()
t.join(10)
assert r.get("ok"), r

# 9. Cache des connexions : tout de suite la seconde fois, oublié dès qu'une chose change.
print("-- Cache des connexions")
reads = []


async def fake_admin(agent_id, action, body=None, timeout=90):
    reads.append(action)
    return {"connecte": False} if action == "google" else {"applications": [{"nom": "notion", "installe": False}], "personnels": {}}


real_admin = machine.admin
machine.admin = fake_admin
alice_web = client(BUREAU_1)
url = f"/api/agents/{AGENT_A}/connections"
machine._connections.clear()
first = alice_web.get(url).json()
count = len(reads)
assert first["applications"][0]["nom"] == "notion" and count == 2, reads
second = alice_web.get(url).json()
assert len(reads) == count and "age" not in second, "lue en mémoire, sans déranger l'agent"
assert webb.get(url).status_code in (403, 404), "le cache ne contourne pas le contrôle d'accès"
machine._connections[AGENT_A] = (time.time() - 3600, machine._connections[AGENT_A][1])
old_answer = alice_web.get(url).json()
assert old_answer.get("age", 0) >= 3600 and len(reads) == count, "vieille : rendue tout de suite, avec son âge"
assert alice_web.get(url, params={"frais": 1}).json().get("age") is None and len(reads) == count + 2
count = len(reads)
mcp.tell_agent(AGENT_A, "notion", [])
alice_web.get(url)
assert len(reads) == count + 2, "une connexion arrivée oublie la réponse gardée"
count = len(reads)
mcp.forget(AGENT_A, "notion")
alice_web.get(url)
assert len(reads) == count + 2, "une connexion retirée aussi"
# Une lecture commencée avant un changement ne remet pas l'ancien état en mémoire.
machine._connections.clear()


async def slow_read():
    task = asyncio.create_task(machine._read_connections(AGENT_A))
    await asyncio.sleep(0)
    machine.forget_connections(AGENT_A)
    await task


asyncio.run(slow_read())
assert AGENT_A not in machine._connections, "ancien état remis en mémoire après un changement"
machine.admin = real_admin
print("9. connexions : immédiates, sans appel à l'agent ; relues si elles ont vieilli ; oubliées à chaque changement")

# 10. Une application coupée : ce qu'elle n'a pas reçu repart ; l'agent n'attend pas 5 minutes pour rien.
print("-- Coupures")
desktop._seen.clear()
beat(web1)
t, got = in_thread(lambda: a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "d", "appareil": D1}).json())
first_try = None
for _ in range(40):
    r = web1.get("/api/desktop/next", params={"fichiers": 1, "recu": ""})
    if r.status_code == 200:
        first_try = r.json()
        break
assert first_try
again = web1.get("/api/desktop/next", params={"fichiers": 1, "recu": ""})
assert again.status_code == 200 and again.json()["id"] == first_try["id"], "pas reçue : elle repart"
none = web1.get("/api/desktop/next", params={"fichiers": 1, "recu": first_try["id"]})
assert none.status_code == 204, "reçue : elle ne repart pas"
web1.post(f"/api/desktop/result/{first_try['id']}", json={"ok": True})
t.join(10)
t, got = in_thread(lambda: a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "d", "appareil": D1}).json())
time.sleep(0.5)
desktop._seen[D1]["at"] = 0  # plus de battement : application fermée, session révoquée
started = time.time()
t.join(15)
assert "déconnecté" in got.get("r", {}).get("erreur", "") and time.time() - started < 8, got
print("10. une demande non reçue repart ; un ordinateur disparu se dit en quelques secondes, pas après 5 minutes")

# 11. Ce qui reste sans propriétaire ne reste pas.
print("-- Nettoyage")
orphan = Path(DATA, "attente", "orphelin")
orphan.write_bytes(b"x" * 100)
os.utime(orphan, (time.time() - 7200, time.time() - 7200))
young = Path(DATA, "attente", "tout-jeune")
young.write_bytes(b"x")
desktop.sweep()
assert not orphan.exists() and young.exists(), "un transfert en cours n'est pas emporté"
young.unlink()
PARTI, DPARTI = session(ALICE, "Vieux portable")
desktop._seen.clear()
r = a.post(f"/agent-api/ordinateur/ecrire?dossier=d&chemin=vieux.txt&appareil={DPARTI}", content=b"x").json()
assert r.get("attente"), r
assert auth.revoke_device(ALICE, DPARTI)
sent2 = []
real_notify2 = push.notify
push.notify = lambda title, text, **k: sent2.append(text)
desktop.sweep()
push.notify = real_notify2
assert desktop._pending_row(r["id"]) is None and not Path(DATA, "attente", r["id"]).exists() and sent2 and "déconnecté" in sent2[-1], sent2
print("11. un transfert coupé ne laisse rien ; un appareil retiré emporte ses fichiers, et la personne le sait")

# 12. Un agent partagé en admin n'atteint aucun appareil : ce profil a la main sur lui.
print("-- Partage")
with db.connect() as c:
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, 'admin')", (AGENT_A, BRUNO))
beat(web1)
for call in (lambda: a.get("/agent-api/appareils"), lambda: a.post("/agent-api/notifier", json={"titre": "x"}),
             lambda: a.post("/agent-api/ordinateur", json={"action": "notifier", "titre": "x"}),
             lambda: a.post("/agent-api/ordinateur/lire", json={"dossier": "d", "chemin": "f"}),
             lambda: a.post("/agent-api/ordinateur/ecrire?dossier=d&chemin=f", content=b"x")):
    assert "partagé" in call().json().get("erreur", "")
with db.connect() as c:
    c.execute("DELETE FROM agent_shares WHERE agent_id = ?", (AGENT_A,))
assert a.get("/agent-api/appareils").json().get("appareils")
print("12. partagé en admin : aucun appareil du propriétaire ; le partage retiré, tout revient")

# 13. Juste après un redémarrage : pas de faux « application fermée » pendant que les applications reviennent.
print("-- Redémarrage")
desktop._seen.clear()
desktop._BOOT = time.time()
t, got = in_thread(lambda: a.post("/agent-api/ordinateur", json={"action": "lister", "dossier": "d", "appareil": D1}).json())
time.sleep(1.5)
assert "r" not in got, "l'agent ne reçoit pas de fausse panne"
beat(web1)
t2, _ = answer_when_asked(web1, lambda item: {"ok": True, "revenu": True})
t.join(15)
assert got["r"].get("revenu"), got
desktop._BOOT = 0
print("13. après un redémarrage, l'agent attend le retour de l'application au lieu de la dire fermée")

server.should_exit = True
print("\nAppareils et dossiers, côté serveur : tout tient.")
