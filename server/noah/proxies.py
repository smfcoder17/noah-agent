"""DeepSeek M1 (audit 0.3.0) : X-Forwarded-For et X-Forwarded-Proto ne sont crus que venant du proxy d'entrée.

Avant, uvicorn croyait ces champs de tout conteneur de 10.0.0.0/8 et 172.16.0.0/12 : un agent compromis, qui appelle le
serveur en direct, choisissait son adresse et contournait une partie du verrou de connexion. Ici, seules les adresses
des noms de NOAH_TRUSTED_PROXIES (Caddy par défaut, « traefik » derrière Traefik) et la boucle locale sont crues. Les
noms sont relus au plus toutes les 10 s, quand une adresse inconnue pose ces champs (Caddy recréé change d'adresse).
"""
import asyncio
import os
import socket
import time

LOOPBACK = {"127.0.0.1", "::1"}
REFRESH = 10.0


def names() -> list[str]:
    return [n.strip() for n in os.environ.get("NOAH_TRUSTED_PROXIES", "noah-caddy").split(",") if n.strip()]


async def resolve(wanted: list[str]) -> set[str]:
    loop = asyncio.get_running_loop()
    found: set[str] = set()
    for name in wanted:
        try:
            found |= {info[4][0] for info in await loop.getaddrinfo(name, None, type=socket.SOCK_STREAM)}
        except OSError:
            continue  # pas de Caddy (installation locale) : seule la boucle locale est crue
    return found


class TrustedProxies:
    def __init__(self, app, wanted: list[str] | None = None):
        self.app = app
        self.wanted = names() if wanted is None else wanted
        self.trusted: set[str] = set(LOOPBACK)
        self.read_at = float("-inf")

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and scope.get("client"):
            headers = dict(scope.get("headers") or [])
            forwarded, proto = headers.get(b"x-forwarded-for"), headers.get(b"x-forwarded-proto")
            if forwarded or proto:
                peer = scope["client"][0]
                if peer not in self.trusted and time.monotonic() - self.read_at > REFRESH:
                    self.read_at = time.monotonic()
                    self.trusted = LOOPBACK | await resolve(self.wanted)
                if peer in self.trusted:
                    scope = dict(scope)
                    if proto:
                        wanted = proto.decode("latin-1").split(",")[0].strip().lower()
                        if scope["type"] == "websocket":
                            wanted = "wss" if wanted in ("https", "wss") else "ws"
                        if wanted in ("http", "https", "ws", "wss"):
                            scope["scheme"] = wanted
                    if forwarded:
                        # Le proxy ajoute en dernier l'adresse qu'il voit : celle du visiteur. Le début de la liste vient du visiteur.
                        last = forwarded.decode("latin-1").split(",")[-1].strip()
                        if last:
                            scope["client"] = (last, 0)
        await self.app(scope, receive, send)
