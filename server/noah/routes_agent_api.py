"""API de l'agent (l'outil noah.py dans sa machine, jeton de relais) : réglages qu'il lit et change, état, navigateur, fils de travail.
Sorti de main.py sans changement de comportement."""
import asyncio

import httpx
from fastapi import HTTPException, Request, APIRouter
from pydantic import Field, BaseModel

from . import access, machine, media, relay, notifications, proactif, modes, db, coordination, taches, main

router = APIRouter()

# --- API de l'agent (outil noah.py dans sa machine, jeton de relais) ----------------------

# --- Réglages que l'agent lit et change lui-même ------------------------------------------------------------------------------
# Liste de ce qui est permis, et rien d'autre : les modèles de médias, la voix et les goûts. Ni clé, ni compte, ni sécurité, ni
# mise à jour, ni cerveau : changer le cerveau redémarrerait l'agent en plein travail, et une clé reste à la personne.
AGENT_NAMES = {"image": "image", "video": "video", "musique": "music", "voix-modele": "speech", "dictee": "transcription",
               }


def _agent_setting_kind(name: str) -> str:
    kind = AGENT_NAMES.get(name)
    if not kind or kind not in media.KINDS:
        raise HTTPException(400, f"Réglage inconnu : {name}. Possibles : {', '.join([*AGENT_NAMES, 'voix', 'gouts'])}")
    return kind


@router.get("/agent-api/reglages")
async def agent_settings(request: Request, type: str | None = None):
    """Résumé de ce qui est réglé, ou la liste des modèles d'un type. Jamais une clé : seulement si elle existe."""
    agent_id = relay._agent_from(request)
    owner = relay.billed_to(agent_id) == db.owner_id()
    try:
        if type == "cerveau":  # en lecture : pour fixer le modèle d'une routine. Le cerveau lui-même reste à la personne.
            listed = modes.free_order(await modes.available(modes.BRAIN))[:80]
            return {"modes": list(modes.MODES), "modeles": [{k: m.get(k) for k in ("id", "name", "fournisseur", "free", "price_in") if m.get(k) is not None} for m in listed],
                    "aide": "Pour une routine : noah.py routine-regler <id> --modele <id ou mode>. Le cerveau de l'agent se change dans Réglages, par la personne."}
        if type == "voix":
            model = await media.resolve("speech")
            voices = next((m.get("voices", []) for m in await media.models("speech") if m["id"] == model), [])
            return {"modele": model, "reglage": db.get_setting("media_voice") or "auto", "voix": voices}
        if type:
            kind = _agent_setting_kind(type)
            return {"reglage": media.setting(kind), "automatique": await media.auto_choice(kind),
                    "modeles": [{k: m.get(k) for k in ("id", "name", "cost", "speed", "quality") if m.get(k) is not None} for m in await media.models(kind)]}
        out: dict = {name: {"reglage": media.setting(kind)} for name, kind in AGENT_NAMES.items() if kind in media.KINDS}
        out["voix"] = {"reglage": db.get_setting("media_voice") or "auto"}
        out["gouts"] = db.get_setting("media_preferences") or ""
    except media.MediaError as e:
        return {"disponible": False, "raison": str(e)}
    except httpx.HTTPError:
        return {"disponible": False, "raison": "Le fournisseur ne répond pas. Réessaie dans un instant."}
    return {"disponible": True, "modifiable": owner, "reglages": out,
            "lecture_seule": {"cerveau": {"fournisseur": db.get_setting("provider") or "", "modele": db.get_setting("model") or ""},
                              "cle_de_medias": bool(db.get_setting("media_api_key")) or (db.get_setting("provider") == "openrouter" and bool(db.get_setting("api_key")))},
            "aide": "Liste des modèles : noah.py reglages <type>. Changer : noah.py regler <type> <valeur>. Clés, comptes, sécurité et cerveau : Réglages, par la personne."}


class AgentSetting(BaseModel):
    type: str = Field(max_length=40)
    valeur: str = Field(min_length=1, max_length=2000)


@router.post("/agent-api/reglages")
async def agent_set_setting(body: AgentSetting, request: Request):
    agent_id = relay._agent_from(request)
    if relay.billed_to(agent_id) != db.owner_id():  # réglages communs à tout le serveur : ceux du propriétaire
        raise HTTPException(403, "Ces réglages appartiennent au propriétaire du serveur.")
    value = body.valeur.strip()
    if body.type == "gouts":
        key = "media_preferences"
    else:
        try:
            if body.type == "voix":
                key = "media_voice"
                allowed = {v.get("id") if isinstance(v, dict) else v for m in await media.models("speech") if m["id"] == await media.resolve("speech") for v in m.get("voices", [])}
            else:
                kind = _agent_setting_kind(body.type)
                key = f"media_{kind}"
                allowed = {m["id"] for m in await media.models(kind)}
        except media.MediaError as e:
            return {"erreur": str(e)}
        except httpx.HTTPError:
            return {"erreur": "Le fournisseur ne répond pas. Réessaie dans un instant."}
        if value != "auto" and value not in allowed:
            return {"erreur": f"Valeur inconnue : {value}. La liste : noah.py reglages {body.type}"}
    before = db.get_setting(key) or "auto"
    db.set_setting(key, value)
    media.forget_voice()
    print(f"[reglages] {agent_id} : {key} {before} -> {value}", flush=True)
    return {"ok": True, "type": body.type, "avant": before, "maintenant": value}


@router.get("/agent-api/etat")
async def agent_state(request: Request):
    agent_id = relay._agent_from(request)
    # L'agent d'un profil ne voit ni le total du serveur ni le budget global, seulement ce qui le limite, lui.
    owner = relay.billed_to(agent_id)
    spent, cap = relay.month_cost(), relay.budget()
    if owner != db.owner_id():
        spent, cap = relay.profile_cost(owner), relay.profile_budget(owner)
    return {
        "navigateur": await main._browser_diagnosis(agent_id),
        "budget": {"depense_du_mois": round(spent, 4), "plafond": cap,
                   "atteint": cap is not None and spent >= cap},
    }


@router.post("/agent-api/navigateur/reveiller")
async def agent_browser_wake(request: Request):
    return await main._browser_wake(relay._agent_from(request))


@router.post("/agent-api/navigateur/redemarrer")
async def agent_browser_restart(request: Request):
    return await main._browser_restart(relay._agent_from(request))


class ThreadBody(BaseModel):
    titre: str = Field(min_length=1, max_length=80)
    consigne: str = Field(min_length=1, max_length=20000)


# Runs de fond (fils ouverts par l'agent) : gardés ici pour ne pas être ramassés en cours de route.
_background: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    """Lance une tâche de fond et la retient : la boucle seule n'en garde qu'une référence faible."""
    task = asyncio.create_task(coro)
    if task is not None:  # un banc qui remplace create_task peut ne rien rendre
        _background.add(task)
        task.add_done_callback(_background.discard)
    return task


async def _resume_agent(agent_id: str, text: str, note: str = "", author: str = "user") -> asyncio.Task | None:
    """Message de l'utilisateur envoyé hors du fil (réponse à un appel) : l'agent repart dans sa conversation
    principale, comme si l'utilisateur l'avait tapé ; l'interface voit la conversation changer."""
    conv_id = main._main_conversation(agent_id)
    if not conv_id:
        return None
    # Relancé par le résultat d'un autre agent : le travail a commencé bien avant ce tour, sa fin se notifie quelle que soit sa durée.
    stream = await main._run(main._agent(agent_id), conv_id, text, context=machine.pop_context(conv_id) + note, author=author, live=False,
                        tell_after=0 if author == "agent" else notifications.TELL_AFTER)

    async def drain():
        async for _ in stream:
            pass

    task = asyncio.create_task(drain())
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


@router.post("/agent-api/fils")
async def agent_thread(body: ThreadBody, request: Request):
    """L'agent ouvre un fil de travail parallèle : nouvelle session Hermes, visible dans Détails."""
    agent_id = relay._agent_from(request)
    if access.ambiguous(agent_id):
        raise HTTPException(409, "Plusieurs personnes te parlent en ce moment : fais ce travail dans ta conversation, sans ouvrir de fil.")
    proactif.no_new_work(agent_id)
    who = access.launcher(agent_id)
    conv_id = main._new_conversation(who, agent_id, body.titre, origin="agent")
    taches.creer(conv_id, "fil", titre=body.titre)  # 0.4.0 : double écriture, fermée par coordination.thread_ended
    try:
        stream = await main._run(main._agent(agent_id), conv_id, body.consigne)
    except BaseException:  # le fil n'a pas démarré : la tâche le dit, l'erreur suit son cours
        taches.finir(conv_id, "echec", "le travail n'a pas pu démarrer")
        raise
    coordination.open_trace(agent_id, who, conv_id, "J'ai ouvert un fil", body.titre)
    taches.lier_trace(conv_id)

    async def drain():
        try:
            async for _ in stream:
                pass
        finally:
            coordination.thread_ended(conv_id)

    task = asyncio.create_task(drain())
    _background.add(task)
    task.add_done_callback(_background.discard)
    coordination.inherit(agent_id, conv_id, task)
    return {"id": conv_id, "etat": "en cours"}


async def _wake_for_routine(agent_id: str, title: str, prompt: str) -> dict:
    """Une routine à condition : le cerveau travaille dans un fil à lui, sans l'historique de la conversation principale (moins cher, et
    il ne s'y mêle pas à une tâche en cours). Rend ce qu'il a répondu et ce que ça a coûté ; le fil reste visible dans Détails."""
    conv_id = main._new_conversation(db.agent_owner(agent_id), agent_id, title, origin="agent")
    taches.creer(conv_id, "routine", titre=title)  # 0.4.0 : double écriture, fermée ci-dessous avec le résultat
    try:
        async for _ in await main._run(main._agent(agent_id), conv_id, prompt, live=False):
            pass
    except BaseException:  # le travail s'est coupé : la tâche le dit, l'erreur suit son cours
        taches.finir(conv_id, "echec", "le travail s'est arrêté sans réponse")
        raise
    with db.connect() as c:
        row = c.execute("SELECT role, text FROM messages WHERE conversation_id = ? AND role IN ('agent', 'error') ORDER BY rowid DESC LIMIT 1", (conv_id,)).fetchone()
        cost = c.execute("SELECT COALESCE(SUM(cost), 0) AS total FROM usage WHERE conversation_id = ?", (conv_id,)).fetchone()["total"]
    if row and row["role"] == "agent":
        taches.finir(conv_id, "fini", row["text"])
        return {"texte": row["text"], "cout": cost}
    taches.finir(conv_id, "echec", row["text"] if row else "l'agent n'a rien répondu")
    return {"erreur": row["text"] if row else "l'agent n'a rien répondu", "cout": cost}


def proactive_mode(agent_id: str) -> str:
    """Ce que cet agent peut faire de lui-même : « coupe », « signaler » (il prépare et propose, rien ne change dehors) ou « agir ».
    Pour un tour précis, `proactif.turn_mode(conversation)` rend le mode qui valait à son lancement, None si ce n'est pas un tour de lui-même."""
    return proactif.mode(agent_id)


@router.get("/agent-api/fils/{conv_id}")
def agent_thread_state(conv_id: str, request: Request):
    agent_id = relay._agent_from(request)
    with db.connect() as c:
        row = c.execute("SELECT user_id, shared FROM conversations WHERE id = ? AND agent_id = ?", (conv_id, agent_id)).fetchone()
    # Même règle que /api/conversations/{id}/messages, pour chaque personne de qui cet appel peut venir : sa conversation ou une
    # conversation partagée. L'appel ne dit pas de qui il vient : s'il y en a une qui n'y a pas droit, on ne répond pas.
    callers = access.callers(agent_id)
    readers = {u for u in callers if row and (row["shared"] or (row["user_id"] or access.owner_of(agent_id)) == u)}
    if not readers:
        raise HTTPException(404, "Fil introuvable")
    if readers != callers:
        raise HTTPException(409, "Plusieurs personnes te parlent en ce moment : réessaie quand leurs tâches sont finies.")
    with db.connect() as c:
        last = c.execute(
            "SELECT text FROM messages WHERE conversation_id = ? AND role NOT IN ('user', 'trace') ORDER BY id DESC LIMIT 1", (conv_id,)
        ).fetchone()
    return {"etat": main.task_state.get(conv_id, "idle"), "derniere_reponse": last["text"] if last else None}
