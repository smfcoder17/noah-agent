"""Ce que Noah ajoute au catalogue d'applications de son agent.

Hermes fournit un catalogue d'applications MCP (Notion, Linear, Figma…) ; celui-ci ne bouge pas sans lui. Ici, les
applications que Noah connaît en plus, avec la même forme que celles du catalogue : une adresse, un mode d'authentification,
et la même carte dans l'onglet Connexions.

Une entrée `oauth` suit le parcours habituel : l'agent ouvre l'adresse d'autorisation, la personne accepte, Noah reçoit le
retour. Le fournisseur est découvert à la connexion (RFC 8414 / 9728), d'où l'absence de `client_id` ici.
"""

# brollss : bibliothèque de vidéos de fond (b-roll) pour les montages. Serveur MCP distant, OAuth découvert à la connexion.
CATALOG = [
    {
        "nom": "brollss",
        "description": "Bibliothèque de vidéos de fond (b-roll) : chercher, prévisualiser et télécharger des plans.",
        "url": "https://brollss.com/mcp",
        "oauth": True,
        "source": "https://brollss.com",
        "hote": "brollss.com",
        "installe": False,
        "connecte": False,
        "etat": None,
        "erreur": "",
        "droit": None,
        "outils": [],
    },
]


def entry(nom: str) -> dict | None:
    return next((a for a in CATALOG if a["nom"] == nom), None)


def names() -> set[str]:
    return {a["nom"] for a in CATALOG}
