"""Recherche (0.4.2) : un mot, et ce que les agents de ce compte en savent, groupé par agent. Messages et tâches se lisent dans la base ;
les fichiers, dans l'espace de travail de l'agent (son lanceur), en parallèle et sans jamais retenir le reste si l'un d'eux ne répond pas.

`GET /api/recherche?q=…&agents=a,b` : `agents` limite la recherche (sans lui : tous ceux que ce compte peut lire). Rend seulement les agents
qui ont quelque chose, chacun avec `messages`, `taches` et `fichiers` (au plus 5, 5 et 8 lignes) et le nombre total trouvé.
Ce que la personne n'a pas le droit de lire n'y est jamais : ses propres fils et ceux qu'on lui a rendus visibles, ses tâches, et les
fichiers des agents qu'elle peut utiliser. Une clé collée dans un ancien message sort masquée, comme dans le fil."""
import asyncio
import re

from fastapi import APIRouter, Depends

from . import access, auth, db, hermes, nettoyage, taches

router = APIRouter()

MIN_LETTRES = 2
PAR_AGENT = {"messages": 5, "taches": 5, "fichiers": 8}
ATTENTE_FICHIERS = 4.0  # secondes par agent : une machine arrêtée ou lente ne bloque pas la recherche


def _like(mot: str) -> str:
    return "%" + mot.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _extrait(texte: str, mot: str, large: int = 70) -> str:
    """Quelques mots autour de la première occurrence, sur une ligne."""
    ligne = re.sub(r"\s+", " ", re.sub(r"[*_`#>]", "", texte)).strip()
    i = ligne.lower().find(mot.lower())
    if i < 0:
        return ligne[: large * 2]
    debut, fin = max(0, i - large), min(len(ligne), i + len(mot) + large)
    return ("… " if debut else "") + ligne[debut:fin] + (" …" if fin < len(ligne) else "")


async def _fichiers(agent_id: str, mot: str) -> list[dict]:
    try:
        liste = await asyncio.wait_for(hermes.list_files(agent_id), ATTENTE_FICHIERS)
    except Exception:  # noqa: BLE001 - machine arrêtée, lanceur absent, trop lent : cet agent n'a pas de fichiers à montrer
        return []
    mot = mot.lower()
    trouves = [f for f in (liste if isinstance(liste, list) else []) if isinstance(f, dict) and mot in str(f.get("path", "")).lower()]
    trouves.sort(key=lambda f: -(f.get("modified") or 0))
    return [{"path": f["path"], "size": f.get("size"), "modified": f.get("modified")} for f in trouves]


@router.get("/api/recherche")
async def recherche(q: str = "", agents: str = "", user: int = Depends(auth.current_user)):
    from . import main  # à la demande : main importe ce module

    mot = q.strip()[:100]
    if len(mot) < MIN_LETTRES:
        return {"q": mot, "total": 0, "agents": []}
    visibles, *_ = main._agents_listing(user)
    voulus = {a for a in agents.split(",") if a}
    cibles = [a for a in visibles if not voulus or a["id"] in voulus]
    ids = [a["id"] for a in cibles]
    if not ids:
        return {"q": mot, "total": 0, "agents": []}
    marques = ",".join("?" * len(ids))
    like = _like(mot)
    messages: dict[str, list[dict]] = {i: [] for i in ids}
    ses_taches: dict[str, list[dict]] = {i: [] for i in ids}
    compte = {i: 0 for i in ids}
    with db.connect() as c:
        for r in c.execute(
            f"SELECT m.id, m.role, m.text, m.created_at, v.id AS conv, v.agent_id, v.main, v.user_id AS auteur FROM messages m JOIN conversations v ON v.id = m.conversation_id "
            f"WHERE v.agent_id IN ({marques}) AND (v.user_id = ? OR v.shared = 1) AND m.role IN ('user', 'agent') AND m.text LIKE ? ESCAPE '\\' "
            "ORDER BY m.id DESC LIMIT 400", (*ids, user, like)):
            vu = nettoyage.message_lu({"role": r["role"], "text": r["text"]})
            if not vu or mot.lower() not in (vu["text"] or "").lower():  # un `[SILENT]`, ou une clé masquée qui était le mot cherché
                continue
            compte[r["agent_id"]] += 1
            if len(messages[r["agent_id"]]) < PAR_AGENT["messages"]:
                messages[r["agent_id"]].append({"id": r["id"], "conversation_id": r["conv"], "principale": bool(r["main"]) and r["auteur"] == user, "role": r["role"], "texte": _extrait(vu["text"], mot), "date": r["created_at"]})
        for r in c.execute(
            f"SELECT t.id, t.titre, t.etat, t.conversation_id, t.agent_id FROM taches t WHERE t.owner_id = ? AND t.agent_id IN ({marques}) "
            f"AND (t.titre LIKE ? ESCAPE '\\' OR t.resume LIKE ? ESCAPE '\\') AND {taches.SAUF_VIDES} ORDER BY t.maj DESC, t.cree DESC LIMIT 200",
                (user, *ids, like, like)):
            compte[r["agent_id"]] += 1
            if len(ses_taches[r["agent_id"]]) < PAR_AGENT["taches"]:
                ses_taches[r["agent_id"]].append({"id": r["id"], "titre": r["titre"], "etat": r["etat"], "conversation_id": r["conversation_id"]})
    lisibles = [a for a in cibles if access.allowed(user, a["id"], "usage")]
    lus = await asyncio.gather(*(_fichiers(a["id"], mot) for a in lisibles))
    fichiers = {a["id"]: f for a, f in zip(lisibles, lus)}
    sortie = []
    for a in cibles:
        f = fichiers.get(a["id"], [])
        if not (messages[a["id"]] or ses_taches[a["id"]] or f):
            continue
        sortie.append({"id": a["id"], "nom": a["name"], "messages": messages[a["id"]], "taches": ses_taches[a["id"]], "fichiers": f[: PAR_AGENT["fichiers"]],
                       "total": compte[a["id"]] + len(f)})
    return {"q": mot, "total": sum(s["total"] for s in sortie), "agents": sortie}
