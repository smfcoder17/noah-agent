"""Pile d'attaque locale : le vrai serveur et la vraie interface, Hermes simulé, deux comptes, un invité, des secrets témoins."""
import asyncio
import http.server
import os
import runpy
import sys
import threading

os.environ.setdefault("MOT_DE_PASSE", "motdepasse-essai")
os.environ.setdefault("NOAH_WEB_DIR", "/web")
import uvicorn  # noqa: E402

real_run = uvicorn.run
uvicorn.run = lambda *a, **k: None
ns = runpy.run_path("/tests/real/chat_pendant_serveur.py")
uvicorn.run = real_run

from noah import access, auth, db, hermes, main, media, relay  # noqa: E402

bruno = auth.create_user("bruno", "motdepasse-bruno")
invite = auth.create_user("invite", "motdepasse-invite")
alice = 1
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('b1', 'Bruno', '', 'CLE-AGENT-B1', ?)", (bruno,))
    c.execute("UPDATE agents SET api_key='CLE-AGENT-A1' WHERE id='a1'")
main._new_conversation(bruno, "b1", "Secrets de Bruno", main=True)
db.set_setting("api_key", "sk-SENTINELLE-MODELE", secret=True)
db.set_setting("model", "modele-temoin")
db.set_setting("media_key", "CLE-MEDIA-SENTINELLE", secret=True)


class R:
    status_code = 200

    def __init__(self, content, ctype="application/octet-stream"):
        self.content = content
        self.headers = {"content-type": ctype}
        self.text = content.decode("utf-8", "replace")


PAGE = b"<!doctype html><title>apercu</title><h1 id=x>Apercu temoin</h1><script>document.getElementById('x').textContent='script ok '+String(self.origin)</script>"


async def read_file(agent_id, path):
    return R(PAGE)


SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>window.parent.PWNED=document.cookie;document.title="PWNED"</script><rect width="9" height="9"/></svg>'


async def fake_media(agent_id, path):
    return R(SVG, "image/svg+xml")


async def list_files(agent_id):
    return {"files": []}


hermes.read_file, hermes.media, hermes.list_files = read_file, fake_media, list_files
hermes.browser_host = lambda agent_id: "127.0.0.1"


async def take_control(agent_id, on):
    return True


main.handoff.take_control = take_control


@main.app.get("/_essai/routes")
def routes():
    out = []
    for r in main.app.routes:
        if hasattr(r, "methods") and r.methods:
            out.append({"path": r.path, "methods": sorted(r.methods)})
        elif hasattr(r, "path"):
            out.append({"path": r.path, "methods": [type(r).__name__]})
    return out


@main.app.get("/_essai/jeton_relais")
def relay_token():
    return {"token": relay.token_for("a1")}


@main.app.post("/_essai/partage")
def share():
    """Bruno devient invité en lecture sur a1 : il doit voir ce qu'autorise la lecture, rien de plus."""
    with db.connect() as c:
        c.execute("INSERT OR REPLACE INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'lecture')", (invite,))
    return {"ok": True}


main.app.router.routes[:0] = [main.app.router.routes.pop(), main.app.router.routes.pop(), main.app.router.routes.pop()]


# noVNC réel (fichiers tirés de l'image du navigateur) sur le port 6080, comme dans le conteneur de l'agent.
def novnc():
    if not os.path.isdir("/novnc"):
        return
    os.chdir("/novnc")
    handler = http.server.SimpleHTTPRequestHandler
    http.server.ThreadingHTTPServer(("127.0.0.1", 6080), handler).serve_forever()


threading.Thread(target=novnc, daemon=True).start()


# Les mêmes options que la ligne CMD de server/Dockerfile.
uvicorn.run(main.app, host="0.0.0.0", port=8099, log_level="warning", proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
