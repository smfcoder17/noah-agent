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

Outils MCP (G13.2) : chaque serveur a un droit choisi par l'utilisateur, écrit par le lanceur en root dans /etc/noah/mcp-droits.json. `lire` :
seuls les outils que le serveur déclare en lecture ; `agir` : tout ; `confirmer` (par défaut, y compris fichier absent ou
illisible) : hors lecture déclarée, l'appel passe par la validation humaine d'Hermes, la même que les commandes dangereuses, et Noah répond
« une fois » seulement. Dans une routine, personne ne peut valider : refus. L'agent ne branche pas de serveur MCP lui-même.

Mémoire : une note ne dure que si elle sert à chaque message. Avant qu'elle entre, Noah la fait juger par le petit modèle de décision
(voir decision.py). Qu'il soit en panne ou trop lent, et la note entre : une note de trop se retire dans Détails, une note perdue ne revient pas.

Limite : c'est un filtre de commandes, pas un bac à sable. Il ferme le schéma courant des skills piégés (un prérequis
à lancer sans le lire) ; un agent décidé à le contourner le pourrait, d'où les autres protections (machine isolée,
aucun secret de Noah dans l'agent, accord demandé pour les actions sensibles).
"""
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import uuid

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
MCP_CONFIG = re.compile(r"\bhermes\s+mcp\s+(?:add|install|remove|rm|configure|reauth|login)\b", re.I)
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
    if MCP_CONFIG.search(command):
        return ("Noah refuse de changer les serveurs MCP depuis la machine de l'agent : une commande locale exécuterait du "
                "code téléchargé. L'utilisateur ajoute ses outils dans Détails → Connexions.")
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
        if len(words) >= 6 and os.path.basename(words[1]) == "noah.py" and words[2:4] == ["navigateur", "telecharger"]:
            unread.add(_path(f"{WORKSPACE}/uploads/{words[5]}"))
    # Lu dans cette commande : compte pour les suivantes (l'agent a vu le contenu dans le résultat).
    _unread.clear()
    _unread.update(u for u in unread if not any(_same(u, r) for r in read_now))
    return None


# --- Droits des outils MCP -----------------------------------------------------------------------------------------

MCP_RIGHTS = os.environ.get("NOAH_MCP_DROITS", "/etc/noah/mcp-droits.json")


def _rights() -> dict:
    try:
        with open(MCP_RIGHTS, encoding="utf-8") as f:
            rights = json.load(f)
        return rights if isinstance(rights, dict) else {}
    except (OSError, ValueError):
        return {}


def _mcp_parts(tool_name: str, rights: dict) -> tuple[str, str]:
    """mcp__<serveur>__<outil> : Hermes remplace « - » par « _ » dans le nom, sa table d'outils garde le vrai serveur."""
    server = ""
    try:
        from tools.registry import registry
        toolset = registry.get_toolset_for_tool(tool_name) or ""
        server = toolset.removeprefix("mcp-") if toolset.startswith("mcp-") else ""
    except Exception:  # noqa: BLE001 - hors d'Hermes, ou table en cours de changement : on déduit du nom
        pass
    rest = tool_name.removeprefix("mcp__")
    known = {name.replace("-", "_"): name for name in rights}
    if not server:
        head = rest.split("__", 1)[0]
        server = known.get(head, head)
    head = server.replace("-", "_")
    return server, rest[len(head) + 2:] if rest.startswith(head + "__") else rest


def _read_only(server: str, tool: str) -> bool:
    """Ce que le serveur a déclaré à Hermes ; inconnu ou pas encore lu : pas en lecture."""
    try:
        from tools.mcp_tool_handlers import _tool_is_read_only
        return _tool_is_read_only(server, tool) is True
    except Exception:  # noqa: BLE001
        return False


def _unattended() -> bool:
    try:
        from tools.approval_context import _is_cron_approval_context
        return bool(_is_cron_approval_context())
    except Exception:  # noqa: BLE001 - le portail d'Hermes refuse de lui-même sans personne pour répondre
        return False


def check_mcp(tool_name: str, args: dict) -> dict | None:
    """La décision pour un appel d'outil MCP : rien (il passe), un refus, ou la validation humaine d'Hermes."""
    rights = _rights()
    server, tool = _mcp_parts(tool_name, rights)
    droit = rights.get(server, "confirmer")
    if droit == "agir":
        return None
    if droit == "lire":
        if _read_only(server, tool):
            return None
        return {"action": "block", "message": (
            f"Noah refuse : « {server} » est en lecture seule sur cet agent et « {tool} » n'est pas déclaré en lecture. "
            "Dis-le à l'utilisateur ; il peut changer ce droit dans Détails → Connexions.")}
    if _read_only(server, tool):  # ce que le serveur déclare en lecture : pas d'accord, ni de routine bloquée pour une lecture
        return None
    if _unattended():
        return {"action": "block", "message": (
            f"Noah refuse : « {server} » demande la confirmation de l'utilisateur et personne ne peut la donner pendant une "
            "routine. Continue sans cet outil et signale-le dans ton compte rendu ; l'utilisateur peut passer ce droit à "
            "« agir » dans Détails → Connexions.")}
    shown = json.dumps(args, ensure_ascii=False, default=str)
    if len(shown) > 600:  # le serveur compare à ce qui a été montré : ce qui dépasse compte aussi, par son empreinte
        shown = f"{shown[:600]}… [empreinte {hashlib.sha256(shown.encode()).hexdigest()[:16]}]"
    # Clé neuve à chaque appel : aucun accord ne se réutilise, même si un client répondait « pour la session ».
    return {"action": "approve", "rule_key": f"noah-mcp-{uuid.uuid4().hex}",
            "message": f"Outil « {server} » : {tool}\n{shown}"}


_browser_awake_at = 0.0


def _wake_browser() -> None:
    """Le navigateur ne tourne que quand on s'en sert : le premier outil qui le demande attend qu'il soit prêt."""
    global _browser_awake_at
    if time.monotonic() - _browser_awake_at < 60:
        return
    try:
        done = subprocess.run([sys.executable, "/opt/data/noah.py", "navigateur", "reveiller"], capture_output=True, timeout=900)
        if json.loads(done.stdout).get("joignable"):
            _browser_awake_at = time.monotonic()
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        pass  # l'outil dira lui-même qu'il n'a pas de navigateur


# --- Partage de l'agent (G12.5) ------------------------------------------------------------------------------------------
# Une personne avec qui l'agent est partagé tourne dans son propre profil Hermes : mémoire, sessions et navigateur à elle. Le
# terminal, lui, lit toute la machine, y compris la mémoire et les jetons du propriétaire : rien ne s'y exécute dans ce profil,
# sauf les commandes de noah.py qui ne touchent ni aux comptes ni à la machine. Liste de ce qui est permis : un outil nouveau
# d'Hermes reste fermé. Dans l'autre sens, le propriétaire ne fouille pas les profils : filtre, pas bac à sable, il reste maître
# de sa machine (c'est dit au partage).
DATA = "/opt/data"
GUEST_ROOT = f"{DATA}/profiles/"
WORKSPACE = f"{DATA}/workspace"
GUEST_TOOLS = {"memory", "session_search", "todo", "clarify", "web_search", "web_extract", "vision_analyze", "image_generate",
               "text_to_speech", "skills_list", "skill_view"}
GUEST_FILES = {"read_file", "write_file", "patch", "search_files"}
GUEST_NOAH = {"image", "video", "musique", "voix", "rappeler", "navigateur", "fil", "fil-etat"}
GUEST_BROWSER = {"reveiller", "redemarrer"}
OPERATORS = set(";&|<>()")


def _home() -> str:
    """Dossier du profil Hermes de ce tour : celui de la requête en cours, pas celui du processus."""
    try:
        from hermes_constants import get_hermes_home
        return str(get_hermes_home())
    except Exception:  # noqa: BLE001 - hors d'Hermes
        return os.environ.get("HERMES_HOME", DATA)


def _guest_path_ok(path: str, home: str) -> bool:
    """Le dossier de travail commun, et les images que ses propres outils ont rangées dans son profil."""
    path = path.strip()
    if not path or path.startswith("~"):
        return False
    full = os.path.realpath(os.path.join(WORKSPACE, path))
    own = tuple(os.path.join(home, d) + "/" for d in ("cache", "image_cache", "browser_screenshots", "audio_cache"))
    return full == WORKSPACE or full.startswith(WORKSPACE + "/") or full.startswith(own)


def _guest_command_ok(command: str) -> bool:
    if re.search(r"[$`\n\r]", command):
        return False
    try:
        lex = shlex.shlex(command, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        words = list(lex)
    except ValueError:
        return False
    if any(w and set(w) <= OPERATORS for w in words):
        return False
    if len(words) >= 4 and words[2] == "navigateur" and words[3] not in GUEST_BROWSER:
        return False  # joindre ou télécharger lit le disque commun, avec la clé du navigateur partagée entre les profils
    return len(words) >= 3 and words[0] == "python3" and words[1] == f"{DATA}/noah.py" and words[2] in GUEST_NOAH


_PATCH_FILE = re.compile(r"\*\*\*\s*(?:update|add|delete)\s+file:\s*(.+)", re.I)
_PATCH_MOVE = re.compile(r"\*\*\*\s*move\s+file:\s*(.+?)\s*->\s*(.+)", re.I)
_PATCH_MOVE_TO = re.compile(r"\*\*\*\s*move\s+to:\s*(.+)", re.I)
_PATCH_FRAME = re.compile(r"^\s*\*\*\*\s*(?:begin\s+patch|end\s+patch|end\s+of\s+file)\s*$", re.I)
_UNKNOWN_PATCH = "/"  # une opération qu'on ne sait pas lire vaut un chemin toujours refusé à une personne invitée


def _patch_targets(args: dict) -> list[str]:
    """Les fichiers qu'un patch V4A touche vraiment : ils sont dans ses en-têtes, pas dans son argument « path ». Hermes reconnaît
    ces en-têtes n'importe où dans la ligne (tools/patch_parser.py), donc on les cherche de même ; un faux positif refuse, jamais l'inverse."""
    targets: list[str] = []
    for line in str(args.get("patch") or "").split("\n"):
        line = line.removesuffix("\r")
        move = _PATCH_MOVE.search(line)
        one = _PATCH_FILE.search(line) or _PATCH_MOVE_TO.search(line)
        if move:
            targets += [move.group(1).strip(), move.group(2).strip()]
        elif one:
            targets.append(one.group(1).strip())
        elif line.lstrip().startswith("***") and not _PATCH_FRAME.match(line):
            targets.append(_UNKNOWN_PATCH)
    return targets


def check_guest(tool_name: str, args: dict, home: str) -> str | None:
    """Raison du refus d'un outil dans le profil d'une personne avec qui l'agent est partagé, ou None."""
    if tool_name.startswith("browser_") or tool_name in GUEST_TOOLS and tool_name != "vision_analyze":
        return None
    if tool_name == "terminal":
        if _guest_command_ok(str(args.get("command", ""))):
            return None
        return ("Noah refuse : cette personne n'a pas de terminal sur cet agent, seulement `python3 /opt/data/noah.py` pour créer un "
                "média, ouvrir un fil ou rappeler. Seul son propriétaire peut lui donner plus (droit admin). Dis-le simplement.")
    if tool_name == "vision_analyze":
        url = str(args.get("image_url", ""))
        if url.startswith(("http://", "https://")) or _guest_path_ok(url, home):
            return None
    elif tool_name in GUEST_FILES:
        path = args.get("path") if "path" in args else "." if tool_name == "search_files" else ""
        if tool_name == "search_files" and path == ".":
            return None  # le terminal et ses fichiers partent du dossier de travail
        targets = _patch_targets(args)
        # En mode patch, Hermes n'utilise pas « path » : seules les cibles comptent, et un patch sans cible n'a rien à faire ici.
        wanted = targets if args.get("mode") == "patch" else [str(path or ""), *targets]
        if wanted and all(_guest_path_ok(t, home) for t in wanted):
            return None
    else:
        return f"Noah refuse : l'outil « {tool_name} » n'est pas ouvert à cette personne sur cet agent. Dis-le simplement."
    return ("Noah refuse : cette personne n'accède qu'au dossier de travail commun, /opt/data/workspace, et pas au reste de la "
            "machine de l'agent. Dis-le simplement.")


def check_owner(tool_name: str, args: dict) -> str | None:
    """Dans le profil de l'agent : ce qu'une personne a confié à son profil ne se lit pas en passant."""
    if tool_name == "terminal":
        hit = GUEST_ROOT.rstrip("/") in str(args.get("command", "")) or re.search(r"(^|[\s'\"/])\.\./profiles\b", str(args.get("command", "")))
    elif tool_name in GUEST_FILES or tool_name == "vision_analyze":
        path = str(args.get("path") or args.get("image_url") or "")
        hit = any(not p.startswith(("http://", "https://")) and os.path.realpath(os.path.join(WORKSPACE, p)).startswith(GUEST_ROOT)
                  for p in [path, *_patch_targets(args)])
    else:
        return None
    return ("Noah refuse : ce dossier tient la mémoire privée des personnes avec qui cet agent est partagé." if hit else None)


MEMORY_JUDGE_SECONDS = 8


def _new_notes(args: dict) -> list[str]:
    """Le texte des notes que cet appel ajoute, seul ou en lot. Un retrait ou une retouche n'ajoute rien : pas d'appel."""
    ops = args.get("operations") if isinstance(args.get("operations"), list) else [args]
    return [str(op.get("content") or op.get("new_text") or "") for op in ops if isinstance(op, dict) and op.get("action") == "add"]


def check_memory(args: dict) -> str | None:
    """Raison du refus d'une note, ou None. Jamais d'erreur : sans réponse à temps, la note entre."""
    notes = [n for n in _new_notes(args) if n.strip()]
    if not notes:
        return None
    body = json.dumps({"cible": args.get("target") if args.get("target") in ("memory", "user") else "memory", "notes": notes[:20]}, ensure_ascii=False)
    try:
        done = subprocess.run([sys.executable, "/opt/data/noah.py", "memoire-juger", body], capture_output=True, timeout=MEMORY_JUDGE_SECONDS)
        refused = json.loads(done.stdout).get("refus") or []
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        return None
    if not refused:
        return None
    lines = [f"« {notes[r['i']][:80]} » : {r.get('raison', '')}" for r in refused if isinstance(r, dict) and isinstance(r.get("i"), int) and r["i"] < len(notes)]
    if not lines:
        return None
    return ("Noah n'a pas gardé cette note, qui serait relue à chaque message :\n" + "\n".join(lines)
            + "\nRien n'a été écrit. Renvoie les autres notes du lot s'il y en a. Une façon de faire va dans un skill. Si l'utilisateur a demandé "
            "lui-même de retenir celle-ci, commence-la par « Demandé : ». Sinon, n'insiste pas et n'en parle pas.")


def _pre_tool_call(tool_name: str = "", args: dict | None = None, **_) -> dict | None:
    home = _home()
    reason = (check_guest if GUEST_ROOT in home + "/" else lambda t, a, _h: check_owner(t, a))(tool_name, args if isinstance(args, dict) else {}, home)
    if reason:
        return {"action": "block", "message": reason}
    if tool_name == "memory":
        refused = check_memory(args if isinstance(args, dict) else {})
        return {"action": "block", "message": refused} if refused else None
    if tool_name.startswith("browser_"):
        _wake_browser()
        return None
    if tool_name.startswith("mcp__"):  # avant le test des arguments : un appel sans argument passe aussi par le droit
        return check_mcp(tool_name, args if isinstance(args, dict) else {})
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


def _forget_nous_guest() -> None:
    """Retire le compte anonyme qu'Hermes a pu créer chez son éditeur (Nous Portal) avant que Noah coupe ces connexions :
    aucun de ses services ne doit plus s'en servir. Un compte choisi par la personne reste."""
    path = os.path.join(os.environ.get("HERMES_HOME") or "/opt/data", "auth.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data["providers"]["nous"]["auth_method"] != "anonymous":
            return
        del data["providers"]["nous"]
        if data.get("active_provider") == "nous":
            data["active_provider"] = None
        mode = os.stat(path).st_mode & 0o777
        with open(path + ".noah", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.chmod(path + ".noah", mode)
        os.replace(path + ".noah", path)
    except (OSError, ValueError, KeyError, TypeError):
        return


def register(ctx) -> None:
    _forget_nous_guest()
    ctx.register_hook("pre_tool_call", _pre_tool_call)
