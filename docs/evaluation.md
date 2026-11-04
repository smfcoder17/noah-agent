# Évaluation et hill climbing de Noah Agent

État chiffré : [etat.md](etat.md). Journal des tours : [journal-hill-climb.md](journal-hill-climb.md).

## Promesse et décision

**Promesse.** Je déploie Noah en un clic sur mon VPS, je relie mon ordinateur et mon téléphone, et je peux appeler mes agents, leur faire travailler ensemble et me faire rappeler quand c'est fini. Tout est open source, léger, et je branche les outils que je veux.

**Décision.** Le score dit si on garde un changement et si une version peut sortir.

**Gain minimal.** Sur le temps entendu en vocal : 150 ms en médiane, et plus que le bruit mesuré. Sur la réussite des tâches : 5 points.

## Ce qui ne marchait pas

1. **Le score mesurait le travail, pas la promesse.** Un critère vert par test simulé comptait comme un parcours réel vécu. Le score déclaré était donc très au-dessus de la réalité.
2. **Le banc vocal ne regardait pas le bon moment.** `perf.md` annonce 754 ms « depuis la fin de la phrase transcrite », et oublie l'attente de fin de tour, qui est la plus longue étape.
3. **Rien ne mesurait le bruit, ni les tests eux-mêmes.** Un test peut rester vert sur un code cassé.
4. **Les audits suivaient une note sur 10 sans lot réservé.** Une revue qui connaît les corrections précédentes les revalide.
5. **La grille ne couvrait pas l'essentiel de la nouvelle demande** : appel, coordination, profils, partage, outils au choix, légèreté.

## Le système, en cinq couches

### 1. Niveau de preuve

Chaque critère exige un niveau. Un niveau inférieur ne donne aucun point, même si le test est vert.

| Niveau | Preuve |
|---|---|
| 0 | Écrit ou déclaré, jamais exécuté |
| 1 | Test automatique avec simulations |
| 2 | Vrais conteneurs ou vrai navigateur, en local |
| 3 | Conditions réelles : VPS neuf, téléphone, 4G |
| 4 | Personne réelle, à l'aveugle |

`node tools/eval/score.mjs` calcule le score prouvé et le score déclaré. L'écart entre les deux est le travail de vérification restant.

### 2. Dix parcours de bout en bout

Les parcours J1 à J10 de [etat.md](etat.md) sont la promesse. Une version publique n'est prête que si tous sont tenus au niveau 3. Ils ne remplacent pas les critères : les critères expliquent pourquoi un parcours casse.

### 3. Mesures par le code

- **Vocal, ressenti :** `node tools/eval/voice_browser.mjs <étiquette> <répétitions> <lot>`. Il passe par le vrai composant : temps entendu depuis la fin de la parole, interruption, coupures à tort.
- **Vocal, serveur :** `python -m apollo.bench_voice <étiquette> <répétitions> <lot>`. Il mesure la transcription, le premier octet, le tri entre action et conversation, les erreurs de mots et le coût.
- **Chat et interface :** `python -m apollo.bench`.
- **Sensibilité des tests :** `node tools/eval/sabotage.mjs` abîme le code exprès, un défaut à la fois, avec un témoin sans défaut.
- **Calculs :** `node tools/eval/stats.mjs` donne le gain apparié avec son intervalle, le bruit, l'accord entre juges et le classement.

Le temps entendu se mesure dans le vrai composant, jamais par une formule. Une mesure qui saute une étape n'est pas recevable, et un tour en échec compte contre le score. Le lot réservé est écrit par un autre modèle et vit hors du dépôt.

### 4. Réussite des tâches vocales

Le schéma vient de [VAmoS Bench](https://arxiv.org/html/2607.27453) et de [MTVA-Bench](https://arxiv.org/html/2609.20152) :

- un appelant simulé suit un plan, en français, par vraie synthèse vocale ;
- 30 scénarios : 20 de travail, 6 réservés, 4 garde-fous. Ils couvrent les questions, les outils, la délégation à un autre agent, le rappel et l'action à confirmer ;
- le code vérifie les appels d'outils et leurs arguments. Les juges ne notent que ce que le code ne peut pas voir, et leurs citations sont vérifiées ;
- un appel sans verdict compte comme un échec ;
- l'échec est localisé : transcription, modèle, outil ou voix. Un score global ne dit pas quoi corriger.

Ce banc **reste à construire** : c'est le premier chantier du vocal.

### 5. Goût et expérience

Le goût ne s'écrit pas : il se montre.

- **Références :** Grok Bot, OpenAI Dots, Claude Duet, Meta Muse pour le produit ; OpenClaw et Hermes pour l'open source.
- **Grille de comportements :** 20 comportements observables relevés sur ces produits, chacun avec sa source. Exemples : comment on démarre un appel, ce qu'on entend pendant qu'un outil travaille, comment l'agent demande une confirmation.
- **Comparaison à l'aveugle :** captures de même durée, dans les deux ordres, sans dire laquelle est Noah. Trois fournisseurs de juges, et le juge n'est jamais le modèle testé. Aucun juge ne lit le plan ni le raisonnement.
- **Audit des juges :** ils doivent se répéter, voir les sabotages et classer les références au-dessus des mauvais exemples. Sinon, on les retire.
- **Verdict humain :** 30 minutes au départ, puis un verdict à chaque palier.

## Règle du hill climbing

1. **Hypothèse écrite avant le code :** cause, changement, critère qui doit bouger, critère qui peut reculer, gain prédit.
2. **Un seul changement,** sur une branche nommée.
3. **Entonnoir :** 2 cas pour filtrer, le lot de travail avec la base appariée, le lot réservé aux paliers seulement. Chaque consultation du lot réservé est comptée.
4. **Garder seulement si :** la borne basse du gain dépasse zéro, le gain atteint le minimum, aucun garde-fou ne tombe et le niveau de preuve exigé est atteint. Sinon on annule, même si le code est élégant.
5. **Rôles séparés :** l'optimiseur ne voit pas le lot réservé et ne modifie pas l'évaluation. Le juge n'est jamais l'optimiseur. Un script applique la décision.
6. **Audit Codex à l'aveugle :** il reçoit le code et la promesse, sans les notes ni les audits passés.
7. **Plateau après 2 ou 3 tours plats :** on vérifie le juge, puis le cas, puis la variance, et seulement ensuite on change d'architecture.

Une évaluation modifiée change de version, et la base est rejouée. Une modification faite pour faire monter un score est un défaut.

## Ce qu'on sait du speech-to-speech

| Fait | Source | Conséquence |
|---|---|---|
| Cascades : 71 % de tâches réussies et 1,95 s (Pipecat). Speech-to-speech : 67 % et 1,53 s (OpenAI Realtime), 62 % et 1,38 s (Gemini Flash Live) | [VAmoS](https://arxiv.org/html/2607.27453), banque en anglais | Le speech-to-speech est plus rapide, pas plus capable. Le gain se mesure sur nos tâches |
| Moshi et PersonaPlex répondent en moins de 300 ms, mais PersonaPlex est annoncé en anglais seul | [fiches citées par Ry Walker](https://rywalker.com/research/agentic-voice-apis) | Pas de français confirmé ; ils ne répondent pas à notre besoin aujourd'hui |
| Les modèles full-duplex avec outils tournent sur GPU : H100 selon un résumé non vérifié de [VoiceChat](https://arxiv.org/html/2609.21967) | Lecture partielle | Non applicable au VPS KVM 2 sans GPU. À réserver à une option GPU |
| Le catalogue OpenRouter public liste `gpt-audio` et `gpt-audio-mini` en entrée et sortie audio | Appel du 3 novembre 2026 | Seuls ces deux modèles sont candidats. Je n'ai trouvé aucune session continue sur OpenRouter |
| Un modèle rapide parle pendant qu'un modèle lent exécute les outils | [Frontend-backend](https://arxiv.org/html/2609.19334) | Notre voix rapide plus l'agent Hermes suit déjà ce schéma. On le garde |

Les chiffres de ces bancs viennent de protocoles différents des nôtres : ils guident les hypothèses, ils ne fixent pas de classement.

## Hypothèses vocales, dans l'ordre

Chacune est un tour de hill climbing, jugé sur le même banc.

| # | Changement | Pourquoi | Gain attendu |
|---|---|---|---|
| H1 | Fin de tour par le sens au lieu du seul silence (par exemple Smart Turn, ouvert) | C'est aujourd'hui la plus longue attente | Plusieurs centaines de ms |
| H2 | Transcription en flux, mot à mot | Plus d'envoi par morceaux après 700 ms de pause, et une fin de tour mieux informée | Quelques centaines de ms |
| H3 | Transport audio continu sur 443 (WebSocket), puis WebRTC si le mobile le demande | Moins de mise en tampon qu'un élément `Audio` ; interruption immédiate | Interruption sous 200 ms |
| H4 | Couche voix interchangeable, avec en option une session hébergée (OpenAI Realtime, Gemini Live, Grok Voice) | C'est la seule façon de comparer le speech-to-speech à notre cascade | Mesuré sur le banc |
| H5 | Annulation d'écho et distinction d'un « mm-hm » d'une vraie interruption | Défaut classique des appels | Moins d'arrêts à tort |

**LiveKit ou Pipecat ?** LiveKit gère la salle, le WebRTC et le SIP, a un SDK Android, et est sous licence Apache-2.0, mais il ajoute un serveur et demande des ports UDP. Pipecat est une chaîne Python légère, sous licence BSD-2, sans transport propre. On commence par une chaîne légère sur le port 443, conforme à G7.1 et G14.4. LiveKit doit gagner sa place au banc en 4G.

## Bases open source à reprendre

| Besoin | Point de départ | État |
|---|---|---|
| Voix, chaîne | Pipecat, Smart Turn | Licence lue ; à tester |
| Voix, transport et SIP | LiveKit, seulement si le banc le justifie | Licence lue ; à tester |
| Écran d'appel Android | `ConnectionService` et notification plein écran d'Android | Absent de l'app ; à vérifier sur téléphone |
| Outils | MCP côté Hermes : Noah sait déjà ouvrir son catalogue et son OAuth | Il manque l'ajout par adresse |
| Profils | Hermes propose des profils isolés ; Noah a déjà ses agents dans des conteneurs séparés | Profils, droits et partage faits (G12, preuve de niveau 1) ; à vérifier sur de vrais conteneurs |
| Partage et droits | Open WebUI et LibreChat, à étudier | **Non lus** |

## Limites de ce document

- Je n'ai pas regardé les vidéos YouTube : seuls leurs titres et descriptions ont été lus. La grille de comportements (G15.1) reste à faire, à partir de leur visionnage.
- Les sources sur Grok Bot, Dots, Duet et Muse sont surtout secondaires.
- Les seuils de G10 sont provisoires : on les recalera sur les références mesurées avec notre banc.
- Le niveau de preuve de chaque critère a été posé à partir des tests et de l'historique, sans repasser chaque critère. Un audit indépendant doit le confirmer.
