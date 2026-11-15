"""Connecteurs prêts à brancher avec une clé : GitHub, Airtable, Stripe en lecture, Apify.

Chacun est le serveur MCP officiel de l'éditeur, hébergé par lui, et accepte une clé personnelle dans l'en-tête
`Authorization: Bearer`. Ils prennent donc le chemin des outils par jeton de mcp.py, sans rien de neuf :
- la clé est testée avant tout enregistrement, puis scellée en base (db.seal) ; ni l'agent ni l'écran ne la revoient ;
- Hermes parle au relais de Noah, jamais au service : le droit (lire, confirmer, agir) est tenu ici, à chaque appel ;
- ce que le serveur ne déclare pas en lecture (readOnlyHint) passe par le juge et, selon le mode, par la carte d'accord ;
- « pour tous mes agents » suit le genre `jeton` de connecteurs.py : chaque agent reçoit sa ligne, au droit « confirmer ».

Pourquoi ceux-là : ils manquent au catalogue d'Hermes (lu sur l'image épinglée), qui offre déjà par OAuth Notion, Linear,
Todoist, Dropbox, Hugging Face et Stripe. Slack n'y entre pas : son serveur MCP n'accepte que les applications publiées
sur sa marketplace ou internes à un espace, avec leur secret. Discord et Telegram n'ont pas de serveur MCP officiel.
"""
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, mcp

router = APIRouter()


@dataclass(frozen=True)
class Cle:
    nom: str  # le nom de l'outil chez l'agent : ses outils s'appellent mcp__<nom>__…
    titre: str
    url: str
    hote: str  # pour le logo, cherché par le serveur Noah
    lien: str  # où la personne crée sa clé
    droit: str = "confirmer"


CATALOG = (
    # https://github.com/github/github-mcp-server : serveur distant, PAT en Bearer ; ses outils déclarent readOnlyHint.
    Cle("github", "GitHub", "https://api.githubcopilot.com/mcp/", "github.com", "https://github.com/settings/personal-access-tokens/new"),
    # https://support.airtable.com/docs/using-the-airtable-mcp-server : jeton personnel (PAT) en Bearer.
    Cle("airtable", "Airtable", "https://mcp.airtable.com/mcp", "airtable.com", "https://airtable.com/create/tokens"),
    # https://docs.stripe.com/mcp : clé d'agent restreinte en Bearer. Le nom évite celui de Stripe par OAuth (catalogue d'Hermes).
    Cle("stripe-lecture", "Stripe", "https://mcp.stripe.com", "stripe.com", "https://dashboard.stripe.com/apikeys"),
    # https://docs.apify.com/platform/integrations/mcp : jeton d'API en Bearer. Lancer un acteur peut coûter.
    Cle("apify", "Apify", "https://mcp.apify.com", "apify.com", "https://console.apify.com/settings/integrations"),
)
_BY_NAME = {c.nom: c for c in CATALOG}


def entry(nom: str) -> Cle | None:
    return _BY_NAME.get(nom)


def host_of(nom: str, url: str | None) -> str | None:
    """Le site du service, pour son logo : seulement si l'outil est bien branché à l'adresse du catalogue."""
    known = _BY_NAME.get(nom)
    return known.hote if known and known.url == url else None


@router.get("/api/connections/cles")
def catalog(user: int = Depends(auth.current_user)):
    """Ce que l'écran propose : jamais une clé, seulement où la créer."""
    return [{"nom": c.nom, "titre": c.titre, "hote": c.hote, "lien": c.lien, "droit": c.droit} for c in CATALOG]


class NewKey(BaseModel):
    jeton: str = Field(min_length=8, max_length=4096)
    droit: str = Field(default="", pattern="^(|lire|agir|confirmer)$")


@router.post("/api/agents/{agent_id}/connections/cles/{nom}")
async def connect(agent_id: str, nom: str, body: NewKey, request: Request, user: int = Depends(auth.current_user)):
    """Le même parcours qu'un outil par adresse avec jeton : test, scellé, posé chez l'agent. La réponse ne contient pas la clé."""
    known = entry(nom)
    if not known:
        raise HTTPException(404, "Connecteur inconnu.")
    tool = mcp.NewTool(url=known.url, nom=known.nom, auth="jeton", jeton=body.jeton, droit=body.droit or known.droit)
    out = await mcp.add_tool(agent_id, tool, request, user)
    return {"nom": out["nom"], "outils": out["outils"]}
