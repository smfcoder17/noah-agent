"""Propositions : ce qu'un agent propose de lui-même, à accepter ou refuser d'un geste dans « À toi ».

Une proposition garde son texte (ce que la personne lit) et sa demande (ce qui part à l'agent, telle quelle, si elle dit « Fais-le »).
Elles naissent dans proactif.py : idée du jour, premier relevé d'une source, travail préparé en mode « Me signaler », point du matin.
C'est proactif.py qui tient les heures actives et le plafond du jour ; ici, on enregistre, on montre et on répond.

- « faire » : la demande part dans sa conversation principale comme un message d'elle, par la même file que les demandes qui attendent
  (pendant.py) : jamais par-dessus un travail en cours ;
- « non » : rien ne part, et le refus s'apprend comme un accord refusé (apprentissage.on_refusal) ;
- sans réponse, elle expire : quand l'heure ou le jour qu'elle nomme est passé (« aujourd'hui », « ce soir », « demain », « le 25 novembre » :
  voir echeance), sinon au bout de 3 jours. Elle quitte « Pour toi » et reste lisible dans Activité, marquée « expirée ».
Seule une décision à prendre y va : un compte rendu (le point du matin) s'écrit dans le fil, sans bouton (proactif._briefing).
Seul le propriétaire de l'agent les voit et y répond : une personne invitée ne reçoit pas ce que l'agent propose à son propriétaire.
"""
import re
import time
import unicodedata
import uuid
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import access, auth, db, pendant

router = APIRouter()

# Une proposition que personne n'a tranchée n'attend pas indéfiniment : passé ce délai, elle quitte « Pour toi » (et le compteur), et
# Activité la montre « expirée ». Trois jours : un week-end sans ouvrir Noah ne fait pas perdre ce qu'il a proposé le vendredi.
EXPIRE_JOURS = 3
EXPIRE = EXPIRE_JOURS * 24 * 3600
MAX_DEFAULT, MAX_LIMIT = 3, 6  # par agent et par jour
OWNER_MAX = 3  # par compte et par jour, tous ses agents ensemble : cinq agents ne font pas quinze cartes
GENRES = ("idee", "releve", "traiter", "briefing")
TEXT_MAX, DEMAND_MAX = 1500, 4000


_MOIS = {"janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12,
         "janv": 1, "fevr": 2, "avr": 4, "juil": 7, "sept": 9, "oct": 10, "nov": 11, "dec": 12}
_AUJOURDHUI = re.compile(r"\b(aujourd ?hui|ce matin|cet apres midi|ce soir|cette nuit|maintenant|tout de suite|des maintenant|today|tonight|this (?:morning|afternoon|evening))\b")
_APRES_DEMAIN = re.compile(r"\b(apres demain|day after tomorrow)\b")
_DEMAIN = re.compile(r"\b(demain|tomorrow)\b")
_DATE = re.compile(r"\b(?:le |on )?(\d{1,2}) (janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|janv|fevr|avr|juil|sept|oct|nov|dec)\b")
_DATE_NUM = re.compile(r"\b(?:le )?(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")


def _plain(texte: str) -> str:
    """Sans accents ni majuscules, apostrophes en espaces : \"Aujourd'hui\" devient \"aujourd hui\"."""
    flat = unicodedata.normalize("NFKD", texte or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9/ ]", " ", flat)


def echeance(texte: str, created: float, zone=None) -> float:
    """Quand cette proposition est passée : la fin du jour qu'elle nomme, sinon created + EXPIRE_JOURS.

    Règle (écrite ici, testée dans tests/agents/pour_toi_passe_test.py). Le jour se compte chez la personne, depuis le jour où la proposition
    est née. « aujourd'hui », « ce soir », « maintenant »… : fin de ce jour-là. « demain » : fin du lendemain. « après-demain » : J+2.
    Une date écrite (« le 25 novembre », « 25/11 ») : fin de cette date. Plusieurs repères : le plus proche l'emporte (« je t'audite
    aujourd'hui, ton essai expire dans 3 jours » est passée ce soir). « dans 3 jours » ne compte pas : c'est un fait, pas le moment
    de la proposition. Aucun repère : la durée habituelle."""
    if zone is None:
        from . import updates
        zone = updates.local_zone()
    born = datetime.fromtimestamp(created, zone)
    plain = _plain(texte)

    def end_of(day: datetime) -> float:
        return day.replace(hour=23, minute=59, second=59, microsecond=0).timestamp()

    marks = []
    if _AUJOURDHUI.search(plain):
        marks.append(end_of(born))
    if _APRES_DEMAIN.search(plain):
        marks.append(end_of(born + timedelta(days=2)))
    elif _DEMAIN.search(plain):
        marks.append(end_of(born + timedelta(days=1)))
    for m in _DATE.finditer(plain):
        marks += _date(born, int(m.group(1)), _MOIS[m.group(2)], None, end_of)
    for m in _DATE_NUM.finditer(plain):
        marks += _date(born, int(m.group(1)), int(m.group(2)), m.group(3), end_of)
    return min(marks) if marks else created + EXPIRE


def _date(born: datetime, day: int, month: int, year: str | None, end_of) -> list[float]:
    try:
        y = (int(year) + (2000 if len(year) == 2 else 0)) if year else born.year
        found = born.replace(year=y, month=month, day=day)
        if not year and found.date() < born.date() - timedelta(days=31):
            found = found.replace(year=y + 1)  # « le 3 janvier » écrit en décembre
    except ValueError:
        return []  # pas une date (« 12/45 »)
    return [end_of(found)] if found.date() >= born.date() else []  # une date déjà passée à la naissance n'est pas un repère


def sweep(now: float | None = None) -> int:
    """Passée (echeance) ou sans réponse trois jours : elle n'attend plus personne. Rend le nombre de lignes sorties."""
    now = now or time.time()
    gone = []
    with db.connect() as c:
        for r in c.execute("SELECT id, texte, created FROM propositions WHERE etat = 'ouverte'").fetchall():
            if echeance(r["texte"], r["created"]) <= now:
                gone.append(r["id"])
        for pid in gone:
            c.execute("UPDATE propositions SET etat = 'expiree' WHERE id = ? AND etat = 'ouverte'", (pid,))
    if gone:
        from . import bus
        bus.invalidate_all()
    return len(gone)


def sortir_comptes_rendus() -> int:
    """Au démarrage : un « point du matin » déjà en base n'est pas une proposition (c'est un compte rendu, écrit dans le fil). Il quitte
    « Pour toi » en passant à « expirée » ; rien n'est effacé, le message du fil et la ligne restent. Rend le nombre de lignes sorties."""
    with db.connect() as c:
        done = c.execute("UPDATE propositions SET etat = 'expiree' WHERE etat = 'ouverte' AND genre = 'briefing'").rowcount
    if done:
        from . import bus
        bus.invalidate_all()
    return done


def expirees(user: int, limite: int = 30) -> list[dict]:
    """Pour Activité : ce que les agents de ce compte ont proposé et qui est resté sans réponse, la plus récente d'abord."""
    sweep()
    with db.connect() as c:
        rows = c.execute("SELECT p.id, p.agent_id, p.texte, p.created, a.name FROM propositions p JOIN agents a ON a.id = p.agent_id "
                         "WHERE p.owner = ? AND p.etat = 'expiree' AND p.genre != 'briefing' ORDER BY p.created DESC, p.id LIMIT ?", (user, limite)).fetchall()
    return [{"id": r["id"], "agent_id": r["agent_id"], "agent": r["name"], "texte": r["texte"], "cree": r["created"], "etat": "expiree"}
            for r in rows if access.right(user, r["agent_id"]) == "proprietaire"]


def made_on(agent_id: str, day: str) -> int:
    """Combien cet agent en a fait ce jour-là, quelle que soit la réponse : c'est ce que compte le plafond."""
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) FROM propositions WHERE agent_id = ? AND jour = ?", (agent_id, day)).fetchone()[0]


def made_for_owner(owner: int | None, day: str) -> int:
    """Combien tous les agents de ce compte en ont fait ce jour-là : le plafond du compte."""
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) FROM propositions WHERE owner IS ? AND jour = ?", (owner, day)).fetchone()[0]


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
                         "WHERE p.owner = ? AND p.etat = 'ouverte' AND p.genre != 'briefing' ORDER BY p.created, p.id", (user,)).fetchall()
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
