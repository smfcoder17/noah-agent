# Noah Agent — plan vers une première version déployable

But : un agent, pas un chatbot. Il a son ordinateur, ses outils, ses connexions (courriel, agenda…), ses routines,
et il prend l'initiative. Une première version tourne sur un VPS ; l'application mobile vient ensuite.

## Fait (29-30 octobre)

- Noah : nom, logo, agents seuls à gauche, épingle, conversation unique, fils dans Détails.
- Widgets, aperçus de fichiers, visionneuse, création d'images, vidéos, musique et voix.
- Dictée et mode vocal. Une voix rapide (Gemini Flash Lite) répond en ~2,5 s pendant que l'agent travaille, puis résume son résultat.
- Navigateur : délais allongés, écran 1920x1080, onglet partagé avec l'agent, réveil et redémarrage, diagnostic `noah.py etat`.
- Empreinte du navigateur alignée sur la connexion (langue et fuseau déduits de l'IP, ou `NOAH_LOCALE` / `NOAH_TIMEZONE`).
- Import d'une session (cookies) pour les sites qui bloquent la connexion automatisée (X, Google, banques).

## Phase 1 — L'ordinateur de l'agent

- « Ordinateur » = un vrai bureau Linux (XFCE) dans le conteneur du navigateur : explorateur de fichiers, terminal, navigateur, applications.
  « Redémarrer le navigateur » devient « Redémarrer l'ordinateur ».
- Espace de travail partagé entre la machine de l'agent et le bureau (même volume), pour ouvrir ses fichiers à la main.
- Installer des outils : `sudo apt` limité au conteneur de l'agent (liste blanche), ou boîte à outils persistante (`/opt/data/tools`).
  Quota de disque réglable à l'installation et dans Réglages.
- Garder la session des sites : rappel automatique quand un site demande une reconnexion, import de cookies guidé.

## Phase 2 — « Automatique » = un vrai routeur

- Un modèle de décision rapide lit la demande, les préférences et la mémoire de l'utilisateur (prioritaires), et choisit :
  SVG ou code (logo simple, icône, schéma, graphique), dessin par programme, ou modèle de génération ; puis le modèle
  selon le style, le texte dans l'image, le photoréalisme, le coût et la difficulté.
- Base de décision versionnée (`server/noah/routing/*.json`) : forces de chaque modèle, cas types, exemples annotés,
  avec tests de non-régression (une demande → le choix attendu).
- Même logique pour vidéo, musique, voix, et pour le cerveau (tâche simple → modèle rapide, tâche difficile → modèle fort).

## Phase 3 — Choisir un modèle facilement

- Un sélecteur commun partout (cerveau, images, vidéo, musique, voix, dictée) : logo du fournisseur
  (bibliothèque d'icônes d'IA), coût par unité parlante (par image, par seconde de vidéo, par minute dictée, par tâche),
  vitesse, score de qualité (classements OpenRouter, LMArena, Artificial Analysis), filtres par fournisseur et recherche.
- Corriger le niveau « Équilibré » (il proposait Claude Haiku).

## Phase 4 — Conversation

- Sélectionner un passage d'une réponse → « Répondre à ceci » (citation jointe au message).
- Joindre en contexte un tableau, un widget ou une image de la conversation.
- Mémoire : vérifier qu'elle retient les préférences, les montrer et les modifier dans Détails.

## Phase 5 — Connexions et routines (ce qui fait un agent)

- Connecteurs : Gmail, Google Agenda, Drive, Notion, GitHub… par MCP, avec connexion OAuth en un clic.
  Visibles dans Détails, par agent.
- Routines : voir, créer, mettre en pause les tâches planifiées d'Hermes (cron) depuis l'interface ; résultats dans les fils.
- Initiative : résumé du matin, veille, alertes ; l'agent propose ce qu'il peut faire avec les connexions disponibles.

## Phase 6 — Performance, montée en qualité

- Mesures automatiques : délai avant le premier mot, avant la première activité, réponse orale, durée totale d'une tâche,
  fluidité de l'interface ; comparaison avec ChatGPT, Claude, Grok sur un jeu de tâches fixe.
- Audit par deux agents (Codex et Opus) en « hill climbing » : chaque amélioration mesurée rapporte des points,
  une régression en retire. Objectif : 1,5 à 2 fois plus rapide et plus fluide.

## Phase 7 — Déploiement

- VPS : HTTPS automatique (Caddy), nom de domaine, sauvegardes, mises à jour, installation en une commande.
- Renommer l'interne (`noah-*` → `noah-*`, volumes) avec migration des données.
- Puis : application mobile (même API, notifications).
