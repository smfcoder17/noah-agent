"""Citer avec @ (un agent, un fichier, un dossier) et appeler une compétence avec / : les suggestions de la saisie, et ce que l'agent en reçoit.

Les suggestions sont trois routes en lecture, réservées à qui peut parler à l'agent du fil (droit « usage ») :
- agents : ceux que ce compte voit (les mêmes règles que la barre de gauche), sans l'agent du fil ;
- fichiers : l'espace de travail de l'agent du fil, lu une fois et gardé quelques secondes (un `find` dans son conteneur coûte plus que
  les 100 ms de la frappe) ; les dossiers se déduisent des chemins. Rien ne touche au disque à partir d'un chemin reçu : on ne filtre
  que la liste que le lanceur a rendue, qui ne contient ni lien symbolique ni fichier caché ;
- compétences : les skills de l'agent, lus par le lanceur et gardés comme le reste de sa machine (machine.lire).

Une pastille de la saisie part dans le message sous la forme d'un lien markdown `[@nom](noah:type/référence)`. Le fil la relit pour la
redessiner ; l'agent reçoit, devant le message et sans que la personne le voie, ce que chaque pastille lui demande (`contexte`).
Un agent cité qui n'est pas visible par ce compte n'entre jamais dans ce contexte.
"""
import asyncio
import re
import time
import unicodedata
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException

from . import access, auth, hermes, machine

router = APIRouter()

WORKSPACE = "/opt/data/workspace/"
FILES_FRESH = 20  # secondes pendant lesquelles la liste des fichiers est servie telle quelle
FILES_STALE = 300  # au-delà de FILES_FRESH : servie quand même, et relue en fond ; au-delà de celui-ci : on attend la relecture
_files: dict[str, tuple[float, list[dict]]] = {}
_reading: dict[str, asyncio.Task] = {}

SKILL_PART = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def forget_files(agent_id: str) -> None:
    """Un fichier vient de bouger : la prochaine liste sera relue."""
    _files.pop(agent_id, None)


def plain(text: str) -> str:
    """Sans accent ni majuscule : « Équipe » se trouve en tapant « equ »."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold()


def _score(name: str, query: str) -> int | None:
    """0 : le nom commence par la recherche ; 1 : un de ses mots ; 2 : elle s'y trouve ; None : rien."""
    if not query:
        return 0
    hay, need = plain(name), plain(query)
    if hay.startswith(need):
        return 0
    if re.search(r"[\s._/-]" + re.escape(need), hay):
        return 1
    return 2 if need in hay else None


def _clean_folder(folder: str) -> str:
    """Un dossier relatif à l'espace de travail, sans détour. Ce qui n'en est pas un est refusé : le chemin ne sert qu'à filtrer, mais personne ne doit croire le contraire."""
    folder = folder.strip().strip("/")
    parts = folder.split("/") if folder else []
    if len(folder) > 1024 or "\x00" in folder or "\\" in folder or any(p in ("", ".", "..") for p in parts):
        raise HTTPException(400, "Chemin hors de l'espace de travail")
    return folder


async def _read_files(agent_id: str) -> list[dict]:
    rows = await hermes.list_files(agent_id)
    kept = [r for r in rows if isinstance(r.get("path"), str) and not any(p.startswith(".") for p in r["path"].split("/"))]
    _files[agent_id] = (time.monotonic(), kept)
    return kept


def _sans_bruit(task: asyncio.Future) -> None:
    task.cancelled() or task.exception()


async def files_of(agent_id: str) -> list[dict]:
    """Les fichiers de l'espace de travail, du plus récent au plus ancien. Une lecture à la fois par agent."""
    known = _files.get(agent_id)
    age = time.monotonic() - known[0] if known else None
    if known and age is not None and age < FILES_STALE:
        if age >= FILES_FRESH and agent_id not in _reading:
            task = asyncio.ensure_future(_read_files(agent_id))
            _reading[agent_id] = task
            task.add_done_callback(lambda t, a=agent_id: (_reading.pop(a, None), _sans_bruit(t)))
        return known[1]
    task = _reading.get(agent_id)
    if task is None:
        task = asyncio.ensure_future(_read_files(agent_id))
        _reading[agent_id] = task
        task.add_done_callback(lambda t, a=agent_id: (_reading.pop(a, None), _sans_bruit(t)))
    return await asyncio.shield(task)


def _folders(files: list[dict]) -> dict[str, dict]:
    """Les dossiers qui contiennent des fichiers, avec le plus récent d'entre eux et leur nombre."""
    out: dict[str, dict] = {}
    for f in files:
        parts = f["path"].split("/")[:-1]
        for i in range(1, len(parts) + 1):
            path = "/".join(parts[:i])
            seen = out.setdefault(path, {"modifie": 0.0, "fichiers": 0})
            seen["modifie"] = max(seen["modifie"], f["modified"])
            seen["fichiers"] += 1
    return out


def suggest_files(files: list[dict], folder: str, query: str, limit: int) -> dict:
    """Dans `folder` seulement, ce qui s'appelle comme `query` ; sans dossier, partout si l'on cherche, les plus récents si l'on ne tape rien."""
    folders = _folders(files)
    found_files, found_folders = [], []
    for f in files:
        parent, _, name = f["path"].rpartition("/")
        if folder and not (parent == folder or (query and parent.startswith(folder + "/"))):
            continue  # dans un dossier : ses enfants ; en y cherchant, tout ce qu'il contient
        score = _score(name, query)
        if score is not None:
            found_files.append((score, -f["modified"], {"type": "fichier", "chemin": f["path"], "nom": name, "dossier": parent, "modifie": f["modified"], "taille": f.get("size", 0)}))
    for path, info in folders.items():
        parent, _, name = path.rpartition("/")
        if folder and not (parent == folder or (query and parent.startswith(folder + "/"))):
            continue
        if not folder and not query and parent:
            continue  # sans recherche, les dossiers du premier niveau : on descend ensuite
        score = _score(name, query)
        if score is not None:
            found_folders.append((score, -info["modifie"], {"type": "dossier", "chemin": path, "nom": name, "dossier": parent, "modifie": info["modifie"], "fichiers": info["fichiers"]}))
    found_files.sort(key=lambda x: x[:2])
    found_folders.sort(key=lambda x: x[:2])
    return {"fichiers": [x[2] for x in found_files[:limit]], "dossiers": [x[2] for x in found_folders[:limit]]}


def _usable(user: int, agent_id: str) -> None:
    access.access(user, agent_id, "usage")


@router.get("/api/agents/{agent_id}/mentions/agents")
async def mention_agents(agent_id: str, q: str = "", user: int = Depends(auth.current_user)):
    """Les agents que ce compte peut citer : ceux qu'il voit, sauf celui du fil."""
    _usable(user, agent_id)
    from . import main  # à la demande : main nous charge
    agents = main._agents_listing(user)[0]
    out = []
    for a in agents:
        if a["id"] == agent_id:
            continue
        score = _score(a["name"], q)
        if score is None and q:
            score = 3 if plain(q) in plain(a["role"] or "") else None
        if score is None:
            continue
        out.append((score, len(out), {"id": a["id"], "nom": a["name"], "role": (a["role"] or "")[:160], "color": a["color"] or "", "shape": a["shape"] or "", "detail": a["detail"] or ""}))
    out.sort(key=lambda x: x[:2])
    return {"agents": [x[2] for x in out[:12]]}


@router.get("/api/agents/{agent_id}/mentions/fichiers")
async def mention_files(agent_id: str, q: str = "", dossier: str = "", limite: int = 8, user: int = Depends(auth.current_user)):
    """Les fichiers et dossiers de l'espace de travail de l'agent du fil, les plus récents d'abord."""
    _usable(user, agent_id)
    folder = _clean_folder(dossier)
    limit = max(1, min(limite, 50))
    try:
        files = await files_of(agent_id)
    except Exception:  # agent arrêté : la liste est vide, la saisie continue de marcher
        return {"fichiers": [], "dossiers": [], "indisponible": True}
    return suggest_files(files, folder, q.strip(), limit)


@router.get("/api/agents/{agent_id}/mentions/competences")
async def mention_skills(agent_id: str, q: str = "", user: int = Depends(auth.current_user)):
    """Les compétences de l'agent du fil : nom lisible et une ligne. Les désactivées sont dites telles, pas retirées : la personne se demande sinon où est passée celle qu'elle connaît."""
    _usable(user, agent_id)
    try:
        skills = (await machine.lire(agent_id, "skills_resume")).get("skills") or []
    except Exception:  # noqa: BLE001
        return {"competences": [], "indisponible": True}
    out = []
    for s in skills:
        score = min((x for x in (_score(s.get("titre") or "", q), _score(s.get("nom") or "", q)) if x is not None), default=None)
        if score is None and q:
            score = 3 if plain(q) in plain(s.get("resume") or "") else None
        if score is None:
            continue
        out.append((bool(s.get("desactivee")), score, len(out), {
            "nom": s["nom"], "titre": s.get("titre") or s["nom"], "resume": (s.get("resume") or "")[:200],
            "origine": s.get("origine") or "", "desactivee": bool(s.get("desactivee"))}))
    out.sort(key=lambda x: x[:3])
    return {"competences": [x[3] for x in out[:40]], "total": len(skills)}


# --- Ce qui part dans le message, et ce que l'agent en lit -----------------------------------------------------------

TOKEN = re.compile(r"\[([@/])([^\]\n]{1,200})\]\(noah:(agent|fichier|dossier|competence)/([^)\s]{1,600})\)")


def lisible(text: str) -> str:
    """Le message tel qu'on le dirait à voix haute : chaque pastille redevient « @nom » ou « /nom ». Pour les titres et les aperçus."""
    return TOKEN.sub(lambda m: m.group(1) + m.group(2), text)


def _workspace_ref(ref: str) -> str | None:
    """Le chemin de l'espace de travail pour une référence de pastille, ou None si elle sort du dossier ou n'est pas un chemin."""
    path = unquote(ref).strip("/")
    parts = path.split("/") if path else []
    if not parts or len(path) > 1024 or "\x00" in path or "\\" in path or any(p in ("", ".", "..") for p in parts):
        return None
    return WORKSPACE + path


def _skill_leaf(ref: str) -> str | None:
    parts = unquote(ref).strip("/").split("/")
    return parts[-1] if parts and all(SKILL_PART.fullmatch(p) for p in parts) else None


def _skill_off(agent_id: str, leaf: str) -> bool:
    """Vrai si la dernière lecture de ses compétences dit celle-ci désactivée. Rien n'est demandé au lanceur : sans lecture, on fait confiance."""
    known = machine._lus.get((agent_id, "skills_resume"))
    return bool(known and any(s.get("desactivee") and (s.get("nom") or "").rsplit("/", 1)[-1] == leaf for s in known[1].get("skills") or []))


def contexte(user: int | None, agent_id: str, text: str) -> str:
    """Devant le message, pour l'agent seulement : ce que la personne lui demande par ses pastilles. Vide sans pastille."""
    lines: list[str] = []
    seen: set[tuple[str, str]] = set()
    guest = user is not None and access.separated(user, agent_id)
    from . import coordination  # à la demande : le nom d'un agent vient de la base, pas de ce que le message dit
    for found in TOKEN.finditer(text):
        kind, ref = found.group(3), found.group(4)
        if (kind, ref) in seen or len(seen) >= 20:
            continue
        seen.add((kind, ref))
        if kind in ("fichier", "dossier"):
            path = _workspace_ref(ref)
            if not path:
                continue
            if kind == "fichier":
                lines.append(f"- Fichier : {path} (dans ton dossier de travail). Lis-le avant de répondre : c'est de lui que la personne parle.")
            else:
                lines.append(f"- Dossier : {path}/ (dans ton dossier de travail). Regarde ce qu'il contient avec ls et sers-t'en : c'est de lui que la personne parle.")
        elif kind == "agent":
            other = unquote(ref)
            if other == agent_id or user is None or access.right(user, other) is None:
                continue  # un agent que ce compte ne voit pas n'entre pas dans ce que l'agent lit
            name = coordination._name(other)
            if guest:
                lines.append(f"- Agent « {name} » (id {other}) : la personne le cite, pour information. Tu ne peux rien lui confier depuis une conversation partagée : dis-le si elle le demande.")
            else:
                lines.append(f"- Agent « {name} » (id {other}) : un collègue que la personne cite. Si elle veut lui confier une tâche ou lui demander quelque chose, "
                             f"`python3 /opt/data/noah.py demander {other} \"consigne complète et autonome\"` (voir « Travailler avec les autres agents ») : la commande rend tout de suite, "
                             "termine ton tour, sa réponse te relance dans cette conversation. Sinon, ne le dérange pas.")
        else:
            leaf = _skill_leaf(ref)
            if not leaf:
                continue
            if _skill_off(agent_id, leaf):
                lines.append(f"- Compétence « {leaf} » : elle est désactivée pour toi. Ne l'utilise pas ; dis à la personne qu'elle est désactivée.")
            else:
                lines.append(f"- Compétence « {leaf} » : pour ce message, charge-la d'abord avec l'outil skill_view (name=\"{leaf}\"), puis suis ses instructions à la lettre. Elle prime sur tes habitudes.")
    if not lines:
        return ""
    return "[Dans son message, la personne a cité avec @ ou / (les liens « noah: » du texte). Ce que ça te demande :\n" + "\n".join(lines) + "]\n\n"
