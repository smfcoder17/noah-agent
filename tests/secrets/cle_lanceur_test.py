"""Audit 0.3.0, Kimi M5 : la clé du lanceur se renouvelle par une commande, sans toucher aux autres secrets, et le lanceur
en service prend la nouvelle clé sans redémarrer ; l'ancienne ne vaut plus rien.

    docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/secrets/cle_lanceur_test.py"
"""
import json
import os
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
folder = Path(tempfile.mkdtemp())
secrets_file = folder / "noah.json"
FIRST = {"LAUNCHER_KEY": "a" * 64, "NOAH_SECRET_KEY": "b" * 64, "NOAH_SETUP_CODE": "BCDFGHJKLMNP"}
secrets_file.write_text(json.dumps(FIRST))
os.chmod(secrets_file, 0o600)
os.environ.update(NOAH_SECRETS_FILE=str(secrets_file), NOAH_DATA_DIR=tempfile.mkdtemp())
os.environ.pop("LAUNCHER_KEY", None)
fails = 0


def check(ok: bool, what: str) -> None:
    global fails
    print(("ok   " if ok else "ÉCHEC ") + what)
    fails += not ok


# 1. Le lanceur en service, avec la clé du fichier.
docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
os.environ.update(AGENT_NETWORK="banc", NOAH_UPDATE_STATE=str(folder / "updates.json"))
sys.path.insert(0, str(REPO / "launcher"))
start = threading.Thread.start
threading.Thread.start = lambda self: None
import launcher  # noqa: E402

threading.Thread.start = start
from fastapi.testclient import TestClient  # noqa: E402

box = MagicMock()
box.labels = {launcher.BROWSER_LABEL: "essai"}
box.status = "running"
launcher.client.containers.get.side_effect = lambda name: box
web = TestClient(launcher.app)
asks = lambda key: web.get("/agents/essai/browser", headers={"Authorization": f"Bearer {key}"}).status_code  # noqa: E731
check(asks(FIRST["LAUNCHER_KEY"]) == 200, "avant : la clé du fichier ouvre le lanceur")

# 2. La commande renouvelle la clé, et seulement elle.
sys.path.insert(0, str(REPO / "server"))
from noah import cle_lanceur  # noqa: E402

time.sleep(0.01)
new = cle_lanceur.rotate()
after = json.loads(secrets_file.read_text())
check(new and new != FIRST["LAUNCHER_KEY"] and after["LAUNCHER_KEY"] == new and len(new) == 64, "nouvelle clé tirée au hasard, écrite")
check({k: v for k, v in after.items() if k != "LAUNCHER_KEY"} == {k: v for k, v in FIRST.items() if k != "LAUNCHER_KEY"},
      "les autres secrets (clé maîtresse, code d'installation) sont intacts")
check(stat.S_IMODE(secrets_file.stat().st_mode) == 0o600, f"fichier toujours en 600 ({oct(stat.S_IMODE(secrets_file.stat().st_mode))})")
check(not list(folder.glob("*.tmp")), "aucun fichier temporaire laissé")
again = cle_lanceur.rotate()
check(again != new, "une deuxième fois : encore une autre clé")

# 3. Le lanceur en service prend la nouvelle clé sans redémarrer ; les anciennes sont refusées.
check(asks(again) == 200, "après : la nouvelle clé ouvre le lanceur, sans le redémarrer")
check(asks(new) == 401 and asks(FIRST["LAUNCHER_KEY"]) == 401, "après : les anciennes clés sont refusées")

# 4. Clé fixée dans .env (install.sh) : la commande refuse au lieu de couper le serveur du lanceur.
os.environ["LAUNCHER_KEY"] = "cle-du-env"
before = secrets_file.read_text()
check(cle_lanceur.rotate() is None and secrets_file.read_text() == before, "clé fixée par l'environnement : rien n'est changé")
os.environ.pop("LAUNCHER_KEY")
# Un fichier abîmé n'est jamais réécrit à moitié : la commande s'arrête.
secrets_file.write_text("{pas du json")
check(cle_lanceur.rotate() is None and secrets_file.read_text() == "{pas du json", "fichier illisible : la commande ne le touche pas")
print("clé du lanceur : tout est vert" if not fails else f"clé du lanceur : {fails} échec(s)")
sys.exit(1 if fails else 0)
