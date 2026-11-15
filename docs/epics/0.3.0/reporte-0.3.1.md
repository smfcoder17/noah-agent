# Reporté après la 0.3.0 (à ranger dans la 0.3.1 ou plus tard)

Décision de Franck (15 novembre 2026) : la 0.3.0 sort avec le menu de l'agent au survol et la forme réelle de l'agent. Le reste de ce qu'il a demandé est écrit ici, avec ses mots, pour ne rien perdre.

## Modèles

- **Bascule de modèle sans effet.** « J'essaie de switcher le modèle, je définis un modèle particulier, mais après ça ne change rien. En bas dans le chat, c'est toujours l'ancien modèle (DeepSeek 4.1 Flash). » Fenêtre « Noah's model » ouverte depuis la conversation (Auto / Same as my other agents / A specific model), puis étiquette sous la saisie. Cause non trouvée : le lot a été arrêté avant la reproduction. À vérifier aussi : ce qui part réellement au tour suivant.
- **Modèles Claude vagues.** Claude branché comme fournisseur ne liste que Sonnet, Opus, Haiku, sans numéro exact. À afficher : l'identifiant exact que la CLI connectée accepte, avec un nom lisible.
- **Étude de T3 Code** (logiciel open source qui utilise les abonnements ChatGPT et Claude sur l'ordinateur) : comment ils détectent la CLI, listent les modèles, lancent un tour, gèrent l'arrêt et les limites. Comparer avec `desktop/claude.js`, `desktop/chatgpt.js`, `server/noah/relay.py`, et reprendre ce qui est meilleur, sauf si cela enfreint les règles d'Anthropic ou d'OpenAI (`abonnements.md`).

## Barre de gauche

- Trois petits points à la place de l'engrenage, et un agent plus visible : fait dans la 0.3.0 (voir `lot-barre.md`).
- **Fichier de rôle.** Dans « Rôle et instructions », ajouter un fichier (`.txt`, `.md`, `.pdf`, `.docx`) dont le texte remplit le champ, en plus de la dictée. Reporté.

## Recherche

- **Ctrl+F dans une conversation :** barre propre à Noah sur les messages enregistrés, nombre de résultats, précédent et suivant, défilement et surlignage, même sur un message pas encore chargé.
- **Recherche de la barre latérale :** aujourd'hui elle ne fait rien. Elle doit chercher dans tous les agents, grouper par agent (« N résultats dans tel agent »), et un clic sur un groupe ouvre le Ctrl+F de cet agent. Droits respectés, côté serveur, paginée.

## Aperçus

- **Visionneuse d'images :** le zoom rogne l'image et le bouton pour dézoomer disparaît. À refaire : zoom molette, pincement et boutons, déplacement, commandes toujours visibles, double clic, flèches.
- **Vidéo dans la barre de droite,** adaptée à son format (vertical ou horizontal), avec plein écran.
- **Artefacts HTML :** une page créée par l'agent doit s'ouvrir rendue dans le panneau de droite, comme un artefact Claude ou ChatGPT, au lieu d'afficher le code. Dans une iframe isolée (`sandbox` sans `allow-same-origin`, CSP), avec bascule vers le code et plein écran. Cause du code affiché non trouvée.

## Déjà connu, hors de ces demandes

- Paiement par carte lié à un accord, états « fait / a peut-être eu lieu » d'un accord, point d'étape à 5 $ par tâche (plan 0.3.0, lots B4, C3, C5).
- Trafic entre conteneurs d'un même serveur non coupé (un agent doit parler à son navigateur).
- Un message envoyé pendant que l'agent travaille a disparu sur un serveur de test sans agent actif : à revérifier avec un vrai agent.
