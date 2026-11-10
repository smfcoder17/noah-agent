"""Modes : Rapide, Équilibré, Le plus fort, Gratuit et Custom, pour le cerveau, la création et la voix.

La personne décide quel modèle correspond à chaque mode. Gratuit et Custom sont des chaînes : le premier répond, et le suivant
prend le relais s'il est épuisé ou en panne (relay.py pour le cerveau, media.py pour le reste).

Le réglage historique (« model », « media_image »…) reste le modèle en service : tout ce qui le lit continue de marcher. Un mode
n'est actif que tant que ce réglage vaut ce que le mode y a posé : choisir un modèle précis ailleurs (Réglages, l'agent) le quitte
sans autre geste.
"""
import asyncio
import hashlib
import json
import re
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import access, auth, catalog, db

router = APIRouter()

BRAIN = "cerveau"
MEDIA_LEVELS = ("image", "video", "music", "speech", "transcription")
LEVELS = (BRAIN, *MEDIA_LEVELS)
TIERS = ("fast", "balanced", "smart")
CHAINED = ("gratuit", "custom")
MODES = (*TIERS, *CHAINED)
AUTO = "auto"  # par agent seulement : le niveau suit chaque demande (complexite.py)
REASONING = ("low", "medium", "high")

FREE_CHAIN_MAX = 8
CUSTOM_MAX = 12
MIN_CONTEXT = 32000  # en dessous, un cerveau d'agent ne tient pas ses consignes et ses outils
ROTATE_SECONDS = 600  # les gratuits alternent, sans changer de modèle à chaque étape d'une tâche
LISTING_SECONDS = 3600
# Ce que ces mots désignent ne tient pas une conversation avec outils, et un routeur choisit à notre place.
NOT_BRAIN = re.compile(r"^openrouter/|embed|whisper|tts|speech|transcri|audio|image|video|moderation|guard|rerank|ocr|realtime|deep-research", re.I)

# Ce que Gratuit et Custom ont le droit de sauter : quota, crédit, panne, modèle retiré. Jamais une demande mal formée (400) ni une clé
# refusée (401, 403) : le suivant échouerait pareil, et la vraie raison se perdrait.
FAILOVER = {402, 404, 408, 409, 425, 429, 500, 502, 503, 504, 524, 529}
COOLDOWN = {429: 300, 402: 3600, 404: 3600}
COOLDOWN_DEFAULT = 60
COOLDOWN_MAX = 3600

ROUTINE_PREFIX = "noah-routine/"
# Ce qu'une routine peut recevoir, en langage clair à l'écran. Rien d'autre ne part vers Hermes.
ROUTINE_TOOLS = {
    "internet": ["web", "search"],
    "navigateur": ["browser"],
    "fichiers": ["file"],
    "commandes": ["terminal", "code_execution"],
    "memoire": ["memory", "session_search"],
    "images_vues": ["vision"],
    "competences": ["skills"],
}
_IMAGE_NOTE = re.compile(r"\n*\[Réglage de cette routine : pour une image, ajoute --modele (\S+) à noah\.py image\.\]\s*$")


# --- Réglages ---------------------------------------------------------------------------------------------------------

def _config() -> dict:
    try:
        data = json.loads(db.get_setting("modes") or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _level(level: str) -> dict:
    data = _config().get(level)
    return data if isinstance(data, dict) else {}


def _save_level(level: str, data: dict) -> None:
    config = _config()
    config[level] = data
    db.set_setting("modes", json.dumps(config, ensure_ascii=False))


def _setting_key(level: str) -> str:
    return "model" if level == BRAIN else f"media_{level}"


def _in_service(level: str) -> str:
    return db.get_setting(_setting_key(level)) or ("" if level == BRAIN else "auto")


def active(level: str) -> str | None:
    """Le mode en service. Un modèle précis choisi depuis (par l'écran ou par l'agent) l'a quitté."""
    data = _level(level)
    mode = data.get("actif")
    return mode if mode in MODES and data.get("pose") == _in_service(level) else None


def forget_unusable() -> None:
    """Après un changement de fournisseur : les modèles qu'aucune clé ne permet plus sortent des modes. Le mode actif, lui, s'est déjà
    quitté : le réglage en service a changé."""
    data = _level(BRAIN)
    if not data:
        return
    usable = usable_providers()
    own = data.get("surcharges") or {}
    data["surcharges"] = {tier: link for tier, link in own.items() if link.get("fournisseur") in usable}
    data["custom"] = [link for link in data.get("custom") or [] if link.get("fournisseur") in usable]
    _save_level(BRAIN, data)


# --- Clés et listes ---------------------------------------------------------------------------------------------------

def key_of(provider: str) -> str | None:
    """La clé de la personne pour ce fournisseur. Seuls le cerveau et OpenRouter (voix et création) en ont une ici."""
    from . import providers
    return providers.key_of(provider)


def usable_providers() -> list[str]:
    from . import hermes, providers
    return [p for p in hermes.PROVIDERS if providers.connected(p)]


_listed: dict[str, tuple[float, list[dict]]] = {}


async def _models_of(provider: str) -> list[dict]:
    key = key_of(provider)
    from . import providers
    base_url = providers.base_of(provider)
    stamp = hashlib.sha256(f"{provider}|{key}|{base_url}".encode()).hexdigest()
    hit = _listed.get(stamp)
    if hit and time.time() - hit[0] < LISTING_SECONDS:
        return hit[1]
    models = await catalog.models_for(provider, key, base_url)
    _listed[stamp] = (time.time(), models)
    return models


def _media_row(m: dict) -> dict:
    cost = m.get("cost") or {}
    return {"id": m["id"], "name": m.get("name") or m["id"], "lab": m["id"].split("/")[0], "created": m.get("created") or 0, "context": 0,
            "price_in": None, "price_out": None, "vision": False, "free": cost.get("value") == 0, "fournisseur": "openrouter",
            "prix": cost.get("label"), "prix_valeur": cost.get("value"), "quality": m.get("quality"), "speed": m.get("speed")}


async def available(level: str) -> list[dict]:
    """Tout ce que les clés de la personne permettent à ce niveau. Une liste illisible ne fait pas disparaître les autres."""
    if level != BRAIN:
        from . import media  # media passe par decision, qui passe par la machine des agents, qui passe par ce module

        try:
            return [_media_row(m) for m in await media.models(level)]
        except media.MediaError as e:  # pas de clé pour la voix et la création : la phrase est faite pour l'écran
            raise HTTPException(400, str(e)) from None
    out: list[dict] = []
    for provider in usable_providers():
        try:
            out += [{**m, "fournisseur": provider} for m in await _models_of(provider)]
        except Exception as e:  # noqa: BLE001
            print(f"[modes] liste de {provider} illisible : {type(e).__name__}", flush=True)
    return out


def _link(model_id: str, provider: str | None) -> dict:
    return {"modele": model_id, "fournisseur": provider or db.get_setting("provider") or ""}


async def _validated(level: str, model_id: str, provider: str | None) -> dict:
    """Un modèle hors de ce que les clés permettent est refusé : c'est la garde de tout ce qui vient de l'agent."""
    provider = provider or None
    models = await available(level)
    found = next((m for m in models if m["id"] == model_id and (not provider or m["fournisseur"] == provider)), None)
    if not found:
        raise HTTPException(400, f"Modèle inconnu avec tes clés : {model_id}")
    return _link(found["id"], found["fournisseur"])


# --- Ce que vaut chaque mode ------------------------------------------------------------------------------------------

def _brain_tier(models: list[dict], provider: str, tier: str) -> dict | None:
    """Sans choix de la personne : le phare pour « Le plus fort », le plus récent de sa gamme pour les autres (catalog.groups)."""
    group = next((g for g in catalog.groups(provider, models) if g["id"] == tier), None)
    if not group or not group["models"]:
        return None
    return group["models"][0] if tier == "smart" else max(group["models"], key=lambda m: m.get("created") or 0)


def _media_tier(models: list[dict], tier: str) -> dict | None:
    if not models:
        return None
    price = lambda m: m["prix_valeur"] if m.get("prix_valeur") is not None else 1e9  # noqa: E731
    if tier == "fast":
        return max(models, key=lambda m: (m.get("speed") or 0, m.get("quality") or 0, -price(m)))
    if tier == "smart":
        return max(models, key=lambda m: (m.get("quality") or 0, -price(m)))
    good = [m for m in models if (m.get("quality") or 0) >= 3] or models
    return min(good, key=lambda m: (price(m), -(m.get("quality") or 0)))


async def tier_link(level: str, tier: str, models: list[dict] | None = None) -> dict | None:
    own = (_level(level).get("surcharges") or {}).get(tier)
    if own:
        return own
    models = await available(level) if models is None else models
    if level != BRAIN:
        found = _media_tier(models, tier)
    else:
        provider = db.get_setting("provider") or ""
        found = _brain_tier([m for m in models if m["fournisseur"] == provider], provider, tier)
    return _link(found["id"], found["fournisseur"]) if found else None


def free_order(models: list[dict], brain: bool = True) -> list[dict]:
    """Gratuits d'abord, puis du moins cher au plus cher, les prix inconnus en dernier."""
    def fits(m: dict) -> bool:
        return not brain or (not NOT_BRAIN.search(m["id"]) and not (0 < (m.get("context") or 0) < MIN_CONTEXT))

    def rank(m: dict):
        cost = m.get("prix_valeur")
        if cost is None and m.get("price_in") is not None:
            cost = (3 * m["price_in"] + (m.get("price_out") or 0)) / 4
        if m.get("free"):
            return (0, 0, -(m.get("created") or 0), m["id"])
        return (1, cost, -(m.get("created") or 0), m["id"]) if cost is not None else (2, 0, -(m.get("created") or 0), m["id"])
    return sorted((m for m in models if fits(m)), key=rank)


def rotation() -> int:
    return int(time.time() / ROTATE_SECONDS)


def _free_links(level: str, models: list[dict], rotate: bool) -> list[dict]:
    order = free_order(models, level == BRAIN)[:FREE_CHAIN_MAX]
    free = [m for m in order if m.get("free")]
    if rotate and len(free) > 1:  # alterner n'use pas le quota d'un seul ; les payants restent derrière, dans l'ordre
        turn = rotation() % len(free)
        order = free[turn:] + free[:turn] + order[len(free):]
    return [_link(m["id"], m["fournisseur"]) for m in order]


def _keep_usable(links: list[dict]) -> list[dict]:
    usable = usable_providers()
    return [link for link in links if link.get("modele") and link.get("fournisseur") in usable]


async def links_of(level: str, mode: str, rotate: bool = True) -> list[dict]:
    if mode in TIERS:
        link = await tier_link(level, mode)
        return [link] if link else []
    if mode == "gratuit":
        return _free_links(level, await available(level), rotate)
    return _keep_usable(_level(level).get("custom") or []) if level == BRAIN else list(_level(level).get("custom") or [])


async def agent_chain(agent_id: str) -> list[dict] | None:
    """La chaîne de cet agent ; None : un seul modèle, celui que le relais lit déjà (relay._current_brain)."""
    own = db.get_setting(f"model_mode_{agent_id}")
    mode = own or (None if db.get_setting(f"model_{agent_id}") else active(BRAIN))
    if mode not in MODES:
        return None
    links = _keep_usable(await links_of(BRAIN, mode))
    if mode in TIERS and not own and all(link.get("fournisseur") in ("", None, db.get_setting("provider")) for link in links):
        return None  # le fournisseur en service répond déjà : pas de chaîne à monter
    return links or None


async def auto_chain(agent_id: str, body: dict) -> list[dict] | None:
    """Mode Auto : le niveau choisi pour cette demande d'abord, puis les autres en relais s'il est épuisé ou en panne."""
    from . import complexite
    tier = await complexite.tier_for(agent_id, body)
    order = [tier, *[t for t in ("balanced", "smart", "fast") if t != tier]]
    links: list[dict] = []
    for t in order:
        for link in await links_of(BRAIN, t):
            if link not in links:
                links.append(link)
    return _keep_usable(links) or None


async def media_chain(level: str) -> list[str] | None:
    """Gratuit ou Custom à la création et à la voix. None : un seul modèle, le réglage."""
    mode = active(level)
    if mode not in CHAINED:
        return None
    return [link["modele"] for link in await links_of(level, mode)] or None


def reasoning(agent_id: str) -> str | None:
    value = db.get_setting(f"reasoning_{agent_id}")
    return value if value in REASONING else None


async def set_agent_mode(agent_id: str, mode: str) -> dict:
    links = [link for t in TIERS for link in await links_of(BRAIN, t, rotate=False)] if mode == AUTO else await links_of(BRAIN, mode, rotate=False)
    if not links:
        raise HTTPException(400, "Ce mode n'a encore aucun modèle : choisis-en un dans Réglages > Modèles et budget.")
    provider = db.get_setting("provider")
    first = next((link for link in links if link["fournisseur"] == provider), None)
    if mode == AUTO:  # le relais reconnaît les petits travaux d'Hermes à ce nom : le modèle inscrit ne doit jamais être le sien
        from . import decision
        first = next((link for link in links if link["fournisseur"] == provider and link["modele"] != decision.model()), None)
    db.set_setting(f"model_mode_{agent_id}", mode)
    if first:  # pour les fichiers de sa machine et l'écran ; c'est le relais qui décide à chaque appel
        db.set_setting(f"model_{agent_id}", first["modele"])
    elif mode == AUTO:
        with db.connect() as c:
            c.execute("DELETE FROM settings WHERE key = ?", (f"model_{agent_id}",))
    return links[0]


def clear_agent_mode(agent_id: str) -> None:
    with db.connect() as c:
        c.execute("DELETE FROM settings WHERE key = ?", (f"model_mode_{agent_id}",))


def set_reasoning(agent_id: str, value: str | None) -> None:
    if value:
        db.set_setting(f"reasoning_{agent_id}", value)
    else:
        with db.connect() as c:
            c.execute("DELETE FROM settings WHERE key = ?", (f"reasoning_{agent_id}",))


# --- Épuisés ----------------------------------------------------------------------------------------------------------
# En mémoire : un redémarrage remet tout le monde en jeu, et le premier refus les écarte de nouveau.

_cooling: dict[tuple[str, str], float] = {}


def cool(link: dict, status: int = 0, retry_after: str | None = None) -> None:
    seconds: float = COOLDOWN.get(status, COOLDOWN_DEFAULT)
    try:
        asked = float(retry_after) if retry_after else seconds
        seconds = min(max(asked, 1), COOLDOWN_MAX) if asked == asked else seconds  # « nan » n'est égal à rien
    except ValueError:
        pass
    _cooling[(link.get("fournisseur", ""), link["modele"])] = time.time() + seconds


def ordered(links: list[dict]) -> list[dict]:
    """Les disponibles d'abord, dans l'ordre. Les épuisés restent derrière : tous épuisés vaut mieux qu'un essai que pas de réponse."""
    now = time.time()
    ready, tired = [], []
    for link in links:
        (ready if _cooling.get((link.get("fournisseur", ""), link["modele"]), 0) <= now else tired).append(link)
    return ready + tired


# --- Routines ---------------------------------------------------------------------------------------------------------
# Hermes fait tourner la routine avec le nom qu'on lui donne. Ce nom n'est pas un modèle : c'est un jeton gardé ici, posé après
# vérification. Le relais ne suit que ses jetons connus, jamais un identifiant écrit par l'agent : une routine ne dépasse ni les
# clés de la personne ni son budget (spending_refusal passe avant la chaîne).

def _pins(agent_id: str) -> dict:
    try:
        data = json.loads(db.get_setting(f"routine_pins:{agent_id}") or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


async def routine_alias(agent_id: str, choice: str, provider: str | None = None) -> str:
    """Un mode (« gratuit ») ou un modèle des clés de la personne. Le nom de ce choix reste lisible dans le nom donné à Hermes."""
    if choice in MODES:
        pin: dict = {"mode": choice}
    else:
        pin = await _validated(BRAIN, choice, provider)
    token = secrets.token_hex(6)
    pins = _pins(agent_id)
    pins[token] = pin
    db.set_setting(f"routine_pins:{agent_id}", json.dumps(pins, ensure_ascii=False))
    return f"{ROUTINE_PREFIX}{token}/{choice}"


async def routine_links(agent_id: str, asked: str) -> list[dict] | None:
    """La chaîne d'un jeton de routine. None : ce n'en est pas un, ou un jeton inconnu (le relais retombe alors sur le cerveau)."""
    if not asked.startswith(ROUTINE_PREFIX):
        return None
    pin = _pins(agent_id).get(asked[len(ROUTINE_PREFIX):].split("/", 1)[0])
    if not pin:
        return None
    links = await links_of(BRAIN, pin["mode"]) if pin.get("mode") else [pin]
    return _keep_usable(links) or None


def routine_toolsets(names: list[str]) -> list[str]:
    unknown = [n for n in names if n not in ROUTINE_TOOLS]
    if unknown:
        raise HTTPException(400, f"Outil inconnu : {unknown[0]}. Possibles : {', '.join(ROUTINE_TOOLS)}")
    return sorted({toolset for n in names for toolset in ROUTINE_TOOLS[n]})


async def routine_image(model: str) -> str:
    if model not in {m["id"] for m in await available("image")}:
        raise HTTPException(400, f"Modèle d'image inconnu : {model}")
    return model


def with_image_note(prompt: str, model: str | None) -> str:
    """Hermes ne connaît pas nos médias : l'agent le lit dans sa consigne. L'écran ne montre que la consigne de la personne."""
    prompt = _IMAGE_NOTE.sub("", prompt)
    return f"{prompt}\n\n[Réglage de cette routine : pour une image, ajoute --modele {model} à noah.py image.]" if model else prompt


def shown_routine(agent_id: str, routine: dict) -> dict:
    """Ce que l'écran et l'agent lisent : le choix en clair, sans jeton ni note technique."""
    routine = dict(routine)
    found = _IMAGE_NOTE.search(routine.get("prompt") or "")
    routine["image"] = found.group(1) if found else None
    routine["prompt"] = _IMAGE_NOTE.sub("", routine.get("prompt") or "")
    model = routine.pop("model", None) or ""
    routine["modele"] = None
    routine["fournisseur"] = None
    if model.startswith(ROUTINE_PREFIX):
        pin = _pins(agent_id).get(model[len(ROUTINE_PREFIX):].split("/", 1)[0]) or {}
        routine["modele"] = pin.get("mode") or pin.get("modele")
        routine["fournisseur"] = pin.get("fournisseur")
    toolsets = routine.pop("enabled_toolsets", None)
    routine["outils"] = None if toolsets is None else [n for n, sets in ROUTINE_TOOLS.items() if set(sets) <= set(toolsets)]
    return routine


# --- Réglages > Modèles et budget -------------------------------------------------------------------------------------

_brain_changed = None  # posé par main : la nouvelle valeur part dans les fichiers des agents, sans les arrêter


def on_brain_change(callback) -> None:
    global _brain_changed
    _brain_changed = callback


def _check_level(level: str) -> None:
    if level not in LEVELS:
        raise HTTPException(404, "Niveau inconnu")


def _row(link: dict | None, models: dict[tuple[str, str], dict]) -> dict | None:
    if not link:
        return None
    m = models.get((link.get("fournisseur", ""), link["modele"])) or {}
    return {**link, "nom": m.get("name") or link["modele"], "price_in": m.get("price_in"), "price_out": m.get("price_out"),
            "free": bool(m.get("free")), "prix": m.get("prix"), "inconnu": not m}


async def state(level: str) -> dict:
    models = await available(level)
    index = {(m["fournisseur"], m["id"]): m for m in models}
    own = _level(level).get("surcharges") or {}
    rows = [{"id": tier, "personnalise": tier in own, "modele": _row(await tier_link(level, tier, models), index)} for tier in TIERS]
    return {"niveau": level, "actif": active(level), "en_service": _in_service(level), "modes": rows,
            "gratuit": [_row(link, index) for link in _free_links(level, models, rotate=False)],
            "custom": [_row(link, index) for link in await links_of(level, "custom")]}


def _owner_for_level(level: str, user: int) -> None:
    if level != BRAIN and not access.is_owner(user):  # la création et la voix valent pour tout le serveur
        raise HTTPException(403, "Réservé au propriétaire de ce Noah Agent.")


@router.get("/api/modes/{level}")
async def get_modes(level: str, user: int = Depends(auth.current_user)):
    _check_level(level)
    _owner_for_level(level, user)
    return await state(level)


@router.get("/api/modes/{level}/modeles")
async def get_mode_models(level: str, user: int = Depends(auth.current_user)):
    _check_level(level)
    _owner_for_level(level, user)
    keep = ("id", "name", "lab", "created", "context", "price_in", "price_out", "vision", "free", "fournisseur", "prix")
    return {"modeles": [{k: m.get(k) for k in keep} for m in await available(level)]}


class Link(BaseModel):
    modele: str = Field(min_length=1, max_length=200)
    fournisseur: str | None = Field(default=None, max_length=40)


class ModeChange(BaseModel):
    actif: str | None = Field(default=None, max_length=20)  # vide : quitter les modes
    mode: str | None = Field(default=None, max_length=20)
    modele: str | None = Field(default=None, max_length=200)  # avec mode ; vide : le choix de Noah
    fournisseur: str | None = Field(default=None, max_length=40)
    chaine: list[Link] | None = Field(default=None, max_length=CUSTOM_MAX)


async def _apply(level: str, data: dict) -> None:
    """Le mode actif pose son premier modèle dans le réglage en service. Gratuit via OpenRouter sans ce fournisseur pour cerveau : le
    réglage garde un modèle que le fournisseur du cerveau comprend, et la chaîne seule passe par OpenRouter."""
    mode = data.get("actif")
    if mode not in MODES:
        return
    links = await links_of(level, mode, rotate=False)
    if not links:
        raise HTTPException(400, "Ce mode n'a encore aucun modèle disponible.")
    if level == BRAIN:
        provider = db.get_setting("provider")
        first = next((link["modele"] for link in links if link["fournisseur"] == provider), None) or _in_service(level)
    else:
        first = links[0]["modele"]
    db.set_setting(_setting_key(level), first)
    data["pose"] = first
    if level == BRAIN and _brain_changed:
        await _brain_changed()
    if level != BRAIN:
        from . import media

        media.forget_voice()


_changing = asyncio.Lock()  # lecture, attentes, écriture : deux changements en même temps s'écraseraient


@router.put("/api/modes/{level}")
async def change_modes(level: str, body: ModeChange, _: int = Depends(access.owner_only)):
    async with _changing:
        return await _change_modes(level, body)


async def _change_modes(level: str, body: ModeChange):
    _check_level(level)
    if level == BRAIN and not db.get_setting("provider"):
        raise HTTPException(400, "Choisis d'abord un cerveau.")
    data = _level(level)
    fields = body.model_fields_set
    if body.chaine is not None:
        links, seen = [], set()
        for link in body.chaine:
            checked = await _validated(level, link.modele, link.fournisseur)
            if (checked["fournisseur"], checked["modele"]) not in seen:
                seen.add((checked["fournisseur"], checked["modele"]))
                links.append(checked)
        data["custom"] = links
    if body.mode is not None:
        if body.mode not in TIERS:
            raise HTTPException(400, "Mode inconnu")
        own = data.get("surcharges") or {}
        if body.modele:
            own[body.mode] = await _validated(level, body.modele, body.fournisseur)
        else:
            own.pop(body.mode, None)
        data["surcharges"] = own
    if "actif" in fields:
        if body.actif and body.actif not in MODES:
            raise HTTPException(400, "Mode inconnu")
        if not body.actif and level != BRAIN:
            db.set_setting(_setting_key(level), "auto")
        data["actif"] = body.actif or None
    elif data.get("pose") != _in_service(level):
        data["actif"] = None  # le mode avait été quitté : changer un mode ne le remet pas en service
    before = _level(level)
    _save_level(level, data)  # les chaînes se lisent dans les réglages : ils doivent déjà porter ce changement
    try:
        await _apply(level, data)
    except HTTPException:
        _save_level(level, before)
        raise
    _save_level(level, data)
    return await state(level)
