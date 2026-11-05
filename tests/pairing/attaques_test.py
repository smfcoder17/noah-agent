"""Attaques réelles contre l'appairage : un vrai serveur uvicorn (mêmes options que le conteneur : X-Forwarded-* de confiance
depuis le relais), de vraies requêtes HTTP, le vrai journal d'accès. Le relais (Caddy) est joué par ce script : il pose
X-Forwarded-For, et tests/pairing/xff_caddy.sh prouve à part qu'un vrai Caddy écrase ce que le client envoie. Chaque cas
est compté ; le script rend tous les échecs d'un coup, pas seulement le premier.

Exigence : qu'un QR soit passé ou valide, il ne connecte personne de lui-même et n'ouvre rien au-delà du compte qui l'a créé.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim \
      sh -c "pip install -q -r /app/requirements.txt && python /tests/pairing/attaques_test.py"
"""
import asyncio
import logging
import os
import socket
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, db, main, push  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
db.set_setting("onboarded", "1")

access_log: list[str] = []


class Keep(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        access_log.append(record.getMessage())


with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, proxy_headers=True,
                                       forwarded_allow_ips="127.0.0.1", log_level="info", access_log=True))
logging.getLogger("uvicorn.access").addHandler(Keep())
logging.getLogger("uvicorn.access").setLevel(logging.INFO)
threading.Thread(target=server.run, daemon=True).start()
while not server.started:
    time.sleep(0.05)

_addr = iter(range(1, 60000))
failed: list[str] = []


def check(ok: bool, what: str, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'ÉCHEC'} {what}" + (f" : {detail}" if not ok and detail != "" else ""))
    if not ok:
        failed.append(what)


def addr() -> str:
    n = next(_addr)
    return f"198.18.{n >> 8}.{n & 255}"


def device(ip: str | None = None) -> httpx.Client:
    """Un appareil sans session, derrière le relais : son adresse arrive dans X-Forwarded-For, comme avec Caddy."""
    return httpx.Client(base_url=BASE, headers={"X-Forwarded-For": ip or addr()}, timeout=20)


def browser(username: str, password: str, ip: str | None = None) -> httpx.Client:
    """Un navigateur connecté : cookie de session, et l'origine de Noah, comme une page de Noah."""
    c = httpx.Client(base_url=BASE, headers={"X-Forwarded-For": ip or addr(), "Origin": BASE}, timeout=20)
    r = c.post("/api/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return c


def fresh() -> None:
    main._pairing.clear()
    main._flows.clear()
    main._failed_logins.clear()
    main._pairing_failures.clear()
    main._short_failures.clear()
    main._number_failures.clear()


def session_count() -> int:
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]


def qr(web: httpx.Client) -> tuple[str, dict]:
    p = web.post("/api/pairing", json={}).json()
    return p["adresse"].split("#appairage=")[1], p


def claim(who: httpx.Client, code: str, **more) -> httpx.Response:
    return who.post("/api/pairing/claim", json={"code": code, **more})


def only_pending(web: httpx.Client) -> dict:
    return web.get("/api/pairing/pending").json()["demandes"][0]


def other_number(number: str) -> str:
    return "100" if number != "100" else "101"


print("== 1. QR photographié pendant qu'il est valide : quelqu'un d'autre le scanne avant la personne")
fresh()
web = browser("alice", "motdepasse-a")
link, _ = qr(web)
before = session_count()
thief = device()
r = claim(thief, link, appareil="Pixel de Franck", type="android")
body = r.json()
check(r.status_code == 200 and "token" not in body and "set-cookie" not in r.headers, "le QR seul ne donne aucune session", r.text)
check(session_count() == before and thief.post("/api/pairing/flow/poll", json={"sondage": body["sondage"]}).status_code == 202,
      "le voleur attend, aucune session créée")
victim = claim(device(), link)
check(victim.status_code == 400 and "déjà servi" in victim.json()["detail"], "la personne qui scanne après lui reçoit une erreur claire", victim.text)
fid = only_pending(web)["id"]
check(web.post(f"/api/pairing/flow/{fid}/autoriser", json={}).status_code == 403, "accepter sans le nombre : refusé, demande annulée")
check(thief.post("/api/pairing/flow/poll", json={"sondage": body["sondage"]}).status_code == 410, "le voleur n'a plus rien après un mauvais nombre")

fresh()
link, _ = qr(web)
number = claim(device(), link, appareil="Inconnu").json()["verification"]
fid = only_pending(web)["id"]
other_tab = browser("alice", "motdepasse-a")
r = other_tab.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": number})
check(r.status_code == 404, "seul l'écran qui a affiché le QR peut accepter (une autre session du compte : non)", r.status_code)
check(other_tab.get("/api/pairing/pending").json()["demandes"] == [], "une autre session du compte ne voit pas la demande")
check(web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": number}).status_code == 200, "l'écran d'origine, avec le bon nombre : accepté")

print("== 2. QR expiré, déjà utilisé, rejoué, en parallèle, après déconnexion, révocation, changement de mot de passe")
fresh()
link, p = qr(web)
main._pairing[auth.digest(link)]["expire"] = time.time() - 1
check(claim(device(), link).status_code == 400 and claim(device(), p["code"]).status_code == 400, "QR et code court expirés : refusés")

fresh()
link, p = qr(web)
first = claim(device(), link)
check(first.status_code == 200 and claim(device(), link).status_code == 400 and claim(device(), p["code"]).status_code == 400,
      "rejoué après usage : refusé, le code court du même affichage avec")

fresh()
link, _ = qr(web)
codes: list[int] = []
gate = threading.Barrier(16)


def race() -> None:
    who = device()
    gate.wait()
    codes.append(claim(who, link).status_code)


threads = [threading.Thread(target=race) for _ in range(16)]
[t.start() for t in threads]
[t.join() for t in threads]
check(sorted(codes) == [200] + [400] * 15 and len(web.get("/api/pairing/pending").json()["demandes"]) == 1,
      "16 appareils au même instant : un seul passe, une seule demande", codes)


def alice_session() -> httpx.Client:
    return browser("alice", "motdepasse-a")


fresh()
creator = alice_session()
link, p = qr(creator)
creator.post("/api/logout", json={})
check(claim(device(), link).status_code == 400 and claim(device(), p["code"]).status_code == 400, "après déconnexion de la session qui l'a créé : QR mort")

fresh()
creator = alice_session()
link, _ = qr(creator)
web = alice_session()
web.post("/api/devices/others/revoke", json={})
check(claim(device(), link).status_code == 400, "après révocation de la session qui l'a créé : QR mort")

fresh()
creator = alice_session()
link, _ = qr(creator)
number = claim(device(), link, appareil="x").json()["verification"]
web = alice_session()
fid = next(iter(main._flows))
creator.post("/api/logout", json={})
check(web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": number}).status_code == 404, "demande en attente d'une session partie : plus acceptable")

fresh()
web = alice_session()
link, p = qr(web)
r = web.post("/api/me/password", json={"actuel": "motdepasse-a", "nouveau": "motdepasse-a2"})
assert r.status_code == 200, r.text
check(claim(device(), link).status_code == 400 and claim(device(), p["code"]).status_code == 400, "après changement de mot de passe : QR mort, même si la session reste")
web.post("/api/me/password", json={"actuel": "motdepasse-a2", "nouveau": "motdepasse-a"})

fresh()
link, _ = qr(web)
waiting = device()
b = claim(waiting, link, appareil="x").json()
web.post(f"/api/pairing/flow/{only_pending(web)['id']}/autoriser", json={"verification": b["verification"]})
web.post("/api/me/password", json={"actuel": "motdepasse-a", "nouveau": "motdepasse-a2"})
check(waiting.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}).status_code == 410,
      "accord donné juste avant le changement de mot de passe : plus de session à récupérer")
web.post("/api/me/password", json={"actuel": "motdepasse-a2", "nouveau": "motdepasse-a"})

print("== 3. Devinette : entropie, force brute, X-Forwarded-For, demandes en attente, inondation")
fresh()
web = alice_session()
link, p = qr(web)
check(len(link) >= 32 and len(p["code"].replace("-", "")) == 8 and set(p["code"].replace("-", "")) <= set(main._SHORT),
      "QR de 192 bits, code court de 8 caractères en base 20 (34 bits)")
one = addr()
tries = [claim(device(one), "BCDF-GHJK").status_code for _ in range(6)]
check(tries == [400] * 5 + [429], "code court : 5 essais par adresse, puis 429", tries)
fresh()
main._short_failures.extend([time.time()] * main.SHORT_GLOBAL)
check(claim(device(), "BCDF-GHJK").status_code == 429, "même en changeant d'adresse à chaque essai, plafond global : 429")
fresh()
one = addr()
starts = [device(one).post("/api/pairing/flow", json={"appareil": "PC"}).status_code for _ in range(6)]
check(starts == [200] * 5 + [429], "5 demandes en attente par adresse", starts)
fresh()
one = addr()
got: list[int] = []
gate = threading.Barrier(12)


def start_flow() -> None:
    who = device(one)
    gate.wait()
    got.append(who.post("/api/pairing/flow", json={"appareil": "PC"}).status_code)


threads = [threading.Thread(target=start_flow) for _ in range(12)]
[t.start() for t in threads]
[t.join() for t in threads]
check(got.count(200) == 5, "12 demandes simultanées d'une même adresse : pas plus de 5", got)

fresh()
for n in range(main.FLOW_GLOBAL if hasattr(main, "FLOW_GLOBAL") else 2000):
    main._flows[f"f{n}"] = {"sondage": "", "appareil": "PC", "type": "desktop", "expire": time.time() + 60, "ip": f"2001:db8:{n:x}::1",
                            "user": None, "proprietaire": None, "verif": "123", "sens": "app"}
r = device().post("/api/pairing/flow", json={"appareil": "PC"})
check(r.status_code == 429, "plafond global de demandes sans titulaire (adresses IPv6 tournantes) : mémoire bornée", r.status_code)

fresh()
for _ in range(30):
    device().post("/api/pairing/flow", json={"appareil": "PC"})
check(web.get("/api/pairing/pending").json()["demandes"] == [], "une inondation de demandes n'arrive sur aucun écran d'accord")

fresh()
start = device().post("/api/pairing/flow", json={"appareil": "PC"}).json()
fid = start["adresse"].split("#autoriser=")[1]
web.get(f"/api/pairing/flow/{fid}")
web.post(f"/api/pairing/flow/{fid}/autoriser", json={})
strange = device()
r = strange.post("/api/pairing/flow/poll", json={"sondage": start["sondage"], "verification": "é"})
check(r.status_code == 403, "nombre avec un caractère non ASCII : refusé proprement, pas une erreur 500", r.status_code)

print("== 4. Ce que contient le QR, et où finit le jeton")
fresh()
access_log.clear()
link, p = qr(web)
u = urlsplit(p["adresse"])
check(not u.query and u.path in ("", "/") and u.fragment == f"appairage={link}", "le QR ne contient que l'adresse et un jeton dans le fragment", p["adresse"])
b = claim(device(), link, appareil="x").json()
device().post("/api/pairing/flow/poll", json={"sondage": b["sondage"]})
logged = "\n".join(access_log)
check("pairing/claim" in logged, "le contrôle voit bien le journal d'accès", logged[:200])
check(all(s not in logged for s in (link, p["code"], p["code"].replace("-", ""), b["sondage"], b["verification"] + " ")),
      "journal d'accès : ni jeton, ni code court, ni sondage")
check(claim(device(), link).status_code == 400, "photographié après usage : il n'ouvre plus rien")
check(auth.digest(link) not in main._pairing and link not in str(main._flows), "le serveur n'a gardé ni le jeton ni son empreinte")

print("== 5. Autre compte déjà connecté, navigateur quelconque, fixation de session")
fresh()
bob_web = browser("bruno", "motdepasse-b")
link, _ = qr(bob_web)
alice_tab = alice_session()
alice_cookie = alice_tab.cookies.get(auth.COOKIE)
r = claim(alice_tab, link)
check(r.status_code == 409, "lien d'un autre compte ouvert dans un navigateur connecté : refusé", r.status_code)
check(auth.digest(link) in main._pairing, "le code n'est pas brûlé par ce refus (la personne n'a rien fait)")

fresh()
link, _ = qr(bob_web)
later = device()  # navigateur sans session qui ouvre le lien de Bob, puis se connecte à son compte dans un autre onglet
b = claim(later, link).json()
assert later.post("/api/login", json={"username": "alice", "password": "motdepasse-a"}, headers={"Origin": BASE}).status_code == 200
alice_cookie = later.cookies.get(auth.COOKIE)
bob_web.post(f"/api/pairing/flow/{only_pending(bob_web)['id']}/autoriser", json={"verification": b["verification"]})
r = later.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}, headers={"Origin": BASE})
check(r.status_code == 409 and "set-cookie" not in r.headers and later.cookies.get(auth.COOKIE) == alice_cookie,
      "sondage d'un autre compte : le cookie de la personne n'est jamais remplacé", (r.status_code, r.headers.get("set-cookie")))

# Connexion forcée (CSRF de connexion) : Bob a accepté sa propre demande, une page étrangère la fait récupérer par le
# navigateur de la victime.
fresh()
link, _ = qr(bob_web)
bob_phone = device()
b = claim(bob_phone, link).json()
bob_web.post(f"/api/pairing/flow/{only_pending(bob_web)['id']}/autoriser", json={"verification": b["verification"]})


def evil() -> httpx.Client:
    """Le navigateur de la victime, sans session, sur une page d'un autre site : le navigateur y pose l'Origin de ce site."""
    return httpx.Client(base_url=BASE, headers={"X-Forwarded-For": addr(), "Origin": "https://evil.example"}, timeout=20)


r = evil().post("/api/pairing/flow/poll", json={"sondage": b["sondage"]})
check(r.status_code == 403 and "set-cookie" not in r.headers, "sondage forcé depuis un autre site : refusé, aucun cookie posé", r.status_code)
r = evil().post("/api/login", json={"username": "bruno", "password": "motdepasse-b"})
check(r.status_code == 403 and "set-cookie" not in r.headers, "connexion forcée depuis un autre site : refusée, aucun cookie posé", r.status_code)
r = evil().post("/api/pairing/claim", json={"code": "BCDF-GHJK"})
check(r.status_code == 403, "code envoyé depuis un autre site : refusé", r.status_code)
r = httpx.post(f"{BASE}/api/pairing/flow/poll", content=f'{{"sondage":"{b["sondage"]}"}}', headers={"Content-Type": "text/plain", "X-Forwarded-For": addr()})
check(r.status_code == 422 and "set-cookie" not in r.headers, "formulaire text/plain : refusé", r.status_code)
ok = device().post("/api/pairing/flow/poll", json={"sondage": b["sondage"]})
check(ok.status_code == 200 and ok.json().get("compte") == "bruno", "le sondage dit à quel compte l'appareil vient d'être relié", ok.text)

print("== 6. Le « accepter » trompeur")
fresh()
web = alice_session()
trap = "Noah‮\nclique sur Autoriser\x07"
link, _ = qr(web)
b = claim(device(), link, appareil=trap, type="android").json()
d = only_pending(web)
check(not set(d["appareil"]) & {"‮", "\n", "\x07"}, "nom d'appareil : caractères de contrôle et d'inversion retirés", repr(d["appareil"]))
check(d.get("age", -1) >= 0 and d.get("expire", 0) > 0 and "autre_reseau" in d, "la demande dit son âge, son délai et si elle vient d'un autre réseau", d)
check("verification" not in d and "sondage" not in d, "l'écran d'accord ne reçoit pas le nombre : il doit le lire sur l'appareil")
fresh()
attacker = device()
start = attacker.post("/api/pairing/flow", json={"appareil": "Ordinateur de Franck", "type": "desktop"}).json()
fid = start["adresse"].split("#autoriser=")[1]
info = web.get(f"/api/pairing/flow/{fid}").json()
check("verification" not in start and info["autre_reseau"] and info.get("age", -1) >= 0 and info.get("expire", 0) > 0,
      "flux du bureau : le nombre reste dans la page, âge et réseau affichés", info)
check(web.post(f"/api/pairing/flow/{fid}/autoriser", json={}).status_code == 200, "la personne accepte par erreur")
check(attacker.post("/api/pairing/flow/poll", json={"sondage": start["sondage"]}).json() == {"attente": "nombre"}, "l'attaquant n'a rien sans le nombre")
check(attacker.post("/api/pairing/flow/poll", json={"sondage": start["sondage"], "verification": other_number(info["verification"])}).status_code == 403
      and attacker.post("/api/pairing/flow/poll", json={"sondage": start["sondage"], "verification": info["verification"]}).status_code == 410,
      "un seul essai : un mauvais nombre annule la demande")

print("== 7. Droits de la session obtenue, alerte à chaque nouvel appareil")
sent: list[tuple] = []
real_send = push.send


async def fake_send(title, text, url="/", urgent=False, user_id=None, session=None):
    sent.append((title, text, user_id))
    return {}


push.send = fake_send
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('secret', 'A', '', 'k', ?)", (alice,))
fresh()
link, _ = qr(bob_web)
linked = device()
b = claim(linked, link, appareil="Tablette de Bruno", type="android").json()
bob_web.post(f"/api/pairing/flow/{only_pending(bob_web)['id']}/autoriser", json={"verification": b["verification"]})
tok = linked.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}).json()["token"]
mine = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {tok}", "X-Forwarded-For": addr()}, timeout=20)
check(mine.get("/api/me").json() == {"id": bruno, "username": "bruno", "role": "member"}, "session limitée au compte qui a accepté, rôle du compte")
check(mine.get("/api/agents/secret/conversations").status_code in (403, 404), "un agent d'Alice reste fermé à un compte invité relié par QR")
check(mine.get("/api/profiles").status_code == 403, "pas d'administration pour un compte invité relié par QR")
names = [x["nom"] for x in bob_web.get("/api/devices").json()["appareils"]]
check("Tablette de Bruno" in names, "le nouvel appareil se voit dans la liste", names)
for _ in range(50):
    if sent:
        break
    time.sleep(0.05)
check(any(u == bruno and "Tablette de Bruno" in t for _, t, u in sent), "alerte envoyée au compte à la création de la session", sent)
sent.clear()
browser("bruno", "motdepasse-b")
for _ in range(50):
    if sent:
        break
    time.sleep(0.05)
check(any(u == bruno for *_, u in sent), "alerte aussi à une connexion par mot de passe", sent)
did = next(x["id"] for x in bob_web.get("/api/devices").json()["appareils"] if x["nom"] == "Tablette de Bruno")
check(bob_web.delete(f"/api/devices/{did}").status_code == 200 and mine.get("/api/me").status_code == 401, "révoqué : le jeton ne sert plus")
fresh()
window = auth.new_session(bruno, "Fenêtre", "android")
held = auth.new_window(window)
check(httpx.post(f"{BASE}/api/pairing", json={}, headers={"Authorization": f"Bearer {held}"}).status_code == 403, "une session de fenêtre ne produit pas de QR")
push.send = real_send

print("== 8. Code de liaison du bureau et de l'APK : mêmes attaques")
fresh()
web = alice_session()
for kind in ("desktop", "android"):
    _, p = qr(web)
    pc = device()
    b = claim(pc, p["code"].lower().replace("-", " "), appareil="PC", type=kind).json()
    check("token" not in b and "set-cookie" not in pc.cookies, f"{kind} : le code seul ne donne aucune session")
    check(claim(device(), p["code"]).status_code == 400, f"{kind} : code rejoué, refusé")
    d = only_pending(web)
    check(d["type"] == kind, f"{kind} : le type de l'appareil est affiché")
    web.post(f"/api/pairing/flow/{d['id']}/autoriser", json={"verification": b["verification"]})
    r = pc.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]})
    check(r.status_code == 200 and "set-cookie" not in r.headers and r.json()["token"], f"{kind} : session en réponse seulement, jamais en cookie")

print("== 9. Jeton d'appareil volé : il affiche un QR, mais n'accorde rien sans le mot de passe")
fresh()
main._account_failures.clear()
stolen = auth.new_session(alice, "Téléphone d'Alice", "android")
thief_app = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {stolen}", "X-Forwarded-For": addr()}, timeout=20)
before = session_count()
link, _ = qr(thief_app)
second = device()
b = claim(second, link, appareil="Second téléphone du voleur", type="android").json()
pending = thief_app.get("/api/pairing/pending").json()
fid = pending["demandes"][0]["id"]
check(pending["preuve_requise"] is True and pending["code_requis"] is False, "l'écran d'accord annonce qu'il faut la preuve", pending)
r = thief_app.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"]})
check(r.status_code == 428, "bon nombre, sans mot de passe : refusé", r.text)
check(fid in main._flows and second.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}).status_code == 202 and session_count() == before,
      "le nouvel appareil attend toujours, aucune session créée")
r = thief_app.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"], "motdepasse": "mauvais-mdp"})
check(r.status_code == 400 and second.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}).status_code == 202, "bon nombre, mauvais mot de passe : refusé", r.text)
tries = [thief_app.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"], "motdepasse": f"essai-{n:04d}"}).status_code for n in range(12)]
check(tries[-1] == 429, "mot de passe forcé à travers l'accord : borné par les limites de connexion, même depuis une adresse connue", tries)
fresh()
main._account_failures.clear()
link, _ = qr(thief_app)
second = device()
b = claim(second, link, appareil="Second téléphone", type="android").json()
fid = thief_app.get("/api/pairing/pending").json()["demandes"][0]["id"]
r = thief_app.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"], "motdepasse": "motdepasse-a"})
check(r.status_code == 200 and second.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}).status_code == 200, "avec le mot de passe : l'accord passe", r.text)
link, _ = qr(thief_app)
b = claim(device(), link, appareil="Troisième", type="android").json()
pending = thief_app.get("/api/pairing/pending").json()
check(pending["preuve_requise"] is True, "une session d'app ne garde pas de dispense : la preuve revaut à chaque fois", pending)

fresh()
old_web = alice_session()
with db.connect() as c:
    c.execute("UPDATE sessions SET mdp_a = ? WHERE token = ?", (time.time() - auth.PROOF_SECONDS - 1, auth.digest(old_web.cookies.get(auth.COOKIE))))
link, _ = qr(old_web)
b = claim(device(), link, appareil="Tablette", type="android").json()
pending = old_web.get("/api/pairing/pending").json()
check(pending["preuve_requise"] is True, "navigateur connecté depuis plus de 15 minutes : la preuve est demandée", pending)
fid = pending["demandes"][0]["id"]
check(old_web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"]}).status_code == 428, "et exigée")
check(old_web.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"], "motdepasse": "motdepasse-a"}).status_code == 200, "mot de passe confirmé : accordé")
link, _ = qr(old_web)
b = claim(device(), link, appareil="Tablette 2", type="android").json()
pending = old_web.get("/api/pairing/pending").json()
check(pending["preuve_requise"] is False and old_web.post(f"/api/pairing/flow/{pending['demandes'][0]['id']}/autoriser", json={"verification": b["verification"]}).status_code == 200,
      "confirmé il y a moins de 15 minutes : pas redemandé dans ce navigateur", pending)

fresh()
fresh_web = alice_session()
link, _ = qr(fresh_web)
b = claim(device(), link, appareil="Téléphone", type="android").json()
pending = fresh_web.get("/api/pairing/pending").json()
check(pending["preuve_requise"] is False and fresh_web.post(f"/api/pairing/flow/{pending['demandes'][0]['id']}/autoriser", json={"verification": b["verification"]}).status_code == 200,
      "le cas courant : ordinateur tout juste connecté, QR, téléphone. Rien de plus à saisir", pending)

fresh()
via_qr = alice_session()
link, _ = qr(via_qr)
phone_browser = device()
b = claim(phone_browser, link).json()  # navigateur du téléphone : session de type web, mais pas par mot de passe
via_qr.post(f"/api/pairing/flow/{only_pending(via_qr)['id']}/autoriser", json={"verification": b["verification"]})
token = phone_browser.post("/api/pairing/flow/poll", json={"sondage": b["sondage"]}, headers={"Origin": BASE}).json()["token"]
held = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}", "X-Forwarded-For": addr()}, timeout=20)
link, _ = qr(held)
b = claim(device(), link, appareil="Encore un", type="android").json()
pending = held.get("/api/pairing/pending").json()
check(pending["preuve_requise"] is True and held.post(f"/api/pairing/flow/{pending['demandes'][0]['id']}/autoriser", json={"verification": b["verification"]}).status_code == 428,
      "navigateur relié par QR, pas par mot de passe : pas de dispense", pending)

fresh()
main._account_failures.clear()
from noah import double_verification  # noqa: E402

code_web = alice_session()
setup = code_web.post("/api/me/double-verification/preparer", json={"motdepasse": "motdepasse-a"}).json()
now_code = lambda: double_verification.code_at(setup["secret"], int(time.time()) // 30)  # noqa: E731
spare = code_web.post("/api/me/double-verification/confirmer", json={"code": now_code()}).json()["secours"]
link, _ = qr(thief_app)
b = claim(device(), link, appareil="Avec code", type="android").json()
pending = thief_app.get("/api/pairing/pending").json()
fid = pending["demandes"][0]["id"]
check(pending["code_requis"] is True, "double vérification active : l'accord demande aussi le code", pending)
r = thief_app.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"], "motdepasse": "motdepasse-a"})
check(r.status_code == 400, "le mot de passe seul ne suffit plus", r.text)
r = thief_app.post(f"/api/pairing/flow/{fid}/autoriser", json={"verification": b["verification"], "motdepasse": "motdepasse-a", "code": spare[0]})
check(r.status_code == 200, "mot de passe et code de secours : accordé", r.text)
fresh()
main._account_failures.clear()
code_web.post("/api/me/double-verification/couper", json={"motdepasse": "motdepasse-a", "code": spare[1]})

server.should_exit = True
print()
if failed:
    print(f"{len(failed)} attaque(s) qui passent encore :")
    for f in failed:
        print(" -", f)
    sys.exit(1)
print("attaques contre l'appairage : tout est vert")
