"""Profils d'un même serveur (G12) et partage d'un agent. Les contrôles eux-mêmes sont dans access.py.

Supprimer un profil ne devine rien : s'il a des agents, la demande dit quoi en faire, et la réponse à une demande
incomplète explique les deux choix.
"""
import sqlite3

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db, relay

router = APIRouter()

_h: dict = {}  # fonctions de main.py : stop_runs, remove_agent, drop_pending


def setup(**hooks) -> None:
    _h.update(hooks)


class NewProfile(BaseModel):
    username: str = Field(min_length=2, max_length=64, pattern=r"^[\w .@-]+$")
    password: str = Field(min_length=8, max_length=256)
    budget: float | None = Field(default=None, ge=0, le=100000)


class ProfileEdit(BaseModel):
    budget: float | None = Field(default=None, ge=0, le=100000)  # plafond mensuel en dollars ; None : pas de plafond


def _public(row) -> dict:
    with db.connect() as c:
        agents = [dict(r) for r in c.execute("SELECT id, name FROM agents WHERE owner_id = ? ORDER BY created_at", (row["id"],))]
        devices = c.execute("SELECT COUNT(*) FROM sessions WHERE user_id = ?", (row["id"],)).fetchone()[0]
    return {"id": row["id"], "username": row["username"], "role": row["role"], "budget": row["budget_monthly"],
            "depense": round(relay.profile_cost(row["id"]), 4), "agents": agents, "appareils": devices}


def _profile(profile_id: int):
    with db.connect() as c:
        row = c.execute("SELECT id, username, role, budget_monthly FROM users WHERE id = ?", (profile_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Profil introuvable")
    return row


@router.get("/api/profiles")
def list_profiles(_: int = Depends(access.owner_only)):
    with db.connect() as c:
        rows = c.execute("SELECT id, username, role, budget_monthly FROM users ORDER BY id").fetchall()
    return {"profils": [_public(r) for r in rows]}


@router.post("/api/profiles")
def create_profile(body: NewProfile, _: int = Depends(access.owner_only)):
    try:
        profile_id = auth.create_user(body.username.strip(), body.password, role="member")
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Ce nom d'utilisateur existe déjà.")
    if body.budget is not None:
        with db.connect() as c:
            c.execute("UPDATE users SET budget_monthly = ? WHERE id = ?", (body.budget, profile_id))
    return _public(_profile(profile_id))


@router.patch("/api/profiles/{profile_id}")
def edit_profile(profile_id: int, body: ProfileEdit, _: int = Depends(access.owner_only)):
    _profile(profile_id)
    if "budget" not in body.model_fields_set:  # un champ absent ne retire pas le plafond
        return _public(_profile(profile_id))
    with db.connect() as c:
        c.execute("UPDATE users SET budget_monthly = ? WHERE id = ?", (body.budget, profile_id))
    return _public(_profile(profile_id))


def _transfer(c: sqlite3.Connection, agent_id: str, source: int, target: int) -> None:
    """L'agent change de propriétaire avec ses conversations et ses dépenses. Si le nouveau propriétaire lui parlait
    déjà en partage, sa conversation reste la principale ; celle du profil supprimé reste lisible comme un fil."""
    if c.execute("SELECT 1 FROM conversations WHERE agent_id = ? AND user_id = ? AND main = 1", (agent_id, target)).fetchone():
        c.execute("UPDATE conversations SET main = 0 WHERE agent_id = ? AND user_id = ?", (agent_id, source))
    c.execute("UPDATE conversations SET user_id = ? WHERE agent_id = ? AND user_id = ?", (target, agent_id, source))
    c.execute("UPDATE voice_calls SET user_id = ? WHERE agent_id = ? AND user_id = ?", (target, agent_id, source))
    c.execute("DELETE FROM agent_shares WHERE agent_id = ? AND user_id = ?", (agent_id, target))
    c.execute("UPDATE agents SET owner_id = ? WHERE id = ?", (target, agent_id))
    c.execute("UPDATE usage SET owner_id = ? WHERE agent_id = ?", (target, agent_id))


@router.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: int, agents: str | None = None, me: int = Depends(access.owner_only)):
    """`agents` : « transferer » (ils passent au propriétaire, avec leurs conversations, et continuent de tourner) ou
    « supprimer » (machine, fichiers et conversations effacés). Obligatoire dès que le profil a un agent."""
    row = _profile(profile_id)
    if row["role"] == "owner":
        raise HTTPException(400, "Le propriétaire ne peut pas se supprimer.")
    with db.connect() as c:
        owned = [dict(r) for r in c.execute("SELECT id, name FROM agents WHERE owner_id = ?", (profile_id,))]
    if owned and agents not in ("transferer", "supprimer"):
        names = ", ".join(a["name"] for a in owned)
        raise HTTPException(409, f"{row['username']} a {len(owned)} agent(s) : {names}. Choisis : « transferer » les leur "
                                 "donne à toi, avec leurs conversations et leurs fichiers ; « supprimer » efface leurs "
                                 "machines, leurs fichiers et leurs conversations, sans retour possible.")
    await _h["stop_runs"](profile_id)
    if owned and agents == "supprimer":
        for a in owned:
            await _h["remove_agent"](a["id"])
    with db.connect() as c:
        if owned and agents == "transferer":
            for a in owned:
                _transfer(c, a["id"], profile_id, me)
        # Les numéros de compte peuvent resservir : plus rien ne doit pointer vers celui-ci. Les dépenses passées restent
        # dans le total du serveur, comptées au propriétaire qui les paie.
        c.execute("UPDATE usage SET owner_id = ? WHERE owner_id = ?", (me, profile_id))
        c.execute("DELETE FROM voice_calls WHERE user_id = ?", (profile_id,))
        sessions = "SELECT token FROM sessions WHERE user_id = ?"
        c.execute(f"DELETE FROM push_subscriptions WHERE session IN ({sessions})", (profile_id,))
        c.execute(f"DELETE FROM push_queue WHERE session IN ({sessions})", (profile_id,))
        c.execute("DELETE FROM users WHERE id = ?", (profile_id,))  # sessions, partages et ses conversations ailleurs suivent
    _h["drop_pending"](profile_id)
    return {"ok": True, "agents": "transferes" if owned and agents == "transferer" else "supprimes" if owned else "aucun",
            "noms": [a["name"] for a in owned]}


class NewPassword(BaseModel):
    actuel: str = Field(min_length=1, max_length=256)
    nouveau: str = Field(min_length=8, max_length=256)


@router.post("/api/me/password")
def change_password(body: NewPassword, request: Request, apollo_session: str | None = Cookie(None),
                    user: int = Depends(auth.current_user)):
    """Le mot de passe d'un profil est choisi au départ par le propriétaire : son titulaire le remplace ici. 400 et non
    401 quand il se trompe : sa session reste bonne. Les autres appareils du compte sont déconnectés."""
    if auth.check_password(access.username(user), body.actuel) != user:
        raise HTTPException(400, "Mot de passe actuel incorrect.")
    auth.set_password(user, body.nouveau, keep=auth.digest(auth.request_token(request, apollo_session) or ""))
    return {"ok": True}


# --- Partage d'un agent : seul son propriétaire partage et révoque --------------------------------

class Share(BaseModel):
    utilisateur: str = Field(min_length=2, max_length=64)
    droit: str = Field(pattern="^(lecture|usage|admin)$")
    compris: bool = False  # l'avertissement de access.SHARE_WARNING a été montré


def _shares(agent_id: str) -> list[dict]:
    with db.connect() as c:
        rows = c.execute("SELECT s.user_id, u.username, s.droit FROM agent_shares s JOIN users u ON u.id = s.user_id "
                         "WHERE s.agent_id = ? ORDER BY u.username", (agent_id,)).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/agents/{agent_id}/shares")
def list_shares(agent_id: str, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "proprietaire")
    return {"partages": _shares(agent_id), "avertissement": access.SHARE_WARNING}


@router.put("/api/agents/{agent_id}/shares")
async def set_share(agent_id: str, body: Share, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "proprietaire")
    if not body.compris:
        raise HTTPException(400, f"Avant de partager : {access.SHARE_WARNING}")
    with db.connect() as c:
        target = c.execute("SELECT id FROM users WHERE username = ?", (body.utilisateur.strip(),)).fetchone()
    if not target:
        raise HTTPException(404, "Aucun profil à ce nom.")
    if target["id"] == user:
        raise HTTPException(400, "Cet agent est déjà le tien.")
    with db.connect() as c:
        c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES (?, ?, ?) "
                  "ON CONFLICT(agent_id, user_id) DO UPDATE SET droit = excluded.droit", (agent_id, target["id"], body.droit))
    if body.droit == "lecture":  # droit retiré : ses tâches en cours s'arrêtent, comme à la révocation
        await _h["stop_runs"](target["id"], agent_id)
    return {"partages": _shares(agent_id), "avertissement": access.SHARE_WARNING}


@router.delete("/api/agents/{agent_id}/shares/{user_id}")
async def revoke_share(agent_id: str, user_id: int, user: int = Depends(auth.current_user)):
    """Vaut à la requête suivante ; les flux déjà ouverts se coupent d'eux-mêmes (voir auth.revocable et screen_socket)."""
    access.access(user, agent_id, "proprietaire")
    with db.connect() as c:
        gone = c.execute("DELETE FROM agent_shares WHERE agent_id = ? AND user_id = ?", (agent_id, user_id)).rowcount
    if not gone:
        raise HTTPException(404, "Ce partage n'existe plus.")
    # Un rappel en attente d'envoi peut porter un compte rendu de cet agent ; la file ne dit pas lequel : on la vide.
    with db.connect() as c:
        c.execute("DELETE FROM push_queue WHERE session IN (SELECT token FROM sessions WHERE user_id = ?)", (user_id,))
    await _h["stop_runs"](user_id, agent_id)
    return {"partages": _shares(agent_id)}
