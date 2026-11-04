# Journal du hill climbing

Une entrée par tour, échecs compris. Méthode : [evaluation.md](evaluation.md).

## Cadre

- **Objectif :** tenir les parcours J1 à J10 au niveau de preuve exigé.
- **Gain minimal :** 150 ms sur le temps entendu en vocal ; 5 points sur la réussite des tâches.
- **Arrêt :** tous les parcours tenus et le verdict humain à l'aveugle (G15.3), ou décision de la personne.
- **Budget :** à confirmer. Le banc vocal coûte environ 0,01 $ par passage de 30 tours.
- **Consultations du lot réservé :** 1, depuis qu'il a été réécrit par un autre modèle, hors du dépôt.

## Base du 3 novembre 2026 (banc version 2)

Mesure dans le vrai composant `Voice.tsx`, avec un faux micro : depuis la fin de la parole jusqu'à l'événement « playing ». Machine locale, voix de synthèse, cerveau sur OpenRouter. Une partie des mesures a tourné en même temps que le test des mises à jour, avec peu de mémoire libre : le bruit est sans doute surestimé.

| Mesure | Travail (42 tours) | Réservé (24 tours) |
|---|---|---|
| Temps entendu, médiane | 2 457 ms | 2 145 ms |
| Temps entendu, p95 | 4 120 ms | 3 253 ms |
| Jusqu'à l'envoi du tour, médiane | 1 506 ms | 1 408 ms |
| Voix, de l'envoi au premier son, médiane | 878 ms | 785 ms |
| Échecs | 0 | 0 |
| Coupures à tort, pause de 1,5 s | 9 sur 9 | 9 sur 9 |

**Côté serveur (42 tours, lot de travail).** Transcription : 760 ms. Premier octet de la voix : 594 ms. Tri juste : 97,6 %. Erreurs de mots, total sur total : 2,1 %. Coût : 0,00033 $ par tour.

**Interruption.** Sur 5 essais, 3 ne coupent pas la voix. Les 2 autres la coupent en 538 ms. L'objectif est 200 ms.

**Bruit.** Écart entre deux lancers d'un même cas : 732 ms. Un gain de 150 ms n'est pas détectable dans ces conditions. Il faudra remesurer sur une machine au calme avant de décider d'un tour.

**Chat (`apollo.bench`, 5 répétitions, banc version 1).** Première réaction : 528 ms (salut), 441 ms (question), 668 ms (commande). Réponse finie : 674, 711 et 1 352 ms.

**Légèreté, au repos, un agent.** Serveur 73 Mo, lanceur 40 Mo, agent 258 Mo, navigateur 332 Mo. Images : Hermes 4,31 Go, Camoufox 4,08 Go, serveur 275 Mo, lanceur 239 Mo. Soit près de 9 Go à télécharger sur un VPS neuf, ce qui menace les 10 minutes du parcours J1.

**Sensibilité des tests.** 4 sabotages sur 4 vus lors du dernier passage, avec témoin vert. Ce passage datait d'avant la règle qui exige une assertion : il reste à rejouer.

**Audit Codex à l'aveugle : 4/10.** Il a corrigé ce système :

- preuves surévaluées ramenées à leur niveau réel (G3.2, G3.5, G3.6, G2.2, G2.4, G4.1, G5.1, G5.5, G6.8, G7.4, G7.5, G7.7) ;
- le temps entendu calculé par formule était faux, il est maintenant mesuré dans le composant ;
- le lot réservé était lisible dans le code, il vit maintenant hors du dépôt ;
- les fonctions centrales ne se compensent plus entre elles ;
- `score.mjs --release` refuse la publication tant qu'un parcours n'est pas tenu ;
- un critère open source (G16) et un budget de téléchargement (G14.6) ont été ajoutés.

**Ce que la base apprend.**

- L'attente avant l'envoi et la voix pèsent à peu près 60 % et 40 % du temps entendu. Le chiffre de 754 ms de `perf.md` n'en montrait qu'une partie.
- Une pause de 1,5 s coupe toujours la personne : c'est le défaut le plus visible, avec l'interruption.
- « Bonjour. » revient transcrit « Bonjour. Bonjour. » : il reste à savoir si le doublon vient de la voix de test ou de la transcription.
- `apollo.bench` était cassé depuis la garde anti-CSRF (403) et personne ne l'avait vu : il passe maintenant par un jeton, comme les apps.

**Non mesuré.** Le réseau d'un VPS et de la 4G, l'écho d'un vrai haut-parleur, les vraies voix, le bruit de fond.

## Base du 4 novembre 2026 (banc navigateur version 3, cerveau et voix rapide sur Ollama)

Cerveau et voix rapide : `deepseek-v4.1-flash:cloud`. Transcription et synthèse : OpenRouter. Agent et navigateur arrêtés, même machine pour tous les tours. Mémoire libre : 956 Mo au départ du lot travail, donc un peu sous la limite demandée de 1 Go, puis 1,7 à 1,8 Go. Je le note plutôt que de le rejouer.

**Banc corrigé d'abord (commit à part).** Les « 3 interruptions ratées sur 5 » venaient du banc, pas du produit : il attendait le libellé « Je t'écoute », qui s'affiche aussi pendant que la voix se prépare, et l'essai suivant partait sur la réponse du précédent. Une fois corrigé : 0 raté sur 5. L'ancien chiffre ne doit plus être cité. Le banc attend maintenant que plus rien ne soit en cours. Une coupure compte le son entendu ou le tour envoyé, et non une réponse préparée en silence. Des mots brefs par-dessus la voix sont ajoutés. Le doublon « Bonjour. Bonjour. » vient de la voix de test : le fichier contient deux fois le mot, à 1,2 s d'écart. Je ne l'ai pas changé.

| Mesure | Travail (42 tours) | Garde (6 tours) |
|---|---|---|
| Temps entendu, médiane | 2 634 ms | 2 368 ms |
| Temps entendu, p95 | 4 023 ms | 3 283 ms |
| Jusqu'à l'envoi du tour, médiane | 1 373 ms | 1 404 ms |
| Voix, de l'envoi au premier son, médiane | 1 232 ms | 991 ms |
| Échecs | 1 (c2) | 0 |

**Interruption :** 0 ratée sur 5, arrêt franc en 524 ms (439 à 573). **Arrêts à tort sur un mot bref :** 4 sur 6 (« Mm-hm. » et le « Bonjour » du lot garde coupent, « Oui. » non). **Coupures, pause de 1,5 s :** 9 sur 9.

**Côté serveur (42 tours, travail).** Transcription 697 ms, premier octet de la voix 866 ms (p95 1 270 ms), tri juste 97,6 %, erreurs de mots 2,1 %, 0,00017 $ par tour, 1 échec. Garde : transcription 714 ms, premier octet 752 ms, tri 100 %, erreurs de mots 9,1 % (le doublon « Bonjour »).

**Bruit.** Écart type intra-cas 488 ms. Gain détectable à 95 % : 362 ms à 1 répétition, environ 209 ms à 3. Un gain de 150 ms reste sous le bruit dans ces conditions : la borne basse de l'intervalle décide.

## Tours

### T1, interruption

- **Cause.** Le niveau de voix n'est pas en cause (RMS de 0,2 environ pour un seuil de 0,05). L'arrêt attend 250 ms de voix nette, avec un compteur qui redescend à chaque creux, et ce temps est plus court qu'un mot bref : « Mm-hm. » ou « Bonjour » coupent. Allonger la confirmation seule retarderait l'arrêt. En outre, l'événement « playing » revient après chaque manque de données et remet le compteur à zéro.
- **Hypothèse.** Deux temps : la voix baisse dès 100 ms de parole, l'arrêt franc vient après 600 ms de parole (550 ms au premier essai : 1 arrêt à tort sur 6 sur le « Bonjour » du lot garde), et la voix remonte si la parole retombe avant. « Bonjour » dure 500 ms au plus.
- **Changement.** `Voice.tsx` : compteur de parole continue avec tolérance de 150 ms, baisse puis arrêt, un seul signal « playing » par lecture.
- **Doit bouger.** Arrêts à tort : de 4 sur 6 à 0 sur 6. Baisse de la voix : 250 ms environ, à comparer à l'objectif de 200 ms.
- **Peut reculer.** L'arrêt franc : de 524 ms à environ 700 ms, soit la confirmation plus 150 ms.
- **Gain prédit.** Aucun sur le temps entendu.
- **Mesure.** Travail, 3 répétitions, avec arrêt à 550 ms. Puis deux passages d'interruption et de mots brefs à 600 ms. Mémoire libre : 1,1 à 1,8 Go.
- **Décision : GARDÉ.** Défaut franc corrigé.

| Critère | Base | Après |
|---|---|---|
| Arrêts à tort, mots brefs | 4 sur 6 | 0 sur 12 à 600 ms (1 sur 12 à 550 ms) |
| Voix baissée, médiane | sans objet | 78 et 111 ms (sur 2 passages), toujours sous 133 ms |
| Arrêt franc, médiane | 524 ms | 665 et 723 ms, soit la confirmation plus 65 à 123 ms |
| Temps entendu, travail, à 550 ms | 2 634 ms | 2 574 ms, gain 145 ms, intervalle de -80 à 380 ms : pas de changement prouvé, comme prévu |
| Coupures | 9 sur 9 | 9 sur 9 |

- **Compromis.** L'arrêt franc recule de 140 à 200 ms : c'est le prix pour distinguer un mot bref sans comprendre le son. La cible de 200 ms de plus que la confirmation est tenue. L'objectif G10.3 de 200 ms n'est tenu que si on accepte une voix à 10 % de volume (-20 dB) comme « se tait ». Un jugement humain doit le confirmer, et l'arrêt franc reste au-dessus de 200 ms.
- **Coût.** Environ 50 tours de banc de plus (transcription et synthèse), moins de 0,02 $ au compteur, qui ignore la synthèse (voir plus bas).
- **Ce qu'on apprend.** La moitié du défaut supposé était le banc. Non mesuré : l'écho d'un vrai haut-parleur peut faire pomper la baisse de volume, et iOS interdit de régler le volume d'un élément audio : là, seul l'arrêt franc agit (à vérifier).
- **Défaut vu en passant, non expliqué.** Des tours sans aucun son : le serveur rend 204 sur le flux audio, sans erreur journalisée (1 sur 42 en base, 1 sur 42 après ; 4 sur 12 puis 0 sur 6 sur le lot garde après, 0 sur 6 en base). La voix rapide seule, appelée 58 fois, n'a jamais rendu de réponse vide, et la synthèse seule a répondu 8 fois sur 8. J'ajoute un journal pour le prendre sur le fait.
