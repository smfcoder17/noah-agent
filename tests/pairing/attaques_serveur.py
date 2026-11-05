"""Serveur d'essai de tests/pairing/attaques_navigateur.mjs : le vrai serveur et la vraie interface compilée, une base neuve
avec deux comptes, aucune pile Docker autour. Les adresses viennent de X-Forwarded-For, comme derrière Caddy."""
import os
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ["NOAH_WEB_DIR"] = "/web"
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["NOAH_UPDATE_MANIFEST"] = "http://127.0.0.1:9/manifeste"  # aucune sortie réelle pendant l'essai

import uvicorn  # noqa: E402

from noah import auth, db, main  # noqa: E402

db.init()
auth.create_user("alice", "motdepasse-a")
auth.create_user("bruno", "motdepasse-b")
db.set_setting("onboarded", "1")
uvicorn.run(main.app, host="0.0.0.0", port=8080, log_level="warning", proxy_headers=True, forwarded_allow_ips="*")
