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

# Fichiers téléchargés et pas encore lus, d'un appel à l'autre (une machine = un agent). Une lecture ne compte que
# dans un appel à part : l'agent voit le contenu avant de décider de le lancer (cat f && sh f ne le lui montre pas).
_unread: set[str] = set()


def _path(path: str) -> str:
    return os.path.normpath(path.strip("'\"")) if path.strip("'\"") else ""


def _same(a: str, b: str) -> bool:
    """Même fichier : chemins égaux, ou l'un des deux relatif (dossier courant inconnu) et même nom."""
    if a == b:
        return True
    if os.path.isabs(a) and os.path.isabs(b):
        return False
    return os.path.basename(a) == os.path.basename(b)


def _hits(paths: set[str], unread: set[str]) -> set[str]:
    return {p for p in paths for u in unread if _same(p, u)}


def _words(command: str) -> list[str]:
    try:
        lex = shlex.shlex(command, posix=True, punctuation_chars="|<>")
        lex.whitespace_split = True
        return list(lex)
    except ValueError:
        return command.split()


def _downloads(words: list[str]) -> list[str]:
    """Fichiers écrits par curl/wget (-o f, -of, -O f, --output=f, > f, curl -O d'après l'adresse)."""
    out = []
    for i, w in enumerate(words):
        nxt = words[i + 1] if i + 1 < len(words) else ""
        if w in ("-o", "--output", "-O", "--output-document"):
            if nxt and nxt != "-" and not nxt.startswith("http"):
                out.append(nxt)
        elif w.startswith(("--output=", "--output-document=")):
            out.append(w.split("=", 1)[1])
        elif (m := re.fullmatch(r"-[a-zA-Z]*?[oO](.+)", w)) and not w.startswith("--"):  # -o/tmp/f, -sSLo/tmp/f
            out.append(m.group(1))
        elif w in (">", ">>") and nxt:
            out.append(nxt)
    if "-O" in words or "--remote-name" in words or any(re.fullmatch(r"-[a-zA-Z]*O", w) for w in words):
        out += [w.rsplit("/", 1)[-1] for w in words if w.startswith(("http://", "https://"))]
    return [_path(f) for f in out if f and f != "-"]


def _executed(words: list[str]) -> set[str]:
    """Fichiers lancés : `sh f`, `bash -e f`, `python3 -u f`, `. f`, `./f`, `/chemin/f`, `sh < f`, `cat f | sh`,
    et ce que lance `bash -c "…"`."""
    out: set[str] = set()
    i = 0
    while i < len(words):
        w = words[i]
        if os.path.basename(w) in RUNNERS:
            j = i + 1
            while j < len(words) and words[j].startswith("-"):
                if words[j] == "-c" and j + 1 < len(words):  # commande en texte : vérifiée comme une commande
                    for seg in _segments(words[j + 1]):
                        out |= _executed(seg)
                    j = len(words)
                    break
                if words[j] == "-m":  # python -m module : pas un fichier
                    j = len(words)
                    break
                j += 1
            if j < len(words) and words[j] == "<" and j + 1 < len(words):
                out.add(_path(words[j + 1]))
            elif j < len(words) and words[j] not in ("|", "<", ">", ">>"):
                out.add(_path(words[j]))
        elif w.startswith(("./", "/")) and (i == 0 or words[i - 1] in ("|", "sudo", "then", "do", "exec", "env")):
            out.add(_path(w))
        elif w == "|" and i + 1 < len(words) and os.path.basename(words[i + 1]) in RUNNERS:
            # cat f | sh : le contenu de f est lancé
            out |= {_path(x) for x in words[:i] if not x.startswith("-") and x not in READERS and x not in ("|", "<", ">")}
        i += 1
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
    unread, read_now = set(_unread), set()
    for words in _segments(command):
        if words and words[0] in READERS and "|" not in words:
            read_now |= {_path(w) for w in words[1:] if not w.startswith("-")}
            continue
        blind = _hits(_executed(words), unread)
        if blind:
            return (f"Noah refuse de lancer {', '.join(sorted(blind))} : ce fichier a été téléchargé et tu ne l'as "
                    "pas encore lu. Lis-le d'abord (read_file, dans un appel à part), vérifie ce qu'il fait, puis "
                    "lance-le en le disant à l'utilisateur.")
        if words and re.fullmatch(DOWNLOADER, os.path.basename(words[0]), re.I):
            unread |= set(_downloads(words))
    # Lu dans cette commande : compte pour les suivantes (l'agent a vu le contenu dans le résultat).
    _unread.clear()
    _unread.update(u for u in unread if not any(_same(u, r) for r in read_now))
    return None


def _pre_tool_call(tool_name: str = "", args: dict | None = None, **_) -> dict | None:
    if not isinstance(args, dict):
        return None
    if tool_name == "read_file":
        read = _path(str(args.get("path", "")))
        _unread.difference_update({u for u in _unread if _same(u, read)})
        return None
    if tool_name != "terminal":
        return None
    reason = check(str(args.get("command", "")))
    return {"action": "block", "message": reason} if reason else None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
