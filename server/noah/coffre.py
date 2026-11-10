"""Se connecter à un site depuis le navigateur de l'agent, sans que l'agent voie le mot de passe.

L'agent appelle son outil `browser_vault` (agent_plugin). Le serveur lit lui-même ce que la page est, avec la clé du navigateur que
l'agent n'a pas : l'origine montrée à la personne ne vient jamais d'un texte de l'agent. La personne saisit ses identifiants dans une
carte de la conversation ; le serveur les pose directement dans la page (launcher/camofox-noah, POST /noah/remplir), et l'agent ne
reçoit que le résultat. Ils n'entrent donc jamais dans sa machine, où son terminal lirait tout.

Pourquoi pas le coffre d'Hermes (tools/browser_vault_tool.py) : il pilote un Chromium à lui, pas Camofox, et il refuse de demander
quoi que ce soit en mode API. Son fichier chiffré, surtout, a sa clé juste à côté, dans le volume de l'agent, à portée de son terminal.

Une demande reste en mémoire : à usage unique, 10 minutes au plus, jamais en base, jamais dans les messages, le journal, les
diagnostics ou une notification. Ce que la personne choisit de retenir est scellé (db.seal) : la clé vit dans le volume des secrets,
hors de portée de l'agent. Le mot de passe ne retourne jamais vers un navigateur.
"""
import asyncio
import json
import re
import secrets
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from . import access, auth, db, hermes, push, relay

router = APIRouter()

ASK_SECONDS = 600
MAX_WAIT = 25  # l'agent revient régulièrement : un arrêt de la tâche se voit sans attendre la réponse
MAX_IDENTIFIER = 320
MAX_PASSWORD = 1024
MAX_CODE = 16
MAX_BODY = 4096
MAX_ASKED = 50
SECOND_LEVEL = {"ac", "co", "com", "edu", "gouv", "gov", "ne", "net", "or", "org"}

task_state: dict[str, str] = {}  # celui de main.py, pour que la conversation et « À toi » montrent ce qui attend
_asked: dict[str, dict] = {}


def site_of(origin: str) -> str:
    """Le domaine que la personne reconnaît : instagram.com.piege.io se lit piege.io."""
    host = urlsplit(origin).hostname or ""
    parts = host.split(".")
    if len(parts) < 2 or re.fullmatch(r"[\d.]+", host) or ":" in host:
        return host
    keep = 3 if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in SECOND_LEVEL else 2
    return ".".join(parts[-keep:])


def _refused(error_type: str, error: str) -> dict:
    return {"success": False, "error_type": error_type, "error": error}


def _finish(item: dict, result: dict) -> None:
    item["result"] = result
    item["answered"] = True
    item["done_at"] = time.monotonic()
    if task_state.get(item["conv"]) == "approve":
        task_state[item["conv"]] = "work"


def _sweep() -> None:
    now = time.monotonic()
    for key, item in list(_asked.items()):
        if item.get("done_at"):
            if now - item["done_at"] > 60:  # l'agent ne viendra plus le chercher
                del _asked[key]
        elif item.get("answered"):
            continue  # la page est en train d'être remplie
        elif now > item["expires"]:
            _finish(item, _refused("expired", "La personne n'a pas répondu à temps. Dis-lui ce qui attend, sans redemander tout de suite."))
        elif item["conv"] not in (relay.active.get(item["agent"]) or []):
            _finish(item, _refused("cancelled", "La tâche s'est arrêtée."))


def _view(item: dict) -> dict:
    return {"id": item["id"], "type": item["type"], "site": item["site"], "origine": item["origine"],
            "chiffre": item["origine"].startswith("https://"), "identifiant_requis": item["identifiant_requis"]}


def pending(conv_id: str) -> dict | None:
    """Ce qui attend dans cette conversation, sans regarder qui demande : la réponse appartient à son auteur (`asked`)."""
    _sweep()
    return next((i for i in _asked.values() if i["conv"] == conv_id and not i.get("answered")), None)


def asked(conv_id: str, user: int) -> dict | None:
    item = pending(conv_id)
    return _view(item) if item and item["user"] == user else None


def _conversation(agent_id: str, session: str) -> str | None:
    """La tâche de cet appel : celle de sa session Hermes. Une session renommée par Hermes (résumé) n'a plus ce nom : s'il n'y a
    qu'une tâche, c'est elle ; sinon on ne devine pas à qui montrer la carte."""
    active = list(dict.fromkeys(relay.active.get(agent_id) or []))
    if session.startswith("noah-") and session[5:] in active:
        return session[5:]
    return active[0] if len(active) == 1 else None


def _for_a_guest(agent_id: str) -> bool:
    """Une personne avec qui l'agent est partagé : son profil Hermes est lisible par le propriétaire. Elle ne confie pas de mot
    de passe à cette machine, et elle n'utilise pas ceux du propriétaire."""
    return any(access.separated(user, agent_id) for user in access.callers(agent_id))


async def _page(agent_id: str, tab: str = "") -> dict:
    """{origine, onglet, champs}, lus dans la vraie page. Une erreur sous `error`, déjà en mots simples."""
    try:
        seen = await hermes.browser_call(agent_id, "POST", "/noah/page", key=hermes.private_key(agent_id), timeout=20,
                                         params={"userId": hermes.BROWSER_USER, **({"onglet": tab} if tab else {})})
    except httpx.HTTPError:
        return {"error": "Le navigateur ne répond pas : lance « noah.py navigateur reveiller », puis réessaie."}
    if seen.get("ok"):
        return seen
    if seen.get("http_status") == 403 or not seen.get("error"):  # un navigateur d'avant cette route : ni clé reconnue, ni réponse à elle
        return {"error": "Ce navigateur doit être relancé pour remplir une page : lance « noah.py navigateur redemarrer », puis réessaie."}
    return {"error": seen["error"]}


async def _fill(agent_id: str, page: dict, values: dict) -> dict:
    try:
        return await hermes.browser_call(agent_id, "POST", "/noah/remplir", key=hermes.private_key(agent_id), timeout=60,
                                         json={"userId": hermes.BROWSER_USER, "onglet": page["onglet"], "origine": page["origine"], **values})
    except httpx.HTTPError:
        return {"error": "Le navigateur n'a pas répondu : regarde l'état de la page avant de réessayer."}


def _outcome(filled: dict, origin: str, saved: bool = False, handle: str = "") -> dict:
    """Ce que l'agent reçoit : ce qui s'est passé, jamais ce qui a été écrit."""
    if not filled.get("ok"):
        return _refused("origin_changed" if filled.get("http_status") == 409 else "fill_failed", str(filled.get("error") or "La page n'a pas accepté la saisie."))
    done = {"success": True, "origin": origin, "filled_fields": filled.get("rempli") or [], "page": filled.get("page"), "saved": saved}
    if handle:
        done["handle"] = handle
    if not filled.get("complet", True):
        done["next"] = ("Seul l'identifiant a été envoyé : le mot de passe n'a pas trouvé de champ sur ce site. Relis la page ; si elle demande le mot de passe "
                        "sur un autre domaine, rappelle action=save_login.")
    elif filled.get("page") == "meme":
        done["next"] = ("Le formulaire est resté affiché et le champ a été vidé : la page a peut-être refusé ces identifiants. Relis-la et dis ce qu'elle "
                        "indique ; pour réessayer, action=save_login.")
    else:
        done["next"] = "Le formulaire est parti. Relis la page : si elle demande un code, action=enter_code."
    return done


def _mask(identifier: str) -> str:
    name, at, domain = identifier.partition("@")
    return f"{name[:1]}•••{at}{domain}"


def _rows(agent_id: str):
    with db.connect() as c:
        return c.execute("SELECT id, origine, secret, created_at, used_at FROM agent_logins WHERE agent_id = ? ORDER BY created_at", (agent_id,)).fetchall()


def _remember(agent_id: str, origin: str, identifier: str, password: str) -> str:
    """Un compte par site et par identifiant : un nouveau mot de passe remplace l'ancien."""
    sealed = db.seal(json.dumps({"identifiant": identifier, "mot_de_passe": password}))
    with db.connect() as c:
        for row in c.execute("SELECT id, secret FROM agent_logins WHERE agent_id = ? AND origine = ?", (agent_id, origin)).fetchall():
            if json.loads(db.unseal(row["secret"])).get("identifiant") == identifier:
                c.execute("UPDATE agent_logins SET secret = ? WHERE id = ?", (sealed, row["id"]))
                return row["id"]
        handle = "login_" + secrets.token_hex(8)
        c.execute("INSERT INTO agent_logins (id, agent_id, origine, secret, created_at) VALUES (?, ?, ?, ?, ?)", (handle, agent_id, origin, sealed, time.time()))
    return handle


# --- Côté agent --------------------------------------------------------------------------------------------------------

def _list(agent_id: str) -> dict:
    items = []
    for row in _rows(agent_id):
        identifier = json.loads(db.unseal(row["secret"])).get("identifiant") or ""
        items.append({"handle": row["id"], "kind": "login", "origin": row["origine"], "label": site_of(row["origine"]), "account": _mask(identifier)})
    out = {"success": True, "items": items}
    if not items:
        out["hint"] = "Aucun identifiant retenu. Sur une page de connexion, action=save_login le demande à la personne."
    return out


async def _fill_saved(agent_id: str, handle: str) -> dict:
    with db.connect() as c:
        row = c.execute("SELECT origine, secret FROM agent_logins WHERE id = ? AND agent_id = ?", (handle, agent_id)).fetchone()
    if not row:
        return _refused("unknown_handle", "Identifiant inconnu : regarde action=list, ou demande-le avec action=save_login.")
    page = await _page(agent_id)
    if page.get("error"):
        return _refused("page_unavailable", page["error"])
    if page.get("origine") != row["origine"]:
        return _refused("origin_mismatch", f"Refusé : cet identifiant sert sur {row['origine']}, et la page est sur {page.get('origine')}. Rien n'a été écrit.")
    secret = json.loads(db.unseal(row["secret"]))
    filled = await _fill(agent_id, page, {"identifiant": secret.get("identifiant"), "motDePasse": secret.get("mot_de_passe")})
    with db.connect() as c:
        c.execute("UPDATE agent_logins SET used_at = ? WHERE id = ?", (time.time(), handle))
    return _outcome(filled, row["origine"], saved=True, handle=handle)


async def _ask(agent_id: str, kind: str, session: str) -> dict:
    """Ouvre la carte. Rend {attente: id}, ou ce qui l'empêche."""
    conv = _conversation(agent_id, session)
    if not conv:
        return _refused("prompt_unavailable", "Personne ne peut répondre ici (routine, ou plusieurs tâches en même temps). Préviens la personne au lieu d'attendre.")
    page = await _page(agent_id)
    if page.get("error"):
        return _refused("page_unavailable", page["error"])
    origin, fields = page.get("origine"), page.get("champs") or {}
    if not origin:
        return _refused("no_page", "Ouvre d'abord la page de connexion du site.")
    if kind == "connexion" and not (fields.get("motDePasse") or fields.get("identifiant")):
        return _refused("no_login_field", "Aucun champ de connexion sur cette page. Si le site attend un clic (« Se connecter »), fais-le d'abord.")
    if kind == "code" and not fields.get("code"):
        return _refused("no_code_field", "Aucun champ de code sur cette page. Si le site attend une validation dans une application, dis à la personne de la faire, puis relis la page.")
    with db.connect() as c:
        row = c.execute("SELECT user_id FROM conversations WHERE id = ?", (conv,)).fetchone()
    if not row:
        return _refused("prompt_unavailable", "Conversation introuvable.")
    _sweep()
    for other in _asked.values():  # une seule carte par conversation : la dernière demande remplace l'autre
        if other["conv"] == conv and not other.get("answered"):
            _finish(other, _refused("cancelled", "Remplacée par une nouvelle demande."))
    if len(_asked) >= MAX_ASKED:
        return _refused("busy", "Trop de demandes en attente : réessaie plus tard.")
    item = {"id": secrets.token_urlsafe(16), "agent": agent_id, "conv": conv, "user": row["user_id"], "type": kind, "origine": origin, "site": site_of(origin),
            "onglet": page.get("onglet") or "", "identifiant_requis": not fields.get("motDePasse") or bool(fields.get("identifiant")),
            "created": time.time(), "expires": time.monotonic() + ASK_SECONDS}
    _asked[item["id"]] = item
    task_state[conv] = "approve"
    text = f"Se connecter à {item['site']}" if kind == "connexion" else f"Code demandé par {item['site']}"
    push.notify("Noah attend ta connexion", text, urgent=True, user_id=row["user_id"], kind="accord")
    return {"attente": item["id"]}


@router.post("/agent-api/coffre")
async def agent_vault(request: Request):
    agent_id = relay._agent_from(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Demande illisible") from None
    action = str(body.get("action") or "") if isinstance(body, dict) else ""
    if _for_a_guest(agent_id):
        return _refused("guest", "Les connexions enregistrées sont réservées au propriétaire de l'agent. Dis-le simplement : cette personne se connecte elle-même, dans l'onglet Ordinateur.")
    if action == "list":
        return _list(agent_id)
    if action == "fill":
        return await _fill_saved(agent_id, str(body.get("handle") or ""))
    if action in ("save_login", "enter_code"):
        return await _ask(agent_id, "connexion" if action == "save_login" else "code", str(body.get("session") or ""))
    if action == "unlock":
        return _refused("no_manager", "Aucun gestionnaire de mots de passe externe n'est branché sur cet agent.")
    return _refused("unknown_action", "Action inconnue : list, fill, save_login ou enter_code.")


def _agents_own(agent_id: str, ask_id: str) -> dict:
    item = _asked.get(ask_id)
    if not item or item["agent"] != agent_id:
        raise HTTPException(404, "Demande inconnue")
    return item


@router.get("/agent-api/coffre/{ask_id}")
async def agent_vault_wait(ask_id: str, request: Request, attente: float = MAX_WAIT):
    agent_id = relay._agent_from(request)
    end = time.monotonic() + min(max(attente, 0), MAX_WAIT)
    while True:
        _sweep()
        item = _agents_own(agent_id, ask_id)
        if item.get("done_at"):
            del _asked[ask_id]
            return item["result"]
        if time.monotonic() >= end:
            return {"attente": ask_id}
        await asyncio.sleep(0.25)


@router.delete("/agent-api/coffre/{ask_id}")
def agent_vault_cancel(ask_id: str, request: Request):
    agent_id = relay._agent_from(request)
    item = _agents_own(agent_id, ask_id)
    if not item.get("answered"):
        _finish(item, _refused("cancelled", "Annulée."))
    del _asked[ask_id]
    return {"ok": True}


# --- Côté personne -----------------------------------------------------------------------------------------------------

def _text(body: dict, name: str, limit: int) -> str:
    value = body.get(name)
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit:
        raise HTTPException(400, "Ce champ est trop long.")  # sans citer la valeur : une erreur finit souvent dans un journal
    return value


async def _read_answer(request: Request) -> dict:
    """Le corps à la main : FastAPI recopie une valeur refusée dans sa réponse d'erreur, et un mot de passe n'a rien à y faire."""
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(413, "Réponse trop longue.")
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "Réponse illisible.") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "Réponse illisible.")
    return body


@router.post("/api/agents/{agent_id}/connexions/{ask_id}")
async def answer_login(agent_id: str, ask_id: str, request: Request, user: int = Depends(auth.current_user)):
    """La réponse de la personne. La protection anti-CSRF est celle de toutes les routes (main.same_origin_only)."""
    access.access(user, agent_id, "usage")
    if access.separated(user, agent_id):
        raise HTTPException(403, "Une personne invitée ne saisit pas de mot de passe pour le navigateur du propriétaire.")
    _sweep()
    item = _asked.get(ask_id)
    if not item or item["agent"] != agent_id or item["user"] != user:
        raise HTTPException(404, "Demande introuvable")
    if item.get("answered"):
        raise HTTPException(410, "Cette demande n'attend plus de réponse.")
    body = await _read_answer(request)
    if body.get("refuser") is True:
        _finish(item, _refused("save_declined", "La personne a choisi de ne pas se connecter maintenant. Ne redemande pas pendant ce tour : continue sans, ou dis ce qui bloque."))
        return {"ok": True, "refuse": True}
    values, identifier, password = {}, "", ""
    if item["type"] == "code":
        code = re.sub(r"[\s-]", "", _text(body, "code", MAX_CODE))
        if not code:
            raise HTTPException(400, "Saisis le code.")
        values = {"code": code}
    else:
        identifier, password = _text(body, "identifiant", MAX_IDENTIFIER).strip(), _text(body, "mot_de_passe", MAX_PASSWORD)
        if not password or (item["identifiant_requis"] and not identifier):
            raise HTTPException(400, "Saisis ton identifiant et ton mot de passe.")
        values = {"identifiant": identifier, "motDePasse": password}
    item["answered"] = True  # avant la première attente : un second envoi ne passe plus
    result = _refused("fill_failed", "La page n'a pas accepté la saisie.")
    try:
        page = await _page(agent_id, item["onglet"])
        if page.get("error"):
            result = _refused("page_unavailable", page["error"])
        elif page.get("origine") != item["origine"]:
            result = _refused("origin_changed", f"La page a changé de site ({page.get('origine')}) pendant la saisie. Rien n'y a été écrit.")
        else:
            filled = await _fill(agent_id, {**page, "origine": item["origine"]}, values)
            # Un mot de passe refusé par le site ne se retient pas : il resservirait à chaque fois.
            keep = item["type"] == "connexion" and body.get("retenir") is not False and filled.get("ok") and filled.get("complet", True) and filled.get("page") != "meme"
            handle = _remember(agent_id, item["origine"], identifier, password) if keep else ""
            result = _outcome(filled, item["origine"], saved=bool(keep), handle=handle)
    finally:
        _finish(item, result)
    if not result["success"]:
        raise HTTPException(409, result["error"])
    return {"ok": True, "page": result.get("page"), "retenu": result.get("saved", False)}


@router.get("/api/agents/{agent_id}/coffre")
def saved_logins(agent_id: str, user: int = Depends(auth.current_user)):
    """Les sites retenus. Ni l'identifiant ni le mot de passe ne repartent vers un écran."""
    access.access(user, agent_id, "admin")
    return [{"id": row["id"], "site": site_of(row["origine"]), "origine": row["origine"]} for row in _rows(agent_id)]


@router.delete("/api/agents/{agent_id}/coffre/{login_id}")
def forget_login(agent_id: str, login_id: str, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    with db.connect() as c:
        gone = c.execute("DELETE FROM agent_logins WHERE id = ? AND agent_id = ?", (login_id, agent_id)).rowcount
    if not gone:
        raise HTTPException(404, "Identifiant introuvable")
    return {"ok": True}
