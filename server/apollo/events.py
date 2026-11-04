"""Traducteur : réduit le flux technique d'Hermes à quatre événements lisibles par l'utilisateur.

  message   texte de l'agent (par morceaux)
  activity  ce que l'agent est en train de faire, en mots simples
  approval  l'agent attend une validation
  done      fin du run (ok, erreur ou annulé)

Le détail brut (appels d'outils, arguments) n'est envoyé que si l'interface demande le mode détails.
"""

# Ce que l'utilisateur voit pendant le travail : une seule ligne, remplacée au fil de l'eau.
# Les étapes qui ont un sens pour lui ont leur libellé ; les commandes, fichiers, compétences et la
# mémoire restent sans détail technique, mais la ligne dit que l'agent avance (sinon il semble figé).
TOOL_LABELS = {
    "web_search": "Cherche sur le web",
    "web_extract": "Lit une page web",
    "browser": "Navigue sur le web",
    "cronjob": "Planifie une tâche",
    "delegate_task": "Confie une partie du travail à un sous-agent",
    "vision_analyze": "Regarde une image",
}


def tool_label(name: str) -> str | None:
    if name in TOOL_LABELS:
        return TOOL_LABELS[name]
    if name.startswith("browser"):
        return TOOL_LABELS["browser"]
    if name.startswith("mcp_") or "__" in name:
        return "Utilise une app connectée"
    return "Travaille sur ta demande"


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
    if "unknown_execution" in text:
        return "Un redémarrage a coupé le travail précédent et cette conversation reste bloquée. Réessaie dans un instant."
    return raw or "Le travail s'est arrêté avant la fin."


def translate(kind: str, data: dict, details: bool) -> dict | None:
    if kind in ("message.delta", "assistant.delta", "response.output_text.delta"):
        text = data.get("delta") or data.get("text") or data.get("content") or ""
        return {"type": "message", "text": text} if text else None

    if kind in ("tool.started", "hermes.tool.progress"):
        tool = data.get("tool") or data.get("tool_name") or data.get("name") or ""
        if tool.startswith("_"):  # réflexion interne
            return None
        label = tool_label(tool)
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
