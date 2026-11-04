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

Cerveau : `deepseek-v4.1-flash:cloud`. Voix rapide : `gpt-oss:20b-cloud`, choisie automatiquement chez Ollama. Transcription et synthèse : OpenRouter. Agent et navigateur arrêtés, même machine pour tous les tours. Mémoire libre : 956 Mo au départ du lot travail, donc un peu sous la limite demandée de 1 Go, puis 1,7 à 1,8 Go. Je le note plutôt que de le rejouer.

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

### T2, fin de tour

- **Cause.** Le tour part dès 1,3 ou 1,4 s de silence, car attendre plus allongerait d'autant le temps entendu : la réponse ne commence à se préparer qu'à l'envoi. Une pause de 1,5 s coupe donc toujours.
- **Hypothèse.** Séparer préparer et parler. La réponse se prépare en silence dès 500 ms de pause, le son retenu. Le tour n'est confirmé qu'à 2 s de silence après un point ou une fin ordinaire (1 s après un point d'interrogation, 2,5 s après un mot de liaison). Préparation : 500 ms de pause, 700 ms de transcription et 1 200 ms de voix, soit environ 2,4 s, plus long que l'attente de confirmation : celle-ci n'allonge donc pas le temps entendu. Si la personne reprend, on annule : requête coupée côté serveur, aucun message.
- **Changement.** `Voice.tsx` : réponse préparée et confirmée, pause de morceau à 500 ms en mode vocal, délais de fin de tour. `media.py` et `main.py` : `POST /api/voice/cancel/<id>`, qui coupe la voix rapide et la synthèse.
- **Doit bouger.** Coupures : de 9 sur 9 à moins de 1 sur 9. Temps entendu : gain de 200 ms environ.
- **Peut reculer.** L'envoi du tour à l'agent : de 1,4 s à 2 s environ, donc le vrai travail démarre 600 ms plus tard. Davantage de morceaux à transcrire, donc les erreurs de mots. Coût : chaque réponse jetée paie sa synthèse et sa voix rapide.
- **Gain prédit.** 200 ms sur le temps entendu, coupures à zéro.
- **Premier filtre, attente à 2 s.** 6 coupures sur 9, gain 354 ms (79 à 614), mémoire libre 370 Mo au départ : à ne pas retenir. Cause des coupures : le banc annonce 1,5 s, mais le silence réel dure environ 1,9 à 2 s, avec la queue du fichier, le décodage et le silence de tête de la moitié suivante. Je ne touche pas au banc, qui reste plus sévère que son titre : l'attente passe à 2,3 s.
- **Banc corrigé en cours de tour (commit à part, version 4).** Le banc attendait 1,5 s après la fin du fichier, silence de queue compris : la pause réelle montait au-delà de 2,4 s sur « Demande à l'autre agent ». Elle est maintenant de 1 503 ms en médiane, de la dernière syllabe à la première. Une pause de 2 s montre la marge. Base rejouée sur cette partie, code d'avant T2 : **8 sur 9 à 1,5 s, 6 sur 6 à 2 s.**
- **Mesure.** Banc version 4, 3 répétitions, travail et garde. Attente de confirmation à 2,3 s. Mémoire libre : 1 064 Mo au départ, 945 Mo à la fin.
- **Décision : GARDÉ.** Défaut franc corrigé, le temps entendu ne recule pas.

| Critère | Base | Après |
|---|---|---|
| Coupures, pause de 1,5 s | 8 sur 9 | 0 sur 9 |
| Coupures, pause de 2 s | 6 sur 6 | 0 sur 6 |
| Temps entendu, travail, médiane | 2 634 ms | 2 588 ms, gain 59 ms, intervalle de -131 à 263 ms : gain prédit de 200 ms non tenu |
| Temps entendu, travail, p95 | 4 023 ms | 3 901 ms |
| Temps entendu, garde, médiane | 2 368 ms | 2 301 ms, gain 470 ms sur 4 paires, seulement 2 cas |
| Envoi du tour à l'agent, médiane | 1 373 ms | 2 268 ms : recul attendu, le vrai travail démarre 900 ms plus tard |
| Interruption | 524 ms, 4 sur 6 à tort | 687 ms, 0 sur 6 à tort, voix baissée en 106 ms |
| Échecs | 1 sur 42, 0 sur 6 | 1 sur 42, 2 sur 6 |

- **Coût des spéculations.** 15 réponses jetées sur 88 au lot travail, exactement une par essai de pause, aucune sur les tours sans pause. 3 sur 9 au lot garde, à cause du doublon « Bonjour ». Une réponse jetée paie sa voix rapide et sa première phrase de synthèse. `tests/voice/voice_test.py` prouve l'annulation avec simulation : requête au modèle fermée, aucun message écrit, un autre compte refusé, et une demande arrivée après l'annulation ne lance rien.
- **Ce qu'on apprend.** Le temps entendu ne bouge presque pas, car l'attente de confirmation de 2,3 s devient la borne quand la voix est prête tôt : sur le lot garde, le son part à 2 301 ms, juste après la confirmation. Le gain possible est là. Les erreurs de mots sur des morceaux coupés à 500 ms ne sont pas mesurées : le banc du serveur transcrit des phrases entières. La cause des tours muets se précise : le journal dit 0 phrase reçue (3 fois), la synthèse n'y est donc pour rien, c'est la voix rapide qui ne dit rien.

### T2 bis, attente de confirmation

- **Cause.** Avec la réponse préparée à l'avance, l'attente de 2,3 s borne le temps entendu dès que la voix est prête avant.
- **Hypothèse.** Revenir à 1,8 s garde 300 ms de marge sur le critère de 1,5 s et laisse le son partir plus tôt.
- **Changement.** `endOfTurnDelay` : 1,8 s au lieu de 2,3 s après un point ou une fin ordinaire.
- **Doit bouger.** Temps entendu : gain d'au moins 150 ms, surtout sur les cas rapides.
- **Peut reculer.** Coupures à 2 s : elles reviendront, c'est le prix. Coupures à 1,5 s : doivent rester à 0 sur 9.
- **Gain prédit.** 200 à 300 ms.
- **Mesure.** Filtre à 2 répétitions contre T2, 26 paires, mémoire libre 1 192 Mo au départ.
- **Décision : ANNULÉ.** Gain 151 ms, mais intervalle de -154 à 514 ms : la borne basse est sous zéro. Médiane 2 584 ms contre 2 588 ms. Coupures à 1,5 s : 0 sur 9. Coupures à 2 s : 6 sur 6 contre 0 sur 6, donc on perd la marge pour rien de prouvé. L'envoi à l'agent passe de 2 268 à 1 781 ms, ce qui reste un vrai avantage à revoir si la voix devient plus rapide.
- **Coût.** 28 tours et 15 essais de pause.
- **Ce qu'on apprend.** La médiane dépend surtout de la voix (1 300 à 1 400 ms entre la demande et le premier son) : l'attente de confirmation n'est bornante que sur les cas rapides. Tant que la voix ne descend pas, raccourcir cette attente rapporte peu.

### T2 ter, tours muets

- **Cause.** Le journal du serveur dit « 0 phrase reçue » : la voix rapide termine sans rien dire et la boucle s'arrête quand même sur ce modèle. Sur le banc, l'historique contient des réponses vides de l'agent intercepté, ce qui peut favoriser le défaut : en usage réel, il serait plus rare.
- **Hypothèse.** Traiter une réponse vide comme un modèle indisponible : le suivant répond à sa place.
- **Changement.** `media.voice_reply` : une réponse sans rien à dire passe au modèle suivant, et le journal en garde le début.
- **Doit bouger.** Échecs : de 2 à 5 % des tours (2 sur 6 sur le lot garde selon les passages) vers 0.
- **Peut reculer.** Le temps entendu de ces seuls tours, qui comptaient jusqu'ici comme des échecs.
- **Gain prédit.** Aucun sur la médiane.
- **Premier filtre.** Travail : 0 échec sur 28. Garde : 1 sur 4. Le journal montre 6 réponses vides de `gpt-oss:20b-cloud`, et une fois de suite sur les trois modèles. Le même modèle appelé sans historique n'en avait donné aucune sur 58 : l'historique en contenait des messages vides de l'agent. J'ajoute au même tour : les messages vides de l'historique ne partent plus au modèle.
- **Second filtre, messages vides retirés : recul.** Temps entendu 3 224 ms, perte de 513 ms, intervalle de -955 à -85 ms, voix 2 075 ms. Échantillon direct sur `gpt-oss:20b-cloud`, 8 appels par forme d'historique : premier mot à 0,30 s sans historique, 0,47 s avec des réponses vides, **1,24 s avec les seules questions**, 0,29 s avec de vraies réponses. Le banc n'a que des réponses vides, puisqu'il intercepte l'agent : les retirer le pénalise. Une réponse vide survient aussi sans historique (1 sur 8), donc l'historique n'en était pas la cause. Ce retrait est annulé.
- **Décision : GARDÉ, passage au modèle suivant seul.** Filtre à 2 répétitions contre T2 : gain 160 ms, intervalle de -343 à 665 ms, sans recul prouvé. Échecs : 0 sur 28 au lot travail contre 1 sur 42, 1 sur 4 au lot garde contre 2 sur 6. Réponses vides rattrapées d'après le journal : 3 tours sur 32 environ, et 7 sur 34 au filtre suivant. Il reste un tour muet quand les trois essais rendent du vide (1 sur 66).
- **Coût.** 60 tours environ pour ce tour. La reprise ajoute le temps d'un appel au tour concerné.
- **Ce qu'on apprend.** `gpt-oss:20b-cloud` rend parfois une réponse vide, sans raison visible (`finish_reason: stop`), quelle que soit la forme de l'historique. **Limite du banc :** son historique, sans réponses de l'agent, ne ressemble pas à une vraie conversation. La latence réelle de la voix rapide pourrait y être un peu meilleure. Je ne change pas le banc pour ça.

### T3, transcription plus tôt

- **Cause.** Le son n'est prêt qu'après 500 ms de pause, 700 ms de transcription et 1 300 ms de voix. Seule la pause de départ est sous notre main sans dépendance nouvelle, car la transcription coûte surtout son temps d'aller-retour : une fenêtre glissante sur une longue phrase ne le réduirait pas, et transcrire deux fois doublerait les appels à OpenRouter.
- **Hypothèse.** Couper et préparer à 300 ms de pause au lieu de 500 ms avance le son d'environ 200 ms sur les tours non bornés par la confirmation.
- **Changement.** `TURN_PAUSE` à 300 ms.
- **Doit bouger.** Temps entendu : gain d'au moins 150 ms.
- **Peut reculer.** Plus de morceaux par tour, donc plus d'appels et plus de mots coupés. Plus de réponses préparées et jetées dans une vraie parole, qui fait souvent des pauses de 300 ms.
- **Gain prédit.** 100 à 200 ms, plafonné par l'attente de 2,3 s.
- **Mesure.** Filtre à 2 répétitions contre le même code à 500 ms, 28 paires, 1 180 Mo libres. 29 transcriptions pour 28 tours, aucune réponse jetée : la voix de synthèse ne fait pas les pauses d'une vraie parole.
- **Décision : ANNULÉ.** Gain 163 ms, intervalle de -218 à 538 ms : la borne basse est sous zéro. Médiane 2 333 ms contre 2 497 ms, p95 3 764 ms contre 3 847 ms. Le sens est bon mais rien n'est prouvé, et le risque (couper à chaque virgule d'une vraie voix, plus d'appels, plus de mots coupés) n'est pas mesurable sur ce banc.
- **Coût.** 28 tours.
- **Ce qu'on apprend.** C'est le deuxième tour plat sur le temps entendu (T2 bis, T3) : je m'arrête sur ce réglage. Reste à gagner sur la voix (1 300 ms). La fenêtre glissante n'a pas été essayée : elle double les appels à OpenRouter pour au plus 200 ms, plafonnés par la même attente, et avec un temps de transcription de 700 ms dominé par l'aller-retour. Pour aller plus bas, il faut une transcription en flux (H2), ce qui est un changement d'architecture.
