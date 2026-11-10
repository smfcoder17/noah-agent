"""Transport stdlib des faux : état par serveur, appels sérialisés et journalisés."""
import argparse
import copy
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


class Erreur(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class Serveur(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, adresse, handler, etat):
        self.etat = etat
        self.verrou = threading.RLock()
        super().__init__(adresse, handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def traiter(self, chemin, query, body):
        raise NotImplementedError

    def erreur(self, code, message):
        return {"erreur": message}

    def json_invalide(self):
        return 400, self.erreur(400, "JSON illisible")

    def _servir(self):
        with self.server.verrou:
            self.server.etat["journal"].append({"methode": self.command, "chemin": self.path})
            headers = {}
            try:
                taille = int(self.headers.get("Content-Length", 0))
                if not 0 <= taille <= 2_000_000:
                    raise Erreur(413, "Corps trop long")
                raw = self.rfile.read(taille)
                body = parse_qs(raw.decode()) if self.headers.get_content_type() == "application/x-www-form-urlencoded" else json.loads(raw or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("Un objet est attendu")
                parts = urlsplit(self.path)
                code, result, headers = self.traiter(parts.path, parse_qs(parts.query), body)
                result = copy.deepcopy(result)
            except Erreur as e:
                code, result = e.code, self.erreur(e.code, e.message)
            except json.JSONDecodeError:
                code, result = self.json_invalide()
            except (ValueError, TypeError, KeyError) as e:
                code, result = 400, self.erreur(400, str(e))
            except Exception as e:
                code, result, headers = 500, self.erreur(500, "Erreur interne du faux"), {}
                self.server.etat["journal"][-1]["erreur_interne"] = type(e).__name__
            self.server.etat["journal"][-1]["statut"] = code
        data = json.dumps(result, ensure_ascii=False).encode() if result is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _servir


def lancer(fabrique, port):
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=port)
    args = parser.parse_args()
    with fabrique((args.host, args.port)) as serveur:
        print(f"{serveur.server_address}", flush=True)
        serveur.serve_forever()
