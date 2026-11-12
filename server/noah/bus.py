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
POLL = 0.2  # seulement juste après un réveil : la publication précède le commit de sa transaction
SETTLE = 2  # durée pendant laquelle un réveil sans ligne visible est relu à ce rythme
FALLBACK = 3  # au repos : une lecture de secours, au cas où un réveil se perdrait

# Un seul processus sert l'app (serve.py lance un uvicorn.Server sans workers) : un réveil en mémoire suffit.
_waiters: dict[int, set[asyncio.Event]] = {}
_loop: asyncio.AbstractEventLoop | None = None


def _wake(user: int) -> None:
    for event in _waiters.get(user, ()):
        event.set()


def _notify(user: int) -> None:
    """Depuis n'importe quel thread : réveille les flux ouverts de ce compte."""
    loop = _loop
    if loop is None or user not in _waiters:
        return
    try:
        loop.call_soon_threadsafe(_wake, user)
    except RuntimeError:  # boucle fermée (arrêt, test) : la lecture de secours prend le relais
        pass


async def _wait(wake: asyncio.Event, stopping: asyncio.Event | None, timeout: float) -> None:
    tasks = [asyncio.ensure_future(wake.wait())]
    if stopping is not None:
        tasks.append(asyncio.ensure_future(stopping.wait()))
    try:
        await asyncio.wait(tasks, timeout=max(0, timeout), return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()


def event_headers() -> dict:
    """Aucun relais ne doit mettre un flux en tampon ni le compresser : le texte arrive mot à mot."""
    return {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


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
    _notify(user)
    return revision


def prune(c) -> None:
    c.execute("DELETE FROM evenements WHERE created <= ?", (time.time() - KEEP,))


def invalidate(user: int | None) -> None:
    """Signal sans contenu : chaque écran relit ses propres routes et leurs droits."""
    if user is not None:
        with db.connect() as c:
            publish(c, user, "donnees.changees", {})


def invalidate_all() -> None:
    """État partagé changé en arrière-plan. Aucun contenu ne sort des routes autorisées."""
    with db.connect() as c:
        if not c.execute("SELECT 1 FROM sqlite_master WHERE name='evenements'").fetchone():
            return  # démarrage ou test avant la migration
        for row in c.execute("SELECT id FROM users").fetchall():
            publish(c, row["id"], "donnees.changees", {})


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
    global _loop
    if stopping is not None and stopping.is_set():
        return
    _loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    _waiters.setdefault(user, set()).add(wake)  # avant la première lecture : rien ne passe entre les deux
    try:
        revision, gap, rows = await asyncio.to_thread(replay, user, after)
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
        settle = 0.0  # jusqu'à quand relire vite : le réveil part avant le commit de la publication
        while stopping is None or not stopping.is_set():
            now = time.monotonic()
            pause = POLL if now < settle else FALLBACK
            await _wait(wake, stopping, min(pause, KEEPALIVE - (now - alive)))
            if stopping is not None and stopping.is_set():
                return
            if wake.is_set():
                wake.clear()
                settle = time.monotonic() + SETTLE
            revision, gap, rows = await asyncio.to_thread(replay, user, after)
            if gap:
                yield frame(revision, "resync", {})
                return
            for row in rows:
                after = row["revision"]
                yield frame(after, row["genre"], json.loads(row["contenu"]))
            if rows and not wake.is_set():
                settle = 0.0
            if time.monotonic() - alive >= KEEPALIVE:
                yield ": vivant\n\n"
                alive = time.monotonic()
    finally:
        waiting = _waiters.get(user)
        if waiting is not None:
            waiting.discard(wake)
            if not waiting:
                _waiters.pop(user, None)


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
                             headers=event_headers())
