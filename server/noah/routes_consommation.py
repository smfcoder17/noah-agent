"""Consommation, « À toi », activité et session : ce que l'agent fait, ce que la personne doit trancher, ce que ça coûte.
Sorti de main.py sans changement de comportement."""
import asyncio
import json
import re
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, BaseModel
from . import questions, machine, coffre, handoff, desktop, access, session, db, auth, relay, propositions, proactif, coordination, sensitive, accords, main

router = APIRouter()

# --- Consommation -------------------------------------------------------------------------

# L'offre de fin de tâche que le prompt demande (« Va au bout ») : une seule suite, en choix « Oui, vas-y » / « Non ».
_OFFER_OPTIONS = {"oui, vas-y", "non"}
_CHOICE_BLOCK = re.compile(r"```noah\s*(\{[^`]*\"type\"\s*:\s*\"choice\"[^`]*\})\s*```", re.S)


def follow_up_offer(conv_id: str) -> bool:
    """Le choix qui finit cette conversation est l'offre d'une suite, pas une question qui bloque. L'état « choice » ne naît que d'un
    tour fini normalement (_run) : la tâche est faite. Reste à savoir si le choix attend vraiment quelque chose. Le signe fiable est
    le contrat du prompt : la suite proposée se touche par « Oui, vas-y » ou « Non », et rien d'autre ne lui ressemble. Une vraie
    question (« On publie ? » en Oui / Non, deux comptes à départager, un choix au milieu du message) garde ses propres options."""
    with db.connect() as c:
        row = c.execute("SELECT text FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY id DESC LIMIT 1", (conv_id,)).fetchone()
    blocks = list(_CHOICE_BLOCK.finditer(row["text"] if row else ""))
    if not blocks or row["text"][blocks[-1].end():].strip():  # du texte après le choix : il attend la réponse à ce texte
        return False
    try:
        options = json.loads(blocks[-1].group(1)).get("options") or []
    except (ValueError, AttributeError):
        return False
    return {" ".join(str(o).split()).casefold().rstrip(".!") for o in options} == _OFFER_OPTIONS and len(options) == 2


@router.get("/api/a-toi")
def inbox(user: int = Depends(auth.current_user)):
    """Accords du compte qui a lancé le travail, connexions et choix. Une conversation privée reste à son auteur. Une tâche finie
    sur l'offre d'une suite n'attend rien : elle n'y est pas (follow_up_offer)."""
    out = accords.list_accords(user)
    asked = questions.a_la_personne(user)  # 0.4.0 : les questions des agents et leurs choix, une ligne chacune
    for conv_id, state in list(main.task_state.items()):
        login = coffre.pending(conv_id)  # l'état peut être passé à « work » sur un événement de l'agent : la demande, elle, attend toujours
        if (state != "choice" or follow_up_offer(conv_id) or any(q["conversation_id"] == conv_id for q in asked)) and not login:
            continue
        with db.connect() as c:
            row = c.execute("SELECT v.id, v.title, v.main, v.agent_id, v.user_id, a.name, "
                            "CAST(strftime('%s', v.updated_at) AS REAL) AS created "
                            "FROM conversations v JOIN agents a ON a.id = v.agent_id WHERE v.id = ?", (conv_id,)).fetchone()
        if not row or user not in (row["user_id"], access.owner_of(row["agent_id"])):
            continue
        try:
            access.conversation(user, conv_id)
        except HTTPException:
            continue
        if login:  # à son auteur seul : personne d'autre ne saisit de mot de passe pour lui
            if login["user"] == user:
                out.append({"agent_id": row["agent_id"], "agent": row["name"], "conversation_id": conv_id, "titre": row["title"], "main": bool(row["main"]), "a_moi": True, "etat": "approve",
                            "demande": f"Se connecter à {login['site']}" if login["type"] == "connexion" else f"Code demandé par {login['site']}", "apercu": [], "connexion": coffre.asked(conv_id, user), "created": login["created"]})
            continue
        out.append({"agent_id": row["agent_id"], "agent": row["name"], "conversation_id": conv_id, "titre": row["title"], "main": bool(row["main"]), "a_moi": row["user_id"] == user, "etat": state,
                    "demande": "Une question attend ta réponse.", "apercu": [], "created": row["created"]})
    out += [_question_item(q) for q in asked]
    out += _calls_waiting(user)
    return out + propositions.inbox(user)  # ce que ses agents proposent de lui-même


def _question_item(q: dict) -> dict:
    """Une question qui attend la personne : qui demande, pour quelle tâche, le pourquoi, les choix. Elle se répond sur place."""
    conv = q["conversation_id"]
    with db.connect() as c:
        row = c.execute("SELECT title, main, agent_id FROM conversations WHERE id = ?", (conv,)).fetchone()
    return {"type": "question", "id": q["id"], "agent_id": q["de"], "agent": q["de_nom"], "conversation_id": conv, "titre": row["title"] if row else "",
            "main": bool(row["main"]) if row else False, "a_moi": True, "etat": "approve", "demande": q["titre"], "apercu": [], "created": q["cree"], "question": q}


def _calls_waiting(user: int) -> list[dict]:
    """L'agent attend la personne pour une étape à elle (`noah.py appeler` : se connecter, un code, un CAPTCHA). Le bandeau ne se voit
    que dans sa conversation : « À toi » le montre aussi, aux mêmes comptes que le bandeau (droit admin, comme GET …/appel)."""
    found = []
    for agent_id in list(handoff._calls):
        call = handoff.current(agent_id)
        if not call or call["attente"].done() or not access.allowed(user, agent_id, "admin"):
            continue
        conv_id = main._main_conversation(agent_id, user)
        with db.connect() as c:
            row = c.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not row or not conv_id:
            continue
        found.append({"agent_id": agent_id, "agent": row["name"], "conversation_id": conv_id, "titre": "Conversation", "main": True, "a_moi": True,
                      "etat": "approve", "demande": call["message"][:300], "apercu": [], "appel": handoff._public(call), "created": call["depuis"]})
    return found


JOURNAL_KEEP = 2000  # par agent
JOURNAL_SECONDS = 90 * 86400  # un aperçu des derniers temps ; plus ancien, l'agent le retrouve dans ses conversations


def _journal(agent_id: str, conv_id: str | None, kind: str, title: str, result: str, state: str) -> None:
    if not conv_id:
        return
    with db.connect() as c:
        c.execute("INSERT INTO journal (agent_id, conversation_id, kind, titre, resultat, etat, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                  (agent_id, conv_id, kind, title[:200], result[:300], state, time.time()))
        c.execute("DELETE FROM journal WHERE agent_id = ? AND (at < ? OR id NOT IN (SELECT id FROM journal WHERE agent_id = ? ORDER BY id DESC LIMIT ?))",
                  (agent_id, time.time() - JOURNAL_SECONDS, agent_id, JOURNAL_KEEP))


def _first_line(text: str) -> str:
    """La phrase à montrer : sans widget, sans image, sans liste d'adresses de fichiers joints."""
    plain = re.sub(r"```.*?(?:```|$)", "", text, flags=re.S)
    return next((line.strip() for line in plain.splitlines() if line.strip() and not line.startswith("MEDIA:")), "")


@router.get("/api/agents/{agent_id}/activite")
def activity(agent_id: str, user: int = Depends(auth.current_user)):
    """Ce qu'a fait l'agent, le plus récent d'abord. Comme la conversation : une conversation privée reste à son auteur."""
    access.access(user, agent_id, "lecture")
    with db.connect() as c:
        rows = c.execute("SELECT j.kind, j.titre, j.resultat, j.etat, j.at, j.conversation_id, v.main FROM journal j JOIN conversations v ON v.id = j.conversation_id "
                         "WHERE j.agent_id = ? AND (v.user_id = ? OR v.shared) AND j.at >= ? ORDER BY j.id DESC LIMIT 500",
                         (agent_id, user, time.time() - JOURNAL_SECONDS)).fetchall()
    return [{**dict(r), "main": bool(r["main"]), "de_lui_meme": r["kind"] == "proactif" or r["titre"].startswith(proactif.ANCIENNE_MARQUE)} for r in rows]


@router.get("/api/agents/{agent_id}/session")
async def agent_session(agent_id: str, user: int = Depends(auth.current_user)):
    """La barre de session : ce que l'agent fait maintenant, dans ce que cette personne a le droit de voir. Relue toutes les
    deux secondes : rien ici n'attend la machine de l'agent, sauf les routines, lues à part et gardées quelques secondes."""
    access.access(user, agent_id, "lecture")
    with db.connect() as c:
        rows = c.execute("SELECT id, title, origin, main, user_id FROM conversations WHERE agent_id = ? AND (user_id = ? OR shared = 1)",
                         (agent_id, user)).fetchall()
        asked = c.execute("SELECT d.id, d.vers, d.consigne, d.created_at, d.conversation_id, a.name FROM delegations d LEFT JOIN agents a ON a.id = d.vers "
                          "WHERE d.de = ? AND d.etat = 'en_cours' ORDER BY d.created_at", (agent_id,)).fetchall()
    visible = {r["id"] for r in rows}
    work = [{"id": r["id"], "titre": r["title"], "origine": r["origin"], "main": bool(r["main"]) and r["user_id"] == user,
             "etat": "approve" if main.task_state.get(r["id"]) == "approve" else "work", "activite": main.task_activity.get(r["id"])}
            for r in rows if coordination._busy(agent_id, r["id"])]
    # Une demande passée à un autre agent : son nom et sa consigne, seulement si elle part d'une conversation que la personne voit
    # (comme les processus), et si elle voit aussi cet agent-là.
    others = [{"id": d["id"], "agent": d["name"] or d["vers"], "titre": d["consigne"].split("\n")[0][:120], "debut": d["created_at"]}
              for d in asked if d["conversation_id"] in visible and access.right(user, d["vers"])]
    confided = (await desktop.user_tasks(agent_id, user))["taches"] if access.owner_of(agent_id) == user else []
    return {"travaux": work, "processus": session.processes(agent_id, visible), "demandes": others, "confiees": confided,
            "routines": await _running_routines(agent_id, user)}


_routine_cache: dict[str, tuple[float, list[dict]]] = {}
_routine_reading: dict[str, asyncio.Task] = {}


async def _read_routines(agent_id: str) -> None:
    try:
        found = await asyncio.wait_for(machine.admin(agent_id, "routines", timeout=4), 5)
        running = [{"id": str(r.get("id")), "titre": r.get("name") or "", "depuis": r.get("last_run_at")}
                   for r in found.get("routines") or [] if isinstance(r, dict) and str(r.get("state") or "").lower() in ("running", "en_cours")]
    except (asyncio.TimeoutError, HTTPException, httpx.HTTPError):
        running = []
    except Exception as e:  # noqa: BLE001 - réponse inattendue : la barre continue, et le journal le dit (relecture 0.3.0, partie 5 n°6)
        print(f"[session] routines de {agent_id} illisibles : {type(e).__name__}: {e}", flush=True)
        running = []
    _routine_cache[agent_id] = (time.monotonic(), running)


async def _running_routines(agent_id: str, user: int) -> list[dict]:
    """Les routines qui tournent en ce moment. Elles font partie des réglages de l'agent : seulement pour qui les administre.
    La machine de l'agent est lue à part, au plus une fois toutes les dix secondes : une machine lente ou éteinte ne retient
    jamais la barre de session, qui répond avec la dernière lecture."""
    if access.right(user, agent_id) not in ("proprietaire", "admin"):
        return []
    at, cached = _routine_cache.get(agent_id, (0.0, []))
    reading = _routine_reading.get(agent_id)
    if time.monotonic() - at >= 10 and (reading is None or reading.done()):
        task = asyncio.create_task(_read_routines(agent_id))
        _routine_reading[agent_id] = task
        await asyncio.wait({task}, timeout=0.3)  # une machine qui répond vite donne déjà sa réponse
    return _routine_cache.get(agent_id, (0.0, cached))[1]
# Des jetons sans coût, hors modèle gratuit : le prix de ce modèle est inconnu. L'écran dit « prix inconnu », jamais 0 $ (C5). Un appel
# compris dans un abonnement par le PC (Claude Code, ChatGPT) n'est pas « prix inconnu » (A7). Une seule règle, pour le total et le détail.
NO_PRICE = ("u.cost = 0 AND u.prompt_tokens + u.completion_tokens > 0 AND u.model NOT LIKE '%:free' "
            "AND u.model NOT LIKE '% · abonnement' AND u.model NOT LIKE 'forfait%'")
UNPRICED = f"SUM(CASE WHEN {NO_PRICE} THEN 1 ELSE 0 END)"


@router.get("/api/usage")
def usage(user: int = Depends(auth.current_user)):
    """Ce que ce profil paie, et ce qu'il a lui-même dépensé sur un agent partagé avec lui ; rien des autres. Le
    propriétaire de l'installation voit en plus le total du serveur, celui que son budget global limite."""
    installation = access.is_owner(user)
    # Dépense visible : sur un de ses agents, ou faite dans une de ses conversations sur un agent qui lui est encore partagé.
    mine = ("(u.owner_id = :me" + (" OR u.owner_id IS NULL" if installation else "") + ")")
    seen = (f"({mine} OR (v.user_id = :me AND EXISTS (SELECT 1 FROM agent_shares s "
            "WHERE s.agent_id = u.agent_id AND s.user_id = :me)))")
    with db.connect() as c:
        rows = c.execute(
            "SELECT u.agent_id, COALESCE(a.name, u.agent_id) AS name, SUM(u.cost) AS cost, "
            "SUM(u.prompt_tokens + u.completion_tokens) AS tokens, COUNT(*) AS calls, "
            "SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.cached_tokens) AS cached_tokens, " + UNPRICED + " AS sans_prix "
            "FROM usage u LEFT JOIN agents a ON a.id = u.agent_id LEFT JOIN conversations v ON v.id = u.conversation_id "
            f"WHERE u.created_at >= :start AND {seen} GROUP BY u.agent_id ORDER BY cost DESC",
            {"start": relay.month_start(), "me": user},
        ).fetchall()
        # Des jetons sans coût : le plafond ne les a pas comptés. Un modèle gratuit le dit dans son nom. Le propriétaire règle le budget de tout le serveur.
        unpriced = c.execute(
            "SELECT 1 FROM usage u LEFT JOIN conversations v ON v.id = u.conversation_id "
            f"WHERE u.created_at >= :start AND {'1 = 1' if installation else seen} AND {NO_PRICE} LIMIT 1",
            {"start": relay.month_start(), "me": user},
        ).fetchone()
    ids = [a["id"] for a in main._agents() if access.right(user, a["id"]) == "proprietaire"]
    today = {i: {"depense": round(relay.day_cost(i), 4), "plafond": relay.daily_cap(i)} for i in ids}
    with db.connect() as c:
        # Par jour (chez l'utilisateur), sur 14 jours, et par tâche ce mois-ci : où part l'argent. Regroupé par tranche
        # de 10 minutes en SQL, puis rangé dans son jour avec le décalage horaire de cette date (heure d'été).
        slices = c.execute(
            "SELECT u.agent_id, substr(u.created_at, 1, 15) || '0:00' AS slice, SUM(u.cost) AS cost, " + UNPRICED + " AS sans_prix, "
            "SUM(u.prompt_tokens + u.completion_tokens) AS tokens, COUNT(*) AS calls "
            "FROM usage u LEFT JOIN conversations v ON v.id = u.conversation_id "
            f"WHERE u.created_at >= datetime('now', '-15 days') AND {seen} GROUP BY u.agent_id, slice", {"me": user},
        ).fetchall()
    by_day: dict[tuple[str, str], dict] = {}
    for r in slices:
        d = by_day.setdefault((r["agent_id"], relay.local_day(r["slice"])), {"cost": 0.0, "tokens": 0, "calls": 0, "sans_prix": 0})
        d["sans_prix"] += r["sans_prix"]
        d["cost"] += r["cost"]
        d["tokens"] += r["tokens"]
        d["calls"] += r["calls"]
    days = [{"agent_id": a, "day": day, **v} for (a, day), v in sorted(by_day.items(), key=lambda kv: kv[0][1])]
    with db.connect() as c:
        tasks = c.execute(
            "SELECT u.agent_id, u.conversation_id, COALESCE(v.title, 'Travail de fond') AS title, v.main, "
            "SUM(u.cost) AS cost, SUM(u.prompt_tokens + u.completion_tokens) AS tokens, COUNT(*) AS calls, " + UNPRICED + " AS sans_prix "
            "FROM usage u LEFT JOIN conversations v ON v.id = u.conversation_id "
            f"WHERE u.created_at >= :start AND {seen} AND (v.user_id = :me OR u.conversation_id IS NULL) "
            "GROUP BY u.agent_id, u.conversation_id ORDER BY cost DESC, tokens DESC LIMIT 50",
            {"start": relay.month_start(), "me": user},
        ).fetchall()
    daily = db.get_setting("budget_daily")
    spent, cap = relay.profile_cost(user), relay.profile_budget(user)
    return {"non_suivi": bool(unpriced), "month_cost": relay.month_cost() if installation else spent, "budget": relay.budget() if installation else cap,
            "agents": [dict(r) for r in rows], "profil": {"depense": round(spent, 4), "plafond": cap},
            "daily": float(daily) if daily and installation else None, "today": today,
            "days": days,
            # Un titre écrit par l'agent (fil, routine) peut recopier une clé : elle reste masquée ici aussi.
            "tasks": [{**dict(r), "title": sensitive.mask_keys(r["title"]), "main": bool(r["main"])} for r in tasks]}


class Budget(BaseModel):
    monthly: float | None = Field(default=None, ge=0, le=100000)
    daily: float | None = Field(default=None, ge=0, le=100000)  # par agent et par jour (fuseau de l'utilisateur)


@router.post("/api/budget")
def set_budget(body: Budget, user: int = Depends(access.owner_only)):
    db.set_setting("budget_monthly", "" if body.monthly is None else str(body.monthly))
    if "daily" in body.model_fields_set:
        db.set_setting("budget_daily", "" if body.daily is None else str(body.daily))
    return {"ok": True}


class AgentCap(BaseModel):
    daily: float | None = Field(default=None, ge=0, le=100000)  # None : le plafond de tous les agents s'applique


@router.put("/api/agents/{agent_id}/plafond")
def set_agent_cap(agent_id: str, body: AgentCap, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "proprietaire")  # c'est son argent : un partage, même admin, n'y touche pas
    db.set_setting(f"budget_daily:{agent_id}", "" if body.daily is None else str(body.daily))
    return {"ok": True}
