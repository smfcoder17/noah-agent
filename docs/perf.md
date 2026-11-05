# Réactivité de Noah Agent

Mesure : `docker exec noah-server python -m noah.bench <étiquette> <répétitions>`. Les résultats
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

## Un message court : où passe le temps (5 novembre 2026)

Bancs : `tests/real/vitesse.py` (découpe du temps, faux fournisseur à latence connue), `tests/real/vitesse_ecran.mjs` (de la touche Entrée au premier mot, dans un navigateur), `tests/real/reprise_vrai.py` (demande restée en suspens, vrais modèles). Vrais conteneurs Hermes sur la machine locale, médianes.

| « bonjour » | Avant | Après |
|---|---|---|
| Notre part, conversation chaude (fournisseur à 0 ms) : première réaction | 169-219 ms | 210 ms, sans changement : il n'y a rien à y gagner |
| Premier message après un redémarrage de l'agent | 2 800-5 100 ms | 224-667 ms (chauffe) |
| Premier mot dans une longue conversation, cache froid, au pire | 16,7 s (Kimi K3), 6,1 s (DeepSeek Flash) | ~6 s (Kimi K3), ~2,8 s (DeepSeek Flash) : contexte borné à 64 000 jetons |
| Le tour qui déclenche le résumé (résumé de 5 s) | 5 637 ms | 239 ms si la personne écrit après le résumé d'avance |
| « hi » pendant que l'agent attend la réponse à son appel (mis à la suite) | 153,5 s | 1,0 s |
| « hi » après une demande restée en suspens : relance ses outils | 9 fois sur 10, 6 à 136 s (DeepSeek Flash, GLM 5.3 Flash) | 0 fois sur 28, 1 à 7 s (les mêmes et GPT-OSS 120B) |

Premier mot par fournisseur pour un « bonjour » en cache (8 essais alternés, 17 000 jetons envoyés), à ajouter à notre part : GPT-OSS 120B ~400 ms, GLM 5.3 Flash ~700 ms, DeepSeek Flash ~900 ms. G14.1 (800 ms) est donc à portée sur les modèles les plus rapides, pas sur tous. Dans le navigateur, la ligne « Réflexion… » s'affiche en ~30 ms, et l'écran ajoute 100 à 300 ms au premier mot.

**Ce qui ne gagne rien, donc laissé tel quel :**
- Retirer les schémas d'outils (10 000 jetons sur 17 000), en garder 14 sur 28, ou retirer la liste des compétences : dans le bruit quand le cache joue, sur les trois modèles. Le cache du préfixe fait déjà le travail. Ça reste une économie de coût possible, pas de vitesse.
- Effort de raisonnement « low » pour tous : -66, +75 et -255 ms selon le modèle, et « none » fait écrire son raisonnement à GLM dans la réponse.
- Réduction des vieux résultats d'outils sans modèle (`proactive_prune_tokens`) : le résumé passe avant elle, avec les 20 derniers messages protégés.

**Reste à mesurer :** le même découpage sur le VPS (les limites CPU locales à 1 et 0,5 cœur ne changent rien au chemin chaud), et le cache d'une heure de Claude (`prompt_caching.cache_ttl`), faute de clé Anthropic valide dans `.env`. Un message envoyé dans les secondes qui suivent le retour de l'agent paie encore son démarrage (~10 s) : la chauffe tourne en même temps.

## Correction du 3 novembre 2026

Le « premier son » de 754 ms ci-dessus part de la fin de la phrase transcrite. Depuis la fin de la parole, le temps entendu est de **2 277 ms en médiane** : voir [journal-hill-climb.md](journal-hill-climb.md). Le banc de référence du vocal est maintenant `python -m noah.bench_voice`.
