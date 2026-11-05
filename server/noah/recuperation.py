"""Mot de passe oublié, sans courriel. Avoir la main sur le serveur prouve qu'il est à soi, comme pour le code d'installation :
le code se lit dans les journaux du service `server` (Docker Manager de Hostinger) ou sort de la commande

    docker exec noah-server python -m noah.recuperation

Il sert une fois, 15 minutes. La base n'en garde que l'empreinte, dans `settings` : le serveur et la commande sont deux
processus, et un redémarrage ne doit pas changer les règles. Le changement ferme toutes les sessions du serveur.

Qui a la main sur le serveur peut aussi couper la double vérification du propriétaire (téléphone perdu), si la demande le dit :
l'écran le dit, et le journal le garde.
"""
import json
import logging
import secrets
import sys
import threading
import time

from . import auth, db
from .config import _new_setup_code

SECONDS = 15 * 60
# Par adresse (ou réseau /64), comptés à part des mots de passe : qui a oublié le sien vient d'épuiser ce budget-là.
TRIES_PER_NETWORK = 5
WINDOW = 600
# Toutes adresses confondues. 12 lettres tiennent déjà face aux essais répartis ; ce plafond borne ce qui reste. Un code annulé
# par un inconnu ne coûte qu'un nouveau code.
TRIES_PER_CODE = 20

_KEY = "recuperation"
_tries_lock = threading.Lock()
_tries: dict[str, list[float]] = {}
log = logging.getLogger("uvicorn.error")


class TooManyTries(Exception):
    pass


def owner():
    with db.connect() as c:
        return c.execute("SELECT id, username FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").fetchone()


def _normalized(code: str) -> str:
    return "".join(code.upper().split()).replace("-", "")


def _active(c):
    """Le code en cours : les écritures qui suivent se font dans la même transaction que cette lecture."""
    row = c.execute("SELECT value FROM settings WHERE key = ?", (_KEY,)).fetchone()
    if not row:
        return None
    state = json.loads(row["value"])
    if state["expire"] <= time.time():
        c.execute("DELETE FROM settings WHERE key = ?", (_KEY,))
        return None
    return state


def _save(c, state: dict) -> None:
    c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
              (_KEY, json.dumps(state)))


def issue(replace: bool) -> str | None:
    """Tire un code et le rend. Sans `replace` (le bouton, ouvert à tous), rien si un code est en cours : un inconnu ne peut ni
    annuler celui qu'on est en train de lire, ni remplir les journaux."""
    code = _new_setup_code()
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        if not replace and _active(c):
            return None
        _save(c, {"empreinte": auth.digest(code), "expire": time.time() + SECONDS, "essais": 0})
    return f"{code[:4]}-{code[4:8]}-{code[8:]}"


def announce(code: str, ip: str) -> None:
    """Dans les journaux du service `server`, là où la personne va déjà lire son code d'installation."""
    log.warning("\n\n  Mot de passe oublié. Code de récupération, valable %d minutes et une seule fois :\n\n    %s\n\n"
                "  Demandé depuis l'adresse %s. Si ce n'est pas toi, ne fais rien : sans ce code, rien ne change.\n",
                SECONDS // 60, code, ip or "inconnue")


def _reserve(network: str) -> float:
    """Essai réservé avant la comparaison, sous verrou : des envois simultanés ne dépassent pas le plafond."""
    now = time.time()
    with _tries_lock:
        recent = [t for t in _tries.get(network, []) if now - t < WINDOW]
        if len(recent) >= TRIES_PER_NETWORK:
            raise TooManyTries
        _tries[network] = recent + [now]
    return now


def _matches(given: str) -> bool:
    """Compte l'essai. Passe avant le hachage du mot de passe, qui est lent : un faux code ne coûte rien au serveur."""
    key = auth.digest(_normalized(given))
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        state = _active(c)
        if not state:
            return False
        if secrets.compare_digest(state["empreinte"], key):
            return True
        state["essais"] += 1
        if state["essais"] >= TRIES_PER_CODE:
            c.execute("DELETE FROM settings WHERE key = ?", (_KEY,))
        else:
            _save(c, state)
    return False


def change_password(given: str, password: str, network: str, cut_double: bool = False) -> str | None:
    """Le bon code change le mot de passe du propriétaire et ferme toutes les sessions, en une seule transaction : le code ne
    sert qu'une fois, même envoyé deux fois au même instant. Rend le nom du compte, ou None. TooManyTries si l'adresse a épuisé
    ses essais. La double vérification reste en place sans `cut_double`, et ses codes faux d'avant ne comptent plus."""
    reserved = _reserve(network)
    if not _matches(given):
        return None
    pw_hash = auth.hash_password(password)
    key = auth.digest(_normalized(given))
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        state = _active(c)
        if not state or not secrets.compare_digest(state["empreinte"], key):
            return None  # un envoi simultané l'a déjà utilisé
        row = c.execute("SELECT id, username FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").fetchone()
        if not row:
            return None
        c.execute("DELETE FROM settings WHERE key = ?", (_KEY,))
        c.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (pw_hash, row["id"]))
        if cut_double:
            c.execute("DELETE FROM double_verification WHERE user_id = ?", (row["id"],))
        else:
            c.execute("UPDATE double_verification SET essais = '[]' WHERE user_id = ?", (row["id"],))
        c.execute("DELETE FROM sessions")  # et leurs sessions de fenêtre, par la clé étrangère
        c.execute("DELETE FROM push_subscriptions")
        c.execute("DELETE FROM push_queue")
    with _tries_lock:  # bon code : l'essai réservé ne compte pas
        if reserved in _tries.get(network, []):
            _tries[network].remove(reserved)
    return row["username"]


def main() -> int:
    if not owner():
        print("Aucun compte sur ce serveur : rien à récupérer. Crée le compte avec le code d'installation.")
        return 1
    print(f"\nCode de récupération, valable {SECONDS // 60} minutes et une seule fois :\n\n    {issue(replace=True)}\n\n"
          "Sur la page de connexion : « Mot de passe oublié ? ». Toutes les sessions seront fermées après le changement.\n"
          "Ce code peut aussi couper la double vérification du propriétaire, si la page le demande.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
