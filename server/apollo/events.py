"""Traducteur : réduit le flux technique d'Hermes à quatre événements lisibles par l'utilisateur.

  message   texte de l'agent (par morceaux)
  activity  ce que l'agent est en train de faire, en mots simples
  approval  l'agent attend une validation
  done      fin du run (ok, erreur ou annulé)

Le détail brut (appels d'outils, arguments) n'est envoyé que si l'interface demande le mode détails.
"""
import re

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


# Les phrases écrites par Noah lui-même (relais, budget) sont déjà faites pour la personne.
_OWN = re.compile(r"^(Budget |Plafond du jour|Le modèle est injoignable|Aucun modèle|Ce fournisseur)")
# Du plus précis au plus général. Une erreur inconnue n'est jamais montrée brute : elle reste dans les détails.
_KNOWN = (
    (r"unknown_execution", "Un redémarrage a coupé le travail précédent et cette conversation reste bloquée. Réessaie dans un instant."),
    (r"expired", "Ta clé API a expiré. Crée-en une nouvelle chez ton fournisseur, puis colle-la dans Réglages > Cerveau."),
    (r"\b40[13]\b|authenticat|unauthorized|api key|x-api-key|invalid.{0,12}key|forbidden",
     "Le fournisseur a refusé ta clé API : elle est invalide ou n'a plus accès. Remplace-la dans Réglages > Cerveau."),
    (r"\b402\b|credit|quota|insufficient|billing",
     "Le compte du fournisseur n'a plus de crédit ou a atteint sa limite. Recharge-le, ou choisis un autre modèle dans Réglages > Cerveau."),
    (r"\b429\b|rate.?limit|too many requests", "Le fournisseur limite les requêtes pour le moment. Réessaie dans une minute."),
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
        return raw
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
            out["raw_error"] = str(data.get("error") or "")
            out["error"] = friendly_error(out["raw_error"])
        return out

    # message.interim, subagent.*, keepalive… : rien pour l'utilisateur, sauf en mode détails.
    return {"type": "raw", "kind": kind, "data": data} if details else None
