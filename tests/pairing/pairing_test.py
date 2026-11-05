"""Appairage d'un appareil, sur le vrai serveur (FastAPI, base SQLite temporaire) : QR code et code court soumis à
l'accord de l'utilisateur avec un nombre à recopier, autorisation depuis le navigateur, essais ralentis, révocation.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" \
      -v "$PWD/frontend/src/App.tsx:/front/App.tsx:ro" -v "$PWD/mobile/www/app.js:/mobile/app.js:ro" python:3.12-slim \
      sh -c "pip install -q -r /app/requirements.txt && python /tests/pairing/pairing_test.py"
"""
import asyncio
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main  # noqa: E402

db.init()
alice, bob = auth.create_user("alice", "motdepasse-a"), auth.create_user("bob", "motdepasse-b")
ip = iter(range(1, 250))
main._ip = lambda request: request.headers.get("x-test-ip", "")  # TestClient : une seule adresse sinon


def client(token: str | None = None, addr: str | None = None) -> TestClient:
    """Un appareil : sa propre adresse (les limites sont par adresse), sa session s'il en a une."""
    c = TestClient(main.app, headers={"X-Noah-Version": "1.4.0", "X-Test-Ip": addr or f"10.0.0.{next(ip)}"})
    if token:
        c.headers["Authorization"] = f"Bearer {token}"
    return c


def reset() -> None:
    main._pairing.clear()
    main._flows.clear()
    main._failed_logins.clear()
    main._pairing_failures.clear()
    main._short_failures.clear()
    main._number_failures.clear()


def sessions() -> int:
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]


web_a = client(auth.new_session(alice, "Firefox", "web", proven=True))
web_b = client(auth.new_session(bob, "Firefox", "web", proven=True))

# 1. QR code : pas de session sans accord ; un QR filmé (partage d'écran) ne suffit pas.
reset()
p = web_a.post("/api/pairing").json()
link = p["adresse"].split("#appairage=")[1]
before = sessions()
viewer = client()
r = viewer.post("/api/pairing/claim", json={"code": link, "appareil": "Pixel 8", "type": "android"})
assert r.status_code == 200 and r.json()["attente"] and "token" not in r.json() and "set-cookie" not in r.headers, r.text
assert len(r.json()["verification"]) == 3 and sessions() == before
assert viewer.post("/api/pairing/flow/poll", json={"sondage": r.json()["sondage"]}).status_code == 202
assert client().post("/api/pairing/claim", json={"code": link}).status_code == 400
assert client().post("/api/pairing/claim", json={"code": p["code"]}).status_code == 400, "le code court du même affichage sert encore"
print("1. QR code : demande en attente sans session, à usage unique (le code court du même affichage meurt avec)")

# 2. Code court : demande que seul le propriétaire voit et accepte, avec le nombre affiché sur l'appareil.
reset()
p = web_a.post("/api/pairing").json()
phone = client()
r = phone.post("/api/pairing/claim", json={"code": p["code"].lower().replace("-", " "), "appareil": "Pixel 8", "type": "android"})
assert r.status_code == 200 and r.json()["attente"], r.text
poll, verif = r.json()["sondage"], r.json()["verification"]
pending = web_a.get("/api/pairing/pending").json()["demandes"]
assert len(pending) == 1 and pending[0]["appareil"] == "Pixel 8" and pending[0]["type"] == "android", pending
assert all("verification" not in d and "verif" not in d for d in pending), "le nombre est montré à celui qui accepte"
assert web_b.get("/api/pairing/pending").json()["demandes"] == [], "un autre compte voit la demande"
fid = pending[0]["id"]
assert web_b.get(f"/api/pairing/flow/{fid}").status_code == 404
assert web_b.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": verif}).status_code == 404, "un autre compte accepte"
before = sessions()
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": verif}).status_code == 200
assert sessions() == before, "session créée avant que l'appareil la récupère"
r = phone.post("/api/pairing/flow/poll", json={"sondage": poll})
assert r.status_code == 200 and "set-cookie" not in r.headers, r.text
token = r.json()["token"]
assert phone.post("/api/pairing/flow/poll", json={"sondage": poll}).json()["token"] == token, "deuxième session créée"
assert sessions() == before + 1
me = client(token)
dev = [d for d in me.get("/api/devices").json()["appareils"] if d["actuel"]][0]
assert (dev["nom"], dev["type"], dev["version"]) == ("Pixel 8", "android", "1.4.0"), dev
print("2. code court : demande visible et acceptable par son seul propriétaire, avec le nombre ; session créée au sondage")

# 3. Mauvais nombre : la demande est annulée (pas de seconde chance pour deviner).
reset()
p = web_a.post("/api/pairing").json()
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Inconnu"})
wrong = "100" if r.json()["verification"] != "100" else "101"
fid = web_a.get("/api/pairing/pending").json()["demandes"][0]["id"]
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": wrong}).status_code == 403
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r.json()["verification"]}).status_code == 404
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 404
assert client().post("/api/pairing/flow/poll", json={"sondage": r.json()["sondage"]}).status_code == 410
print("3. mauvais nombre recopié : demande annulée, l'appareil s'arrête")

# 4. Refus : l'appareil l'apprend et n'a rien.
reset()
p = web_a.post("/api/pairing").json()
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Inconnu"})
fid = web_a.get("/api/pairing/pending").json()["demandes"][0]["id"]
assert web_a.post(f"/api/pairing/flow/{fid}/refuser").status_code == 200
assert client().post("/api/pairing/flow/poll", json={"sondage": r.json()["sondage"]}).status_code == 410
print("4. demande refusée : pas de session, l'appareil s'arrête")

# 4 bis. « Refuser » une demande déjà accordée : refusé (404), jamais un faux « ok » alors que la session existe.
reset()
p = web_a.post("/api/pairing").json()
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Inconnu"}).json()
fid = web_a.get("/api/pairing/pending").json()["demandes"][0]["id"]
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]}).status_code == 200
assert web_a.post(f"/api/pairing/flow/{fid}/refuser").status_code == 404, "refus annoncé pour une demande accordée"
print("4 bis. refus d'une demande déjà accordée : 404")

# 5. « Nouveau code » et panneau fermé : l'ancien code et les demandes en attente ne servent plus.
reset()
old = web_a.post("/api/pairing").json()
r = client().post("/api/pairing/claim", json={"code": old["code"], "appareil": "Inconnu"})
new = web_a.post("/api/pairing").json()
assert web_a.get("/api/pairing/pending").json()["demandes"] == [], "demande en attente gardée après « Nouveau code »"
assert client().post("/api/pairing/flow/poll", json={"sondage": r.json()["sondage"]}).status_code == 410
assert client().post("/api/pairing/claim", json={"code": old["adresse"].split("#appairage=")[1]}).status_code == 400
client().post("/api/pairing/claim", json={"code": new["code"]})
assert web_a.delete("/api/pairing").status_code == 200
assert web_a.get("/api/pairing/pending").json()["demandes"] == []
print("5. nouveau code ou panneau fermé : ancien code et demandes en attente annulés")

# 6. Essais : 5 codes faux par adresse (tout le /64 en IPv6), puis 429 ; le code de Bob reste valable.
reset()
p = web_b.post("/api/pairing").json()
codes = [s for s in ("BCDF-GHJK", "BCDF-GHJL", "BCDF-GHJM", "BCDF-GHJN", "BCDF-GHJP", "BCDF-GHJR") if s != p["code"]][:5]
for i, c in enumerate(codes):
    assert client(addr=f"2001:db8:1:2::{i + 1}").post("/api/pairing/claim", json={"code": c}).status_code == 400
assert client(addr="2001:db8:1:2::99").post("/api/pairing/claim", json={"code": "BCDF-GHJQ"}).status_code == 429
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Mac de Bob", "type": "desktop"})
assert r.status_code == 200 and r.json()["attente"], "le code de Bob a été annulé par les essais d'un autre"
print("6. 5 codes faux par adresse (/64 en IPv6) puis 429 ; le code d'un autre utilisateur reste valable")

# 7. Plafond global (attaque distribuée) : 429 pour tous, sans annuler les codes.
reset()
p = web_a.post("/api/pairing").json()
main._short_failures.extend([time.time()] * main.SHORT_GLOBAL)
assert client().post("/api/pairing/claim", json={"code": p["code"]}).status_code == 429
main._short_failures.clear()
assert client().post("/api/pairing/claim", json={"code": p["code"]}).json()["attente"], "le code a été annulé"
print(f"7. {main.SHORT_GLOBAL} codes faux venus de partout : 429 pour tous, mais le vrai code reste valable")

# 8. Autorisation dans le navigateur (app de bureau) : la page d'accord montre le nombre, l'app doit le recopier.
reset()
app_desktop = client(addr="203.0.113.7")
r = app_desktop.post("/api/pairing/flow", json={"appareil": "PC du salon", "type": "desktop"}).json()
assert "verification" not in r, "le nombre est rendu à celui qui crée la demande"
fid = r["adresse"].split("#autoriser=")[1]
info = web_a.get(f"/api/pairing/flow/{fid}").json()
assert info["appareil"] == "PC du salon" and info["autre_reseau"] and len(info["verification"]) == 3, info
me_a = web_a.headers["Authorization"][7:]
assert client(me_a, addr="203.0.113.7").get(f"/api/pairing/flow/{fid}").json()["autre_reseau"] is False
assert client(me_a, addr="2001:db8::5").get(f"/api/pairing/flow/{fid}").json()["autre_reseau"] is False, "double pile"
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 200
assert app_desktop.post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).json() == {"attente": "nombre"}
before = sessions()
token = app_desktop.post("/api/pairing/flow/poll", json={"sondage": r["sondage"], "verification": info["verification"]}).json()["token"]
again = app_desktop.post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).json()["token"]
assert again == token and sessions() == before + 1, "réponse perdue : le même sondage doit relire la même session"
assert client(token).get("/api/me").status_code == 200
main._flows[next(iter(main._flows))]["expire"] = time.time() - 1
assert app_desktop.post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).status_code == 410
print("8. navigateur : nombre affiché dans la page, recopié dans l'app ; réponse relue 30 s ; double pile sans fausse alerte")

# 8 bis. Hameçonnage : un tiers crée la demande et envoie le lien ; l'utilisateur accepte, mais le tiers ne voit pas
# le nombre de la page d'accord : il ne récupère rien.
reset()
attacker = client(addr="198.51.100.9")
r = attacker.post("/api/pairing/flow", json={"appareil": "Ordinateur FRANCK-PC", "type": "desktop"}).json()
fid = r["adresse"].split("#autoriser=")[1]
web_a.get(f"/api/pairing/flow/{fid}")  # l'utilisateur ouvre la page d'accord (et voit le nombre)
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 200
guess = "100" if main._flows[fid]["verif"] != "100" else "101"
assert attacker.post("/api/pairing/flow/poll", json={"sondage": r["sondage"], "verification": guess}).status_code == 403
assert attacker.post("/api/pairing/flow/poll", json={"sondage": r["sondage"], "verification": main._flows.get(fid, {}).get("verif", "")}).status_code == 410
print("8 bis. lien d'accord envoyé par un tiers : sans le nombre de la page, pas de session (un seul essai)")

# 8 bis bis. Plusieurs liens acceptés depuis des adresses différentes : 3 nombres faux par compte, puis plus d'accord
# par navigateur pendant une heure (le plafond par adresse ne suffit pas).
reset()
for n in range(4):
    a = client(addr=f"198.51.100.{20 + n}")
    r = a.post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"}).json()
    fid = r["adresse"].split("#autoriser=")[1]
    web_a.get(f"/api/pairing/flow/{fid}")
    if n < 3:
        assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 200
        guess = "100" if main._flows[fid]["verif"] != "100" else "101"
        assert a.post("/api/pairing/flow/poll", json={"sondage": r["sondage"], "verification": guess}).status_code == 403
    else:
        assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 429, "essais illimités par compte"
assert web_b.post("/api/pairing").status_code == 200  # un autre compte n'est pas touché
print("8 bis bis. 3 nombres faux pour un même compte (adresses différentes) : accords par navigateur suspendus 1 h")

# 8 bis ter. Même attaque, mais tous les liens acceptés d'avance : le budget du compte s'applique au sondage aussi.
reset()
waiting = []
for n in range(6):
    a = client(addr=f"198.51.100.{40 + n}")
    r = a.post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"}).json()
    fid = r["adresse"].split("#autoriser=")[1]
    web_a.get(f"/api/pairing/flow/{fid}")
    assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 200
    waiting.append((a, r["sondage"], fid))
answers = []
for a, sondage, fid in waiting:
    guess = "100" if main._flows[fid]["verif"] != "100" else "101"
    answers.append(a.post("/api/pairing/flow/poll", json={"sondage": sondage, "verification": guess}).status_code)
assert answers == [403, 403, 403, 429, 429, 429], answers
print("8 bis ter. 6 liens acceptés d'avance : 3 essais, puis 429 au sondage (budget du compte)")

# 8 ter. Accord différé donné par une session ensuite révoquée (« Déconnecter tous les autres ») : il tombe avec elle.
reset()
thief_session = auth.new_session(alice, "Session volée", "web", proven=True)
thief = client(thief_session)
p = thief.post("/api/pairing").json()
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Appareil de l'attaquant"}).json()
fid = thief.get("/api/pairing/pending").json()["demandes"][0]["id"]
assert thief.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]}).status_code == 200
assert web_a.post("/api/devices/others/revoke").status_code == 200  # l'utilisateur fait le ménage
assert client().post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).status_code == 410, "accord survivant"
web_a = client(auth.new_session(alice, "Firefox", "web", proven=True))  # la révocation a aussi coupé l'ancienne session de test
print("8 ter. accord donné par une session révoquée ensuite : plus de session à récupérer (410)")

# 8 quater. Course : « Déconnecter tous les autres » pendant que l'appareil récupère sa session. Quel que soit l'ordre,
# l'attaquant ne garde aucune session valable (création et contrôle de l'approbateur en une seule écriture SQL).
import threading  # noqa: E402

leaks = 0
for i in range(40):
    reset()
    owner = auth.new_session(alice, "Propriétaire", "web", proven=True)
    stolen = auth.new_session(alice, "Session volée", "web", proven=True)
    thief = client(stolen)
    p = thief.post("/api/pairing").json()
    r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Attaquant"}).json()
    fid = thief.get("/api/pairing/pending").json()["demandes"][0]["id"]
    thief.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]})
    got = {}
    poll = threading.Thread(target=lambda: got.update(r=client().post("/api/pairing/flow/poll", json={"sondage": r["sondage"]})))
    revoke = threading.Thread(target=lambda: auth.revoke_others(alice, owner))
    for t in ((poll, revoke) if i % 2 else (revoke, poll)):
        t.start()
    poll.join()
    revoke.join()
    if got["r"].status_code == 200 and auth.still_valid(got["r"].json()["token"]):
        leaks += 1
assert leaks == 0, f"{leaks} sessions d'attaquant survivent à la révocation"
web_a = client(auth.new_session(alice, "Firefox", "web", proven=True))
print("8 quater. révocation concurrente du sondage (40 essais, deux ordres) : aucune session d'attaquant ne survit")

# 8 quinquies. Plusieurs comptes : Bob crée une demande, lit le nombre avec son compte, puis envoie le lien à Alice.
# La demande appartient à Bob dès qu'il l'a ouverte : Alice ne peut ni la voir ni l'accepter.
reset()
bob_app = client()
r = bob_app.post("/api/pairing/flow", json={"appareil": "PC d'Alice (faux)", "type": "desktop"}).json()
fid = r["adresse"].split("#autoriser=")[1]
number = web_b.get(f"/api/pairing/flow/{fid}").json()["verification"]
assert web_a.get(f"/api/pairing/flow/{fid}").status_code == 404
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code == 404
assert bob_app.post("/api/pairing/flow/poll", json={"sondage": r["sondage"], "verification": number}).status_code == 202
print("8 quinquies. plusieurs comptes : la page d'accord appartient au premier compte qui l'ouvre")

# 8 sexies. Annulation pendant qu'un appareil utilise le code : après l'annulation, aucune demande ne reste.
for i in range(40):
    reset()
    p = web_a.post("/api/pairing").json()
    claim = threading.Thread(target=lambda: client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "x"}))
    cancel = threading.Thread(target=lambda: web_a.delete("/api/pairing"))
    for t in ((claim, cancel) if i % 2 else (cancel, claim)):
        t.start()
    claim.join()
    cancel.join()
    assert web_a.get("/api/pairing/pending").json()["demandes"] == [], "demande apparue après l'annulation"
print("8 sexies. annulation concurrente d'un code en cours d'utilisation (40 essais) : aucune demande ne reste")

# 8 septies. Course entre l'accord d'Alice et l'ouverture de la page par Bob : jamais Alice n'accepte une demande dont
# Bob a lu le nombre.
for i in range(40):
    reset()
    r = client().post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"}).json()
    fid = r["adresse"].split("#autoriser=")[1]
    out = {}
    alice_t = threading.Thread(target=lambda: out.update(a=(web_a.get(f"/api/pairing/flow/{fid}").status_code,
                                                             web_a.post(f"/api/pairing/flow/{fid}/autoriser").status_code)))
    bob_t = threading.Thread(target=lambda: out.update(b=web_b.get(f"/api/pairing/flow/{fid}").status_code))
    for t in ((alice_t, bob_t) if i % 2 else (bob_t, alice_t)):
        t.start()
    alice_t.join()
    bob_t.join()
    assert not (out["a"][1] == 200 and out["b"] == 200), f"Alice a accepté une demande dont Bob a lu le nombre ({out})"
print("8 septies. accord concurrent avec l'ouverture par un autre compte (40 essais) : jamais les deux")

# 8 octies. Mauvais nombre recopié dans l'app : chaque essai compte ; au-delà du budget de l'adresse, 429.
reset()
phisher = client(addr="198.51.100.77")
codes = []
for i in range(main.LOGIN_TRIES + 2):
    r = phisher.post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"})
    codes.append(r.status_code)
    if r.status_code != 200:
        break
    fid = r.json()["adresse"].split("#autoriser=")[1]
    main._number_failures.clear()  # ici : le budget par adresse seul (celui par compte : 8 bis bis)
    web_a.get(f"/api/pairing/flow/{fid}")
    web_a.post(f"/api/pairing/flow/{fid}/autoriser")
    wrong = "100" if main._flows[fid]["verif"] != "100" else "101"
    phisher.post("/api/pairing/flow/poll", json={"sondage": r.json()["sondage"], "verification": wrong})
assert codes[-1] == 429 and len(codes) <= main.LOGIN_TRIES + 1, codes
print(f"8 octies. nombres faux recopiés : 429 après {len(codes) - 1} essais depuis la même adresse")

# 8 novies. Une connexion réussie depuis la même adresse n'efface pas le budget des nombres faux.
reset()
bob_app = client(addr="198.51.100.78")  # même adresse, sans cookie : demande et sonde
codes = []
for i in range(main.LOGIN_TRIES + 2):
    assert client(addr="198.51.100.78").post("/api/login", json={"username": "bob", "password": "motdepasse-b"}).status_code == 200
    r = bob_app.post("/api/pairing/flow", json={"appareil": "PC", "type": "desktop"})
    codes.append(r.status_code)
    if r.status_code != 200:
        break
    fid = r.json()["adresse"].split("#autoriser=")[1]
    main._number_failures.clear()  # ici : le budget par adresse seul (celui par compte : 8 bis bis)
    web_a.get(f"/api/pairing/flow/{fid}")
    web_a.post(f"/api/pairing/flow/{fid}/autoriser")
    wrong = "100" if main._flows[fid]["verif"] != "100" else "101"
    bob_app.post("/api/pairing/flow/poll", json={"sondage": r.json()["sondage"], "verification": wrong})
assert codes[-1] == 429, codes
print("8 novies. connexions réussies entre deux nombres faux : le budget d'appairage n'est pas remis à zéro")

# 9. Navigateur du téléphone (QR scanné par l'appareil photo) : la session arrive en cookie au sondage.
reset()
p = web_a.post("/api/pairing").json()
browser = client()
r = browser.post("/api/pairing/claim", json={"code": p["adresse"].split("#appairage=")[1]}).json()
fid = web_a.get("/api/pairing/pending").json()["demandes"][0]["id"]
web_a.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]})
assert browser.post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).status_code == 200
assert browser.cookies.get(auth.COOKIE) and browser.get("/api/me").status_code == 200
print("9. navigateur du téléphone : cookie posé au sondage, connecté")

# 10. Oublier : la session est révoquée sur le serveur ; un deuxième oubli ne fait pas d'erreur.
gone = client(token)
assert gone.delete("/api/devices/self").status_code == 200
assert gone.get("/api/me").status_code == 401
assert gone.delete("/api/devices/self").status_code == 200
print("10. oublier ce serveur : session supprimée côté serveur, oubli rejoué sans erreur")


# 11. Flux qui se tait (le modèle réfléchit) : la révocation le coupe quand même en quelques secondes.
async def silent():
    yield b"debut"
    await asyncio.sleep(3600)
    yield b"jamais"


async def watch(token: str) -> tuple[list, float]:
    got, t0 = [], time.monotonic()
    async for chunk in auth.revocable(silent(), token, every=0.5):
        got.append(chunk)
        auth.drop_session(token)
    return got, time.monotonic() - t0


got, took = asyncio.run(asyncio.wait_for(watch(auth.new_session(alice, "Pixel", "android")), 10))
assert got == [b"debut"] and took < 2, (got, took)
print(f"11. flux silencieux d'un appareil révoqué : coupé en {took:.1f} s")

# 12. Plus de jeton dans l'adresse (?appairage=) : ni le web ni l'app mobile ne le lisent.
for path in ("/front/App.tsx", "/mobile/app.js"):
    if os.path.exists(path):
        assert 'get("appairage")' not in open(path).read(), path
if os.path.exists("/mobile/app.js"):
    source = open("/mobile/app.js").read()
    assert source.index("window.confirm(") < source.index("await claim(link.server, link.code)"), "QR : serveur inconnu contacté sans confirmation"
print("12. jeton d'appairage jamais lu dans l'adresse (seulement le fragment) ; l'app montre le serveur avant de le contacter")

# 13. Navigateur utilisé chaque jour : le cookie est renouvelé avec la session (sinon il expire à J+30).
from datetime import datetime, timedelta, timezone  # noqa: E402

web = auth.new_session(alice, "Navigateur", "web", proven=True)
with db.connect() as c:
    old = datetime.now(timezone.utc)
    c.execute("UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token = ?",
              ((old + timedelta(days=10)).isoformat(), (old - timedelta(hours=1)).isoformat(), auth.digest(web)))
browser = TestClient(main.app)
browser.cookies.set(auth.COOKIE, web)
r = browser.get("/api/devices")
assert r.status_code == 200 and f"Max-Age={auth.SESSION_DAYS * 86400}" in r.headers.get("set-cookie", ""), r.headers
bearer = auth.new_session(alice, "Bureau", "desktop")
with db.connect() as c:
    c.execute("UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token = ?",
              ((old + timedelta(days=10)).isoformat(), (old - timedelta(hours=1)).isoformat(), auth.digest(bearer)))
r = TestClient(main.app, headers={"Authorization": f"Bearer {bearer}"}).get("/api/devices")
assert r.status_code == 200 and "set-cookie" not in r.headers, "cookie posé pour une app (Bearer)"
phone = auth.new_session(alice, "Pixel", "android")  # fenêtre de l'app Android : cookie de session, sans expiration
with db.connect() as c:
    c.execute("UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token = ?",
              ((old + timedelta(days=10)).isoformat(), (old - timedelta(hours=1)).isoformat(), auth.digest(phone)))
window = TestClient(main.app)
window.cookies.set(auth.COOKIE, phone)
r = window.get("/api/devices")
assert r.status_code == 200 and "set-cookie" not in r.headers, "cookie de l'app Android rendu persistant"
print("13. cookie du navigateur renouvelé avec la session ; jamais pour une app (Bearer, ou cookie de la fenêtre Android)")

# 14. Session d'appairage jamais récupérée (réponse perdue, app fermée) : elle expire seule en 10 minutes ; sa
# première utilisation la prolonge normalement.
reset()
p = web_a.post("/api/pairing").json()
r = client().post("/api/pairing/claim", json={"code": p["code"], "appareil": "Perdu"}).json()
fid = web_a.get("/api/pairing/pending").json()["demandes"][0]["id"]
assert web_a.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": r["verification"]}).status_code == 200
token = client().post("/api/pairing/flow/poll", json={"sondage": r["sondage"]}).json()["token"]


def expires(t: str) -> datetime:
    with db.connect() as c:
        return datetime.fromisoformat(c.execute("SELECT expires_at FROM sessions WHERE token = ?", (auth.digest(t),)).fetchone()[0])


assert expires(token) - datetime.now(timezone.utc) <= timedelta(minutes=10), "session orpheline valable 30 jours"
assert client(token).get("/api/devices").status_code == 200
assert expires(token) - datetime.now(timezone.utc) > timedelta(days=29), "première utilisation sans prolongation"
# 15. Identifiant d'appareil stable : une ancienne liste ne déconnecte pas un appareil arrivé depuis à sa place.
gone = auth.new_session(alice, "Ancien", "android")
old_id = [d["id"] for d in client(gone).get("/api/devices").json()["appareils"] if d["actuel"]][0]
auth.drop_session(gone)
newcomer = auth.new_session(alice, "Nouveau", "android")
assert web_a.delete(f"/api/devices/{old_id}").status_code == 404
assert auth.still_valid(newcomer), "l'ancienne liste a déconnecté le nouvel appareil"
new_id = [d["id"] for d in client(newcomer).get("/api/devices").json()["appareils"] if d["actuel"]][0]
assert web_b.delete(f"/api/devices/{new_id}").status_code == 404, "un autre compte déconnecte l'appareil"
assert web_a.delete(f"/api/devices/{new_id}").status_code == 200 and not auth.still_valid(newcomer)
print("15. identifiant d'appareil stable et non réutilisé ; révocation limitée au compte")

print("14. session d'appairage jamais utilisée : expire en 10 min ; prolongée à sa première utilisation")
print("appairage : tout est vert")
