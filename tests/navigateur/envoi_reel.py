"""Le vrai noah.py, depuis une autre machine, vers le vrai Firefox : le fichier arrive entier dans la page. Lancé par envoi_reel.mjs."""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

API, KEY, NOAH = sys.argv[1:4]
SITE = "http://127.0.0.1:9999"
HOME = "/h"
UP = HOME + "/workspace/uploads/"
checks = []


def check(name, ok, detail=""):
    print("OK   " if ok else "ÉCHEC", name, str(detail)[:400])
    checks.append(ok)


def api(method, path, body=None, timeout=180):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def noah(*args, home=HOME):
    r = subprocess.run([sys.executable, NOAH, "navigateur", "envoyer", *args], capture_output=True, text=True, timeout=700,
                       env={**os.environ, "HERMES_HOME": home})
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"erreur": "sortie illisible : " + (r.stdout + r.stderr)[-500:]}


def write(name, size):
    data = os.urandom(size)
    with open(UP + name, "wb") as f:
        f.write(data)
    return f"{name} {size} {hashlib.sha256(data).hexdigest()}"


os.makedirs(UP)
with open(HOME + "/.env", "w") as f:
    f.write(f"CAMOFOX_URL={API}\nCAMOFOX_API_KEY={KEY}\nAUTRE=x\n")
with open(HOME + "/config.yaml", "w") as f:
    f.write("browser:\n  camofox:\n    user_id: noah\n    session_key: noah\n")

for _ in range(150):
    try:
        api("GET", "/health", timeout=3)
        break
    except OSError:
        time.sleep(2)

tab = json.loads(api("POST", "/tabs", {"userId": "noah", "sessionKey": "noah", "url": SITE + "/un"}))["tabId"]


def go(page):
    api("POST", f"/tabs/{tab}/navigate", {"userId": "noah", "url": SITE + page})
    time.sleep(1)


def seen():
    deadline = time.time() + 40  # l'empreinte d'un gros fichier prend du temps dans la page
    text = ""
    while time.time() < deadline:
        text = api("GET", f"/tabs/{tab}/snapshot?userId=noah")
        if "RECU" in text:
            break
        time.sleep(1)
    return text


small, other, big = write("photo.jpg", 200_000), write("deux.jpg", 150_000), write("video.mp4", 60 * 2**20)

r = noah(UP + "photo.jpg")
check("un seul champ : le fichier arrive entier", r.get("ok") is True and small in seen(), r)

go("/un")
r = noah(UP + "video.mp4")
check("une vidéo de 60 Mo arrive entière", r.get("ok") is True and big in seen(), r)

go("/fenetre")
r = noah(UP + "photo.jpg", UP + "deux.jpg")
text = seen()
check("la fenêtre ouverte reçoit le carrousel, pas le champ de profil", r.get("ok") is True and "RECU post" in text and small in text and other in text, r)
check("le champ de profil n'a rien reçu", "RECU profil" not in text)

go("/deux")
r = noah(UP + "photo.jpg")
check("deux champs sans fenêtre : refus, avec la liste", "erreur" in r and len(r.get("champs", [])) == 2, r)
check("rien n'est posé au hasard", "RECU" not in api("GET", f"/tabs/{tab}/snapshot?userId=noah"))
r = noah(UP + "photo.jpg", "--selecteur", "#second")
check("le champ désigné reçoit le fichier", r.get("ok") is True and "RECU second" in seen(), r)

go("/bouton")
r = noah(UP + "photo.jpg", "--selecteur", "#b")
check("un bouton qui ouvre le choix de fichier du système", r.get("ok") is True and small in seen(), r)

go("/bouton")
refs = re.findall(r'button "Choisir un fichier" \[(e\d+)\]', api("GET", f"/tabs/{tab}/snapshot?userId=noah"))
r = noah(UP + "photo.jpg", "--ref", refs[0] if refs else "e1")
check("le même bouton par sa référence", r.get("ok") is True and small in seen(), r)

go("/panneau")
r = noah(UP + "photo.jpg", "--selecteur", "#b")
check("un bouton qui fait apparaître un champ", r.get("ok") is True and small in seen(), r)

go("/aucun")
r = noah(UP + "photo.jpg")
check("aucun champ : la réponse dit quoi faire", "ouvre d'abord" in r.get("erreur", ""), r)

os.symlink(HOME + "/.env", UP + "lien.jpg")
for path in (HOME + "/.env", HOME + "/config.yaml", UP + "lien.jpg", UP + "../../.env", "/etc/passwd"):
    r = noah(path)
    check(f"refus de joindre {path}", "workspace" in r.get("erreur", "") and "ok" not in r, r)
check("un fichier absent", "n'existe pas" in noah(UP + "absent.jpg").get("erreur", ""))

guest = "/g"
os.makedirs(guest + "/workspace")
with open(guest + "/.env", "w") as f:
    f.write(f"CAMOFOX_URL={API}\nCAMOFOX_API_KEY={KEY}\n")
with open(guest + "/config.yaml", "w") as f:
    f.write("browser:\n  camofox:\n    user_id: u1abcdef12\n")
with open(guest + "/workspace/x.jpg", "wb") as f:
    f.write(b"x")
r = noah(guest + "/workspace/x.jpg", home=guest)
check("un profil invité ne vise pas l'onglet du propriétaire", "Aucun onglet" in r.get("erreur", ""), r)
with open(guest + "/.env", "w") as f:
    f.write(f"CAMOFOX_URL={API}\nCAMOFOX_API_KEY=mauvaise\n")
r = noah(guest + "/workspace/x.jpg", home=guest)
check("une mauvaise clé est refusée", "Forbidden" in r.get("erreur", ""), r)

sys.exit(0 if all(checks) else 1)
