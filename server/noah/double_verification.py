"""Double vérification à la connexion (TOTP, RFC 6238 : HMAC-SHA1, 30 s, 6 chiffres, un pas de tolérance), en bibliothèque standard.

Optionnelle, compte par compte. Le secret est scellé en base. Les codes de secours n'y sont qu'en empreinte, avec la clé du
serveur : une copie de la base seule ne permet pas de les essayer hors ligne.

Ce module ne compte que les codes, et seulement ceux de qui a déjà donné le bon mot de passe : un inconnu ne peut donc pas
bloquer le compte. Ce plafond est par compte et survit à un redémarrage : changer d'adresse n'apporte aucun essai de plus. Au
pire 240 essais par jour, chacun avec 3 chances sur un million.
"""
import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from urllib.parse import quote, urlencode

from . import db
from .config import SECRET_KEY, _new_setup_code

STEP = 30
DIGITS = 6
SPARE_CODES = 8
TRIES = 5
TRIES_WINDOW = 1800
# Sur la durée, 5 essais par demi-heure laisseraient 1 chance sur 4 en un an à qui connaît le mot de passe.
TRIES_DAY, TRIES_DAY_WINDOW = 20, 86400


class TooManyTries(Exception):
    pass


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode()  # 160 bits, la taille conseillée par la RFC 4226


def code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret)
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(number % 10 ** DIGITS).zfill(DIGITS)


def _step_matching(secret: str, code: str, after: int) -> int | None:
    """Le pas de ce code, s'il vaut maintenant (à un pas près) et n'est pas déjà passé : un code ne sert pas deux fois."""
    now = int(time.time()) // STEP
    for step in range(now - 1, now + 2):
        if step > after and secrets.compare_digest(code_at(secret, step).encode(), code.encode()):
            return step
    return None


def _spare_print(user_id: int, code: str) -> str:
    return hmac.new(SECRET_KEY.encode(), f"noah-secours:{user_id}:{code}".encode(), hashlib.sha256).hexdigest()


def _clean(code: str) -> str:
    return "".join(code.upper().split()).replace("-", "")


def _recent(row) -> list[float]:
    now = time.time()
    return [t for t in json.loads(row["essais"]) if now - t < TRIES_WINDOW]


def _today(row) -> list[float]:
    now = time.time()
    return [t for t in json.loads(row["essais"]) if now - t < TRIES_DAY_WINDOW]


def _too_many(row) -> bool:
    return len(_recent(row)) >= TRIES or len(_today(row)) >= TRIES_DAY


def active(user_id: int) -> bool:
    with db.connect() as c:
        return c.execute("SELECT 1 FROM double_verification WHERE user_id = ? AND active = 1", (user_id,)).fetchone() is not None


def status(user_id: int) -> dict:
    with db.connect() as c:
        row = c.execute("SELECT secours FROM double_verification WHERE user_id = ? AND active = 1", (user_id,)).fetchone()
    return {"active": row is not None, "secours": len(json.loads(row["secours"])) if row else 0}


def prepare(user_id: int, username: str) -> dict:
    """Nouveau secret, sans effet à la connexion tant que le premier code ne l'a pas confirmé. Rend de quoi l'enregistrer."""
    secret = new_secret()
    with db.connect() as c:
        c.execute("INSERT INTO double_verification (user_id, secret) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE "
                  "SET secret = excluded.secret WHERE active = 0", (user_id, db.seal(secret)))
    issuer = "Noah Agent"
    query = urlencode({"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": DIGITS, "period": STEP}, quote_via=quote)
    return {"secret": secret, "adresse": f"otpauth://totp/{quote(issuer)}:{quote(username)}?{query}"}


def confirm(user_id: int, code: str) -> list[str] | None:
    """Le premier code prouve que l'application a bien le secret. Rend les codes de secours, montrés cette seule fois, ou None."""
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM double_verification WHERE user_id = ? AND active = 0", (user_id,)).fetchone()
        if not row:
            return None
        if _too_many(row):
            raise TooManyTries
        step = _step_matching(db.unseal(row["secret"]), _clean(code), 0)
        if step is None:
            c.execute("UPDATE double_verification SET essais = ? WHERE user_id = ?", (json.dumps(_today(row) + [time.time()]), user_id))
            return None
        codes = [_new_setup_code() for _ in range(SPARE_CODES)]
        c.execute("UPDATE double_verification SET active = 1, dernier_pas = ?, secours = ?, essais = '[]' WHERE user_id = ?",
                  (step, json.dumps([_spare_print(user_id, x) for x in codes]), user_id))
    return [f"{x[:4]}-{x[4:8]}-{x[8:]}" for x in codes]


def check(user_id: int, code: str) -> bool:
    """Code de l'application ou code de secours, en une seule transaction : deux envois simultanés du même code, un seul passe.
    TooManyTries sans même regarder le code une fois le plafond atteint : le bon ne se distingue plus des faux."""
    given = _clean(code)
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM double_verification WHERE user_id = ? AND active = 1", (user_id,)).fetchone()
        if not row:
            return False
        if _too_many(row):
            raise TooManyTries
        if given.isascii() and given.isdigit():
            step = _step_matching(db.unseal(row["secret"]), given, row["dernier_pas"])
            if step is not None:
                c.execute("UPDATE double_verification SET dernier_pas = ? WHERE user_id = ?", (step, user_id))
                return True
        else:
            spare = json.loads(row["secours"])
            mine = _spare_print(user_id, given)
            if any(secrets.compare_digest(mine, x) for x in spare):
                spare.remove(mine)
                c.execute("UPDATE double_verification SET secours = ? WHERE user_id = ?", (json.dumps(spare), user_id))
                return True
        c.execute("UPDATE double_verification SET essais = ? WHERE user_id = ?", (json.dumps(_today(row) + [time.time()]), user_id))
    return False


def blocked(user_id: int) -> bool:
    with db.connect() as c:
        row = c.execute("SELECT essais FROM double_verification WHERE user_id = ?", (user_id,)).fetchone()
    return bool(row) and _too_many(row)


def remove(user_id: int) -> bool:
    with db.connect() as c:
        return c.execute("DELETE FROM double_verification WHERE user_id = ?", (user_id,)).rowcount > 0
