"""Noah à une adresse publique : ce qu'un inconnu voit, peut demander et peut forcer. Vraies routes, vraie base, vrais en-têtes ;
Hermes et le lanceur sont simulés. L'attaque en conditions réelles (Caddy devant, Chrome, capture du trafic) se rejoue avec
tests/exposition/fuites_navigateur.mjs.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/public_test.py"
"""
import asyncio
import json
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
web = Path(tempfile.mkdtemp())
(web / "assets").mkdir()
(web / "index.html").write_text("<!doctype html><title>Noah</title>")
(web / "assets" / "index-AbCd1234.js").write_text("console.log(1)")
(web / "manifest.webmanifest").write_text("{}")
(web / "sw.js").write_text("")
os.environ["NOAH_WEB_DIR"] = str(web)
os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["NOAH_SETUP_CODE"] = "BCDFGHJKLMNP"
sys.path.insert(0, str(REPO / "server"))
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from noah import auth, db, hermes, main, relay  # noqa: E402

app = main.app
db.init()
main._ip = lambda request: request.headers.get("x-forwarded-for", "")  # ce qu'Uvicorn lit derrière Caddy ; TestClient n'a pas d'adresse
ADDRESS = iter(range(1, 60000))


def anonymous(ip: str | None = None, **kw) -> TestClient:
    """Un visiteur vu à travers Caddy : Caddy ajoute toujours X-Forwarded-For, qu'on ne distingue donc jamais d'Internet."""
    n = next(ADDRESS)
    ip = ip or f"203.0.{n // 250}.{n % 250 + 1}"
    return TestClient(app, base_url="https://noah.exemple", headers={"X-Forwarded-For": ip}, raise_server_exceptions=False, **kw)


# --- 1. Premier lancement : avant le compte -----------------------------------------------------------------------------
def test_first_run() -> None:
    st = anonymous().get("/api/status").json()
    assert st["has_account"] is False and st["setup_code"] is True and st["secrets_lisibles"] is True, st
    assert "BCDFGHJKLMNP" not in json.dumps(st), "le code d'installation sort par l'état public"
    body = {"username": "alice", "password": "motdepasse-a"}
    assert anonymous().post("/api/setup/account", json=body).status_code == 403
    r = anonymous().post("/api/setup/check", json={"installation": "é" * 12})
    assert r.status_code == 403, f"code non ASCII : {r.status_code} (500 = trace écrite par un inconnu dans le diagnostic)"
    print("1. premier lancement : compte refusé sans le code, code absent de l'état public, code non ASCII refusé sans erreur 500")


test_first_run()
ALICE = auth.create_user("alice", "motdepasse-a")
BRUNO = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'A', '', 'CLE-AGENT', ?)", (ALICE,))
db.set_setting("provider", "openrouter")
db.set_setting("api_key", "sk-CLE-DU-MODELE", secret=True)
db.set_setting("onboarded", "1")


def session(user: int, **kw) -> TestClient:
    return TestClient(app, base_url="https://noah.exemple", headers={"Authorization": f"Bearer {auth.new_session(user, 't', 'web')}"},
                      raise_server_exceptions=False, **kw)


# --- 2. Descriptions de l'API ---------------------------------------------------------------------------------------------
def test_no_api_description() -> None:
    for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
        assert anonymous().get(path).status_code == 404, f"{path} est ouvert"
    print("2. /docs, /redoc et /openapi.json n'existent pas")


# --- 3. Robots et en-têtes -----------------------------------------------------------------------------------------------
def test_robots() -> None:
    r = anonymous().get("/robots.txt")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain"), r.text
    assert re.search(r"User-agent: \*\s+Disallow: /\s*$", r.text), r.text
    for path in ("/robots.txt", "/", "/api/status", "/api/me", "/nexiste-pas", "/assets/index-AbCd1234.js", "/sw.js"):
        tag = anonymous().get(path).headers.get("x-robots-tag")
        assert tag == "noindex, nofollow, noarchive", f"{path} : {tag}"
    page = (REPO / "frontend" / "index.html").read_text(encoding="utf-8")
    assert '<meta name="robots" content="noindex, nofollow, noarchive"' in page, "pas de balise robots dans la page"
    print("3. robots.txt, X-Robots-Tag sur toutes les réponses (404 et statiques compris), balise dans la page")


def directives(csp: str) -> dict[str, str]:
    return {part.split()[0]: part.split(None, 1)[1] if " " in part.strip() else "" for part in csp.split(";") if part.strip()}


def test_security_headers() -> None:
    for path in ("/", "/api/status", "/nexiste-pas", "/assets/index-AbCd1234.js"):
        h = anonymous().get(path).headers
        assert h.get("strict-transport-security") == "max-age=31536000", (path, h)
        assert h.get("x-content-type-options") == "nosniff", (path, h)
        assert h.get("x-frame-options") == "SAMEORIGIN", (path, h)
        assert h.get("referrer-policy") == "same-origin", (path, h)
        assert "microphone=(self)" in h.get("permissions-policy", "") and "camera=()" in h["permissions-policy"], (path, h)
        csp = directives(h["content-security-policy"])
        assert csp["default-src"] == "'self'" and csp["script-src"] == "'self'", csp
        assert csp["frame-ancestors"] == "'self'" and csp["object-src"] == "'none'" and csp["base-uri"] == "'self'", csp
        assert csp["frame-src"] == "'self'" and "'self'" in csp["connect-src"], csp
    plain = TestClient(app, base_url="http://localhost:8080").get("/")
    assert "strict-transport-security" not in plain.headers, "HSTS sur une adresse en clair"

    # Une panne de Noah (500, servie hors des intergiciels) garde les mêmes en-têtes.
    def boom():
        raise RuntimeError("panne")
    app.add_api_route("/_essai/panne", boom)
    app.router.routes.insert(0, app.router.routes.pop())
    r = anonymous().get("/_essai/panne")
    assert r.status_code == 500 and "x-robots-tag" in r.headers and "content-security-policy" in r.headers, r.headers
    app.router.routes.pop(0)

    # noVNC : ses modules en ligne doivent tourner, son WebSocket passer ; rien d'autre ne s'ouvre.
    async def novnc_file(*a, **k):
        return httpx.Response(200, text="<html>", headers={"content-type": "text/html"})
    transport = httpx.MockTransport(lambda req: httpx.Response(200, text="<html>", headers={"content-type": "text/html"}))
    real = httpx.AsyncClient
    httpx.AsyncClient = lambda **k: real(transport=transport, **k)
    try:
        h = session(ALICE).get("/api/agents/a1/screen/vnc.html").headers
    finally:
        httpx.AsyncClient = real
    csp = directives(h["content-security-policy"])
    assert "'unsafe-inline'" in csp["script-src"] and "'self'" in csp["connect-src"] and csp["frame-ancestors"] == "'self'", csp
    print("3 bis. HSTS (HTTPS seulement), CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy partout, 500 compris ; CSP à part pour noVNC")


async def _page(agent_id, path):
    return httpx.Response(200, content=b"<script>1</script>")


async def _svg(agent_id, path):
    return httpx.Response(200, content=b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", headers={"content-type": "image/svg+xml"})


def test_agent_content_stays_sandboxed() -> None:
    """Ce que produit un agent ne s'exécute jamais avec l'origine de Noah : une page injectée y volerait la session."""
    hermes.read_file, hermes.media = _page, _svg
    alice = session(ALICE)
    raw = alice.get("/api/agents/a1/files/raw/page.html").headers
    assert raw["content-security-policy"].startswith("sandbox "), raw
    assert raw["x-frame-options"] == "SAMEORIGIN", raw
    link = alice.post("/api/agents/a1/apercu", json={"path": "app/page.html"}).json()["url"]
    preview = anonymous().get(link)
    assert preview.status_code == 200 and preview.headers["content-security-policy"].startswith("sandbox "), preview.headers
    # Une page d'aperçu peut citer ses propres cadres : leur parent a une origine opaque, X-Frame-Options les bloquerait.
    assert "x-frame-options" not in preview.headers, preview.headers
    assert "x-robots-tag" in preview.headers
    media = alice.get("/api/agents/a1/media", params={"path": "/opt/data/workspace/x.svg"}).headers
    assert "sandbox" in media.get("content-security-policy", ""), f"SVG d'agent actif à l'origine de Noah : {media}"
    assert anonymous().get("/api/apercu/abc.%C3%A9/x").status_code == 403, "signature non ASCII : 500"
    print("4. contenus d'agent (fichier, aperçu, média SVG) en bac à sable ; signature d'aperçu non ASCII refusée sans erreur 500")


# --- 5. Ce qu'un inconnu lit -----------------------------------------------------------------------------------------------
def test_status_says_little() -> None:
    st = anonymous().get("/api/status").json()
    assert set(st) == {"has_account", "setup_code", "api", "min_client_version"}, f"trop d'informations pour un inconnu : {st}"
    assert st["has_account"] is True and st["setup_code"] is False
    full = session(ALICE).get("/api/status").json()
    assert full["onboarded"] is True and full["model_configured"] is True and full["secrets_lisibles"] is True, full
    revoked = auth.new_session(ALICE, "t", "web")
    auth.drop_session(revoked)
    assert "onboarded" not in anonymous().get("/api/status", headers={"Authorization": f"Bearer {revoked}"}).json(), "session révoquée"
    # Depuis son propre réseau (lanceur, conteneur) : tout l'état, sans session. La restauration vérifie ainsi la clé.
    inside = TestClient(app, base_url="http://server:8080").get("/api/status").json()
    assert inside["secrets_lisibles"] is True and inside["onboarded"] is True, inside
    print("5. /api/status : un inconnu n'apprend que ce qu'il faut pour choisir l'écran ; session ou réseau interne : tout")


def test_internal_routes_from_outside() -> None:
    """Par le mandataire, ces routes n'existent pas pour un inconnu, même pour lire leur format en 422."""
    token = relay.token_for("a1")
    for method, path in (("POST", "/agent-api/demander"), ("POST", "/agent-api/installer"), ("GET", "/agent-api/etat"),
                         ("POST", "/relay/v1/chat/completions"), ("GET", "/api/tls-ask?domain=noah.exemple"), ("GET", "/api/public")):
        for headers in ({}, {"Authorization": f"Bearer {token}"}):
            r = anonymous().request(method, path, json={} if method == "POST" else None, headers=headers)
            assert r.status_code == 403, f"{method} {path} {headers and 'avec jeton'} : {r.status_code} {r.text[:120]}"
    inside = TestClient(app, base_url="http://server:8080")
    assert inside.get("/api/public").status_code == 200, "le lanceur lit l'adresse publique sans session"
    assert inside.get("/api/tls-ask?domain=inconnu.exemple").status_code == 403
    print("6. /agent-api, /relay, /api/tls-ask, /api/public refusés depuis l'extérieur, même avec un vrai jeton de relais ; intérieur intact")


def test_providers_need_a_session() -> None:
    assert anonymous().get("/api/providers").status_code == 401
    assert session(ALICE).get("/api/providers").status_code == 200
    print("7. /api/providers derrière la connexion")


def test_restore_status_says_nothing() -> None:
    async def launcher(method, path, **kw):
        return {"etape": "Vérification", "erreur": "/var/lib/docker/volumes/noah-secrets : clé illisible", "fini": False, "avertissement": "/data/backup.tar"}
    real, hermes._launcher = hermes._launcher, launcher
    try:
        text = anonymous().get("/api/setup/restore").text
        assert "/var/lib" not in text and "/data" not in text, f"chemin interne lu par un inconnu : {text}"
        assert session(ALICE).get("/api/setup/restore").json()["erreur"].startswith("/var/lib"), "le propriétaire garde le détail"
    finally:
        hermes._launcher = real
    print("8. /api/setup/restore : un inconnu ne lit plus le détail du lanceur une fois le compte créé")


# --- 9. Connexion ----------------------------------------------------------------------------------------------------------
def _reset() -> None:
    main._failed_logins.clear()
    main._account_failures.clear()


def test_login_same_answer() -> None:
    _reset()
    known = anonymous().post("/api/login", json={"username": "alice", "password": "mauvais-mot"})
    unknown = anonymous().post("/api/login", json={"username": "personne", "password": "mauvais-mot"})
    assert (known.status_code, known.text) == (unknown.status_code, unknown.text), (known.text, unknown.text)

    def timed(user: str) -> float:
        started = time.perf_counter()
        anonymous().post("/api/login", json={"username": user, "password": "mauvais-mot"})
        return time.perf_counter() - started
    known_t = sorted(timed("alice") for _ in range(3))[1]
    unknown_t = sorted(timed(f"personne-{i}") for i in range(3))[1]
    assert unknown_t > known_t / 3, f"compte inconnu en {unknown_t * 1000:.0f} ms, connu en {known_t * 1000:.0f} ms : l'attente trahit les comptes"
    print(f"9. compte inconnu : même réponse, même attente ({unknown_t * 1000:.0f} ms contre {known_t * 1000:.0f} ms)")


def test_login_limits() -> None:
    _reset()
    same = anonymous()
    codes = [same.post("/api/login", json={"username": "alice", "password": f"mauvais-{i}"}).status_code for i in range(12)]
    assert codes == [401] * 10 + [429] * 2, codes

    # Essais simultanés : chacun réserve sa place avant bcrypt, personne ne passe au travers.
    _reset()
    ip = "203.0.113.77"
    out: list[int] = []
    def one() -> None:
        out.append(anonymous(ip).post("/api/login", json={"username": "alice", "password": "mauvais-simultane"}).status_code)
    threads = [threading.Thread(target=one) for _ in range(25)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert out.count(401) <= main.LOGIN_TRIES, f"{out.count(401)} essais simultanés ont atteint bcrypt : {sorted(out)}"

    # Un compte à soi ne remet pas le compteur de son adresse à zéro.
    _reset()
    mine = "203.0.113.78"
    seen = []
    for i in range(14):  # un client neuf à chaque fois : sinon le cookie reçu ferait refuser l'essai suivant (403, sans Origin)
        seen.append(anonymous(mine).post("/api/login", json={"username": "alice", "password": f"mauvais-{i}"}).status_code)
        if i % 4 == 3:
            anonymous(mine).post("/api/login", json={"username": "bruno", "password": "motdepasse-b"})
    assert 429 in seen, f"essais illimités en se connectant à son propre compte : {seen}"

    # Beaucoup d'adresses (ou un en-tête falsifié sans mandataire devant) : le compte a son propre plafond…
    _reset()
    many = [anonymous().post("/api/login", json={"username": "alice", "password": "mauvais-reparti"}).status_code for _ in range(main.LOGIN_ACCOUNT_TRIES + 3)]
    assert many[-1] == 429 and many.count(401) == main.LOGIN_ACCOUNT_TRIES, many
    same_for_unknown = [anonymous().post("/api/login", json={"username": "fantome", "password": "mauvais-reparti"}).status_code for _ in range(main.LOGIN_ACCOUNT_TRIES + 1)]
    assert same_for_unknown[-1] == 429, "le plafond distingue les comptes qui existent"

    # … qui ne bloque pas son propriétaire depuis une adresse qu'il a déjà utilisée.
    _reset()
    home = "198.51.100.9"
    assert anonymous(home).post("/api/login", json={"username": "alice", "password": "motdepasse-a"}).status_code == 200
    for _ in range(main.LOGIN_ACCOUNT_TRIES):
        anonymous().post("/api/login", json={"username": "alice", "password": "mauvais-reparti"})
    assert anonymous().post("/api/login", json={"username": "alice", "password": "motdepasse-a"}).status_code == 429
    assert anonymous(home).post("/api/login", json={"username": "alice", "password": "motdepasse-a"}).status_code == 200
    _reset()
    print(f"10. limites : {main.LOGIN_TRIES} par adresse, simultanés compris, sans remise à zéro par son propre compte ; {main.LOGIN_ACCOUNT_TRIES} par compte, le propriétaire chez lui passe")


def test_login_cookie_and_body() -> None:
    _reset()
    r = anonymous().post("/api/login", json={"username": "alice", "password": "motdepasse-a"})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie, cookie
    assert "token" not in r.json(), f"le jeton d'un cookie HttpOnly revient au script de la page : {r.json()}"
    assert r.cookies.get("noah_session") or "noah_session=" in r.headers["set-cookie"]
    print("11. connexion navigateur : cookie Secure, HttpOnly, SameSite=Lax, et le jeton ne revient pas au script")


# --- 12. Autre origine -------------------------------------------------------------------------------------------------------
def test_other_origins() -> None:
    token = auth.new_session(ALICE, "t", "web")
    jar = {"noah_session": token}
    for origin in ("https://evil.example", "null", "https://autre.noah.exemple"):
        c = anonymous(cookies=jar)
        assert c.post("/api/agents", json={"name": "x", "role": ""}, headers={"Origin": origin}).status_code == 403, origin
    r = anonymous(cookies=jar).get("/api/me", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers, r.headers
    p = anonymous().options("/api/me", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in p.headers, p.headers

    # Un site frère (autre.exemple sur le même domaine) est « même site » pour SameSite : le cookie part avec la poignée de main.
    route = "/api/agents/a1/screen/websockify"
    for headers in ({"Origin": "https://autre.noah.exemple"}, {}):
        ws = anonymous(cookies=jar)
        try:
            with ws.websocket_connect(route, headers={"Host": "noah.exemple", **headers}):
                raise AssertionError(f"écran ouvert avec le cookie depuis {headers}")
        except WebSocketDisconnect as e:
            assert e.code == 4403, e.code
    print("12. autre origine : écriture 403, aucun CORS, écran noVNC refusé depuis un site frère (détournement du WebSocket)")


def test_screen_password_out_of_address() -> None:
    async def yes(*a):
        return True
    main.handoff.take_control = yes
    url = session(ALICE).get("/api/agents/a1/screen-url").json()["url"]
    path, _, fragment = url.partition("#")
    assert "password" not in path and "password=" in fragment, f"mot de passe de l'écran dans l'adresse, donc dans les journaux : {url}"
    print("13. le mot de passe de l'écran est dans le # : il ne part ni au serveur ni dans les journaux")


# --- 14. Fichiers de déploiement -----------------------------------------------------------------------------------------------
def test_deploy_files() -> None:
    assert "--no-server-header" in (REPO / "server" / "Dockerfile").read_text(encoding="utf-8"), "Uvicorn se nomme (compose Traefik)"
    launcher = (REPO / "launcher" / "launcher.py").read_text(encoding="utf-8")
    assert "compare_digest" in launcher.split("def auth", 1)[1].split("def check_id", 1)[0], "clé du lanceur comparée en temps variable"
    for name in ("deploy/Caddyfile", "deploy/docker-compose.yml"):
        text = (REPO / name).read_text(encoding="utf-8")
        assert "-Server" in text, name
        # Le serveur pose ces en-têtes : les répéter ici les enverrait en double.
        assert not re.search(r"^\s*(Strict-Transport-Security|X-Content-Type-Options|Referrer-Policy)\b", text, re.M), name
        assert "log_skip /api/apercu/*" in text and "delete installation" in text, f"{name} : jetons dans le journal d'accès"
    print("14. Uvicorn ne se nomme plus, clé du lanceur comparée en temps constant, Caddy ne double pas les en-têtes")
    assert "--no-access-log" in (REPO / "server" / "Dockerfile").read_text(encoding="utf-8"), "journal d'accès d'Uvicorn : les adresses y finissent"
    assert "/#installation=%s" in (REPO / "server" / "noah" / "public.py").read_text(encoding="utf-8"), "le code d'installation part vers le serveur"
    onboarding = (REPO / "frontend" / "src" / "components" / "Onboarding.tsx").read_text(encoding="utf-8")
    assert "location.hash" in onboarding and "location.search" in onboarding, "l'interface lit le # et les anciens liens"
    get_sh = (REPO / "get.sh").read_text(encoding="utf-8")
    assert '/#installation=$code' in get_sh and "?installation" not in get_sh
    print("14 bis. ni code d'installation ni jeton d'aperçu dans les journaux d'accès")
    pins = [re.search(r"fastapi==([\d.]+)", (REPO / f).read_text(encoding="utf-8")).group(1) for f in ("server/requirements.txt", "launcher/Dockerfile")]
    assert pins[0] == pins[1], pins
    assert "openapi_url=None" in launcher, "le lanceur décrit ses routes sans clé"


def test_range_header() -> None:
    """CVE-2025-62727 : Starlette < 0.49.1 met un temps quadratique à lire un en-tête Range malformé, sur tout fichier public."""
    from importlib.metadata import version
    found = tuple(int(n) for n in version("starlette").split(".")[:3])
    assert found >= (0, 49, 1), f"Starlette {found} : CVE-2025-62727"
    started = time.monotonic()
    r = anonymous().get("/assets/index-AbCd1234.js", headers={"Range": "bytes=" + "1" * 50000})
    took = time.monotonic() - started
    assert r.status_code in (200, 206, 400, 416) and took < 2, f"Range malformé : {r.status_code} en {took:.1f} s"
    print(f"16. Starlette {'.'.join(map(str, found))} : un Range malformé de 50 000 caractères coûte {took * 1000:.0f} ms")


def test_assets() -> None:
    for path in ("/assets/", "/assets/..%2f..%2fetc%2fpasswd", "/assets/%2e%2e/%2e%2e/etc/passwd", "/assets/index-AbCd1234.js.map", "/.env", "/noah.db"):
        assert anonymous().get(path).status_code == 404, path
    build = (REPO / "frontend" / "vite.config.ts").read_text(encoding="utf-8")
    assert "sourcemap: true" not in build, "cartes de source publiées"
    print("15. statiques : ni liste, ni remontée de dossier, ni carte de source")


for test in (test_no_api_description, test_robots, test_security_headers, test_agent_content_stays_sandboxed, test_status_says_little,
             test_internal_routes_from_outside, test_providers_need_a_session, test_restore_status_says_nothing, test_login_same_answer,
             test_login_limits, test_login_cookie_and_body, test_other_origins, test_screen_password_out_of_address, test_deploy_files, test_assets, test_range_header):
    test()
print("OK : exposition publique")
