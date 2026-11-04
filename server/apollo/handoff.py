"""Appel à l'utilisateur : l'agent (ou Noah Agent) a besoin de lui pour une étape qui doit rester la sienne.

Se connecter à un compte, taper un code 2FA, résoudre un CAPTCHA. L'agent dit quoi
faire ; Noah Agent affiche un bandeau avec l'écran de l'agent, prévient sur l'ordinateur, et l'agent attend la
réponse (« C'est fait » ou « Je ne peux pas ») au lieu de finir son tour et d'oublier où il en était.
"""
import asyncio
import time
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, desktop, hermes, relay

router = APIRouter()

# Un appel en cours au plus par agent : {id, message, depuis, origine, reponse, attente}.
_calls: dict[str, dict] = {}
_answered: dict[str, str] = {}  # réponses récentes, pour l'agent qui relance `attendre` après coup
_hooks: dict = {}


def setup(resume) -> None:
    """`resume(agent_id, texte)` : relance l'agent dans sa conversation principale."""
    _hooks["resume"] = resume


def open_call(agent_id: str, message: str, origin: str = "agent", leave_host: str = "") -> dict:
    """`leave_host` : l'appel se termine tout seul (« fait ») quand plus aucun onglet n'est sur ce site, par exemple
    la page de connexion de Google. L'utilisateur se connecte et n'a rien d'autre à cliquer."""
    old = _calls.get(agent_id)
    if old and not old["attente"].done():
        old["attente"].set_result("remplace")
    call = {"id": uuid.uuid4().hex[:10], "message": message, "depuis": time.time(), "origine": origin,
            "attente": asyncio.get_running_loop().create_future(), "attentifs": 0}
    _calls[agent_id] = call
    _ensure_keeper(agent_id)
    desktop.notify("Noah a besoin de toi", message[:240])
    if leave_host:
        asyncio.create_task(_until_left(agent_id, call, leave_host))
    return call


PRIVATE_SECONDS = 3 * 3600  # au plus : rouvert à la fin de l'appel, ou de lui-même après ce délai


async def _private(agent_id: str, seconds: int) -> bool:
    """Pendant que l'utilisateur a la main (mot de passe, code), le navigateur refuse toute capture d'écran (G7.7)."""
    try:
        r = await hermes.browser_call(agent_id, "POST", "/noah/prive", key=hermes.private_key(agent_id),
                                      params={"secondes": seconds})
        return r.get("http_status") == 200
    except Exception:  # noqa: BLE001 - navigateur absent ou en train de redémarrer : rien à capturer
        return False


PRIVATE_EVERY = 20  # secondes : un navigateur recréé pendant la prise en main (mise à jour, plantage) repasse en privé
MANUAL_SECONDS = 3600  # « Prendre le contrôle » depuis l'écran, sans appel de l'agent : rendu de lui-même après 1 h

_manual: dict[str, float] = {}  # agent -> échéance de la prise de contrôle manuelle
_keepers: dict[str, asyncio.Task] = {}
_wake: dict[str, asyncio.Event] = {}


def _wanted(agent_id: str) -> bool:
    """L'utilisateur a la main : un appel de l'agent en cours, ou « Prendre le contrôle » dans l'écran."""
    return agent_id in _calls or _manual.get(agent_id, 0) > time.time()


def _ensure_keeper(agent_id: str) -> None:
    _wake.setdefault(agent_id, asyncio.Event()).set()
    task = _keepers.get(agent_id)
    if not task or task.done():
        _keepers[agent_id] = asyncio.get_running_loop().create_task(_keeper(agent_id))


async def _keeper(agent_id: str) -> None:
    """Un seul gardien par agent, qui envoie l'état voulu dans l'ordre : deux prises en main qui se suivent ne se
    marchent pas dessus (la fin de l'ancienne ne peut pas couper la nouvelle). Rappel toutes les 20 s tant que
    l'utilisateur a la main ; un échec (navigateur qui démarre) est retenté après 3 s."""
    wake = _wake.setdefault(agent_id, asyncio.Event())
    try:
        while True:
            wake.clear()
            if _wanted(agent_id):
                ok = await _private(agent_id, PRIVATE_SECONDS)
                if _wanted(agent_id):
                    try:
                        await asyncio.wait_for(wake.wait(), PRIVATE_EVERY if ok else 3)
                    except asyncio.TimeoutError:
                        pass
                    continue
            for _ in range(5):  # rendre les captures : jamais laissées bloquées par erreur
                if await _private(agent_id, 0) or _wanted(agent_id):
                    break
                await asyncio.sleep(3)
            if not _wanted(agent_id):  # aucune attente depuis le dernier contrôle : rien n'a pu se glisser
                return
    finally:
        _keepers.pop(agent_id, None)


async def take_control(agent_id: str, on: bool) -> bool:
    """Prise de contrôle depuis l'écran. Rend True quand le navigateur a confirmé le mode privé (ou qu'il est rendu)."""
    if not on:
        _manual.pop(agent_id, None)
        _ensure_keeper(agent_id)
        return True
    _manual[agent_id] = time.time() + MANUAL_SECONDS
    if not await _private(agent_id, PRIVATE_SECONDS):  # acquitté avant de laisser la main
        _manual.pop(agent_id, None)
        return False
    _ensure_keeper(agent_id)
    return True


async def _until_left(agent_id: str, call: dict, host: str) -> None:
    seen_gone = 0
    while _calls.get(agent_id) is call:
        await asyncio.sleep(2)
        try:
            tabs = (await hermes.browser_call(agent_id, "GET", "/tabs", params={"userId": hermes.BROWSER_USER})).get("tabs") or []
        except Exception:  # noqa: BLE001 - navigateur en train de redémarrer
            continue
        on_host = any((urlparse(str(t.get("url", ""))).hostname or "").endswith(host) for t in tabs)
        seen_gone = 0 if on_host else seen_gone + 1
        if seen_gone >= 2:  # deux relevés de suite : pas une redirection en cours
            await answer(agent_id, call, "fait")
            return


def close_call(agent_id: str, call_id: str | None, answer: str) -> None:
    call = _calls.get(agent_id)
    if call and (call_id is None or call["id"] == call_id):
        if not call["attente"].done():
            call["attente"].set_result(answer)
        _calls.pop(agent_id, None)
        try:
            _ensure_keeper(agent_id)
        except RuntimeError:  # appelé hors de la boucle : la fenêtre privée se fermera seule
            pass
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
    call["attentifs"] += 1
    try:
        return await asyncio.wait_for(asyncio.shield(call["attente"]), seconds)
    except asyncio.TimeoutError:
        return "en_attente"
    finally:
        call["attentifs"] -= 1


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
    await answer(agent_id, call, body.reponse)
    return {"ok": True}


async def answer(agent_id: str, call: dict, reponse: str) -> None:
    nobody_waiting = call["attentifs"] == 0
    close_call(agent_id, call["id"], reponse)
    if reponse == "fait":
        asyncio.create_task(save_browser_session(agent_id))
    if call["origine"] == "agent" and nobody_waiting and _hooks.get("resume"):
        # L'agent a fini son tour entre-temps (limite de temps, ou il s'est arrêté) : la réponse le relance.
        word = "C'est fait" if reponse == "fait" else "Je ne peux pas le faire maintenant"
        await _hooks["resume"](agent_id, f"{word} (ta demande : « {call['message'][:300]} »). Reprends où tu en étais.")


async def save_browser_session(agent_id: str, delay: float = 3) -> None:
    """Enregistre tout de suite les cookies du navigateur de l'agent. Camoufox ne le fait qu'à la fermeture propre
    d'une session : si Firefox se fige juste après une connexion, elle serait perdue au redémarrage."""
    await asyncio.sleep(delay)
    try:
        # La réponse (les cookies) n'est pas gardée ici : l'appel suffit à déclencher l'enregistrement sur disque.
        await hermes.browser_call(agent_id, "GET", f"/sessions/{hermes.BROWSER_USER}/storage_state", timeout=15)
    except Exception:  # noqa: BLE001 - navigateur éteint ou figé : rien à enregistrer
        pass


# Sous la limite des commandes de l'agent (180 s) : au-delà, il relance `noah.py attendre <id>`.
AGENT_WAIT = 150


class AgentCall(BaseModel):
    message: str = Field(min_length=3, max_length=600)
    quand_quitte: str = Field(default="", max_length=100, pattern=r"^[a-z0-9.-]*$")


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
    call = open_call(agent_id, body.message.strip(), leave_host=body.quand_quitte)
    return _result(call["id"], await wait(agent_id, call["id"], AGENT_WAIT))


@router.get("/agent-api/appel/{call_id}")
async def agent_wait(call_id: str, request: Request):
    agent_id = relay._agent_from(request)
    return _result(call_id, await wait(agent_id, call_id, AGENT_WAIT))


async def keep_browser_sessions(every: float = 180) -> None:
    """Enregistre régulièrement les cookies des navigateurs ouverts : une connexion faite à la main (écran de
    l'agent) survit ainsi à un Firefox figé puis redémarré."""
    from . import db

    while True:
        await asyncio.sleep(every)
        with db.connect() as c:
            ids = [r["id"] for r in c.execute("SELECT id FROM agents")]
        for agent_id in ids:
            try:
                health = await hermes.browser_call(agent_id, "GET", "/health", timeout=3)
            except Exception:  # noqa: BLE001 - pas de navigateur pour cet agent
                continue
            if health.get("activeSessions"):
                await save_browser_session(agent_id, delay=0)
