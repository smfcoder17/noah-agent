"""La barre de session : ce que l'agent fait en ce moment, sans avoir à le lui demander.

Une seule lecture, relevée toutes les deux secondes par l'écran : les travaux en cours dans les conversations que la personne
voit, les demandes passées à d'autres agents, les tâches confiées à son ordinateur, les routines qui tournent et les processus
que l'agent a lancés en arrière-plan. Rien n'est inventé : un processus n'est montré que tant qu'on ne sait pas qu'il est fini,
et jamais plus de deux heures.
"""
import re
import time

from . import events

PROCESS_SECONDS = 2 * 3600  # au-delà, on ne sait plus rien de lui : il quitte la barre
_SESSION_ID = re.compile(r"\b(proc_[A-Za-z0-9_-]{4,64})\b")
_EXITED = re.compile(r"\"?status\"?\s*[:=]\s*\"?(exited|killed|done|finished|completed|failed)\b", re.I)

# agent -> liste de processus {id, label, debut, conversation, session}. En mémoire : un redémarrage du serveur les oublie,
# comme il oublie les travaux en cours.
_processes: dict[str, list[dict]] = {}
# (agent, conversation) -> processus lancés dont on attend la réponse de l'outil, dans l'ordre.
_waiting: dict[tuple[str, str], list[dict]] = {}


def _tool(data: dict) -> str:
    return str(data.get("tool_name") or data.get("tool") or "")


def _args(data: dict) -> dict:
    return data.get("args") if isinstance(data.get("args"), dict) else {}


def _call_id(data: dict) -> str:
    return str(data.get("tool_call_id") or data.get("call_id") or data.get("id") or "")


def _answered(agent_id: str, conv_id: str, data: dict) -> dict | None:
    """L'appel `terminal` dont cet événement est la fin : par son identifiant d'appel quand Hermes le donne. Sans identifiant, une
    réponse qui porte un `proc_…` finit le plus ancien lancement en arrière-plan, une autre la plus ancienne commande en avant-plan
    (à défaut, le plus ancien appel). Une commande ordinaire finie, ou ratée, ne prend jamais la place d'un lancement en
    arrière-plan qui tourne (relecture 0.3.0, partie 5 n°1)."""
    waiting = _waiting.get((agent_id, conv_id)) or []
    if not waiting:
        return None
    call = _call_id(data)
    if call and any(w["call"] for w in waiting):
        at = next((i for i, w in enumerate(waiting) if w["call"] == call), None)
        return waiting.pop(at) if at is not None else None  # un identifiant inconnu : on ne devine pas
    background = bool(_SESSION_ID.search(str(data.get("preview") or data.get("result") or "")))
    at = next((i for i, w in enumerate(waiting) if bool(w["entry"]) == background), 0)
    return waiting.pop(at)


def note(agent_id: str, conv_id: str, kind: str, data: dict) -> None:
    """Suit, dans le flux d'un travail, les commandes lancées en arrière-plan et leur fin quand l'agent la constate."""
    name, args = _tool(data), _args(data)
    if name == "terminal" and kind == "tool.started":
        entry = None
        if args.get("background"):
            entry = {"id": f"{conv_id}:{time.time_ns()}", "label": events.tool_label("terminal", args) or "Commande en arrière-plan",
                     "debut": time.time(), "conversation": conv_id, "session": None}
            _processes.setdefault(agent_id, []).append(entry)
        _waiting.setdefault((agent_id, conv_id), []).append({"call": _call_id(data), "entry": entry})
    elif name == "terminal" and kind in ("tool.completed", "tool.failed") and _waiting.get((agent_id, conv_id)):
        waited = _answered(agent_id, conv_id, data)
        entry = waited and waited["entry"]
        if not entry:
            return  # la fin d'une commande en avant-plan
        found = _SESSION_ID.search(str(data.get("preview") or data.get("result") or ""))
        if kind == "tool.failed":
            _drop(agent_id, lambda p: p is entry)
        elif found:
            entry["session"] = found.group(1)
    elif name in ("process", "process_manage") and kind in ("tool.completed", "tool.failed"):
        target = str(args.get("session_id") or args.get("id") or "")
        text = str(data.get("preview") or data.get("result") or "")
        if target and (str(args.get("action") or "") == "kill" or _EXITED.search(text)):
            _drop(agent_id, lambda p: p.get("session") == target)


def run_ended(agent_id: str, conv_id: str) -> None:
    """Fin du travail : un lancement resté sans réponse de l'outil n'a pas eu lieu."""
    for waited in _waiting.pop((agent_id, conv_id), []):
        entry = waited["entry"]
        if entry and not entry.get("session"):
            _drop(agent_id, lambda p, e=entry: p is e)


def _drop(agent_id: str, match) -> None:
    _processes[agent_id] = [p for p in _processes.get(agent_id, []) if not match(p)]


def processes(agent_id: str, visible: set[str]) -> list[dict]:
    """Les processus encore supposés en vie, lancés depuis une conversation que la personne voit."""
    limit = time.time() - PROCESS_SECONDS
    _drop(agent_id, lambda p: p["debut"] < limit)
    return [{"id": p["id"], "titre": p["label"], "debut": p["debut"], "conversation_id": p["conversation"]}
            for p in _processes.get(agent_id, []) if p["conversation"] in visible]


def forget(agent_id: str | None = None) -> None:
    if agent_id is None:
        _processes.clear()
        _waiting.clear()
        return
    _processes.pop(agent_id, None)
    for key in [k for k in _waiting if k[0] == agent_id]:
        _waiting.pop(key, None)
