"""Double vérification, sur un vrai serveur uvicorn et de vraies requêtes HTTP : activation, connexion, code rejoué, codes de
secours, force brute bornée, autre profil isolé, récupération. Les codes sont calculés ici, indépendamment du serveur, comme le
ferait une application sur le téléphone.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/install/double_verification_test.py"
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import socket
import sqlite3
import struct
import sys
import tempfile
import threading
import time

data = tempfile.mkdtemp()
os.environ.update({"NOAH_DATA_DIR": data, "LAUNCHER_KEY": "x", "NOAH_SECRET_KEY": "y" * 32})
sys.path.insert(0, "/app")
import httpx  # noqa: E402
import uvicorn  # noqa: E402

from noah import auth, db, double_verification, main, push, recuperation  # noqa: E402

db.init()
db.set_setting("onboarded", "1")
FRANCK_PW, NINA_PW, NEW_PW = "motdepasse-franck", "motdepasse-nina", "nouveau-motdepasse"
franck = auth.create_user("franck", FRANCK_PW)
nina = auth.create_user("nina", NINA_PW)
uma = auth.create_user("uma", "motdepasse-uma")


class Lines(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


journal = Lines()

alerts: list[tuple] = []


async def fake_send(title, text, url="/", urgent=False, user_id=None, session=None):
    alerts.append((title, user_id))
    return {}


push.send = fake_send

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"
server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=PORT, proxy_headers=True, forwarded_allow_ips="127.0.0.1", log_level="warning"))
logging.getLogger("uvicorn.error").addHandler(journal)  # après la configuration d'uvicorn, qui remplace les récepteurs
threading.Thread(target=server.run, daemon=True).start()
while not server.started:
    time.sleep(0.05)

failed: list[str] = []
_addr = iter(range(1, 60000))


def check(ok: bool, what: str, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'ÉCHEC'} {what}" + (f" : {detail}" if not ok and detail != "" else ""))
    if not ok:
        failed.append(what)


def addr() -> str:
    n = next(_addr)
    return f"198.18.{n >> 8}.{n & 255}"


def anyone(ip: str | None = None) -> httpx.Client:
    return httpx.Client(base_url=BASE, headers={"X-Forwarded-For": ip or addr(), "Origin": BASE}, timeout=20)


def fresh_limits() -> None:
    main._failed_logins.clear()
    main._account_failures.clear()
    recuperation._tries.clear()


def clear_tries(user: int) -> None:
    with db.connect() as c:
        c.execute("UPDATE double_verification SET essais = '[]' WHERE user_id = ?", (user,))


def app_code(secret: str, offset: int = 0) -> str:
    """Ce que calcule l'application du téléphone, sans passer par le serveur."""
    step = int(time.time()) // 30 + offset
    digest = hmac.new(base64.b32decode(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    pos = digest[-1] & 0x0F
    return str((struct.unpack(">I", digest[pos:pos + 4])[0] & 0x7FFFFFFF) % 1000000).zfill(6)


def rewind(user: int) -> None:
    """Le prochain essai peut resservir le code du moment : ce test ne veut pas attendre 30 s à chaque connexion."""
    with db.connect() as c:
        c.execute("UPDATE double_verification SET dernier_pas = 0 WHERE user_id = ?", (user,))


def login(who: httpx.Client, username: str, password: str, code: str = "") -> httpx.Response:
    return who.post("/api/login", json={"username": username, "password": password, "code": code})


def logged_in(username: str, password: str, code: str = "") -> httpx.Client:
    who = anyone()
    r = login(who, username, password, code)
    assert r.status_code == 200, r.text
    return who


def activate(who: httpx.Client, password: str) -> tuple[str, list[str]]:
    setup = who.post("/api/me/double-verification/preparer", json={"motdepasse": password}).json()
    r = who.post("/api/me/double-verification/confirmer", json={"code": app_code(setup["secret"])})
    assert r.status_code == 200, r.text
    return setup["secret"], r.json()["secours"]


print("== RFC 6238 : le vecteur de test de la RFC (SHA1, 6 derniers chiffres)")
rfc = base64.b32encode(b"12345678901234567890").decode()
check([double_verification.code_at(rfc, t // 30) for t in (59, 1111111109, 1234567890, 2000000000)] == ["287082", "081804", "005924", "279037"],
      "calcul conforme à la RFC 6238")

print("== Activation")
web = logged_in("franck", FRANCK_PW)
check(web.get("/api/me/double-verification").json() == {"active": False, "secours": 0}, "désactivée au départ")
r = web.post("/api/me/double-verification/preparer", json={"motdepasse": "mauvais-mdp"})
check(r.status_code == 400 and "secret" not in r.json(), "préparer sans le bon mot de passe : refusé, rien de montré (jeton volé)", r.text)
check(httpx.post(f"{BASE}/api/me/double-verification/preparer", json={"motdepasse": FRANCK_PW}).status_code == 401, "sans session : refusé")
setup = web.post("/api/me/double-verification/preparer", json={"motdepasse": FRANCK_PW}).json()
secret = setup["secret"]
check(len(secret) == 32 and secret in setup["adresse"] and setup["adresse"].startswith("otpauth://totp/Noah%20Agent:franck?"), "QR et secret en clair rendus", setup)
check(login(anyone(), "franck", FRANCK_PW).status_code == 200, "pas encore confirmée : la connexion ne change pas")
check(web.post("/api/me/double-verification/confirmer", json={"code": "000000" if app_code(secret) != "000000" else "000001"}).status_code == 400, "premier code faux : pas d'activation")
check(not double_verification.active(franck), "toujours pas active")
clear_tries(franck)
r = web.post("/api/me/double-verification/confirmer", json={"code": app_code(secret)})
spares = r.json()["secours"]
check(r.status_code == 200 and len(spares) == 8 and len(set(spares)) == 8, "bon premier code : active, 8 codes de secours", r.text)
check(web.get("/api/me/double-verification").json() == {"active": True, "secours": 8}, "état : active, 8 codes restants")
check(web.get("/api/me/double-verification").text.count("-") == 0, "les codes de secours ne se relisent jamais")
with sqlite3.connect(f"{data}/noah.db") as c:
    row = c.execute("SELECT secret, secours FROM double_verification WHERE user_id = ?", (franck,)).fetchone()
check(secret not in row[0] and db.unseal(row[0]) == secret, "secret scellé en base", row[0][:20])
check(not any(s in row[1] or s.replace("-", "") in row[1] for s in spares), "codes de secours en empreinte seulement")
check(web.post("/api/me/double-verification/preparer", json={"motdepasse": FRANCK_PW}).status_code == 409, "déjà active : pas de nouveau secret")
check(db.unseal(sqlite3.connect(f"{data}/noah.db").execute("SELECT secret FROM double_verification WHERE user_id = ?", (franck,)).fetchone()[0]) == secret, "le secret actif n'a pas changé")

print("== Connexion")
sessions = lambda: sqlite3.connect(f"{data}/noah.db").execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
before = sessions()
who = anyone()
r = login(who, "franck", FRANCK_PW)
check(r.status_code == 202 and r.json() == {"code_requis": True} and "set-cookie" not in r.headers and sessions() == before, "sans code : aucune session, le code est demandé", r.text)
check(who.get("/api/me").status_code == 401, "pas connecté après cette réponse")
wrong = login(anyone(), "franck", "mauvais-mdp")
unknown = login(anyone(), "personne", "mauvais-mdp")
without = login(anyone(), "uma", "mauvais-mdp")
check(wrong.status_code == unknown.status_code == without.status_code == 401 and wrong.json() == unknown.json() == without.json(),
      "mauvais mot de passe : même réponse, avec ou sans double vérification, compte existant ou non", wrong.text)
tried = lambda: double_verification._recent(sqlite3.connect(f"{data}/noah.db", factory=_row).execute("SELECT essais FROM double_verification WHERE user_id = ?", (franck,)).fetchone())


class _row(sqlite3.Connection):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.row_factory = sqlite3.Row


r = login(anyone(), "franck", "mauvais-mdp", "000000")
check(r.status_code == 401 and tried() == [], "mauvais mot de passe avec un code : le code n'est pas regardé, le plafond n'est pas entamé", tried())
rewind(franck)
current = app_code(secret)
r = login(anyone(), "franck", FRANCK_PW, "000000" if current != "000000" else "000001")
check(r.status_code == 401 and "faux" in r.json()["detail"] and "set-cookie" not in r.headers, "mauvais code : refusé", r.text)
clear_tries(franck)
who = anyone()
r = login(who, "franck", FRANCK_PW, current)
check(r.status_code == 200 and who.get("/api/me").json()["id"] == franck, "bon code : connecté", r.text)
r = login(anyone(), "franck", FRANCK_PW, current)
check(r.status_code == 401, "code rejoué : refusé", r.text)
clear_tries(franck)
fresh_limits()
rewind(franck)
got: list[int] = []
gate = threading.Barrier(8)
current = app_code(secret)


def race() -> None:
    client = anyone()
    gate.wait()
    got.append(login(client, "franck", FRANCK_PW, current).status_code)


threads = [threading.Thread(target=race) for _ in range(8)]
[t.start() for t in threads]
[t.join() for t in threads]
check(got.count(200) == 1, "le même code envoyé 8 fois au même instant : un seul passe", got)
clear_tries(franck)
fresh_limits()
rewind(franck)
for name, offset in (("le pas précédent", -1), ("le pas suivant", 1)):
    check(login(anyone(), "franck", FRANCK_PW, app_code(secret, offset)).status_code == 200, f"tolérance d'horloge : {name} passe")
    rewind(franck)
check(login(anyone(), "franck", FRANCK_PW, app_code(secret, 3)).status_code == 401, "un code de 90 s plus tard : refusé")
clear_tries(franck)
rewind(franck)
check(login(anyone(), "franck", FRANCK_PW, " " + app_code(secret)[:3] + " " + app_code(secret)[3:] + " ").status_code == 200, "espaces dans le code : accepté")
clear_tries(franck)

print("== Codes de secours")
one = spares[0]
who = anyone()
check(login(who, "franck", FRANCK_PW, one).status_code == 200 and who.get("/api/me/double-verification").json()["secours"] == 7, "un code de secours connecte, il en reste 7")
check(login(anyone(), "franck", FRANCK_PW, one).status_code == 401, "le même code de secours, une seconde fois : refusé")
clear_tries(franck)
check(login(anyone(), "franck", FRANCK_PW, spares[1].lower().replace("-", " ")).status_code == 200, "code de secours en minuscules et avec des espaces : accepté")
check(login(anyone(), "franck", FRANCK_PW, spares[1]).status_code == 401, "ce code-là aussi est consommé")
clear_tries(franck)
fresh_limits()

print("== Force brute")
rewind(franck)
current = app_code(secret)
alerts.clear()
wrong_code = "000000" if current != "000000" else "000001"
codes = [login(anyone(), "franck", FRANCK_PW, wrong_code).status_code for _ in range(5)]
check(codes == [401] * 5, "5 codes faux depuis 5 adresses différentes", codes)
r = login(anyone(), "franck", FRANCK_PW, current)
check(r.status_code == 429 and "set-cookie" not in r.headers, "6e essai depuis une autre adresse : bloqué, même avec le bon code", r.text)
r = login(anyone(), "franck", FRANCK_PW, spares[2])
check(r.status_code == 429, "un code de secours aussi est bloqué pendant ce temps")
check(web.get("/api/me/double-verification").json()["secours"] == 6, "ce blocage n'a consommé aucun code de secours")
for _ in range(50):
    if alerts:
        break
    time.sleep(0.05)
check(alerts == [("Quelqu'un connaît ton mot de passe", franck)], "la personne est prévenue, une seule fois", alerts)
check(any("Trop de codes" in x for x in journal.lines), "le journal le garde", journal.lines)
check(login(anyone(), "franck", "mauvais-mdp", current).status_code == 401, "un inconnu sans le mot de passe ne voit pas ce blocage")
check(login(anyone(), "uma", "motdepasse-uma").status_code == 200, "les autres comptes ne sont pas touchés")
with sqlite3.connect(f"{data}/noah.db") as c:
    c.execute("UPDATE double_verification SET essais = ? WHERE user_id = ?", (f"[{time.time() - double_verification.TRIES_WINDOW - 1}]", franck))
rewind(franck)
check(login(anyone(), "franck", FRANCK_PW, app_code(secret)).status_code == 200, "passé le délai : le bon code repasse")
fresh_limits()
with sqlite3.connect(f"{data}/noah.db") as c:
    c.execute("UPDATE double_verification SET essais = ? WHERE user_id = ?", (json.dumps([time.time() - double_verification.TRIES_WINDOW - 1] * double_verification.TRIES_DAY), franck))
rewind(franck)
check(login(anyone(), "franck", FRANCK_PW, app_code(secret)).status_code == 429, "plafond de la journée atteint, même étalé : le bon code ne passe plus")
with sqlite3.connect(f"{data}/noah.db") as c:
    c.execute("UPDATE double_verification SET essais = ? WHERE user_id = ?", (f"[{time.time() - double_verification.TRIES_DAY_WINDOW - 1}]", franck))
rewind(franck)
check(login(anyone(), "franck", FRANCK_PW, app_code(secret)).status_code == 200, "le lendemain : le bon code repasse")
fresh_limits()
one_ip = addr()
ten = [login(anyone(one_ip), "franck", FRANCK_PW, "99999" + str(i % 10)).status_code for i in range(11)]
check(ten[-1] == 429, "une seule adresse reste aussi sous la limite de connexion", ten)
clear_tries(franck)
fresh_limits()

print("== Mot de passe et double vérification")
rewind(franck)
web = logged_in("franck", FRANCK_PW, app_code(secret))
no_code = web.post("/api/me/password", json={"actuel": FRANCK_PW, "nouveau": NEW_PW})
check(no_code.status_code == 428 and auth.check_password("franck", FRANCK_PW) == franck, "mot de passe seul, sans le code : refusé", no_code.text)
rewind(franck)
check(web.post("/api/me/password", json={"actuel": FRANCK_PW, "nouveau": NEW_PW, "code": app_code(secret)}).status_code == 200, "changement de mot de passe ordinaire")
check(double_verification.active(franck) and login(anyone(), "franck", NEW_PW).status_code == 202, "il ne coupe pas la double vérification")
rewind(franck)
check(web.post("/api/me/password", json={"actuel": NEW_PW, "nouveau": FRANCK_PW, "code": app_code(secret)}).status_code == 200, "retour au mot de passe de départ")

print("== Désactivation")
fresh_limits()
rewind(franck)
current = app_code(secret)
r = web.post("/api/me/double-verification/couper", json={"motdepasse": "mauvais-mdp", "code": current})
check(r.status_code == 400, "couper avec un mauvais mot de passe : refusé", r.text)
r = web.post("/api/me/double-verification/couper", json={"motdepasse": FRANCK_PW})
check(r.status_code == 400, "couper sans code : refusé", r.text)
r = web.post("/api/me/double-verification/couper", json={"motdepasse": FRANCK_PW, "code": "000000" if current != "000000" else "000001"})
check(r.status_code == 400, "couper avec un mauvais code : refusé", r.text)
check(double_verification.active(franck) and web.get("/api/me").status_code == 200, "toujours active, et la session reste bonne")
clear_tries(franck)
r = web.post("/api/me/double-verification/couper", json={"motdepasse": FRANCK_PW, "code": current})
check(r.status_code == 200 and not double_verification.active(franck), "mot de passe et code : coupée", r.text)
check(login(anyone(), "franck", FRANCK_PW).status_code == 200, "connexion sans code de nouveau")
check(any("coupée par le titulaire" in x for x in journal.lines), "le journal le garde")
fresh_limits()

print("== Autre profil isolé")
secret_f, spares_f = activate(web, FRANCK_PW)
nina_web = logged_in("nina", NINA_PW)
check(nina_web.get("/api/me/double-verification").json() == {"active": False, "secours": 0}, "l'état de Franck ne se voit pas depuis Nina")
check(login(anyone(), "nina", NINA_PW).status_code == 200, "Nina se connecte sans code")
secret_n, spares_n = activate(nina_web, NINA_PW)
check(secret_n != secret_f, "chacun son secret")
clear_tries(franck)
check(login(anyone(), "nina", NINA_PW).status_code == 202, "Nina doit maintenant donner son code")
check(login(anyone(), "nina", NINA_PW, spares_f[0]).status_code == 401, "un code de secours de Franck ne sert pas à Nina")
check(login(anyone(), "franck", FRANCK_PW, spares_n[0]).status_code == 401, "ni l'inverse")
rewind(nina)
check(login(anyone(), "nina", NINA_PW, app_code(secret_f)).status_code == 401 or secret_f == secret_n, "le code de Franck ne sert pas à Nina")
clear_tries(franck)
clear_tries(nina)
fresh_limits()
nina_codes = [login(anyone(), "nina", NINA_PW, "99999" + str(i)).status_code for i in range(6)]
check(nina_codes == [401] * 5 + [429], "le plafond de Nina ne touche qu'elle", nina_codes)
rewind(franck)
check(login(anyone(), "franck", FRANCK_PW, app_code(secret_f)).status_code == 200, "Franck reste libre")
fresh_limits()
rewind(franck)
owner_web = logged_in("franck", FRANCK_PW, app_code(secret_f))
check(next(p for p in owner_web.get("/api/profiles").json()["profils"] if p["id"] == nina)["double"] is True, "le propriétaire voit que Nina l'a activée")
check(nina_web.post(f"/api/profiles/{franck}/double-verification/couper", json={"motdepasse": NINA_PW}).status_code == 403, "un profil ne coupe pas celle d'un autre")
check(owner_web.post(f"/api/profiles/{nina}/double-verification/couper", json={"motdepasse": FRANCK_PW}).status_code == 400, "le propriétaire sans son propre code : refusé")
clear_tries(franck)
fresh_limits()
rewind(franck)
check(owner_web.post(f"/api/profiles/{nina}/double-verification/couper", json={"motdepasse": FRANCK_PW, "code": app_code(secret_f)}).status_code == 200, "le propriétaire avec sa preuve coupe celle du profil qui a perdu son téléphone")
check(login(anyone(), "nina", NINA_PW).status_code == 200 and double_verification.active(franck), "Nina se connecte sans code, celle de Franck reste")
fresh_limits()

print("== Récupération")
journal.lines.clear()
code = recuperation.issue(replace=True)
r = anyone().post("/api/recuperation", json={"code": code, "password": NEW_PW})
check(r.status_code == 200 and double_verification.active(franck), "code de récupération sans la case : la double vérification reste", r.text)
check(login(anyone(), "franck", NEW_PW).status_code == 202, "le nouveau mot de passe seul ne suffit pas")
check(not any("coupée" in x for x in journal.lines), "rien de coupé dans le journal")
fresh_limits()
code = recuperation.issue(replace=True)
r = anyone().post("/api/recuperation", json={"code": "BCDF-GHJK-LMNP", "password": NEW_PW, "couper_double": True})
check(r.status_code == 400 and double_verification.active(franck), "faux code de récupération : rien n'est coupé", r.text)
r = anyone().post("/api/recuperation", json={"code": code, "password": FRANCK_PW, "couper_double": True})
check(r.status_code == 200 and not double_verification.active(franck), "avec la case : coupée, avec le code lu sur le serveur", r.text)
check(login(anyone(), "franck", FRANCK_PW).status_code == 200, "connexion avec le seul nouveau mot de passe")
check(any("coupée par code de récupération" in x for x in journal.lines), "le journal le garde", journal.lines)
check(not double_verification.active(nina), "les autres profils n'ont rien de changé")

print("== Suppression d'un compte")
fresh_limits()
owner_web = logged_in("franck", FRANCK_PW)
gone = auth.create_user("sophie", "motdepasse-s")
activate(logged_in("sophie", "motdepasse-s"), "motdepasse-s")
check(owner_web.delete(f"/api/profiles/{gone}").status_code == 200, "profil supprimé")
check(sqlite3.connect(f"{data}/noah.db").execute("SELECT COUNT(*) FROM double_verification WHERE user_id = ?", (gone,)).fetchone()[0] == 0, "son secret part avec lui")

server.should_exit = True
print()
if failed:
    print(f"{len(failed)} cas en échec :")
    for f in failed:
        print(" -", f)
    sys.exit(1)
print("double vérification : tout est vert")
