"""Le modèle rapide : celui qui dit le premier mot le plus vite, chez le fournisseur du cerveau.

Il sert aux petites choses qui doivent être instantanées : accuser réception d'une consigne donnée en cours de route, proposer des
réponses à toucher, résumer en une phrase. Jamais aux actions : il n'a aucun outil, et rien de ce qu'il écrit n'est exécuté.

Mesuré en tâche de fond quand la clé du cerveau change, et à la demande depuis Réglages : 2 ou 3 modèles légers connus de ce
fournisseur (ou le modèle choisi, chez un fournisseur personnalisé ou local), le plus rapide qui répond juste est gardé, avec sa mesure.
"""
import asyncio
import json
import time

import httpx
from fastapi import APIRouter, Depends

from . import access, catalog, db, decision, diagnostics, relay

router = APIRouter()

KEY = "modele_rapide"
CANDIDATES = 3
SECONDS = {"ollama": 90}  # le premier appel à un modèle local le charge en mémoire
DEFAULT_SECONDS = 15
EXAM_SYSTEM = "Réponds par un seul mot, sans ponctuation : prêt."
EXAM_USER = "Es-tu là ?"


def _saved() -> dict:
    try:
        state = json.loads(db.get_setting(KEY) or "{}")
    except ValueError:
        return {}
    return state if state.get("empreinte") == decision._fingerprint() else {}  # une mesure ne vaut que pour la clé qui l'a faite


def model() -> str:
    """Le modèle rapide mesuré sur la clé actuelle, ou rien : chacun garde alors son secours d'avant."""
    return _saved().get("modele") or ""


def _candidates(provider: str, listed: list[dict]) -> list[str]:
    """Les modèles légers connus : nom de petit modèle, pas de réflexion (elle retarde le premier mot), le moins cher puis le plus petit."""
    pool = [m for m in listed if not decision.NOT_CHAT.search(m["id"]) and decision.FAST_NAME.search(m["id"]) and not decision.thinks(m["id"])]
    if provider == "openrouter":
        pool = [m for m in pool if m.get("lab") in catalog.MAJOR_LABS and not m.get("free")] or pool

    def rank(m: dict):
        price = decision._blend(m)
        return (price is None, price or 0, decision._size(m), m["id"])
    return [m["id"] for m in sorted(pool, key=rank)[:CANDIDATES]]


async def _first_word(provider: str, key: str | None, base: str, name: str) -> dict:
    """Délai du premier morceau de texte, en flux, et justesse de la réponse entière."""
    row = {"modele": name, "ms": None, "ok": False, "erreur": ""}
    body = {"model": name, "temperature": 0, "max_tokens": 10, "stream": True,
            "messages": [{"role": "system", "content": EXAM_SYSTEM}, {"role": "user", "content": EXAM_USER}]}
    if provider == "openrouter":
        body["provider"] = {"sort": "latency"}
    text, first = "", None
    started = time.monotonic()
    try:
        async with relay.upstream_client().stream("POST", f"{base}/chat/completions", json=body, headers=relay._upstream_headers(provider, key),
                                                  timeout=SECONDS.get(provider, DEFAULT_SECONDS)) as r:
            if r.status_code != 200:
                row["erreur"] = "Clé refusée." if r.status_code in (401, 403) else f"Le fournisseur a répondu {r.status_code}."
                return row
            async for line in r.aiter_lines():
                if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                    continue
                try:
                    piece = json.loads(line[5:])["choices"][0].get("delta", {}).get("content") or ""
                except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                    continue
                if piece and first is None:
                    first = int((time.monotonic() - started) * 1000)
                text += piece
    except httpx.TimeoutException:
        row["erreur"] = "Trop lent."
        return row
    except httpx.HTTPError:
        row["erreur"] = "Injoignable."
        return row
    if first is None:
        row["erreur"] = "Aucune réponse."
    elif "prêt" not in text.lower() and "pret" not in text.lower():
        row["erreur"] = "Mauvaise réponse à l'essai."
    else:
        row |= {"ms": first, "ok": True}
    return row


_lock = asyncio.Lock()


async def measure() -> dict:
    """Mesure et garde le plus rapide qui répond juste. Rien de juste : l'ancien choix s'efface, chacun reprend son secours."""
    async with _lock:
        provider, key, base_url = decision._credentials()
        if not provider:
            return {}
        base = relay.upstream_base(provider, base_url)
        brain = db.get_setting("model") or ""
        names: list[str] = []
        if provider not in relay.OWN_URL:
            try:
                names = _candidates(provider, await catalog.models_for(provider, key, base_url))
            except Exception as e:  # noqa: BLE001 - liste illisible : on mesure au moins le cerveau
                diagnostics.record("modèle rapide", f"liste des modèles : {type(e).__name__}")
        if not names and brain:
            names = [brain]
        if provider == "ollama":  # un seul modèle à la fois en mémoire : pas en parallèle
            rows = [await _first_word(provider, key, base, n) for n in names]
        else:
            rows = list(await asyncio.gather(*(_first_word(provider, key, base, n) for n in names)))
        good = sorted((r for r in rows if r["ok"]), key=lambda r: r["ms"])
        best = good[0] if good else {}
        state = {"modele": best.get("modele", ""), "ms": best.get("ms"), "candidats": rows, "quand": time.time(),
                 "empreinte": decision._fingerprint()}
        db.set_setting(KEY, json.dumps(state, ensure_ascii=False))
        return state


_tasks: set[asyncio.Task] = set()


async def _safe_measure() -> None:
    try:
        await measure()
    except Exception as e:  # noqa: BLE001
        diagnostics.record("modèle rapide", type(e).__name__)


def schedule() -> None:
    """Après la pose ou le changement d'une clé : l'écran ne l'attend pas."""
    task = asyncio.create_task(_safe_measure())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def first_measure(delay: float = 120) -> None:
    """Une installation déjà en service, mise à jour, n'a encore rien de mesuré : une mesure peu après le démarrage."""
    await asyncio.sleep(delay)
    if decision._credentials()[0] and not _saved():
        await _safe_measure()


def public() -> dict:
    state = _saved()
    return {"modele": state.get("modele") or "", "ms": state.get("ms"), "quand": state.get("quand"),
            "candidats": state.get("candidats") or [], "en_cours": _lock.locked(), "mesure": bool(state)}


@router.get("/api/modele-rapide")
def get_fast(_: int = Depends(access.owner_only)):
    return public()


@router.post("/api/modele-rapide/mesurer")
async def measure_again(_: int = Depends(access.owner_only)):
    await measure()
    return public()
