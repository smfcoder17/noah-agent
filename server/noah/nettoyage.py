"""Un seul nettoyage pour tout ce qui s'écrit ou se relit dans un fil (0.4.0, L4 : X31 et X17).

Les marques de Noah n'ont rien à faire à l'écran : la réaction `[[👍]]` que l'agent met en tête, `[SILENT]` (« ne rien écrire »), les caractères codés
(`\\u00a0`, `\\x1b`, séquences ANSI, caractères invisibles), les balises `<releve>`, et la consigne « [Personne ne t'a écrit : … ] » que Noah envoie à
l'agent. Une clé d'API collée ne se relit jamais en clair.

Deux moments, la même règle :
- à l'écriture (`routes_chat._save_message`, titres, résumés, passages de routine) : ce qui est interne n'est pas posé, ou posé propre ;
- à la lecture (`routes_conversations.messages_page`, tâches, titres, Activité) : un ancien message déjà en base sort propre lui aussi, et la base
  n'est pas réécrite (rien n'est perdu : la clé d'une vieille conversation se range encore au coffre depuis le serveur, voir `coffre.py`).
Le même nettoyage existe côté interface (`frontend/src/lib/nettoyage.ts`) pour un serveur plus ancien que l'écran."""
import json
import re

from . import sensitive

# Le texte d'une consigne que Noah donne à l'agent : jamais une parole de la personne.
CONSIGNE = re.compile(r"^\s*\[Personne ne t.a écrit")
_RELEVE = re.compile(r"<releve>\s*\n?(.*?)(?:\n|</releve>)", re.S)
_SILENCE_SEUL = re.compile(r"(?im)^[ \t]*\[SILENT\][ \t]*$")
_SILENCE = re.compile(r"\[SILENT\]", re.I)
_BALISES = re.compile(r"</?releve>", re.I)
# Une réaction : doubles crochets autour d'un symbole, sans lettre ni chiffre (`[[👍]]`, `[[✅]]`). Un `[[lien]]` écrit avec des mots reste.
_REACTION = re.compile(r"\[\[[^\[\]\w\n]{1,16}\]\]")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b")
_INVISIBLES = re.compile("[" + "\x00-\x08\x0b\x0c\x0e-\x1f\x7f" + "\N{ZERO WIDTH SPACE}\N{WORD JOINER}\N{ZERO WIDTH NO-BREAK SPACE}" + chr(0xE000) + "-" + chr(0xF8FF) + "]")  # le liant d'émojis reste : il fait les familles
_CODE = re.compile(r"(```[\s\S]*?(?:```|\Z)|`[^`\n]+`)")
_ECHAPPE = re.compile(r"\\u([0-9a-fA-F]{4})(?:\\u([dD][c-fC-F][0-9a-fA-F]{2}))?|\\x([0-9a-fA-F]{2})")


def _decoder(m: re.Match) -> str:
    """`\\u00a0` écrit en toutes lettres devient le caractère (une espace pour les espaces insécables) ; un caractère de contrôle disparaît."""
    if m.group(3) is not None:
        code = int(m.group(3), 16)
    else:
        code = int(m.group(1), 16)
        if m.group(2) and 0xD800 <= code <= 0xDBFF:  # paire de substitution : un seul caractère
            code = 0x10000 + ((code - 0xD800) << 10) + (int(m.group(2), 16) - 0xDC00)
        elif 0xD800 <= code <= 0xDFFF:
            return ""
    char = chr(code)
    if code == 27:  # ESC : la séquence ANSI qui suit part avec lui, juste après
        return char
    if code in (0xA0, 0x202F, 0x2007, 0x2009, 0x200A, 0x3000):  # les espaces insécables deviennent une espace
        return " "
    return "" if (code < 32 and char not in "\n\t") or code == 127 or code in (0x200B, 0x2060, 0xFEFF) else char


def interne(text: str | None) -> str:
    """Le texte sans rien d'interne. Le code (blocs et `en ligne`) n'est pas touché : ce qu'il montre est ce que l'agent a écrit."""
    text = str(text or "")
    if not text:
        return ""
    text = _ANSI.sub("", text)
    parts = _CODE.split(text)
    for i in range(0, len(parts), 2):  # les indices pairs sont hors du code
        p = _INVISIBLES.sub("", parts[i])
        p = _ANSI.sub("", _ECHAPPE.sub(_decoder, p))  # un `\x1b[0m` écrit en toutes lettres devient une séquence ANSI : elle part aussi
        p = _REACTION.sub("", p)
        p = _SILENCE.sub("", p)
        p = _BALISES.sub("", p)
        parts[i] = p
    for i in range(1, len(parts), 2):
        parts[i] = _INVISIBLES.sub("", parts[i])
    cleaned = "".join(parts)
    if cleaned != text:  # une marque est partie : l'espace qu'elle laisse en tête, ou trois sauts de ligne de suite, partent avec
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


def silence(text: str | None) -> bool:
    """Vrai si l'agent a dit « ne rien écrire » : `[SILENT]` seul sur sa ligne, ou au début ou à la fin de son texte. Un `[SILENT]` au milieu
    d'une phrase est une marque oubliée, pas un silence : il est retiré, le message reste."""
    text = str(text or "")
    stripped = text.strip()
    return bool(_SILENCE_SEUL.search(text)) or stripped.upper().startswith("[SILENT]") or stripped.upper().endswith("[SILENT]")


def est_consigne(text: str | None) -> bool:
    """La consigne que Noah donne à l'agent (réveil d'une initiative, reprise d'un tour coupé) : ce n'est pas la personne qui l'a écrite."""
    return bool(CONSIGNE.match(str(text or "")))


def ligne_consigne(text: str | None) -> str:
    """Ce que la personne lit à la place : une ligne, du côté de l'agent."""
    text = str(text or "")
    if "s'est coupé" in text.split("\n", 1)[0]:
        return "Noah reprend ce travail là où il s'est arrêté."
    found = _RELEVE.search(text)
    title = " ".join(interne(found.group(1)).split()) if found else ""
    return f"Noah a relevé : {title}." if title else "Noah a relevé quelque chose à traiter."


def pose(role: str, text: str | None) -> str | None:
    """Ce qui s'écrit dans un fil, ou None : rien n'est posé. Une parole de la personne reste la sienne (sa clé, masquée à part) ;
    la consigne de Noah n'est pas une parole de la personne ; l'agent qui dit « [SILENT] » ne dit rien."""
    text = str(text or "")
    if role == "user":
        return None if est_consigne(text) else text
    if role not in ("agent", "error"):
        return text
    if silence(text):
        return None
    cleaned = interne(text)
    return cleaned if cleaned.strip() else None


def lecture(text: str | None) -> str:
    """Ce qu'une route rend d'un texte de fil : sans marque interne, et sans clé d'API en clair."""
    return sensitive.mask_keys(interne(text))


def dans(valeur):
    """Les textes d'une structure rendue à l'écran (question en attente, échanges d'une tâche…), nettoyés comme `lecture`."""
    if isinstance(valeur, str):
        return lecture(valeur)
    if isinstance(valeur, list):
        return [dans(v) for v in valeur]
    if isinstance(valeur, dict):
        return {k: dans(v) for k, v in valeur.items()}
    return valeur


def _plat(text: str) -> str:
    text = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*`#>|]+|(?<!\w)_+|_+(?!\w)", " ", text)
    return " ".join(text.split())


def ligne(text: str | None) -> str:
    """Un titre, une ligne de trace, un résumé : une ligne propre, sans Markdown, sans marque interne, sans clé en clair."""
    return _plat(lecture(text))


def message_lu(row: dict) -> dict | None:
    """Une ligne de `messages` telle que l'écran la lit (`routes_conversations.messages_page`), ou None : elle ne s'affiche pas
    (un `[SILENT]` déjà en base). La base reste telle quelle."""
    role, text = row.get("role"), row.get("text") or ""
    out = dict(row)
    if role == "user":
        if est_consigne(text):  # une ancienne consigne en bulle de la personne : une ligne lisible, du côté de l'agent
            out.update(role="agent", text=ligne_consigne(text), detail=None, model=None)
            return out
        out["text"] = sensitive.mask_keys(text)
        return out
    if role == "trace":
        out["text"] = lecture(text)
        out["detail"] = trace_lue(row.get("detail"))
        return out
    if role in ("agent", "error"):
        if silence(text) or not interne(text).strip():
            return None
    out["text"] = lecture(text)
    if out.get("detail"):
        out["detail"] = sensitive.mask_keys(out["detail"])
    return out


def trace_lue(detail: str | None) -> str | None:
    """Le détail d'une trace de fil (JSON : fil, entete, consigne, etat, issue) : ses phrases passent par le même nettoyage."""
    if not detail:
        return detail
    try:
        data = json.loads(detail)
    except ValueError:
        return sensitive.mask_keys(detail)
    if not isinstance(data, dict):
        return sensitive.mask_keys(detail)
    for key in ("entete", "consigne", "issue"):
        if isinstance(data.get(key), str):
            data[key] = lecture(data[key])
    return json.dumps(data, ensure_ascii=False)
