"""Le premier message après un redémarrage d'agent ne paie pas son démarrage.

La gateway Hermes dit qu'elle va bien bien avant d'être prête à répondre vite : son premier tour charge encore le client du
modèle, ses outils et son flux (3 à 8 s mesurées, tests/real/vitesse.py), contre 0,2 s ensuite. Dès qu'un agent revient, le serveur
lui fait donc faire un tour complet, sur une session à part, que le relais reconnaît et sert lui-même : ni modèle, ni dépense.
"""
import asyncio
import uuid

import httpx

from . import hermes
from .relay import warmup_mark

SESSION = "noah-chauffe"
EVERY = 5  # secondes entre deux regards : Hermes met bien plus longtemps à redémarrer
RUN_LIMIT = 90
COMPACT_LIMIT = 300
FORGET_TRIES = 10

_warm: set[str] = set()


async def warm(agent: hermes.Agent) -> bool:
    """Un tour complet, puis sa session s'efface : elle ne doit pas ressortir dans les recherches de l'agent."""
    session = f"{SESSION}-{uuid.uuid4().hex[:12]}"
    try:
        run_id = await hermes.start_run(agent, warmup_mark(agent.id), session)
        async with asyncio.timeout(RUN_LIMIT):
            async for kind, _ in hermes.run_events(agent, run_id):
                if kind in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
                    break
        await _forget(agent, session)
    except (httpx.HTTPError, TimeoutError, KeyError, ValueError) as e:
        print(f"[chauffe] {agent.id} : {type(e).__name__}: {e}", flush=True)
        return False
    return True


async def compact(agent: hermes.Agent, session: str) -> None:
    """Le contexte a passé la limite : Hermes résumera son début au prochain tour, avant de répondre, et ce résumé prend de 5 à 60 s.
    Un tour d'entretien le fait maintenant, pendant que personne n'attend."""
    try:
        run_id = await hermes.start_run(agent, warmup_mark(agent.id), session)
        async with asyncio.timeout(COMPACT_LIMIT):
            async for kind, _ in hermes.run_events(agent, run_id):
                if kind in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
                    break
    except (httpx.HTTPError, TimeoutError, KeyError, ValueError) as e:
        print(f"[chauffe] résumé d'avance sur {agent.id} : {type(e).__name__}: {e}", flush=True)


async def _forget(agent: hermes.Agent, session: str) -> None:
    """Hermes referme un tour juste après son dernier événement : on lui laisse le temps avant d'effacer sa session."""
    for _ in range(FORGET_TRIES):
        r = await hermes.http().delete(f"{agent.url}/api/sessions/{session}", headers=agent.headers, timeout=10)
        if r.status_code != 409:
            return
        await asyncio.sleep(1)


async def run(agents, ready) -> None:
    """`agents()` : les agents à garder chauds. `ready(id)` : pas pendant une mise à jour, une préparation ou un tour en cours."""
    while True:
        await asyncio.sleep(EVERY)
        try:
            await _pass(agents, ready)
        except Exception as e:  # noqa: BLE001 - la chauffe ne doit jamais s'arrêter pour de bon
            print(f"[chauffe] {type(e).__name__}: {e}", flush=True)


async def _pass(agents, ready) -> None:
    for agent in agents():
        if not await hermes.health(agent):
            _warm.discard(agent.id)  # il a redémarré ou va le faire : à refaire quand il revient
        elif agent.id not in _warm and ready(agent.id):
            # Un agent à la fois : sur un petit serveur, plusieurs démarrages en même temps ralentiraient celui qui parle.
            if await warm(agent):
                _warm.add(agent.id)
