"""Les questions d'un agent pendant un travail (0.4.0, X4, X35, X36).

Une question monte d'un cran à la fois : l'agent qui a confié la tâche, puis le chef d'équipe (le premier agent créé), puis la
personne (`a = ''`). Chaque cran est écrit dans `chemin`. Un sujet réservé (payer, supprimer pour toujours, secrets et droits,
première publication) va directement à la personne. Un échange qui tourne en rond saute les agents. La réponse d'un agent est
une « décision prise pour toi » ; la personne la corrige, et sa correction devient une règle qui répond ensuite à sa place.
"""
import asyncio
import json
import re
import time
import unicodedata
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, bus, db, desktop, relay

router = APIRouter()

TOURS_MAX = 3  # questions presque identiques entre les mêmes agents avant de monter à la personne
BOUCLE_FENETRE = 3600  # secondes : au-delà, deux questions semblables ne comptent plus comme un échange qui tourne en rond
DELAI_AGENT = 600  # un agent qui ne répond pas dans ce délai : la question monte d'un cran
EXPIRE = 48 * 3600  # une question que personne n'a tranchée
AGENT_WAIT = 150  # l'outil de l'agent attend la réponse jusqu'là, puis il rend la main
LIVRAISON_ATTENTE = 900
RESERVES = ("payer", "supprimer", "secrets", "publier")
_hooks: dict = {}
_events: dict[str, asyncio.Event] = {}
_background: set = set()


def _norm(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9$€ ]", " ", plain)).strip()


def _mots(text: str) -> set[str]:
    return {m for m in _norm(text).split() if len(m) > 2}


def proche(a: str, b: str) -> bool:
    """Deux questions qui disent la même chose : mêmes mots, à peu près."""
    x, y = _mots(a), _mots(b)
    if not x or not y:
        return _norm(a) == _norm(b)
    return len(x & y) / len(x | y) >= 0.6


_RESERVE_MOTS = {
    "payer": re.compile(r"\b(pay\w*|paie\w*|achet\w*|achat\w*|virement\w*|rembours\w*|carte bancaire|abonnement\w*|souscri\w*|euros?|dollars?)\b|[€$]"),
    "supprimer": re.compile(r"\b(suppr\w*|effac\w*|detrui\w*|delete\w*|purg\w*)\b.*\b(definitiv\w*|irreversib\w*|pour toujours|sans retour)\b"
                            r"|\b(definitiv\w*|irreversib\w*|pour toujours)\b.*\b(suppr\w*|effac\w*|detrui\w*|delete\w*)\b"),
    "secrets": re.compile(r"\b(mot de passe|mots de passe|password|cle d api|cles d api|api key|secret\w*|jeton\w*|token\w*|identifiant\w* de connexion"
                          r"|droits?|permissions?|acces admin\w*|admin\w*|partager l acces)\b"),
    "publier": re.compile(r"\b(publi\w*|poster|post |tweet\w*|diffus\w*)\b.*\b(compte|reseau\w*|instagram|facebook|linkedin|tiktok|youtube|twitter|x)\b"),
}


def sujet_reserve(texte: str, force: str = "") -> str:
    """Le sujet réservé que touche cette question, ou ''. Un mot-clé du texte, ou le sujet que l'agent nomme lui-même."""
    if force in RESERVES:
        return force
    plain = _norm(texte)
    for sujet in RESERVES:
        if _RESERVE_MOTS[sujet].search(plain):
            return sujet
    return ""


def _now() -> float:
    return time.time()


def _nom(agent_id: str) -> str:
    if not agent_id:
        return "Toi"
    with db.connect() as c:
        row = c.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
    return row["name"] if row else agent_id


def _chef(owner: int) -> str:
    """Le chef d'équipe : le premier agent créé de ce compte."""
    with db.connect() as c:
        row = c.execute("SELECT id FROM agents WHERE owner_id = ? ORDER BY created_at, rowid LIMIT 1", (owner,)).fetchone()
        if not row:
            row = c.execute("SELECT id FROM agents ORDER BY created_at, rowid LIMIT 1").fetchone()
    return row["id"] if row else ""


def _existe(agent_id: str) -> bool:
    with db.connect() as c:
        return bool(agent_id) and bool(c.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone())


def _niveaux(q: dict) -> list[str]:
    """Qui peut répondre avant la personne, dans l'ordre : l'agent qui a confié la tâche, puis le chef d'équipe.
    Une tâche venue de la personne, ou une question sans tâche, n'a pas d'agent au-dessus : la personne répond."""
    if not q.get("tache_id"):
        return []
    with db.connect() as c:
        t = c.execute("SELECT genre, demandeur FROM taches WHERE id = ?", (q["tache_id"],)).fetchone()
    out: list[str] = []
    if t and t["genre"] == "demande" and _existe(t["demandeur"]) and t["demandeur"] != q["de"]:
        out.append(t["demandeur"])
    chef = _chef(q["owner_id"])
    if chef and chef != q["de"] and chef not in out:
        out.append(chef)
    return out


def _ligne(row) -> dict:
    d = dict(row)
    d["choix"] = json.loads(d["choix"] or "[]")
    d["chemin"] = json.loads(d["chemin"] or "[]")
    return d


def get(qid: str) -> dict | None:
    with db.connect() as c:
        row = c.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
    return _ligne(row) if row else None


def en_attente_conv(conv_id: str) -> bool:
    """Une question posée depuis cette conversation attend encore sa réponse."""
    with db.connect() as c:
        return bool(c.execute("SELECT 1 FROM questions WHERE conversation_id = ? AND genre = 'question' AND etat = 'attend'", (conv_id,)).fetchone())


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


# --- Règles ------------------------------------------------------------------------------------------------------------------

def regle_pour(owner: int, agent_id: str, titre: str) -> dict | None:
    with db.connect() as c:
        rows = c.execute("SELECT * FROM regles WHERE owner_id = ? AND etat = 'active' AND (agent_id IS NULL OR agent_id = '' OR agent_id = ?) "
                         "ORDER BY cree DESC", (owner, agent_id)).fetchall()
    for r in rows:
        if proche(r["sujet"], titre):
            return dict(r)
    return None


# --- Poser -------------------------------------------------------------------------------------------------------------------

def _contexte(agent_id: str) -> tuple[str, int | None, str | None]:
    """(conversation, compte, tâche) d'où l'agent pose sa question : la tâche qu'il mène, sinon sa conversation principale."""
    from . import main
    conv = relay._task_of(agent_id) or main._main_conversation(agent_id)
    if not conv:
        raise HTTPException(409, "Pas de conversation pour poser cette question.")
    with db.connect() as c:
        row = c.execute("SELECT user_id FROM conversations WHERE id = ?", (conv,)).fetchone()
        t = c.execute("SELECT id FROM taches WHERE conversation_id = ?", (conv,)).fetchone()
    return conv, (row["user_id"] if row else access.owner_of(agent_id)), (t["id"] if t else None)


def _en_boucle(q: dict, vers: str) -> bool:
    """Les mêmes agents se renvoient la même question : après TOURS_MAX tours, elle ne passe plus par eux."""
    since = _now() - BOUCLE_FENETRE
    with db.connect() as c:
        rows = c.execute("SELECT titre, de, a FROM questions WHERE owner_id = ? AND genre = 'question' AND cree > ? AND id != ?",
                         (q["owner_id"], since, q["id"])).fetchall()
    ids = {q["de"], vers}
    n = sum(1 for r in rows if proche(r["titre"], q["titre"]) and (r["de"] in ids or r["a"] in ids))
    return n >= TOURS_MAX


def poser(agent_id: str, titre: str, pourquoi: str = "", choix: list[str] | None = None, libre: bool = True, sujet: str = "") -> dict:
    conv, owner, tache = _contexte(agent_id)
    reserve = sujet_reserve(f"{titre} {pourquoi}", sujet)
    qid = uuid.uuid4().hex[:12]
    now = _now()
    q = {"id": qid, "owner_id": owner, "tache_id": tache, "conversation_id": conv, "de": agent_id, "titre": titre.strip(), "pourquoi": pourquoi.strip()}
    a, note = "", ""
    if not reserve:
        regle = regle_pour(owner, agent_id, titre)
        if regle:
            with db.connect() as c:
                c.execute("INSERT INTO questions (id, owner_id, tache_id, conversation_id, de, a, genre, titre, pourquoi, choix, libre, reserve, chemin, etat, "
                          "reponse, repondu_par, repondu_a, regle_id, cree, maj) VALUES (?,?,?,?,?,?, 'question', ?,?,?,?, '', ?, 'repondue', ?,?,?,?,?,?)",
                          (qid, owner, tache, conv, agent_id, "", q["titre"], q["pourquoi"], json.dumps(choix or []), int(libre), json.dumps([agent_id]),
                           regle["texte"], f"regle:{regle['id']}", now, regle["id"], now, now))
                c.execute("UPDATE regles SET servie = servie + 1, servie_a = ? WHERE id = ?", (now, regle["id"]))
            bus.invalidate(owner)
            return {"id": qid, "etat": "repondue", "reponse": regle["texte"], "par": "règle retenue"}
        niveaux = _niveaux(q)
        for vers in niveaux:
            if _en_boucle(q, vers):
                note = " Cet échange tourne en rond : il monte à la personne."
                break
            a = vers
            break
    with db.connect() as c:
        c.execute("INSERT INTO questions (id, owner_id, tache_id, conversation_id, de, a, genre, titre, pourquoi, choix, libre, reserve, chemin, etat, cree, maj) "
                  "VALUES (?,?,?,?,?,?, 'question', ?,?,?,?,?,?, 'attend', ?,?)",
                  (qid, owner, tache, conv, agent_id, a, q["titre"], (q["pourquoi"] + note).strip(), json.dumps(choix or []), int(libre), reserve,
                   json.dumps([agent_id] + ([a] if a else [])), now, now))
    _events[qid] = asyncio.Event()
    _router_vers(qid)
    return {"id": qid, "etat": "attend", "a": _nom(a) if a else "la personne", "reserve": reserve}


def _router_vers(qid: str) -> None:
    q = get(qid)
    if not q or q["etat"] != "attend":
        return
    if q["a"]:
        _spawn(_reveiller(qid))
        _spawn(_surveiller(qid, q["a"]))
    else:
        _arrivee_personne(q)


def _arrivee_personne(q: dict) -> None:
    from . import main
    main.task_state[q["conversation_id"]] = "approve"
    bus.invalidate(q["owner_id"])
    qui = _nom(q["de"])
    try:
        desktop.notify_user(q["owner_id"], f"{qui} te demande", q["titre"][:200], "accord", "/")
    except Exception:  # noqa: BLE001 - la notification ne doit jamais empêcher la question d'arriver
        pass


async def _reveiller(qid: str) -> None:
    """Relance l'agent qui doit répondre, dans sa conversation principale, avec ce qu'il lui faut pour décider."""
    from . import main
    q = get(qid)
    if not q or q["etat"] != "attend" or not q["a"]:
        return
    cible = q["a"]
    conv = main._main_conversation(cible, q["owner_id"]) or main._main_conversation(cible)
    if not conv:
        monter(qid, cible, "")
        return
    demande = ""
    if q["tache_id"]:
        with db.connect() as c:
            t = c.execute("SELECT titre, consigne FROM taches WHERE id = ?", (q["tache_id"],)).fetchone()
        if t:
            demande = f"Tâche « {t['titre']} ». Demande d'origine : {(t['consigne'] or '')[:600]}\n"
    options = f"Choix proposés : {' / '.join(q['choix'])}\n" if q["choix"] else ""
    note = (f"[Question de {_nom(q['de'])} pour toi (n° {qid}). {demande}Question : {q['titre']}\n"
            f"{('Pourquoi : ' + q['pourquoi'] + chr(10)) if q['pourquoi'] else ''}{options}"
            f"Si la réponse est dans la demande ou dans ce que tu sais déjà, réponds avec `noah.py repondre {qid} \"ta réponse\"`. "
            f"Si tu ne sais pas, ou si cela engage de l'argent, des accès ou une suppression : `noah.py remonter {qid} \"ce que tu sais\"`. "
            "Ne fais rien d'autre pour cette question : pas de tâche, pas de message à la personne.]\n\n")
    texte = f"Question de {_nom(q['de'])} : {q['titre']}"
    deadline = time.monotonic() + LIVRAISON_ATTENTE
    from . import coordination
    while coordination._busy(cible, conv) and time.monotonic() < deadline:
        await asyncio.sleep(coordination.FREE_POLL)
    q = get(qid)
    if not q or q["etat"] != "attend" or q["a"] != cible:
        return
    try:
        await _relancer(cible, conv, texte, note, "agent")
    except Exception:  # noqa: BLE001 - agent arrêté : la question monte, la personne n'attend pas pour rien
        monter(qid, cible, "")


async def _surveiller(qid: str, cible: str) -> None:
    await asyncio.sleep(DELAI_AGENT)
    q = get(qid)
    if q and q["etat"] == "attend" and q["a"] == cible:
        monter(qid, cible, "")


async def _relancer(agent_id: str, conv: str, texte: str, note: str, author: str) -> None:
    """Fait repartir l'agent dans cette conversation avec ce texte, sans l'ouvrir à l'écran."""
    from . import main, machine, notifications
    stream = await main._run(main._agent(agent_id), conv, texte, context=machine.pop_context(conv) + note, author=author, live=False,
                             tell_after=0 if author == "agent" else notifications.TELL_AFTER)

    async def drain():
        async for _ in stream:
            pass

    _spawn(drain())


# --- Répondre, monter --------------------------------------------------------------------------------------------------------

def monter(qid: str, par: str, savoir: str = "") -> dict:
    """L'agent ne sait pas : la question passe au cran suivant, ou à la personne."""
    q = get(qid)
    if not q or q["etat"] != "attend":
        raise HTTPException(404, "Question introuvable ou déjà réglée.")
    if q["a"] != par:
        raise HTTPException(403, "Cette question n'est pas à toi.")
    niveaux = _niveaux(q)
    suite = ""
    if not q["reserve"] and q["a"] in niveaux:
        autres = niveaux[niveaux.index(q["a"]) + 1:]
        suite = autres[0] if autres and not _en_boucle(q, autres[0]) else ""
    pourquoi = q["pourquoi"] + (f"\n{_nom(par)} : {savoir.strip()}" if savoir.strip() else "")
    chemin = q["chemin"] + ([suite] if suite else [])
    with db.connect() as c:
        c.execute("UPDATE questions SET a = ?, chemin = ?, pourquoi = ?, maj = ? WHERE id = ?", (suite, json.dumps(chemin), pourquoi, _now(), qid))
    _router_vers(qid)
    return {"id": qid, "a": _nom(suite) if suite else "la personne"}


def repondre(qid: str, par: str, texte: str) -> dict:
    """`par` : un id d'agent (décision prise pour la personne) ou 'personne'."""
    texte = (texte or "").strip()
    if not texte:
        raise HTTPException(400, "Une réponse vide ne règle rien.")
    q = get(qid)
    if not q or q["etat"] != "attend":
        raise HTTPException(404, "Question introuvable ou déjà réglée.")
    if par != "personne" and q["a"] != par:
        raise HTTPException(403, "Cette question n'est pas à toi.")
    chemin = q["chemin"] + ([par] if par != "personne" and par not in q["chemin"] else [])
    now = _now()
    with db.connect() as c:
        done = c.execute("UPDATE questions SET etat = 'repondue', reponse = ?, repondu_par = ?, repondu_a = ?, chemin = ?, maj = ? WHERE id = ? AND etat = 'attend'",
                         (texte, par, now, json.dumps(chemin), now, qid)).rowcount
    if not done:
        raise HTTPException(404, "Question introuvable ou déjà réglée.")
    q = get(qid)
    bus.invalidate(q["owner_id"])
    ev = _events.pop(qid, None)
    if ev:
        ev.set()
    _apaiser(q)
    if q["genre"] == "question":
        _spawn(_livrer(qid))
    else:
        _spawn(_livrer_choix(qid))
    return {"id": qid, "etat": "repondue"}


def _apaiser(q: dict) -> None:
    """La question a trouvé sa réponse : la conversation ne « demande » plus rien à la personne."""
    from . import main
    if main.task_state.get(q["conversation_id"]) == "approve" and not en_attente_conv(q["conversation_id"]):
        main.task_state[q["conversation_id"]] = "work"


async def _livrer(qid: str) -> None:
    """La réponse revient à l'agent qui avait demandé, dans la conversation d'où il l'a posée. Jamais par-dessus un tour en cours."""
    from . import coordination
    q = get(qid)
    if not q:
        return
    agent, conv = q["de"], q["conversation_id"]
    deadline = time.monotonic() + LIVRAISON_ATTENTE
    while coordination._busy(agent, conv) and time.monotonic() < deadline:
        await asyncio.sleep(coordination.FREE_POLL)
    par = q["repondu_par"]
    qui = "La personne" if par == "personne" else ("Une règle qu'elle a retenue" if par.startswith("regle:") else _nom(par))
    note = (f"[Réponse à ta question n° {qid}. {qui} répond. Reprends la tâche là où tu l'avais laissée, sans reposer cette question.]\n\n")
    texte = f"Réponse à « {q['titre'][:160]} » : {q['reponse']}"
    try:
        await _relancer(agent, conv, texte, note, "user" if par == "personne" else "agent")
    except Exception:  # noqa: BLE001 - agent arrêté : la réponse reste dans la conversation, il la lira au retour
        from . import main
        main._save_message(conv, "user" if par == "personne" else "agent", texte)
    with db.connect() as c:
        c.execute("UPDATE questions SET maj = ? WHERE id = ?", (_now(), qid))


def attente_agent(qid: str) -> dict:
    """Ce que l'outil de l'agent lit : l'état de sa question, et la réponse si elle est là."""
    q = get(qid)
    if not q:
        raise HTTPException(404, "Question introuvable.")
    if q["etat"] == "repondue":
        return {"id": qid, "etat": "repondue", "reponse": q["reponse"]}
    if q["etat"] in ("annulee", "expiree"):
        return {"id": qid, "etat": q["etat"], "reponse": ""}
    return {"id": qid, "etat": "en_attente", "a": _nom(q["a"]) if q["a"] else "la personne"}


# --- Choix proposés dans le texte d'un agent (anciens blocs « choice ») -----------------------------------------------------

_CHOIX_BLOC = re.compile(r"```noah\s*(\{.*?\})\s*```", re.S)


def ouvrir_choix(conv_id: str, texte: str, message_id: int | None = None) -> str | None:
    """Un message d'agent qui propose des choix devient une ligne de `questions` : « Pour toi » la montre et y répond."""
    m = None
    for found in _CHOIX_BLOC.finditer(texte or ""):
        try:
            data = json.loads(found.group(1))
        except ValueError:
            continue
        if data.get("type") == "choice":
            m = data
    if not m:
        return None
    options = [str(o.get("label") if isinstance(o, dict) else o) for o in (m.get("options") or []) if o]
    if len(options) == 2 and {" ".join(o.split()).casefold().rstrip(".!") for o in options} == {"oui, vas-y", "non"}:
        return None  # l'offre d'une suite après une tâche finie n'attend rien : elle n'est pas une question
    titre = str(m.get("question") or "").strip() or "Une question attend ta réponse."
    with db.connect() as c:
        conv = c.execute("SELECT user_id, agent_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not conv:
            return None
        if message_id is not None and c.execute("SELECT 1 FROM questions WHERE message_id = ?", (message_id,)).fetchone():
            return None
        c.execute("UPDATE questions SET etat = 'annulee', maj = ? WHERE conversation_id = ? AND genre = 'choix' AND etat = 'attend'", (_now(), conv_id))
        t = c.execute("SELECT id FROM taches WHERE conversation_id = ?", (conv_id,)).fetchone()
        qid, now = uuid.uuid4().hex[:12], _now()
        c.execute("INSERT INTO questions (id, owner_id, tache_id, conversation_id, de, a, genre, titre, choix, libre, chemin, etat, message_id, cree, maj) "
                  "VALUES (?,?,?,?,?, '', 'choix', ?,?,1,?, 'attend', ?,?,?)",
                  (qid, conv["user_id"], t["id"] if t else None, conv_id, conv["agent_id"], titre[:300], json.dumps(options), json.dumps([conv["agent_id"]]),
                   message_id, now, now))
    bus.invalidate(conv["user_id"])
    return qid


def fermer_choix(conv_id: str, par: str = "personne") -> None:
    """La personne a écrit dans la conversation : les choix qui attendaient sont réglés, une seule ligne reste vraie."""
    with db.connect() as c:
        rows = c.execute("SELECT id, owner_id FROM questions WHERE conversation_id = ? AND genre = 'choix' AND etat = 'attend'", (conv_id,)).fetchall()
        if rows:
            c.execute("UPDATE questions SET etat = 'repondue', repondu_par = ?, repondu_a = ?, maj = ? WHERE conversation_id = ? AND genre = 'choix' AND etat = 'attend'",
                      (par, _now(), _now(), conv_id))
    if rows:
        bus.invalidate(rows[0]["owner_id"])


async def _livrer_choix(qid: str) -> None:
    """Répondre à un choix depuis « Pour toi » : c'est un message de la personne dans la conversation, l'agent repart sans qu'on l'ouvre."""
    from . import coordination
    q = get(qid)
    if not q:
        return
    deadline = time.monotonic() + LIVRAISON_ATTENTE
    while coordination._busy(q["de"], q["conversation_id"]) and time.monotonic() < deadline:
        await asyncio.sleep(coordination.FREE_POLL)
    try:
        await _relancer(q["de"], q["conversation_id"], q["reponse"], "", "user")
    except Exception:  # noqa: BLE001
        from . import main
        main._save_message(q["conversation_id"], "user", q["reponse"])


# --- Démarrage, attente de fin de tâche --------------------------------------------------------------------------------------

def recover() -> None:
    """Au démarrage : une question qui attendait un agent monte à la personne (le délai de l'agent s'est perdu avec le serveur) ;
    une question vieille de 48 h expire. Les questions à la personne restent telles quelles."""
    now = _now()
    with db.connect() as c:
        c.execute("UPDATE questions SET etat = 'expiree', maj = ? WHERE etat = 'attend' AND cree < ?", (now, now - EXPIRE))
        rows = c.execute("SELECT id, a FROM questions WHERE etat = 'attend' AND genre = 'question' AND a != ''").fetchall()
        for r in rows:
            c.execute("UPDATE questions SET a = '', maj = ? WHERE id = ?", (now, r["id"]))
        due = c.execute("SELECT * FROM questions WHERE etat = 'attend' AND a = ''").fetchall()
    from . import main
    for r in due:
        if r["genre"] == "question":
            main.task_state[r["conversation_id"]] = "approve"
    if due:
        bus.invalidate_all()


async def attendre_reponses(conv_id: str, limite: float = EXPIRE) -> None:
    """Une tâche qui a posé une question n'est pas finie : le suivi attend la réponse, puis la fin du tour qu'elle relance."""
    from . import coordination
    deadline = time.monotonic() + limite
    while time.monotonic() < deadline and en_attente_conv(conv_id):
        await asyncio.sleep(coordination.FREE_POLL)
    with db.connect() as c:
        agent = c.execute("SELECT agent_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    if agent:
        await asyncio.sleep(coordination.FREE_POLL)
        while time.monotonic() < deadline and coordination._busy(agent["agent_id"], conv_id):
            await asyncio.sleep(coordination.FREE_POLL)


# --- Lecture pour l'interface ------------------------------------------------------------------------------------------------

def _carte(q: dict) -> dict:
    with db.connect() as c:
        agent = c.execute("SELECT name FROM agents WHERE id = ?", (q["de"],)).fetchone()
        t = c.execute("SELECT titre FROM taches WHERE id = ?", (q["tache_id"],)).fetchone() if q["tache_id"] else None
    return {"id": q["id"], "genre": q["genre"], "de": q["de"], "de_nom": agent["name"] if agent else q["de"], "tache_id": q["tache_id"],
            "tache": t["titre"] if t else "", "conversation_id": q["conversation_id"], "titre": q["titre"], "pourquoi": q["pourquoi"],
            "choix": q["choix"], "libre": bool(q["libre"]), "reserve": q["reserve"], "chemin": [{"id": a, "nom": _nom(a)} for a in q["chemin"]],
            "cree": q["cree"]}


def a_la_personne(owner: int) -> list[dict]:
    with db.connect() as c:
        rows = c.execute("SELECT * FROM questions WHERE owner_id = ? AND etat = 'attend' AND a = '' ORDER BY cree", (owner,)).fetchall()
    return [_carte(_ligne(r)) for r in rows]


def decidees(owner: int, limite: int = 50) -> list[dict]:
    """Les questions qu'un agent ou une règle a réglées à la place de la personne, les plus récentes d'abord."""
    with db.connect() as c:
        rows = c.execute("SELECT * FROM questions WHERE owner_id = ? AND genre = 'question' AND etat = 'repondue' AND repondu_par != 'personne' "
                         "ORDER BY repondu_a DESC LIMIT ?", (owner, limite)).fetchall()
    out = []
    for r in rows:
        q = _ligne(r)
        par = q["repondu_par"]
        c = _carte(q)
        c.update({"reponse": q["reponse"], "par": "règle retenue" if par.startswith("regle:") else _nom(par), "par_id": par, "le": q["repondu_a"],
                  "correction": q["correction"], "corrigee": bool(q["corrige_a"]), "regle_id": q["regle_id"]})
        out.append(c)
    return out


def echanges_tache(tache_id: str) -> list[dict]:
    """Ce qui s'est réglé entre agents dans cette tâche : « Léa à Noah … / Noah à Léa … »."""
    with db.connect() as c:
        rows = c.execute("SELECT * FROM questions WHERE tache_id = ? AND genre = 'question' AND etat = 'repondue' AND repondu_par != 'personne' ORDER BY cree",
                         (tache_id,)).fetchall()
    out = []
    for r in rows:
        q = _ligne(r)
        par = q["repondu_par"]
        out.append({"id": q["id"], "de": _nom(q["de"]), "a": "règle retenue" if par.startswith("regle:") else _nom(par), "question": q["titre"],
                    "reponse": q["reponse"], "corrigee": bool(q["corrige_a"]), "regle": par.startswith("regle:")})
    return out


def question_tache(tache_id: str) -> dict | None:
    """La question qui attend la personne dans cette tâche, s'il y en a une."""
    with db.connect() as c:
        row = c.execute("SELECT * FROM questions WHERE tache_id = ? AND etat = 'attend' AND a = '' ORDER BY cree DESC LIMIT 1", (tache_id,)).fetchone()
    return _carte(_ligne(row)) if row else None


# --- Correction --------------------------------------------------------------------------------------------------------------

def corriger(qid: str, owner: int, texte: str, regle: bool = True) -> dict:
    """La personne rectifie une décision. Retenue comme règle, elle répond ensuite à la même question sans la déranger."""
    texte = (texte or "").strip()
    if not texte:
        raise HTTPException(400, "Une correction vide ne change rien.")
    q = get(qid)
    if not q or q["owner_id"] != owner or q["etat"] != "repondue" or q["repondu_par"] == "personne":
        raise HTTPException(404, "Décision introuvable.")
    now = _now()
    rid = q["regle_id"]
    with db.connect() as c:
        if regle:
            if rid and c.execute("SELECT 1 FROM regles WHERE id = ?", (rid,)).fetchone():
                c.execute("UPDATE regles SET texte = ?, etat = 'active' WHERE id = ?", (texte, rid))
            else:
                rid = uuid.uuid4().hex[:12]
                c.execute("INSERT INTO regles (id, owner_id, agent_id, question_id, sujet, texte, cree) VALUES (?,?,NULL,?,?,?,?)",
                          (rid, owner, qid, q["titre"], texte, now))
        c.execute("UPDATE questions SET correction = ?, corrige_a = ?, regle_id = ?, maj = ? WHERE id = ?", (texte, now, rid if regle else q["regle_id"], now, qid))
    try:
        from . import machine
        machine.add_context(q["conversation_id"], f"[La personne a corrigé la réponse à « {q['titre'][:160]} » : {texte}. Tiens-en compte pour la suite.]\n\n")
    except Exception:  # noqa: BLE001
        pass
    bus.invalidate(owner)
    return {"id": qid, "regle_id": rid if regle else None}


# --- Routes ------------------------------------------------------------------------------------------------------------------

class QuestionBody(BaseModel):
    question: str = Field(min_length=1, max_length=600)
    pourquoi: str = Field(default="", max_length=1200)
    choix: list[str] = Field(default_factory=list, max_length=6)
    libre: bool = True
    sujet: str = Field(default="", max_length=20)


class SavoirBody(BaseModel):
    reponse: str = Field(default="", max_length=2000)
    savoir: str = Field(default="", max_length=2000)


class ReponseBody(BaseModel):
    reponse: str = Field(min_length=1, max_length=4000)


class CorrectionBody(BaseModel):
    correction: str = Field(min_length=1, max_length=2000)
    regle: bool = True


@router.post("/agent-api/question")
async def agent_question(body: QuestionBody, request: Request):
    me = relay._agent_from(request)
    out = poser(me, body.question, body.pourquoi, [c for c in body.choix if c.strip()], body.libre, body.sujet)
    if out["etat"] == "repondue":
        return {"id": out["id"], "etat": "repondue", "reponse": out["reponse"], "par": out["par"]}
    ev = _events.get(out["id"])
    if ev:
        try:
            await asyncio.wait_for(ev.wait(), AGENT_WAIT)
        except TimeoutError:
            pass
    return attente_agent(out["id"]) | {"conseil": "Si la réponse n'est pas là : `question-attendre <id>` une fois, puis termine ton tour. La réponse te relancera."}


@router.get("/agent-api/question/{qid}")
async def agent_question_state(qid: str, request: Request):
    me = relay._agent_from(request)
    q = get(qid)
    if not q or me not in (q["de"], q["a"]):
        raise HTTPException(404, "Question introuvable.")
    ev = _events.get(qid)
    if ev and q["etat"] == "attend":
        try:
            await asyncio.wait_for(ev.wait(), AGENT_WAIT)
        except TimeoutError:
            pass
    return attente_agent(qid)


@router.post("/agent-api/question/{qid}/repondre")
async def agent_question_answer(qid: str, body: ReponseBody, request: Request):
    return repondre(qid, relay._agent_from(request), body.reponse)


@router.post("/agent-api/question/{qid}/remonter")
async def agent_question_up(qid: str, body: SavoirBody, request: Request):
    return monter(qid, relay._agent_from(request), body.savoir)


def _own(qid: str, user: int) -> dict:
    q = get(qid)
    if not q or q["owner_id"] != user:
        raise HTTPException(404, "Question introuvable.")
    return q


@router.post("/api/questions/{question_id}/reponse")
async def person_answer(question_id: str, body: ReponseBody, user: int = Depends(auth.current_user)):
    q = _own(question_id, user)
    if q["etat"] != "attend" or q["a"] != "":
        raise HTTPException(409, "Cette question n'attend plus ta réponse.")
    return repondre(question_id, "personne", body.reponse)


@router.get("/api/decisions")
def decisions(user: int = Depends(auth.current_user)):
    return {"decisions": decidees(user)}


@router.post("/api/questions/{question_id}/correction")
def person_correct(question_id: str, body: CorrectionBody, user: int = Depends(auth.current_user)):
    _own(question_id, user)
    return corriger(question_id, user, body.correction, body.regle)


def a_la_personne_conv(conv_id: str) -> bool:
    """Une question attend la personne dans cette conversation (le fil s'affiche « attend ta réponse » tant qu'elle est là)."""
    with db.connect() as c:
        return bool(c.execute("SELECT 1 FROM questions WHERE conversation_id = ? AND genre = 'question' AND etat = 'attend' AND a = ''", (conv_id,)).fetchone())
