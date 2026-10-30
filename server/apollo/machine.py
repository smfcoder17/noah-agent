"""La machine de chaque agent vue depuis Détails : disque et logiciels, mémoire, routines, connexions.

Tout passe par le lanceur, qui exécute un petit outil d'administration dans le conteneur de l'agent
avec les modules d'Hermes : l'agent et l'interface lisent et écrivent exactement les mêmes données.
"""
import asyncio
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, db, relay
from .config import LAUNCHER_URL
from .hermes import LAUNCHER

router = APIRouter()


def _check(agent_id: str) -> str:
    with db.connect() as c:
        if not c.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone():
            raise HTTPException(404, "Agent introuvable")
    return agent_id


async def admin(agent_id: str, action: str, body: dict | None = None, timeout: float = 90) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{LAUNCHER_URL}/agents/{agent_id}/admin/{action}", headers=LAUNCHER,
                         content=json.dumps(body or {}, ensure_ascii=False).encode())
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = r.text
        raise HTTPException(r.status_code if r.status_code < 500 else 502, detail or "L'agent ne répond pas")
    return r.json()


async def install(agent_id: str, packages: list[str]) -> dict:
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(f"{LAUNCHER_URL}/agents/{agent_id}/install", headers=LAUNCHER, json={"paquets": packages})
    if r.status_code >= 400:
        raise HTTPException(400, f"Installation impossible : {r.json().get('detail', r.text)[-600:]}")
    return r.json()


# --- Ordinateur ----------------------------------------------------------------------------

class Install(BaseModel):
    paquets: list[str] = Field(min_length=1, max_length=10)


@router.get("/api/agents/{agent_id}/computer")
async def computer(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "ordinateur")


@router.post("/api/agents/{agent_id}/install")
async def computer_install(agent_id: str, body: Install, user: int = Depends(auth.current_user)):
    return await install(_check(agent_id), body.paquets)


@router.post("/agent-api/installer")
async def agent_install(body: Install, request: Request):
    return await install(relay._agent_from(request), body.paquets)


# --- Mémoire --------------------------------------------------------------------------------

class MemoryWrite(BaseModel):
    cible: str = Field(pattern=r"^(memory|user)$")
    entrees: list[str] = Field(max_length=200)


@router.get("/api/agents/{agent_id}/memory")
async def memory(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "memoire")


@router.put("/api/agents/{agent_id}/memory")
async def memory_write(agent_id: str, body: MemoryWrite, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "memoire_ecrire", body.model_dump())


# --- Routines -------------------------------------------------------------------------------

class NewRoutine(BaseModel):
    nom: str = Field(default="", max_length=80)
    consigne: str = Field(min_length=1, max_length=5000)
    quand: str = Field(min_length=1, max_length=100)
    en_pause: bool = False


class RoutineEdit(BaseModel):
    nom: str | None = Field(default=None, max_length=80)
    consigne: str | None = Field(default=None, max_length=5000)


@router.get("/api/agents/{agent_id}/routines")
async def routines(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "routines")


@router.post("/api/agents/{agent_id}/routines")
async def routine_create(agent_id: str, body: NewRoutine, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "routine_creer", body.model_dump())


@router.post("/api/agents/{agent_id}/routines/{routine_id}/{action}")
async def routine_action(agent_id: str, routine_id: str, action: str, body: RoutineEdit | None = None,
                         user: int = Depends(auth.current_user)):
    if action not in ("pause", "reprendre", "lancer", "supprimer", "modifier"):
        raise HTTPException(400, "Action inconnue")
    payload = {"id": routine_id, "action": action, **(body.model_dump(exclude_none=True) if body else {})}
    return await admin(_check(agent_id), "routine_action", payload)


async def deliver_routines(save_message, main_conversation) -> None:
    """Toutes les minutes : les résultats des routines arrivent dans la conversation de l'agent,
    comme un message de Noah. C'est ce qui rend l'initiative visible."""
    while True:
        await asyncio.sleep(60)
        with db.connect() as c:
            ids = [r["id"] for r in c.execute("SELECT id FROM agents")]
        for agent_id in ids:
            key = f"routines_vues_{agent_id}"
            try:
                found = (await admin(agent_id, "routines_sorties", {"depuis": db.get_setting(key) or ""}, 30))["sorties"]
            except Exception:
                continue  # agent arrêté ou en cours de création
            conv = main_conversation(agent_id)
            for r in found:
                if conv:
                    text = f"**Routine « {r['nom']} »**\n\n{r['texte'].strip()}"
                    save_message(conv, "agent", text)
                    # Hermes n'a pas ce message dans sa session : il le recevra avec le prochain message de l'utilisateur.
                    pending = json.loads(db.get_setting(f"contexte_{conv}") or "[]")
                    db.set_setting(f"contexte_{conv}", json.dumps((pending + [text])[-5:]))
                db.set_setting(key, r["quand"])


def pop_context(conv_id: str) -> str:
    """Résultats de routines arrivés dans la conversation depuis le dernier message de l'utilisateur."""
    pending = json.loads(db.get_setting(f"contexte_{conv_id}") or "[]")
    if not pending:
        return ""
    db.set_setting(f"contexte_{conv_id}", "[]")
    return ("[Arrivé dans la conversation depuis le dernier message, sans que tu l'aies vu :]\n"
            + "\n\n".join(t[:4000] for t in pending) + "\n[Fin. Message de l'utilisateur :]\n\n")


# --- Connexions : Google (Gmail, Agenda, Drive) -----------------------------------------------

class GoogleStart(BaseModel):
    client_secret: str | None = Field(default=None, max_length=20000)


class GoogleFinish(BaseModel):
    code: str = Field(min_length=4, max_length=4000)


@router.get("/api/agents/{agent_id}/connections")
async def connections(agent_id: str, user: int = Depends(auth.current_user)):
    google, apps = await asyncio.gather(admin(_check(agent_id), "google"), admin(agent_id, "applications"))
    return {"google": google, "applications": apps["applications"]}


class AppFinish(BaseModel):
    adresse: str = Field(min_length=4, max_length=4000)


@router.post("/api/agents/{agent_id}/connections/apps/{name}/{action}")
async def app_action(agent_id: str, name: str, action: str, body: AppFinish | None = None,
                     user: int = Depends(auth.current_user)):
    """Connecte ou retire une application du catalogue d'Hermes. La gateway relit sa configuration et
    ses jetons d'elle-même : les outils arrivent sans redémarrer l'agent (ni couper une connexion en cours)."""
    _check(agent_id)
    if action == "connect":
        out = await admin(agent_id, "application_connecter", {"nom": name})
    elif action == "finish":
        if not body:
            raise HTTPException(400, "Adresse de retour manquante")
        out = await admin(agent_id, "application_finir", {"nom": name, "adresse": body.adresse})
    elif action == "remove":
        out = await admin(agent_id, "application_retirer", {"nom": name})
    else:
        raise HTTPException(400, "Action inconnue")
    return out


@router.post("/api/agents/{agent_id}/connections/google/start")
async def google_start(agent_id: str, body: GoogleStart, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "google_debut", body.model_dump())


@router.post("/api/agents/{agent_id}/connections/google/finish")
async def google_finish(agent_id: str, body: GoogleFinish, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "google_fin", body.model_dump())


@router.post("/api/agents/{agent_id}/connections/google/revoke")
async def google_revoke(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id), "google_revoquer")
