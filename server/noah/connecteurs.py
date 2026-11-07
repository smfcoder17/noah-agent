"""Connecteurs globaux : une connexion établie sur un agent vaut « pour tous mes agents », sauf ceux qu'on décoche.

Le jeton ne se copie pas aveuglément d'une machine à l'autre : un jeton de rafraîchissement qui tourne, copié, casse les deux copies dès que
l'une s'en sert. La voie dépend donc du service, et la personne n'a qu'un choix à faire :
- `jeton` (jeton fixe ou aucun, Instagram compris) : le secret vit déjà sur ce serveur et l'agent passe par son relais (mcp.py). Chaque agent reçoit
  sa ligne, avec son droit. Rien n'entre dans sa machine, et retirer la ligne coupe l'accès à la requête suivante.
- `appli_libre` (application du catalogue sans compte) : rien à partager, l'application est posée sur chaque agent.
- `google` : son jeton de rafraîchissement ne change pas à l'usage (le code d'accounts.py et d'agent_admin.py le garde tel quel) : la copie ne casse rien, et un accord
  par agent userait la limite de 100 jetons par compte et par application. Seul l'agent d'origine refait l'accord de 7 jours (accounts.py), et la copie suit.
  Pas de révocation chez Google au retrait : elle couperait aussi les autres agents.
- `appli`, `oauth`, `x` (OAuth d'Hermes ou de X) : le jeton peut tourner. OAuth 2.1 l'exige des clients publics, on ne le sait pas service par service, et le code de X
  garde la clé neuve que X rend. Chaque machine a aussi son propre enregistrement chez le fournisseur. Donc une connexion par agent : un clic, sur la session déjà ouverte.

Le connecteur appartient au propriétaire de l'agent et ne vise que ses agents à lui. Un agent neuf le reçoit à son démarrage. Le droit
(lire, confirmer, agir) reste par agent : il démarre à « confirmer », jamais à celui de l'agent d'origine.

Partage : le droit « usage » a un profil Hermes à part, sans comptes (agent_admin.guest_prepare) : rien à faire ici. Le droit « admin » met les comptes en
commun : un agent partagé ainsi ne reçoit donc un connecteur global que coché exprès pour lui, et le perd si ce partage arrive après coup.
"""
import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db, machine

router = APIRouter()

ONE_CLICK = {"appli", "oauth", "x"}
# Ce que la personne lit : pourquoi ce service se comporte ainsi, sans technique.
VOIES = {
    "jeton": "Tes agents cochés s'en servent aussitôt.",
    "appli_libre": "Tes agents cochés s'en servent aussitôt.",
    "google": "Tes agents cochés reçoivent le même accès Google. Noah le renouvelle depuis un seul d'entre eux.",
    "appli": "Pour ne pas casser ta connexion, chaque agent a la sienne : un clic par agent, ta session chez ce service est déjà ouverte.",
    "oauth": "Pour ne pas casser ta connexion, chaque agent a la sienne : un clic par agent, ta session chez ce service est déjà ouverte.",
    "x": "Pour ne pas casser ta connexion, chaque agent a la sienne : un clic par agent.",
}
_locks: dict[tuple[int, str], asyncio.Lock] = {}


def _lock(user: int, nom: str) -> asyncio.Lock:
    return _locks.setdefault((user, nom), asyncio.Lock())


# --- Base ------------------------------------------------------------------------------------------------------------

LISTS = ("exclus", "partages_ok", "poses")


def _load(row) -> dict:
    return {**dict(row), **{k: json.loads(row[k] or "[]") for k in LISTS}}


def _get(user: int, nom: str) -> dict | None:
    with db.connect() as c:
        row = c.execute("SELECT * FROM connecteurs_globaux WHERE user_id = ? AND nom = ?", (user, nom)).fetchone()
    return _load(row) if row else None


def _all(user: int) -> list[dict]:
    with db.connect() as c:
        rows = c.execute("SELECT * FROM connecteurs_globaux WHERE user_id = ? ORDER BY created_at", (user,)).fetchall()
    return [_load(r) for r in rows]


def _save(row: dict) -> None:
    lists = [json.dumps(sorted(set(row[k]))) for k in LISTS]
    with db.connect() as c:
        c.execute("INSERT INTO connecteurs_globaux (user_id, nom, genre, url, source, exclus, partages_ok, poses, created_at) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, nom) DO UPDATE SET genre = excluded.genre, url = excluded.url, "
                  "source = excluded.source, exclus = excluded.exclus, partages_ok = excluded.partages_ok, poses = excluded.poses",
                  (row["user_id"], row["nom"], row["genre"], row["url"], row["source"], *lists, row.get("created_at") or time.time()))


def _delete(row: dict) -> None:
    with db.connect() as c:
        c.execute("DELETE FROM connecteurs_globaux WHERE user_id = ? AND nom = ?", (row["user_id"], row["nom"]))


def own_agents(user: int) -> list[dict]:
    """Ses agents à lui : ni ceux qu'on lui partage, ni ceux d'un autre profil."""
    with db.connect() as c:
        rows = c.execute("SELECT id, name FROM agents ORDER BY created_at, id").fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows if access.owner_of(r["id"]) == user]


def _admin_guests(agent_id: str) -> list[str]:
    owner = access.owner_of(agent_id)
    with db.connect() as c:
        rows = c.execute("SELECT u.id, u.username FROM agent_shares s JOIN users u ON u.id = s.user_id WHERE s.agent_id = ? AND s.droit = 'admin'", (agent_id,)).fetchall()
    return [r["username"] for r in rows if r["id"] != owner]


def _wanted(row: dict, agent_id: str) -> bool:
    if agent_id in row["exclus"]:
        return False
    return agent_id == row["source"] or agent_id in row["partages_ok"] or not access.shared_admin(agent_id)


# --- Ce qui est branché sur une machine ------------------------------------------------------------------------------

async def _kind(agent_id: str, nom: str) -> tuple[str, str]:
    """La voie de ce service, lue sur la connexion établie. 404 s'il n'y en a pas sur cet agent."""
    from . import accounts, mcp, publication

    if nom == "google":
        if not accounts._account(agent_id):
            raise HTTPException(404, "Google n'est pas connecté sur cet agent.")
        accounts._own_client(agent_id)  # les identifiants de Google sont ceux du propriétaire de l'installation
        return "google", ""
    tool = mcp._row(agent_id, nom)
    if tool and tool["auth"] != "catalogue":
        if tool["auth"] == "oauth":
            return "oauth", tool["url"]
        return ("x" if tool["url"] == publication.tool_url(publication.X) else "jeton"), tool["url"]
    apps = (await machine.admin(agent_id, "applications")).get("applications") or []
    app = next((a for a in apps if a.get("nom") == nom and a.get("installe")), None)
    if not app:
        raise HTTPException(404, "Cette connexion n'existe pas sur cet agent.")
    return ("appli" if app.get("oauth") else "appli_libre"), ""


def _holder(row: dict) -> str | None:
    """Un agent qui a la ligne du relais : d'abord l'agent d'origine."""
    from . import mcp

    for agent_id in dict.fromkeys([row["source"], *row["poses"], *(a["id"] for a in own_agents(row["user_id"]))]):
        tool = mcp._row(agent_id, row["nom"])
        if tool and tool["auth"] != "catalogue":
            return agent_id
    return None


def _is_connected(row: dict, agent_id: str, read) -> bool | None:
    """`read` : ce que dit la machine (action « applications »), None si elle ne répond pas."""
    from . import accounts, mcp

    genre, nom = row["genre"], row["nom"]
    if genre == "google":
        return bool(accounts._account(agent_id))
    if genre in ("jeton", "x"):
        tool = mcp._row(agent_id, nom)
        return bool(tool and tool["auth"] != "catalogue")
    if read is None:
        return None
    if genre == "oauth":
        return bool(mcp._row(agent_id, nom)) and bool((read.get("personnels") or {}).get(nom, {}).get("connecte"))
    app = next((a for a in read.get("applications") or [] if a.get("nom") == nom), None)
    return bool(app and app.get("installe") and app.get("connecte"))


async def _install(row: dict, agent_id: str) -> None:
    """Pose le connecteur sur cet agent, quand il n'y faut aucun geste. Ce qu'il avait déjà reste à lui : `poses` ne note que ce qu'on a posé."""
    from . import accounts, mcp

    genre, nom = row["genre"], row["nom"]
    if genre == "google":
        if accounts._account(agent_id):
            return
        await _copy_google(row, agent_id)
        row["poses"].append(agent_id)
    elif genre == "appli_libre":
        apps = await machine.admin(agent_id, "applications")
        if any(a.get("nom") == nom and a.get("installe") for a in apps.get("applications") or []):
            return
        await machine.admin(agent_id, "application_connecter", {"nom": nom, "retour": ""})
        row["poses"].append(agent_id)
        mcp.tell_agent(agent_id, nom, [])
    elif genre == "jeton":
        await _place_tool(row, agent_id)


async def _place_tool(row: dict, agent_id: str) -> None:
    from . import mcp

    nom = row["nom"]
    if not mcp._row(agent_id, nom):
        holder = _holder(row)
        origin = mcp._row(holder, nom) if holder else None
        if not origin:
            raise HTTPException(409, "Plus aucun agent ne porte cette connexion.")
        token = mcp._token(origin)
        with db.connect() as c:  # le droit de l'agent d'origine ne se copie pas : chacun commence par demander confirmation
            c.execute("INSERT INTO mcp_tools (agent_id, nom, url, auth, jeton, droit, outils, etat, vu_a) VALUES (?, ?, ?, ?, ?, 'confirmer', ?, 'ok', ?)",
                      (agent_id, nom, origin["url"], origin["auth"], db.seal(token) if token else None, origin["outils"], time.time()))
        row["poses"].append(agent_id)
        _save(row)  # noté avant d'appeler la machine : une machine arrêtée reste retirable
        tools = mcp._public_tools(json.loads(origin["outils"] or "[]"))
        machine.forget_connections(agent_id)
        fresh = True
    else:
        tools, fresh = [], False
    try:
        await machine.admin(agent_id, "outil_poser", {"nom": nom, "config": mcp._agent_config(agent_id, nom), "droits": mcp._rights(agent_id), "retour": ""})
    except HTTPException as e:
        if "déjà" not in str(e.detail):  # déjà dans sa configuration : rien à poser
            raise
    if fresh:
        mcp.tell_agent(agent_id, nom, tools)


async def _copy_google(row: dict, target: str) -> None:
    from . import accounts

    account = accounts._account(row["source"])
    if not account:
        raise HTTPException(409, "L'agent d'origine n'a plus Google.")
    secrets = await machine.admin(row["source"], "google_lire")  # ne fait que passer : ni noté, ni renvoyé à l'écran
    await machine.admin(target, "google_installer", secrets)
    db.set_setting(f"google_{target}", json.dumps(account, ensure_ascii=False))
    accounts._forget_screen(target)
    accounts._tell_agent(target, account)


def _owed(agent_id: str) -> list[list[str]]:
    """Ce qui reste à retirer d'une machine qui ne répondait pas : [genre, nom]. À part du connecteur, qui a pu disparaître entre-temps."""
    return json.loads(db.get_setting(f"connecteurs_a_retirer_{agent_id}") or "[]")


def _set_owed(agent_id: str, owed: list[list[str]]) -> None:
    db.set_setting(f"connecteurs_a_retirer_{agent_id}", json.dumps(owed))


async def _take_out(agent_id: str, genre: str, nom: str) -> None:
    from . import mcp

    if genre == "google":
        await machine.admin(agent_id, "google_revoquer", {"local": True})
    elif genre in ("appli", "appli_libre"):
        installed = (await machine.admin(agent_id, "applications")).get("applications") or []
        if any(a.get("nom") == nom and a.get("installe") for a in installed):
            await machine.admin(agent_id, "application_retirer", {"nom": nom})
    else:
        await machine.admin(agent_id, "outil_retirer", {"nom": nom, "droits": mcp._rights(agent_id)})


async def _withdraw(row: dict, agent_id: str) -> None:
    """Retire vraiment : d'abord ce que Noah sert lui-même (effet immédiat), puis ce qui vit dans la machine. Machine arrêtée : repris à son redémarrage."""
    from . import mcp

    genre, nom = row["genre"], row["nom"]
    row["poses"] = [a for a in row["poses"] if a != agent_id]
    machine.forget_connections(agent_id)
    if genre == "google":
        db.set_setting(f"google_{agent_id}", "")
    else:
        mcp.forget(agent_id, nom)
    try:
        await _take_out(agent_id, genre, nom)
    except Exception:  # noqa: BLE001 - sa machine ne répond pas : elle ne sert rien non plus
        _set_owed(agent_id, [*_owed(agent_id), [genre, nom]])
        raise


def _settle_source(row: dict, keep_from: list[str]) -> bool:
    """L'agent d'origine n'en est plus : un autre prend sa place. Faux s'il n'y en a pas."""
    if row["source"] not in row["exclus"] and row["source"] in {a["id"] for a in own_agents(row["user_id"])}:
        return True
    next_source = next((a for a in keep_from if a != row["source"]), None)
    if not next_source:
        return False
    row["source"] = next_source
    row["poses"] = [a for a in row["poses"] if a != next_source]
    return True


def _connected_now(row: dict) -> list[str]:
    """Les agents vers lesquels l'origine peut passer : pour Google et le relais, ceux qui ont déjà la connexion."""
    from . import accounts, mcp

    wanted = [a["id"] for a in own_agents(row["user_id"]) if _wanted(row, a["id"])]
    if row["genre"] == "google":
        return [a for a in wanted if accounts._account(a)]
    if row["genre"] in ("jeton", "x"):
        return [a for a in wanted if mcp._row(a, row["nom"])]
    return wanted


# --- Ce qui s'applique ----------------------------------------------------------------------------------------------

async def _apply(row: dict, previous: set[str]) -> dict[str, str]:
    """Rend à chaque agent ce qu'il doit avoir. `previous` : les agents visés avant ce changement. Rend les soucis, par agent."""
    trouble: dict[str, str] = {}
    own = [a["id"] for a in own_agents(row["user_id"])]

    async def step(agent_id: str, gesture) -> None:
        try:
            await gesture
        except HTTPException as e:
            trouble[agent_id] = str(e.detail)
        except Exception:  # noqa: BLE001
            trouble[agent_id] = "Sa machine ne répond pas : ce sera repris à son redémarrage."

    for agent_id in own:  # d'abord poser : si l'origine est retirée juste après, le connecteur a de quoi survivre
        if _wanted(row, agent_id):
            await step(agent_id, _install(row, agent_id))
    # L'origine n'est retirée qu'une fois un autre agent en mesure de prendre sa place. Sinon rien ne bouge.
    if not _settle_source(row, _connected_now(row)):
        raise HTTPException(409, "Aucun autre agent n'a encore cette connexion : garde celui-ci coché, ou recommence quand les autres sont connectés.")
    for agent_id in own:
        if _wanted(row, agent_id):
            continue
        # Décoché : l'accès part, même une connexion d'avant. Partage admin non coché : seulement ce que Noah y a posé.
        if (agent_id in row["exclus"] and agent_id in previous) or agent_id in row["poses"]:
            await step(agent_id, _withdraw(row, agent_id))
    _save(row)
    for agent_id in own:
        machine.forget_connections(agent_id)
    return trouble


async def sync_agent(agent_id: str) -> None:
    """À chaque démarrage d'un agent : l'agent neuf reçoit les connecteurs globaux, une machine qui était arrêtée rattrape ce qu'elle a manqué."""
    user = access.owner_of(agent_id)
    if user is None:
        return
    left = []
    for genre, nom in _owed(agent_id):
        row = _get(user, nom)
        if row and _wanted(row, agent_id):  # recoché entre-temps : plus rien à retirer
            continue
        try:
            await _take_out(agent_id, genre, nom)
        except Exception:  # noqa: BLE001 - encore arrêtée
            left.append([genre, nom])
    if _owed(agent_id):
        _set_owed(agent_id, left)
    for known in _all(user):
        async with _lock(user, known["nom"]):
            row = _get(user, known["nom"])
            if not row or not _wanted(row, agent_id):
                continue
            try:
                await _install(row, agent_id)
            except Exception as e:  # noqa: BLE001 - le démarrage de l'agent ne dépend pas d'un connecteur
                print(f"[connecteurs] {row['nom']} sur {agent_id} : {getattr(e, 'detail', type(e).__name__)}", flush=True)
            _save(row)


async def share_changed(agent_id: str) -> None:
    """Un partage arrive ou s'en va : un agent partagé en admin perd ce qui n'a pas été coché pour lui, et le retrouve si ce partage cesse."""
    user = access.owner_of(agent_id)
    if user is None:
        return
    for known in _all(user):
        async with _lock(user, known["nom"]):
            row = _get(user, known["nom"])
            if row and not _wanted(row, agent_id) and agent_id in row["poses"]:
                try:
                    await _withdraw(row, agent_id)
                except Exception as e:  # noqa: BLE001
                    print(f"[connecteurs] retrait de {row['nom']} sur {agent_id} : {getattr(e, 'detail', type(e).__name__)}", flush=True)
                _save(row)
    await sync_agent(agent_id)


async def removed(agent_id: str, nom: str) -> None:
    """La personne retire la connexion depuis l'agent : cet agent sort du connecteur, les autres gardent le leur."""
    user = access.owner_of(agent_id)
    row = _get(user, nom) if user is not None else None
    if not row or (agent_id != row["source"] and not _wanted(row, agent_id)):
        return
    row["exclus"].append(agent_id)
    for key in ("poses", "partages_ok"):
        row[key] = [a for a in row[key] if a != agent_id]
    if _settle_source(row, _connected_now(row)):
        _save(row)
    else:
        _delete(row)
    for a in own_agents(user):
        machine.forget_connections(a["id"])


def agent_gone(agent_id: str) -> None:
    """L'agent est supprimé : son nom sort des listes, et un autre reprend l'origine."""
    db.set_setting(f"connecteurs_a_retirer_{agent_id}", "")
    with db.connect() as c:
        rows = [_load(r) for r in c.execute("SELECT * FROM connecteurs_globaux").fetchall()]
    for row in rows:
        if agent_id != row["source"] and not any(agent_id in row[k] for k in LISTS):
            continue
        for key in LISTS:
            row[key] = [a for a in row[key] if a != agent_id]
        if _settle_source(row, _connected_now(row)):
            _save(row)
        else:
            _delete(row)


# --- Google : seule l'origine renouvelle ------------------------------------------------------------------------------

def google_copy(agent_id: str) -> bool:
    """Ce Google est une copie : l'accord de 7 jours se refait sur l'agent d'origine, pas ici."""
    user = access.owner_of(agent_id)
    row = _get(user, "google") if user is not None else None
    return bool(row and agent_id != row["source"] and agent_id in row["poses"])


async def google_renewed(agent_id: str) -> None:
    """Un accord Google vient d'aboutir sur cet agent. L'origine : la copie suit. Une copie : cet agent a maintenant son accord à lui."""
    user = access.owner_of(agent_id)
    row = _get(user, "google") if user is not None else None
    if not row:
        return
    async with _lock(user, "google"):
        row = _get(user, "google")
        if not row:
            return
        if agent_id == row["source"]:
            for target in row["poses"]:
                if _wanted(row, target):
                    try:
                        await _copy_google(row, target)
                    except Exception as e:  # noqa: BLE001 - machine arrêtée : sa prochaine lecture dira ce qu'il en est
                        print(f"[connecteurs] Google non recopié sur {target} : {getattr(e, 'detail', type(e).__name__)}", flush=True)
        elif agent_id in row["poses"]:
            row["poses"] = [a for a in row["poses"] if a != agent_id]
            _save(row)


# --- Lectures ---------------------------------------------------------------------------------------------------------

def for_agent(agent_id: str, google: dict, apps: dict) -> list[dict]:
    """Pour l'onglet Connexions : les connecteurs globaux qui visent cet agent, et ceux qui attendent son clic."""
    user = access.owner_of(agent_id)
    if user is None:
        return []
    out = []
    for row in _all(user):
        if _wanted(row, agent_id):
            out.append({"nom": row["nom"], "genre": row["genre"], "connecte": bool(_is_connected(row, agent_id, apps)), "origine": row["source"] == agent_id})
    return out


async def _view(user: int, agent_id: str, nom: str) -> dict:
    row = _get(user, nom)
    live = row is not None
    if not row:
        genre, url = await _kind(agent_id, nom)
        row = {"user_id": user, "nom": nom, "genre": genre, "url": url, "source": agent_id, "exclus": [], "partages_ok": [], "poses": []}
    agents = own_agents(user)
    reads: list = [None] * len(agents)
    if row["genre"] in ("appli", "appli_libre", "oauth"):
        async def read(agent: dict):
            try:
                return await machine.admin(agent["id"], "applications")
            except Exception:  # noqa: BLE001 - machine arrêtée : la ligne le dira
                return None
        reads = await asyncio.gather(*(read(a) for a in agents))
    from . import mcp

    shown = []
    for agent, state in zip(agents, reads):
        guests, ticked = _admin_guests(agent["id"]), _wanted(row, agent["id"])
        connected = _is_connected(row, agent["id"], state)
        if not ticked:
            etat = "partage" if guests and agent["id"] not in row["exclus"] else "exclu"
        elif connected is None:
            etat = "arrete"
        else:
            etat = "ok" if connected else ("a_connecter" if row["genre"] in ONE_CLICK else "en_attente")
        tool = mcp._row(agent["id"], nom)
        shown.append({"id": agent["id"], "nom": agent["name"], "coche": ticked, "etat": etat, "origine": agent["id"] == row["source"], "invites": guests,
                      "droit": (tool["droit"] if tool else "confirmer") if connected and row["genre"] != "google" else None})
    return {"nom": nom, "pour_tous": live, "genre": row["genre"], "voie": VOIES[row["genre"]], "agents": shown}


# --- Routes ----------------------------------------------------------------------------------------------------------

def _name(nom: str) -> str:
    from . import mcp

    if not mcp.NAME.fullmatch(nom):
        raise HTTPException(404, "Connexion inconnue.")
    return nom


@router.get("/api/agents/{agent_id}/connecteurs/{nom}")
async def scope(agent_id: str, nom: str, user: int = Depends(auth.current_user)):
    """Réservé au propriétaire de l'agent : c'est lui qui décide quels agents ont ses comptes."""
    access.access(user, agent_id, "proprietaire")
    return await _view(user, agent_id, _name(nom))


class Scope(BaseModel):
    pour_tous: bool
    agents: list[str] | None = Field(default=None, max_length=500)  # ceux qu'elle coche. Absent : le choix précédent, ou par défaut


@router.put("/api/agents/{agent_id}/connecteurs/{nom}")
async def set_scope(agent_id: str, nom: str, body: Scope, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "proprietaire")
    nom = _name(nom)
    async with _lock(user, nom):
        row = _get(user, nom)
        if not body.pour_tous:
            if row:
                for target in [a for a in row["poses"] if a != row["source"]]:
                    try:
                        await _withdraw(row, target)
                    except Exception as e:  # noqa: BLE001
                        print(f"[connecteurs] retrait de {nom} sur {target} : {getattr(e, 'detail', type(e).__name__)}", flush=True)
                _delete(row)
                for a in own_agents(user):
                    machine.forget_connections(a["id"])
            return {**await _view_or_empty(user, agent_id, nom), "soucis": {}}
        own = {a["id"] for a in own_agents(user)}
        if not row:
            genre, url = await _kind(agent_id, nom)
            row = {"user_id": user, "nom": nom, "genre": genre, "url": url, "source": agent_id, "exclus": [], "partages_ok": [], "poses": []}
        previous = {a for a in own if _wanted(row, a)}
        if body.agents is not None:
            ticked = set(body.agents)
            if ticked - own:  # un agent d'un autre profil : on ne confirme même pas qu'il existe
                raise HTTPException(404, "Agent introuvable")
            if not ticked:
                raise HTTPException(400, "Coche au moins un agent, ou choisis « Pour cet agent ».")
            row["exclus"] = sorted(own - ticked)
            row["partages_ok"] = sorted(a for a in ticked if access.shared_admin(a))
        trouble = await _apply(row, previous)
    return {**await _view(user, agent_id, nom), "soucis": trouble}


async def _view_or_empty(user: int, agent_id: str, nom: str) -> dict:
    try:
        return await _view(user, agent_id, nom)
    except HTTPException:  # cet agent ne l'a plus
        return {"nom": nom, "pour_tous": False, "genre": "", "voie": "", "agents": []}


@router.post("/api/agents/{agent_id}/connecteurs/{nom}/connecter")
async def connect_here(agent_id: str, nom: str, request: Request, user: int = Depends(auth.current_user)):
    """Le clic par agent : ouvre l'accord du fournisseur, sur la session que la personne y a déjà."""
    from . import mcp

    access.access(user, agent_id, "proprietaire")
    row = _get(user, _name(nom))
    if not row or not _wanted(row, agent_id):
        raise HTTPException(404, "Ce connecteur ne vise pas cet agent.")
    genre = row["genre"]
    if genre not in ONE_CLICK:
        raise HTTPException(400, "Ce connecteur n'a pas besoin de clic.")
    if genre == "appli":
        out = await machine.app_action(agent_id, nom, "connect", request, None, user)
    elif genre == "oauth":
        if mcp._row(agent_id, nom):
            out = await mcp.tool_action(agent_id, nom, "connect", request, None, user)
        else:
            out = await mcp.add_tool(agent_id, mcp.NewTool(url=row["url"], nom=nom, auth="oauth", droit="confirmer"), request, user)
    else:
        holder = _holder(row)
        origin = mcp._row(holder, nom) if holder else None
        if not origin:
            raise HTTPException(409, "Plus aucun agent ne porte cette connexion : reconnecte X d'abord.")
        client = json.loads(mcp._token(origin) or "{}").get("client") or ""
        out = await mcp.connect_x(agent_id, mcp.XClient(client_id=client), request, user)
    async with _lock(user, nom):
        fresh = _get(user, nom)
        if fresh and agent_id != fresh["source"]:
            fresh["poses"].append(agent_id)
            _save(fresh)
    return out
