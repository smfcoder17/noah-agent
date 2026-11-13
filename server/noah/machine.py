"""La machine de chaque agent vue depuis Détails : disque et logiciels, mémoire, routines, connexions.

Tout passe par le lanceur, qui exécute un petit outil d'administration dans le conteneur de l'agent
avec les modules d'Hermes : l'agent et l'interface lisent et écrivent exactement les mêmes données.
"""
import asyncio
import json
import re
import time
import unicodedata

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db, desktop, hermes, modes, notifications, presets, relay
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


# --- Compétences : ce que la personne a enseigné à son agent -----------------------------------------------------------------
# Des skills d'Hermes, rangés dans `competences/` : l'agent les charge seul. Ceux qu'il apprend de lui-même restent internes : ni montrés, ni touchés ici.

class Competence(BaseModel):
    titre: str = Field(min_length=1, max_length=80)
    texte: str = Field(min_length=1, max_length=20000)


def _tell_taught(agent_id: str, name: str, titre: str) -> None:
    """Hermes ne relit la liste de ses skills qu'à la session suivante : sans ce mot, il ignorerait jusque-là ce qu'on vient de lui enseigner."""
    note = f"[L'utilisateur vient de t'enseigner comment faire : « {titre} ». Quand c'est le sujet, ouvre la compétence `{name}` et suis-la. Elle prime sur tes habitudes.]\n\n"
    with db.connect() as c:
        conversations = c.execute("SELECT id FROM conversations WHERE agent_id = ? AND main = 1", (agent_id,)).fetchall()
    for row in conversations:
        add_context(row["id"], note)


@router.get("/api/agents/{agent_id}/competences")
async def competences(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "competences")


@router.post("/api/agents/{agent_id}/competences")
async def competence_add(agent_id: str, body: Competence, user: int = Depends(auth.current_user)):
    out = await admin(_check(agent_id, user), "competence_ajouter", {"titre": body.titre.strip(), "texte": body.texte.strip()})
    _tell_taught(agent_id, out["nom"], out["titre"])
    return out


@router.put("/api/agents/{agent_id}/competences/{name}")
async def competence_edit(agent_id: str, name: str, body: Competence, user: int = Depends(auth.current_user)):
    out = await admin(_check(agent_id, user), "competence_modifier", {"nom": name, "titre": body.titre.strip(), "texte": body.texte.strip()})
    _tell_taught(agent_id, out["nom"], out["titre"])
    return out


@router.delete("/api/agents/{agent_id}/competences/{name}")
async def competence_remove(agent_id: str, name: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "competence_retirer", {"nom": name})


# --- Skills : tout ce que l'agent sait faire, y compris ce qu'il a appris seul ------------------------------------------------
# L'agent crée ses skills avec l'outil d'Hermes, sans catégorie : ils restaient invisibles. Ces routes les montrent tous,
# disent d'où ils viennent, et laissent la personne modifier ou retirer les siens (un skill fourni revient à chaque mise à jour).

class SkillBody(BaseModel):
    titre: str = Field(min_length=1, max_length=120)
    texte: str = Field(min_length=1, max_length=20000)


@router.get("/api/agents/{agent_id}/skills")
async def skills(agent_id: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "skills")


@router.get("/api/agents/{agent_id}/skills/{name:path}")
async def skill_read(agent_id: str, name: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "skill_lire", {"nom": name})


@router.put("/api/agents/{agent_id}/skills/{name:path}")
async def skill_write(agent_id: str, name: str, body: SkillBody, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "skill_ecrire", {"nom": name, "titre": body.titre.strip(), "texte": body.texte.strip()})


@router.delete("/api/agents/{agent_id}/skills/{name:path}")
async def skill_remove(agent_id: str, name: str, user: int = Depends(auth.current_user)):
    return await admin(_check(agent_id, user), "skill_retirer", {"nom": name})


# --- Routines -------------------------------------------------------------------------------

class RoutineChoices(BaseModel):
    """Ce qu'une routine peut fixer pour elle seule. Absent : le réglage de l'agent. Vide (« », ou « tous » pour les outils) : y revenir."""
    modele: str | None = Field(default=None, max_length=200)  # un modèle des clés de la personne, ou un mode (« gratuit »)
    fournisseur: str | None = Field(default=None, max_length=40)
    outils: list[str] | None = Field(default=None, max_length=len(modes.ROUTINE_TOOLS) + 1)
    image: str | None = Field(default=None, max_length=200)


class NewRoutine(RoutineChoices):
    nom: str = Field(default="", max_length=80)
    consigne: str = Field(min_length=1, max_length=5000)
    quand: str = Field(min_length=1, max_length=100)
    en_pause: bool = False


class RoutineEdit(RoutineChoices):
    nom: str | None = Field(default=None, max_length=80)
    consigne: str | None = Field(default=None, max_length=5000)


async def _routine_settings(agent_id: str, body: RoutineChoices) -> dict:
    """Le même contrôle pour l'écran et pour l'agent, avant que rien ne parte vers Hermes : modèle hors des clés, outil inconnu et
    modèle d'image inconnu sont refusés ici."""
    out: dict = {}
    if body.modele is not None:
        out["model"] = await modes.routine_alias(agent_id, body.modele, body.fournisseur) if body.modele else None
    if body.outils is not None:
        out["enabled_toolsets"] = None if "tous" in body.outils else modes.routine_toolsets(body.outils)
    if body.image:
        await modes.routine_image(body.image)
    return out


async def _create_routine(agent_id: str, body: NewRoutine) -> dict:
    settings = await _routine_settings(agent_id, body)
    payload = {"nom": body.nom, "quand": body.quand, "en_pause": body.en_pause, "consigne": modes.with_image_note(body.consigne, body.image), **settings}
    return modes.shown_routine(agent_id, await admin(agent_id, "routine_creer", payload))


async def _edit_routine(agent_id: str, routine_id: str, body: RoutineEdit) -> dict:
    payload = {"id": routine_id, "action": "modifier", **({"nom": body.nom} if body.nom is not None else {}), **await _routine_settings(agent_id, body)}
    if body.consigne is not None or body.image is not None:  # la note du modèle d'image fait partie de la consigne : on garde l'autre moitié
        current = next((r for r in (await _shown_routines(agent_id))["routines"] if r["id"] == routine_id), None)
        if not current:
            raise HTTPException(404, "Routine introuvable")
        payload["consigne"] = modes.with_image_note(body.consigne if body.consigne is not None else current["prompt"],
                                                    body.image if body.image is not None else current["image"])
    return modes.shown_routine(agent_id, await admin(agent_id, "routine_action", payload))


async def _shown_routines(agent_id: str) -> dict:
    found = await admin(agent_id, "routines")
    # `suggerees` : celles du modèle d'agent, en pause dans Noah (presets.py). Hors de `routines` : Hermes ne les connaît pas encore.
    return {**found, "routines": [modes.shown_routine(agent_id, r) for r in found.get("routines") or []], "suggerees": presets.suggested(agent_id)}


@router.get("/api/agents/{agent_id}/routines")
async def routines(agent_id: str, user: int = Depends(auth.current_user)):
    return await _shown_routines(_check(agent_id, user))


@router.post("/api/agents/{agent_id}/routines")
async def routine_create(agent_id: str, body: NewRoutine, user: int = Depends(auth.current_user)):
    return await _create_routine(_check(agent_id, user), body)


@router.post("/api/agents/{agent_id}/routines/suggerees/{suggestion_id}/activer")
async def routine_suggestion_activate(agent_id: str, suggestion_id: int, user: int = Depends(auth.current_user)):
    """Un geste : la routine du modèle, en pause jusque-là, devient une vraie routine active. Une seule fois."""
    agent_id = _check(agent_id, user)
    row = presets.take(agent_id, suggestion_id)
    try:
        return await _create_routine(agent_id, NewRoutine(nom=row["nom"], consigne=row["consigne"], quand=row["horaire"]))
    except BaseException:
        presets.give_back(row)
        raise


@router.post("/api/agents/{agent_id}/routines/{routine_id}/{action}")
async def routine_action(agent_id: str, routine_id: str, action: str, body: RoutineEdit | None = None,
                         user: int = Depends(auth.current_user)):
    if action not in ("pause", "reprendre", "lancer", "supprimer", "modifier"):
        raise HTTPException(400, "Action inconnue")
    if action == "modifier":
        return await _edit_routine(_check(agent_id, user), routine_id, body or RoutineEdit())
    return modes.shown_routine(agent_id, await admin(_check(agent_id, user), "routine_action", {"id": routine_id, "action": action}))


class AgentRoutineAction(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    action: str = Field(pattern="^(pause|reprendre|lancer|supprimer)$")


@router.post("/agent-api/routines")
async def agent_routine_create(body: NewRoutine, request: Request):
    """Le chemin de l'agent, le même que celui de l'écran : la livraison reste locale, le résultat revient toujours dans la conversation."""
    return await _create_routine(relay._agent_from(request), body)


@router.get("/agent-api/routines")
async def agent_routines(request: Request):
    return await _shown_routines(relay._agent_from(request))


@router.post("/agent-api/routines/{routine_id}/regler")
async def agent_routine_settings(routine_id: str, body: RoutineEdit, request: Request):
    """La personne le demande à son agent, à l'écrit ou à la voix : mêmes contrôles qu'à l'écran."""
    return await _edit_routine(relay._agent_from(request), routine_id, body)


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
                owner = db.agent_owner(agent_id)  # son résultat est écrit chez lui : pas chez le profil en train de parler à l'agent
                if owner is not None:
                    desktop.notify_user(owner, f"Routine « {r['nom']} »", notifications.first_sentence(r["texte"]), "routines",
                                        notifications.conversation_url(agent_id, conv))
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

# Lire cet état interroge l'agent et chaque service branché : plusieurs secondes. On garde la dernière réponse, en mémoire,
# pour rendre l'écran tout de suite ; l'interface la relit ensuite si elle a vieilli. Un changement l'oublie aussitôt.
_connections: dict[str, tuple[float, dict]] = {}
_connections_version: dict[str, int] = {}
_reading: dict[tuple[str, int], asyncio.Task] = {}
CONNECTIONS_FRESH = 30
WARM_EVERY = 3600


def forget_connections(agent_id: str) -> None:
    _connections.pop(agent_id, None)
    _connections_version[agent_id] = _connections_version.get(agent_id, 0) + 1


async def _read_connections(agent_id: str) -> dict:
    """Deux onglets qui demandent en même temps font une seule lecture, tant que rien n'a changé entre-temps."""
    key = (agent_id, _connections_version.get(agent_id, 0))
    task = _reading.get(key)
    if task is None:
        task = asyncio.create_task(_read_connections_once(agent_id, key[1]))
        _reading[key] = task
        task.add_done_callback(lambda _t, k=key: _reading.pop(k, None))
    return await asyncio.shield(task)


async def _read_connections_once(agent_id: str, version: int) -> dict:
    from . import mcp

    google, apps = await asyncio.gather(admin(agent_id, "google"), admin(agent_id, "applications"))
    applications = apps.get("applications") or []
    state = await mcp.connections_state(agent_id, applications, apps.get("personnels") or {})
    from . import connecteurs

    value = {"google": google, "applications": applications, **state, "globaux": connecteurs.for_agent(agent_id, google, apps)}
    if _connections_version.get(agent_id, 0) == version:  # sinon quelque chose a changé pendant la lecture : elle est déjà vieille
        _connections[agent_id] = (time.time(), value)
    return value


@router.get("/api/agents/{agent_id}/connections")
async def connections(agent_id: str, frais: bool = False, user: int = Depends(auth.current_user)):
    agent_id = _check(agent_id, user)
    known = _connections.get(agent_id)
    if known and not frais:
        age = time.time() - known[0]
        return {**known[1], "age": int(age)} if age > CONNECTIONS_FRESH else known[1]
    return await _read_connections(agent_id)


async def keep_connections_warm(agents, ready) -> None:
    """Après une mise à jour puis à chaque heure, pour les agents au repos : l'état et les logos sont prêts avant qu'on les demande."""
    from . import logos

    while True:
        for agent_id in agents():
            if not ready(agent_id):
                continue
            try:
                value = await _read_connections(agent_id)
                await logos.prepare(value)
            except Exception:  # noqa: BLE001 - agent arrêté ou service en panne : l'écran relira à la demande
                pass
        await asyncio.sleep(WARM_EVERY)


class AppFinish(BaseModel):
    adresse: str = Field(default="", max_length=4000)  # seulement pour « finish » : « connect » et « remove » n'en ont pas


@router.post("/api/agents/{agent_id}/connections/apps/{name}/{action}")
async def app_action(agent_id: str, name: str, action: str, request: Request, body: AppFinish | None = None,
                     user: int = Depends(auth.current_user)):
    """Connecte ou retire une application du catalogue d'Hermes. La gateway relit sa configuration et
    ses jetons d'elle-même : les outils arrivent sans redémarrer l'agent (ni couper une connexion en cours)."""
    from . import connexion, mcp

    _check(agent_id, user)
    forget_connections(agent_id)

    async def finish(adresse: str) -> dict:
        done = await admin(agent_id, "application_finir", {"nom": name, "adresse": adresse})
        mcp.tell_agent(agent_id, name, [])
        return done

    if action == "connect":
        out = await admin(agent_id, "application_connecter", {"nom": name, "retour": connexion.callback_url(request)})
        connexion.expect(out, agent_id, name, finish, connexion.from_app(request), user)
        if out.get("connecte"):
            mcp.tell_agent(agent_id, name, [])
    elif action == "finish":
        if not body or len(body.adresse.strip()) < 4:
            raise HTTPException(400, "Colle l'adresse de retour affichée après l'accord.")
        out = await finish(body.adresse)
    elif action == "remove":
        out = await admin(agent_id, "application_retirer", {"nom": name})
        mcp.forget(agent_id, name)
        from . import connecteurs

        await connecteurs.removed(agent_id, name)
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
