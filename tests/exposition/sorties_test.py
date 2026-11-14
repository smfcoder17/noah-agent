"""G7.3, partie vérifiable sans VPS : tout ce que le serveur Noah envoie vers l'extérieur, pendant une journée au repos en
accéléré puis un usage normal. Attendu par la grille : le fournisseur de modèle choisi, les sites visités par l'agent, le
registre et le manifeste des mises à jour, le distributeur de push. Aucune télémétrie.

Vrais : le serveur et ses boucles de fond, la base. Simulés : le réseau (rien ne sort, tout est enregistré, à la couche
httpx et à la couche socket), le lanceur, l'horloge (24 h en moins d'une minute). Ne voit PAS ce qui part des conteneurs
Hermes, Camoufox et Caddy, ni du démon Docker : pour eux, seule la capture de 24 h sur un VPS répond (niveau 3).

Sans option, le test échoue sur toute sortie non déclarée ou nouvelle, et sur tout paquet de télémétrie. Il liste les
écarts connus à la grille. `--strict` échoue tant que ces écarts existent : le critère, à la lettre, n'est pas tenu.

    docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/sorties_test.py"
"""
import asyncio
import json
import os
import re
import socket
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
STRICT = "--strict" in sys.argv
SECRET_FILE = Path(tempfile.mkdtemp()) / "noah.json"
os.environ.update({"NOAH_DATA_DIR": tempfile.mkdtemp(), "NOAH_DOMAIN": "auto", "LAUNCHER_KEY": "x", "NOAH_SECRET_KEY": "y" * 32,
                   "NOAH_SECRETS_FILE": str(SECRET_FILE), "LAUNCHER_URL": "http://launcher:9000"})
os.environ.pop("NOAH_LOCALE", None)
os.environ.pop("NOAH_TIMEZONE", None)
sys.path.insert(0, str(REPO / "server"))

# --- 1. Lecture : aucun paquet de télémétrie, et chaque adresse écrite dans le code a une raison d'être ---------------
TELEMETRY = re.compile(r"\b(sentry|posthog|mixpanel|amplitude|segment-analytics|analytics-node|datadog|dd-trace|ddtrace|opentelemetry|"
                       r"bugsnag|rollbar|logrocket|newrelic|new-relic|google-analytics|gtag|plausible|umami|fullstory|matomo|"
                       r"firebase-analytics|crashlytics|appcenter|hotjar|heap-analytics|applicationinsights)\b", re.I)
MANIFESTS = ["server/requirements.txt", "launcher/requirements.txt", "frontend/package.json", "frontend/package-lock.json", "desktop/package.json",
             "desktop/package-lock.json", "mobile/package.json", "mobile/package-lock.json", "frontend/index.html", "server/Dockerfile", "launcher/Dockerfile"]
MANIFESTS += [str(p.relative_to(REPO)) for p in (REPO / "mobile").rglob("*.gradle") if "node_modules" not in p.parts]
MANIFESTS += [str(p.relative_to(REPO)) for p in (REPO / "mobile").rglob("AndroidManifest.xml") if "node_modules" not in p.parts and "build" not in p.parts]
read = 0
for name in MANIFESTS:
    path = REPO / name
    if not path.is_file():  # un dossier .gradle laissé par une compilation locale ressemble à un manifeste
        continue
    read += 1
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.name == "package-lock.json":
        # Les paquets installés, seulement : assistant-stream cite OpenTelemetry en dépendance facultative, jamais installée.
        text = "\n".join(json.loads(text)["packages"])
    hit = TELEMETRY.search(text)
    assert not hit, f"télémétrie dans {name} : {hit.group(0)}"
assert read >= 8, f"{read} manifestes lus seulement : le contrôle ne regarde presque rien"
print(f"1. {read} manifestes et verrous de paquets lus : aucun paquet de télémétrie")

# Tout hôte écrit dans le code qui s'exécute. Ce qui n'est qu'un lien montré à l'utilisateur est marqué comme tel.
KNOWN = {
    # Liens que la personne ouvre elle-même : fiche Play Store (version Play) et politique de confidentialité
    "play.google.com": "lien", "noah-agent.smfcoder.com": "lien",
    # Grille : fournisseur de modèle choisi (un seul à la fois, voir plus bas)
    "openrouter.ai": "fournisseur", "api.openai.com": "fournisseur", "api.anthropic.com": "fournisseur",
    "generativelanguage.googleapis.com": "fournisseur", "ollama.com": "fournisseur", "api.mammouth.ai": "fournisseur",
    "api.mistral.ai": "fournisseur", "api.deepseek.com": "fournisseur",  # 0.1.6 : fournisseurs branchés par la personne (providers.py)
    # Page Meta où Noah lit le jeton Instagram, seulement si la personne branche Instagram (mcp.py)
    "business.facebook.com": "à la demande", "www.facebook.com": "à la demande",
    # Textes d’exemple seulement, jamais appelés : aide de la saisie et test
    "www.linkedin.com": "lien montré", "mon-fournisseur.fr": "lien montré", "exemple.org": "lien montré",
    "brollss.com": "à la demande",  # application du catalogue (MCP distant), contactée seulement si la personne la connecte
    # Modèle de décision choisi par le propriétaire, avec sa clé (decision.py)
    "api.typesafe.ai": "fournisseur",
    # Lecteurs de vidéo dans le fil : rien ne se charge avant le clic de la personne (chatMedia.ts, exposition.py)
    "www.youtube-nocookie.com": "vidéo au clic", "player.vimeo.com": "vidéo au clic", "platform.twitter.com": "vidéo au clic",
    "www.tiktok.com": "vidéo au clic", "www.youtube.com": "vidéo au clic", "vimeo.com": "vidéo au clic", "www.instagram.com": "vidéo au clic",
    # Grille : manifeste et registre des mises à jour
    "github.com": "mises à jour", "raw.githubusercontent.com": "installation (get.sh)", "get.docker.com": "installation (get.sh)",
    # Déclarés dans /api/flux, hors de la liste de la grille
    "ipinfo.io": "hors grille", "api.ipify.org": "hors grille", "ifconfig.me": "hors grille", "icanhazip.com": "hors grille",
    # Seulement si l'utilisateur branche son compte Google à un agent (déclaré dans /api/flux)
    "accounts.google.com": "à la demande", "oauth2.googleapis.com": "à la demande", "www.googleapis.com": "à la demande",
    "gmail.googleapis.com": "à la demande",  # relevé d'une veille ou d'une routine, depuis la machine de l'agent
    # Seulement si la personne connecte Instagram ou X à un agent (déclaré dans /api/flux, ligne de l'outil)
    "graph.instagram.com": "à la demande", "api.x.com": "à la demande", "x.com": "lien montré",
    "developers.facebook.com": "lien montré", "console.x.com": "lien montré",
    "console.cloud.google.com": "lien montré", "mail.google.com": "lien montré",
    # Noms sans trafic : adresses d'exemple, espaces de noms, liens de documentation
    "noah.exemple.com": "exemple", "noah.example.com": "exemple", "mcp.example.com": "exemple", "my-provider.com": "exemple", "noah.invalid": "exemple", "mcp.exemple.fr": "exemple",
    "speaches.ai": "lien montré",
    # 0.2.0 : adresses écrites dans les tests de l'interface (blocs, masquage), jamais appelées
    "boutique.example": "exemple", "shop.example.com": "exemple", "www.lemonde.fr": "exemple", "youtu.be": "exemple", "wa.me": "exemple",
    "noah.exemple.com.evil.net": "exemple", "docs.docker.com": "lien montré", "host.docker.internal": "machine elle-même",
}
SOURCES = [*(REPO / "server/noah").rglob("*.py"), *(REPO / "launcher").rglob("*.py"), *(REPO / "launcher").rglob("*.js"),
           *(REPO / "frontend/src").rglob("*.ts*"), REPO / "frontend/index.html", *(REPO / "mobile/www").glob("*.*"),
           *(REPO / "desktop").glob("*.js"), *(REPO / "desktop").glob("*.html"), REPO / "get.sh", REPO / "install.sh"]
HOST = re.compile(r"(?:https?|wss?)://([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)")
found: dict[str, set[str]] = {}
for path in SOURCES:
    for host in HOST.findall(path.read_text(encoding="utf-8", errors="replace")):
        if not host.replace(".", "").isdigit():
            found.setdefault(host.lower(), set()).add(str(path.relative_to(REPO)))
assert len(found) > 10, "presque aucune adresse trouvée : le contrôle ne regarde rien"
unknown = {h: sorted(f) for h, f in found.items() if h not in KNOWN}
assert not unknown, f"adresse inconnue dans le code (nouvelle sortie à justifier) : {unknown}"
stale = sorted(set(KNOWN) - set(found))
assert not stale, f"adresses qui ne sont plus dans le code, à retirer de la liste : {stale}"
print(f"2. {len(found)} noms d'hôtes écrits dans le code de {len(SOURCES)} fichiers : tous connus et classés")

# --- 2. Capture : tout ce qui voudrait sortir, à deux couches ----------------------------------------------------------
import httpx  # noqa: E402

REQUESTS: list[dict] = []
RAW: list[str] = []   # ce qui passe à côté de httpx (urllib, socket, websockets) : la couche socket le voit
PROVIDER_REPLY = {"choices": [{"message": {"content": "ok"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}


def answer(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if host == "api.ipify.org":
        return httpx.Response(200, text="203.0.113.5")
    if host == "ipinfo.io":
        return httpx.Response(200, json={"country": "FR", "region": "Bretagne", "timezone": "Europe/Paris"})
    if host == "openrouter.ai":
        return httpx.Response(200, json={"data": [{"id": "anthropic/modele-essai", "pricing": {"prompt": "0.000001", "completion": "0.000002"}}]})
    if host == "api.anthropic.com" and request.method == "POST":
        return httpx.Response(200, json=PROVIDER_REPLY)
    if host == "github.com":
        return httpx.Response(200, content=b"{}")  # manifeste invalide : refusé par la signature, comme une version trafiquée
    if host == "launcher":
        return httpx.Response(200, json=[] if request.url.path.endswith("/agents") else {})
    return httpx.Response(200, json={})


def note(request: httpx.Request) -> httpx.Response:
    content = request.content if hasattr(request, "_content") else b"<flux>"
    REQUESTS.append({"host": request.url.host, "method": request.method, "url": str(request.url), "body": content,
                     "auth": "authorization" in request.headers or "x-api-key" in request.headers, "cookie": "cookie" in request.headers,
                     "at": time.time()})
    return answer(request)


async def fake_async(self, request):
    await request.aread()
    return note(request)


def fake_sync(self, request):
    request.read()
    return note(request)


httpx.AsyncHTTPTransport.handle_async_request = fake_async
httpx.HTTPTransport.handle_request = fake_sync
LOCAL = re.compile(r"^(localhost|127\.|::1|0\.0\.0\.0|$)")
real_getaddrinfo, real_connect = socket.getaddrinfo, socket.socket.connect


def guarded_getaddrinfo(host, *a, **k):
    name = host.decode() if isinstance(host, bytes) else str(host)
    if not LOCAL.match(name):
        RAW.append(name)
        raise socket.gaierror("réseau coupé par le test")
    return real_getaddrinfo(host, *a, **k)


def guarded_connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not LOCAL.match(str(address[0])):
        RAW.append(str(address[0]))
        raise OSError("réseau coupé par le test")
    return real_connect(self, address)


socket.getaddrinfo = guarded_getaddrinfo
socket.socket.connect = guarded_connect

from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, catalog, db, hermes, main, public, push, relay, updates  # noqa: E402

# Pas d'écriture hors du dossier de test : l'état des mises à jour vit aussi dans les données.
db.init()
owner = auth.create_user("franck-proprietaire", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('agentsecret', 'Veilleur', '', 'k', ?)", (owner,))
db.set_setting("provider", "anthropic")
db.set_setting("model", "claude-modele-essai")
db.set_setting("api_key", "cle-du-fournisseur", secret=True)
session = auth.new_session(owner, "Firefox", "web")

# --- 3. Une journée au repos, en accéléré --------------------------------------------------------------------------------
SCALE, DAY = 1800, 86400
real_sleep, real_time = asyncio.sleep, time.time
t0 = real_time()


async def fast_sleep(delay, result=None):
    return await real_sleep(max(delay / SCALE, 0.002), result)


asyncio.sleep = fast_sleep
time.time = lambda: t0 + (real_time() - t0) * SCALE
with TestClient(main.app, headers={"Authorization": f"Bearer {session}"}) as web:
    real_sleep_wall = t0 + DAY / SCALE
    while real_time() < real_sleep_wall:
        time.sleep(0.5)
    idle = list(REQUESTS)
    idle_external = sorted({r["host"] for r in idle} - {"launcher"} - {h for h in {r["host"] for r in idle} if h.startswith("noah-")})
    manifests = [r for r in idle if r["url"] == updates.MANIFEST_URL]
    print(f"3. 24 h simulées au repos : {len(idle)} requêtes, vers l'extérieur {idle_external} ; manifeste lu {len(manifests)} fois")
    assert public.domains(), "le service d'adresse publique n'a pas répondu : la boucle de démarrage n'a pas tourné"
    assert 12 <= len(manifests) <= 30, f"manifeste lu {len(manifests)} fois en 24 h (annoncé : une fois par heure)"

    # --- 4. Usage normal : un message au modèle, le navigateur d'un agent, une notification --------------------------------
    agent = TestClient(main.app, headers={"Authorization": f"Bearer {relay.token_for('agentsecret')}"})
    r = agent.post("/relay/v1/chat/completions", json={"model": "claude-modele-essai", "messages": [{"role": "user", "content": "phrase-privee-de-franck"}]})
    assert r.status_code == 200, r.text
    identity = asyncio.run(hermes.browser_identity())
    assert identity["timezone"] == "Europe/Paris", identity
    from cryptography.hazmat.primitives import serialization  # noqa: E402
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
    import base64  # noqa: E402

    point = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    assert web.post("/api/push/subscription", json={"endpoint": "https://fcm.googleapis.com/fcm/send/essai",
                                                    "p256dh": base64.urlsafe_b64encode(point).decode().rstrip("="),
                                                    "auth": "AAAAAAAAAAAAAAAAAAAAAA"}).status_code == 200
    asyncio.run(push.send("titre-prive", "texte-prive", "/", False, user_id=owner))
    flux = web.get("/api/flux").json()
asyncio.sleep, time.time = real_sleep, real_time

# --- 5. Verdict ------------------------------------------------------------------------------------------------------------
INTERNAL = re.compile(r"^(launcher|noah-.*|host\.docker\.internal)$")
external = [r for r in REQUESTS if not INTERNAL.match(r["host"])]
hosts = sorted({r["host"] for r in external})
assert {"api.anthropic.com", "github.com", "fcm.googleapis.com"} <= set(hosts), f"capture incomplète : le contrôle ne voit pas le trafic ({hosts})"
print(f"4. sorties observées : {hosts}")

# 5.1 Rien ne passe à côté de la capture httpx (urllib, socket directe, websockets).
raw_external = sorted({h for h in RAW if not INTERNAL.match(h)})
assert not raw_external, f"sortie hors de httpx, vers : {raw_external}"
print("5. couche socket : aucune sortie à côté de httpx")

# 5.2 Tout ce qui sort est annoncé à l'utilisateur dans Réglages (/api/flux), et /api/flux dit qu'il n'y a pas de télémétrie.
assert flux["telemetrie"] is False
declared = {h.strip() for f in flux["flux"] for h in f["vers"].split(",")}
undeclared = [h for h in hosts if h not in declared]
assert not undeclared, f"sortie absente de /api/flux : {undeclared} (déclaré : {sorted(declared)})"
print(f"6. tout est annoncé dans /api/flux ({len(declared)} destinations), qui répond telemetrie=false")

# 5.3 Un seul fournisseur : le choisi. Les autres ne sont jamais contactés.
others = {h for h, kind in KNOWN.items() if kind == "fournisseur"} - {"api.anthropic.com", "openrouter.ai"}
assert not others & set(hosts), f"autre fournisseur contacté : {others & set(hosts)}"
to_provider = [r for r in external if r["host"] == "api.anthropic.com"]
assert any(b"phrase-privee-de-franck" in r["body"] for r in to_provider), "le message n'est pas parti chez le fournisseur choisi"
print("7. fournisseur choisi (Anthropic) contacté, avec le message ; aucun autre fournisseur")

# 5.4 Ce qui ne porte pas de données : ni corps, ni identifiant, ni clé, ni donnée du compte. La phrase privée, le compte,
# l'agent, le titre de la notification ne vont nulle part ailleurs que chez le fournisseur.
private = [b"phrase-privee-de-franck", b"franck-proprietaire", b"agentsecret", b"titre-prive", b"texte-prive", b"cle-du-fournisseur"]
for r in external:
    if r["host"] == "api.anthropic.com":
        continue
    blob = r["url"].encode() + (r["body"] if isinstance(r["body"], bytes) else b"")
    leaks = [p.decode() for p in private if p in blob]
    assert not leaks, f"{leaks} part vers {r['host']}"
    if r["host"] != "fcm.googleapis.com":
        assert r["method"] == "GET" and not r["body"] and not r["cookie"], f"{r['host']} reçoit des données : {r['method']} {r['url']}"
        assert not r["auth"], f"{r['host']} reçoit une clé"
push_out = [r for r in external if r["host"] == "fcm.googleapis.com"]
assert push_out and push_out[0]["method"] == "POST" and len(push_out[0]["body"]) > 50, "notification pas envoyée"
print("8. ni compte, ni agent, ni message, ni clé vers les autres hôtes : des GET sans corps ; la notification part chiffrée")

# 5.5 Rapport à la grille : chaque hôte hors de sa liste est un écart connu, nommé.
GRID = {"api.anthropic.com", "github.com", "fcm.googleapis.com"}
gaps = sorted(set(hosts) - GRID)
KNOWN_GAPS = {
    "openrouter.ai": "catalogue public des prix, au plus une fois par heure, même si le fournisseur choisi est un autre (estimation des coûts et plafonds)",
    "ipinfo.io": "une seule fois : pays et fuseau du navigateur des agents (NOAH_LOCALE et NOAH_TIMEZONE l'évitent)",
    "api.ipify.org": "au démarrage : adresse publique pour le nom sslip.io",
}
assert set(gaps) == set(KNOWN_GAPS), f"écarts à la grille changés : observés {gaps}, connus {sorted(KNOWN_GAPS)}"
for g in gaps:
    print(f"   hors de la liste de la grille : {g} : {KNOWN_GAPS[g]}")
print("   hors de portée de ce test : Caddy (acme-v02.api.letsencrypt.org, déclaré), le démon Docker, Hermes, Camoufox")
print(f"G7.3 : aucune télémétrie, aucune sortie non déclarée ; {len(gaps)} écarts connus à la liste de la grille")
if STRICT and gaps:
    print(f"--strict : {len(gaps)} hôtes hors de la liste de la grille : {gaps}")
sys.stdout.flush()
os._exit(1 if STRICT and gaps else 0)  # les boucles de fond du serveur n'ont pas à finir leur journée
