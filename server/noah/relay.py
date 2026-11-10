"""Relais de modèle : les agents appellent le serveur, jamais le fournisseur directement.

- La clé du fournisseur reste chiffrée dans le serveur ; chaque agent n'a qu'un jeton de relais.
- Chaque appel est mesuré (jetons, coût) et refusé quand le budget mensuel est atteint, ou le plafond du jour de
  l'agent : prévenu sur le téléphone à 80 %, arrêté à 100 % (les plaintes de coûts OpenClaw en contre-exemple).
- Tous les fournisseurs passent par leur point d'accès compatible OpenAI.
"""
import hashlib
import hmac
import ipaddress
import json
import re
import socket
import time
from contextvars import ContextVar
from datetime import datetime, time as dtime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import catalog, db
from .config import SECRET_KEY

router = APIRouter()

UPSTREAMS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "ollama": "http://host.docker.internal:11434/v1",
    "ollama-cloud": "https://ollama.com/v1",
    "mammouth": "https://api.mammouth.ai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com/v1",
}
# Ces fournisseurs acceptent une adresse choisie par l'utilisateur. Aucun prix connu : leur coût reste à 0.
OWN_URL = {"ollama", "custom"}
# URL que les agents utilisent, sur le réseau Docker interne.
RELAY_URL = "http://noah-server:8080/relay/v1"


# Un seul client pour tous les appels au fournisseur : la connexion TLS reste ouverte d'un appel à l'autre
# (un run avec outils en fait plusieurs ; sans ça, chacun repaie la négociation).
_client: httpx.AsyncClient | None = None


def upstream_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=8),
                                    limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=120))
    return _client


def upstream_base(provider: str, base_url: str | None = None) -> str:
    """Adresse de l'API OpenAI du fournisseur, sans « / » final. Vide si le fournisseur demande une adresse et n'en a pas."""
    if provider in OWN_URL and base_url:
        base = base_url.rstrip("/")
        # Ollama : « http://machine:11434 » est ce qu'on saisit, et l'API compatible OpenAI est sous /v1.
        return base + "/v1" if provider == "ollama" and not base.endswith("/v1") else base
    return UPSTREAMS.get(provider, "")


def token_for(agent_id: str) -> str:
    return hmac.new(SECRET_KEY.encode(), f"relay:{agent_id}".encode(), hashlib.sha256).hexdigest()


def _routes() -> tuple[list, str | None]:
    """Les réseaux Docker de ce conteneur et leur passerelle, lus dans le noyau."""
    networks, gateway = [], None
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            fields = line.split()
            to_ip = lambda v: socket.inet_ntoa(int(v, 16).to_bytes(4, "little"))  # noqa: E731
            if fields[1] == "00000000":
                gateway = to_ip(fields[2])
            else:
                networks.append(ipaddress.ip_network(f"{to_ip(fields[1])}/{to_ip(fields[7])}", strict=False))
    except (OSError, ValueError, IndexError):
        pass
    return networks, gateway


def _from_outside(request: Request) -> bool:
    """Tout ce qui entre par un port publié semble venir de la passerelle, ou garde sa vraie adresse (Linux, réseau local)."""
    if "x-forwarded-for" in request.headers:
        return True
    host = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False  # client de test, sans adresse
    networks, gateway = _routes()
    if address.is_loopback or not networks:
        return False
    return host == gateway or not any(address in n for n in networks)


def _agent_from(request: Request) -> str:
    # Un agent parle à Noah par le réseau Docker. Un jeton affiché par un agent à une personne ne sert à rien depuis dehors :
    # elle reprendrait la main sur les collègues et les fonds de l'agent, même après la fin de son partage.
    if _from_outside(request):
        raise HTTPException(403, "Réservé aux agents")
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    with db.connect() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM agents")]
    for agent_id in ids:
        if hmac.compare_digest(token.encode(), token_for(agent_id).encode()):
            return agent_id
    raise HTTPException(401, "Jeton de relais invalide")


def month_cost() -> float:
    with db.connect() as c:
        row = c.execute(
            "SELECT COALESCE(SUM(cost), 0) AS total FROM usage WHERE created_at >= ?", (month_start(),)
        ).fetchone()
    return float(row["total"])


def budget() -> float | None:
    value = db.get_setting("budget_monthly")
    return float(value) if value else None


def profile_cost(user: int) -> float:
    with db.connect() as c:
        row = c.execute("SELECT COALESCE(SUM(cost), 0) AS total FROM usage WHERE owner_id = ? AND created_at >= ?",
                        (user, month_start())).fetchone()
    return float(row["total"])


def profile_budget(user: int | None) -> float | None:
    with db.connect() as c:
        row = c.execute("SELECT budget_monthly FROM users WHERE id = ?", (user,)).fetchone()
    return row["budget_monthly"] if row else None


# Qui paie une dépense sans agent (voix, routeur de médias) : le compte de la requête en cours.
payer: ContextVar[int | None] = ContextVar("payer", default=None)


def billed_to(agent_id: str) -> int | None:
    """Une dépense compte pour le propriétaire de l'agent, même quand un profil partagé lui parle."""
    return db.agent_owner(agent_id) or payer.get() or db.owner_id()


def profile_refusal(agent_id: str) -> str | None:
    """Message de refus si le profil qui paie pour cet agent a atteint son plafond du mois."""
    user = billed_to(agent_id)
    limit = profile_budget(user)
    if limit is not None and profile_cost(user) >= limit:
        return f"Budget mensuel de ce profil ({limit:.2f} $) atteint. Le propriétaire de Noah Agent peut l'augmenter."
    return None


def daily_cap(agent_id: str) -> float | None:
    """Plafond du jour de cet agent : le sien s'il en a un, sinon celui de tous les agents. None : pas de plafond."""
    value = db.get_setting(f"budget_daily:{agent_id}") or db.get_setting("budget_daily")
    return float(value) if value else None


def _day_start() -> str:
    """Minuit chez l'utilisateur, en UTC au format de created_at (CURRENT_TIMESTAMP de SQLite)."""
    from . import updates
    zone = updates.local_zone()
    midnight = datetime.combine(datetime.now(zone).date(), dtime(0), zone)
    return midnight.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def day_cost(agent_id: str) -> float:
    with db.connect() as c:
        row = c.execute("SELECT COALESCE(SUM(cost), 0) AS total FROM usage WHERE agent_id = ? AND created_at >= ?",
                        (agent_id, _day_start())).fetchone()
    return float(row["total"])


def day_refusal(agent_id: str) -> str | None:
    """Message de refus si cet agent a atteint son plafond du jour : le relais du modèle, et tout ce qui dépense hors du
    relais (images, voix, transcription, tri des veilles, préparation d'un appel)."""
    cap = daily_cap(agent_id)
    if cap is None or day_cost(agent_id) < cap:
        return None
    _check_daily(agent_id)  # l'alerte « arrêté » part même si le dernier appel l'avait déjà franchi
    return f"Plafond du jour de {cap:.2f} $ atteint pour cet agent. Il reprend demain, ou augmente le plafond dans Noah Agent."


def spending_refusal(agent_id: str) -> str | None:
    """Ce qui arrête cet agent en ce moment, tous plafonds confondus. None : rien."""
    limit = budget()
    if limit is not None and month_cost() >= limit:
        return f"Budget mensuel de {limit:.2f} $ atteint. Augmente-le dans Noah Agent pour continuer."
    return profile_refusal(agent_id) or day_refusal(agent_id)


def _agent_name(agent_id: str) -> str:
    with db.connect() as c:
        row = c.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
    return row["name"] if row else agent_id


def _warn_once(agent_id: str, level: str, cap: float, title: str, text: str) -> None:
    """Une alerte par niveau (80 %, 100 %), par jour et par plafond, sur les appareils du propriétaire de l'agent : un plafond
    relevé dans la journée prévient de nouveau, sinon l'agent s'arrêterait au nouveau plafond sans rien dire."""
    from . import push
    key, stamp = f"budget_alert:{agent_id}:{level}", f"{_day_start()}|{cap}"
    if db.get_setting(key) == stamp:
        return
    db.set_setting(key, stamp)
    push.notify(title, text, url="/", urgent=level.endswith("100"), user_id=billed_to(agent_id), kind="plafond")


def _check_profile(agent_id: str) -> None:
    """Après chaque appel mesuré : même échelle que le plafond du jour, pour le plafond mensuel du profil."""
    user = billed_to(agent_id)
    limit = profile_budget(user)
    if limit is None:
        return
    spent = profile_cost(user)
    tag = f"profil{user}"
    if spent >= limit:
        _warn_once(agent_id, f"{tag}:100", limit, "Budget du profil atteint",
                   f"{spent:.2f} $ dépensés ce mois-ci sur {limit:.2f} $ : les agents de ce profil s'arrêtent.")
    elif spent >= 0.8 * limit:
        _warn_once(agent_id, f"{tag}:80", limit, "Budget du profil bientôt atteint", f"{spent:.2f} $ dépensés ce mois-ci sur {limit:.2f} $.")


def _check_daily(agent_id: str) -> None:
    """Après chaque appel mesuré : prévient avant le dépassement (80 %), puis quand le plafond est atteint."""
    cap = daily_cap(agent_id)
    if cap is None:
        return
    spent = day_cost(agent_id)
    name = _agent_name(agent_id)
    if spent >= cap:
        _warn_once(agent_id, "100", cap, f"{name} s'est arrêté",
                   f"Plafond du jour atteint ({spent:.2f} $ sur {cap:.2f} $). Il reprend demain, ou augmente le plafond.")
    elif spent >= 0.8 * cap:
        _warn_once(agent_id, "80", cap, f"{name} approche de son plafond",
                   f"{spent:.2f} $ dépensés aujourd'hui sur {cap:.2f} $. Au plafond, il s'arrête jusqu'à demain.")


# Conversations dont un run est en cours, par agent (tenu par main._run). Les appels d'un agent ne disent pas pour
# quelle tâche ils sont faits : avec un seul run en cours, c'est lui ; avec plusieurs, l'appel reste sans tâche.
# Approximation assumée : une routine planifiée qui tourne pendant un run interactif lui est comptée.
active: dict[str, list[str]] = {}


def _task_of(agent_id: str) -> str | None:
    runs = active.get(agent_id) or []
    return runs[0] if len(set(runs)) == 1 else None


def local_day(created_at: str) -> str:
    """Jour chez l'utilisateur d'un horodatage UTC de SQLite, avec le décalage de cette date-là (heure d'été comprise)."""
    from . import updates
    utc = datetime.strptime(created_at[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    return utc.astimezone(updates.local_zone()).strftime("%Y-%m-%d")


def month_start() -> str:
    """Premier du mois à minuit chez l'utilisateur, en UTC au format de created_at."""
    from . import updates
    zone = updates.local_zone()
    first = datetime.combine(datetime.now(zone).date().replace(day=1), dtime(0), zone)
    return first.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


context_size: dict[str, int] = {}  # conversation -> plus gros contexte envoyé au modèle pendant son tour en cours (voir chauffe.compact)


async def _record(agent_id: str, model: str, usage: dict | None, task: str | None = None, provider: str | None = None) -> float | None:
    """Compte un appel et rend son coût. None : le fournisseur n'a rien dit de ce qu'il a consommé."""
    if not usage:
        return None
    prompt = int(usage.get("prompt_tokens") or 0)
    if task:
        context_size[task] = max(prompt, context_size.get(task, 0))
    completion = int(usage.get("completion_tokens") or 0)
    cached = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
    cost = usage.get("cost")
    provider = provider or db.get_setting("provider")
    if cost is None and provider not in (*OWN_URL, "ollama-cloud"):
        price = catalog.price_of(await (catalog.mammouth_prices() if provider == "mammouth" else catalog.price_index()), model)
        if price:
            cost = (prompt * price["price_in"] + completion * price["price_out"]) / 1e6
    with db.connect() as c:
        c.execute(
            "INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, cached_tokens, conversation_id, owner_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (agent_id, model, prompt, completion, float(cost or 0), cached, task, billed_to(agent_id)),
        )
    if agent_id and agent_id != "routeur":  # dépense de Noah lui-même : aucun agent à arrêter ni à nommer
        check_spend(agent_id)
    return float(cost or 0)


def check_spend(agent_id: str) -> None:
    """Après chaque dépense mesurée, par le relais ou non : les alertes de plafond partent d'ici."""
    _check_daily(agent_id)
    _check_profile(agent_id)


# Fournisseur injoignable, par agent : Hermes réessaie plusieurs minutes sans rien dire, la tâche le dit à sa place (main._run).
UNREACHABLE = "Le modèle est injoignable. Vérifie son adresse dans Réglages > Modèles et budget > Cerveau, ou réessaie dans un instant."
_failing: dict[str, float] = {}  # depuis quand les appels de cet agent échouent
_reached: dict[str, float] = {}  # dernier appel qui a eu une réponse


def failing_for(agent_id: str) -> float | None:
    """Secondes depuis le premier échec de suite. None : le fournisseur répond."""
    since = _failing.get(agent_id)
    return None if since is None else time.time() - since


def forget_failure(agent_id: str) -> None:
    _failing.pop(agent_id, None)


def reached_since(agent_id: str, moment: float) -> bool:
    return _reached.get(agent_id, 0) >= moment


def _note_status(agent_id: str, status: int) -> None:
    if status in (502, 504):  # un intermédiaire dit que le service derrière lui ne répond pas
        _failing.setdefault(agent_id, time.time())
    else:
        _failing.pop(agent_id, None)
        _reached[agent_id] = time.time()


def _unreachable(agent_id: str) -> JSONResponse:
    _failing.setdefault(agent_id, time.time())
    return JSONResponse({"error": {"message": UNREACHABLE, "type": "upstream_unreachable", "code": 502}}, status_code=502)


def _upstream_headers(provider: str, api_key: str | None) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://github.com/smfcoder17"
        headers["X-Title"] = "Noah Agent"
    return headers


def warmup_mark(agent_id: str) -> str:
    """Propre à l'agent, et impossible à taper par hasard : une personne qui écrit à son agent parle toujours au vrai modèle."""
    code = hmac.new(SECRET_KEY.encode(), f"chauffe:{agent_id}".encode(), hashlib.sha256).hexdigest()[:24]
    return f"[Entretien technique de Noah, rien à faire : {code}]"


WARMUP_MAX = 1000  # le tour lui-même et son titre sont courts ; un résumé de conversation qui citerait la marque, lui, va au vrai modèle


def _is_warmup(agent_id: str, body: dict) -> bool:
    for message in reversed(body.get("messages") or []):
        if message.get("role") == "user":
            content = message.get("content")
            text = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content or [] if isinstance(p, dict))
            return len(text) < WARMUP_MAX and warmup_mark(agent_id) in text
    return False


# Familles qui lisent les marqueurs de cache d'Anthropic : les autres peuvent les refuser.
_CACHE_MARKERS = re.compile(r"claude|kimi|moonshot|qwen", re.I)


def _strip_cache_marks(messages: list) -> None:
    """Hermes pose ses marqueurs selon le modèle qu'il a connu au démarrage : celui qu'on vient de choisir n'en veut peut-être pas."""
    for message in messages:
        message.pop("cache_control", None)
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    part.pop("cache_control", None)


def _current_brain(agent_id: str, asked: str) -> str:
    """Le modèle de cet appel. Changer de cerveau prend effet ici, au prochain appel, sans toucher à la machine de l'agent : c'est
    instantané, même au milieu d'une tâche. Seul le modèle de décision, que l'agent demande pour ses petits travaux, reste le sien."""
    from . import decision  # decision passe par ce module

    helper, brain = decision.model(), db.get_setting("model")
    if helper and helper != brain and asked == helper:  # sans petit modèle, le modèle de décision est le cerveau de tous
        return asked
    return db.get_setting(f"model_{agent_id}") or brain or asked


async def _chain_of(agent_id: str, asked: str, body: dict | None = None) -> list[dict]:
    """Les modèles de cet appel, dans l'ordre : le jeton d'une routine, sinon le mode de l'agent, sinon son cerveau. Le nom écrit par
    l'agent n'est suivi que s'il est le modèle de décision ou un jeton gardé par modes : un agent ne choisit rien d'autre ici."""
    from . import decision, modes

    pinned = await modes.routine_links(agent_id, asked)
    if pinned:
        return pinned
    single = [{"modele": _current_brain(agent_id, asked), "fournisseur": db.get_setting("provider") or ""}]
    helper = decision.model()
    if helper and helper != db.get_setting("model") and asked == helper:  # ses petits travaux restent au modèle de décision
        return single
    if modes.agent_mode(agent_id) == modes.AUTO:
        return await modes.auto_chain(agent_id, body or {}) or single
    return await modes.agent_chain(agent_id) or single


def _payload(body: dict, link: dict, effort: str | None, stream: bool) -> dict:
    """Le corps pour ce maillon : les réglages d'OpenRouter ne partent pas chez un autre fournisseur."""
    from . import decision

    out = {**body, "model": link["modele"]}
    if not _CACHE_MARKERS.search(link["modele"]) and isinstance(out.get("messages"), list):
        _strip_cache_marks(out["messages"])
    if stream:
        out["stream_options"] = {**(out.get("stream_options") or {}), "include_usage": True}
    if link["fournisseur"] == "openrouter":
        out["usage"] = {"include": True}  # OpenRouter renvoie alors le coût exact
        # Le fournisseur le plus réactif pour ce modèle plutôt que le moins cher : c'est le premier mot qui compte.
        out.setdefault("provider", {"sort": "latency"})
        if effort:
            out["reasoning"] = {"effort": effort}  # OpenRouter l'ignore pour un modèle qui ne raisonne pas
    elif effort and decision.thinks(link["modele"]):
        out["reasoning_effort"] = effort
    return out


def _failed_body(raw: bytes) -> int | None:
    """200 qui annonce une erreur dans son corps (OpenRouter le fait quand le fournisseur tombe après coup). Sinon None."""
    line = raw if raw.lstrip().startswith(b"{") else next((x for x in raw.split(b"\n") if x.startswith(b"data:")), b"")[5:]
    try:
        data = json.loads(line)
    except ValueError:
        return None
    if not isinstance(data, dict) or not data.get("error") or data.get("choices"):
        return None
    code = data["error"].get("code") if isinstance(data["error"], dict) else None
    return code if isinstance(code, int) else 502


def _warmup_reply(model: str, stream: bool) -> Response:
    base = {"id": "chauffe", "created": int(time.time()), "model": model}
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if not stream:
        return JSONResponse(base | {"object": "chat.completion", "usage": usage,
                                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})
    chunks = ({"choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}]},
              {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage})
    frames = "".join(f"data: {json.dumps(base | {'object': 'chat.completion.chunk'} | c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return Response(frames, media_type="text/event-stream")


@router.api_route("/relay/v1/{path:path}", methods=["GET", "POST"])
async def relay(path: str, request: Request):
    agent_id = _agent_from(request)
    task = _task_of(agent_id)  # lue au départ de l'appel : la tâche peut finir avant la réponse du fournisseur
    provider = db.get_setting("provider")
    if not provider:
        raise HTTPException(503, "Aucun modèle n'est configuré")
    api_key = db.get_setting("api_key", secret=True) if db.get_setting("api_key") else None
    base = upstream_base(provider, db.get_setting("base_url"))
    if not base:
        raise HTTPException(503, "Ce fournisseur n'a pas d'adresse : renseigne-la dans Réglages > Modèles et budget > Cerveau.")
    url = f"{base}/{path}"
    headers = _upstream_headers(provider, api_key)

    if request.method == "GET":
        try:
            r = await upstream_client().get(url, headers=headers, params=request.query_params, timeout=30)
        except httpx.TransportError:
            return _unreachable(agent_id)
        _note_status(agent_id, r.status_code)
        return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))

    body = await request.json()
    model = body.get("model", "")
    stream = bool(body.get("stream"))
    if path.endswith("chat/completions") and _is_warmup(agent_id, body):  # voir chauffe.py : ni modèle, ni dépense
        return _warmup_reply(model, stream)

    refused = spending_refusal(agent_id)
    if refused:
        _check_profile(agent_id)
        # Lu par l'agent : Hermes ne le remonte pas tel quel à la personne, main._run lui redonne la vraie raison.
        return JSONResponse({"error": {"message": refused, "type": "budget_exceeded", "code": 402}}, status_code=402)

    from . import modes

    chat = path.endswith("chat/completions")
    effort = modes.reasoning(agent_id) if chat else None
    chain = modes.ordered(await _chain_of(agent_id, model, body)) if chat else [{"modele": model, "fournisseur": provider}]

    def target(link: dict) -> tuple[str, dict]:
        """L'adresse et les en-têtes de ce maillon. Chaque clé ne part que vers son fournisseur."""
        if link["fournisseur"] == provider:
            return url, headers
        from . import providers
        return f"{upstream_base(link['fournisseur'], providers.base_of(link['fournisseur']))}/{path}", _upstream_headers(link["fournisseur"], modes.key_of(link["fournisseur"]))

    def retry_later(link: dict, status: int, retry_after: str | None = None) -> None:
        modes.cool(link, status, retry_after)
        print(f"[relais] {agent_id} : {link['modele']} indisponible ({status or 'injoignable'}), le suivant prend le relais", flush=True)

    def bodies(link: dict) -> list[dict]:
        """Un fournisseur qui refuse le niveau de raisonnement répond sans : le réglage ne casse pas l'agent."""
        if not chat:
            return [body]
        return [_payload(body, link, effort, stream)] + ([_payload(body, link, None, stream)] if effort else [])

    if not stream:
        for i, link in enumerate(chain):
            last = i == len(chain) - 1
            to, sent = target(link)
            try:
                tries = bodies(link)
                r = await upstream_client().post(to, headers=sent, json=tries[0])
                if r.status_code == 400 and len(tries) > 1:
                    r = await upstream_client().post(to, headers=sent, json=tries[1])
            except httpx.TransportError:
                if last:
                    return _unreachable(agent_id)
                retry_later(link, 0)
                continue
            failed = r.status_code if r.status_code != 200 else _failed_body(r.content)
            if not last and failed in modes.FAILOVER:
                retry_later(link, failed, r.headers.get("retry-after"))
                continue
            _note_status(agent_id, r.status_code)
            if r.status_code == 200:
                try:
                    await _record(agent_id, link["modele"], r.json().get("usage"), task, link["fournisseur"])
                except ValueError:
                    pass
            return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))

    client = upstream_client()
    for i, link in enumerate(chain):
        last = i == len(chain) - 1
        to, sent = target(link)
        # Un flux compressé retarde le premier mot. Un fournisseur peut compresser quand même : aiter_bytes décompresse.
        plain = {**sent, "Accept-Encoding": "identity"}
        # Tant qu'un suivant attend, un modèle muet ne le fait pas patienter dix minutes.
        limits = {} if last else {"timeout": httpx.Timeout(600, connect=8, read=120)}
        try:
            tries = bodies(link)
            upstream = await client.send(client.build_request("POST", to, headers=plain, json=tries[0], **limits), stream=True)
            if upstream.status_code == 400 and len(tries) > 1:
                await upstream.aclose()
                upstream = await client.send(client.build_request("POST", to, headers=plain, json=tries[1], **limits), stream=True)
        except httpx.TransportError:
            if last:
                return _unreachable(agent_id)
            retry_later(link, 0)
            continue
        if upstream.status_code != 200:
            content = await upstream.aread()
            await upstream.aclose()
            if not last and upstream.status_code in modes.FAILOVER:
                retry_later(link, upstream.status_code, upstream.headers.get("retry-after"))
                continue
            _note_status(agent_id, upstream.status_code)
            return Response(content, status_code=upstream.status_code, media_type=upstream.headers.get("content-type"))

        # Basculer n'est possible qu'avant le premier octet transmis : on lit jusqu'à la première donnée, sans rien transmettre. Le
        # dernier maillon n'a personne après lui : il part tout de suite, comme un modèle seul.
        chunks = upstream.aiter_bytes()
        head = b""
        if not last:
            try:
                while not any(x.startswith(b"data:") for x in head.split(b"\n")[:-1]):  # une ligne entière : une erreur peut arriver en deux morceaux
                    head += await chunks.__anext__()
            except StopAsyncIteration:
                pass
            except httpx.HTTPError:
                await upstream.aclose()
                retry_later(link, 0)
                continue
            failed = _failed_body(head)
            if failed in modes.FAILOVER:
                await upstream.aclose()
                retry_later(link, failed)
                continue
        _note_status(agent_id, 200)
        return StreamingResponse(_passthrough(agent_id, upstream, chunks, head, link, task), status_code=200,
                                 media_type=upstream.headers.get("content-type", "text/event-stream"))
    return _unreachable(agent_id)  # chaîne vide : impossible, _chain_of rend toujours au moins le cerveau


async def _passthrough(agent_id: str, upstream, chunks, head: bytes, link: dict, task: str | None):
    usage = None
    pending = b""

    def read(chunk: bytes, pending: bytes, usage):
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for line in lines:
            if line.startswith(b"data:") and b'"usage"' in line:
                try:
                    usage = json.loads(line[5:].strip()).get("usage") or usage
                except ValueError:
                    pass
        return pending, usage

    try:
        if head:
            yield head
            pending, usage = read(head, pending, usage)
        async for chunk in chunks:
            yield chunk
            pending, usage = read(chunk, pending, usage)
    finally:
        await upstream.aclose()
        await _record(agent_id, link["modele"], usage, task, link["fournisseur"])
