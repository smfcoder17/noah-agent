"""Traducteur : réduit le flux technique d'Hermes à quatre événements lisibles par l'utilisateur.

  message   texte de l'agent (par morceaux)
  activity  ce que l'agent est en train de faire, en mots simples
  approval  l'agent attend une validation
  done      fin du run (ok, erreur ou annulé)

Le détail brut (appels d'outils, arguments) n'est envoyé que si l'interface demande le mode détails.
"""

# Libellés humains des outils les plus courants ; les autres retombent sur un libellé générique.
TOOL_LABELS = {
    "web_search": "Recherche sur le web",
    "web_extract": "Lecture d'une page web",
    "browser": "Navigation dans le navigateur",
    "terminal": "Exécution d'une commande",
    "read_file": "Lecture d'un fichier",
    "write_file": "Écriture d'un fichier",
    "patch": "Modification d'un fichier",
    "memory": "Consultation de la mémoire",
    "session_search": "Recherche dans les conversations passées",
    "skill_view": "Consultation d'une compétence",
    "cronjob": "Planification d'une tâche",
    "delegate_task": "Délégation à un sous-agent",
}


def tool_label(name: str) -> str:
    if name in TOOL_LABELS:
        return TOOL_LABELS[name]
    if name.startswith("browser"):
        return TOOL_LABELS["browser"]
    if name.startswith("mcp_") or "__" in name:
        return "Utilisation d'une app connectée"
    return "Travail en cours"


def friendly_error(raw: str) -> str:
    text = raw.lower()
    if "401" in text or "authentication" in text or "api key" in text:
        return "Le fournisseur a refusé la clé API. Vérifie-la avec le bouton « Modèle »."
    if "budget mensuel" in text:
        return "Budget mensuel atteint. Augmente-le dans « Modèle et budget » pour continuer."
    if "402" in text or "credit" in text or "quota" in text:
        return "Le compte du fournisseur n'a plus de crédit ou a atteint sa limite."
    if "429" in text or "rate limit" in text:
        return "Le fournisseur limite les requêtes pour le moment. Réessaie dans une minute."
    return raw or "Le travail s'est arrêté avant la fin."


def translate(kind: str, data: dict, details: bool) -> dict | None:
    if kind in ("message.delta", "assistant.delta", "response.output_text.delta"):
        text = data.get("delta") or data.get("text") or data.get("content") or ""
        return {"type": "message", "text": text} if text else None

    if kind in ("tool.started", "hermes.tool.progress"):
        tool = data.get("tool") or data.get("tool_name") or data.get("name") or ""
        out = {"type": "activity", "label": tool_label(tool)}
        if details:
            out["detail"] = {"tool": tool, "preview": data.get("preview")}
        return out

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
        }

    if kind in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
        status = kind.split(".", 1)[1]
        out = {"type": "done", "status": status}
        # La réponse finale arrive aussi ici ; l'interface l'affiche si aucun morceau n'a été streamé.
        output = data.get("output")
        if isinstance(output, str) and output:
            out["output"] = output
        if status != "completed":
            out["error"] = friendly_error(str(data.get("error") or ""))
        return out

    # message.interim, subagent.*, keepalive… : rien pour l'utilisateur, sauf en mode détails.
    return {"type": "raw", "kind": kind, "data": data} if details else None
