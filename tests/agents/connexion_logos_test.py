"""Retour de connexion public et logos, côté serveur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/connexion_logos_test.py"
"""
import asyncio
import os
import sys
import tempfile
from urllib.parse import urlencode

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, connexion, logos, main, public, watch  # noqa: E402

client = TestClient(main.app, base_url="https://noah.exemple.test", raise_server_exceptions=False)
ORIGIN = "https://notion.exemple/authorize?"
calls = []


async def finish(query):
    calls.append(query)
    return {"connecte": True}


def begin(state="etat-secret", retour=True, app=True):
    connexion.expect({"adresse": ORIGIN + urlencode({"state": state, "redirect_uri": "x"}), "retour": retour}, "a1", "notion", finish, app)


# 1. Sans le bon state : rien n'atteint l'agent. La page n'écrit rien de ce qu'on lui envoie.
begin()
r = client.get(connexion.PATH, params={"code": "<script>x</script>", "state": "faux"})
assert r.status_code == 400 and not calls and "<script>x" not in r.text
r = client.get(connexion.PATH, params={"code": "abc"})
assert r.status_code == 400 and not calls
print("1. state absent ou faux : refus, rien transmis, rien de reflété")

# 2. Le bon state : transmis une seule fois, et seulement les champs prévus.
r = client.get(connexion.PATH, params={"code": "abc", "state": "etat-secret", "iss": "https://i", "autre": "x&injection=1"})
assert r.status_code == 200 and "Notion est connecté" in r.text and "noah://connexion" in r.text, r.text
assert calls == ["?code=abc&state=etat-secret&iss=https%3A%2F%2Fi"], calls
r = client.get(connexion.PATH, params={"code": "abc", "state": "etat-secret"})
assert r.status_code == 400 and len(calls) == 1, "un même retour ne sert qu'une fois"
print("2. bon state : une seule fois, champs prévus seulement ; depuis l'application, elle est proposée")

# 2 bis. Depuis un onglet : retour sur Noah, à l'adresse de ce serveur, comme les autres services.
begin("depuis-web", app=False)
r = client.get(connexion.PATH, params={"code": "abc", "state": "depuis-web"}, follow_redirects=False)
assert r.status_code == 303 and r.headers["location"] == "/#connexion=notion", (r.status_code, r.headers)
assert "code=" not in r.headers["location"] and r.headers["referrer-policy"] == "no-referrer"
print("2 bis. depuis le web : renvoyé sur Noah, sans le code dans l'adresse")

# 3. La page ne laisse rien fuir : ni cache, ni Referer, ni script, ni indexation.
begin()
r = client.get(connexion.PATH, params={"code": "abc", "state": "etat-secret"})
assert r.headers["cache-control"] == "no-store" and "no-referrer" in r.headers["referrer-policy"].lower()
assert "default-src 'none'" in r.headers["content-security-policy"] and "<script" not in r.text
assert "noindex" in r.headers["x-robots-tag"]
print("3. no-store, no-referrer, aucun script, noindex")

# 4. Un refus du fournisseur est dit sans détail repris de l'adresse.
begin()
calls.clear()
r = client.get(connexion.PATH, params={"error": "access_denied", "state": "etat-secret", "error_description": "<b>x</b>"})
assert r.status_code == 200 and "pas connecté" in r.text and "<b>x" not in r.text
assert calls and "error=access_denied" in calls[0], "Hermes doit savoir : il arrête d'attendre"
print("4. refus du fournisseur : dit clairement, Hermes prévenu")


# 5. Une panne de l'agent ne montre aucun détail dans le navigateur.
async def broken(_query):
    raise RuntimeError("chemin interne secret")

connexion.expect({"adresse": ORIGIN + "state=e2", "retour": True}, "a1", "notion", broken)
r = client.get(connexion.PATH, params={"code": "abc", "state": "e2"})
assert r.status_code == 502 and "secret" not in r.text
print("5. panne : page lisible, aucun détail interne")

# 6. Une connexion expire, et une voie par copier-coller n'attend rien ici.
begin("vieux")
connexion._pending["vieux"]["expire"] = 0
assert client.get(connexion.PATH, params={"code": "a", "state": "vieux"}).status_code == 400
begin("colle", retour=False)
assert "colle" not in connexion._pending
print("6. expirée : refusée ; voie par copier-coller : rien d'attendu")

# 7. L'adresse de retour : le nom public, ou localhost, jamais l'en-tête Host d'une requête sur un serveur.
class Req:
    class url:
        hostname = "piege.exemple"
    base_url = "https://piege.exemple/"

public._state["domaines"] = set()
assert connexion.callback_url(Req) == "", "sans nom public, pas d'adresse tirée de l'en-tête Host"
public._state["domaines"] = {"1-2-3-4.sslip.io"}
assert connexion.callback_url(Req) == "https://1-2-3-4.sslip.io/api/connexion/retour"
print("7. adresse de retour : jamais tirée de l'en-tête Host d'un serveur")

# 8. Logos : l'icône la plus nette, le type lu dans le contenu, rien qui ne soit pas une image.
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
page = ('<link rel="icon" href="/petit.png"><link rel="apple-touch-icon" sizes="180x180" href="/grand.png">'
        '<link rel="mask-icon" href="/masque.svg"><link rel="icon" href="data:image/png;base64,AAAA">').encode()
pages = {"https://site.exemple/": (page, "https://www.site.exemple/"), "https://www.site.exemple/grand.png": (PNG, "x")}
fetched = []


async def fake_read(url, limit, as_text=False):
    fetched.append(url)
    if url not in pages:
        raise ValueError("absent")
    return pages[url]

watch.read_bytes = fake_read
found = asyncio.run(logos._logo("site.exemple"))
assert found == (PNG, "image/png"), found
assert fetched[1] == "https://www.site.exemple/grand.png", fetched
before = len(fetched)
assert asyncio.run(logos._logo("site.exemple")) == (PNG, "image/png") and len(fetched) == before, "gardé : pas de nouvel appel"
pages["https://html.exemple/favicon.ico"] = (b"<html>" + b"x" * 200, "x")
assert asyncio.run(logos._logo("html.exemple")) is None
before = len(fetched)
assert asyncio.run(logos._logo("html.exemple")) is None and len(fetched) == before, "absent : pas redemandé à chaque ouverture"
assert logos._kind(b"<svg xmlns='x'></svg>") == "image/svg+xml" and logos._kind(b"<html><svg>") is None
print("8. logos : la plus nette d'abord, gardée, une page HTML n'est pas une image, absence mémorisée")

# 9. La route exige une session, et refuse un nom qui n'est pas un nom de domaine.
assert client.get("/api/logos/site.exemple").status_code == 401
main.app.dependency_overrides[auth.current_user] = lambda: 1
for host in ("localhost", "127.0.0.1", "..%2F..%2Fetc", "a_b.exemple"):
    assert client.get(f"/api/logos/{host}").status_code in (400, 404), host
r = client.get("/api/logos/site.exemple")
assert r.status_code == 200 and r.headers["x-content-type-options"] == "nosniff" and "sandbox" in r.headers["content-security-policy"]
main.app.dependency_overrides.clear()
print("9. logos : session exigée, adresse interne refusée, servis en bac à sable")
print("OK")

# Lien d'accord envoyé à quelqu'un d'autre : son compte ne part pas vers l'agent d'un tiers sans qu'il le voie.
main.db.init()
owner = auth.create_user("porteur", "motdepasse-p")
other = auth.create_user("victime", "motdepasse-v")
with main.db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a-lie', 'Nadine', '', 'k', ?)", (owner,))
calls.clear()


def bound(state):
    connexion.expect({"adresse": ORIGIN + urlencode({"state": state}), "retour": True}, "a-lie", "notion", finish, False, owner)


bound("autre-compte")
stranger = TestClient(main.app, base_url="https://noah.exemple.test", headers={"Authorization": f"Bearer {auth.new_session(other, 't', 'web')}"}, raise_server_exceptions=False)
r = stranger.get(connexion.PATH, params={"code": "abc", "state": "autre-compte"}, follow_redirects=False)
assert r.status_code == 403 and not calls and "autre compte" in r.text, r.text
r = stranger.get(connexion.PATH, params={"code": "abc", "state": "autre-compte"}, follow_redirects=False)
assert r.status_code == 400 and not calls, "annulé pour de bon"
bound("sans-session")
r = client.post(connexion.PATH, data={"state": "sans-session", "code": "abc"}, follow_redirects=False)
assert r.status_code == 400 and not calls, "sans la page montrée, un POST direct ne passe pas"
bound("sans-session")
r = stranger.get(connexion.PATH, params={"state": "inconnu"}, follow_redirects=False)
r = client.get(connexion.PATH, params={"code": "abc", "state": "sans-session"}, follow_redirects=False)
assert r.status_code == 200 and not calls and "Nadine" in r.text and "porteur" in r.text and "<form" in r.text, r.text
assert "form-action 'self'" in r.headers["content-security-policy"], r.headers
r = client.post(connexion.PATH, data={"state": "sans-session", "code": "abc"}, follow_redirects=False)
assert r.status_code in (200, 303) and calls == ["?code=abc&state=sans-session"], (r.status_code, calls)
r = client.post(connexion.PATH, data={"state": "sans-session", "code": "abc"}, follow_redirects=False)
assert r.status_code == 400 and len(calls) == 1, "une seule fois"
calls.clear()
bound("post-etranger")
client.get(connexion.PATH, params={"code": "abc", "state": "post-etranger"}, follow_redirects=False)
r = stranger.post(connexion.PATH, data={"state": "post-etranger", "code": "abc"}, follow_redirects=False)
assert r.status_code == 403 and not calls, "le POST contrôle le compte comme le GET"
bound("le-bon")
mine = TestClient(main.app, base_url="https://noah.exemple.test", headers={"Authorization": f"Bearer {auth.new_session(owner, 't', 'web')}"}, raise_server_exceptions=False)
r = mine.get(connexion.PATH, params={"code": "abc", "state": "le-bon"}, follow_redirects=False)
assert r.status_code == 303 and len(calls) == 1, (r.status_code, calls)
print("autre compte : refusé ; sans session : la page nomme l'agent et demande ; la bonne personne : sans étape de plus")

# Le plafond de logos tient sous des demandes simultanées.
real_find, real_max = logos._find, logos.MAX_HOSTS


async def fake_find(host):
    await asyncio.sleep(0.01)
    return b"\x89PNG\r\n\x1a\n" + b"x" * 64, "image/png"


logos._find, logos.MAX_HOSTS = fake_find, 5
async def many():
    await asyncio.gather(*(logos._logo(f"site{i}.exemple") for i in range(20)))


asyncio.run(many())
assert len(list(logos._folder().glob("*.bin"))) <= 5, "plafond dépassé"
logos._find, logos.MAX_HOSTS = real_find, real_max
print("logos : plafond tenu sous 20 demandes simultanées")

# Une icône piégée ne fige pas le serveur.
import time as _time  # noqa: E402

trap = b"<!--" + b"a-->" * 0 + (b"<!---->" * 3000) + b"x"
started = _time.time()
assert logos._kind(trap[:2000]) is None
assert logos._kind(b"<?xml version='1.0'?><!-- x --><svg xmlns='a'></svg>") == "image/svg+xml"
assert _time.time() - started < 0.5, "expression qui revient en arrière"
print("icône piégée : jugée tout de suite, un vrai SVG reste reconnu")
