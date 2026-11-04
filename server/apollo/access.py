"""Qui peut toucher à quoi : le seul endroit qui décide. Toute route qui touche un agent ou une conversation passe ici.

Un agent a un propriétaire ; il peut le partager avec un autre profil, avec un droit :
- lecture : voir l'agent et les conversations que leur auteur a rendues visibles, sans rien écrire ;
- usage : en plus, lui parler dans ses propres conversations, voir ses fichiers ;
- admin : en plus, ses réglages (rôle, cerveau, routines, mémoire, connexions, écran), sauf le supprimer ou le repartager.

Le rôle `owner` donne la configuration globale, pas les agents des autres : il ne les voit que s'ils lui sont partagés.
404 quand l'agent est invisible (on ne confirme pas qu'il existe), 403 quand il est visible et que le droit manque.
"""
from fastapi import Depends, HTTPException

from . import auth, db, relay

SHARE_RIGHTS = ("lecture", "usage", "admin")
LEVELS = {"lecture": 1, "usage": 2, "admin": 3, "proprietaire": 4}
# Limite réelle d'Hermes : une mémoire, un navigateur et un dossier de travail par conteneur. Dite telle quelle au partage.
SHARE_WARNING = ("cet agent garde une seule mémoire, un seul navigateur et un seul dossier de travail ; ses comptes "
                 "connectés et ses dossiers servent à tous ceux avec qui tu le partages.")


def role(user: int) -> str:
    with db.connect() as c:
        row = c.execute("SELECT role FROM users WHERE id = ?", (user,)).fetchone()
    return row["role"] if row else "member"


def is_owner(user: int) -> bool:
    return role(user) == "owner"


def owner_only(user: int = Depends(auth.current_user)) -> int:
    """Dépendance des routes de configuration globale : fournisseur, clé, budget global, mises à jour, flux, profils."""
    if not is_owner(user):
        raise HTTPException(403, "Réservé au propriétaire de ce Noah Agent.")
    return user


def username(user: int) -> str:
    with db.connect() as c:
        row = c.execute("SELECT username FROM users WHERE id = ?", (user,)).fetchone()
    return row["username"] if row else ""


def owner_of(agent_id: str) -> int | None:
    return db.agent_owner(agent_id) or db.owner_id()


closing: set[int] = set()  # profils en cours de suppression : plus aucun droit, avant même la première attente


def right(user: int, agent_id: str) -> str | None:
    """Le droit de ce profil sur cet agent : « proprietaire », un droit partagé, ou None s'il ne le voit pas."""
    if user in closing:
        return None
    with db.connect() as c:
        if not c.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone():
            return None
        share = c.execute("SELECT droit FROM agent_shares WHERE agent_id = ? AND user_id = ?", (agent_id, user)).fetchone()
    if owner_of(agent_id) == user:
        return "proprietaire"
    return share["droit"] if share else None


def access(user: int, agent_id: str, droit: str = "lecture") -> str:
    """Rend le droit de ce profil, ou refuse : 404 si l'agent est invisible, 403 si le droit manque."""
    have = right(user, agent_id)
    if have is None:
        raise HTTPException(404, "Agent introuvable")
    if LEVELS[have] < LEVELS[droit]:
        raise HTTPException(403, "Ton accès à cet agent ne permet pas cela.")
    return have


def allowed(user: int, agent_id: str, droit: str = "lecture") -> bool:
    """Pour les flux déjà ouverts : la révocation vaut aussi pour eux."""
    have = right(user, agent_id)
    return have is not None and LEVELS[have] >= LEVELS[droit]


def conversation(user: int, conv_id: str, ecrire: bool = False):
    """Une conversation appartient à son auteur. Un autre profil qui a accès à l'agent ne la lit que si l'auteur l'a
    rendue visible, et n'y écrit jamais. Son auteur la perd de vue en même temps que son accès à l'agent."""
    with db.connect() as c:
        row = c.execute("SELECT id, user_id, agent_id, shared, main FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    if not row or not (row["user_id"] == user or row["shared"]):
        raise HTTPException(404, "Conversation introuvable")
    if not allowed(user, row["agent_id"]):
        raise HTTPException(404, "Conversation introuvable")
    if ecrire:
        if row["user_id"] != user:
            raise HTTPException(403, "Cette conversation est celle de quelqu'un d'autre : elle se lit, elle ne s'écrit pas.")
        access(user, row["agent_id"], "usage")
    return row


# --- Tâches en cours : qui les a lancées -------------------------------------------------------

def _conversation_user(conv_id: str) -> int | None:
    with db.connect() as c:
        row = c.execute("SELECT user_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return row["user_id"] if row else None


def launcher(agent_id: str) -> int | None:
    """Le profil des tâches en cours, s'il n'y en a qu'un ; sans tâche, le propriétaire. Plusieurs profils : voir ambiguous."""
    users = _active_users(agent_id)
    return (next(iter(users)) if len(users) == 1 else None) or owner_of(agent_id)


def _active_users(agent_id: str) -> set:
    return {u for u in (_conversation_user(conv) for conv in set(relay.active.get(agent_id) or [])) if u is not None}


def ambiguous(agent_id: str) -> bool:
    """Des tâches de plusieurs profils tournent : on ne sait pas de laquelle vient l'appel de l'agent."""
    return len(_active_users(agent_id)) > 1


def guest_task(agent_id: str) -> bool:
    """Une tâche lancée par un profil partagé tourne : l'agent ne doit pas lui prêter ce que seul son propriétaire a
    (les autres agents, l'ordinateur du propriétaire)."""
    owner = owner_of(agent_id)
    return any(_conversation_user(conv) not in (None, owner) for conv in relay.active.get(agent_id, []))


def recipients(agent_id: str) -> list[int]:
    """Qui prévenir pour un agent : son propriétaire, plus le profil partagé s'il a lancé la tâche en cours."""
    return [u for u in dict.fromkeys((owner_of(agent_id), launcher(agent_id))) if u is not None]
