"""0.4.0 : les tâches. Un travail qu'un agent fait pour la personne, pour un autre agent, de lui-même ou pour une routine.

Au pas S5 du socle (docs/epics/0.4.0/socle.md, sections 3 et 4), ce fichier ne faisait qu'écrire. Au pas S6, la route d'ouverture d'un
agent (section 5.1) les lit par `du_fil`. Au lot L1 (a, c, d), les tâches sont la source de vérité de ce que l'écran montre d'un travail :
le fil les lit, Activité les lit par `liste`, un titre vient du modèle rapide, et un redémarrage ferme celles qu'il a coupées.
Il est le seul à lire la table `taches`, avec ses tests.

- `creer` : la double écriture. Chaque endroit où naît une sous-conversation y crée aussi sa tâche (et lui fait écrire un titre).
- `lier_trace` : relie la tâche à la ligne de trace du fil, une fois écrite.
- `finir` : ferme la tâche là où le travail se termine.
- `redemarrage` : au démarrage, ferme en échec celles qu'aucun travail ne fait plus tourner.
- `titrer`, `premier_message` : le titre écrit par le modèle rapide, ou la règle de `titre_auto` quand il manque.
- `trois_lignes` : le compte rendu d'une demande, tel qu'il arrive dans le fil du demandeur.
- `migrer` : reprend les anciennes sous-conversations, rejouable à chaque démarrage.
- `du_fil`, `liste` : les tâches d'une page du fil, et celles d'un agent (Activité).

Une erreur d'écriture est journalisée et ne remonte jamais : une tâche perdue ne doit pas abîmer le travail qu'elle signale.
"""
import asyncio
import calendar
import hashlib
import json
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone

from . import db, notifications

TITRE_MAX = 60  # caractères d'un titre, points de suspension compris
RESUME_MAX = 280  # caractères d'un résumé : sa première phrase
GENERIQUES = {"nouvelle discussion", "sous-tâche", "conversation"}  # titres d'avant : ils ne disent rien du travail
MOIS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre")
INSTALLEE = "migr_040_taches"  # settings : le compte rendu du dernier passage de la migration
INTERROMPUE = "Noah a redémarré pendant le travail"  # le résumé d'une tâche coupée par un redémarrage
LIGNES_MAX = 3  # lignes d'un compte rendu dans le fil du demandeur
LIGNE_MAX = 160  # caractères d'une de ces lignes


def _log(message: str) -> None:
    print(f"[taches] {message}", flush=True)


# --- Titre et résumé ----------------------------------------------------------------------------

def _zone():
    """Le fuseau de la personne ; UTC si Noah ne le connaît pas encore (base copiée hors serveur)."""
    try:
        from . import updates  # à la demande : le titre n'a besoin du fuseau que pour une date ou une heure
        return updates.local_zone()
    except Exception:  # noqa: BLE001
        return timezone.utc


def _date(quand: float) -> str:
    jour = datetime.fromtimestamp(quand, _zone())
    return f"{jour.day} {MOIS[jour.month - 1]}"


def _heure(quand: float) -> str:
    return datetime.fromtimestamp(quand, _zone()).strftime("%H:%M")


def titre_auto(texte: str, quand: float | None = None) -> str:
    """Un titre tiré d'un texte, sans modèle : on enlève un préfixe entre crochets (`[Demande de l'agent … ]`, coordination.py) et
    le Markdown, on garde la première phrase, on coupe à 60 caractères sur un mot. Sans rien à garder : « Tâche du 12 novembre »."""
    plain = re.sub(r"^\s*\[[^\]]*\](?!\()\s*", "", texte or "")
    plain = re.sub(r"```.*?(```|$)", " ", plain, flags=re.S)
    plain = re.sub(r"MEDIA:\S+", " ", plain)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    plain = re.sub(r"[*`#>|]+|(?<!\w)_+|_+(?!\w)", " ", plain)
    plain = " ".join(plain.split())
    found = re.match(r".+?[.!?…](?=\s|$)", plain)
    title = (found.group(0) if found else plain).rstrip(" .,:;…")
    if len(title) > TITRE_MAX:
        head = title[:TITRE_MAX - 1]
        if title[TITRE_MAX - 1] != " " and " " in head:
            head = head[:head.rindex(" ")]  # coupé sur un mot, pas au milieu
        title = head.rstrip(" .,:;-") + "…"
    return title or f"Tâche du {_date(quand if quand is not None else time.time())}"


def _resume(texte: str | None) -> str:
    """La première phrase de la réponse, avec la fonction qui sert déjà aux notifications. Vide : rien à dire."""
    return notifications.first_sentence(texte, RESUME_MAX) if texte and texte.strip() else ""


def trois_lignes(texte: str | None, lignes: int = LIGNES_MAX) -> list[str]:
    """Le début d'un compte rendu en `lignes` lignes au plus de 160 caractères (X32) : la suite, coupée, est marquée « … ». Sans blocs de code,
    fichiers joints ni marques de Markdown. Le texte entier reste dans la tâche, qu'on déplie ou qu'on ouvre. Vide : rien à lire."""
    plain = re.sub(r"```.*?(```|$)", "\n", texte or "", flags=re.S)
    plain = re.sub(r"MEDIA:\S+", " ", plain)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    plain = re.sub(r"^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+", "", plain, flags=re.M)
    plain = re.sub(r"[*`#>|]+|(?<!\w)_+|_+(?!\w)", " ", plain)
    chunks: list[str] = []
    for line in (" ".join(raw.split()) for raw in plain.splitlines()):
        while len(line) > LIGNE_MAX:  # un long paragraphe se coupe sur un mot
            cut = line.rfind(" ", 0, LIGNE_MAX)
            cut = cut if cut > LIGNE_MAX // 4 else LIGNE_MAX
            chunks.append(line[:cut].rstrip())
            line = line[cut:].lstrip()
        if line:
            chunks.append(line)
        if len(chunks) > lignes:
            break
    if not chunks or lignes < 1:
        return []
    out = chunks[:lignes]
    if len(chunks) > lignes:
        out[-1] = out[-1].rstrip(" .,:;…") + "…"
    return out


def _sans_marque(titre: str) -> str:
    """Le titre d'une ancienne conversation sans les marques que la 0.4.0 retire : « Demande de X : », « De lui-même : »."""
    return re.sub(r"^\s*(?:De lui-même\s*:|Demande de [^:]{1,100}:)\s*", "", titre or "")


def _titre_unique(c, fil_id: str, titre: str, quand: float, sauf: str | None = None) -> str:
    """Deux tâches du même fil au même titre : la seconde reçoit l'heure entre parenthèses (puis un numéro, à la même minute).
    `sauf` : la tâche qu'on retitre, qui ne compte pas contre elle-même."""
    def pris(candidat: str) -> bool:
        return bool(c.execute("SELECT 1 FROM taches WHERE fil_id = ? AND titre = ? AND id != ?", (fil_id, candidat, sauf or "")).fetchone())

    if not pris(titre):
        return titre
    heure, n = _heure(quand), 1
    candidat = f"{titre} ({heure})"
    while pris(candidat):
        n += 1
        candidat = f"{titre} ({heure}, {n})"
    return candidat


# --- Un titre qui dit ce que la tâche fait (X3, lot L1 d) --------------------------------------------

TITRE_SYSTEME = ("Tu écris le titre d'une tâche confiée à un agent. Titre de la tâche : 3 à 7 mots qui disent ce qu'elle fait, à l'infinitif "
                 "ou en groupe nominal, sans guillemets, sans point final, sans nom d'agent, sans le mot « demande ». "
                 "Réponds seulement par le titre. Exemple : Rédiger la newsletter de jeudi")
PAR_MODELE = ("demande", "sous_tache")  # les genres dont le titre se tire d'une consigne longue : le modèle rapide l'écrit. Les autres
#                                          ont déjà un titre choisi (fil ouvert par l'agent, initiative, routine) ou le prennent du premier message
_en_vol: set[asyncio.Task] = set()  # gardées ici pour ne pas être ramassées en cours de route


def _titre_propre(texte: str | None) -> str:
    """Ce que le modèle a écrit, ramené à un titre : première ligne, sans marques ni guillemets ni point final, 60 caractères au plus.
    Vide si ce n'est pas un titre (« Demande de … » est le défaut que la 0.4.0 retire)."""
    ligne = next((l for l in (texte or "").splitlines() if l.strip()), "")
    ligne = re.sub(r"^\s*(?:titre(?: de la tâche)?\s*:\s*)", "", ligne, flags=re.I)
    ligne = re.sub(r"[*`#_]+", "", ligne).strip().strip("\"'«»“”‘’ ").rstrip(" .,:;…")
    if not ligne or re.match(r"demande de\b", ligne, re.I):
        return ""
    return titre_auto(ligne)


async def titrer(tache_id: str, texte: str) -> bool:
    """Le modèle rapide écrit le titre d'une tâche neuve, depuis sa consigne. Rien ne change s'il manque, échoue ou rend autre chose
    qu'un titre : la tâche garde celui de la règle (`titre_auto`). Une tâche déjà retitrée (par lui ou par la personne) ne bouge plus.
    Rend vrai si le titre vient de changer."""
    from . import rapide  # à la demande : rapide lit decision et relay, que ce module n'a pas à connaître au démarrage
    with db.connect() as c:
        row = c.execute("SELECT agent_id, fil_id, titre_source, cree FROM taches WHERE id = ?", (tache_id,)).fetchone()
    if not row or row["titre_source"] != "auto":
        return False
    ecrit = _titre_propre(await rapide.ecrire(row["agent_id"], TITRE_SYSTEME, (texte or "")[:1500]))
    if not ecrit:
        return False
    with db.connect() as c:
        titre = _titre_unique(c, row["fil_id"], ecrit, row["cree"], sauf=tache_id)
        done = c.execute("UPDATE taches SET titre = ?, titre_source = 'modele', maj = ? WHERE id = ? AND titre_source = 'auto'", (titre, time.time(), tache_id))
    return done.rowcount > 0


def _programmer_titre(tache_id: str, texte: str) -> None:
    """Le titre s'écrit à côté : ni la demande ni la réponse de la route n'attendent le modèle. Sans boucle d'événements (appel depuis une
    route synchrone, ou un test), la règle suffit."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    async def go() -> None:
        try:
            await titrer(tache_id, texte)
        except Exception as e:  # noqa: BLE001 - un titre perdu ne vaut pas une erreur
            _log(f"{tache_id} : titre non écrit ({type(e).__name__} : {e})")

    task = loop.create_task(go())
    _en_vol.add(task)
    task.add_done_callback(_en_vol.discard)


def premier_message(conversation_id: str, texte: str) -> None:
    """Une discussion ouverte par la personne naît sans rien dire : « Nouvelle discussion ». À son premier message, elle prend le titre de
    ce qu'on y demande (la règle d'abord, le modèle rapide ensuite). Une tâche d'une autre origine, ou déjà titrée, ne bouge pas."""
    try:
        with db.connect() as c:
            row = c.execute("SELECT id, fil_id, titre, titre_source, cree FROM taches WHERE conversation_id = ? AND genre = 'discussion'", (conversation_id,)).fetchone()
            if not row or row["titre_source"] != "auto" or re.sub(r"\s*\([^)]*\)$", "", row["titre"]).casefold() not in GENERIQUES:
                return
            now = time.time()
            c.execute("UPDATE taches SET titre = ?, maj = ? WHERE id = ?", (_titre_unique(c, row["fil_id"], titre_auto(texte, now), now, sauf=row["id"]), now, row["id"]))
        _programmer_titre(row["id"], texte)
    except Exception as e:  # noqa: BLE001
        _log(f"{conversation_id} : discussion non titrée ({type(e).__name__} : {e})")


# --- Double écriture --------------------------------------------------------------------------------

def _fil(c, agent_id: str, user_id: int) -> str | None:
    row = c.execute("SELECT id FROM conversations WHERE agent_id = ? AND user_id = ? AND main = 1", (agent_id, user_id)).fetchone()
    return row["id"] if row else None


def creer(conversation_id: str, genre: str, *, titre: str = "", consigne: str = "", demandeur: str = "", source_id: str = "",
          etat: str = "encours") -> str | None:
    """Crée la tâche d'une sous-conversation qui vient de naître, rattachée au fil de son compte. Une seule par sous-conversation :
    appelée deux fois, la seconde rend la première. Rend l'id de la tâche, ou None (journalisé) sans fil pour ce compte."""
    try:
        now = time.time()
        with db.connect() as c:
            conv = c.execute("SELECT user_id, agent_id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if not conv:
                _log(f"{conversation_id} : sous-conversation introuvable, pas de tâche")
                return None
            fil = _fil(c, conv["agent_id"], conv["user_id"])
            if not fil:
                _log(f"{conversation_id} : pas de fil pour ce compte avec {conv['agent_id']}, pas de tâche (la migration la reprendra)")
                return None
            ancre = c.execute("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ?", (fil,)).fetchone()["n"]
            tache = uuid.uuid4().hex[:12]
            neuve = c.execute("INSERT OR IGNORE INTO taches (id, owner_id, agent_id, fil_id, conversation_id, genre, demandeur, titre, consigne, etat, "
                              "ancre, source_id, cree, fini_a, maj, migree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
                              (tache, conv["user_id"], conv["agent_id"], fil, conversation_id, genre, demandeur,
                               _titre_unique(c, fil, titre_auto(titre or consigne, now), now), consigne, etat, ancre, source_id, now,
                               now if etat in ("fini", "echec") else None, now)).rowcount
            ident = c.execute("SELECT id FROM taches WHERE conversation_id = ?", (conversation_id,)).fetchone()["id"]
        if neuve and genre in PAR_MODELE and (consigne or titre):
            _programmer_titre(ident, consigne or titre)  # les anciennes tâches (migrer) ne passent jamais ici : aucun appel pour elles
        return ident
    except Exception as e:  # noqa: BLE001
        _log(f"{conversation_id} : tâche non écrite ({type(e).__name__} : {e})")
        return None


def lier_trace(conversation_id: str) -> None:
    """La ligne de trace de ce travail est écrite dans le fil : la tâche en garde l'id, et sa place dans le fil devient celle de la trace
    (`ancre = trace_id`). Sans trace trouvée, la tâche garde la place qu'elle a prise à sa création."""
    try:
        with db.connect() as c:
            tache = c.execute("SELECT id, fil_id FROM taches WHERE conversation_id = ?", (conversation_id,)).fetchone()
            if not tache:
                return
            trace = _trace(c, tache["fil_id"], conversation_id)
            if trace:
                c.execute("UPDATE taches SET trace_id = ?, ancre = ?, maj = ? WHERE id = ?", (trace["id"], trace["id"], time.time(), tache["id"]))
    except Exception as e:  # noqa: BLE001
        _log(f"{conversation_id} : trace non liée ({type(e).__name__} : {e})")


def finir(conversation_id: str, etat: str, resume: str | None = None) -> bool:
    """Ferme la tâche de cette sous-conversation : `fini` ou `echec`, avec sa date et son résumé (la première phrase de `resume`, ou
    à défaut de la dernière réponse de la sous-conversation). Une tâche déjà fermée ne bouge pas. Rend vrai si elle vient de se fermer."""
    try:
        if etat not in ("fini", "echec"):
            raise ValueError(f"état de fin inconnu : {etat}")
        with db.connect() as c:
            if resume is None:
                last = c.execute("SELECT text FROM messages WHERE conversation_id = ? AND role NOT IN ('user', 'trace') ORDER BY id DESC LIMIT 1",
                                 (conversation_id,)).fetchone()
                resume = last["text"] if last else ""
            now = time.time()
            done = c.execute("UPDATE taches SET etat = ?, resume = ?, fini_a = ?, maj = ? WHERE conversation_id = ? AND etat IN ('encours', 'attend')",
                             (etat, _resume(resume), now, now, conversation_id))
            return done.rowcount > 0
    except Exception as e:  # noqa: BLE001
        _log(f"{conversation_id} : tâche non fermée ({type(e).__name__} : {e})")
        return False


# --- Lecture pour la route d'ouverture ---------------------------------------------------------------------

DU_FIL_MAX = 200  # tâches rendues au plus : les plus récentes
LISTE_MAX = 100  # tâches d'un agent rendues à Activité, par défaut
# Une « Nouvelle discussion » restée sans aucun message n'est pas un travail : elle ne s'affiche pas comme tâche (décision laissée par S5).
SAUF_VIDES = ("NOT (t.genre = 'discussion' AND NOT EXISTS "
              "(SELECT 1 FROM messages m WHERE m.conversation_id = t.conversation_id AND m.role != 'trace'))")
CHAMPS = ("t.id, t.titre, t.genre, t.demandeur, a.name AS demandeur_nom, w.name AS agent_nom, t.etat, t.resume, t.fichiers, t.ancre, t.cree, t.fini_a, "
          "t.conversation_id, t.agent_id, t.maj")


def _etat(r) -> str:
    """L'état à lire : une tâche « encours » dont le travail attend un accord de la personne attend (c'est ce que la liste des conversations
    disait avant : l'état vivant du travail). La base ne le sait pas : elle ne change qu'au début et à la fin du travail."""
    if r["etat"] != "encours":
        return r["etat"]
    from . import main  # à la demande : main importe ce module
    return "attend" if main.task_state.get(r["conversation_id"]) == "approve" else "encours"


def _forme(r) -> dict:
    try:
        fichiers = json.loads(r["fichiers"] or "[]")
    except ValueError:
        fichiers = []
    return {"id": r["id"], "titre": r["titre"], "genre": r["genre"],
            "demandeur": {"id": r["demandeur"], "nom": r["demandeur_nom"]} if r["demandeur"] else None,
            "agent": {"id": r["agent_id"], "nom": r["agent_nom"]},  # celui qui fait le travail : la ligne le nomme, pas le demandeur
            "etat": _etat(r), "resume": r["resume"], "fichiers": fichiers if isinstance(fichiers, list) else [],
            "ancre": r["ancre"], "cree": r["cree"], "fini_a": r["fini_a"], "conversation_id": r["conversation_id"], "question": None}


def du_fil(fil_id: str, owner_id: int, depuis_ancre: int | None) -> list[dict]:
    """Les tâches de cette page du fil, dans l'ordre où elles s'y placent (socle.md, 3.1 : « une page de messages [a, b] porte les
    tâches dont a <= ancre <= b »). `depuis_ancre` : l'id du premier message de la page ; None quand la page est la plus ancienne, qui
    porte aussi celles d'avant. La page rendue est toujours la plus récente : aucune borne haute. Le compte qui lit est celui de la tâche."""
    with db.connect() as c:
        rows = c.execute(
            f"SELECT * FROM (SELECT {CHAMPS} FROM taches t LEFT JOIN agents a ON a.id = t.demandeur LEFT JOIN agents w ON w.id = t.agent_id "
            f"WHERE t.fil_id = ? AND t.owner_id = ? AND (? IS NULL OR t.ancre >= ?) AND {SAUF_VIDES} "
            "ORDER BY t.ancre DESC, t.cree DESC LIMIT ?) ORDER BY ancre, cree",
            (fil_id, owner_id, depuis_ancre, depuis_ancre, DU_FIL_MAX)).fetchall()
    return [_forme(r) for r in rows]


def liste(owner_id: int, agent_id: str, etat: str | None = None, limite: int = LISTE_MAX) -> list[dict]:
    """Les tâches d'un agent pour ce compte, la plus récemment active d'abord : ce que lit l'onglet Tâches d'Activité. Les mêmes lignes,
    sous la même forme, que celles du fil (`du_fil`) : une tâche se lit pareil des deux endroits."""
    limite = max(1, min(int(limite), 500))
    with db.connect() as c:
        rows = c.execute(
            f"SELECT {CHAMPS} FROM taches t LEFT JOIN agents a ON a.id = t.demandeur LEFT JOIN agents w ON w.id = t.agent_id WHERE t.owner_id = ? AND t.agent_id = ? "
            f"AND (? IS NULL OR t.etat = ?) AND {SAUF_VIDES} ORDER BY t.maj DESC, t.cree DESC LIMIT ?",
            (owner_id, agent_id, etat, etat, limite)).fetchall()
    return [_forme(r) for r in rows]


# --- Au démarrage ---------------------------------------------------------------------------------------

GENRES_BALAYES = ("fil", "sous_tache", "routine")  # les demandes ferment par coordination.recover, les initiatives par proactif.recover


def redemarrage() -> int:
    """Au démarrage, plus aucun travail ne tourne : une tâche encore `encours` dont le genre n'a pas d'autre rattrapage passe en `echec`
    avec le résumé « Noah a redémarré pendant le travail » (décision laissée ouverte par S5). Rend le nombre de tâches fermées."""
    try:
        now = time.time()
        marques = ",".join("?" for _ in GENRES_BALAYES)
        with db.connect() as c:
            done = c.execute(f"UPDATE taches SET etat = 'echec', resume = ?, fini_a = ?, maj = ? WHERE etat = 'encours' AND genre IN ({marques})",
                             (INTERROMPUE, now, now, *GENRES_BALAYES))
        if done.rowcount:
            _log(f"redémarrage : {done.rowcount} tâches coupées par l'arrêt, passées en échec")
        return done.rowcount
    except Exception as e:  # noqa: BLE001
        _log(f"redémarrage : tâches non fermées ({type(e).__name__} : {e})")
        return 0


# --- Migration des anciennes sous-conversations ----------------------------------------------------------

CANDIDATES = ("SELECT c.* FROM conversations c WHERE c.main = 0 "
              "AND NOT EXISTS (SELECT 1 FROM taches t WHERE t.conversation_id = c.id) ORDER BY c.created_at")


def _trace(c, fil_id: str, conversation_id: str):
    """La ligne de trace du fil qui désigne cette conversation (même requête que coordination.close_trace)."""
    return c.execute("SELECT id, detail FROM messages WHERE conversation_id = ? AND role = 'trace' "
                     "AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.fil') END = ?", (fil_id, conversation_id)).fetchone()


def _ts(texte: str | None, defaut: float) -> float:
    try:
        return float(calendar.timegm(time.strptime(texte or "", "%Y-%m-%d %H:%M:%S")))
    except ValueError:
        return defaut


def _migrer_une(c, conv) -> str | None:
    """Une sous-conversation, dans la transaction de l'appelant. Rend son genre si une tâche est née, « sans_fil » si son compte n'a
    pas de fil avec cet agent, None si une tâche existait déjà."""
    fil = _fil(c, conv["agent_id"], conv["user_id"])
    if not fil:
        return "sans_fil"
    conv_id = conv["id"]
    created = _ts(conv["created_at"], time.time())
    updated = _ts(conv["updated_at"], created)

    # Place : la trace si elle existe, sinon le dernier message du fil écrit avant la création de la sous-conversation.
    trace = _trace(c, fil, conv_id)
    if trace:
        trace_id, ancre = trace["id"], trace["id"]
    else:
        trace_id = None
        ancre = c.execute("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ? AND created_at <= ?",
                          (fil, conv["created_at"] or "")).fetchone()["n"]

    # Genre et source, dans cet ordre.
    deleg = c.execute("SELECT * FROM delegations WHERE conversation_id = ? ORDER BY created_at LIMIT 1", (conv_id,)).fetchone()
    tour = c.execute("SELECT * FROM proactive_turns WHERE conversation_id = ? ORDER BY at LIMIT 1", (conv_id,)).fetchone()
    entete = ""
    if trace:
        try:
            entete = str(json.loads(trace["detail"]).get("entete") or "")
        except (TypeError, ValueError):
            entete = ""
    demandeur = source_id = consigne = ""
    source_etat = None  # ce que la source dit de l'état, quand elle le sait
    issue = ""
    if deleg:
        genre, demandeur, source_id, consigne = "demande", deleg["de"], deleg["id"], deleg["consigne"]
        source_etat = {"fini": "fini", "echec": "echec"}.get(deleg["etat"], "encours")
        titre_brut = consigne
    elif tour:
        genre, source_id = "initiative", tour["id"]
        source_etat = {"fini": "fini", "echec": "echec"}.get(tour["etat"], "encours")  # `en_cours` et `a_reprendre` : pas fini
        titre_brut = tour["titre"]
    elif (conv["title"] or "").startswith("De lui-même : "):
        genre = "initiative"
        titre_brut = conv["title"][len("De lui-même : "):]
    elif entete == "J'ai ouvert un fil":
        genre, titre_brut = "fil", _sans_marque(conv["title"])
    elif conv["origin"] == "agent":
        genre, titre_brut = "sous_tache", _sans_marque(conv["title"])
    else:
        genre, titre_brut = "discussion", _sans_marque(conv["title"])
    if trace and deleg:
        try:
            issue = str(json.loads(trace["detail"]).get("issue") or "")
        except (TypeError, ValueError):
            issue = ""

    # État : la source quand elle le sait, sinon la dernière réponse du sous-fil (même règle que coordination._last_reply).
    last = c.execute("SELECT role, text FROM messages WHERE conversation_id = ? AND role NOT IN ('user', 'trace') ORDER BY id DESC LIMIT 1",
                     (conv_id,)).fetchone()
    if source_etat:
        etat = source_etat
    elif last and last["role"] == "agent":
        etat = "fini"
    else:
        etat = "echec"

    # Titre : jamais « Demande de… ». Un titre générique laisse la place au premier message de la personne.
    if genre not in ("demande", "initiative") and (not titre_brut.strip() or titre_brut.strip().casefold() in GENERIQUES):
        first = c.execute("SELECT text FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id LIMIT 1", (conv_id,)).fetchone()
        titre_brut = first["text"] if first else ""
    titre = _titre_unique(c, fil, titre_auto(titre_brut, created), created)

    resume = _resume(issue or (last["text"] if last else ""))
    fini = etat in ("fini", "echec")
    # Un id qui ne dépend que de la sous-conversation : le retour arrière puis la migration recréent exactement les mêmes lignes.
    tache = "m" + hashlib.sha1(conv_id.encode()).hexdigest()[:11]
    done = c.execute("INSERT OR IGNORE INTO taches (id, owner_id, agent_id, fil_id, conversation_id, genre, demandeur, titre, consigne, etat, "
                     "resume, ancre, trace_id, source_id, cree, fini_a, maj, migree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                     (tache, conv["user_id"], conv["agent_id"], fil, conv_id, genre, demandeur, titre, consigne, etat, resume, ancre,
                      trace_id, source_id, created, updated if fini else None, updated))
    return genre if done.rowcount else None


def migrer() -> dict:
    """Une tâche pour chaque sous-conversation qui n'en a pas, à chaque démarrage (le deuxième passage ne trouve plus rien). Elle ajoute :
    ni `conversations`, ni `messages`, ni `delegations` ne sont touchés. Une transaction par ligne : une ligne qui échoue est comptée et
    journalisée, les autres passent. Le compte rendu va dans `settings['migr_040_taches']` et dans le journal du serveur.
    Retour arrière : DELETE FROM taches WHERE migree = 1, puis DELETE FROM settings WHERE key = 'migr_040_taches'."""
    debut = time.time()
    with db.connect() as c:
        candidates = c.execute(CANDIDATES).fetchall()
    creees = sans_fil = erreurs = 0
    par_genre: dict[str, int] = {}
    for conv in candidates:
        try:
            with db.connect() as c:
                res = _migrer_une(c, conv)
        except (sqlite3.Error, ValueError, TypeError, KeyError) as e:
            erreurs += 1
            _log(f"migration : {conv['id']} passée ({type(e).__name__} : {e})")
            continue
        if res == "sans_fil":
            sans_fil += 1
        elif res:
            creees += 1
            par_genre[res] = par_genre.get(res, 0) + 1
    rapport = {"at": debut, "creees": creees, "sans_fil": sans_fil, "par_genre": par_genre, "erreurs": erreurs}
    db.set_setting(INSTALLEE, json.dumps(rapport))
    _log(f"migration 0.4.0 : {len(candidates)} sous-conversations examinées, {creees} tâches créées {par_genre}, "
         f"{sans_fil} sans fil, {erreurs} erreurs, {time.time() - debut:.2f} s")
    return rapport
