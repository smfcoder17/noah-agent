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


async def price_index() -> dict[str, dict]:
    """Prix par identifiant normalisé, pour estimer le coût des fournisseurs directs."""
    try:
        models = await openrouter_catalog()
    except httpx.HTTPError:
        return {}
    return {_norm(m["id"]): m for m in models if not m["free"]}


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


async def _ollama() -> list[dict]:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(f"{OLLAMA_URL}/api/tags")
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


async def models_for(provider: str, api_key: str | None) -> list[dict]:
    if provider == "openrouter":
        return [m for m in await openrouter_catalog() if m["tools"]]
    if provider == "ollama":
        return [m for m in await _ollama() if m["tools"]]
    if not api_key:
        return []
    prices = await price_index()
    out = []
    for mid in await _native(provider, api_key):
        p = prices.get(_norm(mid), {})
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
    if provider == "ollama":
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
