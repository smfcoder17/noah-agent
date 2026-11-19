"""Masquage d'affichage des notifications, réglé par compte ; et des clés d'API collées dans la conversation, toujours."""
import re

# Les formes publiées des clés courantes (OpenAI et compatibles, Stripe, GitHub, Slack, AWS, Google) et les jetons JWT. Le préfixe
# reste lisible : la personne et l'agent savent de quel service il s'agit, sans que la clé passe par le modèle ni par un titre.
KEYS = re.compile(
    r"(?<![\w-])(?:"
    r"(sk-)[A-Za-z0-9_-]{16,}"
    r"|((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{10,}"
    r"|(gh[pousr]_)[A-Za-z0-9]{20,}"
    r"|(github_pat_)[A-Za-z0-9_]{20,}"
    r"|(xox[abposr]-)[A-Za-z0-9-]{10,}"
    r"|(AKIA)[0-9A-Z]{16}(?![0-9A-Za-z])"
    r"|(AIza)[0-9A-Za-z_-]{30,}"
    r"|(gsk_|xai-|hf_|r8_|pplx-|nvapi-|tvly-|fc-)[A-Za-z0-9_-]{20,}"  # Groq, xAI, Hugging Face, Replicate, Perplexity, NVIDIA, Tavily, Firecrawl
    r"|(eyJ)[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r")")
# Une clé longue d'un fournisseur sans préfixe connu : seulement quand la phrase la nomme (« clé d'API : … », « token = … », « Bearer … »).
CONTEXT = re.compile(r"(?i)\b((?:api[ _-]?key|apikey|secret(?:[ _-]?key)?|access[ _-]?token|auth[ _-]?token|token|bearer|cl[ée](?: d'api| secr[èe]te)?)(?:\s*[:=]\s*|\s+(?:est\s+)?)[\"'`]?)([A-Za-z0-9][A-Za-z0-9_\-./+=]{23,})")
KEY_SHOWN = "•••• (clé masquée)"


def _long_key(m: re.Match) -> str:
    """Seulement une suite qui ressemble à une clé : des lettres et des chiffres mêlés (ni un mot, ni un nombre, ni une adresse)."""
    value = m.group(2)
    if not (re.search(r"[A-Za-z]", value) and re.search(r"\d", value)) or re.match(r"https?:|/", value):
        return m.group(0)
    return m.group(1) + KEY_SHOWN


def mask_keys(value: str) -> str:
    """Une clé collée devient « sk-•••• (clé masquée) » : ni le modèle, ni les titres, ni les journaux, ni une route de lecture ne la gardent."""
    value = KEYS.sub(lambda m: next(g for g in m.groups() if g) + KEY_SHOWN, str(value))
    return CONTEXT.sub(_long_key, value)


def keys_in(value: str) -> list[str]:
    """Les clés que contient ce texte, en clair : pour les ranger au coffre depuis le serveur, jamais pour les rendre."""
    found = [m.group(0) for m in KEYS.finditer(str(value))]
    found += [m.group(2) for m in CONTEXT.finditer(str(value)) if _long_key(m) != m.group(0)]
    return list(dict.fromkeys(found))


def luhn(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if not 13 <= len(digits) <= 19 or len(set(digits)) < 2:
        return False
    total = 0
    for i, char in enumerate(reversed(digits)):
        n = int(char) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def mask(value: str) -> str:
    value = mask_keys(value)
    value = re.sub(r"[\w.!#$%&'*+/=?^`{|}~-]+@([\w-]+\.)+[\w-]+", lambda m: m[0].split("@")[0][:2] + "•••@" + m[0].split("@")[1][:1] + "•••." + m[0].split(".")[-1], value)
    cards = re.compile(r"(?<!\d)(?=((?:(?:\d{4}[ -]){2}\d{4}[ -]\d{1,4}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19}))(?!\d))")
    spans, end = [], 0
    for m in cards.finditer(value):
        if m.start() >= end and luhn(m[1]):
            end = m.start() + len(m[1])
            spans.append((m.start(), end, "•••• •••• •••• " + re.sub(r"\D", "", m[1])[-4:]))
    for start, end, replacement in reversed(spans):
        value = value[:start] + replacement + value[end:]
    def phone(m):
        n = re.sub(r"\D", "", m[0])
        return ("+" if m[0].startswith("+") else "") + n[:2] + " ••• •• " + n[-2:] if 10 <= len(n) <= 15 else m[0]
    return re.sub(r"(?<![\w\d])(?:\+\d{1,3}[ .()-]*|0)(?:\d[ .()-]*){8,13}\d(?!\d)|(?<![\w\d])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)", phone, value)
