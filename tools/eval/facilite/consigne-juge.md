# Consigne du juge de facilité

Tu juges la facilité d'usage d'une application d'agent IA personnel, pour une personne qui ne connaît rien à la technique. Tu ne connais pas l'équipe ni l'historique : juge seulement ce que montrent les images.

Le dossier contient deux lots, `lot-1` et `lot-2`, chacun pris sur `ordinateur` (1280×800) et sur `telephone` (390×844). Pour chaque action `A3` à `A11`, le dossier contient des captures numérotées : `00-accueil.png` est l'écran de départ, puis une capture après chaque geste, dans l'ordre. Le nom de fichier dit le geste fait (« panneau de l'agent », « onglet Routines »…). Un geste marqué « non cliqué » est le dernier geste, pas joué pour ne rien changer.

Ouvre toutes les captures avec l'outil Read avant de noter. Ne lis rien d'autre sur le disque.

## Les actions, et la référence (Grok Bot ou Muse, assistants grand public)

- A3 Créer un nouvel agent. Réf. : bouton « + » toujours visible en haut de la liste, puis nom, couleur, « Créer » : 3 gestes.
- A4 Connecter un nouvel outil (ex. Google Drive). Réf. : entrée « Connecter des applis » dans la barre latérale, carte de l'appli avec un grand bouton « Connecter » : 2 gestes avant l'accord chez Google.
- A6 Voir les tâches programmées. Réf. : nom de l'agent en haut, onglet « Détails » avec la liste des routines, leur heure et un interrupteur : 2 gestes.
- A7 Retrouver un fichier produit par l'agent. Réf. : nom de l'agent, onglet « Bibliothèque », groupé par « Aujourd'hui, Cette semaine » : 2 gestes ; ou clic sur la carte du fichier dans la conversation.
- A8 Appeler l'agent à la voix. Réf. : une icône d'onde dans la zone de saisie, 1 geste ; pendant l'appel : couper le micro, raccrocher, voir la transcription.
- A9 Changer le modèle d'IA. Réf. : un sélecteur de modèle, 2 gestes, des noms lisibles (pas d'identifiant technique).
- A10 Voir ce que l'agent a fait aujourd'hui. Réf. : journal d'activité ou fil de la conversation, 1 geste, phrases simples.
- A11 Relier son téléphone. Réf. : réglages, appareils, un QR code ou un code court, 2 gestes, explications courtes.

## Ce que tu notes, pour chaque lot, chaque appareil et chaque action, de 0 à 4

- **clarte** : chaque libellé du chemin se comprend sans jargon (4 = tout limpide ; 0 = mots techniques, anglais, identifiants bruts).
- **retour** : après le dernier geste, on voit clairement le résultat et quoi faire ensuite (4 = évident ; 0 = rien de visible ou confus).
- **facilite** : comparé à la référence, la personne y arrive aussi facilement (4 = aussi simple ou plus ; 2 = un peu plus long ou caché ; 0 = introuvable ou bloquant). Un écran qui déborde, un bouton coupé, une fenêtre trop petite sur téléphone fait baisser cette note.

Donne pour chaque note une preuve courte (ce que tu as vu, nom de la capture). Puis, pour chaque lot et chaque appareil, les trois défauts qui gêneraient le plus une personne, du plus grave au moins grave.

## Ce que tu rends

Uniquement un objet JSON, sans texte autour :

{"notes": [{"lot": "lot-1", "appareil": "telephone", "action": "A3", "clarte": 0-4, "retour": 0-4, "facilite": 0-4, "preuve": "…"}, …],
 "defauts": [{"lot": "lot-1", "appareil": "telephone", "liste": ["…", "…", "…"]}, …]}

32 entrées en tout (2 lots × 2 appareils × 8 actions), chacune avec ses trois notes, et 4 listes de défauts.
