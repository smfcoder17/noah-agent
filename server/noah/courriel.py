"""Courriel de confirmation, facultatif : le propriétaire règle l'envoi (SMTP), chaque compte active son adresse. Une fois
l'adresse active, les actions critiques demandent, après la preuve habituelle, un code reçu sur cette adresse.

Le code sert une fois, 10 minutes, 5 essais. La base n'en garde qu'une empreinte, avec la clé du serveur, liée au compte et à
l'action : il ne vaut que pour ce qu'il a confirmé, et seulement depuis la session qui l'a demandé. Il ne part qu'une fois la
preuve donnée : un jeton volé ne remplit pas la boîte du propriétaire et n'use pas ses essais.

Sans adresse active, rien ne change. Adresse active et envoi en panne : l'action refuse et le dit. Qui a la main sur le serveur
coupe l'exigence (python -m noah.recuperation --couper-courriel), et les journaux le gardent.

TLS obligatoire, certificat vérifié : STARTTLS (refusé si le serveur ne le propose pas) ou connexion chiffrée d'emblée.
"""
import hashlib
import hmac
import json
import logging
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db
from .config import SECRET_KEY

router = APIRouter()
log = logging.getLogger("uvicorn.error")

_h: dict = {}  # fonctions de main.py : critical (preuve, puis code reçu par courriel)


def setup(**hooks) -> None:
    _h.update(hooks)


CODE_SECONDS = 600
CODE_TRIES = 5
DIGITS = 6
SENDS_PER_HOUR = 5
TESTS_PER_HOUR = 5
ALERTS_PER_HOUR = 10
TIMEOUT = 10  # secondes par échange avec le serveur de courriel : une action critique n'attend pas plus
RECOVERY_COMMAND = "docker exec noah-server python -m noah.recuperation --couper-courriel"
TOO_MANY = "Trop de courriels envoyés pour ce compte. Réessaie dans une heure : le dernier code reçu reste valable 10 minutes."
WRONG_CODE = "Ce code est faux, a expiré ou a déjà servi. Demande-en un nouveau."

ADDRESS = re.compile(r"^[^@\s<>,;:\"()\[\]]+@[^@\s<>,;:\"()\[\]]+\.[^@\s<>,;:\"()\[\]]+$")
HOST = re.compile(r"^[A-Za-z0-9.:-]{1,253}$")
WORDS = {"mot-de-passe": "changer ton mot de passe", "supprimer-compte": "supprimer un compte", "ajouter-utilisateur": "ajouter un utilisateur",
         "reinitialiser": "réinitialiser un mot de passe", "couper-double": "couper une double vérification",
         "courriel": "changer ton adresse ou le réglage des courriels", "revoquer-tous": "déconnecter tous tes autres appareils",
         "activer": "activer cette adresse"}


class Required(Exception):
    """Réponse 428 {"courriel_requis": true} : un code vient de partir, l'interface le demande."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SendFailed(Exception):
    """L'envoi n'a pas abouti. `why` se montre tel quel : rien qui vienne du serveur distant, aucun secret."""

    def __init__(self, why: str) -> None:
        super().__init__(why)
        self.why = why


class Preuve(BaseModel):
    """Ce que demande une action protégée : le mot de passe et le code d'application (si la session n'a pas de preuve récente),
    puis le code reçu par courriel (si une adresse est active)."""
    motdepasse: str = Field(default="", max_length=256)
    code: str = Field(default="", max_length=32)
    courriel: str = Field(default="", max_length=16)


# --- Réglage d'envoi ------------------------------------------------------------------------------------------------------

def smtp_settings() -> dict | None:
    raw = db.get_setting("smtp")
    return json.loads(raw) if raw else None


def smtp_public() -> dict:
    """Jamais le mot de passe, ni scellé : seulement s'il y en a un."""
    cfg = smtp_settings() or {}
    return {"regle": bool(cfg), "hote": cfg.get("hote", ""), "port": cfg.get("port", 587), "utilisateur": cfg.get("utilisateur", ""),
            "expediteur": cfg.get("expediteur", ""), "tls": cfg.get("tls", "starttls"), "mot_de_passe_enregistre": bool(cfg.get("mot_de_passe"))}


def flow() -> dict | None:
    """La ligne de /api/flux : seulement si l'envoi est réglé."""
    cfg = smtp_settings()
    if not cfg:
        return None
    return {"quoi": "Courriels de confirmation et alertes de nouvel appareil", "vers": cfg["hote"],
            "quand": "Quand tu confirmes une action sensible, qu'un nouvel appareil se connecte, ou au bouton « Envoyer un essai »"}


def _deliver(to: str, subject: str, text: str) -> None:
    cfg = smtp_settings()
    if not cfg:
        raise SendFailed("l'envoi de courriels n'est pas réglé sur ce serveur")
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = cfg["expediteur"], to, subject
    message["Date"], message["Message-ID"] = formatdate(localtime=False), make_msgid(domain=cfg["expediteur"].rsplit("@", 1)[-1])
    message.set_content(text)
    context = ssl.create_default_context()  # certificat et nom vérifiés
    try:
        if cfg["tls"] == "ssl":
            client = smtplib.SMTP_SSL(cfg["hote"], cfg["port"], timeout=TIMEOUT, context=context)
        else:
            client = smtplib.SMTP(cfg["hote"], cfg["port"], timeout=TIMEOUT)
        with client:
            if cfg["tls"] != "ssl":
                client.starttls(context=context)  # lève une erreur si le serveur ne le propose pas : jamais d'envoi en clair
            if cfg.get("utilisateur"):
                client.login(cfg["utilisateur"], db.unseal(cfg["mot_de_passe"]) if cfg.get("mot_de_passe") else "")
            client.send_message(message)
    except smtplib.SMTPAuthenticationError:
        raise SendFailed("le serveur de courriel refuse cet identifiant ou ce mot de passe") from None
    except smtplib.SMTPNotSupportedError:
        raise SendFailed("le serveur de courriel ne propose pas de connexion chiffrée (STARTTLS)") from None
    except ssl.SSLError:
        raise SendFailed("le certificat du serveur de courriel n'est pas valable, ou la connexion chiffrée a échoué") from None
    except smtplib.SMTPRecipientsRefused:
        raise SendFailed("le serveur de courriel refuse cette adresse") from None
    except (smtplib.SMTPException, OSError, ValueError):
        raise SendFailed("le serveur de courriel est injoignable ou a refusé l'envoi") from None


# --- Quota d'envois -------------------------------------------------------------------------------------------------------

def _reserve(user: int, genre: str, limit: int) -> float | None:
    """Compté avant l'envoi, en une transaction : des demandes simultanées ne dépassent pas le plafond."""
    now = time.time()
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute("DELETE FROM courriel_envois WHERE quand < ?", (now - 3600,))
        if c.execute("SELECT COUNT(*) FROM courriel_envois WHERE user_id = ? AND genre = ?", (user, genre)).fetchone()[0] >= limit:
            return None
        c.execute("INSERT INTO courriel_envois (user_id, genre, quand) VALUES (?, ?, ?)", (user, genre, now))
    return now


def _give_back(user: int, genre: str, when: float) -> None:
    with db.connect() as c:
        c.execute("DELETE FROM courriel_envois WHERE user_id = ? AND genre = ? AND quand = ?", (user, genre, when))


# --- Adresse d'un compte --------------------------------------------------------------------------------------------------

def _row(user: int):
    with db.connect() as c:
        return c.execute("SELECT adresse, active, en_attente FROM courriel_adresses WHERE user_id = ?", (user,)).fetchone()


def active(user: int) -> bool:
    row = _row(user)
    return bool(row and row["active"] and row["adresse"])


def _masked(address: str) -> str:
    name, _, domain = address.partition("@")
    return f"{name[:1]}***@{domain}"


def _valid_address(value: str) -> str:
    value = value.strip()
    if len(value) > 254 or not ADDRESS.match(value):
        raise HTTPException(400, "Cette adresse de courriel n'est pas valable.")
    return value


# --- Codes ----------------------------------------------------------------------------------------------------------------

def _print(user: int, action: str, code: str) -> str:
    return hmac.new(SECRET_KEY.encode(), f"noah-courriel:{user}:{action}:{code}".encode(), hashlib.sha256).hexdigest()


def _clean(code: str) -> str:
    return "".join(code.split()).replace("-", "")


def send_code(user: int, action: str, session: str, to: str) -> None:
    """Un nouveau code remplace le précédent pour la même action. Refus franc si l'envoi échoue : rien ne passe sans le code."""
    when = _reserve(user, "code", SENDS_PER_HOUR)
    if when is None:
        raise HTTPException(429, TOO_MANY)
    code = str(secrets.randbelow(10 ** DIGITS)).zfill(DIGITS)
    what = WORDS.get(action.split(":", 1)[0], "confirmer une action")
    try:
        _deliver(to, f"Noah : ton code de confirmation est {code}",
                 f"Ton code pour {what} sur Noah Agent :\n\n    {code}\n\nIl sert une seule fois, pendant {CODE_SECONDS // 60} minutes.\n\n"
                 "Si ce n'est pas toi, quelqu'un connaît ton mot de passe : change-le, et regarde tes appareils dans Réglages > Appareils.\n")
    except SendFailed as e:
        _give_back(user, "code", when)
        log.warning("Courriel de confirmation non envoyé pour le compte n°%d : %s.", user, e.why)
        raise HTTPException(503, f"Le courriel de confirmation n'est pas parti : {e.why}. Réessaie plus tard. Si l'envoi reste en panne, "
                                 f"le propriétaire peut couper cette exigence sur le serveur : {RECOVERY_COMMAND}") from None
    with db.connect() as c:
        c.execute("INSERT INTO courriel_codes (user_id, action, session, empreinte, expire, essais) VALUES (?, ?, ?, ?, ?, 0) "
                  "ON CONFLICT(user_id, action) DO UPDATE SET session = excluded.session, empreinte = excluded.empreinte, "
                  "expire = excluded.expire, essais = 0", (user, action, session, _print(user, action, code), time.time() + CODE_SECONDS))


def check(user: int, action: str, given: str, session: str) -> bool:
    """En une transaction : deux envois simultanés du même code, un seul passe. Le code d'une autre session ne s'use pas ici."""
    now = time.time()
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM courriel_codes WHERE user_id = ? AND action = ?", (user, action)).fetchone()
        if not row or row["session"] != session:
            return False
        if row["expire"] <= now:
            c.execute("DELETE FROM courriel_codes WHERE user_id = ? AND action = ?", (user, action))
            return False
        if secrets.compare_digest(row["empreinte"], _print(user, action, _clean(given))):
            c.execute("DELETE FROM courriel_codes WHERE user_id = ? AND action = ?", (user, action))
            return True
        if row["essais"] + 1 >= CODE_TRIES:
            c.execute("DELETE FROM courriel_codes WHERE user_id = ? AND action = ?", (user, action))
        else:
            c.execute("UPDATE courriel_codes SET essais = essais + 1 WHERE user_id = ? AND action = ?", (user, action))
    return False


def gate(user: int, action: str, given: str, session: str) -> None:
    """Sans adresse active : rien. Sinon le bon code passe, un faux refuse, et sans code un nouveau part (réponse 428)."""
    if not active(user):
        return
    if given.strip():
        if check(user, action, given, session):
            return
        raise HTTPException(400, WRONG_CODE)
    to = _row(user)["adresse"]
    send_code(user, action, session, to)
    raise Required(f"Un code vient de partir vers {_masked(to)}. Saisis-le pour confirmer.")


def cut_all() -> int:
    """Récupération depuis le serveur : plus aucune adresse n'est exigée. Elles restent notées, à réactiver avec un code."""
    with db.connect() as c:
        c.execute("DELETE FROM courriel_codes")
        return c.execute("UPDATE courriel_adresses SET active = 0 WHERE active = 1").rowcount


def notify_device(user: int, name: str, ip: str, known_network: bool, when: str) -> None:
    """Alerte de nouvel appareil, si l'adresse est active. Une panne d'envoi ne change rien à la connexion."""
    if not active(user):
        return
    reserved = _reserve(user, "alerte", ALERTS_PER_HOUR)
    if reserved is None:
        return
    network = "un réseau déjà vu sur ce compte" if known_network else "un réseau jamais vu sur ce compte"
    try:
        _deliver(_row(user)["adresse"], "Noah : nouvel appareil sur ton compte",
                 f"Un nouvel appareil vient de se connecter à ton compte Noah Agent.\n\nAppareil : {name or 'inconnu'}\nAdresse : {ip or 'inconnue'}\n"
                 f"Réseau : {network}\nDate : {when}\n\nOuvre Noah sur un appareil déjà relié : tu pourras dire « C'est moi » ou « Ce n'est pas moi ».\n")
    except SendFailed as e:
        _give_back(user, "alerte", reserved)
        log.warning("Alerte de nouvel appareil non envoyée par courriel pour le compte n°%d : %s.", user, e.why)


# --- Routes ---------------------------------------------------------------------------------------------------------------

def _session_of(request: Request) -> str:
    return auth.session_key(auth.request_token(request, request.cookies.get(auth.COOKIE)))


class NewAddress(Preuve):
    adresse: str = Field(min_length=3, max_length=254)


class ActivationCode(BaseModel):
    code: str = Field(min_length=1, max_length=16)


class TestMail(BaseModel):
    adresse: str = Field(default="", max_length=254)


class Smtp(Preuve):
    hote: str = Field(min_length=1, max_length=253)
    port: int = Field(ge=1, le=65535)
    utilisateur: str = Field(default="", max_length=254)
    mot_de_passe: str = Field(default="", max_length=512)  # vide : celui déjà enregistré, si le serveur ne change pas
    expediteur: str = Field(min_length=3, max_length=254)
    tls: str = Field(pattern="^(starttls|ssl)$")


@router.get("/api/me/courriel")
def my_address(user: int = Depends(auth.current_user)):
    row = _row(user)
    return {"adresse": row["adresse"] if row else "", "active": bool(row and row["active"]), "en_attente": row["en_attente"] if row else "",
            "envoi_regle": smtp_settings() is not None}


@router.post("/api/me/courriel")
def set_address(body: NewAddress, request: Request, user: int = Depends(auth.current_user)):
    """Preuve (et code sur l'ancienne adresse, si elle est active), puis code envoyé à la nouvelle : un jeton volé ne détourne pas
    les confirmations vers sa propre boîte, et une faute de frappe n'enferme personne."""
    address = _valid_address(body.adresse)
    if not smtp_settings():
        raise HTTPException(409, "Le propriétaire de ce serveur n'a pas encore réglé l'envoi de courriels.")
    _h["critical"](request, user, "courriel", body.motdepasse, body.code, body.courriel, "Confirme ton mot de passe pour changer ton adresse.")
    send_code(user, f"activer:{address.lower()}", _session_of(request), address)
    with db.connect() as c:
        c.execute("INSERT INTO courriel_adresses (user_id, en_attente) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET en_attente = excluded.en_attente",
                  (user, address))
    return {"attente": True, "vers": address}


@router.post("/api/me/courriel/activer")
def activate_address(body: ActivationCode, request: Request, user: int = Depends(auth.current_user)):
    row = _row(user)
    if not row or not row["en_attente"] or not check(user, f"activer:{row['en_attente'].lower()}", body.code, _session_of(request)):
        raise HTTPException(400, WRONG_CODE)
    with db.connect() as c:
        c.execute("UPDATE courriel_adresses SET adresse = en_attente, en_attente = '', active = 1 WHERE user_id = ?", (user,))
    log.warning("Courriel de confirmation activé pour le compte n°%d.", user)
    return {"ok": True}


@router.delete("/api/me/courriel")
def remove_address(request: Request, body: Preuve | None = None, user: int = Depends(auth.current_user)):
    body = body or Preuve()
    if active(user):
        _h["critical"](request, user, "courriel", body.motdepasse, body.code, body.courriel, "Confirme ton mot de passe pour retirer ton adresse.")
        log.warning("Courriel de confirmation retiré pour le compte n°%d.", user)
    with db.connect() as c:
        c.execute("DELETE FROM courriel_adresses WHERE user_id = ?", (user,))
    return {"ok": True}


@router.get("/api/courriel/smtp")
def read_smtp(_: int = Depends(access.owner_only)):
    return smtp_public()


@router.put("/api/courriel/smtp")
def write_smtp(body: Smtp, request: Request, user: int = Depends(access.owner_only)):
    host = body.hote.strip()
    if not HOST.match(host):
        raise HTTPException(400, "Ce nom de serveur n'est pas valable.")
    sender = _valid_address(body.expediteur)
    if body.utilisateur != body.utilisateur.strip() or any(ch in body.utilisateur for ch in "\r\n"):
        raise HTTPException(400, "Cet identifiant n'est pas valable.")
    _h["critical"](request, user, "courriel", body.motdepasse, body.code, body.courriel, "Confirme ton mot de passe pour régler l'envoi de courriels.")
    before = smtp_settings() or {}
    # Le mot de passe enregistré ne part jamais vers un autre serveur que le sien.
    sealed = db.seal(body.mot_de_passe) if body.mot_de_passe else before.get("mot_de_passe", "") if before.get("hote") == host else ""
    db.set_setting("smtp", json.dumps({"hote": host, "port": body.port, "utilisateur": body.utilisateur, "mot_de_passe": sealed,
                                       "expediteur": sender, "tls": body.tls}))
    log.warning("Réglage d'envoi de courriels changé par le compte n°%d.", user)
    return smtp_public()


@router.delete("/api/courriel/smtp")
def remove_smtp(request: Request, body: Preuve | None = None, user: int = Depends(access.owner_only)):
    with db.connect() as c:
        in_use = c.execute("SELECT COUNT(*) FROM courriel_adresses WHERE active = 1").fetchone()[0]
    if in_use:
        raise HTTPException(409, "Des adresses sont actives : chacun doit d'abord retirer la sienne, sinon ses actions critiques seraient refusées.")
    body = body or Preuve()
    _h["critical"](request, user, "courriel", body.motdepasse, body.code, body.courriel, "Confirme ton mot de passe pour retirer ce réglage.")
    with db.connect() as c:
        c.execute("DELETE FROM settings WHERE key = 'smtp'")
    return smtp_public()


@router.post("/api/courriel/essai")
def test_mail(body: TestMail, user: int = Depends(access.owner_only)):
    """Avec le réglage enregistré. La raison de l'échec est donnée telle quelle ; rien ne se bloque."""
    row = _row(user)
    to = _valid_address(body.adresse or (row and (row["en_attente"] or row["adresse"])) or "")
    when = _reserve(user, "essai", TESTS_PER_HOUR)
    if when is None:
        raise HTTPException(429, "Trop d'essais pour cette heure. Réessaie plus tard.")
    try:
        _deliver(to, "Noah : courriel d'essai", "L'envoi de courriels de Noah Agent marche. Ce message ne demande rien.\n")
    except SendFailed as e:
        _give_back(user, "essai", when)
        raise HTTPException(502, f"L'essai n'est pas parti : {e.why}.") from None
    return {"ok": True, "vers": to}
