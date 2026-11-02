import json
import os
import secrets
import time
from pathlib import Path

DATA_DIR = Path(os.environ.get("APOLLO_DATA_DIR", "/data"))
# Secrets partagés avec le lanceur. Installation par install.sh : ils viennent de .env. Installation sans aucune
# variable (« Compose from URL » de Hostinger, docker-compose.yml public) : le premier service qui démarre les tire
# au hasard et les écrit dans le volume commun ; ils ne changent plus ensuite.
SECRETS_FILE = Path(os.environ.get("NOAH_SECRETS_FILE", "/secrets/noah.json"))
_SHARED = ("LAUNCHER_KEY", "APOLLO_SECRET_KEY", "NOAH_SETUP_CODE")


def shared_secret(name: str) -> str:
    if os.environ.get(name) and os.environ[name] != "auto":
        return os.environ[name]
    for _ in range(120):
        try:
            return json.loads(SECRETS_FILE.read_text())[name]
        except FileNotFoundError:
            SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
            try:
                fd = os.open(SECRETS_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue  # l'autre service l'écrit en ce moment
            values = {k: secrets.token_hex(32) for k in _SHARED}
            values["NOAH_SETUP_CODE"] = "".join(secrets.choice("BCDFGHJKLMNPQRSTVWXZ") for _ in range(8))
            with os.fdopen(fd, "w") as f:
                json.dump(values, f)
        except (ValueError, KeyError):
            time.sleep(0.25)  # fichier en cours d'écriture
    raise RuntimeError(f"Secrets illisibles dans {SECRETS_FILE}")


LAUNCHER_URL = os.environ.get("LAUNCHER_URL", "http://launcher:9000")
LAUNCHER_KEY = shared_secret("LAUNCHER_KEY")
SECRET_KEY = shared_secret("APOLLO_SECRET_KEY")
WEB_DIR = Path(os.environ.get("APOLLO_WEB_DIR", "/app/web"))
SESSION_DAYS = 30
# Langue et fuseau du navigateur des agents ; vides = déduits de l'adresse IP publique.
BROWSER_LOCALE = os.environ.get("APOLLO_LOCALE", "")
BROWSER_TIMEZONE = os.environ.get("APOLLO_TIMEZONE", "")
# Code affiché à la fin de l'installation sur un VPS : sans lui, personne ne peut créer le compte administrateur
# (sinon le premier visiteur de l'adresse publique le prendrait). Vide sur un ordinateur personnel ; « auto » : tiré
# au premier démarrage et écrit dans les journaux du serveur.
SETUP_CODE = shared_secret("NOAH_SETUP_CODE") if os.environ.get("NOAH_SETUP_CODE") == "auto" else os.environ.get("NOAH_SETUP_CODE", "").strip()
# Nom public : NOAH_DOMAIN (un domaine à soi), ou « auto » = <ip-publique>.sslip.io, avec HTTPS par Caddy.
PUBLIC_DOMAIN = os.environ.get("NOAH_DOMAIN", "").strip()
