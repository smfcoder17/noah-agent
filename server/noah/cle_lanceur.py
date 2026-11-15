"""Kimi M5 (audit 0.3.0) : renouveler la clé du lanceur.

    docker exec noah-server python -m noah.cle_lanceur

La clé est tirée au hasard et écrite dans le fichier de secrets (volume noah-secrets), à la place de l'ancienne ; les autres
secrets (clé maîtresse qui chiffre les données, code d'installation) ne bougent pas. Le lanceur relit le fichier quand il
change et refuse aussitôt l'ancienne clé ; le serveur redémarre pour prendre la nouvelle (Docker le relance seul).
Une clé fixée dans .env (install.sh) ne se change pas ici : changer LAUNCHER_KEY dans .env, puis `docker compose up -d`.
"""
import json
import os
import secrets
import signal
import sys

from .config import SECRETS_FILE


def rotate() -> str | None:
    """Écrit une nouvelle clé et la rend ; None si rien n'a été changé (clé fixée par l'environnement, fichier illisible)."""
    if os.environ.get("LAUNCHER_KEY") and os.environ["LAUNCHER_KEY"] != "auto":
        return None
    try:
        values = json.loads(SECRETS_FILE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(values, dict) or not values.get("LAUNCHER_KEY") or not values.get("NOAH_SECRET_KEY"):
        return None
    values["LAUNCHER_KEY"] = secrets.token_hex(32)
    temporary = SECRETS_FILE.with_name(f".{SECRETS_FILE.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(values, f)
            f.flush()
            os.fsync(f.fileno())
        if json.loads(temporary.read_text()) != values:  # relu avant de remplacer : jamais un fichier de secrets à moitié écrit
            raise OSError("relecture différente")
        os.replace(temporary, SECRETS_FILE)
    finally:
        if temporary.exists():
            temporary.unlink()
    return values["LAUNCHER_KEY"]


def main() -> int:
    if not rotate():
        print("Clé du lanceur inchangée : elle est fixée par LAUNCHER_KEY (fichier .env), ou le fichier de secrets est illisible.")
        return 2
    print("Nouvelle clé du lanceur écrite ; l'ancienne est refusée. Le serveur redémarre pour la prendre.")
    if "--sans-redemarrer" not in sys.argv:
        os.kill(1, signal.SIGTERM)  # le processus du serveur : Docker le relance (restart: unless-stopped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
