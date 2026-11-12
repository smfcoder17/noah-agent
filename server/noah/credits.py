"""Crédits du fournisseur : quand le plafond de la clé du cerveau baisse, la personne le sait avant que ses agents s'arrêtent.

Seul OpenRouter dit ce qui reste sur une clé (GET /api/v1/key, avec la clé que la personne a déjà donnée) ; pour un
fournisseur sans solde lisible, ou une clé sans plafond, rien n'est lu ni annoncé. Une alerte par seuil (20 %, puis 5 %),
une seule fois tant que le solde ne remonte pas au-dessus du premier seuil.
"""
import asyncio

import httpx

from . import db, desktop

KEY_URL = "https://openrouter.ai/api/v1/key"
LEVELS = (0.05, 0.20)  # du plus bas au plus haut : le plus bas atteint l'emporte
EVERY = 3600  # une lecture par heure suffit : un solde ne fond pas en une minute
SETTING = "credits_alerte"


def _key() -> str | None:
    if db.get_setting("provider") != "openrouter" or not db.get_setting("api_key"):
        return None
    return db.get_setting("api_key", secret=True)


async def read_remaining() -> tuple[float, float] | None:
    """(reste, plafond) de la clé du cerveau, ou None : autre fournisseur, clé sans plafond, réponse illisible."""
    key = _key()
    if not key:
        return None
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(KEY_URL, headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    data = (r.json() or {}).get("data") or {}
    limit, left = data.get("limit"), data.get("limit_remaining")
    if not isinstance(limit, (int, float)) or not isinstance(left, (int, float)) or limit <= 0:
        return None
    return float(left), float(limit)


def _money(x: float) -> str:
    return f"{x:.2f}".replace(".", ",") + " $"


async def check() -> str | None:
    """Une lecture ; rend le seuil annoncé à l'instant, s'il y en a un."""
    try:
        got = await read_remaining()
    except (httpx.HTTPError, ValueError):
        return None  # injoignable : le prochain passage relira, rien à dire à la personne
    if not got:
        return None
    left, limit = got
    share = left / limit
    level = next((lv for lv in LEVELS if share <= lv), None)
    if level is None:
        db.set_setting(SETTING, "")  # remonté (recharge, plafond relevé) : les seuils préviennent de nouveau
        return None
    tag = f"{int(level * 100)}"
    said = (db.get_setting(SETTING) or "").split(",")
    if tag in said:
        return None
    db.set_setting(SETTING, ",".join([s for s in said if s] + [tag]))
    desktop.notify(f"Crédits OpenRouter : moins de {tag} %",
                   f"Il reste {_money(left)} sur les {_money(limit)} du plafond de ta clé OpenRouter. "
                   "Recharge ou relève le plafond sur openrouter.ai, sinon tes agents s'arrêteront.", kind="plafond")
    return tag


async def run_forever() -> None:
    while True:
        await asyncio.sleep(EVERY)  # pas au démarrage : un redémarrage ne doit pas solliciter le fournisseur
        await check()
