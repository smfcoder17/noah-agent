"""Utilitaires des tests hors réseau : vrais HTTP locaux, aucune dépendance."""
import contextlib
import importlib.util
import io
import json
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

RACINE = Path(__file__).resolve().parents[2]


def charger_admin():
    spec = importlib.util.spec_from_file_location("agent_admin_banc", RACINE / "launcher/agent_admin.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def servir(fabrique):
    with fabrique() as serveur:
        thread = threading.Thread(target=serveur.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{serveur.server_port}", serveur
        finally:
            serveur.shutdown()
            thread.join(timeout=5)


def appeler(base, chemin, body=None, method=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = Request(base + chemin, data=data, method=method,
                  headers={"Content-Type": "application/json", **(headers or {})})
    try:
        response = build_opener(ProxyHandler({})).open(req, timeout=3)
    except HTTPError as e:
        response = e
    with response:
        raw = response.read()
        return response.code, json.loads(raw) if raw else None, response.headers


def echec_google(fonction):
    sortie = io.StringIO()
    with contextlib.redirect_stdout(sortie):
        try:
            fonction()
        except SystemExit as e:
            assert e.code == 2
        else:
            raise AssertionError("Un refus était attendu")
    return json.loads(sortie.getvalue())["erreur"]
