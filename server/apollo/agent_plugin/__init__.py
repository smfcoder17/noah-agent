"""Plugin Hermes « noah-garde », posé par Noah Agent dans la machine de chaque agent (G7.6).

Contre-exemple : ClawHavoc, 341 skills malveillants sur 2 857 dans un catalogue ouvert, qui demandaient d'installer
un « prérequis » téléchargé. Hermes analyse déjà un skill avant de l'installer, mais laisse passer un skill
communautaire jugé sûr, sans signature. Ici :

- un skill ne s'installe que depuis un dépôt vérifié d'Hermes (openai, anthropics, huggingface, NVIDIA), jamais
  avec --force (qui passe outre l'analyse) ;
- aucun script téléchargé n'est exécuté d'un trait (curl … | sh, bash <(curl …), iex (iwr …)) : l'agent doit le
  télécharger, le lire, puis le lancer en le disant.

Les skills que l'agent écrit lui-même (skill_manage) restent permis : ils passent par l'analyse d'Hermes.
"""
import re

TRUSTED = ("openai/skills", "anthropics/skills", "huggingface/skills", "NVIDIA/skills")
INSTALL = re.compile(r"\b(?:hermes\s+skills\s+(?:install|add)|npx\s+(?:-y\s+)?skills\s+add|clawhub\s+install)\s+(\S+)")
PIPE_TO_SHELL = re.compile(
    r"(?:curl|wget|iwr|invoke-webrequest|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|iex)\b"
    r"|(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)"
    r"|iex\s*\(\s*(?:iwr|invoke-webrequest|new-object\s+net\.webclient)",
    re.I,
)


def check(command: str) -> str | None:
    """Raison du refus, ou None si la commande passe."""
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
    return None


def _pre_tool_call(tool_name: str = "", args: dict | None = None, **_) -> dict | None:
    if tool_name != "terminal" or not isinstance(args, dict):
        return None
    reason = check(str(args.get("command", "")))
    return {"action": "block", "message": reason} if reason else None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
