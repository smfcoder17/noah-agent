"""Le reçu : ce que l'agent dit avoir fait, comparé à ce que ses outils ont vraiment fait. Dans les deux sens.

Dit et pas fait : « j'ai envoyé le courriel », et aucun outil d'envoi n'a tourné, ou il a échoué.
Fait et pas dit : un outil a envoyé, publié, supprimé ou payé, et la réponse n'en parle pas.

C'est une comparaison, sans modèle ni coût : les phrases d'un côté, le flux des outils de l'autre. Un juge qui relit la prose repère mal un faux
« c'est fait » ; compter les appels, si. Tenu ici, hors de la machine de l'agent, mais d'après ce que son run rapporte : le reçu dit ce que le run
montre, pas ce qui est arrivé chez le destinataire.

Il ne bloque rien, ne change aucun droit et ne dépense rien : accords, juge et budget restent ce qu'ils sont. En cas de doute, il se tait ou dit
« non vérifiable » : une commande, un clic ou un sous-agent peuvent avoir agi sans que Noah sache lequel. Une fausse alerte coûterait la confiance
qu'il sert à gagner : seules les phrases au passé et à la première personne comptent, et ce qui se passe dans la conversation elle-même n'y entre pas.
"""
import json
import re

from . import db, mcp
from .agent_plugin import no_effect

LECTURE, GENERIQUE, FAIT = "lecture", "generique", "fait"
OK, ECHEC, LANCE = "ok", "echec", "lance"
OUTWARD = ("envoyer", "publier", "supprimer", "payer")  # ce qui se voit dehors : à dire, même si personne ne l'a demandé
MAX_CLAIMS = 6
PHRASE_MAX = 140
EARLIER_MESSAGES = 30  # « je l'ai envoyé » peut parler d'un tour d'avant : ce qui y a été prouvé compte

# Les outils ---------------------------------------------------------------------------------------------------------

_BUILTIN = {"send_message": "envoyer", "write_file": "creer", "patch": "modifier", "image_generate": "creer", "video_generate": "creer",
            "text_to_speech": "creer", "cronjob": "planifier", "memory": "memoire", "skill_manage": "creer"}
_CAN_DO_ANYTHING = {"delegate_task", "execute_code", "a2a_call"}  # un sous-agent ou un programme peut tout faire : Noah ne sait pas quoi
_NOAH_COMMANDS = {"notifier": "envoyer", "rappeler": "envoyer", "appeler": "envoyer", "image": "creer", "video": "creer", "musique": "creer", "voix": "creer",
                  "routine": "planifier", "routine-si": "planifier", "routine-regler": "planifier", "veille": "planifier"}
_READ_WORDS = {"get", "list", "read", "search", "fetch", "find", "query", "lookup", "view", "show", "lire", "liste", "chercher", "cherche", "voir"}
_PAY_WORDS = {"pay", "checkout", "purchase", "buy", "order", "book", "reserve", "payer", "acheter", "commander", "reserver"}
_BY = {"send_message": "son outil de message", "write_file": "un fichier écrit", "patch": "un fichier modifié", "image_generate": "une création d'image", "video_generate": "une création de vidéo",
       "text_to_speech": "une création de son", "cronjob": "une tâche planifiée", "memory": "sa mémoire", "skill_manage": "ses compétences",
       "delegate_task": "un sous-agent", "execute_code": "un programme", "a2a_call": "un autre agent", "terminal": "une commande"}
# Hermes classe parfois en « terminé » un outil qui a refusé : Noah et ses connexions le disent dans le résultat.
_REFUSED = re.compile(r"^\s*(?:Refus[ée]\b|Noah refuse\b|L'outil « .{1,60} » (?:est injoignable|a refus[ée])|Erreur\b|Error\b|\{\s*\"(?:isError|error)\"\s*:\s*(?:true|\")|\{\s*\"success\"\s*:\s*false)", re.I)


def _app(tool: str) -> str:
    parts = [p for p in re.split(r"_+", tool.removeprefix("mcp_")) if p]
    return parts[0].capitalize() if parts else "une app connectée"


def _is_app(tool: str) -> bool:
    return tool.startswith("mcp_") or "__" in tool


def _app_family(tool: str) -> str:
    """D'après les mots du nom, comme la carte d'accord. Lire et agir dans le même nom : Noah ne saurait pas dire lequel a eu lieu."""
    words = set(re.split(r"[_\W]+", tool.lower())) - {"mcp"}
    found = next((action for action, verbs, _ in mcp._ACTIONS if words & verbs), None)
    if words & _PAY_WORDS:
        found = "payer"
    if found and words & _READ_WORDS:
        return GENERIQUE
    if found:
        return {"créer": "creer"}.get(found, found)
    return LECTURE if words & _READ_WORDS else GENERIQUE


def classify(tool: str, args: object = None) -> tuple[str, str]:
    """(famille, par quoi c'est passé). Lecture : sans effet. Générique : a pu agir, sans qu'on sache comment."""
    args = args if isinstance(args, dict) else {}
    if tool == "terminal":
        command = str(args.get("command") or "")
        noah = re.search(r"noah\.py\s+([\w-]+)", command)
        if noah and noah.group(1) in _NOAH_COMMANDS:
            return _NOAH_COMMANDS[noah.group(1)], "Noah"
        if command.strip() and no_effect(tool, args):  # sans la commande, on ne sait pas ce qu'elle a fait
            return LECTURE, _BY[tool]
        return GENERIQUE, _BY[tool]
    if tool in _CAN_DO_ANYTHING:
        return GENERIQUE, _BY[tool]
    if tool in _BUILTIN and not (tool == "memory" and str(args.get("action") or "") == "read"):
        return _BUILTIN[tool], _BY[tool]
    if _is_app(tool):
        return _app_family(tool), _app(tool)
    if tool.startswith("browser"):
        return (LECTURE if no_effect(tool, args) else GENERIQUE), "le navigateur"
    if no_effect(tool, args):
        return LECTURE, tool
    return GENERIQUE, tool.replace("_", " ")


class Ledger:
    """Ce que les outils d'un run ont fait, d'après ses événements."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def feed(self, kind: str, data: dict) -> None:
        tool = str(data.get("tool") or data.get("tool_name") or data.get("name") or "")
        if not tool or tool.startswith("_"):
            return
        if kind == "tool.started":
            self._start(tool, data)
        elif kind == "hermes.tool.progress":  # il suit parfois un tool.started du même appel
            if not any(c["tool"] == tool and c["etat"] == LANCE for c in self.calls):
                self._start(tool, data)
        elif kind in ("tool.completed", "tool.failed"):
            call = next((c for c in self.calls if c["tool"] == tool and c["etat"] == LANCE), None)
            if call is None:
                self._start(tool, data)
                call = self.calls[-1]
            failed = kind == "tool.failed" or bool(data.get("error")) or bool(data.get("is_error")) or data.get("status") in ("error", "failed")
            call["etat"] = ECHEC if failed or _REFUSED.match(str(data.get("preview") or "")) else OK

    def _start(self, tool: str, data: dict) -> None:
        family, by = classify(tool, data.get("args") or data.get("arguments"))
        self.calls.append({"tool": tool, "famille": family, "par": by, "etat": LANCE})


# Les phrases ---------------------------------------------------------------------------------------------------------

_PAST = {  # famille : (participes, infinitifs, anglais)
    "envoyer": (r"envoy[ée]e?s?|exp[ée]di[ée]e?s?|transmise?s?|transf[ée]r[ée]e?s?|relanc[ée]e?s?|r[ée]pondu\s+(?:[àa]|au|aux)\s+(?:[\w'’-]+\s+){0,3}(?:mail|e-mail|courriel|message|sms|client)s?",
                r"envoyer|exp[ée]dier|transmettre|transf[ée]rer|relancer", r"sent|e-?mailed|forwarded|texted"),
    "publier": (r"publi[ée]e?s?|post[ée]e?s?|mise?s?\s+en\s+ligne", r"publier|poster|mettre\s+en\s+ligne", r"published|posted"),
    "supprimer": (r"supprim[ée]e?s?|effac[ée]e?s?|archiv[ée]e?s?", r"supprimer|effacer|archiver", r"deleted|removed|archived|trashed"),
    "payer": (r"pay[ée]e?s?|achet[ée]e?s?|command[ée]e?s?|r[ée]serv[ée]e?s?", r"payer|acheter|commander|r[ée]server", r"paid|bought|purchased|ordered|booked"),
    "planifier": (r"programm[ée]e?s?|planifi[ée]e?s?", r"programmer|planifier", r"scheduled"),
    "memoire": (r"m[ée]moris[ée]e?s?", r"m[ée]moriser", r"memorized"),
    "creer": (r"cr[ée]{1,2}e?s?|ajout[ée]e?s?|enregistr[ée]e?s?|sauvegard[ée]e?s?", r"cr[ée]er|ajouter|enregistrer|sauvegarder", r"created|added|saved"),
    "modifier": (r"modifi[ée]e?s?|mise?s?\s+[àa]\s+jour|chang[ée]e?s?|renomm[ée]e?s?|d[ée]plac[ée]e?s?", r"modifier|mettre\s+[àa]\s+jour|changer|renommer|d[ée]placer", r"updated|modified|renamed|moved"),
}
_EVIDENCE = {"envoyer": {"envoyer", "publier"}, "publier": {"publier", "envoyer"}, "supprimer": {"supprimer"}, "payer": {"payer", "creer"},
             "planifier": {"planifier", "creer", "modifier"}, "memoire": {"memoire"}, "creer": {"creer", "modifier", "planifier"}, "modifier": {"modifier", "creer"}}
# « J'ai ajouté une section », « j'ai changé la tournure » : souvent dans la réponse même. Ces verbes ne comptent que si la phrase nomme un objet qui existe dehors.
_NAMED_THING = {
    "creer": r"fichier|document|dossier|tableau|feuille|[ée]v[ée]nement|rendez-vous|agenda|calendrier|t[âa]che|ticket|contact|d[ée]p[ôo]t|script|file|folder|event|calendar|task",
    "modifier": r"fichier|document|dossier|tableau|feuille|[ée]v[ée]nement|rendez-vous|agenda|calendrier|t[âa]che|ticket|contact|compte|r[ée]glage|param[èe]tre|d[ée]p[ôo]t|script|file|folder|event|calendar|task|settings?",
    "planifier": r"rappel|routine|t[âa]che|rendez-vous|r[ée]union|envoi|publication|agenda|calendrier|[ée]v[ée]nement|chaque|tous les|demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\d\s*h\b|reminder|meeting|tomorrow",
}
_SUBJECT = r"(?:\bj'ai|\bje\s+(?:(?:t'|m'|l'|lui\s+|leur\s+|vous\s+|les\s+|en\s+|y\s+|te\s+|le\s+|la\s+))*ai|\bc'est)"
_ADVERBS = r"(?:\s+(?:bien|d[ée]j[àa]|aussi|donc|[ée]galement|enfin|maintenant|ensuite|alors|tout|toutes?|tous|correctement|finalement|automatiquement|imm[ée]diatement))*"
_HEAD_NOUN = (r"^[\s*_>•·✅✔☑️-]*(?:(?:ton|ta|tes|votre|vos|le|la|les|l')\s*)?(?:mail|e-mail|courriel|message|sms|r[ée]ponse|post|article|tweet|relance|invitation)s?\s+"
              r"(?:bien\s+)?(?:(?:a|ont)\s+[ée]t[ée]\s+|est\s+|sont\s+)?")
_ALONE = r"^[\s*_>•·✅✔☑️-]*"


def _family_patterns() -> list[tuple[str, re.Pattern]]:
    out = []
    for family, (done, infinitive, english) in _PAST.items():
        out.append((family, re.compile(rf"(?P<sujet>{_SUBJECT}){_ADVERBS}\s+(?:{done})\b", re.I)))
        out.append((family, re.compile(rf"\bje\s+viens\s+d(?:e\s+|')(?:(?:t'|lui\s+|leur\s+|l'|le\s+|la\s+|les\s+))?(?:{infinitive})\b|\bj'ai\s+(?:pu|r[ée]ussi\s+[àa])\s+(?:(?:lui\s+|leur\s+|l'|le\s+|la\s+|les\s+))?(?:{infinitive})\b", re.I)))
        out.append((family, re.compile(rf"\bI(?:'ve|\s+have)?(?:\s+(?:just|already|also|successfully))*\s+(?:{english})\b")))
    for family in ("envoyer", "publier"):
        done = _PAST[family][0].split("|r[ée]pondu")[0]
        out.append((family, re.compile(rf"{_HEAD_NOUN}(?:{done})\b(?!\s+(?:par|from|by)\b)", re.I)))
    for family in ("envoyer", "publier", "supprimer"):
        out.append((family, re.compile(rf"{_ALONE}(?:{_PAST[family][0].split('|r[ée]pondu')[0]})\s*(?:[.!:*_✅✔]|$)", re.I)))
    return out


_PATTERNS = _family_patterns()
_IN_CHAT = re.compile(r"\b(?:voici|voil[àa]|ci-dessous)\b", re.I)  # le résultat est dans la réponse : aucun outil à prouver
_DONE_WORDS = re.compile(r"\b(?:c'est\s+fait|tout\s+est\s+fait|c'est\s+termin[ée]|all\s+done)\b", re.I)
_DOUBT_BEFORE = re.compile(r"\b(?:si|s'il|quand|lorsque|d[èe]s\s+que|une\s+fois\s+que|avant\s+que|apr[èe]s\s+que|pour\s+que|if|once|when|dit|dis|[ée]crit|r[ée]pond|indique|annonce|affirme|pr[ée]tend|says?|writes?|wrote|said)\b", re.I)
_HERE = re.compile(r"\b(?:ci-dessus|ci-dessous|plus\s+haut|plus\s+bas|voici|ici|dans\s+(?:cette\s+conversation|ce\s+message|ce\s+fil)|above|below)\b", re.I)
_TO_YOU = re.compile(r"\bje\s+(?:t'|vous\s+)ai\b", re.I)
_YOUR_CHANNEL = re.compile(r"\b(?:par|sur|dans|[àa])\s+(?:mail|e-mail|courriel|sms|ta\s+bo[iî]te|ton\s+(?:mail|t[ée]l[ée]phone|courriel)|t[ée]l[ée]phone)\b", re.I)
_LONG_AGO = re.compile(r"\b(?:hier|avant-hier|la\s+semaine\s+derni[èe]re|le\s+mois\s+dernier|l'autre\s+jour|pr[ée]c[ée]demment|plus\s+t[ôo]t|tout\s+[àa]\s+l'heure|ce\s+matin|yesterday|last\s+week|earlier)\b", re.I)
_MENTION = {
    "envoyer": re.compile(r"envo|exp[ée]di|transm|transf[ée]r|r[ée]pon|relanc|mail|courriel|message|sms|notifi|pr[ée]venu|[ée]crit|sent|send|repl|forward", re.I),
    "publier": re.compile(r"publi|post|en\s+ligne", re.I),
    "supprimer": re.compile(r"suppr|effac|archiv|retir|corbeille|delet|remov|trash", re.I),
    "payer": re.compile(r"pay|achet|command|r[ée]serv|facture|montant|[$€]|bought|purchas|order|book", re.I),
}
_DID = {"envoyer": "a envoyé quelque chose avec {}", "publier": "a publié avec {}", "supprimer": "a supprimé quelque chose avec {}", "payer": "a payé ou commandé avec {}"}


def _plain(text: str) -> str:
    """Ce qu'il affirme lui-même : ni code, ni citation, ni fichier joint."""
    text = text.replace("’", "'")
    text = re.sub(r"```.*?(?:```|$)", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r"«[^»\n]*»|\"[^\"\n]*\"|“[^”\n]*”", " ", text)
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith((">", "MEDIA:")))


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\n+", text) if s.strip()]


def _phrase(sentence: str) -> str:
    plain = " ".join(re.sub(r"[*_#]+", "", sentence).split())
    return plain[:PHRASE_MAX] + ("…" if len(plain) > PHRASE_MAX else "")


def claims_in(text: str) -> list[dict]:
    """Ce qu'il dit avoir fait : {famille, phrase, passe}. Une question, une condition, ce qu'un autre a écrit, ce qui est dans la conversation : rien."""
    found: list[dict] = []
    has_media = "MEDIA:" in text
    for sentence in _sentences(_plain(text)):
        if sentence.endswith("?"):
            continue
        families: list[str] = []
        for family, pattern in _PATTERNS:
            m = pattern.search(sentence)
            if not m or family in families or _DOUBT_BEFORE.search(sentence[:m.start()]):
                continue
            if family in _NAMED_THING and (not re.search(_NAMED_THING[family], sentence, re.I) or _HERE.search(sentence)):
                continue
            if family == "payer" and re.match(r"\s+(?:[àa]|aux?)\b", sentence[m.end():]):
                continue  # « c'est réservé aux membres » ne dit rien de ce qu'il a fait
            if family == "envoyer" and (_HERE.search(sentence) or has_media or (_TO_YOU.search(m.group(0)) and not _YOUR_CHANNEL.search(sentence))):
                continue  # ce qu'il te donne ici, dans la conversation, n'est pas un envoi
            families.append(family)
        if not families and _DONE_WORDS.search(sentence):
            families.append(FAIT)
        found += [{"famille": f, "phrase": _phrase(sentence), "passe": bool(_LONG_AGO.search(sentence))} for f in families]
    return found[:MAX_CLAIMS]


# La comparaison --------------------------------------------------------------------------------------------------------

def compare(text: str, ledger: Ledger, earlier: set[str] | None = None) -> dict | None:
    """Le reçu de cette réponse, ou None s'il n'y a rien à en dire. `earlier` : ce qui est prouvé dans les tours d'avant de cette conversation."""
    earlier = earlier or set()
    calls = ledger.calls
    receipt: dict = {"prouve": [], "sans_trace": [], "echec": [], "incertain": [], "non_dit": []}
    claims = claims_in(text)
    effects = [c for c in calls if c["famille"] != LECTURE and c["etat"] != ECHEC]
    vague = [c for c in calls if c["etat"] != ECHEC and (c["famille"] == GENERIQUE or (c["famille"] != LECTURE and c["etat"] == LANCE))]
    for claim in claims:
        if claim["famille"] == FAIT:
            if not effects and earlier:
                receipt["incertain"].append({"dit": claim["phrase"], "par": "un tour précédent"})
            elif not effects and _IN_CHAT.search(claim["phrase"]):  # sans doute le résultat est dans la réponse : pas d'alerte, mais pas de preuve non plus
                receipt["incertain"].append({"dit": claim["phrase"], "par": "aucune action de ce tour"})
            elif not effects:
                receipt["sans_trace"].append(claim["phrase"])
            continue
        wanted = _EVIDENCE[claim["famille"]]
        proven = next((c for c in calls if c["famille"] in wanted and c["etat"] == OK), None)
        failed = next((c for c in calls if c["famille"] in wanted and c["etat"] == ECHEC), None)
        if proven:
            receipt["prouve"].append({"dit": claim["phrase"], "par": proven["par"]})
        elif vague:
            receipt["incertain"].append({"dit": claim["phrase"], "par": vague[0]["par"]})
        elif failed:
            receipt["echec"].append({"dit": claim["phrase"], "par": failed["par"]})
        elif wanted & earlier:
            receipt["incertain"].append({"dit": claim["phrase"], "par": "un tour précédent"})  # même genre d'action, pas forcément la même
        elif claim["passe"]:
            receipt["incertain"].append({"dit": claim["phrase"], "par": "un moment passé"})
        else:
            receipt["sans_trace"].append(claim["phrase"])
    claimed = {c["famille"] for c in claims}
    for call in calls:
        family = call["famille"]
        if family in OUTWARD and call["etat"] == OK and family not in claimed and not _MENTION[family].search(text):
            line = _DID[family].format(call["par"])
            if line not in receipt["non_dit"]:
                receipt["non_dit"].append(line)
    done = sorted({c["famille"] for c in calls if c["etat"] == OK and c["famille"] not in (LECTURE, GENERIQUE)})
    if not done and not any(receipt.values()):
        return None
    return {**{k: v for k, v in receipt.items() if v}, "fait": done}


def of_turn(conv_id: str, text: str, ledger: Ledger) -> dict | None:
    """Le reçu ne doit jamais abîmer une tâche finie : un défaut ici le fait taire, rien de plus."""
    try:
        return compare(text, ledger, earlier_proofs(conv_id))
    except Exception as e:  # noqa: BLE001
        print(f"[reçu] {type(e).__name__}", flush=True)
        return None


def needs_attention(receipt: dict | None) -> bool:
    return bool(receipt and (receipt.get("sans_trace") or receipt.get("echec") or receipt.get("non_dit")))


def earlier_proofs(conv_id: str) -> set[str]:
    with db.connect() as c:
        rows = c.execute("SELECT detail FROM messages WHERE conversation_id = ? AND role = 'agent' AND detail IS NOT NULL ORDER BY id DESC LIMIT ?",
                         (conv_id, EARLIER_MESSAGES)).fetchall()
    found: set[str] = set()
    for row in rows:
        found.update((_stored(row["detail"]) or {}).get("fait") or [])
    return found


def _stored(detail: str | None) -> dict | None:
    try:
        data = json.loads(detail or "")
    except ValueError:
        return None
    return data.get("recu") if isinstance(data, dict) else None


def of_last_reply(conv_id: str) -> dict | None:
    """Le reçu de la dernière réponse de cette conversation."""
    with db.connect() as c:
        row = c.execute("SELECT role, detail FROM messages WHERE conversation_id = ? AND role NOT IN ('user', 'trace') ORDER BY id DESC LIMIT 1", (conv_id,)).fetchone()
    return _stored(row["detail"]) if row and row["role"] == "agent" else None


def detail_of(steps: list[str], receipt: dict | None) -> str | None:
    """Ce que le message garde : ses étapes, et son reçu. L'écran lit les deux dans le même champ."""
    if not steps and not receipt:
        return None
    return json.dumps({"etapes": steps, **({"recu": receipt} if receipt else {})}, ensure_ascii=False)


def _listed(items: list) -> str:
    return " ; ".join(f"« {i['dit'] if isinstance(i, dict) else i} »" for i in items)


def note_for_agent(receipt: dict | None) -> str:
    """Il le lit à son prochain message : il peut se corriger sans qu'on le lui réclame. Sans appel au modèle ici."""
    if not needs_attention(receipt):
        return ""
    parts = ["[Noah a comparé ta dernière réponse à ce que tes outils ont fait, et la personne voit ce résultat."]
    if receipt.get("sans_trace"):
        parts.append(f"Aucun outil n'a fait ce que tu as écrit : {_listed(receipt['sans_trace'])}.")
    if receipt.get("echec"):
        parts.append(f"L'outil a échoué pour : {_listed(receipt['echec'])}.")
    if receipt.get("non_dit"):
        parts.append(f"Ton run {' ; '.join(receipt['non_dit'])}, et ta réponse n'en parle pas.")
    parts.append("Si c'est une erreur de ta part, dis-le simplement à la personne et répare. N'affirme une action qu'après l'avoir faite.]")
    return " ".join(parts)


def report_line(receipt: dict | None) -> str:
    """Pour un compte rendu écrit sans personne devant l'écran : les réserves restent dans le texte."""
    if not needs_attention(receipt):
        return ""
    lines = []
    if receipt.get("sans_trace"):
        lines.append(f"Noah n'a vu aucune trace de : {_listed(receipt['sans_trace'])}.")
    if receipt.get("echec"):
        lines.append(f"Noah a vu l'outil échouer pour : {_listed(receipt['echec'])}.")
    if receipt.get("non_dit"):
        lines.append(f"Fait sans le dire : il {' ; '.join(receipt['non_dit'])}.")
    return "\n\n" + "\n".join(lines)


def notice(receipt: dict | None) -> str:
    """Devant la phrase d'une notification : sur le téléphone, on ne lit qu'elle."""
    return "À vérifier : " if needs_attention(receipt) else ""
