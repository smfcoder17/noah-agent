"""Uvicorn prévient le bus avant d'attendre la fin des connexions HTTP."""
import argparse

import uvicorn


class Server(uvicorn.Server):
    async def startup(self, sockets=None):
        await super().startup(sockets=sockets)

    async def shutdown(self, sockets=None):
        # Le lifespan.shutdown d'ASGI arrive APRES l'attente des connexions.
        # Fermer les SSE ici permet à cette attente de se terminer normalement.
        self.lifespan.state["noah_events_stopping"].set()
        await super().shutdown(sockets=sockets)


def main():
    # Les options du conteneur sont transmises à Config sans modifier Uvicorn
    # globalement ni installer nos propres gestionnaires de signal.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-server-header", dest="server_header", action="store_false")
    parser.add_argument("--no-access-log", dest="access_log", action="store_false")
    parser.add_argument("--proxy-headers", action="store_true", default=True)
    parser.add_argument("--forwarded-allow-ips")
    # Filet : si une connexion ne se ferme pas malgré le bus, Uvicorn l'annule au bout de 10 s.
    parser.add_argument("--timeout-graceful-shutdown", type=int, default=10)
    Server(uvicorn.Config(**vars(parser.parse_args()))).run()


if __name__ == "__main__":
    main()
