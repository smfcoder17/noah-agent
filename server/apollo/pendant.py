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

TRI, WAITING, DONE, CANCELLED = "tri", "attente", "fait", "annule"

_drains: dict[str, asyncio.Task] = {}
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


def get(request_id: str) -> dict | None:
    with db.connect() as c:
        row = c.execute("SELECT * FROM pending_requests WHERE id = ?", (request_id,)).fetchone()
    return dict(row) if row else None


def settle(request_id: str, status: str, result: dict | None = None) -> None:
    with db.connect() as c:
        c.execute("UPDATE pending_requests SET status = ?, result = ? WHERE id = ?", (status, json.dumps(result) if result else None, request_id))


def known_result(request_id: str) -> dict | None:
    row = get(request_id)
    return json.loads(row["result"]) if row and row["result"] else None


def take(request_id: str, status: str = WAITING) -> bool:
    """Prend une demande : un seul preneur, même à plusieurs en même temps."""
    with db.connect() as c:
        return c.execute("UPDATE pending_requests SET status = ? WHERE id = ? AND status = ?", (DONE, request_id, status)).rowcount == 1


def waiting(conv: str) -> list[dict]:
    with db.connect() as c:
        rows = c.execute("SELECT id, text FROM pending_requests WHERE conversation_id = ? AND status = ? ORDER BY created_at, id", (conv, WAITING)).fetchall()
    return [dict(r) for r in rows]


def _oldest(conv: str) -> dict | None:
    with db.connect() as c:
        row = c.execute("SELECT * FROM pending_requests WHERE conversation_id = ? AND status = ? ORDER BY created_at, id LIMIT 1", (conv, WAITING)).fetchone()
    return dict(row) if row else None


async def _drain(agent_id: str, conv: str) -> None:
    while (row := _oldest(conv)) is not None:
        if not _h["allowed"](row["user_id"], agent_id):  # accès retiré depuis la demande : elle ne part plus
            settle(row["id"], CANCELLED)
        elif time.time() - row["created_at"] > WAIT:
            if take(row["id"]):
                _h["expired"](row)
        elif _h["busy"](agent_id, conv) or _h["paused"]():
            await asyncio.sleep(POLL)
        elif take(row["id"]):
            await _h["run_turn"](row)


def start(agent_id: str, conv: str) -> None:
    task = _drains.get(conv)
    if task is None or task.done():
        _drains[conv] = asyncio.create_task(_drain(agent_id, conv))


def resume() -> None:
    """Au démarrage : ce qui attendait repart, et un tri coupé en plein vol devient une demande à la suite plutôt qu'une perte."""
    with db.connect() as c:
        c.execute("DELETE FROM pending_requests WHERE status IN (?, ?) AND created_at < ?", (DONE, CANCELLED, time.time() - KEEP))
        c.execute("UPDATE pending_requests SET status = ? WHERE status = ?", (WAITING, TRI))
        rows = c.execute("SELECT DISTINCT agent_id, conversation_id FROM pending_requests WHERE status = ?", (WAITING,)).fetchall()
    for row in rows:
        start(row["agent_id"], row["conversation_id"])
