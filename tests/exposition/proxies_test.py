"""Audit 0.3.0, DeepSeek M1 : X-Forwarded-For n'est cru que venant de Caddy. Un agent (ou tout conteneur) qui appelle le
serveur en direct et pose ce champ garde sa vraie adresse : il ne contourne pas le verrou de connexion.

Le serveur est monté comme dans son image : les options de la commande de server/Dockerfile, passées à noah.serve.

    docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/proxies_test.py"
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
sys.path.insert(0, str(REPO / "server"))
os.environ.setdefault("NOAH_DATA_DIR", "/tmp/proxies-test")
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
from noah import proxies, serve  # noqa: E402

fails = 0


def check(ok: bool, what: str) -> None:
    global fails
    print(("ok   " if ok else "ÉCHEC ") + what)
    fails += not ok


async def echo(scope, receive, send):
    if scope["type"] != "http":
        return
    body = json.dumps({"client": scope["client"][0], "scheme": scope["scheme"]}).encode()
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})


CADDY, AGENT = "172.18.0.5", "172.30.0.9"


async def fake_resolve(names):
    return {CADDY} if "noah-caddy" in names else set()


proxies.resolve = fake_resolve
cmd = json.loads(re.search(r"^CMD (\[.*\])$", (REPO / "server/Dockerfile").read_text(encoding="utf-8"), re.M).group(1))
args = cmd[cmd.index("noah.serve") + 1:]
config = serve.config(args, app=echo)
config.load()


def ask(peer: str, headers: dict) -> dict:
    out = {}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.body":
            out.update(json.loads(message["body"]))

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http", "path": "/",
             "raw_path": b"/", "query_string": b"", "root_path": "", "client": (peer, 40000), "server": ("noah-server", 8080),
             "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
    asyncio.run(config.loaded_app(scope, receive, send))
    return out


forged = {"X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https"}
r = ask(CADDY, forged)
check(r == {"client": "203.0.113.7", "scheme": "https"}, f"par Caddy : l'adresse du visiteur et le HTTPS sont crus ({r})")
for peer in (AGENT, "10.0.0.5", "192.168.1.20", "172.16.0.2"):
    r = ask(peer, forged)
    check(r == {"client": peer, "scheme": "http"}, f"appel direct depuis {peer} avec X-Forwarded-For : adresse gardée, pas de HTTPS ({r})")
r = ask(CADDY, {"X-Forwarded-For": "198.51.100.1, 203.0.113.8"})
check(r["client"] == "203.0.113.8", f"Caddy : la dernière adresse, celle qu'il a vue ({r})")
r = ask(CADDY, {})
check(r["client"] == CADDY, f"Caddy sans en-tête : son adresse ({r})")
check(not getattr(config, "proxy_headers", False), "les en-têtes de proxy d'uvicorn (plages privées entières) ne sont plus crus")
check(not re.search(r"10\.0\.0\.0/8|172\.16\.0\.0/12", " ".join(cmd)), f"plus de plages privées dans la commande du serveur : {cmd}")
traefik = (REPO / "deploy/docker-compose.traefik.yml").read_text(encoding="utf-8")
check("NOAH_TRUSTED_PROXIES" in traefik, "derrière Traefik : le nom du proxy de confiance se règle")
print("proxies : tout est vert" if not fails else f"proxies : {fails} échec(s)")
sys.exit(1 if fails else 0)
