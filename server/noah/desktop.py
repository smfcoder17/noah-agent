"""Actions de l'agent sur les ordinateurs de l'utilisateur, par l'application de bureau.

L'agent appelle `noah.py ordinateur …` ; la demande attend ici que l'application de bureau de l'appareil visé la récupère
(attente longue sur /api/desktop/next). L'application applique les droits, fait confirmer ce qui doit l'être dans une boîte de
dialogue du système (la page web ne peut pas répondre à sa place), exécute et renvoie le résultat. Sans application ouverte,
l'agent reçoit une erreur lisible au lieu d'attendre. Une écriture vers un ordinateur éteint attend ici, sur disque.

Les droits sur les dossiers vivent sur l'ordinateur (desktop/dossiers.js) : le serveur ne connaît ni les chemins, ni ne décide.
"""
import asyncio
import hashlib
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import access, auth, config, db, hermes, notifications, relay

router = APIRouter()

# Par appareil : un ordinateur ne reçoit jamais ce qui vise un autre, et encore moins celui d'un autre compte.
_queues: dict[str, asyncio.Queue] = {}
_waiting: dict[str, tuple[asyncio.Future, str, int]] = {}  # demande -> (réponse attendue, appareil qui répond, son compte)
_seen: dict[str, dict] = {}  # dernier passage de chaque application : compte, système, dossiers confiés
_sending: dict[str, float] = {}  # écritures durables en cours de livraison -> quand elles sont parties
_incoming: dict[str, tuple[Path, str]] = {}  # fichier lu sur l'ordinateur et son empreinte, le temps que l'agent le récupère
_unacked: dict[str, dict] = {}  # dernière demande donnée à chaque appareil, tant qu'il n'a pas dit l'avoir reçue
_receiving: dict[int, int] = {}  # octets en cours de réception, par compte : ils comptent déjà dans le plafond
_BOOT = time.time()
AFTER_RESTART = 30  # le temps que les applications reviennent après un redémarrage du serveur
WAIT = 25  # secondes d'attente longue de l'application de bureau
ONLINE = 40  # secondes sans nouvelles avant de dire l'application fermée
ANSWER = 300  # le temps pour la personne de lire une demande et d'y répondre
WRITE_ANSWER = 120  # au-delà, l'écriture reste en attente et l'agent poursuit
RESEND = 600  # une livraison sans accusé repart après ce délai

MAX_FILE = 50 * 1024 * 1024
MAX_PENDING = 500 * 1024 * 1024  # par compte
KEEP = timedelta(days=7)

ACTIONS = ("ouvrir", "notifier", "presse_papiers", "lancer", "commande", "lister", "deplacer", "creer_dossier", "corbeille")
FOLDER_ACTIONS = ("lister", "deplacer", "creer_dossier", "corbeille")


class AgentAction(BaseModel):
    action: str = Field(pattern="^(" + "|".join(ACTIONS) + ")$")
    cible: str = Field(default="", max_length=2000)  # chemin, adresse, application ou commande
    titre: str = Field(default="", max_length=200)
    texte: str = Field(default="", max_length=4000)
    appareil: str = Field(default="", max_length=200)  # son identifiant, qui survit à un renommage, ou son nom
    dossier: str = Field(default="", max_length=200)  # identifiant ou nom d'un dossier confié
    chemin: str = Field(default="", max_length=1000)  # relatif à ce dossier
    vers: str = Field(default="", max_length=1000)  # pour déplacer : la nouvelle place, relative au même dossier


class ReadFile(BaseModel):
    appareil: str = Field(default="", max_length=200)
    dossier: str = Field(default="", max_length=200)
    chemin: str = Field(default="", max_length=1000)


class AgentNotice(BaseModel):
    titre: str = Field(min_length=1, max_length=120)
    texte: str = Field(default="", max_length=400)
    appareil: str = Field(default="", max_length=200)


class Beat(BaseModel):
    os: str = Field(default="", max_length=20)
    dossiers: list[dict] = Field(default_factory=list, max_length=100)
    coupe: bool = False


def _queue(device: str) -> asyncio.Queue:
    return _queues.setdefault(device, asyncio.Queue())


def _online(device: str) -> bool:
    return time.time() - _seen.get(device, {}).get("at", 0.0) < ONLINE


def connected(user: int) -> bool:
    return any(s.get("user") == user and _online(d) for d, s in _seen.items())


def _device(request: Request, cookie: str | None) -> str:
    return auth.device_id(auth.session_key(auth.request_token(request, cookie)))


def _touch(device: str, user: int, **more) -> None:
    _seen[device] = {**_seen.get(device, {}), "at": time.time(), "user": user, **more}


def _known(user: int) -> list[dict]:
    """Les ordinateurs de ce compte : ceux dont la session vit encore et qui sont des applications de bureau."""
    return [d for d in auth.devices(user, None) if d["type"] == "desktop" or d["id"] in _seen]


def _which(user: int, asked: str, offline: bool = False) -> tuple[str | None, str | None]:
    """L'ordinateur visé, parmi ceux de ce compte seulement. Rend (appareil, None) ou (None, message pour l'agent)."""
    known = _known(user)
    asked = asked.strip()
    if asked:
        found = [d for d in known if d["id"] == asked or (d["nom"] or "").lower() == asked.lower()]
        if len(found) > 1:
            return None, "Deux ordinateurs portent ce nom : " + _names(found) + ". Donne son identifiant."
        if not found:
            return None, f"Aucun ordinateur de ce nom : {asked}. Ordinateurs de ce compte : " + (_names(known) or "aucun") + "."
        device = found[0]["id"]
    else:
        online = [d for d in known if _online(d["id"])]
        pool = online or (known if offline else [])
        if len(pool) > 1:
            return None, "Plusieurs ordinateurs possibles : " + _names(pool) + ". Demande à l'utilisateur lequel, puis utilise --appareil."
        if not pool:
            return None, ("L'application de bureau Noah Agent n'est pas ouverte sur l'ordinateur de l'utilisateur. "
                          "Dis-lui de l'ouvrir (elle peut rester dans la zone de notification), puis réessaie.")
        device = pool[0]["id"]
    if not offline and not _online(device):
        return None, "Cet ordinateur est éteint, ou son application de bureau est fermée. Dis-le à l'utilisateur."
    return device, None


def _names(devices: list[dict]) -> str:
    return ", ".join(f"{d['nom'] or 'Ordinateur'} ({d['id']})" for d in devices)


def _host_path(agent_id: str, path: str) -> str | None:
    """/opt/data/dossiers/<nom>/… (vu par l'agent) → chemin sur l'ordinateur. Rend None pour un fichier qui
    n'existe que dans la machine de l'agent, et pour un chemin qui remonte."""
    if ".." in re.split(r"[\\/]", path):
        return None
    m = re.match(r"^/opt/data/dossiers/([a-z0-9-]+)(/.*)?$", path)
    if m:
        folder = next((f for f in hermes.shared_folders(agent_id) if f["nom"] == m.group(1)), None)
        if folder:
            sep = "\\" if re.match(r"^[A-Za-z]:", folder["chemin"]) else "/"
            return folder["chemin"].rstrip("\\/") + (m.group(2) or "").replace("/", sep)
    return None if path.startswith("/opt/") or path.startswith("/tmp/") else path


def _working_folder(agent_id: str) -> str:
    return next((f["chemin"] for f in hermes.shared_folders(agent_id) if f["travail"]), "")


def _agent_name(agent_id: str) -> str:
    with db.connect() as c:
        row = c.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
    return row["name"] if row else "Noah"


GUEST = "Tu es partagé avec d'autres personnes, ou l'une d'elles t'a confié cette tâche : les appareils de ton propriétaire n'en font pas partie."
GONE = "L'ordinateur s'est déconnecté avant de répondre : rien n'indique que l'action a eu lieu. Dis-le à l'utilisateur."


def _too_old(device: str) -> bool:
    """Les applications d'avant les dossiers ne le disent pas : elles ne savent ni lister, ni lire, ni écrire."""
    return not _seen.get(device, {}).get("bat")


async def _settled(user: int) -> None:
    """Juste après un redémarrage, la présence est vide : on laisse aux applications le temps de revenir, sans dire de faux."""
    while time.time() - _BOOT < AFTER_RESTART and not connected(user):
        await asyncio.sleep(1)


def _gatekept(agent_id: str) -> dict | None:
    """Ce qui ferme l'accès aux appareils du propriétaire. Un profil admin a la main sur l'agent (routines, terminal, rôle) :
    on ne peut pas distinguer ce qu'il lui fait faire, donc un agent ainsi partagé n'atteint aucun appareil."""
    if access.guest_task(agent_id) or access.shared_admin(agent_id):
        return {"erreur": GUEST}
    return None


class Gone(Exception):
    """L'ordinateur a disparu pendant l'attente."""


async def _ask(device: str, user: int, item: dict, seconds: float = ANSWER):
    rid = item.get("id") or uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    _waiting[rid] = (future, device, user)
    await _queue(device).put({**item, "id": rid})
    deadline = time.time() + seconds
    try:
        while True:
            try:
                return await asyncio.wait_for(asyncio.shield(future), min(3, max(0.05, deadline - time.time())))
            except asyncio.TimeoutError:
                if time.time() >= deadline:
                    raise
                seen = _seen.get(device, {})
                if seen.get("bat") and not _online(device):  # session révoquée, application fermée, réseau perdu
                    raise Gone() from None
    finally:
        _waiting.pop(rid, None)


@router.post("/agent-api/ordinateur")
async def agent_action(body: AgentAction, request: Request):
    agent_id = relay._agent_from(request)
    if closed := _gatekept(agent_id):
        return closed
    target = access.owner_of(agent_id)
    await _settled(target)
    device, problem = _which(target, body.appareil)
    if problem:
        return {"erreur": problem}
    if body.action in FOLDER_ACTIONS and _too_old(device):
        return {"erreur": "L'application de bureau de cet ordinateur est trop ancienne pour les dossiers. Dis à l'utilisateur de la mettre à jour."}
    cible = body.cible.strip()
    if body.action == "ouvrir" and not re.match(r"^https?://", cible):
        if ".." in re.split(r"[\\/]", cible):
            return {"erreur": "Ce chemin remonte dans les dossiers : donne le chemin complet."}
        host = _host_path(agent_id, cible)
        if host is None:
            return {"erreur": "Ce fichier n'existe que dans ta machine. Copie-le d'abord dans un dossier partagé "
                              "(de préférence ton dossier de travail, voir /opt/data/dossiers.json), puis ouvre cette copie."}
        cible = host
    item = {"agent": _agent_name(agent_id), "action": body.action, "cible": cible, "titre": body.titre, "texte": body.texte,
            "dossier": _working_folder(agent_id), "dossierId": body.dossier, "chemin": body.chemin, "vers": body.vers}
    try:
        return await _ask(device, target, item)
    except asyncio.TimeoutError:
        return {"erreur": "Pas de réponse de l'utilisateur dans les 5 minutes : action annulée."}
    except Gone:
        return {"erreur": GONE}


@router.post("/agent-api/ordinateur/lire")
async def agent_read(body: ReadFile, request: Request, tasks: BackgroundTasks):
    """Le fichier revient tel quel : l'agent l'enregistre, puis choisit ce qu'il en donne au modèle."""
    agent_id = relay._agent_from(request)
    if closed := _gatekept(agent_id):
        return closed
    if not body.dossier or not body.chemin:
        return {"erreur": "Donne le dossier et le chemin du fichier dans ce dossier."}
    target = access.owner_of(agent_id)
    await _settled(target)
    device, problem = _which(target, body.appareil)
    if problem:
        return {"erreur": problem}
    if _too_old(device):
        return {"erreur": "L'application de bureau de cet ordinateur est trop ancienne pour les dossiers. Dis à l'utilisateur de la mettre à jour."}
    rid = uuid.uuid4().hex
    try:
        out = await _ask(device, target, {"id": rid, "agent": _agent_name(agent_id), "action": "lire", "dossierId": body.dossier, "chemin": body.chemin})
    except asyncio.TimeoutError:
        _drop_incoming(rid)
        return {"erreur": "L'ordinateur n'a pas répondu à temps."}
    except Gone:
        _drop_incoming(rid)
        return {"erreur": GONE}
    got = _incoming.pop(rid, None)
    if not (isinstance(out, dict) and out.get("ok")) or not got:
        if got:
            got[0].unlink(missing_ok=True)
        return out if isinstance(out, dict) else {"erreur": "Réponse illisible de l'ordinateur."}
    tasks.add_task(got[0].unlink, missing_ok=True)
    # L'empreinte est celle du fichier reçu : l'agent vérifie qu'il l'a reçu entier, même si le serveur redémarre en route.
    return FileResponse(got[0], media_type="application/octet-stream", headers={"X-Noah-Empreinte": got[1]})


def _drop_incoming(rid: str) -> None:
    got = _incoming.pop(rid, None)
    if got:
        got[0].unlink(missing_ok=True)


# --- Écritures : d'abord sur le disque du serveur, livrées quand l'ordinateur est là -------------------------------------

def _pending_folder() -> Path:
    path = Path(config.DATA_DIR) / "attente"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pending_bytes(user: int) -> int:
    with db.connect() as c:
        return c.execute("SELECT COALESCE(SUM(taille), 0) AS n FROM desktop_attente WHERE user_id = ?", (user,)).fetchone()["n"]


async def _store_body(request: Request, path: Path, user: int | None = None) -> tuple[int, str] | None:
    """Enregistre le corps de la requête, sans le garder en mémoire. Rend (taille, empreinte), ou None au-delà de 50 Mo ou, pour
    un compte, de son plafond d'attente : ce qui arrive en même temps compte déjà. Coupé en route, il ne reste rien."""
    size, digest, done = 0, hashlib.sha256(), False
    try:
        with open(path, "wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if user is not None:
                    _receiving[user] = _receiving.get(user, 0) + len(chunk)
                if size > MAX_FILE or (user is not None and _pending_bytes(user) + _receiving[user] > MAX_PENDING):
                    return None
                digest.update(chunk)
                out.write(chunk)
            out.flush()
            await asyncio.to_thread(os.fsync, out.fileno())
        done = True
        return size, digest.hexdigest()
    finally:
        if user is not None:
            _receiving[user] = _receiving.get(user, 0) - size
        if not done:
            path.unlink(missing_ok=True)


def _item_of(row) -> dict:
    return {"id": row["id"], "agent": row["agent"], "action": "ecrire", "dossierId": row["dossier"], "chemin": row["chemin"],
            "sha256": row["sha256"], "taille": row["taille"], "remplacer": bool(row["remplacer"])}


def _forget_pending(rid: str) -> None:
    with db.connect() as c:
        c.execute("DELETE FROM desktop_attente WHERE id = ?", (rid,))
    (_pending_folder() / rid).unlink(missing_ok=True)
    _sending.pop(rid, None)


def _pending_row(rid: str):
    with db.connect() as c:
        return c.execute("SELECT * FROM desktop_attente WHERE id = ?", (rid,)).fetchone()


@router.post("/agent-api/ordinateur/ecrire")
async def agent_write(request: Request, dossier: str, chemin: str, appareil: str = "", remplacer: bool = False):
    agent_id = relay._agent_from(request)
    if closed := _gatekept(agent_id):
        return closed
    if not dossier or not chemin or len(dossier) > 200 or len(chemin) > 1000:
        return {"erreur": "Donne le dossier et le chemin du fichier dans ce dossier."}
    target = access.owner_of(agent_id)
    await _settled(target)
    device, problem = _which(target, appareil, offline=True)
    if problem:
        return {"erreur": problem}
    if _online(device) and _too_old(device):
        return {"erreur": "L'application de bureau de cet ordinateur est trop ancienne pour les dossiers. Dis à l'utilisateur de la mettre à jour."}
    sweep()
    rid = uuid.uuid4().hex
    path = _pending_folder() / rid
    stored = await _store_body(request, path, target) if _pending_bytes(target) < MAX_PENDING else None
    if stored is None:
        return {"erreur": "Fichier trop gros : 50 Mo au plus, et 500 Mo au plus en attente pour ce compte."}
    size, digest = stored
    name = _agent_name(agent_id)
    with db.connect() as c:
        c.execute("INSERT INTO desktop_attente (id, user_id, appareil, agent, dossier, chemin, sha256, taille, remplacer, cree, expire) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  (rid, target, device, name, dossier, chemin, digest, size, int(remplacer), _now(),
                   (datetime.now(timezone.utc) + KEEP).isoformat()))
    waiting = {"attente": True, "id": rid, "message": "L'ordinateur n'est pas disponible : le fichier attend sur le serveur, 7 jours au plus, et arrivera à sa reconnexion."}
    if not _online(device):
        notify_user(target, "Un fichier attend ton ordinateur", f"{name} a préparé « {_short(chemin)} ». Il arrivera dans « {dossier} » dès que l'application de bureau sera ouverte.",
                    url="/")
        return waiting
    _sending[rid] = time.time()
    try:
        return await _ask(device, target, _item_of(_pending_row(rid)), WRITE_ANSWER)
    except (asyncio.TimeoutError, Gone):
        return waiting


def _short(chemin: str) -> str:
    return re.split(r"[\\/]", chemin)[-1][:80]


def sweep() -> None:
    """Retire ce qui a dépassé 7 jours et ce qui visait un appareil retiré, et le dit à la personne : le fichier est perdu, elle
    doit le savoir. Retire aussi ce qu'un transfert ou un redémarrage a laissé sans propriétaire."""
    with db.connect() as c:
        rows = c.execute("SELECT * FROM desktop_attente").fetchall()
    now = _now()
    for row in rows:
        reason = None
        if row["expire"] <= now:
            reason = f"« {_short(row['chemin'])} » a attendu 7 jours : l'ordinateur ne s'est pas reconnecté, il est retiré."
        elif not auth.session_of_device(row["user_id"], row["appareil"]):
            reason = f"« {_short(row['chemin'])} » visait un ordinateur déconnecté de ton compte : il est retiré."
        if not reason:
            continue
        _forget_pending(row["id"])
        try:
            notify_user(row["user_id"], "Fichier non livré", reason, url="/")
        except RuntimeError:  # pas de boucle en cours (appel hors serveur)
            pass
    known = {r["id"] for r in rows}
    busy = {p.name for p, _ in _incoming.values()}
    limit = time.time() - 3600
    for path in _pending_folder().iterdir():
        if path.name not in known and path.name not in busy and path.stat().st_mtime < limit:
            path.unlink(missing_ok=True)


async def keep_clean() -> None:
    while True:
        sweep()
        await asyncio.sleep(3600)


def _next_pending(device: str):
    now = time.time()
    with db.connect() as c:
        rows = c.execute("SELECT * FROM desktop_attente WHERE appareil = ? AND expire > ? ORDER BY cree", (device, _now())).fetchall()
    for row in rows:
        if now - _sending.get(row["id"], 0.0) > RESEND:
            _sending[row["id"]] = now
            return row
    return None


@router.get("/api/desktop/next")
async def next_action(request: Request, os: str = "", fichiers: bool = False, recu: str = "", noah_session: str | None = Cookie(None),
                      user: int = Depends(auth.current_user)):
    """Attente longue de l'application de bureau : rend la prochaine action, ou 204 après 25 s.

    Une application coupée laisse ici une attente fantôme, qui prendrait la demande suivante pour personne. Donc : l'attente
    s'arrête quand le client part, et une application récente dit à chaque appel la dernière demande reçue ; sinon, elle repart."""
    device = _device(request, noah_session)
    _touch(device, user, os=os[:20], **({"bat": True} if fichiers else {}))

    def given(item: dict) -> dict:
        if fichiers:
            _unacked[device] = item
        _touch(device, user)
        return item

    last = _unacked.pop(device, None)
    if last and fichiers and last["id"] != recu and (last["id"] in _waiting or _pending_row(last["id"])):
        return given(last)
    pending = None if _too_old(device) else _next_pending(device)
    if pending:
        return given(_item_of(pending))
    deadline = time.time() + WAIT
    while time.time() < deadline:
        if await request.is_disconnected():
            return Response(status_code=204)
        try:
            item = await asyncio.wait_for(_queue(device).get(), min(1, max(0.05, deadline - time.time())))
        except asyncio.TimeoutError:
            continue
        if await request.is_disconnected():
            _queue(device).put_nowait(item)
            return Response(status_code=204)
        if item["id"] in _waiting:  # l'agent attend encore (sinon elle a expiré)
            return given(item)
    return Response(status_code=204)


@router.post("/api/desktop/battement")
async def beat(body: Beat, request: Request, noah_session: str | None = Cookie(None), user: int = Depends(auth.current_user)):
    """La présence, à part de l'attente longue : une fenêtre d'accord ouverte ne fait pas croire l'application fermée."""
    device = _device(request, noah_session)
    shown = [{"id": str(d.get("id", ""))[:40], "nom": str(d.get("nom", ""))[:120], "ecriture": bool(d.get("ecriture")), "absent": bool(d.get("absent"))} for d in body.dossiers]
    _touch(device, user, os=body.os, bat=True, dossiers=shown, coupe=body.coupe)
    # Le compte sous une forme qui ne dit rien : l'application efface ses droits si elle change de compte.
    return {"compte": hashlib.sha256(f"noah-compte:{user}".encode()).hexdigest()[:16]}


@router.get("/api/desktop/encore/{rid}")
async def still_wanted(rid: str, request: Request, noah_session: str | None = Cookie(None), user: int = Depends(auth.current_user)):
    """Une fenêtre d'accord vient de recevoir sa réponse : la demande vit-elle encore ?"""
    _, device, owner = _waiting.get(rid, (None, None, None))
    if owner == user and device == _device(request, noah_session):
        return {"encore": True}
    row = _pending_row(rid)
    if row and row["user_id"] == user and row["appareil"] == _device(request, noah_session):
        return {"encore": True}
    raise HTTPException(404, "Demande introuvable")


@router.get("/api/desktop/piece/{rid}")
async def piece_for_computer(rid: str, request: Request, noah_session: str | None = Cookie(None), user: int = Depends(auth.current_user)):
    """Le fichier qu'une écriture doit déposer, pour l'appareil visé seulement."""
    row = _pending_row(rid)
    path = _pending_folder() / rid
    if not row or row["user_id"] != user or row["appareil"] != _device(request, noah_session) or not path.is_file():
        raise HTTPException(404, "Fichier introuvable")
    return FileResponse(path, media_type="application/octet-stream")


@router.post("/api/desktop/piece/{rid}")
async def piece_from_computer(rid: str, request: Request, noah_session: str | None = Cookie(None), user: int = Depends(auth.current_user)):
    """Le fichier qu'une lecture a sorti de l'ordinateur, le temps que l'agent le récupère."""
    _, device, owner = _waiting.get(rid, (None, None, None))
    if owner != user or device != _device(request, noah_session) or rid in _incoming:
        raise HTTPException(404, "Demande introuvable")
    path = _pending_folder() / f"lu-{rid}"
    stored = await _store_body(request, path)
    if stored is None:
        raise HTTPException(413, "Fichier trop gros")
    if rid not in _waiting:  # l'agent ne l'attend plus
        path.unlink(missing_ok=True)
        raise HTTPException(404, "Demande introuvable")
    _incoming[rid] = (path, stored[1])
    return {"ok": True}


@router.post("/api/desktop/result/{rid}")
async def action_result(rid: str, body: dict, request: Request, noah_session: str | None = Cookie(None), user: int = Depends(auth.current_user)):
    device = _device(request, noah_session)
    row = _pending_row(rid)
    future, target, owner = _waiting.get(rid, (None, None, None))
    if row is not None:
        if row["user_id"] != user or row["appareil"] != device:
            raise HTTPException(404, "Demande introuvable")
        if body.get("coupe") or body.get("plus_tard"):
            pass  # l'accès est coupé, ou le réseau a lâché : le fichier attend encore, et repart plus tard
        else:
            _forget_pending(rid)
            if not body.get("ok") and future is None:  # plus personne n'attend : la personne seule peut l'apprendre
                reason = body.get("message") or body.get("erreur") or "refusé"
                notify_user(user, "Fichier non livré", f"« {_short(row['chemin'])} » n'a pas été enregistré : {str(reason)[:200]}", url="/")
    elif future is None or owner != user or target != device:
        raise HTTPException(404, "Demande introuvable")
    if future is not None and owner == user and target == device and not future.done():
        future.set_result(body)
    return {"ok": True}


@router.get("/api/desktop/status")
async def status(user: int = Depends(auth.current_user)):
    mine = [s for d, s in _seen.items() if s.get("user") == user and _online(d)]
    return {"connecte": bool(mine), "systeme": mine[0].get("os", "") if mine else ""}


# --- Ce que l'agent et l'interface savent des appareils -----------------------------------------------------------------

def decorate(user: int, devices: list[dict]) -> list[dict]:
    """Ajoute à la liste des appareils ce qui change d'une minute à l'autre : en ligne ou non, dossiers, fichiers en attente."""
    from . import push as notifications_push

    push = {auth.device_id(s) for s in notifications_push.subscribed_sessions(user)}
    with db.connect() as c:
        rows = c.execute("SELECT appareil, COUNT(*) AS n FROM desktop_attente WHERE user_id = ? GROUP BY appareil", (user,)).fetchall()
    pending = {r["appareil"]: r["n"] for r in rows}
    now = datetime.now(timezone.utc)
    out = []
    for d in devices:
        seen = _seen.get(d["id"], {})
        recent = bool(d.get("vu")) and now - datetime.fromisoformat(d["vu"]) < auth.SEEN_EVERY * 2
        out.append({**d, "en_ligne": _online(d["id"]) if d["type"] == "desktop" or seen else recent,
                    "notifiable": _online(d["id"]) or d["id"] in push,
                    "dossiers": seen.get("dossiers", []), "coupe": bool(seen.get("coupe")), "attente": pending.get(d["id"], 0)})
    return out


@router.get("/agent-api/appareils")
async def agent_devices(request: Request):
    agent_id = relay._agent_from(request)
    if closed := _gatekept(agent_id):
        return closed
    owner = access.owner_of(agent_id)
    await _settled(owner)
    keep = ("id", "nom", "type", "en_ligne", "notifiable", "dossiers", "coupe", "attente")
    return {"appareils": [{k: d[k] for k in keep} for d in decorate(owner, auth.devices(owner, None))]}


@router.post("/agent-api/notifier")
async def agent_notify(body: AgentNotice, request: Request):
    """Vers un seul appareil, ou tous sans précision. Une notification partie ne dit pas qu'elle a été vue."""
    from . import push

    agent_id = relay._agent_from(request)
    if closed := _gatekept(agent_id):
        return closed
    owner = access.owner_of(agent_id)
    if not body.appareil.strip():
        notify_user(owner, body.titre, body.texte)
        return {"ok": True, "cible": "tous ses appareils"}
    asked = body.appareil.strip()
    known = auth.devices(owner, None)
    found = [d for d in known if d["id"] == asked or (d["nom"] or "").lower() == asked.lower()]
    if len(found) != 1:
        return {"erreur": ("Plusieurs appareils portent ce nom : " if found else "Aucun appareil de ce nom. Appareils de ce compte : ") + _names(found or known) + "."}
    device = found[0]
    if _online(device["id"]):
        send_native(owner, body.titre, body.texte, device["id"])
        return {"ok": True, "cible": device["nom"]}
    session = auth.session_of_device(owner, device["id"])
    sent = await push.send(body.titre, body.texte, user_id=owner, session=session) if session else {}
    if sent.get("livres") or sent.get("differes"):
        return {"ok": True, "cible": device["nom"]}
    return {"erreur": f"{device['nom'] or 'Cet appareil'} ne peut pas recevoir de notification : elles n'y sont pas activées, ou son application est fermée."}


def send_native(user: int, title: str, text: str, device: str | None = None) -> None:
    """Notification native sur les ordinateurs de ce compte où l'application est ouverte (ou sur l'un d'eux). Personne n'attend la réponse."""
    for target in [device] if device else [d for d, s in _seen.items() if s.get("user") == user and _online(d)]:
        rid = uuid.uuid4().hex
        _waiting[rid] = (asyncio.get_running_loop().create_future(), target, user)
        _queue(target).put_nowait({"id": rid, "agent": "Noah", "action": "notifier", "cible": "", "titre": title, "texte": text, "dossier": ""})
        asyncio.get_running_loop().call_later(120, lambda r=rid: _waiting.pop(r, None))


def notify_user(user: int, title: str, text: str, kind: str | None = None, url: str = "/", urgent: bool = False) -> None:
    """Sur tous les appareils de ce compte, si ce type n'est pas coupé. Personne n'attend la réponse."""
    from . import push

    if kind and not notifications.wants(user, kind):
        return
    push.notify(title, text, url=url, urgent=urgent, user_id=user, kind=kind)
    send_native(user, title, text)


def notify(title: str, text: str, agent_id: str | None = None, kind: str | None = None, url: str = "/") -> None:
    """Notification sur l'ordinateur si l'application de bureau est ouverte, et sur les appareils abonnés aux
    notifications (téléphone, navigateur) ; personne n'attend la réponse. Pour un agent : son propriétaire, et le profil
    partagé qui a lancé la tâche. Sans agent : le propriétaire de l'installation."""
    for user in access.recipients(agent_id) if agent_id else [db.owner_id()]:
        if user is not None:
            notify_user(user, title, text, kind, url)
