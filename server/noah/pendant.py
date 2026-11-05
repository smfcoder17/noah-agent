"""Parler à l'agent pendant qu'il travaille : ce qui attend est écrit en base avant d'être acquitté.

Un message envoyé en plein travail passe par un tri (réponse rapide, précision transmise, ou à la suite). Ceux qui attendent
leur tour restent ici : un redémarrage ne les perd pas, et un même envoi retransmis n'en fait qu'un (identifiant du client).
Une seule boucle par conversation les fait partir dans l'ordre, chacun quand le précédent a fini.
"""
import asyncio
import json
import time

from . import db

WAIT = 24 * 3600  # l'agent peut travailler longtemps ; au bout d'un jour, la demande abandonne et le dit
POLL = 2
KEEP = 7 * 24 * 3600  # les envois déjà traités servent à reconnaître une retransmission, puis s'effacent

# tri : reçu, en cours de classement. attente : à son tour. en_cours : prise, pas encore chez l'agent. transmission : envoyée à un run,
# réponse inconnue. repondu : question qui a eu sa réponse (peut encore être transmise). fait et annule : terminées.
TRI, WAITING, RUNNING, SENDING, ANSWERED, DONE, CANCELLED = "tri", "attente", "en_cours", "transmission", "repondu", "fait", "annule"
TRI_MAX = 120  # un tri prend quelques secondes ; au-delà, il a échoué sans le dire et ne doit plus retenir la file

_drains: dict[str, asyncio.Task] = {}
_freed_events: dict[str, asyncio.Event] = {}
_h: dict = {}


def setup(**hooks) -> None:
    """busy(agent, conv), paused(), allowed(user, agent), run_turn(row), expired(row) : ce que seul main.py sait faire."""
    _h.update(hooks)


def add(request_id: str, conv: str, agent_id: str, user: int, text: str, status: str = WAITING) -> bool:
    """False si cet envoi est déjà connu : une retransmission ne fait pas une seconde demande."""
    with db.connect() as c:
        return c.execute(
            "INSERT OR IGNORE INTO pending_requests (id, conversation_id, agent_id, user_id, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (request_id, conv, agent_id, user, text, status, time.time()),
        ).rowcount == 1


def forget(request_id: str) -> None:
    """Cet envoi n'a rien lancé : le même identifiant peut revenir."""
    with db.connect() as c:
        c.execute("DELETE FROM pending_requests WHERE id = ?", (request_id,))


def get(request_id: str) -> dict | None:
    with db.connect() as c:
        row = c.execute("SELECT * FROM pending_requests WHERE id = ?", (request_id,)).fetchone()
    return dict(row) if row else None


def settle(request_id: str, status: str, result: dict | None = None) -> None:
    with db.connect() as c:
        c.execute("UPDATE pending_requests SET status = ?, result = COALESCE(?, result) WHERE id = ?", (status, json.dumps(result) if result else None, request_id))


def known_result(request_id: str) -> dict | None:
    row = get(request_id)
    return json.loads(row["result"]) if row and row["result"] else None


def move(request_id: str, allowed: tuple[str, ...], status: str) -> bool:
    """Change d'état seulement depuis ceux permis : un seul gagnant, même à plusieurs en même temps."""
    marks = ", ".join("?" * len(allowed))
    with db.connect() as c:
        return c.execute(f"UPDATE pending_requests SET status = ? WHERE id = ? AND status IN ({marks})", (status, request_id, *allowed)).rowcount == 1


def take(request_id: str) -> bool:
    return move(request_id, (WAITING,), RUNNING)


def waiting(conv: str) -> list[dict]:
    with db.connect() as c:
        rows = c.execute("SELECT id, text FROM pending_requests WHERE conversation_id = ? AND status = ? ORDER BY created_at, id", (conv, WAITING)).fetchall()
    return [dict(r) for r in rows]


def _next(conv: str) -> dict | None:
    """La plus ancienne pas encore partie. Si elle est encore au tri, elle retient les suivantes : l'ordre d'écriture reste celui d'exécution."""
    with db.connect() as c:
        row = c.execute("SELECT * FROM pending_requests WHERE conversation_id = ? AND status IN (?, ?) ORDER BY created_at, id LIMIT 1", (conv, TRI, WAITING)).fetchone()
    return dict(row) if row else None


async def _freed(conv: str) -> None:
    """Le tour d'avant vient de finir, ou POLL s'est écoulé : ce qui attend repart sans laisser un blanc."""
    event = _freed_events.setdefault(conv, asyncio.Event())
    event.clear()
    try:
        await asyncio.wait_for(event.wait(), POLL)
    except asyncio.TimeoutError:
        pass
    finally:
        _freed_events.pop(conv, None)


def wake(conv: str) -> None:
    event = _freed_events.get(conv)
    if event:
        event.set()


async def _drain(agent_id: str, conv: str) -> None:
    while (row := _next(conv)) is not None:
        if row["status"] == TRI:
            if time.time() - row["created_at"] > TRI_MAX:
                move(row["id"], (TRI,), WAITING)
            else:
                await asyncio.sleep(POLL)
        elif not _h["allowed"](row["user_id"], agent_id):  # accès retiré depuis la demande : elle ne part plus
            settle(row["id"], CANCELLED)
        elif time.time() - row["created_at"] > WAIT:
            if move(row["id"], (WAITING,), DONE):
                _h["expired"](row)
        elif _h["busy"](agent_id, conv) or _h["paused"]():
            await _freed(conv)
        elif take(row["id"]):
            await _h["run_turn"](row)


def start(agent_id: str, conv: str) -> None:
    task = _drains.get(conv)
    if task is None or task.done():
        _drains[conv] = asyncio.create_task(_drain(agent_id, conv))


def resume() -> None:
    """Au démarrage : ce qui attendait repart. Un tri coupé attend son tour. Une demande prise mais jamais arrivée chez l'agent repart,
    sans doubler son message. Une transmission coupée ne repart pas : l'agent l'a peut-être reçue, et la personne le saura."""
    with db.connect() as c:
        c.execute("DELETE FROM pending_requests WHERE status IN (?, ?) AND created_at < ?", (DONE, CANCELLED, time.time() - KEEP))
        taken = [dict(r) for r in c.execute("SELECT * FROM pending_requests WHERE status = ?", (RUNNING,)).fetchall()]
        unsure = [dict(r) for r in c.execute("SELECT * FROM pending_requests WHERE status = ?", (SENDING,)).fetchall()]
        c.execute("UPDATE pending_requests SET status = ? WHERE status IN (?, ?)", (WAITING, TRI, RUNNING))
        c.execute("UPDATE pending_requests SET status = ? WHERE status = ?", (DONE, SENDING))
        rows = c.execute("SELECT DISTINCT agent_id, conversation_id FROM pending_requests WHERE status = ?", (WAITING,)).fetchall()
    for row in taken:
        _h["requeued"](row)
    for row in unsure:
        _h["unsure"](row)
    for row in rows:
        start(row["agent_id"], row["conversation_id"])
