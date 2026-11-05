"""La machine de chaque agent vue depuis Détails : disque et logiciels, mémoire, routines, connexions.

Tout passe par le lanceur, qui exécute un petit outil d'administration dans le conteneur de l'agent
avec les modules d'Hermes : l'agent et l'interface lisent et écrivent exactement les mêmes données.
"""
import asyncio
import json
import re
import unicodedata

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db, hermes, relay
from .config import LAUNCHER_URL
from .hermes import LAUNCHER

router = APIRouter()


def _check(agent_id: str, user: int) -> str:
    """Tout ce qui est ici (machine, mémoire, routines, connexions, dossiers) fait partie des réglages de l'agent."""
    access.access(user, agent_id, "admin")
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
    return await admin(_check(agent_id, user), "ordinateur")


@router.post("/api/agents/{agent_id}/install")
async def computer_install(agent_id: str, body: Install, user: int = Depends(auth.current_user)):
    return await install(_check(agent_id, user), body.paquets)


@router.post("/agent-api/installer")
async def agent_install(body: Install, request: Request):
    return await install(relay._agent_from(request), body.paquets)


# --- Mémoire --------------------------------------------------------------------------------

class MemoryWrite(BaseModel):
    cible: str = Field(pattern=r"^(memory|user)$")
    entrees: list[str] = Field(max_length=200)


@router.get("/api/agents/{agent_id}/memory")
async def memory(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "memoire")


@router.put("/api/agents/{agent_id}/memory")
async def memory_write(agent_id: str, body: MemoryWrite, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "memoire_ecrire", body.model_dump())


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
    return await admin(_check(agent_id, user), "routines")


@router.post("/api/agents/{agent_id}/routines")
async def routine_create(agent_id: str, body: NewRoutine, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "routine_creer", body.model_dump())


@router.post("/api/agents/{agent_id}/routines/{routine_id}/{action}")
async def routine_action(agent_id: str, routine_id: str, action: str, body: RoutineEdit | None = None,
                         user: int = Depends(auth.current_user)):
    if action not in ("pause", "reprendre", "lancer", "supprimer", "modifier"):
        raise HTTPException(400, "Action inconnue")
    payload = {"id": routine_id, "action": action, **(body.model_dump(exclude_none=True) if body else {})}
    return await admin(_check(agent_id, user), "routine_action", payload)


class AgentRoutineAction(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    action: str = Field(pattern="^(pause|reprendre|lancer|supprimer)$")


@router.post("/agent-api/routines")
async def agent_routine_create(body: NewRoutine, request: Request):
    """Le chemin de l'agent, le même que celui de l'écran : la livraison reste locale, le résultat revient toujours dans la conversation."""
    return await admin(relay._agent_from(request), "routine_creer", body.model_dump())


@router.get("/agent-api/routines")
async def agent_routines(request: Request):
    return await admin(relay._agent_from(request), "routines")


@router.post("/agent-api/routines/action")
async def agent_routine_action(body: AgentRoutineAction, request: Request):
    return await admin(relay._agent_from(request), "routine_action", body.model_dump())


async def deliver_routines(save_message, main_conversation) -> None:
    """Toutes les minutes : les résultats des routines arrivent dans la conversation de l'agent, comme un message de Noah,
    et en notification. C'est ce qui rend l'initiative visible."""
    while True:
        await asyncio.sleep(60)
        await deliver_routines_once(save_message, main_conversation)


async def deliver_routines_once(save_message, main_conversation) -> None:
    from . import desktop

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
                add_context(conv, text)
            desktop.notify(f"Routine « {r['nom']} »", r["texte"].strip()[:240], agent_id=agent_id)
            db.set_setting(key, r["quand"])


def add_context(conv_id: str, text: str) -> None:
    """Hermes n'a pas ce message dans sa session : il le recevra avec le prochain message de l'utilisateur."""
    pending = json.loads(db.get_setting(f"contexte_{conv_id}") or "[]")
    db.set_setting(f"contexte_{conv_id}", json.dumps((pending + [text])[-20:]))


def pop_context(conv_id: str) -> str:
    """Résultats de routines arrivés dans la conversation depuis le dernier message de l'utilisateur."""
    pending = json.loads(db.get_setting(f"contexte_{conv_id}") or "[]")
    if not pending:
        return ""
    db.set_setting(f"contexte_{conv_id}", "[]")
    return ("[Arrivé dans la conversation depuis le dernier message, sans que tu l'aies vu :]\n"
            + "\n\n".join(t[:4000] for t in pending) + "\n[Fin. Message de l'utilisateur :]\n\n")


# --- Connexions : Google (détail dans accounts.py) et applications ------------------------

@router.get("/api/agents/{agent_id}/connections")
async def connections(agent_id: str, user: int = Depends(auth.current_user)):
    from . import mcp

    google, apps = await asyncio.gather(admin(_check(agent_id, user), "google"), admin(agent_id, "applications"))
    applications = apps.get("applications") or []
    state = await mcp.connections_state(agent_id, applications, apps.get("personnels") or {})
    return {"google": google, "applications": applications, **state}


class AppFinish(BaseModel):
    adresse: str = Field(min_length=4, max_length=4000)


@router.post("/api/agents/{agent_id}/connections/apps/{name}/{action}")
async def app_action(agent_id: str, name: str, action: str, body: AppFinish | None = None,
                     user: int = Depends(auth.current_user)):
    """Connecte ou retire une application du catalogue d'Hermes. La gateway relit sa configuration et
    ses jetons d'elle-même : les outils arrivent sans redémarrer l'agent (ni couper une connexion en cours)."""
    _check(agent_id, user)
    if action == "connect":
        out = await admin(agent_id, "application_connecter", {"nom": name})
    elif action == "finish":
        if not body:
            raise HTTPException(400, "Adresse de retour manquante")
        out = await admin(agent_id, "application_finir", {"nom": name, "adresse": body.adresse})
    elif action == "remove":
        from . import mcp

        out = await admin(agent_id, "application_retirer", {"nom": name})
        mcp.forget(agent_id, name)
    else:
        raise HTTPException(400, "Action inconnue")
    return out


# --- Dossiers de l'ordinateur ---------------------------------------------------------------
# L'utilisateur donne à l'agent des dossiers de son ordinateur, en lecture seule ou en lecture et écriture ; l'un
# d'eux peut être son dossier de travail (là où il range ce qu'il produit, y compris pendant les routines).
# Possible seulement quand Noah tourne sur l'ordinateur lui-même, sous les racines autorisées (NOAH_SHARE_ROOTS).

class SharedFolder(BaseModel):
    chemin: str = Field(min_length=2, max_length=500)
    nom: str = ""
    ecriture: bool = False
    travail: bool = False


class SharedFolders(BaseModel):
    dossiers: list[SharedFolder] = Field(max_length=20)


def _slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:40] or "dossier"


async def _roots() -> list[str]:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{LAUNCHER_URL}/folders/roots", headers=LAUNCHER)
    return r.json().get("racines", []) if r.status_code == 200 else []


@router.get("/api/agents/{agent_id}/folders")
async def folders(agent_id: str, user: int = Depends(auth.current_user)):
    dossiers = hermes.shared_folders(_check(agent_id, user))
    return {"racines": await _roots() if access.is_owner(user) else [], "dossiers": dossiers}


@router.put("/api/agents/{agent_id}/folders")
async def set_folders(agent_id: str, body: SharedFolders, user: int = Depends(auth.current_user)):
    _check(agent_id, user)
    if not access.is_owner(user):  # ces dossiers sont sur l'ordinateur du propriétaire : un profil ne les monte pas
        raise HTTPException(403, "Seul le propriétaire de ce Noah Agent peut confier des dossiers de son ordinateur.")
    out, used = [], set()
    for f in body.dossiers:
        chemin = f.chemin.strip().rstrip("\\/") or f.chemin.strip()
        base = _slug(f.nom or re.split(r"[\/]", chemin)[-1])
        nom, i = base, 2
        while nom in used:
            nom, i = f"{base}-{i}", i + 1
        used.add(nom)
        out.append({"nom": nom, "chemin": chemin, "ecriture": f.ecriture, "travail": f.travail and f.ecriture})
    if sum(f["travail"] for f in out) > 1:
        raise HTTPException(400, "Un seul dossier de travail")
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.put(f"{LAUNCHER_URL}/agents/{agent_id}/folders", headers=LAUNCHER,
                        json={"dossiers": [{k: f[k] for k in ("nom", "chemin", "ecriture")} for f in out]})
    if r.status_code >= 400:
        raise HTTPException(r.status_code if r.status_code < 500 else 502, r.json().get("detail", "Partage impossible"))
    db.set_setting(f"dossiers_{agent_id}", json.dumps(out, ensure_ascii=False))
    await write_folder_notes(agent_id)
    return {"dossiers": out}


async def write_folder_notes(agent_id: str) -> None:
    """/opt/data/dossiers.json : ce que l'agent doit savoir de chaque dossier (où il est, ce qu'il peut y faire)."""
    notes = [{
        "dans_ta_machine": f"/opt/data/dossiers/{f['nom']}",
        "sur_l_ordinateur_de_l_utilisateur": f["chemin"],
        "acces": "lecture et écriture" if f["ecriture"] else "lecture seule",
        "dossier_de_travail": f["travail"],
    } for f in hermes.shared_folders(agent_id)]
    async with httpx.AsyncClient(timeout=30) as c:
        await c.put(f"{LAUNCHER_URL}/agents/{agent_id}/files", headers=LAUNCHER,
                    json={"files": {"dossiers.json": json.dumps(notes, ensure_ascii=False, indent=1) + "\n"}})
