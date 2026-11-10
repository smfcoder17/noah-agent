"""Catalogue des modèles : listes à jour par fournisseur, prix, et groupes recommandés calculés.

Les groupes ne contiennent aucun nom de modèle écrit en dur : pour chaque grand labo, on prend
le modèle le plus récent de chaque gamme de prix. Ils suivent donc les nouvelles sorties.
"""
import re
import time

import httpx

OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
OLLAMA_URL = "http://host.docker.internal:11434"
CACHE_SECONDS = 3600

# Labos dont on met les modèles en avant dans les groupes (la recherche couvre tout le reste).
# L'ordre sert aussi à l'affichage des cartes dans chaque groupe.
MAJOR_LABS = [
    "anthropic", "openai", "google", "x-ai", "deepseek", "moonshotai", "z-ai",
    "qwen", "meta", "mistralai", "minimax", "nvidia",
]

# Gammes de prix d'entrée, en dollars par million de jetons.
TIERS = [
    ("smart", "Les plus intelligents", "Pour les tâches longues et difficiles.", 1.5, None),
    ("balanced", "Équilibrés", "Bon rapport qualité-prix pour tous les jours.", 0.3, 1.5),
    ("fast", "Rapides et économiques", "Pour le tri, les résumés et la veille.", 0.0, 0.3),
]

_cache: dict[str, tuple[float, list[dict]]] = {}


def _norm(model_id: str) -> str:
    """Clé de rapprochement entre identifiants natifs et OpenRouter (claude-sonnet-4-5 ~ claude-sonnet-4.5)."""
    return re.sub(r"[^a-z0-9]", "", model_id.split("/")[-1].lower())


async def openrouter_catalog() -> list[dict]:
    hit = _cache.get("openrouter")
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(OPENROUTER_MODELS)
    r.raise_for_status()
    models = []
    for m in r.json()["data"]:
        mid = m["id"]
        price_in = float(m["pricing"].get("prompt") or 0) * 1e6
        price_out = float(m["pricing"].get("completion") or 0) * 1e6
        if mid.startswith("~") or mid.endswith(":batch") or price_in < 0:
            continue  # alias, variantes différées, routeurs à prix variable
        models.append({
            "id": mid,
            "name": m.get("name") or mid,
            "lab": mid.split("/")[0],
            "created": m.get("created") or 0,
            "context": m.get("context_length") or 0,
            "price_in": round(price_in, 4),
            "price_out": round(price_out, 4),
            "tools": "tools" in (m.get("supported_parameters") or []),
            "vision": "image" in ((m.get("architecture") or {}).get("input_modalities") or []),
            "free": mid.endswith(":free") or (price_in == 0 and price_out == 0),
        })
    _cache["openrouter"] = (time.time(), models)
    return models


# Vrais modèles de décision (Jev, Clef…) : réponses typées, sans texte. OpenRouter les publie à part, avec leurs prix, et les sert tous
# par la même route et la clé qu'on a déjà.
OPENROUTER_DECISIONS = OPENROUTER_MODELS + "?output_modalities=decisions"
_WEB_DECISION = re.compile(r"live web|web-grounded", re.I)  # lit le web en plus de ce qu'on lui confie : pas pour un courriel


async def decision_catalog() -> list[dict]:
    hit = _cache.get("decisions")
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(OPENROUTER_DECISIONS)
    r.raise_for_status()
    models = []
    for m in r.json().get("data", []):
        mid = str(m.get("id") or "")
        if not mid or mid.startswith("~") or "/api/alpha/decisions" not in (m.get("endpoints") or []) or _WEB_DECISION.search(m.get("description") or ""):
            continue
        pricing = m.get("pricing") or {}
        models.append({"id": mid, "name": re.sub(r"^[^:]+:\s*", "", m.get("name") or mid), "created": m.get("created") or 0,
                       "context": m.get("context_length") or 0, "price_in": round(float(pricing.get("prompt") or 0) * 1e6, 4)})
    _cache["decisions"] = (time.time(), models)
    return models


# Suffixes de version des identifiants natifs, absents du catalogue : claude-haiku-4-5-20251001, gpt-5-mini-2025-08-07, gemini-3-flash-latest.
_DATED = re.compile(r"-(?:\d{4}-?\d{2}-?\d{2}|latest|preview(?:-[\w.-]+)?|exp(?:-[\w.-]+)?)$")


def price_of(prices: dict[str, dict], model_id: str) -> dict:
    """Le prix d'un identifiant natif ; sans son suffixe de version s'il le faut. Vide si le catalogue ne le connaît pas."""
    return prices.get(_norm(model_id)) or prices.get(_norm(_DATED.sub("", model_id))) or {}


async def price_index() -> dict[str, dict]:
    """Prix par identifiant normalisé, pour estimer le coût des fournisseurs directs."""
    try:
        models = await openrouter_catalog()
    except httpx.HTTPError:
        return {}
    return {_norm(m["id"]): m for m in models if not m["free"]}


# Mammouth publie ses modèles et ses prix sans clé. Tous se disent « openai » : le labo se lit dans le nom.
MAMMOUTH_MODELS = "https://api.mammouth.ai/public/models"
_MAMMOUTH_LABS = (("claude", "anthropic"), ("gpt", "openai"), ("gemini", "google"), ("kimi", "moonshotai"), ("deepseek", "deepseek"),
                  ("glm", "z-ai"), ("qwen", "qwen"), ("mistral", "mistralai"), ("grok", "x-ai"), ("minimax", "minimax"), ("llama", "meta"))
_MAMMOUTH_NOT_CHAT = re.compile(r"embed|image|banana|sonar", re.I)  # images et recherche web : pas de cerveau à outils


async def mammouth_catalog() -> list[dict]:
    hit = _cache.get("mammouth")
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(MAMMOUTH_MODELS)
    r.raise_for_status()
    models = []
    for m in r.json().get("data", []):
        mid = str(m.get("id") or "")
        info = m.get("model_info") or {}
        if not mid or _MAMMOUTH_NOT_CHAT.search(mid):
            continue
        price_in, price_out = info.get("input_cost_per_token"), info.get("output_cost_per_token")
        models.append({
            "id": mid,
            "name": mid,
            "lab": next((lab for prefix, lab in _MAMMOUTH_LABS if mid.lower().startswith(prefix)), "mammouth"),
            "created": m.get("created") or 0,
            "context": info.get("max_input_tokens") or 0,
            "price_in": float(price_in) * 1e6 if price_in is not None else None,
            "price_out": float(price_out) * 1e6 if price_out is not None else None,
            "tools": True,
            "vision": False,
            "free": False,
        })
    _cache["mammouth"] = (time.time(), models)
    return models


async def mammouth_prices() -> dict[str, dict]:
    """Prix annoncés par Mammouth, en plafond : le coût affiché peut dépasser un peu le coût réel."""
    try:
        models = await mammouth_catalog()
    except httpx.HTTPError:
        return {}
    return {_norm(m["id"]): m for m in models if m["price_in"] is not None}


async def _native(provider: str, api_key: str) -> list[str]:
    """Liste les identifiants exposés par l'API du fournisseur, avec la clé de l'utilisateur."""
    async with httpx.AsyncClient(timeout=20) as c:
        if provider == "openai":
            r = await c.get("https://api.openai.com/v1/models", headers={"Authorization": f"Bearer {api_key}"})
            ids = [m["id"] for m in r.raise_for_status().json()["data"]]
            return [i for i in ids if re.match(r"^(gpt|o\d|chatgpt)", i) and not re.search(r"audio|realtime|tts|transcribe|image|search", i)]
        if provider == "anthropic":
            r = await c.get(
                "https://api.anthropic.com/v1/models?limit=100",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
            )
            return [m["id"] for m in r.raise_for_status().json()["data"]]
        if provider == "gemini":
            r = await c.get(
                "https://generativelanguage.googleapis.com/v1beta/openai/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            ids = [m["id"].removeprefix("models/") for m in r.raise_for_status().json()["data"]]
            return [i for i in ids if i.startswith("gemini") and not re.search(r"embedding|tts|image|audio", i)]
    return []


def _auth(api_key: str | None) -> dict:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _openai_compatible(base_url: str, api_key: str | None) -> list[dict]:
    """Les modèles d'un service compatible OpenAI. On ne connaît ni leurs prix ni leurs capacités : on les suppose capables d'outils."""
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{base_url.rstrip('/')}/models", headers=_auth(api_key))
    r.raise_for_status()
    return [{"id": m["id"], "name": m["id"], "lab": "custom", "created": m.get("created") or 0, "context": 0, "price_in": None,
             "price_out": None, "tools": True, "vision": False, "free": False} for m in r.json().get("data", [])]


async def _ollama(url: str = OLLAMA_URL, api_key: str | None = None) -> list[dict]:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(f"{url}/api/tags", headers=_auth(api_key))
    r.raise_for_status()
    out = []
    for m in r.json().get("models", []):
        caps = m.get("capabilities") or []
        details = m.get("details") or {}
        out.append({
            "id": m["name"],
            "name": m["name"],
            "lab": "ollama",
            "created": 0,
            "context": details.get("context_length") or 0,
            "price_in": 0,
            "price_out": 0,
            "tools": "tools" in caps if caps else True,
            "vision": "vision" in caps,
            "free": True,
            "cloud": bool(m.get("remote_host")) or m["name"].endswith(":cloud"),
            "size": details.get("parameter_size") or "",
        })
    return out


async def check_key(provider: str, api_key: str) -> None:
    """Lève HTTPStatusError si le fournisseur refuse cette clé. Les catalogues publics (OpenRouter) ne la testent pas :
    ils répondent même à une clé expirée, et l'erreur n'apparaîtrait qu'au premier message."""
    if provider == "openrouter":
        async with httpx.AsyncClient(timeout=10) as c:
            (await c.get("https://openrouter.ai/api/v1/key", headers=_auth(api_key))).raise_for_status()
    elif provider == "mammouth":
        async with httpx.AsyncClient(timeout=10) as c:
            (await c.get("https://api.mammouth.ai/key/info", headers=_auth(api_key))).raise_for_status()
    elif provider in ("anthropic", "openai", "gemini"):
        await _native(provider, api_key)


async def models_for(provider: str, api_key: str | None, base_url: str | None = None) -> list[dict]:
    if provider in ("mistral", "deepseek"):
        if not api_key:
            return []
        base = "https://api.mistral.ai/v1" if provider == "mistral" else "https://api.deepseek.com/v1"
        return [{**m, "lab": provider} for m in await _openai_compatible(base, api_key)]
    if provider == "openrouter":
        return [m for m in await openrouter_catalog() if m["tools"]]
    if provider == "ollama":
        return [m for m in await _ollama((base_url or OLLAMA_URL).rstrip("/").removesuffix("/v1"), api_key) if m["tools"]]
    if provider == "custom":
        return await _openai_compatible(base_url, api_key) if base_url else []
    if provider == "mammouth":
        return await mammouth_catalog()
    if not api_key:
        return []
    if provider == "ollama-cloud":
        return [{**m, "cloud": True} for m in await _ollama("https://ollama.com", api_key) if m["tools"]]
    if not api_key:
        return []
    prices = await price_index()
    out = []
    for mid in await _native(provider, api_key):
        p = price_of(prices, mid)
        out.append({
            "id": mid,
            "name": p.get("name") or mid,
            "lab": provider,
            "created": p.get("created", 0),
            "context": p.get("context", 0),
            "price_in": p.get("price_in"),
            "price_out": p.get("price_out"),
            "tools": True,
            "vision": p.get("vision", False),
            "free": False,
        })
    return out


def groups(provider: str, models: list[dict]) -> list[dict]:
    """Groupes recommandés : pour chaque labo et chaque gamme de prix, le modèle le plus récent."""
    if provider == "custom":
        return []
    if provider in ("ollama", "ollama-cloud"):
        cloud = [m for m in models if m.get("cloud")]
        local = [m for m in models if not m.get("cloud")]
        return [g for g in (
            {"id": "cloud", "title": "Modèles cloud d'Ollama", "hint": "Puissants, exécutés chez Ollama.", "models": cloud},
            {"id": "local", "title": "Sur ta machine", "hint": "Gratuits et privés, plus lents.", "models": local},
        ) if g["models"]]

    pool = [m for m in models if not m["free"] and m["price_in"] is not None]
    if provider == "openrouter":
        pool = [m for m in pool if m["lab"] in MAJOR_LABS]
    newest = {}
    for m in pool:
        newest[m["lab"]] = max(newest.get(m["lab"], 0), m["created"])
    recent = 180 * 86400

    out = []
    for gid, title, hint, low, high in TIERS:
        best: dict[str, dict] = {}
        for m in pool:
            if m["price_in"] < low or (high is not None and m["price_in"] >= high):
                continue
            if gid == "smart":
                # Le haut de gamme récent du labo : le plus cher parmi ses sorties des six derniers mois.
                if m["created"] < newest[m["lab"]] - recent:
                    continue
                key = (m["price_in"], m["created"])
            else:
                key = (m["created"],)
            current = best.get(m["lab"])
            if current is None or key > ((current["price_in"], current["created"]) if gid == "smart" else (current["created"],)):
                best[m["lab"]] = m
        rank = {lab: i for i, lab in enumerate(MAJOR_LABS)}
        picks = sorted(best.values(), key=lambda m: (rank.get(m["lab"], 99), -m["created"]))[:8]
        if picks:
            out.append({"id": gid, "title": title, "hint": hint, "models": picks})
    free = sorted((m for m in models if m["free"]), key=lambda m: -m["created"])[:6]
    if free and provider == "openrouter":
        out.append({"id": "free", "title": "Gratuits", "hint": "Limités en débit, parfait pour essayer.", "models": free})
    return out

# Icône du site choisi : garde SSRF partagée avec les aperçus de liens (#44a/C3).
def provider_icon(base_url: str | None) -> tuple[bytes, str] | None:
    import hashlib
    from pathlib import Path
    from urllib.parse import urljoin, urlsplit
    from . import config, logos, safefetch

    if not base_url:
        return None
    u = urlsplit(base_url)
    home = f"{u.scheme}://{u.netloc}/"
    folder = Path(config.DATA_DIR) / "provider-icons"
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(home.encode()).hexdigest()
    image, kind_file = folder / f"{digest}.bin", folder / f"{digest}.type"
    if image.exists() and kind_file.exists() and time.time() - image.stat().st_mtime < 30 * 86400:
        return image.read_bytes(), kind_file.read_text()
    candidates = []
    try:
        page = safefetch.fetch(home, limit=400_000, timeout=5)
        candidates = logos._candidates(page.body.decode("utf8", "replace"), page.url)
    except (safefetch.UnsafeURL, OSError):
        pass
    for address in [*candidates[:2], urljoin(home, "favicon.ico")]:
        try:
            result = safefetch.fetch(address, limit=512_000, timeout=5)
            kind = logos._kind(result.body)
            if kind:
                # Cache borné : aucune adresse saisie ne remplit indéfiniment le disque.
                old = sorted(folder.glob("*.bin"), key=lambda p: p.stat().st_mtime)
                for path in old[:-63]:
                    path.unlink(missing_ok=True)
                    path.with_suffix(".type").unlink(missing_ok=True)
                image.write_bytes(result.body)
                kind_file.write_text(kind)
                return result.body, kind
        except (safefetch.UnsafeURL, OSError):
            continue
    return None
