"""Outils au choix (G13) : l'utilisateur branche un serveur MCP par son adresse, depuis Détails → Connexions.

Sans OAuth, Hermes ne parle pas au serveur : il parle à Noah (/agent-api/mcp/<nom>), qui parle au serveur. C'est le même
schéma que le relais du modèle :
- le jeton reste chiffré ici, l'agent ne le reçoit jamais et une réponse qui le répéterait est masquée ;
- l'adresse est revérifiée et résolue à chaque requête, puis la connexion part vers l'adresse IP vérifiée : un nom qui
  change d'adresse après coup (rebinding) ne mène ni au réseau interne ni aux métadonnées du cloud ;
- le droit est appliqué ici en plus du plugin de garde : l'agent peut réécrire ses propres fichiers, pas cette base ;
- une panne devient un résultat d'outil lisible, et les outils déjà connus restent listés : le tour continue.

OAuth reprend le parcours d'Hermes (voir launcher/agent_admin.py) : Hermes garde lui-même ses jetons et se connecte en
direct. Le droit n'y est tenu que par le plugin de garde, et l'adresse n'est vérifiée qu'à l'ajout et aux relevés d'état.

Le droit vaut pour un serveur entier : `lire` (seuls les outils que le serveur déclare en lecture, readOnlyHint ; cette
déclaration vient du serveur), `agir` (tout, sans demander), `confirmer` (une lecture déclarée passe ; toute autre action attend l'accord de l'utilisateur).
"""
import asyncio
import contextvars
import hashlib
import ipaddress
import json
import re
import socket
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import access, auth, connexion, db, machine, relay

router = APIRouter()

PROTOCOL = "2025-06-18"
CONNECT_SECONDS = 6
LIST_SECONDS = 15
CALL_SECONDS = 120
HEALTH_SECONDS = 4
HEALTH_EVERY = 20  # secondes entre deux relevés d'état d'un même outil
MAX_BYTES = 5_000_000
GRANT_SECONDS = 120  # un accord donné sert une fois, juste après
NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,30}")
TOKEN = re.compile(r"[\x21-\x7e]{8,4096}")
SECRET_PARAM = re.compile(r"(token|secret|passw(or)?d|pwd|api[_-]?key|apikey|auth|key|sig|signature)$", re.I)
RESERVED = {"noah", "hermes", "relay"}
AGENT_URL = "http://noah-server:8080/agent-api/mcp"

# Toujours refusés : métadonnées du cloud et adresses de lien local, y compris leurs équivalents hors 169.254.0.0/16.
METADATA = tuple(ipaddress.ip_network(n) for n in (
    "169.254.0.0/16", "fe80::/10", "fd00:ec2::254/128", "100.100.100.200/32", "168.63.129.16/32", "192.0.0.192/32"))
# Acceptés seulement si le propriétaire a accepté le réseau : un serveur chez soi, un NAS, un réseau Tailscale.
PRIVATE = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"))
INTERNAL_NAMES = re.compile(r"(^|\.)(localhost|internal|local|localdomain|docker)$|^noah-|^host\.docker\.", re.I)


# Le réseau privé accepté est celui du propriétaire de l'installation : les agents des autres profils n'y entrent pas.
_private_ok = contextvars.ContextVar("mcp_private_ok", default=False)


def _scope(agent_id: str) -> None:
    _private_ok.set(access.is_owner(access.owner_of(agent_id)))


class Refused(Exception):
    """Adresse refusée : le message est pour l'utilisateur."""


class Down(Exception):
    """Serveur injoignable, ou réponse qui n'est pas du MCP : le message ne contient ni jeton ni détail réseau."""


class AuthNeeded(Exception):
    """Le serveur répond, et demande à s'authentifier."""


class SessionLost(Exception):
    """Le serveur a oublié la session MCP : il n'a rien exécuté, on en rouvre une."""


# --- Adresses -------------------------------------------------------------------------------------------------------

def internal_networks() -> list:
    """Le réseau Docker de Noah : celui de ses interfaces, lu dans le noyau (aucune plage supposée)."""
    found = []
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            fields = line.split()
            dest, mask = int(fields[1], 16), int(fields[7], 16)
            if dest and mask:  # la route par défaut (0.0.0.0/0) n'est pas un réseau local
                to_ip = lambda v: socket.inet_ntoa(v.to_bytes(4, "little"))  # noqa: E731
                found.append(ipaddress.ip_network(f"{to_ip(dest)}/{to_ip(mask)}", strict=False))
    except (OSError, ValueError, IndexError):
        pass
    try:
        for line in Path("/proc/net/if_inet6").read_text().splitlines():
            raw, _, prefix, scope, *_ = line.split()
            if scope == "00":  # adresse globale de cette interface
                found.append(ipaddress.ip_network(f"{ipaddress.ip_address(int(raw, 16))}/{int(prefix, 16)}", strict=False))
    except (OSError, ValueError):
        pass
    return found


def accepted_networks() -> list:
    return [ipaddress.ip_network(n) for n in json.loads(db.get_setting("mcp_reseaux") or "[]")]


def _unwrap(ip):
    """Une adresse IPv6 qui porte une IPv4 (mappée, 6to4, NAT64) est jugée sur l'IPv4."""
    if ip.version == 6:
        if ip.ipv4_mapped:
            return ip.ipv4_mapped
        if ip.sixtofour:
            return ip.sixtofour
        if ip in ipaddress.ip_network("64:ff9b::/96"):
            return ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
    return ip


def _inside(ip, networks) -> bool:
    return any(ip.version == n.version and ip in n for n in networks)


def _judge(ip, scheme: str) -> None:
    ip = _unwrap(ip)
    if _inside(ip, METADATA):
        raise Refused("Adresse refusée : elle mène aux métadonnées du cloud ou à un lien local.")
    if _inside(ip, internal_networks()):
        raise Refused("Adresse refusée : elle mène au réseau interne de Noah.")
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast:
        raise Refused("Adresse refusée : elle mène à la machine de Noah elle-même.")
    if _inside(ip, PRIVATE):
        if not _private_ok.get() or not _inside(ip, accepted_networks()):
            raise Refused("Adresse privée refusée : le propriétaire de ce Noah Agent doit d'abord accepter ce réseau.")
        return
    if not ip.is_global:
        raise Refused("Adresse refusée : elle ne mène pas à un serveur public.")
    if scheme != "https":
        raise Refused("Adresse en http refusée : il faut https, sauf sur un réseau privé accepté par le propriétaire.")


@dataclass
class Target:
    scheme: str
    host: str
    port: int
    path: str
    ip: str

    @property
    def pinned(self) -> str:
        ip = f"[{self.ip}]" if ":" in self.ip else self.ip
        return f"{self.scheme}://{ip}:{self.port}{self.path}"

    @property
    def host_header(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return host if self.port == {"https": 443, "http": 80}[self.scheme] else f"{host}:{self.port}"

    @property
    def extensions(self) -> dict:
        try:
            ipaddress.ip_address(self.host)
            return {}
        except ValueError:  # le certificat reste vérifié contre le nom demandé, pas contre l'adresse IP
            return {"sni_hostname": self.host}


def parse(url: str, for_source: bool = False):
    """Tout ce qui se juge sans le réseau. Rend l'adresse découpée. `for_source` : voir resolve."""
    url = url.strip()
    if "://" not in url or url.split("://", 1)[0].lower() not in ("https", "http"):
        raise Refused("Il faut une adresse https://… Une commande locale n'est pas acceptée : elle exécuterait du code téléchargé.")
    if re.search(r"[\s\\\x00-\x1f\x7f]", url):
        raise Refused("Adresse refusée : caractères interdits.")
    try:
        parts = urlsplit(url)
        port = parts.port or {"https": 443, "http": 80}[parts.scheme.lower()]
    except ValueError:
        raise Refused("Adresse illisible.") from None
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise Refused("Adresse refusée : pas d'identifiants dans l'adresse, mets le jeton dans le champ prévu.")
    if not for_source and any(SECRET_PARAM.search(k) for k, _ in parse_qsl(parts.query, keep_blank_values=True)):
        raise Refused("Adresse refusée : pas de clé ni de jeton dans l'adresse, mets-le dans le champ prévu.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise Refused("Adresse illisible : il manque le nom du serveur.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if "." not in host or INTERNAL_NAMES.search(host):
            raise Refused("Adresse refusée : ce nom désigne le réseau interne de Noah.") from None
    return parts, host, port


async def resolve(url: str, for_source: bool = False) -> Target:
    """Vérifie l'adresse après résolution DNS : toutes les adresses du nom doivent passer. `for_source` : une page lue sans
    jeton (veille) : http public et paramètres d'adresse permis, mêmes réseaux interdits."""
    parts, host, port = parse(url, for_source)
    scheme = parts.scheme.lower()
    try:
        infos = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM), 5)
    except (OSError, UnicodeError, asyncio.TimeoutError):
        raise Down("Ce nom de serveur n'existe pas ou ne se résout pas.") from None
    addresses = list(dict.fromkeys(i[4][0].split("%")[0] for i in infos))
    if not addresses:
        raise Down("Ce nom de serveur ne se résout pas.")
    for a in addresses:
        _judge(ipaddress.ip_address(a), "https" if for_source else scheme)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return Target(scheme, host, port, path, addresses[0])


# --- Client MCP (HTTP) ----------------------------------------------------------------------------------------------

def _why(exc: Exception) -> str:
    """Jamais le texte brut de l'exception : il peut citer une adresse interne ou un en-tête."""
    if isinstance(exc, httpx.TimeoutException):
        return "délai dépassé"
    if isinstance(exc, httpx.ConnectError):
        return "certificat refusé" if "CERTIFICATE" in str(exc).upper() else "connexion impossible"
    return "connexion coupée"


async def _read_sse(response, wanted):
    """Réponse en flux : on lit jusqu'au message qui répond à notre requête."""
    data, size = [], 0
    async for line in response.aiter_lines():
        size += len(line)
        if size > MAX_BYTES:
            raise Down("réponse trop longue")
        if line.startswith("data:"):
            data.append(line[5:].strip())
        elif not line.strip() and data:
            try:
                message = json.loads("\n".join(data))
            except ValueError:
                raise Down("réponse illisible") from None
            data = []
            if isinstance(message, dict) and message.get("id") == wanted:
                return message
    raise Down("réponse incomplète")


async def _post(url: str, token: str | None, payload: dict, session: str | None, seconds: float):
    """Le délai d'httpx ne limite que le silence : un serveur qui envoie des lignes vides ne doit pas tenir l'appel ouvert."""
    try:
        async with asyncio.timeout(seconds + CONNECT_SECONDS):
            return await _post_once(url, token, payload, session, seconds)
    except TimeoutError:
        raise Down("le serveur ne finit pas de répondre") from None


async def _post_once(url: str, token: str | None, payload: dict, session: str | None, seconds: float):
    target = await resolve(url)  # à chaque requête : un nom peut avoir changé d'adresse depuis l'ajout
    headers = {"Host": target.host_header, "Accept": "application/json, text/event-stream",
               "Content-Type": "application/json", "MCP-Protocol-Version": PROTOCOL}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if session:
        headers["Mcp-Session-Id"] = session
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(seconds, connect=CONNECT_SECONDS),
                                     follow_redirects=False, trust_env=False) as c:
            async with c.stream("POST", target.pinned, headers=headers, content=json.dumps(payload).encode(),
                                extensions=target.extensions) as r:
                if r.status_code in (401, 403):
                    raise AuthNeeded()
                if r.status_code == 404 and session:
                    raise SessionLost()
                if 300 <= r.status_code < 400:  # une redirection pourrait mener n'importe où : jamais suivie
                    raise Down("le serveur redirige ailleurs")
                if r.status_code >= 400:
                    raise Down(f"le serveur répond {r.status_code}")
                sid = r.headers.get("mcp-session-id") or session
                if r.status_code == 202 or "id" not in payload:
                    return None, sid
                if "text/event-stream" in r.headers.get("content-type", ""):
                    return await _read_sse(r, payload["id"]), sid
                body, size = bytearray(), 0
                async for chunk in r.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise Down("réponse trop longue")
                    body += chunk
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        raise Down(_why(e)) from None
    try:
        message = json.loads(bytes(body))
    except ValueError:
        raise Down("ce serveur ne parle pas MCP") from None
    if not isinstance(message, dict):
        raise Down("ce serveur ne parle pas MCP")
    return message, sid


_sessions: dict[tuple, str | None] = {}


async def _open(url: str, token: str | None) -> str | None:
    hello = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "noah-agent", "version": "1"}}}
    message, sid = await _post(url, token, hello, None, LIST_SECONDS)
    if "result" not in message:
        raise Down("ce serveur ne parle pas MCP")
    await _post(url, token, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid, LIST_SECONDS)
    return sid


async def _request(key: tuple, url: str, token: str | None, method: str, params: dict, seconds: float) -> dict:
    if key not in _sessions:
        _sessions[key] = await _open(url, token)
    payload = {"jsonrpc": "2.0", "id": 2, "method": method, "params": params}
    try:
        message, sid = await _post(url, token, payload, _sessions[key], seconds)
    except SessionLost:
        _sessions[key] = await _open(url, token)
        message, sid = await _post(url, token, payload, _sessions[key], seconds)
    except (Down, AuthNeeded, Refused):
        _sessions.pop(key, None)
        raise
    _sessions[key] = sid
    return message


async def list_tools(key: tuple, url: str, token: str | None, seconds: float = LIST_SECONDS) -> list[dict]:
    tools, cursor = [], None
    for _ in range(10):  # 10 pages au plus : un serveur ne fait pas tourner Noah en boucle
        message = await _request(key, url, token, "tools/list", {"cursor": cursor} if cursor else {}, seconds)
        result = message.get("result")
        if not isinstance(result, dict):
            raise Down("ce serveur ne donne pas la liste de ses outils")
        tools += [t for t in result.get("tools") or [] if isinstance(t, dict) and isinstance(t.get("name"), str)]
        cursor = result.get("nextCursor")
        if not cursor:
            break
    return tools[:500]


def _is_read_only(tool: dict) -> bool:
    annotations = tool.get("annotations")
    return isinstance(annotations, dict) and annotations.get("readOnlyHint") is True


def _public_tools(tools: list[dict]) -> list[dict]:
    return [{"nom": t["name"], "description": str(t.get("description") or "")[:300], "lecture_seule": _is_read_only(t)} for t in tools]


def _scrub(value, token: str | None):
    """Un serveur qui répète le jeton dans sa réponse (erreur, écho) ne le fait arriver ni à l'agent ni à l'écran."""
    if not token:
        return value
    return json.loads(json.dumps(value).replace(json.dumps(token)[1:-1], "[jeton masqué]"))


# --- Base ---------------------------------------------------------------------------------------------------------

def _row(agent_id: str, name: str):
    with db.connect() as c:
        return c.execute("SELECT * FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, name)).fetchone()


def _rows(agent_id: str) -> list:
    with db.connect() as c:
        return c.execute("SELECT * FROM mcp_tools WHERE agent_id = ? ORDER BY created_at, nom", (agent_id,)).fetchall()


def outbound(agent_id: str) -> list[dict]:
    """Les outils branchés sur cet agent et leur adresse, pour la liste de ce qui sort du serveur. Jamais le jeton."""
    return [{"nom": r["nom"], "url": r["url"]} for r in _rows(agent_id)]


def _token(row) -> str | None:
    return db.unseal(row["jeton"]) if row["jeton"] else None


def _note(agent_id: str, name: str, etat: str, erreur: str = "", outils: list | None = None) -> None:
    with db.connect() as c:
        if outils is not None:
            c.execute("UPDATE mcp_tools SET outils = ? WHERE agent_id = ? AND nom = ?",
                      (json.dumps(outils, ensure_ascii=False), agent_id, name))
        c.execute("UPDATE mcp_tools SET etat = ?, erreur = ?, vu_a = ? WHERE agent_id = ? AND nom = ?",
                  (etat, erreur, time.time(), agent_id, name))


def _rights(agent_id: str) -> dict[str, str]:
    return {r["nom"]: r["droit"] for r in _rows(agent_id)}


async def seal_rights(agent_id: str) -> None:
    """Un conteneur recréé a perdu ses droits : ils redeviennent ceux choisis ici. Sans lanceur, un droit absent vaut « confirmer »."""
    try:
        await machine.admin(agent_id, "outil_droits", {"droits": _rights(agent_id)})
    except HTTPException as e:
        print(f"[outils] droits non écrits pour {agent_id} : {e.detail}", flush=True)


def _name_from(url: str) -> str:
    """mcp.notion.com → notion ; api.exemple.fr → exemple."""
    _, host, _ = parse(url)
    try:
        ipaddress.ip_address(host)
        return "outil-" + re.sub(r"[^a-z0-9]+", "-", host).strip("-")[:24]
    except ValueError:
        pass
    words = [w for w in host.split(".")[:-1] if w not in ("www", "mcp", "api", "app", "server", "tools")]
    return re.sub(r"[^a-z0-9-]+", "-", (words[-1] if words else host.split(".")[0])).strip("-")[:31] or "outil"


class NewTool(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    nom: str = Field(default="", max_length=31)
    auth: str = Field(default="aucune", pattern="^(aucune|jeton|oauth)$")
    jeton: str = Field(default="", max_length=4096)
    droit: str = Field(default="confirmer", pattern="^(lire|agir|confirmer)$")


def _clean_token(body: NewTool) -> str | None:
    if body.auth != "jeton":
        return None
    token = body.jeton.strip().removeprefix("Bearer ").strip()
    if not TOKEN.fullmatch(token):
        raise HTTPException(400, "Ce jeton n'a pas la bonne forme : colle-le en entier, sans espace.")
    return token


def _require_https(url: str) -> None:
    if urlsplit(url.strip()).scheme.lower() != "https":
        raise Refused("OAuth demande une adresse en https.")


async def _try(body: NewTool, token: str | None) -> dict:
    """Le test de connexion. Rien n'est enregistré ; le jeton ne sert qu'à cet essai."""
    try:
        parse(body.url)
        if body.auth == "oauth":
            _require_https(body.url)
        key = ("essai", object())
        try:
            tools = await list_tools(key, body.url.strip(), token)
        finally:
            _sessions.pop(key, None)
        return {"outils": _scrub(tools, token), "oauth": False}
    except Refused as e:
        raise HTTPException(400, str(e)) from None
    except Down as e:
        raise HTTPException(502, f"Connexion impossible : {_scrub(str(e), token)}. Rien n'a été enregistré.") from None
    except AuthNeeded:
        if body.auth == "oauth":
            return {"outils": [], "oauth": True}
        if body.auth == "jeton":
            raise HTTPException(400, "Ce serveur refuse ce jeton. Rien n'a été enregistré.") from None
        raise HTTPException(400, "Ce serveur demande une authentification : choisis Jeton ou OAuth.") from None


def _agent_config(agent_id: str, name: str) -> dict:
    """Hermes parle à Noah, pas au serveur : ni le jeton ni l'adresse réelle n'arrivent dans l'agent."""
    return {"url": f"{AGENT_URL}/{name}", "headers": {"Authorization": f"Bearer {relay.token_for(agent_id)}"},
            "timeout": CALL_SECONDS + 10, "connect_timeout": 15, "sampling": {"enabled": False}}


def _oauth_config(url: str) -> dict:
    return {"url": url, "auth": "oauth", "timeout": CALL_SECONDS + 10, "connect_timeout": 30, "sampling": {"enabled": False}}


# --- Routes de l'interface -------------------------------------------------------------------------------------------

@router.post("/api/agents/{agent_id}/connections/tools/test")
async def test_tool(agent_id: str, body: NewTool, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    _scope(agent_id)
    found = await _try(body, _clean_token(body))
    try:
        name = body.nom.strip().lower() or _name_from(body.url)
    except Refused as e:
        raise HTTPException(400, str(e)) from None
    return {"nom": name, "oauth": found["oauth"], "outils": _public_tools(found["outils"])}


@router.post("/api/agents/{agent_id}/connections/tools")
async def add_tool(agent_id: str, body: NewTool, request: Request, user: int = Depends(auth.current_user)):
    """Enregistre seulement ce qui vient de passer le test. Un outil OAuth rend l'adresse d'autorisation d'Hermes."""
    access.access(user, agent_id, "admin")
    _scope(agent_id)
    machine.forget_connections(agent_id)
    token = _clean_token(body)
    found = await _try(body, token)
    try:
        name = body.nom.strip().lower() or _name_from(body.url)
    except Refused as e:
        raise HTTPException(400, str(e)) from None
    if not NAME.fullmatch(name) or name in RESERVED:
        raise HTTPException(400, "Nom refusé : lettres minuscules, chiffres et tirets seulement.")
    if _row(agent_id, name):
        raise HTTPException(400, f"Un outil s'appelle déjà « {name} ».")
    oauth = found["oauth"]
    url = body.url.strip()
    kind = "oauth" if oauth else ("jeton" if token else "aucune")
    with db.connect() as c:
        c.execute("INSERT INTO mcp_tools (agent_id, nom, url, auth, jeton, droit, outils, etat, vu_a) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  (agent_id, name, url, kind, db.seal(token) if token else None, body.droit,
                   json.dumps(found["outils"], ensure_ascii=False), "a_connecter" if oauth else "ok", time.time()))
    try:
        out = await machine.admin(agent_id, "outil_poser", {
            "nom": name, "config": _oauth_config(url) if oauth else _agent_config(agent_id, name), "droits": _rights(agent_id),
            "retour": connexion.callback_url(request)})
        connexion.expect(out, agent_id, name, lambda adresse: _finish_tool(agent_id, name, adresse), connexion.from_app(request), user)
    except Exception:
        with db.connect() as c:
            c.execute("DELETE FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, name))
        raise
    if not oauth:
        tell_agent(agent_id, name, found["outils"])
    return {"nom": name, "outils": _public_tools(found["outils"]), **{k: out[k] for k in ("adresse", "retour") if k in out}}


def tell_agent(agent_id: str, name: str, tools: list[dict]) -> None:
    """Hermes relit ses outils environ chaque minute : sans ce mot, l'agent répond tout de suite qu'il n'a pas cet outil.
    Les noms viennent du serveur de l'outil : on ne garde que ceux qui ne peuvent rien dire d'autre qu'un nom."""
    machine.forget_connections(agent_id)
    names = [t["nom"] for t in tools if re.fullmatch(r"[\w.-]{1,64}", t.get("nom") or "")][:20]
    what = f" ({', '.join(names)})" if names else ""
    note = (f"[L'utilisateur vient de connecter l'outil « {name} »{what}. Il arrive dans tes outils en moins "
            "d'une minute. S'il n'y est pas encore, dis qu'il arrive et cherche-le de nouveau : ne dis pas qu'il n'existe pas.]\n\n")
    with db.connect() as c:
        conversations = c.execute("SELECT id FROM conversations WHERE agent_id = ? AND main = 1", (agent_id,)).fetchall()
    for row in conversations:
        machine.add_context(row["id"], note)


class ToolRight(BaseModel):
    droit: str = Field(pattern="^(lire|agir|confirmer)$")


@router.put("/api/agents/{agent_id}/connections/tools/{name}/droit")
async def set_right(agent_id: str, name: str, body: ToolRight, user: int = Depends(auth.current_user)):
    """Vaut aussi pour une application du catalogue : elle entre dans la table à son premier droit."""
    machine.forget_connections(agent_id)
    access.access(user, agent_id, "admin")
    row = _row(agent_id, name)
    if not row:
        installed = (await machine.admin(agent_id, "applications")).get("applications") or []
        if not any(a.get("nom") == name and a.get("installe") for a in installed):
            raise HTTPException(404, "Cet outil n'existe pas sur cet agent")
        with db.connect() as c:
            c.execute("INSERT INTO mcp_tools (agent_id, nom, auth, droit) VALUES (?, ?, 'catalogue', ?)", (agent_id, name, body.droit))
    before = row["droit"] if row else None
    with db.connect() as c:
        c.execute("UPDATE mcp_tools SET droit = ? WHERE agent_id = ? AND nom = ?", (body.droit, agent_id, name))
    try:
        await machine.admin(agent_id, "outil_droits", {"droits": _rights(agent_id)})
    except Exception:  # agent arrêté : le droit affiché reste celui que le plugin applique
        with db.connect() as c:
            if before:
                c.execute("UPDATE mcp_tools SET droit = ? WHERE agent_id = ? AND nom = ?", (before, agent_id, name))
            else:
                c.execute("DELETE FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, name))
        raise
    if (before == "lire") != (body.droit == "lire"):
        _tell_tools_changed(agent_id, name, body.droit)
    return {"droit": body.droit}


class ToolFinish(BaseModel):
    adresse: str = Field(default="", max_length=4000)


@router.post("/api/agents/{agent_id}/connections/tools/{name}/{action}")
async def tool_action(agent_id: str, name: str, action: str, request: Request, body: ToolFinish | None = None, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    row = _row(agent_id, name)
    if not row or row["auth"] == "catalogue":
        raise HTTPException(404, "Cet outil n'existe pas sur cet agent")
    if action == "remove":
        await machine.admin(agent_id, "outil_retirer", {"nom": name, "droits": {k: v for k, v in _rights(agent_id).items() if k != name}})
        forget(agent_id, name)
        return {"connecte": False}
    if row["auth"] != "oauth":
        raise HTTPException(400, "Action inconnue")
    if action == "connect":
        out = await machine.admin(agent_id, "outil_connecter", {"nom": name, "retour": connexion.callback_url(request)})
        connexion.expect(out, agent_id, name, lambda adresse: _finish_tool(agent_id, name, adresse), connexion.from_app(request), user)
        return out
    if action == "finish":
        if not body or not body.adresse.strip():
            raise HTTPException(400, "Adresse de retour manquante")
        return await _finish_tool(agent_id, name, body.adresse)
    raise HTTPException(400, "Action inconnue")


async def _finish_tool(agent_id: str, name: str, adresse: str) -> dict:
    out = await machine.admin(agent_id, "outil_finir", {"nom": name, "adresse": adresse})
    _note(agent_id, name, "ok", "", out.get("outils"))
    tell_agent(agent_id, name, out.get("outils") or [])
    return {"connecte": True, "outils": _public_tools(out.get("outils") or [])}


def forget(agent_id: str, name: str) -> None:
    machine.forget_connections(agent_id)
    with db.connect() as c:
        c.execute("DELETE FROM mcp_tools WHERE agent_id = ? AND nom = ?", (agent_id, name))
    _sessions.pop((agent_id, name), None)


class Networks(BaseModel):
    reseaux: list[str] = Field(max_length=20)


@router.get("/api/mcp/reseaux")
async def get_networks(user: int = Depends(access.owner_only)):
    return {"reseaux": [str(n) for n in accepted_networks()]}


@router.put("/api/mcp/reseaux")
async def set_networks(body: Networks, user: int = Depends(access.owner_only)):
    """Les réseaux privés où un outil peut vivre. Seul le propriétaire les accepte : c'est son réseau."""
    out = []
    for text in body.reseaux:
        try:
            net = ipaddress.ip_network(text.strip(), strict=False)
        except ValueError:
            raise HTTPException(400, f"Réseau illisible : {text[:50]}") from None
        if not any(net.version == p.version and net.subnet_of(p) for p in PRIVATE):
            raise HTTPException(400, f"{net} n'est pas un réseau privé.")
        if any(net.version == i.version and net.overlaps(i) for i in internal_networks()):
            raise HTTPException(400, f"{net} touche le réseau interne de Noah.")
        out.append(str(net))
    db.set_setting("mcp_reseaux", json.dumps(out))
    return {"reseaux": out}


# --- État, lu par Détails → Connexions ---------------------------------------------------------------------------------

_MESSAGES = {"a_connecter": "Connexion à terminer.", "jeton_refuse": "Ce serveur refuse le jeton enregistré."}


async def _health(row) -> dict:
    """Relevé court, au plus toutes les 20 s par outil. Un serveur qui demande à s'authentifier répond : il est là."""
    agent_id, name, kind = row["agent_id"], row["nom"], row["auth"]
    if row["vu_a"] and time.time() - row["vu_a"] < HEALTH_EVERY and row["etat"]:
        return {"etat": row["etat"], "erreur": row["erreur"] or ""}
    token, tools, etat, erreur = _token(row), None, "ok", ""
    try:
        if kind == "oauth":  # Hermes se connecte lui-même : ici on vérifie seulement que le serveur répond
            await asyncio.wait_for(_post(row["url"], None, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, None, HEALTH_SECONDS), HEALTH_SECONDS)
        else:
            tools = _scrub(await asyncio.wait_for(list_tools((agent_id, name), row["url"], token, HEALTH_SECONDS), HEALTH_SECONDS), token)
    except AuthNeeded:
        if kind != "oauth":
            etat, erreur = "jeton_refuse" if token else "a_connecter", _MESSAGES["jeton_refuse" if token else "a_connecter"]
    except Refused as e:
        etat, erreur = "refuse", str(e)
    except (Down, SessionLost, TimeoutError) as e:
        etat, erreur = "injoignable", f"Injoignable : {_scrub(str(e), token) or 'pas de réponse'}."
    _note(agent_id, name, etat, erreur, tools)
    return {"etat": etat, "erreur": erreur}


async def connections_state(agent_id: str, apps: list[dict], personal: dict) -> dict:
    """Les droits et l'état de ce qui est branché. Jamais le jeton : seulement s'il y en a un."""
    _scope(agent_id)
    rows = {r["nom"]: r for r in _rows(agent_id)}
    mine = [r for r in rows.values() if r["auth"] != "catalogue"]
    healths = await asyncio.gather(*(_health(r) for r in mine))
    tools = []
    for row, health in zip(mine, healths):
        fresh = _row(agent_id, row["nom"])
        connected = row["auth"] != "oauth" or bool(personal.get(row["nom"], {}).get("connecte"))
        etat = health["etat"]
        if row["auth"] == "oauth" and not connected and etat == "ok":
            etat = "a_connecter"
        tools.append({"nom": row["nom"], "url": row["url"], "auth": row["auth"], "jeton": bool(row["jeton"]), "droit": row["droit"],
                      "etat": etat, "erreur": health["erreur"] or _MESSAGES.get(etat, ""), "connecte": connected,
                      "outils": _public_tools(json.loads(fresh["outils"] or "[]"))})
    installed = [a for a in apps if a.get("installe")]

    async def reach(app: dict) -> dict:
        if not app.get("url"):
            return {"etat": "ok", "erreur": ""}
        try:
            await asyncio.wait_for(_post(app["url"], None, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, None, HEALTH_SECONDS), HEALTH_SECONDS)
        except AuthNeeded:
            pass
        except Refused as e:
            return {"etat": "refuse", "erreur": str(e)}
        except (Down, SessionLost, TimeoutError) as e:
            return {"etat": "injoignable", "erreur": f"Injoignable : {e or 'pas de réponse'}."}
        return {"etat": "ok", "erreur": ""}

    for app, health in zip(installed, await asyncio.gather(*(reach(a) for a in installed))):
        app.update(health)
    for app in apps:
        app.pop("url", None)
        row = rows.get(app.get("nom"))
        app["droit"] = row["droit"] if row else "confirmer"
    return {"outils": tools}


# --- Confirmation : l'accord donné dans la conversation ouvre un seul appel ------------------------------------------

# Le plugin de garde écrit ce début dans la demande d'accord d'Hermes ; c'est ce qui relie l'accord au serveur.
ASKED = re.compile(r"^Outil « ([a-z0-9-]{1,31}) » : ")
_asked: dict[tuple[str, str], tuple[str, str, float]] = {}  # (serveur, ce qui a été montré à la personne, quand)
_grants: dict[tuple[str, str], list[tuple]] = {}  # (échéance, ce qui a été montré, identifiant)


# La demande telle que la personne la lit : une phrase, et ce que l'action enverrait. Le texte brut reste pour les détails techniques.
# Dans l'ordre : un outil dont le nom dit « lire et supprimer » se présente comme une suppression.
_ACTIONS = (
    ("supprimer", {"delete", "remove", "trash", "cancel", "destroy", "archive", "supprimer", "supprime", "effacer", "efface"}, "supprimer quelque chose dans {}"),
    ("envoyer", {"send", "post", "publish", "reply", "share", "envoyer", "envoie", "publier", "publie"}, "envoyer quelque chose avec {}"),
    ("modifier", {"update", "edit", "set", "patch", "move", "rename", "modify", "change", "resolve", "modifier", "modifie", "changer"}, "modifier quelque chose dans {}"),
    ("créer", {"create", "add", "new", "insert", "upload", "duplicate", "write", "creer", "cree", "ajouter", "ajoute", "ecrire"}, "créer quelque chose dans {}"),
    ("consulter", {"search", "find", "query", "list", "get", "fetch", "read", "view", "lire", "chercher", "cherche"}, "consulter {}"),
)
_HIDDEN = {"intent", "feedback", "skill", "id", "url", "mode", "type", "operator", "property", "propertyType", "instructions_version", "sort", "direction"}
_TECHNICAL = re.compile(r"^(?:[a-z][a-z0-9+.-]*://|[0-9a-f-]{32,36}$|select\s)", re.I)
_PAIR = re.compile(r'"([^"\\]+)":\s*"((?:[^"\\]|\\.)*)"')


def _preview(shown: str) -> list[str]:
    """Ce que l'action écrirait, en texte : le titre, le contenu. Lu dans le texte montré, même coupé. Rien d'autre que du texte."""
    found: list[str] = []
    for key, raw in _PAIR.findall(shown):
        if key in _HIDDEN or key.endswith(("_id", "_url")):
            continue
        try:
            text = " ".join(str(json.loads(f'"{raw}"')).split())
        except ValueError:
            continue
        if len(text) >= 2 and not _TECHNICAL.match(text) and text[:140] not in found:
            found.append(text[:140])
    return found[:3]


def plain_request(summary: str, command: bool = False) -> dict:
    """{demande, apercu} : ce qu'une personne sans notion technique lit pour décider."""
    m = ASKED.match(summary)
    if not m:
        first = summary.split("\n")[0][:200]
        plain = "Ton agent veut lancer une commande sensible sur sa machine." if command else first
        return {"demande": plain if plain and not plain.startswith(("{", "[")) else "Ton agent te demande de valider une action.", "apercu": []}
    app = m.group(1).replace("-", " ").title()
    tool, _, shown = summary[m.end():].partition("\n")
    words = set(re.split(r"[_\W]+", tool.lower()))
    wish = f"utiliser {app}"
    for action, verbs, sentence in _ACTIONS:
        if words & verbs:
            wish = sentence.format(app)
            break
    plain = f"Ton agent veut {wish}."
    return {"demande": plain, "apercu": _preview(shown)}


def _shown(tool: str, args) -> str:
    """Ce que le plugin de garde montre à la personne : un accord ne vaut que pour cela."""
    text = json.dumps(args, ensure_ascii=False, default=str)
    if len(text) <= 600:
        return f"{tool}\n{text}"
    return f"{tool}\n{text[:600]}… [empreinte {hashlib.sha256(text.encode()).hexdigest()[:16]}]"


def approval_seen(agent_id: str, request_id: str | None, summary: str) -> None:
    m = ASKED.match(str(summary or ""))
    if m and request_id:
        now = time.time()
        for key in [k for k, (_, _, at) in _asked.items() if now - at > 3600]:
            _asked.pop(key, None)
        _asked[(agent_id, str(request_id))] = (m.group(1), str(summary)[m.end():], now)


def approval_answered(agent_id: str, request_id: str, approve: bool) -> tuple | None:
    """À appeler avant de répondre à Hermes : l'appel part dès qu'il a la réponse. Rend la clé de l'accord ouvert."""
    asked = _asked.pop((agent_id, str(request_id)), None)
    if not asked or not approve:
        return None
    key = (agent_id, asked[0])
    grant = (time.time() + GRANT_SECONDS, asked[1], uuid.uuid4().hex)
    _grants.setdefault(key, []).append(grant)
    return key, grant


def approval_failed(opened: tuple | None) -> None:
    """Hermes n'a pas reçu la réponse : cet accord-là ne sert pas, celui d'un appel concurrent reste."""
    if opened and opened[1] in _grants.get(opened[0], []):
        _grants[opened[0]].remove(opened[1])


def _take_grant(agent_id: str, name: str, what: str) -> bool:
    """Consomme l'accord donné pour cet appel précis, et aucun autre : un appel concurrent ne peut pas passer à sa place."""
    now = time.time()
    left = [g for g in _grants.get((agent_id, name), []) if g[0] > now]
    match = next((g for g in left if g[1] == what), None)
    if match:
        left.remove(match)
    _grants[(agent_id, name)] = left
    return match is not None


# --- Ce que voit Hermes : un serveur MCP sans état, en JSON ---------------------------------------------------------

def _rpc(msg_id, result=None, error: tuple[int, str] | None = None) -> JSONResponse:
    if error:
        return JSONResponse({"jsonrpc": "2.0", "id": msg_id, "error": {"code": error[0], "message": error[1]}})
    return JSONResponse({"jsonrpc": "2.0", "id": msg_id, "result": result})


def _tool_error(msg_id, text: str) -> JSONResponse:
    """Une erreur d'outil, pas de protocole : l'agent la lit et continue son tour."""
    return _rpc(msg_id, {"isError": True, "content": [{"type": "text", "text": text}]})


def _outage_text(name: str, why: str) -> str:
    return (f"L'outil « {name} » est injoignable en ce moment ({why}). Dis-le à l'utilisateur, continue le reste de la "
            "tâche sans cet outil et ne réessaie pas en boucle. Si le délai est dépassé, l'action a pu partir : vérifie "
            "avant de la refaire.")


def _gate(row, tool: str, args=None) -> str | None:
    """Le droit, tenu ici quoi que dise le plugin de garde dans la machine de l'agent. Rend la raison du refus."""
    name = row["nom"]
    if row["droit"] == "agir":
        return None
    known = {t["name"]: t for t in json.loads(row["outils"] or "[]")}
    if tool in known and _is_read_only(known[tool]):  # lire ne change rien : ni accord à demander, ni routine bloquée
        return None
    if row["droit"] == "lire":
        return (f"Refusé : « {name} » est en lecture seule sur cet agent et « {tool} » n'est pas déclaré en lecture. "
                "Dis-le à l'utilisateur ; il peut changer ce droit dans Détails → Connexions.")
    if _take_grant(row["agent_id"], name, _shown(tool, args if args is not None else {})):
        return None
    return (f"Refusé : « {name} » demande la confirmation de l'utilisateur pour cette action et elle n'a pas été donnée. "
            "Dans une routine personne ne peut l'accorder : pour s'en servir là, il doit passer ce droit à « agir » dans "
            "Détails → Connexions. Dis-le-lui et continue sans cet outil.")


# Le droit « lire » cache les outils d'écriture. Hermes garde sa liste tant que le serveur reste connecté : le flux MCP lui dit
# de la redemander, sans lui retirer l'outil un seul instant.
STREAM_ALIVE = 25  # secondes entre deux signes de vie du flux
_listening: dict[tuple[str, str], set[asyncio.Queue]] = {}
TOOLS_CHANGED = json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})


def _tell_tools_changed(agent_id: str, name: str, droit: str) -> None:
    for queue in _listening.get((agent_id, name), ()):
        queue.put_nowait(TOOLS_CHANGED)
    note = (f"[L'utilisateur vient de changer son droit sur l'outil « {name} » : {droit}. Ce que tu as dit plus tôt sur ce qu'il "
            "permet n'est peut-être plus vrai : regarde de nouveau avant de répondre.]\n\n")
    with db.connect() as c:
        conversations = c.execute("SELECT id FROM conversations WHERE agent_id = ? AND main = 1", (agent_id,)).fetchall()
    for row in conversations:
        machine.add_context(row["id"], note)


@router.get("/agent-api/mcp/{name}")
async def proxy_stream(name: str, request: Request):
    agent_id = relay._agent_from(request)
    if "mcp-session-id" not in request.headers:  # la sonde d'Hermes, qui attendrait la fin d'un flux sans fin
        return Response(status_code=405, headers={"Allow": "POST"})
    row = _row(agent_id, name)
    if not row or row["auth"] not in ("aucune", "jeton"):
        raise HTTPException(404, "Outil inconnu")
    key, queue = (agent_id, name), asyncio.Queue()
    _listening.setdefault(key, set()).add(queue)

    async def events():
        try:
            while True:
                try:
                    yield f"event: message\ndata: {await asyncio.wait_for(queue.get(), STREAM_ALIVE)}\n\n"
                except TimeoutError:
                    yield ": vivant\n\n"
        finally:
            _listening[key].discard(queue)

    return StreamingResponse(events(), media_type="text/event-stream")


@router.delete("/agent-api/mcp/{name}")
async def proxy_end(name: str, request: Request):
    relay._agent_from(request)
    return Response(status_code=405, headers={"Allow": "GET, POST"})  # pas de session à fermer côté Noah


@router.post("/agent-api/mcp/{name}")
async def proxy(name: str, request: Request):
    agent_id = relay._agent_from(request)
    _scope(agent_id)
    row = _row(agent_id, name)
    if not row or row["auth"] not in ("aucune", "jeton"):
        raise HTTPException(404, "Outil inconnu")
    raw = await request.body()
    if len(raw) > MAX_BYTES:
        return _rpc(None, error=(-32600, "Requête trop longue"))
    try:
        msg = json.loads(raw)
    except ValueError:
        return _rpc(None, error=(-32700, "JSON illisible"))
    if not isinstance(msg, dict):
        return _rpc(None, error=(-32600, "Un seul message à la fois"))
    method, msg_id = msg.get("method"), msg.get("id")
    if "id" not in msg:  # notification : rien à répondre
        return Response(status_code=202)
    if method == "initialize":  # répondu ici : un serveur en panne au démarrage de l'agent ne lui retire pas l'outil
        version = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
        answer = _rpc(msg_id, {"protocolVersion": version, "capabilities": {"tools": {"listChanged": True}},
                               "serverInfo": {"name": f"noah-{name}", "version": "1"}})
        answer.headers["Mcp-Session-Id"] = uuid.uuid4().hex  # le client MCP n'ouvre le flux qu'avec une session
        return answer
    if method == "ping":
        return _rpc(msg_id, {})
    token, key = _token(row), (agent_id, name)
    if method == "tools/list":
        tools = json.loads(row["outils"] or "[]")
        try:  # avec une liste connue, une panne ne fait pas attendre le démarrage d'une session d'Hermes
            tools = _scrub(await asyncio.wait_for(list_tools(key, row["url"], token), HEALTH_SECONDS if tools else LIST_SECONDS), token)
            _note(agent_id, name, "ok", "", tools)
        except (Down, Refused, AuthNeeded, SessionLost, TimeoutError) as e:
            _note(agent_id, name, *_failure(e, token))
        if row["droit"] == "lire":
            tools = [t for t in tools if _is_read_only(t)]
        return _rpc(msg_id, {"tools": tools})
    if method != "tools/call":
        return _rpc(msg_id, error=(-32601, "Méthode non prise en charge"))
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    tool = str(params.get("name") or "")
    refusal = _gate(row, tool, params.get("arguments"))
    if refusal:
        return _tool_error(msg_id, refusal)
    try:
        answer = _scrub(await _request(key, row["url"], token, "tools/call", params, CALL_SECONDS), token)
    except (Down, Refused, AuthNeeded, SessionLost) as e:
        etat, erreur = _failure(e, token)
        _note(agent_id, name, etat, erreur)
        return _tool_error(msg_id, _outage_text(name, erreur.rstrip(".")))
    _note(agent_id, name, "ok")
    if "error" in answer:
        detail = answer["error"].get("message") if isinstance(answer["error"], dict) else ""
        return _tool_error(msg_id, f"L'outil « {name} » a refusé cet appel : {str(detail)[:500]}")
    return _rpc(msg_id, answer.get("result"))


def _failure(e: Exception, token: str | None) -> tuple[str, str]:
    if isinstance(e, AuthNeeded):
        return ("jeton_refuse", _MESSAGES["jeton_refuse"]) if token else ("a_connecter", "Ce serveur demande maintenant une authentification.")
    if isinstance(e, Refused):
        return "refuse", str(e)
    return "injoignable", f"Injoignable : {_scrub(str(e), token) or 'pas de réponse'}."
