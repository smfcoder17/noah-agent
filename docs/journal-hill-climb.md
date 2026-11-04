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

## Tours

Aucun tour encore. Le premier : H1, fin de tour par le sens.
