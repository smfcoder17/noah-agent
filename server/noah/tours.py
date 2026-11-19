"""Le tour d'un agent : aides du tour (qui parle, conversation neuve, heure, invité), le tour lui-même (`_run`), les délégations, l'accord à donner pendant un tour et les tâches en cours.
Sorti de main.py sans changement de comportement."""
import asyncio
import contextlib
import hashlib
import json
import re
import time
import uuid
from dataclasses import replace
from datetime import datetime

import httpx
from fastapi import Request, Depends, HTTPException, APIRouter
from pydantic import BaseModel

from .hermes import Agent
from . import desktop, mcp, session, diagnostics, updates, notifications, machine, access, chauffe, auth, db, proactif, push, apprentissage, pendant, handoff, coordination, relay, recu, hermes, events, accords, bus, taches, questions, main

router = APIRouter()


def _speaker(user: int, agent_id: str) -> str:
    return _who_speaks(user, agent_id) + notifications.call_note(user)


def _who_speaks(user: int, agent_id: str) -> str:
    """Sur un agent partagé, il sait à qui il parle. Rien pour le propriétaire tant que personne ne partage sa mémoire : le
    début du prompt reste le même, donc en cache, et son comportement ne change pas."""
    owner = access.owner_of(agent_id)
    name = re.sub(r"[\[\]\s]+", " ", access.username(user)).strip()
    if access.separated(user, agent_id):
        return (f"[Cette conversation est avec {name}, avec qui ton propriétaire te partage. Ici, ta mémoire et ton navigateur sont "
                f"ceux de {name}. Tu n'as ni les comptes connectés de ton propriétaire, ni sa mémoire, ni terminal : seulement tes outils "
                "de recherche, de navigateur, de mémoire et le dossier de travail commun, et `python3 /opt/data/noah.py` pour créer "
                "un média, ouvrir un fil, ou rappeler. Dis-le simplement si une demande sort de là.]\n\n")
    with db.connect() as c:
        common = c.execute("SELECT 1 FROM agent_shares WHERE agent_id = ? AND droit = 'admin' LIMIT 1", (agent_id,)).fetchone()
    if user == owner and not common:
        return ""
    who = f"{name}, ton propriétaire" if user == owner else f"{name}, avec qui ton propriétaire te partage"
    return (f"[Cette conversation est avec {who}. Tu sers plusieurs personnes : chacune a ses conversations, mais ta mémoire, "
            f"ton navigateur et tes comptes connectés sont communs. Ne répète pas à {name} ce que d'autres t'ont confié, "
            "et note en mémoire à qui appartient une préférence.]\n\n")


def _left_open(agent_id: str, conv_id: str) -> str:
    """Ce qui est resté en suspens, dit à l'agent avant un nouveau message de la personne. Sans ça, un « salut » repart sur l'ancienne
    demande : l'historique se finit par un outil coupé (« vérifie l'état avant de réessayer ») et rien ne dit que c'est fini."""
    notes = []
    asked = db.get_setting(f"tour_ouvert:{conv_id}")
    if asked:
        notes.append(f"Ta demande précédente (« {asked} ») s'est arrêtée avant la fin, et plus rien n'est en cours pour elle.")
    call = handoff.left_open(agent_id)
    if call:
        notes.append(call)
    if not notes:
        return ""
    return ("[Note de Noah, que la personne ne voit pas. " + " ".join(notes) + " Réponds au message ci-dessous, et à lui seul : ne relance ni cette demande, "
            "ni ses outils, ni ses appels, sauf si ce message le demande ou s'y rapporte clairement.]\n\n")


def _new_conversation(user: int, agent_id: str, title: str, main: bool = False, origin: str = "user") -> str:
    conv_id = uuid.uuid4().hex
    with db.connect() as c:
        c.execute(
            "INSERT INTO conversations (id, user_id, agent_id, title, main, origin) VALUES (?, ?, ?, ?, ?, ?)",
            (conv_id, user, agent_id, title[:80], int(main), origin),
        )
    return conv_id


def _error_details(agent: Agent, raw: str, run_id: str | None = None) -> str:
    """Ce qu'il faut pour diagnostiquer une erreur, à copier chez un agent. Secrets masqués, et l'adresse du service reste au serveur."""
    m = main.model_for(agent.id) or {}
    diagnostics.record("tâche", raw, agent.id)
    return diagnostics.mask("\n".join((
        f"Quand : {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())} UTC",
        f"Version de Noah Agent : {updates.shown_version()} (construction {updates.VERSION})",
        f"Agent : {agent.id}",
        f"Fournisseur : {m.get('provider') or 'aucun'}",
        f"Modèle : {m.get('model') or 'aucun'}",
        f"Exécution : {run_id or 'non démarrée'}",
        f"Erreur : {raw or 'aucun message'}",
    )))


async def _guest_agent(agent: Agent, user: int | None) -> Agent:
    """Une personne avec qui l'agent est partagé lui parle dans son propre profil Hermes, tenu à jour du modèle et du rôle de
    l'agent. Le droit admin, et lui seul, parle à la mémoire et aux comptes de l'agent (voir access.separated)."""
    if not access.separated(user, agent.id):
        return agent
    profile = access.guest_profile(user)
    with db.connect() as c:
        row = c.execute("SELECT name, role FROM agents WHERE id = ?", (agent.id,)).fetchone()
    raw = json.dumps([main._config_rev(agent.id), row["name"] if row else "", row["role"] if row else "", main.AGENT_SETUP_VERSION])
    version, key = hashlib.sha256(raw.encode()).hexdigest(), f"invite:{agent.id}:{profile}"
    if db.get_setting(key) != version:
        async with _guest_locks.setdefault(key, asyncio.Lock()):  # deux premiers messages en même temps : un seul prépare
            if db.get_setting(key) != version:
                await hermes.prepare_guest(agent.id, profile)
                if not access.allowed(user, agent.id, "usage"):  # partage retiré pendant la préparation : rien ne reste derrière
                    await main._forget_guest(agent.id, user)
                    raise HTTPException(404, "Agent introuvable")
                db.set_setting(key, version)
    return replace(agent, profile=profile)


_guest_locks: dict[str, asyncio.Lock] = {}
task_activity: dict[str, str] = {}  # la dernière ligne de travail de chaque conversation, pour un écran qui arrive en cours de route


async def _start_run(agent: Agent, text: str, session: str) -> str:
    """Un profil perdu (machine restaurée, clé changée) se refait ; il ne retombe jamais sur la mémoire de l'agent."""
    try:
        return await hermes.start_run(agent, text, session_id=session)
    except httpx.HTTPStatusError as e:
        if not agent.profile or e.response.status_code not in (401, 404):
            raise
    await hermes.prepare_guest(agent.id, agent.profile)
    return await hermes.start_run(agent, text, session_id=session)


DAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre")


def _today() -> str:
    """Hermes date une conversation du jour où elle a commencé (« Conversation started ») : la conversation principale dure des
    semaines, et l'agent croyait encore être ce jour-là (« réponds avant jeudi » pour une fête le lendemain). Chaque tour lui dit
    le jour et l'heure chez la personne."""
    now = datetime.now(updates.local_zone())
    return f"[Nous sommes le {DAYS[now.weekday()]} {now.day} {MONTHS[now.month - 1]} {now.year}, {now.hour} h {now.minute:02d}, heure de la personne. Tu la tutoies.]\n\n"


async def _run(agent: Agent, conv_id: str, prompt: str, details: bool = False, context: str = "", author: str = "user",
               live: bool = True, tell_after: float = notifications.TELL_AFTER):
    """Lance un run Hermes dans une conversation et rend le générateur SSE qui l'enregistre au fil de l'eau.
    `context` précède le message pour l'agent seulement : l'utilisateur ne le voit pas. `author` : qui l'a écrit, à l'écran.
    `live` : le flux rendu va à un écran (sinon, personne ne le lit). `tell_after` : durée à partir de laquelle la fin se notifie."""
    began = time.time()
    if updates.maintenance:  # le lanceur recrée les agents : une tâche lancée maintenant serait coupée
        raise HTTPException(503, "Noah installe une mise à jour (quelques minutes). Réessaie juste après.")
    main.task_state[conv_id] = "work"  # avant le premier await : une mise à jour qui vérifie maintenant la voit
    coordination.start_actions(conv_id)
    apprentissage.note_turn(conv_id, author)
    main._save_message(conv_id, author, prompt)
    if author == "user":
        questions.fermer_choix(conv_id)  # 0.4.0 : la personne a écrit dans la conversation, les choix qui attendaient sont réglés
        taches.premier_message(conv_id, prompt)  # 0.4.0 : une nouvelle discussion prend le titre de ce qu'on y demande
    # Configuration qui sert à cette exécution (preuve de l'essai de l'assistant) : celle que l'agent a vraiment reçue.
    rev = main._config_rev(agent.id)
    if db.get_setting(f"applied:{agent.id}") != rev:
        rev = "aucune"
    trial = db.get_setting("onboarded") == "0"  # essai de l'assistant : borné, et arrêté s'il est abandonné
    launched_by = main._conversation_owner(conv_id)  # avant l'attente : le profil peut disparaître, avec ses conversations
    context = main._today() + proactif.goals_context(launched_by, agent.id) + context
    if launched_by is not None and not access.allowed(launched_by, agent.id, "usage"):  # accès retiré depuis la demande : on ne prépare rien
        main.task_state[conv_id] = "idle"
        raise HTTPException(404, "Agent introuvable")
    try:
        agent = await main._guest_agent(agent, launched_by)
        try:
            run_id = await _start_run(agent, context + prompt, f"noah-{conv_id}")
        except Exception:
            # Machine de l'agent arrêtée (Docker relancé, ordinateur éteint) : on la réveille et on réessaie une fois,
            # plutôt que de répondre « l'agent ne répond pas » jusqu'à ce que quelqu'un la relance à la main.
            with contextlib.suppress(Exception):
                await hermes.restart(agent.id)
            if not await main._wait_online(agent, 120):
                raise
            run_id = await _start_run(agent, context + prompt, f"noah-{conv_id}")
    except Exception as e:
        main.task_state[conv_id] = "error"
        sentence = "L'agent ne répond pas. Il redémarre peut-être, par exemple après un changement de modèle : réessaie dans un instant."
        main._save_message(conv_id, "error", sentence, _error_details(agent, f"{type(e).__name__}: {e}"))  # sinon ce message reste sans réponse
        raise HTTPException(503, sentence)

    updates.activity()
    db.set_setting(f"tour_ouvert:{conv_id}", " ".join(prompt.split())[:200])  # effacé à sa fin normale : un redémarrage ne perd pas l'information (voir _left_open)
    _runs[run_id] = {"agent": agent.id, "user": launched_by, "conv": conv_id, "profil": agent.profile}
    if launched_by is not None and not access.allowed(launched_by, agent.id, "usage"):  # retiré pendant le démarrage d'Hermes
        main.task_state[conv_id] = "idle"
        with contextlib.suppress(Exception):
            await hermes.stop_run(agent, run_id)
        raise HTTPException(404, "Agent introuvable")

    gave_up = [False]  # modèle jamais joint pendant cette tâche : le run arrêté finit par ce motif

    async def live_events():
        """Un tour perdu dans un redémarrage bloque la conversation pour toujours : on en prend acte, et ce message repart."""
        nonlocal run_id
        session = f"noah-{conv_id}"
        async for kind, data in hermes.run_events(agent, run_id):
            if kind != "run.failed" or data.get("error") != hermes.LOST_TURN:
                yield kind, data
                continue
            try:
                await hermes.discard_lost_turn(agent.id, session, agent.profile)
                new_id = await hermes.start_run(agent, context + prompt, session_id=session)
            except Exception as e:
                print(f"[tâche] tour perdu non levé sur {agent.id} : {e}", flush=True)
                yield kind, data
                return
            accords.sweep(run_id=run_id)
            _runs[new_id] = _runs.pop(run_id, {"agent": agent.id, "user": launched_by, "conv": conv_id, "profil": agent.profile})
            run_id = new_id
            yield "noah.relance", {}
            async for pair in hermes.run_events(agent, run_id):
                yield pair
            return

    async def body():
        relay.turn_model.pop(conv_id, None)  # le modèle de ce tour, pas celui du précédent
        relay.turn_notes.pop(conv_id, None)  # « ton ordinateur est éteint » ne vaut que pour le tour qui l'a vécu
        yield main._sse({"type": "start", "conversation_id": conv_id, "run_id": run_id})
        reply: list[str] = []  # ce que l'agent écrit depuis son dernier outil : sa réponse s'il n'en lance plus
        steps: list[str] = []  # ce qu'il a écrit avant un outil : le récit de son travail, rangé à part
        kept: list[str] = []  # écrit avant un outil, mais à montrer : un widget, une image
        head = events.ReactionHead()
        answered = main._last_user_message(conv_id)  # une question posée ensuite, pendant le travail, n'est pas ce à quoi il réagit
        final: dict | None = None
        delegated: list[tuple[str, bool]] = []  # (fil, en arrière-plan) des délégations en cours, dans l'ordre
        ledger = recu.Ledger()  # ce que ses outils font : ce à quoi sa réponse sera comparée
        plan = events.Plan()  # son plan (outil todo), s'il en tient un : la ligne de travail dit l'étape en cours
        try:
            async for kind, data in live_events():
                if kind == "noah.relance":
                    yield main._sse({"type": "start", "conversation_id": conv_id, "run_id": run_id})
                    yield main._sse({"type": "activity", "label": "Le travail précédent a été coupé par un redémarrage. Il n'est pas repris."})
                    continue
                ledger.feed(kind, data)
                session.note(agent.id, conv_id, kind, data)
                if (data.get("tool_name") or data.get("tool")) == "delegate_task":
                    if kind == "tool.started":
                        args = data.get("args") if isinstance(data.get("args"), dict) else {}
                        delegated.append((_open_delegation(conv_id, args), bool(args.get("background"))))
                    elif kind in ("tool.completed", "tool.failed") and delegated:
                        thread, background = delegated.pop(0)
                        if background and kind == "tool.completed":
                            _close_delegation(thread, "Lancée en arrière-plan : le résultat arrivera dans la conversation principale.", False)
                        else:
                            _close_delegation(thread, data.get("preview"), kind == "tool.failed")
                if kind == "tool.started":
                    coordination.note_action(conv_id, events.tool_label(str(data.get("tool") or data.get("tool_name") or "")))
                    said = "".join(reply).strip()
                    reply.clear()
                    if said:
                        (kept if main._SHOWS_SOMETHING.search(said) else steps).append(said)
                        yield main._sse({"type": "etape"})
                out = events.translate(kind, data, details, plan)
                if not out:
                    continue
                if out["type"] == "done" and gave_up[0]:
                    out = {"type": "done", "status": "failed", "error": relay.UNREACHABLE, "raw_error": relay.UNREACHABLE}
                if out["type"] == "done" and out.get("status") == "failed":
                    # Hermes résume un refus de plafond (402) en « plus de crédit chez le fournisseur » : on donne la vraie raison.
                    refused = relay.spending_refusal(agent.id)
                    if refused:
                        out = {**out, "error": refused}
                if out["type"] == "done" and "raw_error" in out:
                    out["details"] = _error_details(agent, out.pop("raw_error"), run_id)
                if out["type"] == "approval":
                    command = bool(out.pop("commande", False))
                    out = {**out, **mcp.plain_request(str(out.get("summary") or ""), command)}
                    out = {**out, **accords.create(launched_by, agent.id, conv_id, run_id, out)}
                if out["type"] == "approval" and main.task_state.get(conv_id) != "approve":
                    # Celui qui a lancé la tâche et le propriétaire de l'agent : pas les autres profils partagés.
                    for target in dict.fromkeys((main._conversation_owner(conv_id), access.owner_of(agent.id))):
                        push.notify("Noah attend ton accord", str(out.get("demande") or "Une action demande ton accord."),
                                    urgent=True, user_id=target, kind="accord")
                if out["type"] == "approval":
                    main.task_state[conv_id] = "approve"
                elif main.task_state.get(conv_id) != "approve" or not accords.pending(conv_id=conv_id):
                    main.task_state[conv_id] = "work"
                if out["type"] == "activity":
                    task_activity[conv_id] = out["label"]
                if out["type"] in ("activity", "approval", "done"):
                    await asyncio.to_thread(bus.invalidate, launched_by)
                if out["type"] == "message":
                    emoji, text = head.feed(out["text"])
                    if emoji:
                        main._agent_reacts(answered, emoji)
                        yield main._sse({"type": "reaction", "emoji": emoji})
                    if not text:
                        continue
                    out = {**out, "text": text}
                    reply.append(text)
                if out["type"] == "done":
                    emoji, text = head.flush()
                    if text:
                        reply.append(text)
                        yield main._sse({"type": "message", "text": text})
                    if out.get("status") in ("completed", None):
                        # L'écran finit sur ce que la conversation garde : un texte coupé par des détails ou rangé trop tôt se répare ici.
                        settled, left = main._final_answer(reply, steps, kept, out.get("output") or "", True)
                        out = {**out, "reponse": settled, "etapes": left, "recu": recu.of_turn(conv_id, settled, ledger)}
                        if relay.turn_notes.get(conv_id) and settled:  # le secours a répondu à la place de l'ordinateur : une ligne le dit
                            out["reponse"] = f"_{relay.turn_notes[conv_id]}_\n\n{settled}"
                    if relay.turn_model.get(conv_id):  # l'écran marque la réponse sans attendre de relire la conversation
                        out = {**out, "model": relay.turn_model[conv_id]}
                yield main._sse(out)
                if out["type"] == "done":
                    final = out
                    break
        except Exception as e:
            final = {"type": "done", "status": "failed", "error": "L'agent ne répond plus. Il redémarre peut-être : réessaie dans un instant.",
                     "details": _error_details(agent, f"{type(e).__name__}: {e}", run_id)}
            yield main._sse(final)
        finally:
            # Même quand l'écran se déconnecte en cours de tour : aucun lancement sans réponse ne reste affiché (relecture 0.3.0, partie 5 n°5).
            session.run_ended(agent.id, conv_id)
        _, cut_short = head.flush()  # coupé avant de savoir si le début retenu était une réaction : c'était du texte
        if cut_short:
            reply.append(cut_short)
        if final is None and not reply:  # flux fini sans événement de fin : l'écran attendrait, et la conversation resterait sans réponse
            final = {"type": "done", "status": "failed", "error": "Le travail s'est arrêté avant la fin. Renvoie ton message si besoin.",
                     "details": _error_details(agent, "Le flux de l'agent s'est terminé sans événement de fin.", run_id)}
            yield main._sse(final)
        for thread, _ in delegated:  # run interrompu pendant une délégation
            _close_delegation(thread, None, True)
        succeeded = bool(final) and final.get("status") in ("completed", None)
        if succeeded and not any(CHOICE_RE.search(k) for k in kept):
            # Les réponses à toucher demandent un appel au petit modèle (jusqu'à 7 s) : la fin de la réponse est déjà
            # partie, elles suivent dans un événement à part et rejoignent le message enregistré.
            block = await main._quick_reply_block(agent.id, "".join(reply).strip())
            if block:
                reply.append(block)
                yield main._sse({"type": "choix", "text": block})
        text, steps = main._final_answer(reply, steps, kept, (final or {}).get("output") or "", succeeded)
        if not final or final.get("status") not in ("completed", None):
            main.task_state[conv_id] = "error" if final and final.get("status") == "failed" else "idle"
        else:
            main.task_state[conv_id] = "choice" if CHOICE_RE.search(text) else "done"
            with db.connect() as c:
                c.execute("DELETE FROM settings WHERE key = ?", (f"tour_ouvert:{conv_id}",))
        main._model_replied(final, text, rev)
        receipt = recu.of_turn(conv_id, text, ledger) if succeeded and text else None
        pc_note = relay.turn_notes.pop(conv_id, None)  # le secours a répondu à la place de l'ordinateur : la conversation garde la ligne
        if text:
            main._save_message(conv_id, "agent", f"_{pc_note}_\n\n{text}" if pc_note else text, recu.detail_of(steps, receipt), relay.turn_model.pop(conv_id, None))
            if main.task_state.get(conv_id) == "choice":  # 0.4.0 : un choix proposé à la personne devient une ligne de `questions`
                with contextlib.suppress(Exception):
                    with db.connect() as c:
                        last_id = c.execute("SELECT MAX(id) AS n FROM messages WHERE conversation_id = ? AND role = 'agent'", (conv_id,)).fetchone()["n"]
                    questions.ouvrir_choix(conv_id, text, last_id)
            note = recu.note_for_agent(receipt)
            if note:
                machine.add_context(conv_id, note)
        elif final and final.get("error"):
            main._save_message(conv_id, "error", final["error"], final.get("details"))
        await asyncio.to_thread(bus.invalidate, launched_by)
        with contextlib.suppress(Exception):  # le journal ne doit jamais abîmer une tâche finie
            with db.connect() as c:
                asked_row = c.execute("SELECT text FROM messages WHERE id = ?", (answered,)).fetchone()
            own = proactif.turn_title(conv_id)  # un tour de lui-même : son titre, pas la consigne que Noah lui a donnée
            main._journal(agent.id, conv_id, "proactif" if own else "tache", own or (main._first_line(asked_row["text"]) if asked_row else "Tâche"), main._first_line(text),
                     ("a_verifier" if recu.needs_attention(receipt) else "fait") if succeeded else "erreur" if final and final.get("status") == "failed" else "arrete")
        with contextlib.suppress(Exception):  # une notification perdue ne doit pas abîmer une tâche finie
            _tell_turn_end(agent.id, conv_id, launched_by, final, recu.notice(receipt) + text, time.time() - began, tell_after,
                           live and listening[0] and not notifications.is_hidden(conv_id))
        with contextlib.suppress(Exception):  # ne rien apprendre n'abîme pas une tâche finie
            apprentissage.after_turn(agent, conv_id, launched_by, author, answered, prompt, text, succeeded)
        if relay.context_size.pop(conv_id, 0) >= hermes.CONTEXT_LIMIT and not updates.maintenance:
            compacting = asyncio.create_task(chauffe.compact(agent, f"noah-{conv_id}"))
            main._background.add(compacting)
            compacting.add_done_callback(main._background.discard)


    # Le run est suivi jusqu'au bout même si le client part (téléphone fermé, réseau coupé) : la réponse est
    # enregistrée et l'état de la tâche reste juste (une mise à jour attend vraiment sa fin).
    queue: asyncio.Queue = asyncio.Queue()
    listening = [True]

    async def pump():
        relay.active.setdefault(agent.id, []).append(conv_id)  # appels au modèle comptés pour cette tâche
        try:
            async for chunk in body():
                if listening[0]:  # client parti : on suit le run sans plus rien garder en mémoire pour lui
                    queue.put_nowait(chunk)
        finally:
            relay.active[agent.id].remove(conv_id)
            accords.sweep(run_id=run_id)
            _runs.pop(run_id, None)
            queue.put_nowait(None)
            pendant.wake(conv_id)
    task = asyncio.create_task(pump())
    main._running_runs.add(task)
    task.add_done_callback(main._running_runs.discard)

    async def watch_model():
        """Un modèle injoignable se dit tout de suite. Sans une seule réponse depuis le début de la tâche, elle s'arrête ;
        après, elle continue d'attendre : une coupure courte ne doit pas perdre un long travail."""
        started = time.time()
        told = False
        relay.forget_failure(agent.id)
        while not task.done():
            await asyncio.sleep(main.MODEL_WATCH)
            down = relay.failing_for(agent.id)
            if down is None:
                told = False
                continue
            if not told and listening[0]:
                told = True
                queue.put_nowait(main._sse({"type": "activity", "label": "Le modèle ne répond pas, nouvel essai…"}))
            if down >= main.MODEL_DOWN_LIMIT and not relay.reached_since(agent.id, started):
                gave_up[0] = True
                with contextlib.suppress(Exception):
                    await hermes.stop_run(agent, run_id)
                return
    main._spawn(watch_model())

    if trial:
        async def deadline():
            await asyncio.sleep(TRIAL_LIMIT)
            if not task.done():
                await hermes.stop_run(agent, run_id)
        main._spawn(deadline())

    async def stream():
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(queue.get(), HEARTBEAT)
                except asyncio.TimeoutError:
                    yield ": vivant\n\n"  # l'app distingue un agent qui réfléchit d'une connexion devenue muette
                    continue
                if chunk is None:
                    break
                yield chunk
        finally:
            listening[0] = False
            if trial and not task.done():  # essai de l'assistant abandonné (réseau coupé, page quittée) : on l'arrête
                main._spawn(hermes.stop_run(agent, run_id))

    return stream()


def _tell_turn_end(agent_id: str, conv_id: str, user: int | None, final: dict | None, text: str, took: float, after: float, followed: bool) -> None:
    """Fin d'un tour : une notification normale si la personne n'est pas là pour la voir. Pas pour une tâche qu'elle a
    arrêtée, ni pour le travail interne (fil, demande d'un autre agent : son résultat revient à l'agent qui l'a demandé),
    ni si un rappel vient de lui donner ce compte rendu."""
    if user is None:
        return
    already = notifications.take_reported(agent_id, user)
    status = (final or {}).get("status") or "completed"
    if already or followed or notifications.seen_recently(conv_id) or took < after or status not in ("completed", "failed"):
        return
    with db.connect() as c:
        row = c.execute("SELECT a.name, c.origin FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?", (conv_id,)).fetchone()
    if not row or row["origin"] == "agent" or db.get_setting("onboarded") == "0":
        return
    title, body = row["name"], notifications.first_sentence(text)
    if status == "failed":
        title, body = f"{row['name']} n'a pas pu finir", notifications.first_sentence((final or {}).get("error") or text or "La tâche s'est arrêtée avant la fin.")
    desktop.notify_user(user, title, body, "fin", notifications.conversation_url(agent_id, conv_id))


MODEL_WATCH = 2  # secondes entre deux regards sur le relais
MODEL_DOWN_LIMIT = 30  # secondes d'échecs avant d'abandonner une tâche qui n'a jamais joint le modèle
HEARTBEAT = 10  # secondes entre deux signes de vie (l'app déclare la connexion perdue après 20 s de silence)
TRIAL_LIMIT = 200  # secondes : un peu plus que les trois minutes que l'assistant attend


def _open_delegation(parent_id: str, args: dict) -> str:
    """Une délégation à des sous-agents (outil delegate_task d'Hermes) devient un fil visible dans Détails."""
    tasks = args.get("tasks") if isinstance(args.get("tasks"), list) else [args]
    goals = [str(t.get("goal") or "").strip() for t in tasks if isinstance(t, dict)]
    goals = [g for g in goals if g] or ["Sous-tâche"]
    title = goals[0].split("\n")[0][:70] + (f" (+{len(goals) - 1})" if len(goals) > 1 else "")
    with db.connect() as c:
        row = c.execute("SELECT user_id, agent_id FROM conversations WHERE id = ?", (parent_id,)).fetchone()
    thread = _new_conversation(row["user_id"], row["agent_id"], title, origin="agent")
    taches.creer(thread, "sous_tache", titre=title)  # 0.4.0 : double écriture, fermée par _close_delegation
    main._save_message(thread, "user", "\n\n".join(goals))
    main.task_state[thread] = "work"
    return thread


def _close_delegation(thread: str, result, failed: bool) -> None:
    text = result if isinstance(result, str) and result.strip() else None
    if text:
        main._save_message(thread, "agent", text)
    elif failed:
        main._save_message(thread, "error", "La sous-tâche s'est arrêtée avant la fin.")
    main.task_state[thread] = "error" if failed else "done"
    taches.finir(thread, "echec" if failed else "fini", text or ("La sous-tâche s'est arrêtée avant la fin." if failed else ""))


CHOICE_RE = re.compile(r"```(?:noah|noah)\s*\{[^`]*\"type\"\s*:\s*\"choice\"", re.S)


class ApprovalAnswer(BaseModel):
    request_id: str
    generation: int
    approve: bool


@router.post("/api/agents/{agent_id}/runs/{run_id}/approval")
async def approval(agent_id: str, run_id: str, body: ApprovalAnswer, request: Request, user: int = Depends(auth.current_user)):
    agent = _run_of(user, agent_id, run_id)
    with db.connect() as c:
        row = c.execute("SELECT * FROM accords WHERE agent_id = ? AND run_id = ? AND request_id = ? AND generation = ? AND user_id = ?",
                        (agent_id, run_id, body.request_id, body.generation, user)).fetchone()
    if not row:
        raise HTTPException(404, "Accord introuvable")
    access.conversation(user, row["conv_id"], ecrire=True)
    par = accords.device_type(request)
    accords.close(row["id"], user, "donne" if body.approve else "refuse", par)
    conv, asked = row["conv_id"], json.loads(row["summary_json"])
    # Le résumé persistant fait foi, même si l'observation MCP a été perdue.
    mcp.approval_seen(agent_id, body.request_id, str(asked.get("summary") or ""))
    grant = mcp.approval_answered(agent_id, body.request_id, body.approve)  # avant : l'appel part dès que Hermes a la réponse
    try:
        await hermes.answer_approval(agent, run_id, body.request_id, body.generation, body.approve)
    except httpx.HTTPStatusError as e:
        mcp.approval_failed(grant)
        if e.response.status_code != 409:
            raise
        raise HTTPException(409, "Hermes a déjà clos cet accord") from None
    except Exception:
        mcp.approval_failed(grant)
        raise
    # Un autre accord a pu arriver pendant l'attente : il reste à la personne. Le reste se dit tout de suite, sans attendre le prochain événement.
    if not accords.pending(conv_id=conv) and main.task_state.get(conv) == "approve":
        main.task_state[conv] = "work"
    main._journal(agent_id, conv, "accord", str(asked.get("action") or asked.get("demande") or "Une action sensible"), "", "autorise" if body.approve else "refuse")
    if not body.approve:
        with contextlib.suppress(Exception):
            apprentissage.on_refusal(agent, conv, user, str(asked.get("demande") or asked.get("summary") or ""), main._last_user_message(conv) if conv else None)
    return {"ok": True, "par": par}


# Tâches en cours : run -> agent et compte qui l'a lancée.
_runs: dict[str, dict] = {}


def _run_of(user: int, agent_id: str, run_id: str) -> Agent:
    """Répondre à une tâche ou l'arrêter : celui qui l'a lancée, ou ceux qui ont les réglages de l'agent. Une tâche
    inconnue (serveur redémarré depuis) ne dit pas à qui elle est : pareil, réglages seulement."""
    run = _runs.get(run_id)
    if run and run["agent"] != agent_id:
        access.access(user, agent_id, "lecture")
        raise HTTPException(404, "Tâche introuvable")
    agent = main._usable(user, agent_id, "usage" if run and run["user"] == user else "admin")
    return replace(agent, profile=run.get("profil")) if run else agent
