"""Traducteur : réduit le flux technique d'Hermes à quatre événements lisibles par l'utilisateur.

  message   texte de l'agent (par morceaux)
  activity  ce que l'agent est en train de faire, en mots simples
  approval  l'agent attend une validation
  done      fin du run (ok, erreur ou annulé)

Le détail brut (appels d'outils, arguments) n'est envoyé que si l'interface demande le mode détails.
"""
import re
from urllib.parse import urlsplit

from .diagnostics import mask

# Ce que l'utilisateur voit pendant le travail : une seule ligne, remplacée au fil de l'eau.
# Les étapes qui ont un sens pour lui ont leur libellé ; les commandes, fichiers, compétences et la
# mémoire restent sans détail technique, mais la ligne dit que l'agent avance (sinon il semble figé).
LABEL_MAX = 90


def _name(path: object) -> str:
    return str(path or "").rstrip("/").rsplit("/", 1)[-1]


def _site(url: object) -> str:
    text = str(url or "").strip()
    try:  # le nom d'hôte seul : une adresse peut porter un identifiant et un mot de passe
        host = urlsplit(text if "://" in text else f"//{text}").hostname or ""
    except ValueError:
        return ""
    return host.removeprefix("www.")


def _quoted(text: object, limit: int = 60) -> str:
    text = " ".join(str(text or "").split())
    return text[:limit] + ("…" if len(text) > limit else "")


def _noah_tool(words: list[str]) -> str:
    action = words[2] if len(words) > 2 else ""
    return {"image": "Crée une image", "video": "Crée une vidéo", "son": "Crée un son", "installer": "Installe un logiciel", "fil": "Ouvre un fil de travail",
            "rappeler": "Te rappelle", "appeler": "Te rappelle"}.get(action, "Utilise ses outils")


# Une commande inconnue peut porter un secret n'importe où : on ne cite que son programme, et ce qu'on sait sans risque être un
# nom de script ou une sous-commande d'un outil connu. Jamais ses options ni ses autres arguments.
_RUNNERS = {"npm", "pnpm", "yarn", "bun", "npx", "docker", "make", "cargo", "go", "uv", "pytest", "kubectl", "gh", "node", "python", "python3", "bash", "sh"}
_SCRIPT = re.compile(r"^[\w./-]+\.(?:py|sh|js|mjs|cjs|ts|rb|pl)$")
_SUBCOMMAND = re.compile(r"^[a-z][a-z-]{1,20}$")


def _program_label(first: str, rest: list[str]) -> str:
    if not re.fullmatch(r"[\w.+-]{1,30}", first):
        return "Lance une commande"
    said = [first]
    next_word = rest[0] if rest else ""
    if first in _RUNNERS and _SCRIPT.match(next_word):
        said.append(next_word.rsplit("/", 1)[-1])
    elif first in _RUNNERS and _SUBCOMMAND.match(next_word):
        said.append(next_word)
        if next_word in ("run", "exec", "test") and len(rest) > 1 and _SUBCOMMAND.match(rest[1]):
            said.append(rest[1])
    return "Lance : " + " ".join(said)


def _command_label(command: str) -> str:
    words = command.split()
    if not words:
        return "Lance une commande"
    if words[0] == "python3" and len(words) > 1 and words[1].endswith("noah.py"):
        return _noah_tool(words)
    first = words[0].rsplit("/", 1)[-1]
    second = words[1] if len(words) > 1 else ""
    if first in ("npm", "pnpm", "yarn", "pip", "pip3", "apt", "apt-get") and second in ("install", "i", "add"):
        return "Installe des dépendances"
    if first == "git" and second:
        return {"clone": "Récupère un dépôt", "commit": "Enregistre son travail (git)", "status": "Regarde l'état du dépôt", "diff": "Relit ses changements",
                "log": "Lit l'historique du dépôt", "push": "Envoie son travail (git)", "pull": "Récupère les changements"}.get(second, f"git {second}")
    if first in ("ls", "find", "tree"):
        return "Regarde les fichiers"
    if first in ("cat", "head", "tail", "less", "sed", "grep", "rg"):
        return "Lit des fichiers"
    if first in ("rm", "rmdir"):
        return "Supprime des fichiers"
    if first in ("mkdir", "cp", "mv", "touch"):
        return "Range des fichiers"
    if first in ("curl", "wget"):
        site = next((_site(w) for w in words[1:] if "://" in w), "")
        return f"Télécharge depuis {site}" if site else "Télécharge un fichier"
    if first == "ffmpeg":
        return "Traite une vidéo ou un son"
    return _program_label(first, words[1:])


def tool_label(name: str, args: dict | None = None, preview: str | None = None) -> str | None:
    """La ligne de travail : ce que fait cet appel-ci, pas le nom de l'outil. Déterministe, donc immédiate et gratuite."""
    args = args if isinstance(args, dict) else {}
    named = {
        "web_search": lambda: f"Cherche « {_quoted(args.get('query'))} »" if args.get("query") else "Cherche sur le web",
        "web_extract": lambda: f"Lit {_site((args.get('urls') or [''])[0] if isinstance(args.get('urls'), list) else args.get('url'))}" if (args.get("urls") or args.get("url")) else "Lit une page web",
        "browser_navigate": lambda: f"Ouvre {_site(args.get('url'))}" if args.get("url") else "Ouvre une page",
        "browser_click": lambda: "Clique dans la page",
        "browser_type": lambda: "Écrit dans la page",
        "browser_press": lambda: "Appuie sur une touche dans la page",
        "browser_scroll": lambda: "Fait défiler la page",
        "browser_back": lambda: "Revient à la page précédente",
        "browser_snapshot": lambda: "Regarde la page",
        "browser_vision": lambda: "Regarde la page",
        "browser_console": lambda: "Lit la console de la page",
        "browser_get_images": lambda: "Regarde les images de la page",
        "terminal": lambda: _command_label(str(args.get("command", ""))),
        "process": lambda: "Suit une commande en cours",
        "read_file": lambda: f"Lit {_name(args.get('path'))}" if args.get("path") else "Lit un fichier",
        "write_file": lambda: f"Écrit {_name(args.get('path'))}" if args.get("path") else "Écrit un fichier",
        "patch": lambda: f"Modifie {_name(args.get('path'))}" if args.get("path") else "Modifie des fichiers",
        "search_files": lambda: f"Cherche « {_quoted(args.get('pattern'))} » dans les fichiers" if args.get("pattern") else "Cherche dans les fichiers",
        "vision_analyze": lambda: f"Regarde {_name(args.get('image_url'))}" if args.get("image_url") and "://" not in str(args.get("image_url")) else "Regarde une image",
        "image_generate": lambda: "Crée une image",
        "text_to_speech": lambda: "Prépare un message vocal",
        "execute_code": lambda: "Exécute un petit programme",
        "delegate_task": lambda: f"Confie à un sous-agent : {_quoted(args.get('goal'))}" if args.get("goal") else "Confie une partie du travail à un sous-agent",
        "cronjob": lambda: "Planifie une tâche",
        "memory": lambda: "Met à jour sa mémoire",
        "session_search": lambda: "Cherche dans vos anciennes conversations",
        "skill_view": lambda: f"Consulte la compétence {args.get('name')}" if args.get("name") else "Consulte une compétence",
        "skills_list": lambda: "Regarde ses compétences",
        "skill_manage": lambda: "Met à jour une compétence",
        "todo": lambda: "Organise son travail",
        "clarify": lambda: "Prépare une question pour toi",
        "send_message": lambda: "Envoie un message",
    }
    if name in named:
        return named[name]()
    if name.startswith("browser"):
        return "Agit dans le navigateur"
    if name.startswith("mcp_") or "__" in name:
        parts = [p for p in re.split(r"_+", name.removeprefix("mcp_")) if p]
        return f"Utilise {parts[0]}" if parts else "Utilise une app connectée"
    return f"Utilise l'outil {name.replace('_', ' ')}"  # pas son aperçu : il recopie ses arguments


# Les phrases écrites par Noah lui-même (relais, budget) sont déjà faites pour la personne.
_OWN = re.compile(r"^(Budget |Plafond du jour|Le modèle est injoignable|Aucun modèle|Ce fournisseur)")
# Du plus précis au plus général. Une erreur inconnue n'est jamais montrée brute : elle reste dans les détails.
_KNOWN = (
    (r"unknown_execution", "Un redémarrage a coupé le travail précédent et cette conversation reste bloquée. Réessaie dans un instant."),
    (r"content.?(policy|filter)|moderation|flagged|safety (system|polic)",
     "Le fournisseur a refusé ce contenu selon ses règles. Reformule la demande, ou choisis un autre modèle dans Réglages > Cerveau."),
    # Une panne chez lui, même si elle parle de clé : la tienne n'y est pour rien.
    (r"(http|status|code|error)\D{0,10}5\d\d\b", "Le fournisseur est surchargé ou en panne pour le moment. Réessaie dans quelques minutes."),
    (r"\b429\b|rate.?limit|too many requests",
     "Le fournisseur limite les requêtes ou le quota de ce compte est atteint. Réessaie dans une minute ; si ça continue, regarde ton compte chez lui."),
    (r"(key|token|credential).{0,30}expired|expired.{0,30}(key|token|credential)",
     "Ta clé API a expiré. Crée-en une nouvelle chez ton fournisseur, puis colle-la dans Réglages > Cerveau."),
    (r"\b40[13]\b|authenticat|unauthorized|api key|x-api-key|invalid.{0,12}key|forbidden",
     "Le fournisseur a refusé ta clé API : elle est invalide ou n'a plus accès. Remplace-la dans Réglages > Cerveau."),
    (r"\b402\b|credit|quota|insufficient|billing",
     "Le compte du fournisseur n'a plus de crédit ou a atteint sa limite. Recharge-le, ou choisis un autre modèle dans Réglages > Cerveau."),
    (r"no endpoints|model.{0,40}(not found|not exist|unavailable|invalid)|not a valid model|\b404\b",
     "Ce modèle n'est plus disponible chez le fournisseur. Choisis-en un autre dans Réglages > Cerveau."),
    (r"context.{0,20}(length|window|size)|too (long|large)|token limit",
     "Cette conversation est devenue trop longue pour ce modèle. Commence une nouvelle conversation ou choisis un modèle plus grand."),
    (r"overloaded|\b(500|502|503|504|529)\b|bad gateway|service unavailable",
     "Le fournisseur est surchargé ou en panne pour le moment. Réessaie dans quelques minutes."),
    (r"timed? ?out|timeout", "Le fournisseur n'a pas répondu à temps. Réessaie dans un instant."),
)


def friendly_error(raw: str) -> str:
    if not raw:
        return "Le travail s'est arrêté avant la fin."
    if _OWN.match(raw):
        return mask(raw)[:500]  # un préfixe ne prouve pas l'origine : ce qui suit peut venir du fournisseur
    for pattern, sentence in _KNOWN:
        if re.search(pattern, raw, re.I):
            return sentence
    return "Le travail s'est arrêté sur une erreur que je ne sais pas expliquer. Clique sur « Voir les détails » : tu peux les donner à un agent pour la diagnostiquer."


def translate(kind: str, data: dict, details: bool) -> dict | None:
    if kind in ("message.delta", "assistant.delta", "response.output_text.delta"):
        text = data.get("delta") or data.get("text") or data.get("content") or ""
        return {"type": "message", "text": text} if text else None

    if kind in ("tool.started", "hermes.tool.progress"):
        tool = data.get("tool") or data.get("tool_name") or data.get("name") or ""
        if tool.startswith("_"):  # réflexion interne
            return None
        args = data.get("args") or data.get("arguments")
        label = tool_label(tool, args, data.get("preview"))
        label = mask(label)[:LABEL_MAX] if label else label  # une commande peut contenir une clé
        if details:
            return {"type": "activity", "label": label or tool, "detail": {"tool": tool, "preview": data.get("preview")}}
        return {"type": "activity", "label": label} if label else None

    # Commentaire de l'agent entre deux outils (« Je vérifie le rendu… ») : devient la ligne de travail.
    if kind in ("assistant.commentary", "message.interim"):
        text = (data.get("text") or data.get("content") or "").strip()
        if text and not data.get("already_streamed"):
            line = text.splitlines()[0]
            return {"type": "activity", "label": line[:140] + ("…" if len(line) > 140 else "")}
        return None

    if kind in ("tool.completed", "tool.failed"):
        if not details:
            return None
        return {
            "type": "activity_detail",
            "detail": {
                "tool": data.get("tool"),
                "duration": data.get("duration"),
                "error": data.get("error"),
                "preview": data.get("preview"),
            },
        }

    if kind in ("approval.request", "run.waiting_for_approval"):
        return {
            "type": "approval",
            "request_id": data.get("prompt_id") or data.get("request_id"),
            "generation": data.get("execution_generation"),
            "summary": data.get("description") or data.get("command") or data.get("preview") or "Action à valider",
            "commande": bool(data.get("command")),
        }

    if kind in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
        status = kind.split(".", 1)[1]
        out = {"type": "done", "status": status}
        # La réponse finale arrive aussi ici ; l'interface l'affiche si aucun morceau n'a été streamé.
        output = data.get("output")
        if isinstance(output, str) and output:
            out["output"] = output
        if status != "completed":
            out["raw_error"] = str(data.get("error") or "")
            out["error"] = friendly_error(out["raw_error"])
        return out

    # message.interim, subagent.*, keepalive… : rien pour l'utilisateur, sauf en mode détails.
    return {"type": "raw", "kind": kind, "data": data} if details else None


# Une réaction se donne d'un mot : l'agent commence sa réponse par [[👍]], la personne ne voit que l'emoji posé sur son message.
REACTIONS = ("👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉", "👎")
_REACTION_HEAD = re.compile(r"^\s*\[\[(" + "|".join(REACTIONS) + r")\]\]\s*")
_MOST_HEAD = 24


class ReactionHead:
    """Retient le début du flux le temps de savoir s'il commence par une réaction. Ce qui n'en est pas une repart tel quel."""

    def __init__(self) -> None:
        self.held = ""
        self.done = False

    def feed(self, text: str) -> tuple[str | None, str]:
        if self.done:
            return None, text
        self.held += text
        start = self.held.lstrip()
        if start and "[[".startswith(start[:2]) and "]]" not in start and len(self.held) < _MOST_HEAD:
            return None, ""
        if not start and len(self.held) < _MOST_HEAD:
            return None, ""
        return self._decide()

    def flush(self) -> tuple[str | None, str]:
        return (None, "") if self.done else self._decide()

    def _decide(self) -> tuple[str | None, str]:
        self.done = True
        found = _REACTION_HEAD.match(self.held)
        rest, self.held = self.held, ""
        return (found.group(1), rest[found.end():]) if found else (None, rest)
