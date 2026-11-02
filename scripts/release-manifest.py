"""Manifeste signé d'une version de Noah Agent (lu toutes les heures par chaque serveur : server/apollo/updates.py).

Une seule fois, sur ton ordinateur (la clé privée ne va jamais dans le dépôt) :
    python scripts/release-manifest.py cle
  → GitHub > Settings > Secrets and variables > Actions :
      secret   NOAH_RELEASE_KEY = la clé privée affichée
      variable NOAH_UPDATE_KEY  = la clé publique affichée (elle est copiée dans l'image du serveur)

À chaque version, la CI (release.yml) appelle :
    python scripts/release-manifest.py signer 1.2.3 notes.md composant=image@sha256:… …
  → manifest.json et manifest.json.sig, joints à la release GitHub.
Une version qui transforme les données (schéma, format des fichiers) l'écrit dans le message de son étiquette, sur
une ligne « [migration] » : elle ne s'installera alors jamais sans un clic de l'utilisateur.
"""
import base64
import json
import os
import re
import sys
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def key() -> None:
    private = Ed25519PrivateKey.generate()
    raw = private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    print("Clé privée (secret NOAH_RELEASE_KEY, à garder aussi hors ligne) :", base64.b64encode(raw).decode())
    print("Clé publique (variable NOAH_UPDATE_KEY) :", base64.b64encode(public).decode())


def sign(version: str, notes_file: str, images: list[str]) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"Version invalide : {version}")
    refs = dict(arg.split("=", 1) for arg in images)
    for comp, ref in refs.items():
        if not re.fullmatch(r"[a-z0-9./_:-]+@sha256:[0-9a-f]{64}", ref):
            sys.exit(f"{comp} : image sans empreinte ({ref})")
    notes = open(notes_file, encoding="utf-8").read().strip() if os.path.exists(notes_file) else ""
    migration = "[migration]" in notes.lower()
    notes = "\n".join(line for line in notes.splitlines() if line.strip().lower() != "[migration]").strip()
    manifest = {"version": version, "publie": int(time.time()), "notes": notes[:4000], "migration": migration,
                "images": refs}
    raw = json.dumps(manifest, ensure_ascii=False, indent=1).encode()
    private = Ed25519PrivateKey.from_private_bytes(base64.b64decode(os.environ["NOAH_RELEASE_KEY"]))
    with open("manifest.json", "wb") as f:
        f.write(raw)
    with open("manifest.json.sig", "w") as f:
        f.write(base64.b64encode(private.sign(raw)).decode())
    print(raw.decode())


if __name__ == "__main__":
    if sys.argv[1:2] == ["cle"]:
        key()
    elif sys.argv[1:2] == ["signer"] and len(sys.argv) >= 5:
        sign(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        sys.exit(__doc__)
