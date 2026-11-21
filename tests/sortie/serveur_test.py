"""Sortie réseau (lot sortie-reseau), côté serveur : Réglages > Serveur > Sortie réseau.

Vrais : les routes de Noah, la base et son chiffrement, le calcul de l'identité du navigateur. Simulé : le lanceur (un faux, en mémoire,
qui rend l'état d'un aiguillage). Ce que le test garde à l'œil : les clés sont scellées, n'arrivent qu'au lanceur, et ne sortent dans
aucune réponse ni aucun flux ; sans sortie configurée, aucun appel au lanceur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/sortie/serveur_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ.pop("NOAH_LOCALE", None)
os.environ.pop("NOAH_TIMEZONE", None)
sys.path.insert(0, "/app")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main, public, sortie  # noqa: E402

TS_KEY = "tskey-auth-kABCDEF1234-SECRETSECRETSECRET"
TS_KEY_2 = "tskey-auth-kZZZZZZ9999-AUTRESECRETAUTRESECRET"
WG_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdE="
SECRETS = (TS_KEY, TS_KEY_2, WG_KEY)

import logging  # noqa: E402

LOGS: list[str] = []


class Capture(logging.Handler):
    def emit(self, record):
        LOGS.append(record.getMessage())


logging.getLogger().addHandler(Capture())
logging.getLogger().setLevel(logging.DEBUG)
db.init()
OWNER = auth.create_user("franck", "motdepasse-a")
GUEST = auth.create_user("invite", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('alma', 'Alma', '', 'k', ?)", (OWNER,))


def client(user):
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'test', 'web')}"}, raise_server_exceptions=False)


owner, guest = client(OWNER), client(GUEST)

# --- Un faux lanceur -----------------------------------------------------------------------------------------------------
CALLS: list[tuple] = []
LAUNCHER = {"config": None, "aiguillage": None, "absent": set(), "down": False}


def air(active="maison", maison="active", vpn="prete", direct="prete", geo=None):
    geo = geo or {"ip": "198.51.100.7", "city": "Montréal", "region": "Quebec", "country": "CA", "timezone": "America/Toronto"}
    return {"active": active, "bascules": [{"quand": 1.0, "de": None, "vers": active, "raison": "premier choix"}], "inactif": False,
            "sorties": [{"nom": "maison", "etat": maison, **geo}, {"nom": "vpn", "etat": vpn, **{**geo, "ip": "192.0.2.44"}},
                        {"nom": "direct", "etat": direct, "ip": "203.0.113.5", "city": "Roubaix", "region": "Hauts-de-France", "country": "FR", "timezone": "Europe/Paris"}]}


async def fake_launcher(method, path, **kw):
    CALLS.append((method, path, kw.get("json")))
    if LAUNCHER["down"]:
        raise httpx.ConnectError("lanceur muet")
    if path == "/sortie" and method == "PUT":
        LAUNCHER["config"] = kw["json"]
        cfg = kw["json"]
        LAUNCHER["have"] = {"noah-sortie": bool(cfg["maison"] or cfg["vpn"]), "noah-sortie-maison": bool(cfg["maison"]), "noah-sortie-vpn": bool(cfg["vpn"])}
        return {"conteneurs": LAUNCHER["have"], "aiguillage": LAUNCHER["aiguillage"]}
    if path == "/sortie" and method == "GET":
        have = {n: v and n not in LAUNCHER["absent"] for n, v in LAUNCHER.get("have", {"noah-sortie": False, "noah-sortie-maison": False, "noah-sortie-vpn": False}).items()}
        return {"conteneurs": have, "aiguillage": LAUNCHER["aiguillage"]}
    if path.endswith("/browser") and method == "POST":
        return {"host": "noah-browser-alma", "created": True}
    raise AssertionError(f"appel inattendu au lanceur : {method} {path}")


hermes._launcher = fake_launcher


async def fake_ip():
    return "203.0.113.5"


public._public_ip = fake_ip
sortie.hermes = hermes  # le module appelle hermes._launcher : le faux


def leaks(text: str) -> list[str]:
    return [s for s in SECRETS if s in text]


def ok(name):
    print(f"ok  {name}")


# 1. Rien de configuré : trois lignes, le serveur actif, et aucun appel au lanceur --------------------------------------------
r = owner.get("/api/sortie")
assert r.status_code == 200, r.text
lines = {x["id"]: x for x in r.json()["lignes"]}
assert [x["id"] for x in r.json()["lignes"]] == ["maison", "vpn", "serveur"]
assert (lines["maison"]["etat"], lines["vpn"]["etat"], lines["serveur"]["etat"]) == ("non_configuree", "non_configuree", "active"), lines
assert lines["serveur"]["adresse"] == "203.0.113.5" and r.json()["active"] == "direct"
assert not CALLS, f"sans sortie configurée, le lanceur n'est pas appelé : {CALLS}"
assert guest.get("/api/sortie").status_code == 403 and TestClient(main.app).get("/api/sortie").status_code == 401, "réservé au propriétaire"
assert guest.put("/api/sortie/maison", json={"cle": TS_KEY, "noeud": "pc"}).status_code == 403
asyncio.run(sortie.reconcile())
assert asyncio.run(sortie.active_geo()) is None and not CALLS, "ni réconciliation ni lecture sans sortie"
ok("sans sortie : trois lignes, le serveur actif, aucun appel au lanceur ; réservé au propriétaire")

# 2. La maison : clé scellée, envoyée au seul lanceur, jamais renvoyée -----------------------------------------------------------
LAUNCHER["aiguillage"] = air()
r = owner.put("/api/sortie/maison", json={"cle": TS_KEY, "noeud": "pc-franck"})
assert r.status_code == 200, r.text
assert not leaks(r.text), "la clé revient dans la réponse"
maison = {x["id"]: x for x in r.json()["lignes"]}["maison"]
assert (maison["etat"], maison["adresse"], maison["lieu"], maison["noeud"], maison["cle"]) == ("active", "198.51.100.7", "Montréal, Quebec", "pc-franck", True), maison
assert LAUNCHER["config"] == {"maison": {"cle": TS_KEY, "noeud": "pc-franck"}, "vpn": None}, LAUNCHER["config"]
with db.connect() as c:
    rows = [dict(x) for x in c.execute("SELECT key, value FROM settings WHERE key LIKE 'sortie:%'")]
assert rows and not any(s in json.dumps(rows) for s in SECRETS), "la clé est en clair dans la base"
assert db.get_setting("sortie:maison:cle", secret=True) == TS_KEY
ok("maison : clé scellée en base, envoyée au lanceur, absente de la réponse")

# 3. Le VPN ----------------------------------------------------------------------------------------------------------------------
r = owner.put("/api/sortie/vpn", json={"cle_privee": WG_KEY})
assert r.status_code == 200 and not leaks(r.text), r.text
vpn = {x["id"]: x for x in r.json()["lignes"]}["vpn"]
assert (vpn["etat"], vpn["ville"], vpn["adresse_wireguard"], vpn["cle"]) == ("prete", "Montreal", "10.14.0.2/16", True), vpn
assert LAUNCHER["config"]["vpn"] == {"cle_privee": WG_KEY, "adresse": "10.14.0.2/16", "ville": "Montreal"}
assert LAUNCHER["config"]["maison"]["cle"] == TS_KEY, "la configuration envoyée est toujours complète"
ok("VPN : Montréal et l'adresse Surfshark par défaut, état « prête »")

# 4. Les états : active, prête, injoignable ; le repli sur le serveur -----------------------------------------------------------
def lines_now():
    return {x["id"]: x for x in owner.get("/api/sortie").json()["lignes"]}


LAUNCHER["aiguillage"] = air(active="vpn", maison="injoignable", vpn="active")
ls = lines_now()
assert (ls["maison"]["etat"], ls["vpn"]["etat"], ls["serveur"]["etat"]) == ("injoignable", "active", "prete"), ls
LAUNCHER["aiguillage"] = air(active="direct", maison="injoignable", vpn="injoignable", direct="active")
ls = lines_now()
assert (ls["maison"]["etat"], ls["vpn"]["etat"], ls["serveur"]["etat"]) == ("injoignable", "injoignable", "active"), ls
assert ls["serveur"]["adresse"] == "203.0.113.5" and ls["serveur"]["lieu"] == "Roubaix, Hauts-de-France"
LAUNCHER["aiguillage"] = None
ls = lines_now()
assert ls["maison"]["etat"] == "en_attente", "l'aiguillage ne répond pas encore : ni « active » ni « injoignable » inventés"
ok("états : active, prête, injoignable, en attente ; le serveur actif en repli, avec son adresse")

# 5. Valeurs refusées, sans écho de la clé ----------------------------------------------------------------------------------------
n = len(CALLS)
for url, body in [("/api/sortie/maison", {"cle": "mauvaise clé avec espace", "noeud": "pc"}), ("/api/sortie/maison", {"cle": TS_KEY_2, "noeud": "pc; rm -rf /"}),
                  ("/api/sortie/vpn", {"cle_privee": "trop-court"}), ("/api/sortie/vpn", {"cle_privee": WG_KEY, "adresse": "pas une adresse"}),
                  ("/api/sortie/vpn", {"cle_privee": WG_KEY, "ville": "Montréal$(id)"})]:
    r = owner.put(url, json=body)
    assert r.status_code == 400 and not leaks(r.text) and "mauvaise" not in r.text, (url, r.status_code, r.text)
assert len(CALLS) == n, "une valeur refusée n'arrive jamais au lanceur"
assert db.get_setting("sortie:maison:cle", secret=True) == TS_KEY, "une valeur refusée ne remplace pas la clé en place"
ok("valeurs invalides : 400 sans écho de la clé, rien d'envoyé, rien d'écrasé")

# 6. Changer le nœud sans ressaisir la clé ---------------------------------------------------------------------------------------
LAUNCHER["aiguillage"] = air()
r = owner.put("/api/sortie/maison", json={"noeud": "autre-pc"})
assert r.status_code == 200 and LAUNCHER["config"]["maison"] == {"cle": TS_KEY, "noeud": "autre-pc"}, LAUNCHER["config"]
r = owner.put("/api/sortie/maison", json={"cle": TS_KEY_2})
assert LAUNCHER["config"]["maison"] == {"cle": TS_KEY_2, "noeud": "autre-pc"} and not leaks(r.text)
ok("un champ vide garde la valeur enregistrée ; une nouvelle clé remplace l'ancienne")

# 7. L'identité du navigateur suit la sortie active ----------------------------------------------------------------------------------
sortie._status["at"] = 0.0
geo = asyncio.run(sortie.active_geo())
assert geo == {"country": "CA", "region": "Quebec", "timezone": "America/Toronto"}, geo
assert hermes.identity_of(geo) == {"locale": "fr-CA", "timezone": "America/Toronto"}
assert hermes.identity_of({"country": "CA", "region": "Ontario", "timezone": "America/Toronto"})["locale"] == "en-CA"
assert hermes.identity_of({"country": "FR", "timezone": "Europe/Paris"}) == {"locale": "fr-FR", "timezone": "Europe/Paris"}, "inchangé pour le reste"
assert asyncio.run(hermes.browser_identity_now()) == {"locale": "fr-CA", "timezone": "America/Toronto"}
LAUNCHER["aiguillage"] = air(active="direct", maison="injoignable", vpn="injoignable", direct="active")
sortie._status["at"] = 0.0
assert asyncio.run(sortie.active_geo()) is None, "en repli direct : l'identité du serveur, comme avant"
db.set_setting("browser_identity", json.dumps({"locale": "fr-FR", "timezone": "Europe/Paris"}))
assert asyncio.run(hermes.browser_identity_now()) == {"locale": "fr-FR", "timezone": "Europe/Paris"}
ok("identité : fr-CA et America/Toronto par la maison ou le VPN ; celle du serveur en repli direct")

# 8. Création du navigateur : réconciliation, puis identité ---------------------------------------------------------------------------
LAUNCHER["aiguillage"] = air()
sortie._status["at"] = 0.0
del CALLS[:]
LAUNCHER["absent"] = {"noah-sortie-vpn"}  # supprimé à la main : le serveur le fait recréer avant d'ouvrir le navigateur
asyncio.run(hermes.ensure_browser("alma"))
kinds = [(m, p) for m, p, _ in CALLS]
assert kinds[:3] == [("GET", "/sortie"), ("PUT", "/sortie"), ("GET", "/sortie")] or ("PUT", "/sortie") in kinds, kinds
posted = next(j for m, p, j in CALLS if p.endswith("/browser"))
assert posted["locale"] == "fr-CA" and posted["timezone"] == "America/Toronto", posted
LAUNCHER["absent"] = set()
del CALLS[:]
asyncio.run(sortie.reconcile())
assert [(m, p) for m, p, _ in CALLS] == [("GET", "/sortie")], "tout est là : une lecture, aucune écriture"
LAUNCHER["down"] = True
sortie._status["at"] = 0.0
del CALLS[:]
asyncio.run(sortie.reconcile())  # lanceur muet : ne casse pas ; la création du navigateur dira l'erreur
LAUNCHER["down"] = False
ok("ensure_browser : une sortie manquante est recréée avant le navigateur, lanceur muet toléré")

# 9. Le flux (« où vont mes données ») dit la vérité, sans clé -------------------------------------------------------------------------
r = owner.get("/api/flux")
assert r.status_code == 200 and not leaks(r.text)
text = json.dumps(r.json(), ensure_ascii=False)
assert "Sortie par ta maison" in text and "Sortie par ton VPN" in text and "ipinfo.io" in text
ok("/api/flux : les sorties configurées sont déclarées, sans clé")

# 10. Retirer ------------------------------------------------------------------------------------------------------------------------
r = owner.delete("/api/sortie/vpn")
assert r.status_code == 200 and LAUNCHER["config"]["vpn"] is None and LAUNCHER["config"]["maison"] is not None
assert db.get_setting("sortie:vpn:cle", secret=True) is None
r = owner.delete("/api/sortie/maison")
assert r.status_code == 200 and LAUNCHER["config"] == {"maison": None, "vpn": None}
assert owner.delete("/api/sortie/serveur").status_code == 404
with db.connect() as c:
    assert not [x for x in c.execute("SELECT key FROM settings WHERE key LIKE 'sortie:%'")], "les clés retirées ne restent pas en base"
del CALLS[:]
asyncio.run(hermes.ensure_browser("alma"))
assert [(m, p) for m, p, _ in CALLS if p.startswith("/sortie")] == [], "tout retiré : le comportement d'avant, aucun appel de plus"
assert "Sortie par" not in json.dumps(owner.get("/api/flux").json())
ok("retrait : clés effacées, plus aucun appel, plus rien dans le flux")

# 11. Le lanceur refuse : l'erreur est lisible, sans clé -------------------------------------------------------------------------------
async def refusing(method, path, **kw):
    r = httpx.Response(400, json={"detail": "Clé WireGuard, adresse ou ville invalide."}, request=httpx.Request(method, "http://launcher" + path))
    r.raise_for_status()
hermes._launcher = refusing
r = owner.put("/api/sortie/vpn", json={"cle_privee": WG_KEY})
assert r.status_code == 502 and "invalide" in r.text and not leaks(r.text), r.text
assert not leaks("\n".join(LOGS)), "une clé est dans un journal"
print("OK : sortie réseau, serveur (aucune clé dans les réponses, la base en clair, ni les journaux)")
