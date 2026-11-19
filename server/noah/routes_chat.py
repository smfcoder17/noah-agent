"""Chat : envoi d'un message, message à la suite, message pendant le travail, file des demandes, regard et état de la conversation.
Sorti de main.py sans changement de comportement."""
import asyncio
import contextlib
import json
import uuid
from dataclasses import replace

import httpx
from fastapi import Cookie, HTTPException, Request, Depends, APIRouter
from fastapi.responses import StreamingResponse
from pydantic import Field, BaseModel

from .hermes import Agent
from . import hermes, coordination, machine, coffre, updates, auth, db, notifications, pendant, diagnostics, handoff, access, media, accords, nettoyage, sensitive, bus, main

router = APIRouter()


def _conversation_owner(conv_id: str) -> int | None:
    """Compte à qui appartient la conversation : c'est lui, et lui seul, qu'on prévient."""
    with db.connect() as c:
        row = c.execute("SELECT user_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return row["user_id"] if row else None


def _save_message(conv_id: str, role: str, text: str, detail: str | None = None, model: str | None = None) -> None:
    posed = nettoyage.pose(role, text)  # 0.4.0 (X31) : rien d'interne dans un fil ; `[SILENT]` et la consigne de Noah ne se posent pas
    if posed is None:
        return
    text = posed
    with db.connect() as c:
        c.execute("INSERT INTO messages (conversation_id, role, text, detail, model) VALUES (?, ?, ?, ?, ?)", (conv_id, role, text, detail, model))
        c.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (conv_id,))


class ChatMessage(BaseModel):
    agent_id: str
    text: str = Field(min_length=1, max_length=20000)
    conversation_id: str | None = None
    details: bool = False
    # Chemins rendus par /upload, dans l'espace de travail de l'agent.
    attachments: list[str] = Field(default_factory=list, max_length=20)
    client_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")  # un tour d'appel renvoyé après une coupure : un seul travail


def _with_attachments(text: str, paths: list[str]) -> str:
    kept = [p for p in paths if p.startswith("/opt/data/workspace/uploads/")]
    return text + ("\n\nFichiers joints par l'utilisateur :\n" + "\n".join(f"- {p}" for p in kept) if kept else "")


@router.post("/api/chat")
async def chat(body: ChatMessage, request: Request, noah_session: str | None = Cookie(None),
               user: int = Depends(auth.current_user)):
    body.text = sensitive.mask_keys(body.text)  # une clé collée ne va ni au modèle, ni dans un titre, ni dans un journal
    agent = main._usable(user, body.agent_id)
    conv_id = body.conversation_id
    with db.connect() as c:
        if conv_id and not c.execute(
            "SELECT 1 FROM conversations WHERE id = ? AND user_id = ? AND agent_id = ?", (conv_id, user, agent.id)
        ).fetchone():
            raise HTTPException(404, "Conversation introuvable")
    if not conv_id:
        conv_id = main._main_conversation(agent.id, user) or main._new_conversation(user, agent.id, "Conversation", main=True)
    prompt = _with_attachments(body.text, body.attachments)
    notifications.set_hidden(conv_id, False)  # elle vient d'écrire : elle est là
    request_id = f"{user}:{body.client_id}" if body.client_id else None
    if request_id and not pendant.add(request_id, conv_id, agent.id, user, body.text, pendant.DONE):
        async def known():  # déjà reçu : rien ne repart, l'écran recharge la conversation
            yield main._sse({"type": "start", "conversation_id": conv_id, "run_id": _conversation_run(conv_id) or ""})
            yield main._sse({"type": "deja"})
        return StreamingResponse(known(), media_type="text/event-stream", headers=bus.event_headers())
    try:
        stream = await main._run(agent, conv_id, prompt, body.details, main._speaker(user, agent.id) + machine.pop_context(conv_id) + main._left_open(agent.id, conv_id))
    except HTTPException:
        if request_id:
            pendant.forget(request_id)
        raise
    return StreamingResponse(auth.revocable(stream, auth.request_token(request, noah_session),
                                            allowed=lambda: access.allowed(user, agent.id, "usage")),
                             media_type="text/event-stream", headers=bus.event_headers())




CLIENT_ID = r"^[A-Za-z0-9_-]{8,64}$"


class LaterMessage(BaseModel):
    agent_id: str
    text: str = Field(min_length=1, max_length=20000)
    conversation_id: str | None = None
    client_id: str | None = Field(default=None, pattern=CLIENT_ID)  # même envoi retransmis : une seule demande


class WhileBusy(BaseModel):
    agent_id: str
    text: str = Field(min_length=1, max_length=20000)
    client_id: str = Field(pattern=CLIENT_ID)
    conversation_id: str | None = None
    choix: str | None = Field(default=None, pattern="^(precision|tache)$")  # la personne a choisi elle-même : pas de tri
    garder: bool = False  # l'appel vocal garde ses demandes à la suite : il en lit le résultat
    attachments: list[str] = Field(default_factory=list, max_length=20)


async def _queued_turn(row: dict) -> None:
    """Le tour d'une demande qui attendait. Suivi jusqu'au bout : la suivante ne part qu'après."""
    agent, user = main._agent(row["agent_id"]), row["user_id"]
    try:
        stream = await main._run(agent, row["conversation_id"], row["text"], False, main._speaker(user, agent.id) + machine.pop_context(row["conversation_id"]) + main._left_open(agent.id, row["conversation_id"]), live=False)
        pendant.settle(row["id"], pendant.DONE)  # l'agent l'a : un redémarrage ne doit plus la relancer
        async for _ in stream:
            pass
    except HTTPException:  # _run a déjà écrit le message et son échec
        pass
    except Exception as e:  # noqa: BLE001
        diagnostics.failure("demande en attente", e, agent.id)
    finally:
        pendant.move(row["id"], (pendant.RUNNING,), pendant.DONE)


def _queued_requeued(row: dict) -> None:
    """Redémarrage entre la prise et l'arrivée chez l'agent : son message écrit en premier sera réécrit à son départ."""
    with db.connect() as c:
        last = c.execute("SELECT id, role, text FROM messages WHERE conversation_id = ? AND role != 'trace' ORDER BY id DESC LIMIT 1", (row["conversation_id"],)).fetchone()
        if last and last["role"] == "user" and last["text"] == row["text"]:
            c.execute("DELETE FROM messages WHERE id = ?", (last["id"],))


def _queued_unsure(row: dict) -> None:
    if not (row["result"] and json.loads(row["result"]).get("type") == "question"):  # une question est déjà écrite
        _save_message(row["conversation_id"], "user", row["text"])
    _save_message(row["conversation_id"], "agent", UNSURE_STEER)


def _queued_expired(row: dict) -> None:
    _save_message(row["conversation_id"], "user", row["text"])
    _save_message(row["conversation_id"], "error", "Cette demande n'a pas pu partir : l'agent était encore occupé au bout d'un jour. Renvoie-la si besoin.",
                  main._error_details(main._agent(row["agent_id"]), "Demande toujours en attente après le délai."))


pendant.setup(
    busy=lambda agent_id, conv: coordination._busy(agent_id, conv),
    paused=lambda: updates.maintenance,
    allowed=lambda user, agent_id: access.allowed(user, agent_id, "usage"),
    run_turn=_queued_turn,
    expired=_queued_expired,
    requeued=_queued_requeued,
    unsure=_queued_unsure,
)


async def _resume_requests() -> None:
    """Au démarrage : d'abord savoir si une mise à jour est ouverte, sinon une demande partirait pour être coupée par elle."""
    with contextlib.suppress(Exception):
        await updates._follow()
    pendant.resume()


_hung_up: set[str] = set()


def _own_conversation(user: int, agent: Agent, conv_id: str | None) -> str:
    with db.connect() as c:
        if conv_id and not c.execute(
            "SELECT 1 FROM conversations WHERE id = ? AND user_id = ? AND agent_id = ?", (conv_id, user, agent.id)
        ).fetchone():
            raise HTTPException(404, "Conversation introuvable")
    return conv_id or main._main_conversation(agent.id, user) or main._new_conversation(user, agent.id, "Conversation", main=True)


@router.post("/api/chat/ensuite")
async def chat_after(body: LaterMessage, user: int = Depends(auth.current_user)):
    """Une demande faite en appel pendant que l'agent travaille, puis raccroché : le serveur la garde jusqu'à ce qu'il ait
    fini. Sur le téléphone, l'écran peut se fermer juste après : ça ne peut pas rester du côté de l'application."""
    body.text = sensitive.mask_keys(body.text)
    agent = main._usable(user, body.agent_id)
    conv_id = _own_conversation(user, agent, body.conversation_id)
    request_id = f"{user}:{body.client_id or uuid.uuid4().hex}"
    if pendant.add(request_id, conv_id, agent.id, user, body.text):
        pendant.start(agent.id, conv_id)
    else:  # raccroché pendant son tri : si elle finit à la suite, c'est le serveur qui la garde, l'appel n'est plus là
        _hung_up.add(request_id)
    return {"ok": True}


def _conversation_run(conv_id: str) -> str | None:
    return next((run_id for run_id, r in reversed(main._runs.items()) if r["conv"] == conv_id), None)


STEER_OK, STEER_REFUSED, STEER_UNSURE = "ok", "refuse", "incertain"
STEER_ACK = "Noté, je l'intègre."  # l'accusé immédiat : le travail continue, la consigne le rejoint (aussi quand le tri n'a pas su)
TRIAGE_WAIT = 3  # secondes : la personne attend l'accusé ; au-delà, le message rejoint le travail en cours sans tri
UNSURE_STEER = "Je ne sais pas si l'agent a reçu ce message : la transmission a été coupée. Regarde sa réponse, et renvoie-le si besoin."


async def _steer(agent: Agent, conv_id: str, user: int, text: str) -> str:
    """Transmet au run en cours. Refusé (rien n'est arrivé) : à la file. Incertain (la réponse s'est perdue) : on ne le rejoue pas, on le dit."""
    run_id = _conversation_run(conv_id)
    run = main._runs.get(run_id or "")
    if not run:
        return STEER_REFUSED
    profile = access.guest_profile(user) if access.separated(user, agent.id) else None
    if run.get("user") != user or (run.get("profil") or None) != profile:  # droits changés depuis son départ : ce run n'est plus le sien
        return STEER_REFUSED
    try:
        await hermes.steer_run(replace(agent, profile=profile), run_id, text)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.HTTPStatusError) as e:
        diagnostics.record("précision pendant le travail", f"{type(e).__name__}: {e}", agent.id)
        return STEER_REFUSED
    except httpx.HTTPError as e:
        diagnostics.record("précision pendant le travail, réponse perdue", f"{type(e).__name__}: {e}", agent.id)
        return STEER_UNSURE
    return STEER_OK


def _recent_turns(conv_id: str) -> list[dict]:
    with db.connect() as c:
        rows = c.execute("SELECT role, text FROM messages WHERE conversation_id = ? AND role IN ('user', 'agent') ORDER BY id DESC LIMIT 6", (conv_id,)).fetchall()
    return [{"role": "assistant" if r["role"] == "agent" else "user", "text": r["text"]} for r in reversed(rows)]


@router.post("/api/chat/pendant")
async def chat_while_busy(body: WhileBusy, user: int = Depends(auth.current_user)):
    """Un message pendant le travail : réponse tout de suite, précision glissée dans le travail, ou demande à la suite.
    Écrit avant toute réponse ; si le tri échoue, il attend son tour plutôt que de se perdre."""
    body.text = sensitive.mask_keys(body.text)
    agent = main._usable(user, body.agent_id)
    conv_id = _own_conversation(user, agent, body.conversation_id)
    request_id = f"{user}:{body.client_id}"
    text = _with_attachments(body.text, body.attachments)
    if not pendant.add(request_id, conv_id, agent.id, user, text, pendant.TRI):
        return pendant.known_result(request_id) or {"type": "tache", "reponse": "", "conversation_id": conv_id}
    kind, reply = body.choix, ""
    if not coordination._busy(agent.id, conv_id):
        kind = "tache"  # il vient de finir : elle part tout de suite
    elif not kind:
        with db.connect() as c:
            row = c.execute("SELECT name, role FROM agents WHERE id = ?", (agent.id,)).fetchone()
        try:
            found = await asyncio.wait_for(media.triage(agent.id, row["name"], row["role"], text, _recent_turns(conv_id), main.task_activity.get(conv_id, "")), main.TRIAGE_WAIT)
            kind, reply = found["type"], found["reponse"]
        except (media.MediaError, asyncio.TimeoutError) as e:
            # Tri en panne ou trop lent : dans le doute, le message rejoint le travail en cours. Seule une tâche reconnue attend son tour.
            diagnostics.record("tri pendant le travail", str(e) or "pas de réponse à temps", agent.id)
            kind = "precision"
        if not access.allowed(user, agent.id, "usage"):  # le tri prend du temps : l'accès a pu être retiré entre-temps
            pendant.settle(request_id, pendant.CANCELLED)
            raise HTTPException(404, "Agent introuvable")
    status = pendant.DONE
    if kind == "question":
        status = pendant.ANSWERED
        _save_message(conv_id, "user", text)
        _save_message(conv_id, "agent", reply)
        machine.add_context(conv_id, f"[Pendant ton travail, la personne a demandé : « {text[:1000]} ». Il lui a été répondu : « {reply} ».]\n\n")
    elif kind == "precision":
        pendant.move(request_id, (pendant.TRI,), pendant.SENDING)  # à partir d'ici, un redémarrage ne la rejoue plus
        outcome = await _steer(agent, conv_id, user, text)
        if outcome == STEER_REFUSED:
            kind, status = "tache", pendant.WAITING
        else:
            _save_message(conv_id, "user", text)
            handoff.release_waiters(agent.id)  # transmise après l'outil en cours : pas après la réponse à un appel
            reply = UNSURE_STEER if outcome == STEER_UNSURE else reply or STEER_ACK
    else:
        kind, status = "tache", pendant.WAITING
    result = {"type": kind, "reponse": reply, "conversation_id": conv_id}
    if status == pendant.WAITING and body.garder and request_id not in _hung_up:
        pendant.forget(request_id)
        return result
    _hung_up.discard(request_id)
    pendant.settle(request_id, status, result)
    if status == pendant.WAITING:
        pendant.start(agent.id, conv_id)
        handoff.release_waiters(agent.id)
    return result


class Looking(BaseModel):
    visible: bool


@router.post("/api/conversations/{conv_id}/regard")
def conversation_looking(conv_id: str, body: Looking, user: int = Depends(auth.current_user)):
    """L'écran passe derrière ou revient. Sur un téléphone, le flux reste ouvert sans que personne le lise : la fin de la tâche doit
    quand même se notifier."""
    access.conversation(user, conv_id, ecrire=True)
    notifications.set_hidden(conv_id, not body.visible)
    return {"ok": True}


@router.get("/api/conversations/{conv_id}/en-cours")
def conversation_now(conv_id: str, suivi: bool = True, user: int = Depends(auth.current_user)):
    """Ce que l'agent fait dans cette conversation et ce qui attend, même si l'écran n'a pas lancé ce travail. `suivi` : un
    écran regarde cette conversation. La bulle Android relève sans la regarder : elle passe la main à la notification."""
    row = access.conversation(user, conv_id)
    if suivi and row["user_id"] == user:
        notifications.saw(conv_id)
    return now_of(row, conv_id, user)


def now_of(row, conv_id: str, user: int) -> dict:
    """Ce que l'agent fait dans cette conversation (route …/en-cours et ouverture). `row` : la ligne rendue par access.conversation."""
    agent_id = row["agent_id"]
    busy = coordination._busy(agent_id, conv_id)
    return {"occupe": busy, "activite": main.task_activity.get(conv_id) if busy else None, "run_id": _conversation_run(conv_id) if busy else None,
            "file": [{"id": r["id"].split(":", 1)[1], "text": r["text"]} for r in pendant.waiting(conv_id)],
            # Un accord demandé par un travail qu'aucun écran ne suit : sans ça, personne ne peut le donner et la file reste bloquée.
            "accord": next(iter(accords.pending(user, conv_id)), None) if row["user_id"] == user else None,
            "connexion": coffre.asked(conv_id, user)}


def _own_request(user: int, client_id: str) -> tuple[str, dict]:
    request_id = f"{user}:{client_id}"  # le compte fait partie de l'identifiant : la demande d'un autre n'existe pas ici
    row = pendant.get(request_id)
    if not row:
        raise HTTPException(404, "Demande introuvable")
    access.access(user, row["agent_id"], "usage")
    return request_id, row


@router.post("/api/chat/file/{client_id}/maintenant")
async def request_now(client_id: str, user: int = Depends(auth.current_user)):
    """Corrige le tri : une demande à la suite, ou une question qui a eu sa réponse, part maintenant vers le travail en cours."""
    request_id, row = _own_request(user, client_id)
    agent, conv_id = main._agent(row["agent_id"]), row["conversation_id"]
    if not pendant.move(request_id, (pendant.WAITING, pendant.ANSWERED), pendant.SENDING):  # déjà partie, retirée, ou deux clics
        return {"type": "deja"}
    outcome = await _steer(agent, conv_id, user, row["text"])
    if outcome == STEER_REFUSED:  # plus de travail en cours : elle part à son tour, y compris une question qu'on veut transmettre
        pendant.settle(request_id, pendant.WAITING)
        pendant.start(agent.id, conv_id)
        return {"type": "tache"}
    if row["status"] == pendant.WAITING:
        _save_message(conv_id, "user", row["text"])
    pendant.settle(request_id, pendant.DONE)
    return {"type": "precision" if outcome == STEER_OK else "incertain"}


@router.delete("/api/chat/file/{client_id}")
def request_cancel(client_id: str, user: int = Depends(auth.current_user)):
    request_id, _ = _own_request(user, client_id)
    return {"ok": pendant.move(request_id, (pendant.WAITING,), pendant.CANCELLED)}
