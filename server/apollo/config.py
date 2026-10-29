import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("APOLLO_DATA_DIR", "/data"))
# Dossier /opt/data de la gateway Hermes, monté aussi dans le serveur pour écrire sa config.
HERMES_DATA_DIR = Path(os.environ.get("HERMES_DATA_DIR", "/hermes-data"))
HERMES_URL = os.environ.get("HERMES_URL", "http://hermes:8642")
HERMES_API_KEY = os.environ["HERMES_API_KEY"]
HERMES_CONTAINER = os.environ.get("HERMES_CONTAINER", "apollo-hermes")
DOCKER_URL = os.environ.get("DOCKER_URL", "http://docker-proxy:2375")
SECRET_KEY = os.environ["APOLLO_SECRET_KEY"]
WEB_DIR = Path(os.environ.get("APOLLO_WEB_DIR", "/app/web"))
SESSION_DAYS = 30
