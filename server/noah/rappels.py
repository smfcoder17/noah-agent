"""Rappels vocaux : un agent fait sonner l'appareil de la personne, qui répond ou refuse.
Sorti de coordination.py sans changement de comportement. Les constantes et l'état de coordination (`_h`, `RING_SECONDS`, …)
se lisent `coordination.X` au moment de l'appel : les tests les remplacent dans `coordination`."""
import asyncio
import contextlib
import sqlite3
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, coordination, db, desktop, machine, notifications, precall, push, relay

router = APIRouter()


class Report(BaseModel):
    texte: str = Field(min_length=1, max_length=2000)


def _report_conversation(agent_id: str, user: int) -> str:
    return coordination._main(agent_id) if user == coordination.user_of(agent_id) else (coordination._h["main_conversation"](agent_id, user)
        or coordination._h["new_conversation"](user, agent_id, "Conversation", main=True))


def _report_in_writing(agent_id: str, texte: str, actions: str = "") -> None:
    """Rappel refusé par le réglage de la personne : le compte rendu reste écrit et part en notification normale."""
    user = access.launcher(agent_id)
    conv = _report_conversation(agent_id, user)
    written = f"{texte}{actions}"
    coordination._h["save"](conv, "agent", written)
    if conv not in relay.active.get(agent_id, []):
        machine.add_context(conv, written)
    desktop.notify_user(user, coordination._name(agent_id), notifications.first_sentence(texte), "fin", notifications.conversation_url(agent_id, conv))
    notifications.note_reported(agent_id, user)


def _ring(agent_id: str, texte: str, actions: str = "", user: int | None = None) -> dict:
    now, call_id = time.time(), uuid.uuid4().hex[:12]
    with db.connect() as c:
        recent = c.execute("SELECT COUNT(*) AS n FROM voice_calls WHERE agent_id = ? AND created_at > ?", (agent_id, now - coordination.HOUR)).fetchone()["n"]
    if recent >= coordination.CALLS_PER_HOUR:
        raise HTTPException(429, f"Limite atteinte : {coordination.CALLS_PER_HOUR} rappels par heure. Écris plutôt dans ta conversation.")
    # Le propriétaire de l'agent, ou le profil partagé qui a lancé la tâche : c'est à lui que ce compte rendu s'adresse.
    owner, user = coordination.user_of(agent_id), user or access.launcher(agent_id)
    if notifications.call_choice(user) == notifications.CALLS_NEVER:
        raise HTTPException(403, notifications.REFUSED)  # réglage de cette personne : le serveur l'impose, rien ne sonne
    conv = _report_conversation(agent_id, user)
    with db.connect() as c:
        c.execute("INSERT INTO voice_calls (id, agent_id, user_id, conversation_id, texte, etat, created_at) "
                  "VALUES (?, ?, ?, ?, ?, 'sonne', ?)", (call_id, agent_id, user, conv, texte, now))
    _calls_changed()
    written = f"**Je t'ai appelé.** {texte}{actions}"
    coordination._h["save"](conv, "agent", written)
    if conv not in relay.active.get(agent_id, []):  # depuis un fil : sa conversation principale ne le sait pas encore
        machine.add_context(conv, written)
    with db.connect() as c:
        look = c.execute("SELECT color, shape, detail FROM agents WHERE id = ?", (agent_id,)).fetchone()
    # Le visage de l'agent sur l'écran d'appel du téléphone : couleur, forme et détail.
    face = {"agent_id": agent_id, "couleur": look["color"] or "", "forme": look["shape"] or "", "detail": look["detail"] or ""} if look else None
    push.notify(f"{coordination._name(agent_id)} t'appelle", texte[:200], url=f"/#appel={call_id}", urgent=True, user_id=user, extra=face, kind="appels")
    notifications.note_reported(agent_id, user)  # la fin de cette tâche ne le préviendra pas une seconde fois
    if user != owner:  # le propriétaire sait que son agent a appelé, sans lire ce qui ne lui est pas adressé
        push.notify(f"{coordination._name(agent_id)} a rappelé {access.username(user)}", "Le compte rendu est dans sa conversation.", user_id=owner, kind="appels")
    precall.prepare(agent_id, user, texte)  # au décroché, la voix sait déjà de quoi il s'agit
    coordination._spawn(_expire_later(coordination.RING_SECONDS))
    return {"id": call_id, "etat": "sonne"}


@router.post("/agent-api/rappel")
async def agent_call_back(body: Report, request: Request):
    me = relay._agent_from(request)
    if access.ambiguous(me):  # le compte rendu de l'un ne doit pas partir chez l'autre, ni chez le propriétaire
        raise HTTPException(409, "Plusieurs personnes te parlent en ce moment : écris ton compte rendu dans la conversation, sans rappeler.")
    texte = body.texte.strip()
    if not texte:
        raise HTTPException(400, "Compte rendu vide.")
    actions = coordination._actions_line(relay.active.get(me, []))
    if notifications.call_choice(access.launcher(me)) == notifications.CALLS_NEVER:
        _report_in_writing(me, texte, actions)
        raise HTTPException(403, notifications.REFUSED)
    return _ring(me, texte, actions)


ENDINGS = {"repondu": "Appel pris.", "refuse": "Appel refusé : le compte rendu reste écrit ici.",
           "manque": "Appel manqué : le compte rendu reste écrit ici."}


# Les téléphones en attente longue dorment jusqu'à un appel créé ou fini : la base n'est relue qu'à ce moment-là.
_call_waiters: set[asyncio.Event] = set()
_call_loop: asyncio.AbstractEventLoop | None = None
CALLS_FALLBACK = 5  # relecture de secours, au cas où un réveil se perdrait


def _calls_changed() -> None:
    """Depuis n'importe quel thread : réveille les attentes longues."""
    loop = _call_loop
    if loop is None or not _call_waiters:
        return

    def wake():
        for event in _call_waiters:
            event.set()
    try:
        loop.call_soon_threadsafe(wake)
    except RuntimeError:  # boucle fermée : la relecture de secours prend le relais
        pass


def _close(call_id: str, etat: str) -> bool:
    """Passe de « sonne » à son issue, une seule fois, et l'écrit dans la conversation."""
    with db.connect() as c:
        done = c.execute("UPDATE voice_calls SET etat = ?, ended_at = ? WHERE id = ? AND etat = 'sonne'",
                         (etat, time.time(), call_id)).rowcount == 1
        row = c.execute("SELECT conversation_id FROM voice_calls WHERE id = ?", (call_id,)).fetchone()
    if done:
        _calls_changed()
        try:
            coordination._h["save"](row["conversation_id"], "agent", ENDINGS[etat])
        except sqlite3.IntegrityError:  # conversation supprimée entre-temps
            pass
    return done


def _expire() -> None:
    with db.connect() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM voice_calls WHERE etat = 'sonne' AND created_at <= ?",
                                          (time.time() - coordination.RING_SECONDS,))]
    for call_id in ids:
        _close(call_id, "manque")


async def _expire_later(seconds: float) -> None:
    await asyncio.sleep(seconds)
    _expire()


def _public(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "agent_id": r["agent_id"], "agent": r["agent"] or r["agent_id"], "conversation_id": r["conversation_id"],
            "texte": r["texte"], "etat": r["etat"], "expire_a": r["created_at"] + coordination.RING_SECONDS, "couleur": r["color"] or "",
            "forme": r["shape"] or "", "detail": r["detail"] or ""}


CALL_ROW = "SELECT v.*, a.name AS agent, a.color AS color, a.shape AS shape, a.detail AS detail FROM voice_calls v LEFT JOIN agents a ON a.id = v.agent_id "


def _call(call_id: str, user: int) -> sqlite3.Row:
    with db.connect() as c:
        row = c.execute(CALL_ROW + "WHERE v.id = ? AND v.user_id = ?", (call_id, user)).fetchone()
    if not row or not access.allowed(user, row["agent_id"]):  # accès retiré : son rappel part avec lui
        raise HTTPException(404, "Appel introuvable")
    return row


@router.get("/api/calls/pending")
def calls_pending(user: int = Depends(auth.current_user)):
    _expire()
    with db.connect() as c:
        rows = c.execute(CALL_ROW + "WHERE v.user_id = ? AND v.etat = 'sonne' ORDER BY v.created_at", (user,)).fetchall()
    return {"appels": [_public(r) for r in rows if access.allowed(user, r["agent_id"])]}


@router.get("/api/calls/wait")
async def calls_wait(secondes: int = 50, connus: str = "", user: int = Depends(auth.current_user)):
    """Attente longue d'un téléphone sans service de notification : répond dès que les appels qui sonnent changent."""
    global _call_loop
    known = {k for k in connus.split(",") if k}
    limit = time.monotonic() + max(1, min(secondes, 55))
    _call_loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    _call_waiters.add(wake)  # avant la lecture : un appel créé entre les deux réveille quand même
    try:
        while True:
            wake.clear()
            found = await asyncio.to_thread(calls_pending, user)
            left = limit - time.monotonic()
            if {a["id"] for a in found["appels"]} != known or left <= 0:
                return found
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(wake.wait(), min(left, CALLS_FALLBACK))
    finally:
        _call_waiters.discard(wake)


@router.get("/api/calls/{call_id}")
def call_detail(call_id: str, user: int = Depends(auth.current_user)):
    """Pour l'adresse d'une notification : elle a pu être touchée après la fin de la sonnerie."""
    _expire()
    return _public(_call(call_id, user))


def _decide(call_id: str, user: int, etat: str) -> dict:
    _expire()
    _call(call_id, user)
    if not _close(call_id, etat):
        raise HTTPException(409, "Cet appel ne sonne plus.")
    return _public(_call(call_id, user))


@router.post("/api/calls/{call_id}/answer")
def call_answer(call_id: str, user: int = Depends(auth.current_user)):
    return _decide(call_id, user, "repondu")


@router.post("/api/calls/{call_id}/decline")
def call_decline(call_id: str, user: int = Depends(auth.current_user)):
    return _decide(call_id, user, "refuse")
