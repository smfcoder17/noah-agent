"""Uvicorn prévient le bus avant d'attendre la fin des connexions HTTP."""
import argparse
import importlib

import uvicorn

from . import proxies


class Server(uvicorn.Server):
    async def startup(self, sockets=None):
        await super().startup(sockets=sockets)

    async def shutdown(self, sockets=None):
        # Le lifespan.shutdown d'ASGI arrive APRES l'attente des connexions.
        # Fermer les SSE ici permet à cette attente de se terminer normalement.
        self.lifespan.state["noah_events_stopping"].set()
        await super().shutdown(sockets=sockets)


def config(argv=None, app=None) -> uvicorn.Config:
    """Les options du conteneur sont transmises à Config sans modifier Uvicorn globalement ni installer nos propres
    gestionnaires de signal. Les en-têtes de proxy ne sont crus que de Caddy (proxies.py, audit 0.3.0 DeepSeek M1) :
    --proxy-headers et --forwarded-allow-ips sont acceptés pour les anciennes commandes, et ignorés."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-server-header", dest="server_header", action="store_false")
    parser.add_argument("--no-access-log", dest="access_log", action="store_false")
    parser.add_argument("--proxy-headers", action="store_true")
    parser.add_argument("--forwarded-allow-ips")
    # Filet : si une connexion ne se ferme pas malgré le bus, Uvicorn l'annule au bout de 10 s.
    parser.add_argument("--timeout-graceful-shutdown", type=int, default=10)
    options = vars(parser.parse_args(argv))
    target = options.pop("app")
    options.pop("proxy_headers")
    options.pop("forwarded_allow_ips")
    if app is None:
        module, _, attr = target.partition(":")
        app = getattr(importlib.import_module(module), attr)
    return uvicorn.Config(app=proxies.TrustedProxies(app), proxy_headers=False, **options)


def main():
    Server(config()).run()


if __name__ == "__main__":
    main()
