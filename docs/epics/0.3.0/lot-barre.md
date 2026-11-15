# Lot barre de gauche (0.3.0, suite de D5)

Quatre demandes de Franck, rien d'autre. Reportés : fichier de rôle, recherche, aperçus, modèles.

## Cause de la forme non utilisée

Le serveur enregistre déjà la forme et le détail (`agents.shape`, `agents.detail`, `server/noah/db.py:131`), les applique à la création
depuis le modèle (`server/noah/presets.py:130`, testé dans `tests/agents/presets_test.py:130`) et les renvoie (`main.py:2197`).
Aucune migration n'est donc nécessaire. Le défaut est dans la fenêtre de création, `frontend/src/components/AgentDialog.tsx` : la forme
et le détail n'existent pas dans l'état du formulaire (lignes 45 à 53, `pick` ne reprend que nom, rôle et couleur), l'aperçu est dessiné sans
forme (ligne 114, `<NoahTile color={color} />`, toujours la gomme), et le formulaire n'envoie que la couleur (lignes 63 et 87). La carte du
modèle montre une forme, l'aperçu en montre une autre, et la personne ne peut pas en choisir une.

## Ce qui change

| Point | Changement | Test (avant le code) |
|---|---|---|
| 1. Trois points | L'icône de réglages de la barre est remplacée par `…` (`MoreHorizontal`). La ligne de l'agent n'a plus de réserve à droite : nom, statut et visage prennent la place. | `SideRail.test.tsx` : plus de bouton « Page de … » ; un bouton « Menu de … » par agent |
| 2. Au survol | Les points sont cachés ; ils apparaissent quand on survole l'agent (n'importe lequel, ouvert ou non), au focus clavier, et menu ouvert. Sans survol (écran tactile), ils restent visibles. Le clic ouvre le menu : Personnaliser, Page de l'agent. | `SideRail.test.tsx` : clic sur les points d'un agent non ouvert ouvre le menu et appelle l'action sur cet agent ; Échap ferme ; règle CSS survol, focus, tactile |
| 3. Barre repliée | Clic droit sur la ligne d'un agent : le même menu, au pointeur. | `SideRail.test.tsx` : barre repliée, `contextmenu` ouvre le même menu |
| 4. Forme réelle | Forme et détail entrent dans le formulaire de l'agent : repris du modèle, montrés dans l'aperçu, modifiables (toutes les formes), envoyés. Le panneau Apparence propose les mêmes choix (composant commun). | `AgentDialog.test.tsx` : aperçu = forme du modèle, choix d'une autre forme envoyée, agent existant ; `AgentAppearance.test.tsx` : cinq formes |

## Choix à relire

- Mobile (sans survol) : les points restent visibles, car sans eux le menu serait inatteignable. Le tiroir du téléphone les montre toujours.
- Le clic droit marche aussi barre dépliée (même menu), pas seulement repliée.
- Le menu n'offre « Personnaliser » qu'aux comptes qui peuvent administrer l'agent.
