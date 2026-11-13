# Noah Agent 0.2.0 : un agent qui prend l'initiative et va au bout

But : dès le premier jour, l'agent fait des choses pour la personne sans qu'elle le demande, prépare et fait confirmer (ou agit, en mode Agir), et mène une tâche jusqu'au bout. Sans coûter plus cher, et plus vite.

Sources : diagnostic du code 0.1.9 et deux recherches du 12 novembre 2026 (agents proactifs, navigateurs d'agent). Rien n'a été mesuré dans ce document : chaque lot prouve son changement par un test.

## Pourquoi Noah ne prend aucune initiative aujourd'hui

Le moteur existe (`server/noah/proactif.py`, une passe par minute), mais une installation neuve le laisse éteint.

- `proactif.mode()` rend « coupé » tant que l'agent n'a ni objectif, ni Google relié, ni outil MCP en lecture. Un agent neuf n'a rien de cela.
- Les modèles d'agent ne créent aucune routine : ils affichent « 2 routines à proposer », sans bouton.
- La seule initiative sans source, l'idée du jour, exige un objectif écrit, et aucun écran de départ n'en demande.
- Quand une initiative part, c'est un message texte dans la conversation. « À toi » ne la montre pas, et rien ne se confirme d'un geste.
- Le prompt dit « ne relance rien tant que la personne ne le demande pas ». Rien ne demande à l'agent de proposer une suite, ni de reprendre une tâche non finie.

## Principes retenus

| Principe | D'où il vient | Ce que Noah en fait |
|---|---|---|
| Silence par défaut, avec un contrat clair | OpenClaw (`HEARTBEAT_OK`), Hermes (`[SILENT]`) | Déjà là : le tri répond « rien ». On le garde |
| Trois sorties : signaler, demander, soumettre | LangChain, agents ambiants | Une proposition devient une carte dans « À toi », avec « Fais-le » et « Non » |
| Pas de modèle quand rien n'a changé | Hermes, mode sans agent | Déjà là (`watch.py`). On le garde partout |
| Un petit modèle trie, le gros n'agit que sur décision | OpenClaw, Poke | Déjà là pour le tri. L'idée du jour reste sur le petit modèle |
| Proposition du jour, jugée par un pouce | ChatGPT Pulse | L'idée du jour part sans objectif, depuis le rôle de l'agent. Un refus s'apprend |
| Plan relu et critères de fin | Manus, Anthropic | Le prompt demande un critère de fin, une vérification, puis une suite proposée |
| Compétences écrites par l'agent | Hermes `skill_manage` | Le prompt demande d'en créer une après une tâche réussie qui reviendra |
| Échelle de confiance | LangChain, Hermes | Signaler (par défaut), puis préparer et faire confirmer, puis Agir et rendre compte |
| Heures actives et budget de messages | OpenClaw `activeHours` | Réglables, 8 h à 21 h par défaut, 3 propositions par jour au plus |

L'article X n'a pas été retrouvé avec certitude. Le plus proche : « I Gave Myself a 24/7 AI Assistant » (Leo Ye, février 2026), sur OpenClaw. La source technique derrière ces articles est le battement de cœur d'OpenClaw.

## Lots

### Lot 1. Initiative dès le premier jour (serveur)

- « Me signaler » par défaut dès qu'un agent existe. Le réglage « Rien » reste possible.
- Idée du jour sans objectif : tirée du rôle de l'agent, de sa mémoire et de ses dernières conversations. Petit modèle, une fois par jour.
- Propositions enregistrées (`propositions.py`) : texte, action prête, état. Elles sortent dans `/api/a-toi`. `POST /api/propositions/{id}/reponse` avec `{"choix": "faire" | "non"}` : « faire » envoie la demande à l'agent, « non » s'apprend.
- Premier relevé d'une source neuve : un résumé de l'état, au lieu d'apprendre en silence.
- Briefing du matin : une proposition par jour, à l'heure choisie, quand il y a de quoi dire.
- Tâche non finie : un tour « de lui-même » interrompu se reprend une fois, puis le dit.
- Heures actives et plafond de propositions réglables.

Fini quand : un test crée un agent neuf, sans objectif ni connexion, fait avancer l'horloge, et trouve une proposition dans `/api/a-toi` ; « faire » lance un tour ; « non » n'en lance pas ; rien ne part hors des heures actives ni au-delà du plafond ; aucun modèle n'est appelé quand rien n'a changé.

### Lot 2. Prêt dès la création (modèles d'agent et premier lancement)

- À la création depuis un modèle, ses routines sont posées en pause. Un geste les active.
- Premier message de l'agent, écrit une fois : ce qu'il peut faire seul, avec ses routines à activer.
- Premier lancement : « Qu'est-ce que tu veux atteindre ? », qui crée un objectif. Facultatif.

Fini quand : un test crée un agent depuis chaque modèle et retrouve ses routines en pause ; l'activation en démarre une ; le premier message existe une seule fois.

### Lot 3. Aller au bout (prompt de l'agent)

- Bloc « Façon de travailler » : fixer un critère de fin avant de commencer, vérifier le résultat, finir par ce qui est fait et ce qui reste.
- Après une tâche : proposer une suite concrète, ou une routine si la tâche reviendra. La phrase « ne relance rien » est retirée.
- Après une tâche réussie qui reviendra : écrire une compétence.
- Quand il est bloqué : chercher une autre voie avant de demander, et dire ce qu'il a essayé.
- `AGENT_SETUP_VERSION` monte.

Fini quand : les tests du prompt passent avec les nouvelles consignes, et le corpus du juge reste vert.

### Lot 4. « À toi » et réglage visibles (interface)

- Carte de proposition dans « À toi » : le texte, « Fais-le », « Non ». Aussi dans la conversation.
- Le réglage « Quand tu ne lui parles pas » sort du panneau Détails : visible sur l'écran de l'agent, avec les heures actives.
- Routines en pause du modèle : bouton « Activer ».

Fini quand : `tsc`, `vitest` et le build passent, avec un test par carte.

### Lot 5. Navigateur plus rapide (mesure d'abord)

Aujourd'hui : Camoufox (Firefox furtif) sans carte graphique, 20 s pour la première page, jusqu'à 1,8 Go par onglet lourd. Candidat : Chrome avec écran, piloté par CDP, que Hermes sait déjà utiliser (`BROWSER_CDP_URL`). On garde noVNC, la prise en main et les connexions enregistrées. Camoufox reste en secours pour les sites qui bloquent Chrome.

- Écrire le banc `tools/eval/navigateur.mjs` : 10 tâches, 3 passages, temps, mémoire, réussite.
- Construire l'image Chrome + noVNC et mesurer les deux.
- Basculer seulement si Chrome gagne : au moins 90 % de réussite, moins de mémoire, plus rapide. Sinon Camoufox reste.

Ce lot ne bloque pas la 0.2.0 : la bascule sort quand la mesure la justifie.

## Coût : ce qui ne bouge pas

Rien de neuf, aucun appel de modèle. Plafond de dépense lu avant chaque relevé. 12 tours par jour, une idée par jour sur le petit modèle, un seul tour à la fois.

## Mesure

- Initiative : sur un agent neuf, nombre de propositions utiles le premier jour (0 aujourd'hui, 1 à 3 visé), et part acceptée.
- Aller au bout : 10 tâches du quotidien jouées par des agents de test, part finie sans relance.
- Coût : appels de modèle par jour d'un agent au repos, avant et après.
- Navigateur : le banc du lot 5.

## Livré (13 novembre)

Les lots 1 à 6, puis quatre lots tirés des vraies conversations de Franck (424 messages lus sur son serveur) :

- **A. Présenter.** Les liens de posts X ne sont plus masqués (3 identifiants sur 11 passaient pour des cartes bancaires). Le prompt donne une table « ce que tu présentes → le bloc », avec un exemple par bloc et trois blocs neufs : posts, produits, liens. Tableaux, grilles et graphiques s'affichent dans le fil, avec « Agrandir ».
- **B. Naviguer.** Barre de gauche refaite : les agents en haut, celui qui est choisi déplie Discussion, Activité, Tâches, Fichiers, Ordinateur et Historique. Plus de liste de discussions.
- **C. Navigateur et X.** L'écran Ordinateur ne se cache plus tout seul (la connexion noVNC est suivie en direct). Refus de X pour activité automatisée (226) ou limite du jour (344) : l'agent s'arrête au premier, Noah ne renvoie rien avant l'heure de reprise. `publier_post` prend une vidéo MP4 ; le navigateur lit le H.264 (libavcodec).
- **D. Routines.** Une routine en panne dit une phrase, une fois, sans consigne interne ni adresse de clé ; la reprise est dite une fois.
- **Juge.** Le dossier temporaire d'Hermes vaut `/tmp` : plus de carte en Auto pour y écrire.

Banc du navigateur (`tools/eval/navigateur.mjs`, 10 tâches, 3 passages, 4 cœurs, 4 Go) : Camoufox 30/30 en 66 s, pic 654 Mo ; Chromium par CDP 30/30 en 20 s, pic 434 Mo. Le blocage par les sites n'est pas mesuré. Aucune bascule dans cette version.

Non vérifié : une vraie publication sur X ; le banc sur un VPS.

À décider : bascule vers Chromium (essai anti-bot d'abord, 2 à 3 jours) ; API X payante comme voie normale (0,015 $ le post, 0,20 $ avec lien) ; bouton « Nouvelle discussion » du mobile ; plafond de propositions par compte ; `pip` et `npm` sans carte en Auto.
