"""Flux durable par compte. Le compteur survit à l'élagage et aux redémarrages."""
import asyncio
import json
import time
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import auth, db

KEEP = 300
KEEPALIVE = 15
POLL = 0.2


@asynccontextmanager
async def lifespan(app):
    stopping = asyncio.Event()
    app.state.noah_events_stopping = stopping
    try:
        yield {"noah_events_stopping": stopping}
    finally:
        stopping.set()


router = APIRouter(lifespan=lifespan)


class EventResponse(StreamingResponse):
    async def stream_response(self, send):
        try:
            await super().stream_response(send)
        except OSError:
            # ASGI : une écriture peut apprendre la coupure avant http.disconnect.
            pass
        finally:
            await self.body_iterator.aclose()


def publish(c, user: int, genre: str, contenu: dict) -> int:
    """Dans la transaction du changement : aucune clôture sans son événement."""
    row = c.execute("INSERT INTO evenements_revisions VALUES (?, 1) ON CONFLICT(user_id) "
                    "DO UPDATE SET revision = revision + 1 RETURNING revision", (user,)).fetchone()
    revision = row["revision"]
    c.execute("INSERT INTO evenements VALUES (?, ?, ?, ?, ?)",
              (user, revision, genre, json.dumps(contenu, ensure_ascii=False), time.time()))
    prune(c)
    return revision


def prune(c) -> None:
    c.execute("DELETE FROM evenements WHERE created <= ?", (time.time() - KEEP,))


def replay(user: int, after: int | None):
    with db.connect() as c:
        # Même instantané pour le compteur et les lignes, y compris si un autre thread publie.
        c.execute("BEGIN")
        row = c.execute("SELECT revision FROM evenements_revisions WHERE user_id = ?", (user,)).fetchone()
        revision = row["revision"] if row else 0
        rows = c.execute("SELECT * FROM evenements WHERE user_id = ? AND created > ? ORDER BY revision",
                         (user, time.time() - KEEP)).fetchall()
    floor = rows[0]["revision"] - 1 if rows else revision
    gap = after is not None and (after < floor or after > revision)
    return revision, gap, [r for r in rows if after is not None and r["revision"] > after]


def frame(revision: int, genre: str, data) -> str:
    return f"id: {revision}\nevent: {genre}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def stream(user: int, after: int | None, stopping: asyncio.Event | None = None):
    if stopping is not None and stopping.is_set():
        return
    revision, gap, rows = replay(user, after)
    if gap:
        yield frame(revision, "resync", {})
        return
    if after is None:
        after = revision
    for row in rows:
        after = row["revision"]
        yield frame(after, row["genre"], json.loads(row["contenu"]))
    yield frame(after, "pret", {})
    alive = time.monotonic()
    while stopping is None or not stopping.is_set():
        await asyncio.sleep(POLL)
        if stopping is not None and stopping.is_set():
            return
        revision, gap, rows = replay(user, after)
        if gap:
            yield frame(revision, "resync", {})
            return
        for row in rows:
            after = row["revision"]
            yield frame(after, row["genre"], json.loads(row["contenu"]))
        if time.monotonic() - alive >= KEEPALIVE:
            yield ": vivant\n\n"
            alive = time.monotonic()


@router.get("/api/events")
async def events(request: Request, user: int = Depends(auth.current_user)):
    last = request.headers.get("last-event-id")
    try:
        after = int(last) if last else None
        if after is not None and after < 0:
            raise ValueError()
    except ValueError:
        raise HTTPException(400, "Révision invalide") from None
    token = auth.request_token(request, request.cookies.get(auth.COOKIE))
    stopping = request.app.state.noah_events_stopping
    return EventResponse(auth.revocable(stream(user, after, stopping), token), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
