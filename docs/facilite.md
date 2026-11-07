# Facilité des actions courantes

Note sur 20 de la facilité des gestes que la personne fait le plus souvent, comparée à Grok Bot et Muse. Objectif : **18/20** sur ordinateur et sur téléphone. Journal des tours : [journal-hill-climb.md](journal-hill-climb.md), section « Facilité ».

## Promesse et décision

**Promesse.** Ce qu'on fait tous les jours avec Noah se fait aussi vite et aussi clairement que chez Grok Bot ou Muse, sans mot technique, sur ordinateur comme sur téléphone.

**Décision.** Garder ou annuler un changement d'interface. **Gain minimal :** 1 point sur la moyenne d'un appareil, borne basse de l'intervalle au-dessus de zéro.

## Les actions

| | Action | Référence (gestes) |
|---|---|---|
| A3 | Créer un agent | Grok Bot : « + », nom, « Create » (3) |
| A4 | Connecter un outil | Grok Bot : « Connect apps », « Authenticate » (2) |
| A6 | Voir les tâches programmées | Grok Bot : nom de l'agent, « Details » (2) |
| A7 | Retrouver un fichier produit | Grok Bot : nom de l'agent, « Library » (2) ; Muse : Bibliothèque |
| A8 | Appeler l'agent | Grok Bot : « Start voice chat » (1) |
| A9 | Changer de modèle | sélecteur, noms lisibles (2) |
| A10 | Voir ce que l'agent a fait | journal ou fil (1) |
| A11 | Relier son téléphone | réglages, appareils, QR ou code (2) |

**Lot réservé**, jamais travaillé : voir la dépense du mois (R1, 2 gestes), changer la couleur de l'agent (R2, 2), déconnecter un appareil (R3, 3), mettre en pause une tâche (R4, 3). Celui qui améliore l'interface ne lit que leur note, jamais leurs captures. Chaque consultation est comptée dans le journal.

Pas encore mesurés : envoyer un message (A1), arrêter un travail (A2), programmer une tâche (A5) et répondre à un accord. Ils demandent un vrai modèle ou un accord mis en scène ; la carte d'accord a son banc à part (`tests/real/chat_pendant_serveur.py`, déclencheur `JUGE`).

Sources des références : documentation de Grok Bot (docs.x.ai/grok-bot, pages Get started, Bots, Chat and collaboration, Files and results, Skills and routines, Approvals), centre d'aide de Muse (meta.com/help/superintelligence), et la vidéo Muse envoyée par la personne le 6 novembre.

## La mesure

1. **Banc** : `tools/eval/facilite.mjs` fait chaque action dans le vrai Noah, par le chemin le plus court, sur ordinateur (1280×800) et sur téléphone (`MOBILE=1`, 390×844). Il compte les gestes, dit si le point de départ se voit dès l'accueil, attend la fin des chargements (au plus 12 s, compté à part) et garde une capture par geste. Il ne lance ni agent ni connexion : le dernier geste qui changerait quelque chose est compté, pas joué.
2. **Juges** : trois modèles de fournisseurs différents (Anthropic Sonnet et Haiku, Kimi par Ollama) regardent les captures de deux états anonymes, sans savoir lequel est le nouveau, et notent de 0 à 4 la clarté des mots, le retour après le dernier geste et la facilité comparée à la référence.
3. **Note** : `tools/eval/facilite-note.mjs`. Par action : 6 points pour les gestes (moins 2 par geste au-delà de la référence), 2 si le départ se voit, 12 pour la moyenne des juges. Intervalle à 90 % par rééchantillonnage des actions.

Le verdict de la personne passe avant les juges : s'il les contredit, la note a tort.

## Versions

- **v1 (7 novembre)** : l'état modifié était servi par le serveur de dev de l'interface, qui se faisait refuser les écritures (« elle ne vient pas de Noah »), et les captures étaient prises avant la fin des chargements. Écart faussé, non retenu.
- **v2 (7 novembre)** : origine corrigée dans `frontend/vite.config.ts`, attente de fin de chargement, 32 notes par juge.
- **v3 (7 novembre)** : lot réservé R1 à R4, 48 notes par juge ; le banc prend toujours le bouton à l'écran et le chemin le plus court qui existe.

- **v3.1 (7 novembre)** : connecter un outil attend la liste des outils avant la capture (elle était prise vide).

Limite connue : le banc tourne sur l'adresse locale en HTTP. Relier un téléphone n'y montre pas de QR, par choix de sécurité (jamais de QR vers une adresse non chiffrée) ; A11 ne se juge vraiment que sur le VPS.

## Base

Banc v1, juges Sonnet et Kimi, état avant les changements du 7 novembre : **12,9/20 sur ordinateur** (90 % : 11,1 à 14,9) et **12,2/20 sur téléphone** (10,7 à 13,9). Ce qui coûte le plus, selon les juges : relier un téléphone (jargon HTTPS et Tailscale, pas de QR), le modèle affiché par son identifiant technique sans sélecteur visible, les fichiers cachés sous Ordinateur, les onglets du panneau coupés sur téléphone, les routines longues à charger.

## Palier du 7 novembre

Banc v3, mêmes trois juges, état au commit `d7ab8f4` face à la base : **16,7/20 sur ordinateur** (90 % : 14,9 à 17,8) et **15,5/20 sur téléphone** (14,2 à 16,8). Le gain tient sans chacun des juges.

Ce qui manque pour 18 : relier un téléphone (sans QR tant que l'adresse est en HTTP ; le banc tourne en local), créer un agent et connecter un outil en un geste de trop sur téléphone, aucune confirmation visible après « Créer l'agent » ou « Connecter » (le banc ne les joue pas), noms de modèles obscurs. Lot réservé construit au tour 7 (voir plus haut).
