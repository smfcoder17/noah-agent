# Réactivité de Noah Agent

Mesure : `docker exec apollo-server python -m apollo.bench <étiquette> <répétitions>`. Les résultats
s'ajoutent à `/data/bench.jsonl` dans le volume du serveur. Médianes en millisecondes, machine locale,
cerveau DeepSeek V4.1 Flash via OpenRouter.

| | Avant (2 essais) | Après (6 essais) | Après, sans routage « latence » (6 essais) |
|---|---|---|---|
| Premier signe | 49-65 | 46-48 | 47-48 |
| Première réaction : salut | 2 455 | 601 | 683 |
| Première réaction : question | 763 | 534 | 1 166 |
| Première réaction : commande | 1 721 | 861 | 1 084 |
| Premier mot : commande | 1 721 | 1 363 | 1 789 |
| Fin : question | 1 218 | 776 | 1 570 |
| Réponse vocale rapide | 672 | 653 | — |
| Script principal de l'interface | 1 073 Ko | 949 Ko (342 Ko compressé sur VPS) | — |

Score (somme des premières réactions des trois cas) : 4 939 ms avant, 1 996 ms après, soit 2,5 fois plus
rapide. La base n'a que deux essais et le fournisseur varie d'un appel à l'autre : la colonne A/B, mesurée le
même jour avec 6 essais, isole l'effet du routage « latence » (environ 1,6 fois sur la première réaction).

## Ce qui a changé

Retenu par les deux audits (Opus et Kimi K3) :

- **Routage OpenRouter par latence** pour le chat de l'agent (`relay.py`), comme la voix le faisait déjà.
- **Une ligne d'activité pour chaque étape**, y compris les commandes : « Travaille sur ta demande »
  au lieu d'un silence (`events.py`).
- **Un seul client HTTP** vers le fournisseur pour le relais et la voix : la connexion TLS reste ouverte.
- **Interface** :
  - contexte et props du Markdown stables, donc un jeton ne refait plus l'analyse de tout le fil ;
  - jetons appliqués une fois par image (`requestAnimationFrame`) ;
  - Réglages, Détails et fenêtres chargés à la demande ;
  - fichiers à empreinte mis en cache pour un an, et servis d'abord par le service worker.
- **Voix** :
  - fin de phrase détectée après 0,6 s de silence au lieu de 0,8 s, avec un relevé toutes les 50 ms ;
  - une réponse courte est lue directement, sans second appel au modèle.
- **Base** : index sur `usage`, `messages` et `conversations`, mode WAL, et vérification de santé des agents
  ramenée de 3 s à 1 s.

## Mode vocal : premier son

Délai entre la fin de la phrase transcrite et le premier son entendu, mesuré dans le navigateur (médiane de 6,
trois phrases : salutation, demande d'action, question).

| | Avant | Après |
|---|---|---|
| Premier son | 1 116 ms | 754 ms |

- **Voix rapide sur gpt-oss-120b** (Cerebras, Groq) au lieu de Gemini 3.1 Flash Lite : premier mot en ~0,25 s
  au lieu de ~0,6 s. Juste dans 8 cas sur 8 pour le tri action / conversation, réponses naturelles en français.
- **Synthèse en flux** : le navigateur ouvre `/api/voice/audio/<id>` en même temps qu'il envoie la demande. Le serveur
  synthétise chaque phrase dès que le modèle l'a écrite, et le MP3 part au fil de l'eau. Plus d'aller-retour entre
  la réponse et la synthèse, plus d'attente du fichier complet. Sur un VPS, l'aller-retour économisé compte davantage
  qu'en local.
- **Micro gardé ouvert** pendant tout le mode vocal : chaque tour reprend l'écoute sans redemander le micro au
  navigateur, et le début de la phrase suivante n'est plus coupé.
- La synthèse elle-même (MAI Voice 2.1 Flash, ~0,35 s avant le premier octet) est déjà parmi les plus rapides avec
  une voix française. Les voix qui ne rendent que du PCM (Gemini TTS, HeyGen) passent en WAV dans le même flux.

## Fluidité (deux audits, Opus et Kimi K3)

| | Avant | Après |
|---|---|---|
| Liste des agents (`/api/agents`) | 33 ms | 5 ms |
| Premier signe après Envoyer | 65 ms | 49 ms |
| Réponse de la voix rapide | 630 ms | 366 ms |
| Premier affichage (app de bureau, cache chaud) | — | 116 ms |

- **Fil de discussion** : la fonction de conversion des messages était recréée à chaque rendu, ce qui vidait le cache
  d'assistant-ui. Tout le fil était reconverti à chaque image du flux ; seul le dernier message l'est maintenant.
- **Texte qui s'écrit** : révélation douce de 100 ms au lieu de 250. Le texte arrive plus tôt et le Markdown est
  analysé trois fois moins souvent.
- **Relevés toutes les 4 s** : rien n'est redessiné si les données n'ont pas changé, et tout s'arrête quand la
  fenêtre est cachée.
- **Changer de conversation** : ses messages et la liste des fils sont gardés en mémoire. Ils s'affichent tout
  de suite, puis la version du serveur arrive derrière.
- **Serveur** : un client HTTP partagé vers les agents, le lanceur et les navigateurs. Avant, chaque appel créait
  un client, soit environ 15 ms de travail bloquant. La santé des agents est gardée 5 s, une seule requête SQL
  sert la liste, et l'état de l'écran fait ses deux appels en parallèle.
- **Voix rapide** : le choix du modèle est mémorisé, et le catalogue OpenRouter est relu en tâche de fond.
- **Polices** : servies par le service worker depuis le cache, sans attendre Google à chaque ouverture.
- **Compactage après inactivité retiré** : Hermes le faisait au message suivant, avant de répondre. Cela coûtait
  plusieurs secondes au premier message après une pause.

## Prochaines pistes (non faites)

- **Historique paginé** (80 derniers messages) et `content-visibility` sur les messages.
- **Taux de cache de prompt** à relever dans `/api/usage`, puis à corriger si le modèle ne profite pas du cache.
