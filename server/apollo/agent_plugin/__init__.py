"""Plugin Hermes « noah-garde », posé par Noah Agent dans la machine de chaque agent (G7.6).

Contre-exemple : ClawHavoc, 341 skills malveillants sur 2 857 dans un catalogue ouvert, qui demandaient d'installer
un « prérequis » téléchargé. Hermes analyse déjà un skill avant de l'installer, mais laisse passer un skill
communautaire jugé sûr, sans signature. Ici :

- un skill ne s'installe que depuis un dépôt vérifié d'Hermes (openai, anthropics, huggingface, NVIDIA), jamais
  avec --force (qui passe outre l'analyse) ;
- aucun script téléchargé n'est exécuté sans avoir été lu : ni d'un trait (curl … | sh, bash <(curl …),
  sh -c "$(curl …)", iex (iwr …)), ni téléchargé dans un fichier puis lancé. Un fichier téléchargé (curl -o,
  wget -O, curl … > f) ne s'exécute qu'après que l'agent l'a lu (read_file, cat, less, head) : il sait alors ce qu'il
  lance et peut le dire.

Les skills que l'agent écrit lui-même (skill_manage) restent permis : ils passent par l'analyse d'Hermes.
Limite : c'est un filtre de commandes, pas un bac à sable. Il ferme le schéma courant des skills piégés (un prérequis
à lancer sans le lire) ; un agent décidé à le contourner le pourrait, d'où les autres protections (machine isolée,
aucun secret de Noah dans l'agent, accord demandé pour les actions sensibles).
"""
import os
import re
import shlex

TRUSTED = ("openai/skills", "anthropics/skills", "huggingface/skills", "NVIDIA/skills")
INSTALL = re.compile(r"\b(?:hermes\s+skills\s+(?:install|add)|npx\s+(?:-y\s+)?skills\s+add|clawhub\s+install)\s+(\S+)")
DOWNLOADER = r"(?:curl|wget|iwr|invoke-webrequest|fetch)"
PIPE_TO_SHELL = re.compile(
    rf"{DOWNLOADER}\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python3?|node|perl|ruby|iex)\b"
    r"|(?:sh|bash|zsh|source|\.)\s+<\(\s*(?:curl|wget)"
    r"|\$\(\s*(?:curl|wget)\b|`\s*(?:curl|wget)\b"  # sh -c "$(curl …)", eval `wget -qO- …`
    r"|iex\s*\(\s*(?:iwr|invoke-webrequest|new-object\s+net\.webclient)",
    re.I,
)
RUNNERS = {"sh", "bash", "zsh", "dash", "source", ".", "python", "python3", "node", "perl", "ruby", "exec"}
READERS = {"cat", "less", "more", "head", "tail", "bat", "nl"}

# Fichiers téléchargés et pas encore lus, d'un appel à l'autre (une machine = un agent).
_unread: set[str] = set()


def _name(path: str) -> str:
    """Nom du fichier seul : l'agent peut le télécharger en relatif et le lire en absolu (ou l'inverse)."""
    return os.path.basename(path.strip("'\"").rstrip("/")) or path


def _words(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.split()


def _downloads(words: list[str]) -> list[str]:
    """Fichiers écrits par curl/wget dans cette commande (-o, -O, --output, --output-document, redirection >)."""
    out = []
    for i, w in enumerate(words):
        if w in ("-o", "--output", "-O", "--output-document") and i + 1 < len(words):
            if words[i + 1] != "-":
                out.append(words[i + 1])
        elif w.startswith(("--output=", "--output-document=")):
            out.append(w.split("=", 1)[1])
        elif w in (">", ">>") and i + 1 < len(words):
            out.append(words[i + 1])
        elif w.startswith(">") and len(w.lstrip(">")) > 0:  # curl … >f
            out.append(w.lstrip(">"))
    if "-O" in words or "--remote-name" in words:  # curl -O : nom tiré de l'adresse
        out += [w.rsplit("/", 1)[-1] for w in words if w.startswith(("http://", "https://"))]
    return [_name(f) for f in out if f]


def _executed(words: list[str]) -> set[str]:
    """Fichiers lancés : `sh f`, `bash f`, `python3 f`, `. f`, `./f`, `/chemin/f`."""
    out = set()
    for i, w in enumerate(words):
        if w in RUNNERS and i + 1 < len(words) and not words[i + 1].startswith("-"):
            out.add(_name(words[i + 1]))
        elif w.startswith(("./", "/")) and (i == 0 or words[i - 1] in ("&&", ";", "||", "|", "sudo", "then", "do")):
            out.add(_name(w))
    return out


def _segments(command: str) -> list[list[str]]:
    return [_words(part) for part in re.split(r"&&|\|\||;|\n", command) if part.strip()]


def check(command: str) -> str | None:
    """Raison du refus, ou None si la commande passe. Tient la liste des fichiers téléchargés non lus."""
    if PIPE_TO_SHELL.search(command):
        return ("Noah refuse d'exécuter un script téléchargé d'un trait. Télécharge-le dans un fichier, lis-le, puis "
                "lance-le en expliquant à l'utilisateur ce qu'il fait.")
    for m in INSTALL.finditer(command):
        source = m.group(1).strip("'\"").removeprefix("https://github.com/")
        if "--force" in command:
            return "Noah refuse --force à l'installation d'un skill : l'analyse de sécurité doit passer."
        if not source.startswith(TRUSTED):
            return (f"Noah n'installe pas de skill tiers non vérifié ({source}). Seuls les dépôts vérifiés "
                    f"({', '.join(TRUSTED)}) sont permis ; sinon, écris toi-même le skill avec skill_manage.")
    unread = set(_unread)
    for words in _segments(command):
        if words and words[0] in READERS:
            unread -= {_name(w) for w in words[1:] if not w.startswith("-")}
            continue
        blind = _executed(words) & unread
        if blind:
            return (f"Noah refuse de lancer {', '.join(sorted(blind))} : ce fichier vient d'être téléchargé et tu ne "
                    "l'as pas lu. Lis-le (read_file), vérifie ce qu'il fait, puis lance-le en le disant à l'utilisateur.")
        if words and re.fullmatch(DOWNLOADER, words[0], re.I):
            unread |= set(_downloads(words))
    _unread.clear()
    _unread.update(unread)
    return None


def _pre_tool_call(tool_name: str = "", args: dict | None = None, **_) -> dict | None:
    if not isinstance(args, dict):
        return None
    if tool_name == "read_file":
        _unread.discard(_name(str(args.get("path", ""))))
        return None
    if tool_name != "terminal":
        return None
    reason = check(str(args.get("command", "")))
    return {"action": "block", "message": reason} if reason else None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
