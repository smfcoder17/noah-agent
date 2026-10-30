import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("APOLLO_DATA_DIR", "/data"))
LAUNCHER_URL = os.environ.get("LAUNCHER_URL", "http://launcher:9000")
LAUNCHER_KEY = os.environ["LAUNCHER_KEY"]
SECRET_KEY = os.environ["APOLLO_SECRET_KEY"]
WEB_DIR = Path(os.environ.get("APOLLO_WEB_DIR", "/app/web"))
SESSION_DAYS = 30
# Langue et fuseau du navigateur des agents ; vides = déduits de l'adresse IP publique.
BROWSER_LOCALE = os.environ.get("APOLLO_LOCALE", "")
BROWSER_TIMEZONE = os.environ.get("APOLLO_TIMEZONE", "")
