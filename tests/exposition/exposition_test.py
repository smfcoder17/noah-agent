"""G7.1, partie vérifiable sans VPS : ce que l'installation publie sur Internet, lu dans ses fichiers et dans les appels
Docker du lanceur. Attendu : 80 et 443 seulement ; Hermes (8642), Camoufox (9377, 6080) et le lanceur (9000) jamais publiés.

Vrais : les fichiers Compose et Caddy, le code du lanceur et de son outil de mise à jour, les routes du serveur.
Simulé : Docker (le client enregistre les appels). Un `nmap` depuis Internet sur un VPS neuf reste à faire (niveau 3).

    docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/exposition_test.py"
"""
import ast
import os
import re
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock

import yaml

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
INTERNAL_PORTS = {8642, 9377, 6080, 5900, 9000, 8080, 11434}


def default(text: str) -> str:
    """Valeur sans rien configurer : ${VAR:-défaut} devient défaut, ${VAR:?message} et ${VAR} restent vides."""
    return re.sub(r"\$\{\w+(?::?-([^}]*)|:?\?[^}]*)?\}", lambda m: m.group(1) or "", text)


def published(service: dict) -> set[tuple[str, int, int, str]]:
    """(adresse, port de l'hôte, port du conteneur, protocole) de chaque port publié, écriture courte ou longue."""
    out = set()
    for p in service.get("ports") or []:
        if isinstance(p, dict):
            out.add((p.get("host_ip", ""), int(p["published"]), int(p["target"]), p.get("protocol", "tcp")))
            continue
        spec, _, proto = default(str(p)).partition("/")
        parts = spec.split(":")
        host_ip = parts[0] if len(parts) == 3 else ""
        out.add((host_ip, int(parts[-2]) if len(parts) > 1 else int(parts[-1]), int(parts[-1]), proto or "tcp"))
    return out


def compose(name: str) -> dict:
    return yaml.safe_load((REPO / name).read_text(encoding="utf-8"))["services"]


# 1. Installation VPS par défaut : seul Caddy publie, et seulement 80 et 443.
vps = compose("deploy/docker-compose.yml")
ports = {name: published(s) for name, s in vps.items()}
assert ports.pop("caddy") == {("", 80, 80, "tcp"), ("", 443, 443, "tcp"), ("", 443, 443, "udp")}, "ports de Caddy"
assert not any(ports.values()), f"service publié en plus de Caddy : {ports}"
assert {"server", "launcher", "caddy"} <= set(vps), "le fichier a changé de forme : le contrôle ne regarde plus les bons services"
for name, s in vps.items():
    assert s.get("network_mode") is None, f"{name} sur le réseau de l'hôte"
    assert s.get("networks") == ["apollo"], f"{name} hors du réseau interne : {s.get('networks')}"
print("1. deploy/docker-compose.yml : seul Caddy publie, 80/tcp, 443/tcp et 443/udp ; aucun réseau de l'hôte")

# 2. Autres manières d'installer : rien sur une adresse publique sans le demander.
traefik = compose("deploy/docker-compose.traefik.yml")
assert published(traefik["server"]) == {("127.0.0.1", 8088, 8080, "tcp")}, published(traefik["server"])
assert not any(published(s) for n, s in traefik.items() if n != "server"), "service publié derrière Traefik"
local = compose("docker-compose.yml")
assert published(local["server"]) == {("127.0.0.1", 8080, 8080, "tcp")}, published(local["server"])
assert not any(published(s) for n, s in local.items() if n != "server"), "service publié en installation locale"
print("2. derrière Traefik et en local : le serveur sur 127.0.0.1 seulement, rien d'autre")

# 3. Caddy ne mène qu'au serveur : aucun chemin vers Hermes, Camoufox ou le lanceur.
caddyfiles = {"deploy/Caddyfile": (REPO / "deploy/Caddyfile").read_text(encoding="utf-8"),
              "compose": yaml.safe_load((REPO / "deploy/docker-compose.yml").read_text(encoding="utf-8"))["configs"]["caddyfile"]["content"]}
for name, text in caddyfiles.items():
    targets = re.findall(r"reverse_proxy\s+(\S+)", text)
    assert targets == ["server:8080"], f"{name} : {targets}"
print("3. Caddy : un seul reverse_proxy, vers server:8080")

# 4. Le pare-feu ouvert par get.sh : 80 et 443.
opened = re.findall(r"ufw allow (\S+)", (REPO / "get.sh").read_text(encoding="utf-8"))
assert sorted(opened) == ["443/tcp", "443/udp", "80/tcp"], opened
print("4. get.sh : ufw n'ouvre que 80 et 443")

# 5. Conteneurs créés par le lanceur (agents, navigateurs, outils) : le lanceur lui-même, Docker enregistré.
docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
os.environ.update({"LAUNCHER_KEY": "x", "AGENT_NETWORK": "apollo-net", "NOAH_UPDATE_STATE": str(Path(tempfile.mkdtemp()) / "updates.json"),
                   "NOAH_SECRETS_FILE": str(Path(tempfile.mkdtemp()) / "noah.json")})
sys.path.insert(0, str(REPO / "launcher"))
start = threading.Thread.start
threading.Thread.start = lambda self: None  # à l'import, le lanceur lance ses reprises de mise à jour : pas ici
import launcher  # noqa: E402
import updater  # noqa: E402

threading.Thread.start = start
client = launcher.client
updater.client = client
updater.put_env = launcher.updater.put_env = lambda *a, **k: None
client.containers.get.side_effect = docker.errors.NotFound()
client.images.get.return_value.attrs = {"Config": {"Entrypoint": ["node"], "Cmd": ["server.js"]}}
PUBLISHING = {"ports", "publish_all_ports", "network_mode", "network_disabled"}


def created() -> dict:
    call = client.containers.create.call_args
    assert call is not None, "aucun conteneur créé : le contrôle ne regarde rien"
    return call.kwargs


launcher._run_agent("essai", "k", [])
agent = created()
assert not PUBLISHING & set(agent), f"agent : {PUBLISHING & set(agent)}"
assert agent["network"] == "apollo-net" and agent["name"] == "apollo-agent-essai", agent
assert agent["environment"]["API_SERVER_HOST"] == "0.0.0.0", "le contrôle attend une écoute sur le réseau interne"
client.containers.create.reset_mock()
launcher.container = lambda agent_id: None  # le navigateur vérifie d'abord que l'agent existe

class Created(Exception):
    """Le conteneur est créé : la suite (fichiers posés dedans) ne change rien aux ports."""


client.containers.create.return_value.get_archive.side_effect = Created()
try:
    launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b", private_key="c", locale="", timezone=""))
except Created:
    pass
browser = created()
assert not PUBLISHING & set(browser), f"navigateur : {PUBLISHING & set(browser)}"
assert browser["network"] == "apollo-net", browser
assert browser["environment"]["CAMOFOX_CRASH_REPORT_ENABLED"] == "false", "rapports de plantage du navigateur activés"
print("5. agent et navigateur créés par le lanceur : réseau apollo-net, aucun port publié")

# 6. Tous les appels Docker du lanceur, même ceux que ce test ne déclenche pas : aucun ne publie de port.
found = []
for path in sorted((REPO / "launcher").rglob("*.py")):
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Call):
            found += [(path.name, node.lineno, kw.arg, ast.unparse(kw.value)) for kw in node.keywords if kw.arg in PUBLISHING | {"port_bindings"}]
# Seul cas : la copie de la liste « ExposedPorts » (déclaration, sans publication) à la recréation d'un conteneur.
extra = [f for f in found if not (f[0] == "updater.py" and f[2] == "ports" and "ExposedPorts" in f[3])]
assert not extra, f"appel Docker qui publie un port : {extra}"
print(f"6. appels Docker du lanceur lus un par un : aucun ne publie de port ({len(found)} déclaration d'« ExposedPorts »)")

# 7. Recréation à la mise à jour : elle garde ce que le conteneur avait, sans rien publier de plus.
old = MagicMock()
old.id = "abcdef012345"
old.attrs = {"Config": {"Env": [], "ExposedPorts": {"8642/tcp": {}}, "Labels": {}}, "HostConfig": {"NetworkMode": "apollo-net", "PortBindings": None},
             "NetworkSettings": {"Networks": {"apollo-net": {"Aliases": []}}}, "Mounts": []}
old.image.attrs = {"Config": {}}
old.get_archive.side_effect = docker.errors.NotFound()  # pas de droits d'outils à recopier
updater._get = lambda name: None
client.api.create_container.return_value = {"Id": "nouveau"}
client.containers.get.side_effect = None
updater._create_like(old, "apollo-agent-essai", "image")
kw = client.api.create_container.call_args.kwargs
assert not kw["host_config"].get("PortBindings") and not kw["host_config"].get("PublishAllPorts"), kw["host_config"]
print("7. agent recréé par une mise à jour : toujours aucun port publié")

# 8. Par les routes : personne sans session ne fait parler le serveur à Hermes, au navigateur ou au lanceur.
os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ["LAUNCHER_URL"] = "http://launcher:9000"
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
sys.path.insert(0, str(REPO / "server"))
import httpx  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.routing import WebSocketRoute  # noqa: E402

reached: list[tuple[str, str, str, str]] = []
route_now = ["", ""]


async def record_async(self, request):
    reached.append((*route_now, request.url.host, request.method + " " + request.url.path))
    return httpx.Response(200, json={"etape": "secret-du-lanceur", "interne": "ne sort pas"})


def record(self, request):
    reached.append((*route_now, request.url.host, request.method + " " + request.url.path))
    return httpx.Response(200, json={})


httpx.AsyncHTTPTransport.handle_async_request = record_async
httpx.HTTPTransport.handle_request = record

from apollo import auth, db, main  # noqa: E402

db.init()
owner = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('essai', 'Essai', '', 'k', ?)", (owner,))
anon = TestClient(main.app, raise_server_exceptions=False)
tried = refused = 0
statuses: dict[str, int] = {}
for route in main.app.routes:
    if isinstance(route, WebSocketRoute):
        path = re.sub(r"\{[^}]*\}", "essai", route.path)
        route_now[:] = ["WS", path]
        try:
            with anon.websocket_connect(path):
                raise AssertionError(f"écran ouvert sans session : {path}")
        except AssertionError:
            raise
        except Exception:  # noqa: BLE001 - connexion refusée : c'est le résultat attendu
            refused += 1
        tried += 1
    if not isinstance(route, APIRoute):
        continue
    path = re.sub(r"\{[^}]*\}", "essai", route.path)
    for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
        route_now[:] = [method, path]
        # Sans cookie, sans jeton, avec un corps vide (les routes publiques qui attendent un corps s'arrêtent à 422).
        r = anon.request(method, path, json={})
        statuses[f"{method} {path}"] = r.status_code
        tried += 1
internal = {r for r in reached if r[2] == "launcher" or r[2].startswith("apollo-")}
# Seule exception : l'avancement d'une restauration, lu par la page d'installation avant qu'un compte existe. Le serveur y
# parle au lanceur avec sa propre clé, sur une seule lecture, et ne rend que quatre champs.
ALLOWED = {("GET", "/api/setup/restore", "launcher", "GET /restore")}
assert tried > 100, f"{tried} routes essayées : le contrôle ne regarde presque rien"
assert ALLOWED <= internal, "l'enregistrement des appels internes ne voit rien : le contrôle ne vaut rien"
assert internal == ALLOWED, f"route anonyme qui parle à un conteneur interne : {sorted(internal - ALLOWED)}"
status = anon.get("/api/setup/restore").json()
assert set(status) == {"etape", "erreur", "fini", "avertissement"}, f"la route rend autre chose que son état : {status}"
open_routes = sorted(k for k, s in statuses.items() if s < 400)
print(f"8. {tried} routes appelées sans session (dont {refused} WebSocket refusés) : aucune ne touche Hermes ou le navigateur ; "
      "le lanceur seulement pour l'état d'une restauration, quatre champs")
print(f"   ouvertes sans session : {', '.join(open_routes)}")
print("G7.1 (fichiers et appels Docker) : tout est vert. Reste le nmap depuis Internet sur un VPS neuf.")
