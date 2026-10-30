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

## Prochaines pistes (non faites)

- **TTS en flux** : lire la voix pendant qu'elle arrive, ou un accusé pré-rendu. C'est le plus gros gain
  restant sur le premier son en mode vocal, environ 1 s.
- **Micro gardé ouvert** pendant toute la session vocale, au lieu de le rouvrir à chaque tour.
- **Historique paginé** (80 derniers messages) et `content-visibility` sur les messages.
- **Taux de cache de prompt** à relever dans `/api/usage`, puis à corriger si le modèle ne profite pas du cache.
