"""Publier avec l'API de la plateforme, quand elle existe et que la personne l'a connectée. Le navigateur de l'agent reste le chemin de tout le reste.

Chaque plateforme se présente à l'agent comme un outil MCP branché : même droit (lire, confirmer, agir), même carte d'accord, même relais
(mcp.py). Le jeton reste ici, chiffré : il n'entre jamais dans la machine de l'agent, et aucune réponse ne le répète.

Un post part une seule fois. Son empreinte (texte et contenu des images) est notée avant l'appel : le même post est refusé pendant 24 h, avec
l'adresse s'il est en ligne. Si la réponse se perd au moment de publier, personne ne peut savoir s'il est parti : seule une demande explicite le
relance, et cette demande passe de nouveau par l'accord.

Sources : developers.facebook.com/docs/instagram-platform/content-publishing et docs.x.com (x-api/posts/create-post,
x-api/media/quickstart/media-upload-chunked, fundamentals/authentication/oauth-2-0/authorization-code).
"""
import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Response

from . import db, hermes, public

router = APIRouter()

# httpx écrit chaque adresse dans le journal, et Instagram veut son jeton dans l'adresse pour le renouveler.
for _logger in ("httpx", "httpcore"):
    logging.getLogger(_logger).setLevel(logging.WARNING)

SCHEME = "noah://"
INSTAGRAM, X = "instagram", "x"
HOSTS = {INSTAGRAM: "https://graph.instagram.com", X: "https://api.x.com"}
IG_API = f"{HOSTS[INSTAGRAM]}/v27.0"
X_API = f"{HOSTS[X]}/2"
X_AUTHORIZE = "https://x.com/i/oauth2/authorize"
X_SCOPES = "tweet.read tweet.write users.read media.write offline.access"
SECONDS = 30
IG_READY_SECONDS = 90  # pour un conteneur d'image ; au-delà, l'agent et la personne attendent pour rien
IG_READY_EVERY = 3
IG_REFRESH_AFTER = 20 * 86400  # un jeton vit 60 jours et se renouvelle tant qu'il n'a pas expiré
IG_REFRESH_RETRY = 3600
IG_MAX_IMAGES, IG_MAX_BYTES, IG_MAX_CAPTION = 20, 8_000_000, 2200
X_MAX_IMAGES, X_MAX_BYTES = 4, 5_000_000
X_READY_SECONDS = 60
X_READY_FACTOR = 1
ALREADY_SECONDS = 86400
RUNNING_SECONDS = 600
IMAGE_SECONDS = 600
RETRY_NOTE = "Ne le relance que si la personne le confirme, avec republier à true."

_images: dict[str, tuple[bytes, float]] = {}  # adresse à usage court -> image JPEG, le temps que la plateforme vienne la chercher
_locks: dict[tuple[str, str], asyncio.Lock] = {}
_refresh_failed: dict[tuple[str, str], float] = {}


class Refused(Exception):
    """La plateforme ou Noah refuse : le message est pour l'agent, et rien n'est parti."""


class Uncertain(Exception):
    """La réponse s'est perdue pendant la publication elle-même : le post est peut-être en ligne."""


class TokenRefused(Exception):
    """Le compte n'est plus connecté : la personne doit le reconnecter."""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=SECONDS)


def ours(url: str | None) -> bool:
    return bool(url) and url.startswith(SCHEME)


def real_url(url: str) -> str:
    """L'adresse réelle, pour la liste de ce qui sort du serveur."""
    return HOSTS.get(url.removeprefix(SCHEME), url) if ours(url) else url


def tool_url(platform: str) -> str:
    return f"{SCHEME}{platform}"


def account_of(token: str | None) -> str:
    """Le nom du compte connecté. Rien d'autre du jeton ne sort d'ici."""
    try:
        return str(json.loads(token or "{}").get("compte") or "")
    except ValueError:
        return ""


# --- Ce que voit l'agent -----------------------------------------------------------------------------------------------

def _tool(name: str, description: str, properties: dict, required: list[str], read_only: bool = False) -> dict:
    tool = {"name": name, "description": description, "inputSchema": {"type": "object", "properties": properties, "required": required}}
    if read_only:
        tool["annotations"] = {"readOnlyHint": True}
    return tool


_AGAIN = {"republier": {"type": "boolean", "description": "Seulement si la personne confirme de relancer un post dont l'envoi est resté incertain, ou de republier le même post."}}
_ACCOUNT = _tool("compte", "Le compte connecté, et ce qu'il peut encore publier aujourd'hui quand la plateforme le dit.", {}, [], read_only=True)
TOOLS = {
    INSTAGRAM: [
        _tool("publier_post", "Publie un post (une image) ou un carrousel (2 à 20 images, dans l'ordre donné) sur Instagram et rend son adresse. "
              "Images en JPEG, déjà créées dans l'espace de travail. Le recadrage de tout le carrousel suit la première image.",
              {"images": {"type": "array", "items": {"type": "string"}, "description": "Chemins des fichiers JPEG dans /opt/data/workspace"},
               "legende": {"type": "string", "description": "Légende complète, avec ses mots-clés"}, **_AGAIN}, ["images", "legende"]),
        _tool("derniers_posts", "Les derniers posts du compte, avec leur adresse : pour vérifier ce qui est déjà en ligne.",
              {"nombre": {"type": "integer", "description": "1 à 25"}}, [], read_only=True),
        _ACCOUNT,
    ],
    X: [
        _tool("publier_post", "Publie un post sur X, avec jusqu'à 4 images, et rend son adresse.",
              {"texte": {"type": "string", "description": "Le texte complet du post"},
               "images": {"type": "array", "items": {"type": "string"}, "description": "Chemins des images (JPEG, PNG, WebP) dans /opt/data/workspace"}, **_AGAIN}, ["texte"]),
        _ACCOUNT,
    ],
}


def _text(text: str, error: bool = False) -> dict:
    return {"result": {"isError": error, "content": [{"type": "text", "text": text}]}}


async def request(agent_id: str, url: str, token: str | None, method: str, params: dict) -> dict:
    """Répond comme un serveur MCP. Le relais (mcp.py) a déjà tenu le droit et l'accord."""
    platform = url.removeprefix(SCHEME)
    if platform not in TOOLS or not token:
        raise TokenRefused()
    if method == "tools/list":
        if platform == INSTAGRAM:  # la liste est relue souvent : le jeton se renouvelle sans tâche de plus, tant que l'agent tourne
            await _instagram_token(agent_id, _creds(token))
        return {"result": {"tools": TOOLS[platform]}}
    if method != "tools/call":
        return {"error": {"code": -32601, "message": "Méthode non prise en charge"}}
    creds = _creds(token)
    name, args = params.get("name"), params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
    try:
        if name == "compte":
            return _text(json.dumps(await _account(agent_id, platform, creds), ensure_ascii=False))
        if name == "derniers_posts" and platform == INSTAGRAM:
            return _text(json.dumps(await _instagram_recent(agent_id, creds, args.get("nombre")), ensure_ascii=False))
        if name == "publier_post":
            return await _publish(agent_id, platform, creds, args)
        return _text(f"Outil inconnu : {str(name)[:60]}", True)
    except Refused as e:
        return _text(_clean(str(e), creds), True)
    except httpx.HTTPError:
        return _text(f"{platform.capitalize()} ne répond pas pour le moment. Rien n'est parti : réessaie plus tard, ou passe par le navigateur.", True)


def _creds(token: str) -> dict:
    try:
        return json.loads(token)
    except ValueError:
        raise TokenRefused() from None


def _clean(text: str, creds: dict) -> str:
    for key in ("jeton", "renouvellement"):
        if creds.get(key):
            text = text.replace(creds[key], "[jeton masqué]")
    return text[:800]


def _save(agent_id: str, platform: str, creds: dict, was: str) -> None:
    """Après un renouvellement. Le compte a pu être retiré ou remplacé pendant l'appel : on n'écrase jamais un autre jeton que celui qu'on a renouvelé."""
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT jeton FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, platform)).fetchone()
        if not row or not row["jeton"] or json.loads(db.unseal(row["jeton"])).get("jeton") != was:
            raise TokenRefused()
        c.execute("UPDATE mcp_tools SET jeton = ? WHERE agent_id = ? AND nom = ?", (db.seal(json.dumps(creds)), agent_id, platform))


async def _account(agent_id: str, platform: str, creds: dict) -> dict:
    out = {"plateforme": platform, "compte": creds.get("compte")}
    if platform == INSTAGRAM:
        token = await _instagram_token(agent_id, creds)
        async with _client() as c:
            r = await c.get(f"{IG_API}/{creds['id']}/content_publishing_limit", params={"fields": "quota_usage,config"}, headers=_bearer(token))
        data = _instagram_answer(r).get("data") or [{}]
        out |= {"publies_sur_24h": data[0].get("quota_usage"), "limite": (data[0].get("config") or {}).get("quota_total")}
    return out


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --- Une seule fois ----------------------------------------------------------------------------------------------------

async def _files(agent_id: str, paths, most: int, biggest: int) -> list[bytes]:
    if not isinstance(paths, list) or not all(isinstance(p, str) and p for p in paths):
        raise Refused("images doit être une liste de chemins de fichiers.")
    if len(paths) > most:
        raise Refused(f"{len(paths)} images : cette plateforme en prend {most} au plus par post. Rien n'est parti.")
    out = []
    for path in paths:
        r = await hermes.read_file(agent_id, path)
        if r.status_code != 200:
            raise Refused(f"Fichier introuvable dans ton espace de travail : {path}. Rien n'est parti.")
        if len(r.content) > biggest:
            raise Refused(f"{path} pèse {len(r.content) // 1_000_000} Mo : {biggest // 1_000_000} Mo au plus. Réduis-le, puis relance. Rien n'est parti.")
        out.append(r.content)
    return out


def _print_of(platform: str, account: str, text: str, files: list[bytes]) -> str:
    """Le même post sur le même compte : le même contenu sur un autre compte est un autre post."""
    h = hashlib.sha256(f"{platform}\0{account}\0{text}".encode())
    for data in files:
        h.update(hashlib.sha256(data).digest())
    return h.hexdigest()


def _claim(agent_id: str, platform: str, mark: str, again: bool) -> int:
    """Note la tentative avant tout appel et rend son numéro. Deux appels simultanés du même post : le second est refusé."""
    now = time.time()
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute("DELETE FROM publications WHERE at <= ?", (now - ALREADY_SECONDS,))  # passé ce délai, plus rien ne s'en sert
        row = c.execute("SELECT * FROM publications WHERE plateforme = ? AND empreinte = ? AND at > ? AND etat != 'refuse' "
                        "ORDER BY at DESC LIMIT 1", (platform, mark, now - ALREADY_SECONDS)).fetchone()  # l'empreinte porte le compte : deux agents sur un compte, un seul post
        if row and row["etat"] == "en_cours" and now - row["at"] < RUNNING_SECONDS:
            raise Refused("Ce même post est déjà en cours d'envoi. Attends sa réponse, ne le relance pas.")
        if row and not again:
            if row["etat"] == "publie":
                raise Refused(f"Ce même post est déjà en ligne : {row['lien'] or 'adresse non connue'}. Rien n'a été republié. {RETRY_NOTE}")
            raise Refused(f"L'envoi de ce même post est resté incertain : il est peut-être en ligne. Regarde le compte avant tout. {RETRY_NOTE}")
        return c.execute("INSERT INTO publications (agent_id, plateforme, empreinte, etat, at) VALUES (?, ?, ?, 'en_cours', ?)", (agent_id, platform, mark, now)).lastrowid


def _close(attempt: int, etat: str, link: str = "") -> None:
    with db.connect() as c:
        c.execute("UPDATE publications SET etat = ?, lien = ? WHERE id = ?", (etat, link, attempt))


async def _publish(agent_id: str, platform: str, creds: dict, args: dict) -> dict:
    instagram = platform == INSTAGRAM
    text = args.get("legende" if instagram else "texte")
    if not isinstance(text, str) or (not instagram and not text.strip()):
        raise Refused("Le texte du post manque. Rien n'est parti.")
    if instagram and len(text) > IG_MAX_CAPTION:
        raise Refused(f"Légende de {len(text)} caractères : {IG_MAX_CAPTION} au plus. Raccourcis-la. Rien n'est parti.")
    paths = args.get("images") or []
    if instagram and not paths:
        raise Refused("Instagram demande au moins une image. Rien n'est parti.")
    files = await _files(agent_id, paths, *((IG_MAX_IMAGES, IG_MAX_BYTES) if instagram else (X_MAX_IMAGES, X_MAX_BYTES)))
    if instagram:
        for path, data in zip(paths, files):
            if not data.startswith(b"\xff\xd8\xff"):
                raise Refused(f"{path} n'est pas un JPEG, le seul format qu'accepte l'API d'Instagram. Convertis-le, puis relance. Rien n'est parti.")
    attempt = _claim(agent_id, platform, _print_of(platform, str(creds.get("id") or creds.get("compte") or ""), text, files), args.get("republier") is True)
    try:
        link = await (_instagram_post if instagram else _x_post)(agent_id, creds, text, files)
    except Uncertain as e:
        _close(attempt, "incertain")
        return _text(f"{e} Le post est peut-être en ligne : regarde le compte avant tout. {RETRY_NOTE}", True)
    except (Refused, httpx.HTTPError, TokenRefused):
        _close(attempt, "refuse")
        raise
    except BaseException:  # interrompu en plein travail : on ne sait pas où il en était
        _close(attempt, "incertain")
        raise
    _close(attempt, "publie", link)
    if not link:
        return _text(json.dumps({"publie": True, "adresse": None, "a_faire": "Le post est en ligne, mais son adresse n'a pas pu être lue. Cherche-la avec derniers_posts, sans republier."}, ensure_ascii=False))
    return _text(json.dumps({"publie": True, "adresse": link}, ensure_ascii=False))


# --- Instagram ---------------------------------------------------------------------------------------------------------

def _instagram_answer(r: httpx.Response) -> dict:
    try:
        data = r.json()
    except ValueError:
        data = {}
    error = data.get("error") if isinstance(data, dict) else None
    if r.status_code >= 400 or error:
        error = error if isinstance(error, dict) else {}
        if error.get("code") == 190 or r.status_code == 401:
            raise TokenRefused()
        detail = error.get("error_user_msg") or error.get("message") or f"erreur {r.status_code}"
        raise Refused(f"Instagram refuse : {detail}. Rien n'est parti. Corrige ce qu'il dit, ou passe par le navigateur.")
    return data


async def instagram_check(token: str) -> dict:
    """Le jeton collé par la personne : rend ce qu'il faut garder, ou lève TokenRefused."""
    async with _client() as c:
        r = await c.get(f"{IG_API}/me", params={"fields": "user_id,username"}, headers=_bearer(token))
    data = _instagram_answer(r)
    found = data.get("user_id") or data.get("id")
    if not found:
        raise TokenRefused()
    return {"jeton": token, "id": str(found), "compte": str(data.get("username") or ""), "renouvele": time.time()}


async def _instagram_token(agent_id: str, creds: dict) -> str:
    """Renouvelle bien avant les 60 jours. Un échec ne bloque rien : le jeton actuel marche encore, on réessaiera dans une heure."""
    now, key = time.time(), (agent_id, INSTAGRAM)
    if now - creds.get("renouvele", 0) < IG_REFRESH_AFTER or now - _refresh_failed.get(key, 0) < IG_REFRESH_RETRY:
        return creds["jeton"]
    async with _locks.setdefault(key, asyncio.Lock()):
        with db.connect() as c:
            row = c.execute("SELECT jeton FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, INSTAGRAM)).fetchone()
        if row and row["jeton"]:  # un appel concurrent l'a peut-être déjà renouvelé ; un autre compte n'est pas ce post
            stored = json.loads(db.unseal(row["jeton"]))
            if stored.get("id") != creds.get("id"):
                raise TokenRefused()
            creds.update(stored)
        if time.time() - creds.get("renouvele", 0) < IG_REFRESH_AFTER or now - _refresh_failed.get(key, 0) < IG_REFRESH_RETRY:
            return creds["jeton"]
        try:
            async with _client() as c:
                r = await c.get(f"{HOSTS[INSTAGRAM]}/refresh_access_token", params={"grant_type": "ig_refresh_token", "access_token": creds["jeton"]})
            fresh = r.json().get("access_token") if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            fresh = None
        if not fresh:
            _refresh_failed[key] = now
            return creds["jeton"]
        was = creds["jeton"]
        creds.update(jeton=fresh, renouvele=now)
        _save(agent_id, INSTAGRAM, creds, was)
    return creds["jeton"]


def _share(data: bytes) -> str:
    """Instagram vient chercher l'image lui-même : une adresse impossible à deviner, qui ne vit que quelques minutes."""
    base = public.main_url()
    if not base:
        raise Refused("L'API d'Instagram doit venir chercher les images sur une adresse publique, et ce Noah n'en a pas. Passe par le navigateur. Rien n'est parti.")
    now = time.time()
    for key in [k for k, (_, end) in _images.items() if end < now]:
        _images.pop(key, None)
    key = secrets.token_urlsafe(32)
    _images[key] = (data, now + IMAGE_SECONDS)
    return f"{base}/api/post-image/{key}.jpg"


@router.get("/api/post-image/{name}")
def shared_image(name: str):
    """Sans session : seule l'adresse tirée au hasard y mène, et elle disparaît après la publication."""
    found = _images.get(name.removesuffix(".jpg"))
    if not found or found[1] < time.time():
        raise HTTPException(404, "Introuvable")
    return Response(found[0], media_type="image/jpeg", headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex"})


async def _instagram_post(agent_id: str, creds: dict, caption: str, files: list[bytes]) -> str:
    token = await _instagram_token(agent_id, creds)
    urls = [_share(data) for data in files]
    media_url, headers = f"{IG_API}/{creds['id']}/media", _bearer(token)
    try:
        async with _client() as c:
            async def container(body: dict) -> str:
                return str(_instagram_answer(await c.post(media_url, json=body, headers=headers))["id"])

            async def ready(wanted: str) -> None:
                ended = time.monotonic() + IG_READY_SECONDS
                while True:
                    state = _instagram_answer(await c.get(f"{IG_API}/{wanted}", params={"fields": "status_code,status"}, headers=headers))
                    code = state.get("status_code")
                    if code in ("FINISHED", None):
                        return
                    if code in ("ERROR", "EXPIRED"):
                        raise Refused(f"Instagram refuse cette image : {state.get('status') or code}. Rien n'est parti. Change l'image (JPEG, ratio entre 4:5 et 1,91:1), ou passe par le navigateur.")
                    if time.monotonic() > ended:
                        raise Refused("Instagram n'a pas fini de lire les images à temps. Rien n'est parti : réessaie plus tard.")
                    await asyncio.sleep(IG_READY_EVERY)

            if len(urls) == 1:
                final = await container({"image_url": urls[0], "caption": caption})
            else:
                children = [await container({"image_url": u, "is_carousel_item": True}) for u in urls]
                await asyncio.gather(*(ready(child) for child in children))
                final = await container({"media_type": "CAROUSEL", "children": ",".join(children), "caption": caption})
            await ready(final)
            try:
                r = await c.post(f"{IG_API}/{creds['id']}/media_publish", json={"creation_id": final}, headers=headers)
            except httpx.HTTPError:
                raise Uncertain("La réponse d'Instagram s'est perdue pendant la publication.") from None
            if r.status_code >= 500:  # une passerelle en panne ne prouve pas que rien n'est parti
                raise Uncertain(f"Instagram a répondu par une panne ({r.status_code}) pendant la publication.")
            published = str(_instagram_answer(r).get("id") or "")
            if not published:
                raise Uncertain("Instagram n'a pas rendu l'identifiant du post.")
            try:
                link = _instagram_answer(await c.get(f"{IG_API}/{published}", params={"fields": "permalink"}, headers=headers)).get("permalink")
            except (httpx.HTTPError, Refused, TokenRefused):
                link = None  # il est en ligne : seule son adresse manque
            return str(link or "")
    finally:
        for url in urls:
            _images.pop(url.rsplit("/", 1)[-1].removesuffix(".jpg"), None)


async def _instagram_recent(agent_id: str, creds: dict, count) -> list[dict]:
    token = await _instagram_token(agent_id, creds)
    limit = max(1, min(count if isinstance(count, int) else 10, 25))
    async with _client() as c:
        r = await c.get(f"{IG_API}/{creds['id']}/media", params={"fields": "caption,permalink,timestamp,media_type", "limit": limit}, headers=_bearer(token))
    return [{"adresse": m.get("permalink"), "date": m.get("timestamp"), "type": m.get("media_type"), "legende": str(m.get("caption") or "")[:200]}
            for m in _instagram_answer(r).get("data") or []]


# --- X -----------------------------------------------------------------------------------------------------------------

def x_start(client_id: str, callback: str) -> tuple[str, str]:
    """L'adresse d'accord et le secret PKCE, gardé ici jusqu'au retour."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": callback, "scope": X_SCOPES,
                       "state": secrets.token_urlsafe(32), "code_challenge": challenge, "code_challenge_method": "S256"})
    return f"{X_AUTHORIZE}?{query}", verifier


def _x_answer(r: httpx.Response) -> dict:
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code == 401:
        raise TokenRefused()
    if r.status_code >= 400:
        detail = data.get("detail") or data.get("title") if isinstance(data, dict) else ""
        hint = {402: "Le crédit du compte développeur X est épuisé.", 429: "Limite de X atteinte pour le moment."}.get(r.status_code, "")
        raise Refused(f"X refuse ({r.status_code}) : {' '.join(filter(None, (hint, str(detail or ''))))}. Rien n'est parti. Corrige ce qu'il dit, ou passe par le navigateur.")
    return data if isinstance(data, dict) else {}


def _x_tokens(creds: dict, data: dict) -> None:
    creds.update(jeton=data["access_token"], renouvellement=data.get("refresh_token") or creds.get("renouvellement"),
                 expire=time.time() + float(data.get("expires_in") or 7200))


async def x_finish(client_id: str, callback: str, verifier: str, query: str) -> dict:
    """Le retour de X, avec son code : rend ce qu'il faut garder."""
    code = (parse_qs(urlsplit(query).query).get("code") or [""])[0]
    if not code:
        raise TokenRefused()
    async with _client() as c:
        r = await c.post(f"{X_API}/oauth2/token", data={"code": code, "grant_type": "authorization_code", "client_id": client_id,
                                                         "redirect_uri": callback, "code_verifier": verifier})
        data = _x_answer(r)
        if not data.get("access_token"):
            raise TokenRefused()
        creds = {"client": client_id}
        _x_tokens(creds, data)
        me = _x_answer(await c.get(f"{X_API}/users/me", headers=_bearer(creds["jeton"]))).get("data") or {}
    creds |= {"compte": str(me.get("username") or ""), "id": str(me.get("id") or "")}
    return creds


async def _x_token(agent_id: str, creds: dict) -> str:
    """Le jeton vit deux heures ; le renouvellement change à chaque usage, donc un seul à la fois, et il est gardé tout de suite."""
    if time.time() < creds.get("expire", 0) - 60:
        return creds["jeton"]
    async with _locks.setdefault((agent_id, X), asyncio.Lock()):
        with db.connect() as c:
            row = c.execute("SELECT jeton FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, X)).fetchone()
        if row and row["jeton"]:  # un appel concurrent l'a peut-être déjà renouvelé ; un autre compte n'est pas ce post
            stored = json.loads(db.unseal(row["jeton"]))
            if stored.get("id") != creds.get("id"):
                raise TokenRefused()
            creds.update(stored)
        if time.time() < creds.get("expire", 0) - 60:
            return creds["jeton"]
        if not creds.get("renouvellement"):
            raise TokenRefused()
        async with _client() as c:
            r = await c.post(f"{X_API}/oauth2/token", data={"refresh_token": creds["renouvellement"], "grant_type": "refresh_token", "client_id": creds["client"]})
        if r.status_code in (400, 401):
            raise TokenRefused()
        was = creds["jeton"]
        _x_tokens(creds, _x_answer(r))
        _save(agent_id, X, creds, was)
    return creds["jeton"]


X_TYPES = ((b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG", "image/png"))


def _x_type(data: bytes) -> str:
    for head, kind in X_TYPES:
        if data.startswith(head):
            return kind
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise Refused("X prend des images JPEG, PNG ou WebP. Convertis ce fichier, puis relance. Rien n'est parti.")


async def _x_media_ready(c: httpx.AsyncClient, media: str, answer: dict, headers: dict) -> None:
    """X peut traiter une image après sa réception : un post qui la cite trop tôt est refusé."""
    ended = time.monotonic() + X_READY_SECONDS
    info = (answer.get("data") or {}).get("processing_info") or {}
    while info and info.get("state") not in ("succeeded", None):
        if info.get("state") == "failed":
            raise Refused("X n'a pas pu traiter cette image. Rien n'est parti. Change-la, ou passe par le navigateur.")
        if time.monotonic() > ended:
            raise Refused("X n'a pas fini de traiter l'image à temps. Rien n'est parti : réessaie plus tard.")
        await asyncio.sleep(min(float(info.get("check_after_secs") or 1), 5) * X_READY_FACTOR)
        r = await c.get(f"{X_API}/media/upload", params={"command": "STATUS", "media_id": media}, headers=headers)
        info = (_x_answer(r).get("data") or {}).get("processing_info") or {}


async def _x_post(agent_id: str, creds: dict, text: str, files: list[bytes]) -> str:
    kinds = [_x_type(data) for data in files]
    headers = _bearer(await _x_token(agent_id, creds))
    async with _client() as c:
        ids = []
        for data, kind in zip(files, kinds):
            r = await c.post(f"{X_API}/media/upload/initialize", json={"media_type": kind, "total_bytes": len(data), "media_category": "tweet_image"}, headers=headers)
            media = str((_x_answer(r).get("data") or {}).get("id") or "")
            if not media:
                raise Refused("X n'a pas accepté cette image. Rien n'est parti.")
            _x_answer(await c.post(f"{X_API}/media/upload/{media}/append", data={"segment_index": "0"}, files={"media": ("image", data, kind)}, headers=headers))
            await _x_media_ready(c, media, _x_answer(await c.post(f"{X_API}/media/upload/{media}/finalize", headers=headers)), headers)
            ids.append(media)
        body: dict = {"text": text}
        if ids:
            body["media"] = {"media_ids": ids}
        try:
            r = await c.post(f"{X_API}/tweets", json=body, headers=headers)
        except httpx.HTTPError:
            raise Uncertain("La réponse de X s'est perdue pendant la publication.") from None
        if r.status_code >= 500:
            raise Uncertain(f"X a répondu par une panne ({r.status_code}) pendant la publication.")
        post = str((_x_answer(r).get("data") or {}).get("id") or "")
    if not post:
        raise Uncertain("X n'a pas rendu l'identifiant du post.")
    return f"https://x.com/{creds.get('compte') or 'i'}/status/{post}"
