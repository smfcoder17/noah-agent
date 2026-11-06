"""« noah.py navigateur envoyer », sans navigateur : ce que l'outil accepte de faire partir, et à qui il le demande.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim python /tests/navigateur/envoi_outil_test.py
"""
import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import urllib.parse

source = open("/app/noah/hermes.py", encoding="utf-8").read()
tool = re.search(r"AGENT_TOOL = r'''(.*?)'''", source, re.S).group(1).replace("__TOKEN__", "essai")
base = tempfile.mkdtemp(dir="/var/tmp")  # hors de /tmp, que l'outil accepte
script = os.path.join(base, "noah.py")
open(script, "w", encoding="utf-8").write(tool)

seen = []


class Fake(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(size)
        url = urllib.parse.urlparse(self.path)
        seen.append({"path": url.path, "query": dict(urllib.parse.parse_qsl(url.query)), "key": self.headers.get("Authorization"), "body": body})
        answer = {"id": "a" * 24, "nom": "x"} if url.path == "/noah/fichier" else {"ok": True}
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(answer).encode())

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

home = os.path.join(base, "h")
work = os.path.join(home, "workspace")
os.makedirs(work)
with open(os.path.join(home, ".env"), "w") as f:
    f.write(f'CAMOFOX_URL=http://127.0.0.1:{port}\nCAMOFOX_API_KEY="cle-du-profil"\n')
with open(os.path.join(home, "config.yaml"), "w") as f:
    f.write("browser:\n  camofox:\n    user_id: u1abcdef12\n")
photo = os.path.join(work, "photo.jpg")
open(photo, "wb").write(b"contenu de la photo")
os.symlink(os.path.join(home, ".env"), os.path.join(work, "lien.jpg"))


def noah(*args):
    r = subprocess.run([sys.executable, script, "navigateur", "envoyer", *args], capture_output=True, text=True,
                       env={"HERMES_HOME": home, "PATH": os.environ["PATH"]}, cwd=work, timeout=30)
    return json.loads(r.stdout)


# Le fichier part tel quel, avec la clé et l'identité de ce profil.
assert noah(photo, "--selecteur", "#x").get("ok") is True
sent, attached = seen[-2], seen[-1]
assert sent["path"] == "/noah/fichier" and sent["body"] == b"contenu de la photo" and sent["query"]["nom"] == "photo.jpg"
assert sent["key"] == "Bearer cle-du-profil"
assert attached["path"] == "/noah/joindre" and attached["query"] == {"userId": "u1abcdef12", "fichiers": "a" * 24, "selecteur": "#x"}, attached
assert noah("photo.jpg").get("ok") is True, "un chemin relatif à l'espace de travail"

# Rien d'autre que les fichiers de travail, même par un lien ou un détour.
count = len(seen)
for bad in (os.path.join(home, ".env"), os.path.join(home, "config.yaml"), os.path.join(work, "lien.jpg"), "../.env", "/etc/passwd", work + "-voisin/x"):
    r = noah(bad)
    assert "erreur" in r and "se joignent" in r["erreur"], (bad, r)
assert len(seen) == count, "aucun fichier refusé ne doit partir"
assert "n'existe pas" in noah(os.path.join(work, "absent.jpg"))["erreur"] and len(seen) == count
assert "Quel fichier" in noah()["erreur"]

# Un second fichier en échec : rien n'est joint.
os.remove(os.path.join(home, ".env"))
assert "non configuré" in noah(photo)["erreur"] and len(seen) == count
print("noah.py navigateur envoyer : seuls les fichiers de travail partent, avec la clé et l'identité du profil.")
