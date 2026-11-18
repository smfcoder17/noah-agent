"""Conversations : création, liste, archivage, messages, réactions, suppression, partage.
Sorti de main.py sans changement de comportement."""
import asyncio
import json
import re

from fastapi import HTTPException, Depends, APIRouter
from pydantic import BaseModel

from . import media, access, events, apprentissage, auth, db, taches, main
from . import main as main_module  # dans conversations(), `main` est une variable locale : le module s'y lit par ce nom

router = APIRouter()

# --- Conversations ----------------------------------------------------------------------

# Un fil terminé depuis plus longtemps que ça passe dans « Archivés ».
THREAD_STALE_DAYS = 2


@router.post("/api/agents/{agent_id}/conversations")
def create_discussion(agent_id: str, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "usage")
    conv_id = main._new_conversation(user, agent_id, "Nouvelle discussion")
    # 0.4.0 : double écriture. Aucun travail ne tourne à la création et aucun endroit ne ferme une discussion : elle naît « fini ».
    taches.creer(conv_id, "discussion", titre="Nouvelle discussion", etat="fini")
    return {"id": conv_id}


@router.get("/api/agents/{agent_id}/conversations")
def conversations(agent_id: str, user: int = Depends(auth.current_user)):
    """La conversation principale de ce compte avec l'agent et ses fils, plus celles que d'autres ont rendues visibles.
    Un fil vieux et terminé compte comme archivé."""
    access.access(user, agent_id, "lecture")
    with db.connect() as c:
        rows = c.execute(
            "SELECT v.id, v.title, v.updated_at, v.main, v.archived, v.origin, v.shared, v.user_id, u.username, "
            f"v.updated_at < datetime('now', '-{THREAD_STALE_DAYS} days') AS stale "
            "FROM conversations v JOIN users u ON u.id = v.user_id "
            "WHERE v.agent_id = ? AND (v.user_id = ? OR v.shared = 1) ORDER BY v.updated_at DESC LIMIT 200",
            (agent_id, user),
        ).fetchall()
        answered = {r["conversation_id"] for r in c.execute("SELECT conversation_id FROM delegations WHERE vers = ? AND etat != 'en_cours'", (agent_id,))}
    out = []
    for r in rows:
        state = main_module.task_state.get(r["id"], "idle")
        own = r["user_id"] == user
        main = bool(r["main"]) and own
        # Travaille encore, attend un accord ou un choix. Une demande d'un autre agent finie sur un choix a rendu son résultat : plus rien n'y attend.
        running = state in ("work", "approve") or (state == "choice" and r["id"] not in answered)
        archived = bool(r["archived"]) or (bool(r["stale"]) and not running)
        out.append({
            "id": r["id"], "title": r["title"], "updated_at": r["updated_at"], "state": state, "en_cours": running,
            "main": main, "archived": archived and not main, "origin": r["origin"],
            "partagee": bool(r["shared"]), "de": None if own else r["username"],
        })
    return out


class ArchiveBody(BaseModel):
    archived: bool


@router.post("/api/conversations/{conv_id}/archive")
def archive_conversation(conv_id: str, body: ArchiveBody, user: int = Depends(auth.current_user)):
    access.conversation(user, conv_id, ecrire=True)
    with db.connect() as c:
        c.execute(
            "UPDATE conversations SET archived = ?, updated_at = CASE WHEN ? THEN updated_at ELSE CURRENT_TIMESTAMP END "
            "WHERE id = ? AND user_id = ? AND main = 0",
            (int(body.archived), int(body.archived), conv_id, user),
        )
    return {"ok": True}


@router.get("/api/conversations/{conv_id}/messages")
def messages(conv_id: str, limit: int | None = None, avant: int | None = None, depuis: int | None = None, user: int = Depends(auth.current_user)):
    """Par tranches : `limit` garde les plus récents, `avant` remonte d'une page, `depuis` reprend à partir d'un message. Sans rien : tout."""
    conv = access.conversation(user, conv_id)
    where, args = "conversation_id = ?", [conv_id]
    if conv["user_id"] != user:  # conversation rendue visible : la trace d'un fil reste à son auteur, qui seul peut l'ouvrir
        where += " AND role != 'trace'"
    if avant is not None:
        where, args = where + " AND id < ?", [*args, avant]
    if depuis is not None:
        where, args = where + " AND id >= ?", [*args, depuis]
    query = f"SELECT id, role, text, detail, model, created_at FROM messages WHERE {where} ORDER BY id"
    if limit is not None:
        query, args = f"SELECT * FROM (SELECT id, role, text, detail, model, created_at FROM messages WHERE {where} ORDER BY id DESC LIMIT ?) ORDER BY id", [*args, min(max(limit, 1), 500)]
    with db.connect() as c:
        rows = [dict(r) for r in c.execute(query, args).fetchall()]
        given: dict[int, dict] = {}
        # Seulement les réactions de la page rendue : une vieille conversation ne se relit pas en entier.
        first, last = (rows[0]["id"], rows[-1]["id"]) if rows else (0, -1)
        for r in c.execute("SELECT r.message_id, r.who, r.emoji FROM reactions r JOIN messages m ON m.id = r.message_id "
                           "WHERE m.conversation_id = ? AND r.message_id BETWEEN ? AND ?", (conv_id, first, last)):
            given.setdefault(r["message_id"], {})[r["who"]] = r["emoji"]
    for row in rows:
        if row["id"] in given:
            row["reactions"] = given[row["id"]]
    return rows


class Reaction(BaseModel):
    emoji: str | None = None


@router.put("/api/conversations/{conv_id}/messages/{message_id}/reaction")
async def react_to_message(conv_id: str, message_id: int, body: Reaction, user: int = Depends(auth.current_user)):
    """Poser ou retirer sa réaction. Sur une réponse de l'agent, il l'apprend avec le prochain message, sans relancer de travail. Une réaction ne vaut jamais accord (apprentissage.py)."""
    access.conversation(user, conv_id, ecrire=True)
    if body.emoji is not None and body.emoji not in events.REACTIONS:
        raise HTTPException(400, "Cette réaction n'existe pas.")
    with db.connect() as c:
        row = c.execute("SELECT role, text FROM messages WHERE id = ? AND conversation_id = ?", (message_id, conv_id)).fetchone()
        if not row:
            raise HTTPException(404, "Message introuvable")
        if body.emoji:
            c.execute("INSERT OR REPLACE INTO reactions (message_id, who, emoji) VALUES (?, 'user', ?)", (message_id, body.emoji))
        else:
            c.execute("DELETE FROM reactions WHERE message_id = ? AND who = 'user'", (message_id,))
    if body.emoji and row["role"] == "agent":
        with db.connect() as c:
            owner = c.execute("SELECT agent_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        return {"ok": True, "question": apprentissage.on_reaction(main._agent(owner["agent_id"]), conv_id, user, message_id, body.emoji, row["text"])}
    return {"ok": True}


def _last_user_message(conv_id: str) -> int | None:
    with db.connect() as c:
        row = c.execute("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1", (conv_id,)).fetchone()
    return row["id"] if row else None


def _agent_reacts(message_id: int | None, emoji: str) -> None:
    if message_id:
        with db.connect() as c:
            c.execute("INSERT OR REPLACE INTO reactions (message_id, who, emoji) VALUES (?, 'agent', ?)", (message_id, emoji))


def _final_answer(reply: list[str], steps: list[str], kept: list[str], output: str, succeeded: bool) -> tuple[str, list[str]]:
    """Ce que la conversation garde : le texte de la réponse, et le récit qui reste à part. Il a tout dit avant son dernier outil : sa dernière phrase est la réponse.
    Une erreur n'est pas effacée par une phrase de travail, et un récit seul ne tient pas lieu de réponse."""
    answer = "".join(reply).strip() or output or ""
    left = list(steps)
    if not answer and succeeded and left:
        answer = left.pop()
    return ("\n\n".join([*kept, answer]).strip() if answer or succeeded or kept else ""), left


# Ce qu'un message montre et qu'il faut garder même écrit avant un outil : un widget, une image, un fichier livré (il devient un aperçu).
_SHOWS_SOMETHING = re.compile(r"```noah|^MEDIA:|/opt/data/workspace/(?:outputs|apps|captures)/\S+\.\w", re.M)
# La fin d'un message qui attend une réponse. Le petit modèle tranche ensuite s'il se touche.
_WAITS_ANSWER = re.compile(r"\?\s*$|\b(?:dis-moi|choisis|préfères|valide|confirme)\b[^\n]*$", re.I)


async def _quick_reply_block(agent_id: str, said: str) -> str:
    if not said or main.CHOICE_RE.search(said) or not _WAITS_ANSWER.search(said[-240:]):
        return ""
    try:
        options = await asyncio.wait_for(media.quick_replies(agent_id, said), 7)
    except Exception:  # une proposition perdue ne gêne personne : la saisie reste libre
        return ""
    if len(options) < 2:
        return ""
    return "\n\n```noah\n" + json.dumps({"type": "choice", "question": "", "options": options}, ensure_ascii=False) + "\n```"


@router.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: str, user: int = Depends(auth.current_user)):
    access.conversation(user, conv_id, ecrire=True)
    with db.connect() as c:
        c.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", (conv_id, user))
    main.task_state.pop(conv_id, None)
    return {"ok": True}


class ConversationShare(BaseModel):
    partagee: bool


@router.post("/api/conversations/{conv_id}/partage")
def share_conversation(conv_id: str, body: ConversationShare, user: int = Depends(auth.current_user)):
    """L'auteur rend sa conversation lisible par ceux qui ont accès à l'agent, ou la reprend. Rien n'est visible par défaut."""
    access.conversation(user, conv_id, ecrire=True)
    with db.connect() as c:
        c.execute("UPDATE conversations SET shared = ? WHERE id = ?", (int(body.partagee), conv_id))
    return {"ok": True}
