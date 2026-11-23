"""Le serveur de tests/sortie/relais_docker_test.sh : le vrai module server/noah/sortie_relais.py (route WebSocket, authentification par jeton
d'appareil, mandataire interne sur le port 3130) dans une petite application, avec une vraie base. Seul le lanceur est simulé.
Écrit le jeton de l'appareil de bureau dans /shared/token, puis /shared/pret."""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["NOAH_RELAIS_PORT"] = "3130"
os.environ["NOAH_RELAIS_BIND"] = "0.0.0.0"
sys.path.insert(0, "/app")

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from noah import auth, db, hermes, sortie, sortie_relais  # noqa: E402


async def lanceur_simule(method, path, **kw):
    return {"conteneurs": {}, "aiguillage": None}


hermes._launcher = lanceur_simule
sortie.hermes = hermes
db.init()
proprietaire = auth.create_user("franck", "motdepasse-essai-1")
jeton = auth.new_session(proprietaire, "Noah Agent sur PC-ESSAI", "desktop")
with open("/shared/token", "w") as f:
    f.write(jeton)

app = FastAPI()
app.include_router(sortie_relais.router)


@app.on_event("startup")
async def demarrage():
    await sortie_relais.assurer_mandataire()
    open("/shared/pret", "w").close()


uvicorn.run(app, host="0.0.0.0", port=8080, log_level="warning")
