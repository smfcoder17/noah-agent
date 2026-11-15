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

0.3.0 (leçons de Nod, docs/epics/0.3.0/nod-comparaison.md, 4.1) :
- le coffre appartient à la personne (table `coffre`), et ses agents s'en servent selon un droit par agent (`coffre_agents`) :
  allumé d'office pour un agent qui n'est partagé avec personne, éteint pour un agent partagé ;
- sur une page de connexion, c'est le serveur qui cherche les identifiants du site (origine exacte, puis même site) : un seul, il
  remplit sans rien demander ; plusieurs, la carte demande lequel ; aucun, la carte demande l'identifiant ;
- de même pour un code : une clé d'authentificateur du site retenue, le serveur calcule et tape le code lui-même ;
- le modèle ne reçoit d'un identifiant que son nom, son site et ses deux premiers caractères.
"""
import asyncio
import base64
import csv
import hashlib
import hmac
import io
import ipaddress
import json
import re
import secrets
import struct
import time
from urllib.parse import parse_qs, unquote, urlsplit

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
MAX_NAME = 60
MAX_ITEMS = 2000  # par personne
MAX_IMPORT = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 5000
FAILED_SECONDS = 600  # un identifiant retenu que le site vient de refuser n'est plus pris d'office pendant ce temps
SECOND_LEVEL = {"ac", "co", "com", "edu", "gouv", "gov", "ne", "net", "or", "org"}
# Des domaines où chaque sous-domaine appartient à quelqu'un d'autre : « même site » n'y veut rien dire, seule l'origine exacte compte.
SHARED_HOSTING = {"github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "workers.dev", "web.app",
                  "firebaseapp.com", "appspot.com", "blogspot.com", "wordpress.com", "myshopify.com", "azurewebsites.net",
                  "cloudfront.net", "amazonaws.com", "onrender.com", "fly.dev", "glitch.me", "ngrok.io", "ngrok-free.app",
                  "sslip.io", "nip.io", "repl.co", "replit.app", "surge.sh", "wixsite.com", "squarespace.com", "webflow.io",
                  "notion.site", "substack.com", "tumblr.com", "weebly.com", "carrd.co", "framer.app", "duckdns.org"}

task_state: dict[str, str] = {}  # celui de main.py, pour que la conversation et « À toi » montrent ce qui attend
_asked: dict[str, dict] = {}
_failed: dict[str, float] = {}  # id d'un élément du coffre → quand le site l'a refusé


def site_of(origin: str) -> str:
    """Le domaine que la personne reconnaît : instagram.com.piege.io se lit piege.io."""
    host = urlsplit(origin).hostname or ""
    parts = host.split(".")
    if len(parts) < 2 or re.fullmatch(r"[\d.]+", host) or ":" in host:
        return host
    keep = 3 if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in SECOND_LEVEL else 2
    return ".".join(parts[-keep:])


def same_site(saved: str, page: str) -> bool:
    """Un identifiant retenu sert-il sur cette page ? Son origine exacte, ou le même site enregistrable (www.instagram.com ↔
    instagram.com), seulement en https des deux côtés, sur le même port, et jamais sur un hébergement partagé (a.github.io ≠ b.github.io)."""
    if not saved or not page:
        return False
    if saved == page:
        return True
    a, b = urlsplit(saved), urlsplit(page)
    if a.scheme != "https" or b.scheme != "https":
        return False
    try:
        if (a.port or 443) != (b.port or 443):
            return False
    except ValueError:
        return False
    site = site_of(saved)
    return bool(site) and "." in site and not re.fullmatch(r"[\d.]+", site) and site == site_of(page) and site not in SHARED_HOSTING


def origin_of(address: str) -> str:
    """« https://www.instagram.com/accounts/login » → « https://www.instagram.com ». Vide si ce n'est pas une adresse web."""
    text = (address or "").strip()
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        return ""
    host = (parts.hostname or "").lower()
    if ":" in host:  # une adresse IPv6 ([::1]) : valide, et gardée entre crochets comme dans la page
        try:
            host = "[" + ipaddress.IPv6Address(host).compressed + "]"
        except ValueError:
            return ""
    elif parts.scheme not in ("http", "https") or not host or not re.fullmatch(r"[a-z0-9.\-]+", host) or "." not in host and host != "localhost":
        return ""
    if parts.scheme not in ("http", "https"):
        return ""
    default = 443 if parts.scheme == "https" else 80
    return f"{parts.scheme}://{host}" + (f":{port}" if port and port != default else "")


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
    for key, at in list(_failed.items()):
        if now - at > FAILED_SECONDS:
            del _failed[key]


def _view(item: dict) -> dict:
    view = {"id": item["id"], "type": item["type"], "site": item["site"], "origine": item["origine"],
            "chiffre": item["origine"].startswith("https://"), "identifiant_requis": item["identifiant_requis"]}
    if item.get("comptes"):
        view["comptes"] = [{"id": c["id"], "nom": c["nom"], "compte": c["compte"]} for c in item["comptes"]]
    return view


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
                        "indique ; pour réessayer, action=save_login (la personne sera sollicitée).")
    else:
        done["next"] = "Le formulaire est parti. Relis la page : si elle demande un code, action=enter_code."
    return done


async def _after_fill(agent_id: str, filled: dict, origin: str, item_id: str = "", user: int | None = None) -> None:
    """Un remplissage qui a marché : le serveur relit la page, et le site n'est noté connecté que s'il y est resté, sans champ de
    mot de passe (sites.py). Un remplissage refusé par le site : cet élément n'est plus pris d'office pendant un moment.
    Seule la connexion du propriétaire note le site : le registre décrit sa session, pas celle d'une autre personne."""
    if not filled.get("ok"):
        return
    if filled.get("page") == "meme" or not filled.get("complet", True):
        if item_id:
            _failed[item_id] = time.monotonic()
        return
    if user is None or user != owner(agent_id):
        return
    from . import sites
    await sites.verify(agent_id, origin, proven=True)  # le serveur a lui-même envoyé le formulaire, et la page l'a quitté


def _mask(identifier: str) -> str:
    """Ce que le modèle voit d'un identifiant : ses deux premiers caractères."""
    return f"{identifier[:2]}•••" if identifier else ""


def _secret(row) -> dict:
    try:
        value = json.loads(db.unseal(row["secret"]))
    except Exception:  # noqa: BLE001 - une ligne illisible ne casse pas tout le coffre ; elle ne sert simplement pas
        return {}
    return value if isinstance(value, dict) else {}


# --- Le coffre de la personne, et le droit de chaque agent ------------------------------------------------------------

def owner(agent_id: str) -> int | None:
    """Le coffre dont un agent se sert : celui de son propriétaire, jamais celui d'une personne avec qui il est partagé."""
    return access.owner_of(agent_id)


def _shared(agent_id: str) -> bool:
    with db.connect() as c:
        return bool(c.execute("SELECT 1 FROM agent_shares WHERE agent_id = ? LIMIT 1", (agent_id,)).fetchone())


def may_use(agent_id: str) -> bool:
    """Le droit « utiliser mon coffre » de cet agent : celui que le propriétaire a choisi, sinon allumé s'il n'est partagé avec personne."""
    with db.connect() as c:
        row = c.execute("SELECT utiliser FROM coffre_agents WHERE agent_id = ?", (agent_id,)).fetchone()
    return bool(row["utiliser"]) if row else not _shared(agent_id)


def set_may_use(agent_id: str, allowed: bool) -> None:
    with db.connect() as c:
        c.execute("INSERT INTO coffre_agents (agent_id, utiliser) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET utiliser = excluded.utiliser",
                  (agent_id, int(allowed)))


def _items(user: int | None, genre: str | None = None):
    if user is None:
        return []
    with db.connect() as c:
        if genre:
            return c.execute("SELECT * FROM coffre WHERE user_id = ? AND genre = ? ORDER BY created_at", (user, genre)).fetchall()
        return c.execute("SELECT * FROM coffre WHERE user_id = ? ORDER BY created_at", (user,)).fetchall()


def _rows(agent_id: str, genre: str = "login"):
    """Ce que cet agent peut utiliser du coffre de son propriétaire : rien sans le droit."""
    return _items(owner(agent_id), genre) if may_use(agent_id) else []


def _matching(agent_id: str, origin: str, genre: str = "login") -> list:
    """Les éléments retenus pour cette page : ceux de l'origine exacte d'abord, sinon ceux du même site."""
    rows = _rows(agent_id, genre)
    exact = [r for r in rows if r["origine"] == origin]
    return exact or [r for r in rows if same_site(r["origine"], origin)]


def _label(row) -> str:
    return (row["nom"] or "").strip() or site_of(row["origine"])


def _remember(user: int, origin: str, identifier: str, password: str) -> str:
    """Un compte par site et par identifiant : un nouveau mot de passe remplace l'ancien."""
    sealed = db.seal(json.dumps({"identifiant": identifier, "mot_de_passe": password}))
    with db.connect() as c:
        found = ""
        for row in c.execute("SELECT id, secret FROM coffre WHERE user_id = ? AND genre = 'login' AND origine = ?", (user, origin)).fetchall():
            if _secret(row).get("identifiant") == identifier:
                c.execute("UPDATE coffre SET secret = ? WHERE id = ?", (sealed, row["id"]))
                found = found or row["id"]
        if found:
            return found
        if c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ?", (user,)).fetchone()[0] >= MAX_ITEMS:
            return ""
        handle = "login_" + secrets.token_hex(8)
        c.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at) VALUES (?, ?, 'login', '', ?, ?, ?)",
                  (handle, user, origin, sealed, time.time()))
    return handle


def totp_code(key: str, at: float | None = None, digits: int = 6, period: int = 30) -> str:
    """RFC 6238 (SHA-1, 30 s, 6 chiffres) : ce que montre une application d'authentification."""
    raw = re.sub(r"[\s=-]", "", key).upper()
    secret_bytes = base64.b32decode(raw + "=" * (-len(raw) % 8))
    digest = hmac.new(secret_bytes, struct.pack(">Q", int((time.time() if at is None else at) // period)), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return str((int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


# --- Côté agent --------------------------------------------------------------------------------------------------------

def _list(agent_id: str) -> dict:
    items = []
    for row in _rows(agent_id):
        items.append({"handle": row["id"], "kind": "login", "name": _label(row), "origin": row["origine"], "label": site_of(row["origine"]),
                      "account": _mask(_secret(row).get("identifiant") or "")})
    out = {"success": True, "items": items}
    if not may_use(agent_id):
        out["hint"] = "Le coffre de la personne n'est pas ouvert à cet agent. Sur une page de connexion, action=save_login le lui demande."
    elif not items:
        out["hint"] = "Aucun identifiant retenu. Sur une page de connexion, action=save_login le demande à la personne."
    return out


def _login_row(agent_id: str, login_id: str):
    """Un identifiant de ce coffre que cet agent a le droit d'utiliser, ou None."""
    if not may_use(agent_id):
        return None
    with db.connect() as c:
        return c.execute("SELECT * FROM coffre WHERE id = ? AND user_id = ? AND genre = 'login'", (login_id, owner(agent_id))).fetchone()


async def _use_login(agent_id: str, page: dict, row) -> dict:
    """Remplit et envoie en une étape, côté serveur : le modèle n'observe ni la saisie ni la valeur."""
    secret = _secret(row)
    filled = await _fill(agent_id, page, {"identifiant": secret.get("identifiant"), "motDePasse": secret.get("mot_de_passe")})
    with db.connect() as c:
        c.execute("UPDATE coffre SET used_at = ? WHERE id = ?", (time.time(), row["id"]))
    await _after_fill(agent_id, filled, page["origine"], row["id"], user=owner(agent_id))
    return _outcome(filled, page["origine"], saved=True, handle=row["id"])


def _owner_turn(agent_id: str) -> bool:
    """Toutes les tâches en cours de cet agent sont celles de son propriétaire : lui seul fait taper ses secrets."""
    return access.callers(agent_id) == {owner(agent_id)}


async def _fill_saved(agent_id: str, handle: str) -> dict:
    row = _login_row(agent_id, handle)
    if row and not _owner_turn(agent_id):
        return _refused("not_owner", "Les identifiants retenus sont ceux du propriétaire de l'agent, et cette tâche n'est pas la sienne. Demande avec action=save_login.")
    if not row:
        return _refused("unknown_handle", "Identifiant inconnu : regarde action=list, ou demande-le avec action=save_login.")
    page = await _page(agent_id)
    if page.get("error"):
        return _refused("page_unavailable", page["error"])
    if not same_site(row["origine"], page.get("origine") or ""):
        return _refused("origin_mismatch", f"Refusé : cet identifiant sert sur {row['origine']}, et la page est sur {page.get('origine')}. Rien n'a été écrit.")
    return await _use_login(agent_id, page, row)


async def _ask(agent_id: str, kind: str, session: str) -> dict:
    """Le serveur regarde d'abord le coffre : un seul élément pour ce site, il remplit lui-même. Sinon il ouvre la carte, et rend
    {attente: id}, ou ce qui l'empêche."""
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
    _sweep()
    with db.connect() as c:
        row = c.execute("SELECT user_id FROM conversations WHERE id = ?", (conv,)).fetchone()
    if not row:
        return _refused("prompt_unavailable", "Conversation introuvable.")
    # Remplir d'office, c'est taper un secret du propriétaire : seulement dans une tâche qu'il a lancée lui-même. Pour un autre
    # profil, une carte vide, sans les comptes du propriétaire.
    by_owner = row["user_id"] == owner(agent_id)
    choices = []
    if kind == "connexion":
        from . import sites
        if by_owner:
            sites.needs_sign_in(agent_id, origin)  # une page de connexion sur un site noté connecté : sa session est partie
        found = [r for r in _matching(agent_id, origin) if r["id"] not in _failed] if by_owner else []
        if len(found) == 1:
            done = await _use_login(agent_id, page, found[0])
            if done.get("success"):
                done["automatic"] = True
            return done
        choices = [{"id": r["id"], "nom": _label(r), "compte": _mask(_secret(r).get("identifiant") or "")} for r in found]
    if kind == "code":
        keys = [r for r in _matching(agent_id, origin, "totp") if r["id"] not in _failed] if by_owner else []
        if len(keys) == 1:
            try:
                code = totp_code(_secret(keys[0]).get("cle") or "")
            except (ValueError, TypeError):
                code = ""
            if code:
                filled = await _fill(agent_id, page, {"code": code})
                await _after_fill(agent_id, filled, origin, keys[0]["id"], user=row["user_id"])
                done = _outcome(filled, origin)
                if done.get("success"):
                    done["automatic"] = True
                return done
    for other in _asked.values():  # une seule carte par conversation : la dernière demande remplace l'autre
        if other["conv"] == conv and not other.get("answered"):
            _finish(other, _refused("cancelled", "Remplacée par une nouvelle demande."))
    if len(_asked) >= MAX_ASKED:
        return _refused("busy", "Trop de demandes en attente : réessaie plus tard.")
    item = {"id": secrets.token_urlsafe(16), "agent": agent_id, "conv": conv, "user": row["user_id"], "type": kind, "origine": origin, "site": site_of(origin),
            "onglet": page.get("onglet") or "", "identifiant_requis": not fields.get("motDePasse") or bool(fields.get("identifiant")),
            "comptes": choices, "created": time.time(), "expires": time.monotonic() + ASK_SECONDS}
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


# --- Côté personne : la carte de la conversation ----------------------------------------------------------------------

def _text(body: dict, name: str, limit: int) -> str:
    value = body.get(name)
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit:
        raise HTTPException(400, "Ce champ est trop long.")  # sans citer la valeur : une erreur finit souvent dans un journal
    return value


async def _read_answer(request: Request, limit: int = MAX_BODY) -> dict:
    """Le corps à la main : FastAPI recopie une valeur refusée dans sa réponse d'erreur, et un mot de passe n'a rien à y faire."""
    raw = await request.body()
    if len(raw) > limit:
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
    values, identifier, password, chosen = {}, "", "", None
    if item["type"] == "code":
        code = re.sub(r"[\s-]", "", _text(body, "code", MAX_CODE))
        if not code:
            raise HTTPException(400, "Saisis le code.")
        values = {"code": code}
    elif body.get("choix") is not None:
        choice = _text(body, "choix", 64)
        if choice not in {c["id"] for c in item.get("comptes") or []} or not (chosen := _login_row(agent_id, choice)):
            raise HTTPException(400, "Ce compte n'est plus dans ton coffre.")
        secret = _secret(chosen)
        values = {"identifiant": secret.get("identifiant"), "motDePasse": secret.get("mot_de_passe")}
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
            if chosen:
                with db.connect() as c:
                    c.execute("UPDATE coffre SET used_at = ? WHERE id = ?", (time.time(), chosen["id"]))
            # Un mot de passe refusé par le site ne se retient pas : il resservirait à chaque fois. Seul le propriétaire de l'agent
            # remplit son coffre : ce qu'une autre personne saisit part dans la page, sans rester.
            keep = (item["type"] == "connexion" and not chosen and body.get("retenir") is not False and filled.get("ok") and filled.get("complet", True)
                    and filled.get("page") != "meme" and user == owner(agent_id))
            handle = _remember(user, item["origine"], identifier, password) if keep else ""
            await _after_fill(agent_id, filled, item["origine"], chosen["id"] if chosen else "", user=user)
            result = _outcome(filled, item["origine"], saved=bool(handle) or bool(chosen), handle=handle or (chosen["id"] if chosen else ""))
            if keep and not handle and result.get("success"):  # coffre plein : le dire, au lieu d'une demande qui reviendrait en boucle
                result["vault_full"] = True
                result["next"] = ("Connexion faite, mais le coffre de la personne est plein : rien n'a été retenu. Dis-le-lui (Réglages > Coffre) "
                                  "et ne rappelle pas save_login pour le retenir.")
    finally:
        _finish(item, result)
    if not result["success"]:
        raise HTTPException(409, result["error"])
    done = {"ok": True, "page": result.get("page"), "retenu": bool(result.get("saved")) and not chosen}
    if result.get("vault_full"):
        done["coffre_plein"] = True
    return done


# --- Côté personne : l'agent et son droit -----------------------------------------------------------------------------

def _owner_only(user: int, agent_id: str) -> None:
    """Le coffre est à la personne : seul le propriétaire de l'agent voit ce qu'il en utilise et le règle."""
    access.access(user, agent_id, "admin")
    if owner(agent_id) != user:
        raise HTTPException(403, "Seul le propriétaire de l'agent règle l'accès à son coffre.")


@router.get("/api/agents/{agent_id}/coffre")
def saved_logins(agent_id: str, user: int = Depends(auth.current_user)):
    """Les sites où cet agent se reconnecte seul. Ni l'identifiant ni le mot de passe ne repartent vers un écran."""
    _owner_only(user, agent_id)
    return [{"id": row["id"], "site": site_of(row["origine"]), "origine": row["origine"]} for row in _rows(agent_id)]


@router.get("/api/agents/{agent_id}/coffre-droit")
def vault_right(agent_id: str, user: int = Depends(auth.current_user)):
    _owner_only(user, agent_id)
    return {"utiliser": may_use(agent_id), "partage": _shared(agent_id)}


@router.put("/api/agents/{agent_id}/coffre-droit")
async def set_vault_right(agent_id: str, request: Request, user: int = Depends(auth.current_user)):
    _owner_only(user, agent_id)
    body = await _read_answer(request)
    if not isinstance(body.get("utiliser"), bool):
        raise HTTPException(400, "Réponse illisible.")
    set_may_use(agent_id, body["utiliser"])
    return {"utiliser": may_use(agent_id), "partage": _shared(agent_id)}


@router.delete("/api/agents/{agent_id}/coffre/{login_id}")
def forget_login(agent_id: str, login_id: str, user: int = Depends(auth.current_user)):
    _owner_only(user, agent_id)
    with db.connect() as c:
        gone = c.execute("DELETE FROM coffre WHERE id = ? AND user_id = ? AND genre = 'login'", (login_id, user)).rowcount
    if not gone:
        raise HTTPException(404, "Identifiant introuvable")
    return {"ok": True}


# --- Réglages > Coffre : ce que la personne garde, à elle seule ---------------------------------------------------------

LUHN_BRANDS = (("4", "Visa"), ("5", "Mastercard"), ("2", "Mastercard"), ("34", "American Express"), ("37", "American Express"), ("6", "Discover"))


def _luhn(number: str) -> bool:
    total = 0
    for i, digit in enumerate(reversed(number)):
        n = int(digit) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def _brand(number: str) -> str:
    return next((name for prefix, name in sorted(LUHN_BRANDS, key=lambda p: -len(p[0])) if number.startswith(prefix)), "Carte")


def _preview(row) -> str:
    """Ce qui se montre sans preuve : jamais la valeur."""
    secret = _secret(row)
    if row["genre"] == "login":
        return _mask(secret.get("identifiant") or "")
    if row["genre"] == "carte":
        number = secret.get("numero") or ""
        return f"{_brand(number)} •••• {number[-4:]} · {secret.get('expiration') or ''}"
    return ""


def _public(row) -> dict:
    return {"id": row["id"], "genre": row["genre"], "nom": _label(row) if row["origine"] else (row["nom"] or ""), "site": site_of(row["origine"]) if row["origine"] else "",
            "origine": row["origine"], "apercu": _preview(row), "utilise_a": row["used_at"]}


def _totp_key(text: str) -> str:
    """Une clé d'authentificateur : la clé en base 32, ou l'adresse otpauth:// que montre le QR code."""
    text = text.strip()
    if text.lower().startswith("otpauth://"):
        text = (parse_qs(urlsplit(text).query).get("secret") or [""])[0]
    key = re.sub(r"[\s=-]", "", unquote(text)).upper()
    if not key or len(key) > 128 or not re.fullmatch(r"[A-Z2-7]+", key):
        raise ValueError("clé")
    totp_code(key)
    return key


def _validated(body: dict, genre: str, before: dict | None = None) -> tuple[str, str, dict]:
    """(nom, origine, secret) d'un élément, ou 400 avec la raison, jamais avec la valeur. `before` : on garde ce qui n'est pas changé."""
    before = before or {}
    name = _text(body, "nom", MAX_NAME).strip() if body.get("nom") is not None else before.get("_nom", "")
    if genre == "login":
        origin = origin_of(_text(body, "origine", 500)) if body.get("origine") is not None else before.get("_origine", "")
        if not origin:
            raise HTTPException(400, "Donne l'adresse du site (ex. https://www.instagram.com).")
        identifier = _text(body, "identifiant", MAX_IDENTIFIER).strip() if body.get("identifiant") is not None else before.get("identifiant", "")
        password = _text(body, "mot_de_passe", MAX_PASSWORD) or before.get("mot_de_passe", "")
        if not identifier:  # sans lui, l'élément ne sert à rien : chaque connexion le redemanderait
            raise HTTPException(400, "Saisis l'identifiant.")
        if not password:
            raise HTTPException(400, "Saisis le mot de passe.")
        return name, origin, {"identifiant": identifier, "mot_de_passe": password}
    if genre == "carte":
        number = re.sub(r"[\s-]", "", _text(body, "numero", 40)) or before.get("numero", "")
        if not re.fullmatch(r"\d{12,19}", number) or not _luhn(number):
            raise HTTPException(400, "Ce numéro de carte n'est pas valide.")
        expiry = _text(body, "expiration", 7).strip() or before.get("expiration", "")
        match = re.fullmatch(r"(0[1-9]|1[0-2])\s*/\s*(\d{2})", expiry)
        if not match:
            raise HTTPException(400, "Date d'expiration attendue sous la forme MM/AA.")
        holder = _text(body, "titulaire", 120).strip() if body.get("titulaire") is not None else before.get("titulaire", "")
        return name or _brand(number), "", {"numero": number, "expiration": f"{match.group(1)}/{match.group(2)}", "titulaire": holder}
    if genre == "totp":
        origin = origin_of(_text(body, "origine", 500)) if body.get("origine") is not None else before.get("_origine", "")
        if not origin:
            raise HTTPException(400, "Donne l'adresse du site (ex. https://www.instagram.com).")
        raw = _text(body, "cle", 512)
        try:
            key = _totp_key(raw) if raw else before.get("cle", "")
        except ValueError:
            raise HTTPException(400, "Cette clé d'authentificateur n'est pas valide.") from None
        if not key:
            raise HTTPException(400, "Cette clé d'authentificateur n'est pas valide.")
        return name, origin, {"cle": key}
    raise HTTPException(400, "Type inconnu : identifiant, carte ou clé d'authentificateur.")


def _mine(user: int, item_id: str):
    with db.connect() as c:
        row = c.execute("SELECT * FROM coffre WHERE id = ? AND user_id = ?", (item_id, user)).fetchone()
    if not row:
        raise HTTPException(404, "Élément introuvable")
    return row


@router.get("/api/coffre")
def my_vault(user: int = Depends(auth.current_user)):
    """Le coffre de la personne, sans aucune valeur, et ses agents avec leur droit."""
    with db.connect() as c:
        agents = c.execute("SELECT id, name FROM agents WHERE owner_id = ? ORDER BY name", (user,)).fetchall()
    return {"elements": [_public(r) for r in _items(user)],
            "agents": [{"id": a["id"], "nom": a["name"], "utiliser": may_use(a["id"]), "partage": _shared(a["id"])} for a in agents]}


@router.post("/api/coffre")
async def add_to_vault(request: Request, user: int = Depends(auth.current_user)):
    body = await _read_answer(request)
    genre = str(body.get("genre") or "")
    name, origin, secret = _validated(body, genre)
    with db.connect() as c:
        if c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ?", (user,)).fetchone()[0] >= MAX_ITEMS:
            raise HTTPException(409, "Ton coffre est plein.")
        item_id = f"{genre}_" + secrets.token_hex(8)
        c.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                  (item_id, user, genre, name, origin, db.seal(json.dumps(secret)), time.time()))
    return _public(_mine(user, item_id))


@router.put("/api/coffre/{item_id}")
async def change_in_vault(item_id: str, request: Request, user: int = Depends(auth.current_user)):
    """Modifier : un champ de secret laissé vide garde l'ancienne valeur, qui n'a donc jamais à revenir vers l'écran."""
    row = _mine(user, item_id)
    body = await _read_answer(request)
    name, origin, secret = _validated(body, row["genre"], {**_secret(row), "_origine": row["origine"], "_nom": row["nom"]})
    with db.connect() as c:
        c.execute("UPDATE coffre SET nom = ?, origine = ?, secret = ? WHERE id = ?", (name, origin, db.seal(json.dumps(secret)), item_id))
    _failed.pop(item_id, None)
    return _public(_mine(user, item_id))


@router.delete("/api/coffre/{item_id}")
def remove_from_vault(item_id: str, user: int = Depends(auth.current_user)):
    _mine(user, item_id)
    with db.connect() as c:
        c.execute("DELETE FROM coffre WHERE id = ? AND user_id = ?", (item_id, user))
    return {"ok": True}


@router.post("/api/coffre/{item_id}/voir")
async def reveal(item_id: str, request: Request, user: int = Depends(auth.current_user)):
    """Voir une valeur demande la preuve (mot de passe, et code si la double vérification est active), récente ou donnée ici."""
    row = _mine(user, item_id)
    body = await _read_answer(request)
    from . import main
    main._prove_if_needed(request, user, _text(body, "motdepasse", 256), _text(body, "code", 32), "Confirme ton mot de passe pour voir ce secret.")
    secret = _secret(row)
    if row["genre"] == "totp":
        try:
            code = totp_code(secret.get("cle", ""))
        except (ValueError, TypeError):  # binascii.Error en est une : une clé abîmée en base, sans la citer
            raise HTTPException(422, "Cette clé d'authentificateur est illisible : remplace-la.") from None
        return {"cle": secret.get("cle", ""), "code": code}
    return {k: v for k, v in secret.items() if k in ("identifiant", "mot_de_passe", "numero", "expiration", "titulaire")}


CSV_COLUMNS = {
    "origine": ("url", "login_uri", "login url", "website", "uri", "site", "web site", "address", "hostname"),
    "identifiant": ("username", "login_username", "login", "user", "email", "user name", "login name", "e-mail"),
    "mot_de_passe": ("password", "login_password", "pass"),
    "nom": ("name", "title", "nom"),
    "cle": ("totp", "login_totp", "otpauth", "otp", "one-time password", "2fa"),
}


@router.post("/api/coffre/import")
async def import_csv(request: Request, user: int = Depends(auth.current_user)):
    """Un export CSV de Chrome, Firefox, Bitwarden, 1Password… Chaque ligne refusée l'est avec son numéro et sa raison, jamais sa valeur."""
    body = await _read_answer(request, MAX_IMPORT)
    text = body.get("csv")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "Fichier vide.")
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    try:
        header = [h.strip().lower() for h in next(reader)]
    except (StopIteration, csv.Error):
        raise HTTPException(400, "Fichier illisible.") from None
    where = {field: next((header.index(n) for n in names if n in header), None) for field, names in CSV_COLUMNS.items()}
    if where["origine"] is None or where["mot_de_passe"] is None:
        raise HTTPException(400, "Colonnes introuvables : il faut au moins l'adresse du site et le mot de passe.")
    added = replaced = 0
    refused: list[dict] = []
    with db.connect() as c:
        count = c.execute("SELECT COUNT(*) FROM coffre WHERE user_id = ?", (user,)).fetchone()[0]
    known = {r["id"] for r in _items(user, "login")}
    line = 1
    try:
        for cells in reader:
            line = reader.line_num
            if not any(cell.strip() for cell in cells):
                continue
            if line > MAX_IMPORT_ROWS + 1:
                refused.append({"ligne": line, "raison": "Trop de lignes : le reste n'est pas lu."})
                break
            value = {field: (cells[i] if i is not None and i < len(cells) else "") for field, i in where.items()}
            origin = origin_of(value["origine"])
            if not origin:
                refused.append({"ligne": line, "raison": "Adresse du site manquante ou illisible."})
                continue
            if not value["mot_de_passe"]:
                refused.append({"ligne": line, "raison": "Mot de passe manquant."})
                continue
            if not value["identifiant"].strip():
                refused.append({"ligne": line, "raison": "Identifiant manquant."})
                continue
            if len(value["mot_de_passe"]) > MAX_PASSWORD or len(value["identifiant"]) > MAX_IDENTIFIER or len(value["nom"]) > 200:
                refused.append({"ligne": line, "raison": "Un champ est trop long."})
                continue
            if count >= MAX_ITEMS:
                refused.append({"ligne": line, "raison": "Ton coffre est plein."})
                continue
            handle = _remember(user, origin, value["identifiant"].strip(), value["mot_de_passe"])
            if not handle:
                refused.append({"ligne": line, "raison": "Ton coffre est plein."})
                continue
            if handle in known:
                replaced += 1
            else:
                known.add(handle)
                added += 1
                count += 1
                if value["nom"].strip():
                    with db.connect() as c:
                        c.execute("UPDATE coffre SET nom = ? WHERE id = ?", (value["nom"].strip()[:MAX_NAME], handle))
            if value["cle"].strip():
                try:
                    key = _totp_key(value["cle"])
                except ValueError:
                    refused.append({"ligne": line, "raison": "Identifiant ajouté, mais sa clé d'authentificateur n'est pas valide."})
                    continue
                with db.connect() as c:
                    c.execute("INSERT INTO coffre (id, user_id, genre, nom, origine, secret, created_at) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
                              ("totp_" + secrets.token_hex(8), user, value["nom"].strip()[:MAX_NAME], origin, db.seal(json.dumps({"cle": key})), time.time()))
                count += 1
    except csv.Error:
        refused.append({"ligne": line + 1, "raison": "Ligne illisible : le reste n'est pas lu."})
    return {"ajoutes": added, "remplaces": replaced, "refuses": refused}
