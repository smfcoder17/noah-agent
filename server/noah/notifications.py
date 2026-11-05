"""Ce que chaque compte veut recevoir, et quand une tâche finie mérite une notification.

Un agent n'appelle pas par défaut. La fin d'une tâche part en notification normale, seulement si personne ne regarde la
conversation et si le travail a pris du temps. Les réglages sont par compte : un profil partagé a les siens. Les alertes de
sécurité (nouvel appareil, mot de passe) passent par `push.send` et ne sont filtrées par rien ici.
"""
import json
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import auth, db

router = APIRouter()

KINDS = ("fin", "accord", "routines", "appels", "plafond")
CALLS_ON_REQUEST, CALLS_IMPORTANT, CALLS_NEVER = "demande", "important", "jamais"
CALL_CHOICES = (CALLS_ON_REQUEST, CALLS_IMPORTANT, CALLS_NEVER)
TELL_AFTER = 30  # secondes : en dessous, la personne attendait encore la réponse
WATCH_WINDOW = 10  # secondes : un écran qui relève la conversation toutes les 3 s la regarde encore
REPORT_MEMORY = 3600  # une heure : un rappel plus ancien ne dit plus rien de la tâche qui finit

REFUSED = ("Cette personne a choisi de ne jamais être appelée. Ton compte rendu est écrit dans sa conversation et part en "
           "notification : ne réessaie pas, termine simplement ton tour.")
_NOTES = {
    CALLS_IMPORTANT: ("[Réglage de cette personne : tu peux aussi la rappeler de toi-même quand c'est vraiment important et "
                      "urgent, même sans qu'elle l'ait demandé. Le reste du temps, écris ta réponse.]\n\n"),
    CALLS_NEVER: ("[Réglage de cette personne : ne la rappelle jamais, même si elle semble le demander ; `noah.py rappeler` serait "
                  "refusé. Écris ton compte rendu, il part en notification. Si elle demande un appel, dis-lui que ce réglage "
                  "se change dans Réglages > Notifications.]\n\n"),
}


def preferences(user: int) -> dict:
    with db.connect() as c:
        row = c.execute("SELECT rappels, coupes FROM notification_prefs WHERE user_id = ?", (user,)).fetchone()
    off = set(json.loads(row["coupes"])) if row else set()
    return {"rappels": row["rappels"] if row else CALLS_ON_REQUEST, "types": {k: k not in off for k in KINDS}}


def wants(user: int, kind: str) -> bool:
    return preferences(user)["types"].get(kind, True)


def call_choice(user: int) -> str:
    """Le choix qui compte vraiment : couper le type « appels », c'est ne jamais sonner, quel que soit l'autre réglage."""
    prefs = preferences(user)
    return CALLS_NEVER if not prefs["types"]["appels"] else prefs["rappels"]


def call_note(user: int) -> str:
    """Ajouté au message pour l'agent, seulement si le choix diffère du défaut : le début du prompt reste en cache."""
    return _NOTES.get(call_choice(user), "")


# --- Une phrase pour le bandeau -----------------------------------------------------------------

def first_sentence(text: str, limit: int = 180) -> str:
    """La première phrase lisible du résultat : sans blocs de code, sans fichiers joints, sans marques de mise en forme."""
    text = re.sub(r"```.*?(```|$)", " ", text or "", flags=re.S)
    text = re.sub(r"MEDIA:\S+", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`#>|]+", " ", text)
    text = " ".join(text.split())
    if not text:
        return "C'est fini : le résultat est dans la conversation."
    match = re.match(r".+?[.!?…](?=\s|$)", text)
    sentence = match.group(0) if match else text
    return sentence if len(sentence) <= limit else sentence[:limit - 1].rstrip() + "…"


def conversation_url(agent_id: str, conv_id: str | None = None) -> str:
    return f"/#agent={agent_id}" + (f"&conversation={conv_id}" if conv_id else "")


# --- Pas deux fois la même nouvelle --------------------------------------------------------------

_reported: dict[tuple[str, int], float] = {}


def note_reported(agent_id: str, user: int) -> None:
    """Cette personne vient de recevoir le compte rendu (rappel, ou rappel refusé devenu notification)."""
    _reported[(agent_id, user)] = time.time()


def take_reported(agent_id: str, user: int) -> bool:
    """Rendu une seule fois : la tâche qui finit juste après ne prévient pas de nouveau, la suivante si."""
    told = _reported.pop((agent_id, user), None)
    return told is not None and time.time() - told < REPORT_MEMORY


# --- Quelqu'un regarde-t-il ? --------------------------------------------------------------------

_seen: dict[str, float] = {}
_hidden: set[str] = set()


def saw(conv_id: str) -> None:
    """Un écran vient de relever cette conversation : il la suit, même sans flux ouvert."""
    _seen[conv_id] = time.monotonic()


def seen_recently(conv_id: str) -> bool:
    seen = _seen.get(conv_id)
    return seen is not None and time.monotonic() - seen < WATCH_WINDOW


def set_hidden(conv_id: str, hidden: bool) -> None:
    """L'écran qui tient le flux n'est plus visible : sur un téléphone, ce flux peut rester ouvert longtemps sans lecteur."""
    if hidden:
        _hidden.add(conv_id)
        _seen.pop(conv_id, None)  # le dernier relevé date d'avant : la personne vient de partir, elle ne regarde plus
    else:
        _hidden.discard(conv_id)


def is_hidden(conv_id: str) -> bool:
    return conv_id in _hidden


# --- Réglages > Notifications --------------------------------------------------------------------

class Preferences(BaseModel):
    rappels: str | None = None
    types: dict[str, bool] | None = None


@router.get("/api/me/notifications")
def read_preferences(user: int = Depends(auth.current_user)):
    return preferences(user)


@router.put("/api/me/notifications")
def write_preferences(body: Preferences, user: int = Depends(auth.current_user)):
    if body.rappels is not None and body.rappels not in CALL_CHOICES:
        raise HTTPException(400, "Choix d'appel inconnu.")
    if body.types is not None and set(body.types) - set(KINDS):
        raise HTTPException(400, "Type de notification inconnu.")  # la sécurité n'est pas dans la liste : elle ne se coupe pas
    now = preferences(user)
    types = {**now["types"], **(body.types or {})}
    choice = body.rappels or now["rappels"]
    with db.connect() as c:
        c.execute("INSERT INTO notification_prefs (user_id, rappels, coupes) VALUES (?, ?, ?) "
                  "ON CONFLICT(user_id) DO UPDATE SET rappels = excluded.rappels, coupes = excluded.coupes",
                  (user, choice, json.dumps(sorted(k for k, on in types.items() if not on))))
    return preferences(user)
