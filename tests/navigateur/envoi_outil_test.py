"""« noah.py navigateur envoyer », sans navigateur : ce que l'outil accepte de faire partir, et à qui il le demande.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim python /tests/navigateur/envoi_outil_test.py
"""
import http.server
import json
import os
import re
import ssl
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
    def do_GET(self):  # ce qu'une redirection hors de https atteindrait
        seen.append({"path": self.path})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"service interne")

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

cert, key = os.path.join(base, "cert.pem"), os.path.join(base, "key.pem")
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
                "-addext", "subjectAltName=DNS:localhost"], check=True, capture_output=True)
asked = []


class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        asked.append(self.path)
        if self.path.startswith("/vers-http"):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{port}/interne")
            self.end_headers()
        elif self.path.startswith("/expire"):
            self.send_response(403)
            self.end_headers()
        elif self.path.startswith("/vide"):
            self.send_response(200)
            self.end_headers()
        elif self.path.startswith("/tronque"):
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"abc")
            self.close_connection = True
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"image telechargee")

    def log_message(self, *_):
        pass


site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(cert, key)
site.socket = tls.wrap_socket(site.socket, server_side=True)
threading.Thread(target=site.serve_forever, daemon=True).start()
SITE = f"https://localhost:{site.server_address[1]}"

home = os.path.join(base, "h")
work = os.path.join(home, "workspace")
os.makedirs(work)
with open(os.path.join(home, ".env"), "w") as f:
    f.write(f'CAMOFOX_URL=http://127.0.0.1:{port}\nCAMOFOX_API_KEY="cle-du-profil"\n')
with open(os.path.join(home, "config.yaml"), "w") as f:
    f.write("autre:\n  user_id: leurre\nbrowser:\n  camofox:\n    session_key: x\n    user_id: u1abcdef12\n")
photo = os.path.join(work, "photo.jpg")
open(photo, "wb").write(b"contenu de la photo")
os.symlink(os.path.join(home, ".env"), os.path.join(work, "lien.jpg"))


def run(command, *args, where=None):
    r = subprocess.run([sys.executable, script, "navigateur", command, *args], capture_output=True, text=True,
                       env={"HERMES_HOME": where or home, "PATH": os.environ["PATH"], "SSL_CERT_FILE": cert}, cwd=work, timeout=30)
    return json.loads(r.stdout)


def noah(*args, where=None):
    return run("envoyer", *args, where=where)


# Le fichier part tel quel, avec la clé et l'identité de ce profil.
assert noah(photo, "--selecteur", "#x").get("ok") is True
sent, attached = seen[-2], seen[-1]
assert sent["path"] == "/noah/fichier" and sent["body"] == b"contenu de la photo" and sent["query"]["nom"] == "photo.jpg"
assert sent["key"] == "Bearer cle-du-profil"
assert attached["path"] == "/noah/joindre" and attached["query"] == {"userId": "u1abcdef12", "fichiers": "a" * 24, "selecteur": "#x"}, attached
assert noah("photo.jpg").get("ok") is True, "un chemin relatif à l'espace de travail"

# Rien d'autre que les fichiers de travail, même par un lien ou un détour.
count = len(seen)
os.makedirs(work + "-voisin")
open(work + "-voisin/x", "wb").write(b"x")
open("/tmp/commun.jpg", "wb").write(b"x")
for bad in (os.path.join(home, ".env"), os.path.join(home, "config.yaml"), os.path.join(work, "lien.jpg"), "../.env", "/etc/passwd", work + "-voisin/x", "/tmp/commun.jpg"):
    r = noah(bad)
    assert "erreur" in r and "se joignent" in r["erreur"], (bad, r)
assert len(seen) == count, "aucun fichier refusé ne doit partir"
assert "n'existe pas" in noah(os.path.join(work, "absent.jpg"))["erreur"] and len(seen) == count
assert "Quel fichier" in noah()["erreur"]

# Un profil invité : ni envoi ni téléchargement, même avec un dossier de travail à lui.
guest = os.path.join(home, "profiles", "u1abcdef12")
os.makedirs(os.path.join(guest, "workspace"))
open(os.path.join(guest, "workspace", "x.jpg"), "wb").write(b"x")
assert "propriétaire" in noah(os.path.join(guest, "workspace", "x.jpg"), where=guest)["erreur"] and len(seen) == count
assert "propriétaire" in run("telecharger", SITE + "/a.jpg", "a.jpg", where=guest)["erreur"]

# Télécharger : https seulement, jamais d'écrasement, jamais hors du dossier, l'adresse reste une adresse.
uploads = os.path.join(work, "uploads")
r = run("telecharger", SITE + "/dossier/x.jpg?signature=a&b=$(id)", "image du jour.jpg")
assert r.get("chemin") == os.path.join(uploads, "image du jour.jpg") and open(r["chemin"], "rb").read() == b"image telechargee", r
assert "$(id)" in asked[-1], "l'adresse part telle quelle, sans être interprétée"
open(r["chemin"], "wb").write(b"fichier de la personne")
again = run("telecharger", SITE + "/x.jpg", "image du jour.jpg")
assert "existe déjà" in again.get("erreur", ""), again
assert open(r["chemin"], "rb").read() == b"fichier de la personne", "un téléchargement n'écrase rien"
for name in ("../../.env", ".env", "a/b.jpg", "a\\b.jpg", "", "*.jpg", "a$(id).jpg"):
    assert "invalide" in run("telecharger", SITE + "/a", name)["erreur"], name
assert not os.path.exists(os.path.join(home, ".env.bak")) and sorted(os.listdir(uploads)) == ["image du jour.jpg"]
assert "https://" in run("telecharger", SITE + "/a")["erreur"], "le nom est obligatoire"
for bad in ("http://localhost/a.jpg", "file:///etc/passwd", "ftp://x/a", ""):
    assert "https://" in run("telecharger", bad, "n.jpg")["erreur"], bad
assert "erreur" in run("telecharger", SITE + "/vers-http", "n.jpg"), "une redirection hors de https n'est pas suivie"
assert len(seen) == count, "le service interne n'a rien reçu"
assert "expiré" in run("telecharger", SITE + "/expire", "n.jpg")["erreur"]
assert "vide" in run("telecharger", SITE + "/vide", "n.jpg")["erreur"]
assert "coupé" in run("telecharger", SITE + "/tronque", "n.jpg").get("erreur", "")
assert sorted(os.listdir(uploads)) == ["image du jour.jpg"], "ni partiel ni fichier temporaire"

# Une routine : la consigne passe par un fichier, avec ses apostrophes et ses guillemets.
consigne = "Publie aujourd'hui ce qui est « prévu » : l'agent n'oublie rien, \"même ceci\"."
local = os.path.join(base, "noah_local.py")
open(local, "w", encoding="utf-8").write(tool.replace("http://noah-server:8080/agent-api", f"http://127.0.0.1:{port}"))
consigne_path = os.path.join(work, "consigne.txt")
open(consigne_path, "w", encoding="utf-8").write(consigne + "\n")


def routine(*args):
    done = subprocess.run([sys.executable, local, "routine", "Essai", "every day at 9am", *args], capture_output=True, text=True,
                          env={"HERMES_HOME": home, "PATH": os.environ["PATH"]}, timeout=30)
    return json.loads(done.stdout)


routine("--fichier", consigne_path)
assert seen[-1]["path"] == "/routines" and json.loads(seen[-1]["body"])["consigne"] == consigne, seen[-1]
del seen[-1]
routine("en", "toutes", "lettres")
assert json.loads(seen[-1]["body"])["consigne"] == "en toutes lettres", seen[-1]
del seen[-1]
held = len(seen)
assert "illisible" in routine("--fichier", os.path.join(work, "absent.txt"))["erreur"] and len(seen) == held, "rien ne part sans consigne"
assert "dossier" not in routine("--fichier")["erreur"] and len(seen) == held
for outside in (os.path.join(home, ".env"), os.path.join(work, "lien.jpg"), "/etc/passwd"):
    assert "doit être un fichier" in routine("--fichier", outside).get("erreur", ""), outside
assert len(seen) == held, "rien d'extérieur au dossier de travail ne part dans une consigne"
open(consigne_path, "w").close()
assert "vide" in routine("--fichier", consigne_path)["erreur"] and len(seen) == held
os.remove(consigne_path)

# Un second fichier en échec : rien n'est joint.
os.remove(os.path.join(home, ".env"))
assert "non configuré" in noah(photo)["erreur"] and len(seen) == count
print("noah.py navigateur : seuls les fichiers de travail partent, avec la clé et l'identité du profil ; téléchargement en https, sans écraser.")
