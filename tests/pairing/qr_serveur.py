"""Serveur d'essai de tests/pairing/qr_navigateur.mjs : le vrai serveur et la vraie interface compilée, une base neuve avec
un compte, aucune pile Docker autour. Le QR expire ici en quelques secondes (les 10 min sont vérifiées dans qr_jeton_test.py)."""
import os
import tempfile

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ["APOLLO_WEB_DIR"] = "/web"
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
os.environ["NOAH_UPDATE_MANIFEST"] = "http://127.0.0.1:9/manifeste"  # aucune sortie réelle pendant l'essai

import uvicorn  # noqa: E402

from apollo import auth, db, main  # noqa: E402

main.PAIRING_SECONDS = int(os.environ.get("QR_SECONDES", "6"))
db.init()
auth.create_user("alice", "motdepasse-a")
db.set_setting("onboarded", "1")
uvicorn.run(main.app, host="0.0.0.0", port=8080, log_level="warning")
