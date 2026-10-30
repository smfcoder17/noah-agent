"""Appel à l'utilisateur : l'agent (ou Noah Agent) a besoin de lui pour une étape qui doit rester la sienne.

Se connecter à un compte, taper un code 2FA, accepter des conditions, cliquer sur « Autoriser ». L'agent dit quoi
faire ; Noah Agent affiche un bandeau avec l'écran de l'agent, prévient sur l'ordinateur, et l'agent attend la
réponse (« C'est fait » ou « Je ne peux pas ») au lieu de finir son tour et d'oublier où il en était.
"""
import asyncio
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, desktop, relay

router = APIRouter()

# Un appel en cours au plus par agent : {id, message, depuis, origine, reponse, attente}.
_calls: dict[str, dict] = {}
_answered: dict[str, str] = {}  # réponses récentes, pour l'agent qui relance `attendre` après coup


def open_call(agent_id: str, message: str, origin: str = "agent") -> dict:
    old = _calls.get(agent_id)
    if old and not old["attente"].done():
        old["attente"].set_result("remplace")
    call = {"id": uuid.uuid4().hex[:10], "message": message, "depuis": time.time(), "origine": origin,
            "attente": asyncio.get_running_loop().create_future()}
    _calls[agent_id] = call
    desktop.notify("Noah a besoin de toi", message[:240])
    return call


def close_call(agent_id: str, call_id: str | None, answer: str) -> None:
    call = _calls.get(agent_id)
    if call and (call_id is None or call["id"] == call_id):
        if not call["attente"].done():
            call["attente"].set_result(answer)
        _calls.pop(agent_id, None)
        _answered[call["id"]] = answer
        while len(_answered) > 50:
            _answered.pop(next(iter(_answered)))


def current(agent_id: str) -> dict | None:
    call = _calls.get(agent_id)
    if call and time.time() - call["depuis"] > 3600:  # personne n'attend plus depuis longtemps
        close_call(agent_id, call["id"], "expire")
        return None
    return call


async def wait(agent_id: str, call_id: str, seconds: float) -> str:
    call = _calls.get(agent_id)
    if not call or call["id"] != call_id:
        return _answered.get(call_id, "inconnu")
    try:
        return await asyncio.wait_for(asyncio.shield(call["attente"]), seconds)
    except asyncio.TimeoutError:
        return "en_attente"


def _public(call: dict | None) -> dict | None:
    return {k: call[k] for k in ("id", "message", "depuis", "origine")} if call else None


@router.get("/api/agents/{agent_id}/appel")
async def get_call(agent_id: str, user: int = Depends(auth.current_user)):
    return {"appel": _public(current(agent_id))}


class Answer(BaseModel):
    reponse: str = Field(pattern="^(fait|impossible)$")


@router.post("/api/agents/{agent_id}/appel/{call_id}")
async def answer_call(agent_id: str, call_id: str, body: Answer, user: int = Depends(auth.current_user)):
    call = current(agent_id)
    if not call or call["id"] != call_id:
        raise HTTPException(404, "Cet appel est déjà terminé")
    if call["origine"] != "agent" and body.reponse == "fait":
        # Noah Agent finit lui-même ses appels (il voit quand l'accord est donné) : « fait » ne change rien.
        return {"ok": True}
    close_call(agent_id, call_id, body.reponse)
    return {"ok": True}


# Sous la limite des commandes de l'agent (180 s) : au-delà, il relance `noah.py attendre <id>`.
AGENT_WAIT = 150


class AgentCall(BaseModel):
    message: str = Field(min_length=3, max_length=600)


def _result(call_id: str, answer: str) -> dict:
    if answer == "en_attente":
        return {"reponse": "en_attente", "id": call_id,
                "conseil": f"L'utilisateur n'a pas encore répondu. Relance `python3 /opt/data/noah.py attendre {call_id}`."}
    if answer == "fait":
        return {"reponse": "fait", "conseil": "Recharge la page avant de vérifier : elle a pu changer pendant que tu attendais."}
    if answer == "impossible":
        return {"reponse": "impossible", "conseil": "L'utilisateur ne peut pas le faire maintenant : arrête-toi et demande-lui comment continuer."}
    return {"reponse": answer, "conseil": "Cet appel n'attend plus de réponse."}


@router.post("/agent-api/appel")
async def agent_call(body: AgentCall, request: Request):
    agent_id = relay._agent_from(request)
    call = open_call(agent_id, body.message.strip())
    return _result(call["id"], await wait(agent_id, call["id"], AGENT_WAIT))


@router.get("/agent-api/appel/{call_id}")
async def agent_wait(call_id: str, request: Request):
    agent_id = relay._agent_from(request)
    return _result(call_id, await wait(agent_id, call_id, AGENT_WAIT))
