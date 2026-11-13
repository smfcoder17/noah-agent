"""Propositions : ce qu'un agent propose de lui-même, à accepter ou refuser d'un geste dans « À toi ».

Une proposition garde son texte (ce que la personne lit) et sa demande (ce qui part à l'agent, telle quelle, si elle dit « Fais-le »).
Elles naissent dans proactif.py : idée du jour, premier relevé d'une source, travail préparé en mode « Me signaler », point du matin.
C'est proactif.py qui tient les heures actives et le plafond du jour ; ici, on enregistre, on montre et on répond.

- « faire » : la demande part dans sa conversation principale comme un message d'elle, par la même file que les demandes qui attendent
  (pendant.py) : jamais par-dessus un travail en cours ;
- « non » : rien ne part, et le refus s'apprend comme un accord refusé (apprentissage.on_refusal) ;
- sans réponse, elle expire au bout de 48 h.
Seul le propriétaire de l'agent les voit et y répond : une personne invitée ne reçoit pas ce que l'agent propose à son propriétaire.
"""
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import access, auth, db, pendant

router = APIRouter()

EXPIRE = 48 * 3600
MAX_DEFAULT, MAX_LIMIT = 3, 6  # par agent et par jour
GENRES = ("idee", "releve", "traiter", "briefing")
TEXT_MAX, DEMAND_MAX = 1500, 4000


def sweep(now: float | None = None) -> None:
    """Sans réponse au bout de 48 h : elle n'attend plus personne."""
    with db.connect() as c:
        c.execute("UPDATE propositions SET etat = 'expiree' WHERE etat = 'ouverte' AND created <= ?", ((now or time.time()) - EXPIRE,))


def made_on(agent_id: str, day: str) -> int:
    """Combien cet agent en a fait ce jour-là, quelle que soit la réponse : c'est ce que compte le plafond."""
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) FROM propositions WHERE agent_id = ? AND jour = ?", (agent_id, day)).fetchone()[0]


def create(agent_id: str, genre: str, texte: str, demande: str, day: str, conv_id: str | None = None, message_id: int | None = None) -> str:
    prop_id = uuid.uuid4().hex[:16]
    with db.connect() as c:
        c.execute("INSERT INTO propositions (id, agent_id, owner, genre, texte, demande, jour, conversation_id, message_id, created) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  (prop_id, agent_id, access.owner_of(agent_id), genre, texte.strip()[:TEXT_MAX], demande.strip()[:DEMAND_MAX], day,
                   conv_id, message_id, time.time()))
    from . import bus
    bus.invalidate_all()  # « À toi » se relit
    return prop_id


def open_for_agent(agent_id: str, genres: tuple[str, ...] = GENRES) -> list[dict]:
    sweep()
    marks = ", ".join("?" * len(genres))
    with db.connect() as c:
        rows = c.execute(f"SELECT * FROM propositions WHERE agent_id = ? AND etat = 'ouverte' AND genre IN ({marks}) ORDER BY created, id",
                         (agent_id, *genres)).fetchall()
    return [dict(r) for r in rows]


def refused_texts(agent_id: str, limit: int = 5) -> list[str]:
    with db.connect() as c:
        rows = c.execute("SELECT texte FROM propositions WHERE agent_id = ? AND etat = 'refusee' ORDER BY repondu DESC LIMIT ?", (agent_id, limit)).fetchall()
    return [r["texte"] for r in rows]


def inbox(user: int) -> list[dict]:
    """Pour « À toi » : celles qui attendent ce compte, sur les agents dont il est propriétaire."""
    sweep()
    with db.connect() as c:
        rows = c.execute("SELECT p.id, p.agent_id, p.texte, p.created, a.name FROM propositions p JOIN agents a ON a.id = p.agent_id "
                         "WHERE p.owner = ? AND p.etat = 'ouverte' ORDER BY p.created, p.id", (user,)).fetchall()
    return [{"type": "proposition", "id": r["id"], "agent_id": r["agent_id"], "agent": r["name"], "texte": r["texte"], "cree": r["created"]}
            for r in rows if access.right(user, r["agent_id"]) == "proprietaire"]


class Answer(BaseModel):
    choix: Literal["faire", "non"]


@router.post("/api/propositions/{proposition_id}/reponse")
async def answer(proposition_id: str, body: Answer, user: int = Depends(auth.current_user)):
    sweep()
    with db.connect() as c:
        row = c.execute("SELECT * FROM propositions WHERE id = ?", (proposition_id,)).fetchone()
    if not row or access.right(user, row["agent_id"]) is None:
        raise HTTPException(404, "Proposition introuvable")
    access.access(user, row["agent_id"], "proprietaire")  # il agit avec les comptes de son propriétaire : un partage n'en décide pas
    if row["etat"] == "expiree":
        raise HTTPException(409, "Cette proposition a expiré.")
    state = "faite" if body.choix == "faire" else "refusee"
    with db.connect() as c:
        if not c.execute("UPDATE propositions SET etat = ?, repondu = ? WHERE id = ? AND etat = 'ouverte'", (state, time.time(), proposition_id)).rowcount:
            raise HTTPException(409, "Tu as déjà répondu à cette proposition.")
    from . import bus, proactif
    bus.invalidate_all()
    conv = proactif._main(row["agent_id"])
    if body.choix == "faire":  # comme un message qu'elle aurait écrit, à la suite de ce qui tourne déjà
        if pendant.add(f"{user}:proposition-{proposition_id}", conv, row["agent_id"], user, row["demande"]):
            pendant.start(row["agent_id"], conv)
    else:
        from . import apprentissage
        apprentissage.on_refusal(proactif._h["agent"](row["agent_id"]), conv, user, row["texte"], row["message_id"])
    return {"id": proposition_id, "etat": state, "conversation_id": conv}
