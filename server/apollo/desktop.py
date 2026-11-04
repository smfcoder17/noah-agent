"""Actions de l'agent sur l'ordinateur de l'utilisateur, par l'application de bureau.

L'agent appelle `noah.py ordinateur …` ; la demande attend ici que l'application de bureau la récupère
(attente longue sur /api/desktop/next), la fasse confirmer par l'utilisateur dans une boîte de dialogue du système
(la page web ne peut pas répondre à sa place), l'exécute et renvoie le résultat. Sans application ouverte, l'agent
reçoit une erreur lisible au lieu d'attendre.
"""
import asyncio
import re
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import access, auth, db, hermes, relay

router = APIRouter()

# Par compte : l'ordinateur d'un profil ne reçoit jamais les actions de l'agent d'un autre.
_queues: dict[int, asyncio.Queue] = {}
_waiting: dict[str, tuple[asyncio.Future, int]] = {}  # demande -> (réponse attendue, compte dont l'ordinateur répond)
_seen: dict[int, dict] = {}  # dernier passage de l'application de bureau de ce compte, et son système
WAIT = 25  # secondes d'attente longue de l'application de bureau

ACTIONS = ("ouvrir", "notifier", "presse_papiers", "lancer", "commande")


class AgentAction(BaseModel):
    action: str = Field(pattern="^(" + "|".join(ACTIONS) + ")$")
    cible: str = Field(default="", max_length=2000)  # chemin, adresse, application ou commande
    titre: str = Field(default="", max_length=200)
    texte: str = Field(default="", max_length=4000)


def _queue(user: int) -> asyncio.Queue:
    return _queues.setdefault(user, asyncio.Queue())


def connected(user: int) -> bool:
    return time.time() - _seen.get(user, {}).get("at", 0.0) < 40


def _host_path(agent_id: str, path: str) -> str | None:
    """/opt/data/dossiers/<nom>/… (vu par l'agent) → chemin sur l'ordinateur. Rend None pour un fichier qui
    n'existe que dans la machine de l'agent."""
    m = re.match(r"^/opt/data/dossiers/([a-z0-9-]+)(/.*)?$", path)
    if m:
        folder = next((f for f in hermes.shared_folders(agent_id) if f["nom"] == m.group(1)), None)
        if folder:
            sep = "\\" if re.match(r"^[A-Za-z]:", folder["chemin"]) else "/"
            return folder["chemin"].rstrip("\\/") + (m.group(2) or "").replace("/", sep)
    return None if path.startswith("/opt/") or path.startswith("/tmp/") else path


def _working_folder(agent_id: str) -> str:
    return next((f["chemin"] for f in hermes.shared_folders(agent_id) if f["travail"]), "")


@router.post("/agent-api/ordinateur")
async def agent_action(body: AgentAction, request: Request):
    agent_id = relay._agent_from(request)
    if access.guest_task(agent_id):
        return {"erreur": "Une personne avec qui tu es partagé t'a confié cette tâche : l'ordinateur de ton propriétaire n'en fait pas partie."}
    target = access.owner_of(agent_id)
    if not connected(target):
        return {"erreur": "L'application de bureau Noah Agent n'est pas ouverte sur l'ordinateur de l'utilisateur. "
                          "Dis-lui de l'ouvrir (elle peut rester dans la zone de notification), puis réessaie."}
    cible = body.cible.strip()
    if body.action == "ouvrir" and not re.match(r"^https?://", cible):
        host = _host_path(agent_id, cible)
        if host is None:
            return {"erreur": "Ce fichier n'existe que dans ta machine. Copie-le d'abord dans un dossier partagé "
                              "(de préférence ton dossier de travail, voir /opt/data/dossiers.json), puis ouvre cette copie."}
        cible = host
    with db.connect() as c:
        row = c.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
    rid = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    _waiting[rid] = (future, target)
    await _queue(target).put({"id": rid, "agent": row["name"] if row else "Noah", "action": body.action, "cible": cible,
                      "titre": body.titre, "texte": body.texte, "dossier": _working_folder(agent_id)})
    try:
        # Le temps pour l'utilisateur de lire la demande et de répondre.
        return await asyncio.wait_for(future, 300)
    except asyncio.TimeoutError:
        return {"erreur": "Pas de réponse de l'utilisateur dans les 5 minutes : action annulée."}
    finally:
        _waiting.pop(rid, None)


@router.get("/api/desktop/next")
async def next_action(os: str = "", user: int = Depends(auth.current_user)):
    """Attente longue de l'application de bureau : rend la prochaine action, ou 204 après 25 s."""
    _seen[user] = {"at": time.time(), "os": os[:20]}
    while True:
        try:
            item = await asyncio.wait_for(_queue(user).get(), WAIT)
        except asyncio.TimeoutError:
            return Response(status_code=204)
        if item["id"] in _waiting:  # l'agent attend encore (sinon elle a expiré)
            _seen[user]["at"] = time.time()
            return item


@router.post("/api/desktop/result/{rid}")
async def action_result(rid: str, body: dict, user: int = Depends(auth.current_user)):
    future, target = _waiting.get(rid, (None, None))
    if future is None or target != user:
        raise HTTPException(404, "Demande introuvable")
    if not future.done():
        future.set_result(body)
    return {"ok": True}


@router.get("/api/desktop/status")
async def status(user: int = Depends(auth.current_user)):
    return {"connecte": connected(user), "systeme": _seen.get(user, {}).get("os", "")}


def notify(title: str, text: str, agent_id: str | None = None) -> None:
    """Notification sur l'ordinateur si l'application de bureau est ouverte, et sur les appareils abonnés aux
    notifications (téléphone, navigateur) ; personne n'attend la réponse. Pour un agent : son propriétaire, et le profil
    partagé qui a lancé la tâche. Sans agent : le propriétaire de l'installation."""
    from . import push

    for user in access.recipients(agent_id) if agent_id else [db.owner_id()]:
        if user is None:
            continue
        push.notify(title, text, user_id=user)
        if connected(user):
            rid = uuid.uuid4().hex
            _waiting[rid] = (asyncio.get_running_loop().create_future(), user)
            _queue(user).put_nowait({"id": rid, "agent": "Noah", "action": "notifier", "cible": "", "titre": title, "texte": text, "dossier": ""})
            asyncio.get_running_loop().call_later(120, lambda r=rid: _waiting.pop(r, None))
