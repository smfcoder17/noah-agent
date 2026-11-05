# Journal du hill climbing

Une entrée par tour, échecs compris. Méthode : [evaluation.md](evaluation.md).

## Cadre

- **Objectif :** tenir les parcours J1 à J10 au niveau de preuve exigé.
- **Gain minimal :** 150 ms sur le temps entendu en vocal ; 5 points sur la réussite des tâches.
- **Arrêt :** tous les parcours tenus et le verdict humain à l'aveugle (G15.3), ou décision de la personne.
- **Budget :** à confirmer. Le banc vocal coûte environ 0,01 $ par passage de 30 tours au compteur, qui ignore la synthèse : voir la base finale du 4 novembre.
- **Consultations du lot réservé :** 2, depuis qu'il a été réécrit par un autre modèle, hors du dépôt. La seconde le 4 novembre, en fin de tours, score seul.

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

**Interruption.** (Faux : erreur du banc, voir la base du 4 novembre.) Sur 5 essais, 3 ne coupent pas la voix. Les 2 autres la coupent en 538 ms. L'objectif est 200 ms.

**Bruit.** Écart entre deux lancers d'un même cas : 732 ms. Un gain de 150 ms n'est pas détectable dans ces conditions. Il faudra remesurer sur une machine au calme avant de décider d'un tour.

**Chat (`apollo.bench`, 5 répétitions, banc version 1).** Première réaction : 528 ms (salut), 441 ms (question), 668 ms (commande). Réponse finie : 674, 711 et 1 352 ms.

**Légèreté, au repos, un agent.** Serveur 73 Mo, lanceur 40 Mo, agent 258 Mo, navigateur 332 Mo. Images : Hermes 4,31 Go, Camoufox 4,08 Go, serveur 275 Mo, lanceur 239 Mo. Soit près de 9 Go à télécharger sur un VPS neuf, ce qui menace les 10 minutes du parcours J1.


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

### T4, voix indépendante du fournisseur (G10.8)

- **Cause.** La synthèse et la transcription sont liées à OpenRouter par le code : aucune voie ouverte n'est possible.
- **Hypothèse.** Une adresse compatible OpenAI dans Réglages > Voix suffit : `/audio/speech` et `/audio/transcriptions` en multipart, chez un serveur comme Speaches, dont j'ai lu la documentation (les deux routes, licence MIT).
- **Changement.** `media.py` : `voice_server()`, utilisé par `speak`, `speak_stream` et `transcribe`. `main.py` : `/api/voice/server`. `Settings.tsx` : un panneau. Une fonction sans modèle reste sur OpenRouter. Avec un serveur choisi, il n'y a aucun repli vers OpenRouter, pour que la voix ne sorte pas à l'insu de la personne.
- **Doit bouger.** G10.8 passe à une preuve de niveau 1, par `tests/voice/voice_test.py` avec `httpx.MockTransport`.
- **Peut reculer.** Rien sur le banc : sans adresse, le chemin reste celui d'OpenRouter.
- **Gain prédit.** Aucun en latence. Non vérifié sur un vrai serveur : aucun modèle n'est téléchargé.
- **Mesure.** `tests/voice/voice_test.py`, avec `httpx.MockTransport`. Prouvé : sans adresse, tout va à OpenRouter avec sa clé ; avec adresse, la synthèse par flux, la synthèse directe et la transcription multipart vont au serveur choisi, avec le modèle et la voix réglés ; rien ne part vers OpenRouter, même serveur en panne ; une fonction sans modèle reste sur OpenRouter ; la clé ne revient jamais à l'interface, ne suit pas une nouvelle adresse et se retire ; adresses invalides refusées ; réservé au propriétaire. `/api/flux` liste maintenant ce serveur.
- **Décision : GARDÉ.** Une capacité nouvelle, sans changement du chemin par défaut. G10.8 passe à la preuve 1 ; il en exige 2.
- **Coût.** Aucun appel au fournisseur.
- **Ce qu'on apprend.** Le test de couverture des routes (`tests/profiles`) a vu deux choses : la route d'annulation de T2 n'était pas déclarée, et un identifiant annulé perdait son propriétaire. Corrigé ici : T2 avait été gardé avec ce test rouge sur la déclaration, ma faute. **Non vérifié :** aucun vrai serveur n'a tourné, faute de modèle téléchargé. Speaches est cité d'après sa documentation (`/v1/audio/speech`, `/v1/audio/transcriptions` en multipart, licence MIT). Le streaming réel de ses formats, la latence et la qualité en français restent inconnus.

## Base finale du 4 novembre 2026 (banc navigateur version 4)

T1, T2, T2 ter et T4 en place, image reconstruite. Mémoire libre : 1 191 Mo au départ du lot travail, 1 023 Mo ensuite, 861 Mo au lot réservé, sous la limite demandée de 1 Go (le conteneur du navigateur de l'agent était reparti tout seul avec la reconstruction).

| Mesure | Base, travail | Finale, travail | Finale, garde | Réservé (score seul) |
|---|---|---|---|---|
| Temps entendu, médiane | 2 634 ms | **2 435 ms** | 2 306 ms | 2 390 ms |
| Temps entendu, p95 | 4 023 ms | **3 310 ms** | 6 534 ms | 3 510 ms |
| Envoi du tour à l'agent, médiane | 1 373 ms | 2 273 ms | 2 267 ms | 2 269 ms |
| Voix, de la demande au premier son | 1 232 ms | 1 221 ms | 2 905 ms | 1 206 ms |
| Échecs | 1 sur 42 | 0 sur 42 | 0 sur 6 | 0 sur 24 |
| Coupures, pause de 1,5 s | 8 sur 9 | **0 sur 9** | | |
| Coupures, pause de 2 s | 6 sur 6 | **0 sur 6** | | |
| Arrêts à tort, mots brefs | 4 sur 6 | **0 sur 5**, plus 1 essai sans voix | | |
| Voix baissée, médiane | sans objet | 129 ms (une fois à 308 ms) | | |
| Arrêt franc, médiane | 524 ms | 719 ms, plus 1 essai sans mesure | | |
| Réponses préparées puis jetées | 0 | 14 sur 86, une par essai de pause ou presque | 3 sur 9 | 0 sur 24 |

**Gain apparié sur le temps entendu, base contre finale, travail (41 paires) : 300 ms, intervalle de 103 à 501 ms.** Sur le lot garde (6 paires, 2 cas) : -431 ms, intervalle de -1 094 à 233 ms, sous le bruit, mais avec un p95 à 6,5 s : le « Bonjour » doublé prépare puis jette une réponse, et une reprise de modèle allonge un tour. À surveiller.

**Côté serveur.** Travail : transcription 644 ms (base 697), premier octet 841 ms (base 866), tri juste 97,6 %, erreurs de mots 1,6 %, 1 échec. Garde : 822 ms, 836 ms, tri 100 %, 9,1 %. Réservé : 596 ms, 848 ms, tri **87,5 %**, erreurs de mots 1,4 %, 0 échec.

**Lot réservé.** Consulté une seule fois, à la fin, score seul. Il n'a pas de base sur ce cerveau, puisqu'on ne le consulte pas pour ça : l'ancien score (2 145 ms, 3 253 ms, tri 95,8 %) était avec la voix rapide `openai/gpt-oss-120b` d'OpenRouter, et n'est pas comparable. Le temps réservé rejoint celui du lot travail : pas de signe de surapprentissage. **Le tri de 87,5 % est un point à regarder** : il vient probablement du passage à `gpt-oss:20b-cloud`, et non de ces tours. Je n'ai pas cherché à le corriger, pour ne pas optimiser sur ce lot.

**Ce qui reste faux.**

- **G10.1 :** 2,4 s pour une cible de 1,2 s, et 3,3 s pour une cible de 2 s au p95. Ni la 4G ni un VPS n'ont été mesurés.
- **G10.3 :** l'arrêt franc reste à 700 ms environ. Seule la voix baissée à 10 % tient 200 ms.
- **Essais sans voix.** Une interruption et un mot bref du passage final n'ont pas eu de voix à interrompre : leur essai a échoué avant le son, sans que le banc sache dire pourquoi. Au même moment, le journal montre la voix rapide d'Ollama indisponible 5 fois et vide 4 fois. Je les compte comme des défauts, pas comme des succès.
- **Tours muets.** Un tour reste muet si les trois essais de voix rapide échouent. Un silence total sans aucune phrase de repli : à corriger.
- **L'agent démarre 900 ms plus tard**, à cause de l'attente de confirmation. Non mesuré sur une vraie tâche.
- **Une pause de plus de 2,3 s coupe encore.**

**Non vérifié.** La 4G et un VPS. Un vrai micro, l'écho d'un vrai haut-parleur, qui peut faire pomper la baisse de volume ou déclencher des arrêts à tort. De vraies voix et le bruit : un vrai « mm-hm » n'est pas une voix de synthèse. Le volume sur iOS. L'attente d'une réponse retenue dans un élément audio sur téléphone. Les erreurs de mots sur des morceaux coupés à 500 ms. Un vrai serveur de voix ouvert. L'historique du banc n'a pas de réponses de l'agent.

**Coût du tour complet.** Compteur : 0,13 $, 876 transcriptions. **Le compteur ignore la synthèse** : `speak_stream` enregistre un coût nul. Il y a eu 863 appels à `microsoft/mai-voice-2.1-flash`, à 0,013 $ la minute d'après le catalogue. Pour environ 5 s par appel, c'est de l'ordre de 0,9 $, estimation et non mesure. Le chiffre de « 0,00017 $ par tour » sous-estime donc le coût réel d'un facteur 5 ou plus, et G10.7 reste à mesurer. Voix rapide : Ollama, non facturée au compteur. Lot réservé : 1 consultation, 48 tours.

## 2026-11-04 : première vérification sur de vrais agents

Deux vrais conteneurs Hermes, modèle `deepseek-v4.1-flash:cloud` par Ollama, vrai navigateur, vrai serveur MCP sur un autre réseau. Scripts dans `tests/real/`.

- **Tenu :** demande de Noah à Rita à l'écrit et à la voix, fichier relu sur la machine de Rita, rappel de lui-même, sonnerie en 2,4 s, compte rendu lu, accord à l'écran (un « oui » parlé ne suffit pas), profils, isolation, révocation en moins de 50 ms, droits `confirmer`, `lire` et `agir` vérifiés sur ce que le serveur reçoit, panne dite et affichée.
- **Défauts trouvés et corrigés :** consignes internes entre crochets affichées à l'utilisateur, comme s'il les avait écrites ; « Rappel de l'utilisateur » incompréhensible ; un outil tout juste ajouté n'arrive chez Hermes qu'après environ une minute, et l'agent répondait qu'il n'existait pas ; le texte d'aide du champ prenait trois lignes sur téléphone, avec un cadre bleu.
- **Défauts vus, non corrigés :** « ≈ 0 $ / 5 s » sur Seedance dans Réglages > Création ; les sessions du banc comptent comme des appareils dans Profils.
- **Limites :** tâches simples (calculs), navigateur sans vrai micro ni vrai haut-parleur, téléphone simulé par la taille d'écran, aucun VPS.
- **Note :** le journal disait qu'il restait à rejouer les sabotages : c'est fait depuis, 11 sur 11.

## 2026-11-04, G14.3 : navigateur au premier usage

- **Hypothèse :** le navigateur démarre avec chaque agent et pèse 300 à 500 Mo pour rien ; le démarrer au premier outil `browser_*` et l'arrêter au repos libère cette mémoire, et retire 4 Go du téléchargement initial. Risque : l'attente du premier usage.
- **Mesure, vrai agent :** deux agents au repos, 410 Mo au lieu d'environ 1,1 Go. Navigateur froid : page ouverte et titre rendu en 20 s, dont 10 s pour l'outil. Redémarrage de deux agents : 36 s au lieu de 216 s.
- **Décision :** GARDÉ. Arrêt au repos prouvé par un test simulé seulement (niveau 1) : il faut attendre 35 min en vrai. Le téléchargement au premier usage n'a pas été mesuré sur une machine neuve.

## 2026-11-04 : audits à l'aveugle, Codex et Kimi : 4/10 tous les deux

Les deux ont reçu le code et la promesse, sans notes. Chaque constat a été relu dans le code avant correction.

- **Corrigé :** droits des outils écrits en root hors du volume ; un accord ne vaut que pour cet outil et ces arguments ; jeton d'agent refusé depuis dehors ; compte rendu envoyé au bon profil, et refus quand plusieurs profils sont actifs ; tâche arrêtée si l'accès est retiré pendant son démarrage ; voix coupée à la révocation ; file de notifications vidée ; agent figé coupé après 120 s de silence, demande bornée à 6 h ; résultat livré même après un redémarrage ; plafond de 100 demandes par jour ; synthèse vocale comptée ; clé masquée dans les erreurs du serveur de voix ; machine d'agent non effacée signalée ; plafond conservé si un champ manque ; navigateur en panne qui n'empêche plus l'agent de démarrer (trouvé par nos parcours).
- **Tests durcis :** fichier lu pour de vrai, voix réellement jouée, accord suivi de l'arrivée à l'outil, confidentialité vérifiée par l'identifiant et la lecture des messages.
- **Reste ouvert :**
  - un outil OAuth s'exécute dans la machine de l'agent, avec ses jetons : la confirmation arrête le modèle, pas un agent déjà pris en main ;
  - les agents gardent un accès sortant direct, donc au réseau de métadonnées d'un VPS et au réseau Docker ;
  - un processus lancé pendant le tour d'un profil partagé peut survivre à ce tour (G12.5) ;
  - un coût Ollama ou compatible OpenAI vaut 0 $, le plafond ne les arrête pas ; une réponse vocale annulée n'est pas comptée ;
  - le résultat d'un autre agent reste un tour de conversation, marqué comme information : une injection reste possible chez un modèle qui ignore la consigne ;
  - le secret client Google passe par le terminal de l'agent ; l'adresse d'un serveur de voix n'a pas de garde réseau, mais seul le propriétaire la règle.

## 2026-11-04 : audit de contrôle Codex sur les corrections : 4/10

Il a réfuté six corrections : jeton encore valable depuis une vraie adresse sur un port publié, invité à deux conversations traité comme le propriétaire, accord qui ignorait ce qui dépasse 600 caractères, profil supprimé pendant le démarrage d'une tâche, droits perdus quand les dossiers changent, audio déjà en file après une révocation. Corrigées, avec une reprise qui écrit le message avant ses marqueurs. Parcours réels rejoués sur l'image reconstruite : 3, 13, 8 et 27 vérifications, toutes tenues. Cette dernière série de corrections n'a pas encore été auditée.

## 2026-11-04 : répétition sur un VPS simulé

Docker dans Docker, `get.sh`, Caddy en HTTPS (`tls internal`, seule différence avec le fichier publié), client qui ne parle qu'à l'adresse publique.

- **Tenu :** installation en 4 s avec les images déjà là, compte par code à usage unique, premier agent en 22 s, première réponse à 26 s, liaison d'un téléphone et d'un bureau avec accord, conversation depuis chacun, redémarrage de la machine : tout revient en 6 s et l'appareil reste relié. Au repos : 350 Mo pour Caddy, le serveur, le lanceur et un agent.
- **Défaut trouvé et corrigé :** une adresse Ollama saisie sans `/v1`, comme l'écran le propose, donnait 404 à chaque réponse. Aucun test ne le voyait : ils utilisaient l'adresse par défaut.
- **Non prouvé :** vrai VPS, vrai certificat, temps de téléchargement, vraies apps de bureau et mobile (seule leur demande réseau est reproduite), 4G.

## 2026-11-04 : deuxième audit de contrôle Codex : 4/10

Sept défauts, reproduits en mémoire par l'auditeur. Corrigés : profil en suppression sans plus aucun droit dès le départ, suppression d'agent qu'on peut reprendre, demande de plus de 6 h réellement arrêtée, échec d'un accord qui retire le bon, synthèse comptée au modèle qui a parlé (test sur l'écriture dans `usage`), droits des outils recopiés à une mise à jour d'Hermes, réveil raté du navigateur non retenu. Ni la recopie à la mise à jour ni l'arrêt à 6 h n'ont de test réel : à rejouer avec `tests/updates/docker_test.sh`.

## 2026-11-04, G10.5 : banc des tâches vocales

**Verdict.** La cible de 71 % sur 30 scénarios n'est pas tenue. Le code retenu fait 62,5 % sur les 24 scénarios du dépôt. La branche d'essai `hc/voix-resultats` fait 79,2 % sur ces 24, 33,3 % sur le lot réservé, soit 70 % sur 30. Ses changements ne passent pas la règle de garde et restent hors de `feat/mvp-skeleton`.

**Le banc.** `tests/real/taches_vocales.mjs` (vraie synthèse dans un faux micro, vrai composant, vrais agents, vrai serveur MCP qui écrit ce qu'il reçoit), `taches_verif.mjs` (ce que le code vérifie, où il place un échec, autotest), `taches_juges.mjs` (juges), `taches_vocales.json` (20 de travail, 4 garde-fous, version 3). Lot réservé : 6 scénarios écrits par `kimi-k3:cloud` dans `/data/bench-voix/taches-reserve.json`, jamais lus, 1 consultation comptée.

**Trois versions du banc, trois défauts du banc, trouvés en lisant ses échecs :**

- La synthèse ajoute parfois une suite inventée après la phrase (« Nei sosui fella medobila », partie au modèle comme un tour de plus). Chaque voix est désormais relue une fois et refaite si besoin.
- Version 2 : le banc attend que le droit de l'outil soit pris en compte, et le fait de transcrire « 30 et 1 » pour « 31 » se place enfin en transcription. Les juges voient aussi ce que l'outil a répondu : ils prenaient une fiche bien lue pour une invention.
- Version 3 : les fichiers de la série précédente sont effacés. Rita retrouvait son fichier et ne le récrivait pas : T11 a échoué à tort dans la base. **La base n'a pas été rejouée en version 3** : cet échec à tort y reste compté.

**Résultats.** Une série par état, intervalle à 95 % groupé par cas. Un échec du code ou un refus de 2 juges sur 3 fait échouer l'appel ; un appel sans verdict compte comme un échec.

| État | Tout (24) | Travail (20) | Garde-fous (4) | Causes des échecs |
|---|---|---|---|---|
| Base v1, juges avec MiniMax, à titre d'information | 62,5 % [41,7 ; 79,2] | 65 % | 50 % | |
| **Base v2, code retenu** | **62,5 % [41,7 ; 79,2]** | 60 % [40 ; 80] | 75 % [25 ; 100] | modèle 5, voix 2, transcription 1, tri 1 |
| Essai, tour 1 seul | 75 % [58,3 ; 91,7] | 75 % [55 ; 90] | 75 % [25 ; 100] | modèle 5, transcription 1 |
| **Essai final, branche** | **79,2 % [62,5 ; 95,8]** | 85 % [70 ; 100] | 50 % [0 ; 100] | modèle 4, tri 1 |
| Lot réservé, branche, score seul | 33,3 % [0 ; 66,7] : 2 sur 6, code tenu sur 3 | | | non lues |
| Branche, 24 + 6 réservés | **70 % [53,3 ; 86,7]** sur 30 | | | |

**Le lot réservé est loin du lot de travail** : 33 % contre 85 %. Il n'a pas de base. Trois explications restent ouvertes : du sur-apprentissage, un lot plus dur, ou la machine : mémoire libre tombée à **5 Mo** pendant cette série (319 à 477 Mo au plus bas sur les autres). Je n'ai pas lu les appels pour ne pas user le lot.

**Base contre branche, gain apparié : 16,7 points, intervalle de -4,2 à 37,5.** Montent : T09, T11, T12, T15, T16, T20. Descendent : T19, G4. T11 monte surtout parce que la base l'avait fait échouer à tort, et T09 et T12 varient d'une série à l'autre (T12 monte parce que l'agent a dit « 93 » parmi deux lectures, alors que la transcription reste fausse).

**Le code tient sur les 24 de la série finale** : les 5 échecs viennent tous des juges.

### Tours

Tous mesurés sur le même lot, hypothèse écrite avant le code. Une seule série complète pour le tour 1, une pour le cumul, faute de mémoire et de temps : les tours 2 et 3 n'ont eu qu'un filtre chacun.

**Tour 1 : le résultat d'un agent rapide se perdait.**
- *Hypothèse :* `action.current` n'est lu qu'après la fin de l'accusé de réception ; si l'agent finit avant, le tri vaut encore celui du tour d'avant, et le résultat n'est jamais dit. Attendre l'accusé doit faire entendre T15, T16 et T20. Gain prédit : 3 cas, soit 12,5 points. Risque : un texte intermédiaire de l'agent se met à être lu.
- *Mesure :* T15, T16 et T20 échouent sur les 2 séries de base (0 sur 6), et réussissent sur les 2 séries suivantes (6 sur 6) ; le filtre fait aussi entendre le résultat aux 3, sans juges. Gain sur la série : 12,5 points, intervalle de -4,2 à 29,2. Le risque s'est produit : T14 est tombé sur « Demande envoyée à Rita (31b80acb7c) », lu à voix haute.
- *Règle :* borne basse négative. **NON RETENU.**

**Tour 2 : un identifiant interne lu à voix haute.** Conséquence directe du tour 1. *Hypothèse :* retirer les identifiants entre parenthèses de ce qui est dit relève T11 et T14, 2 cas. *Mesure :* filtre : les identifiants ont disparu sur T10 et T14. **NON RETENU** avec le cumul.

**Tour 3 : changer le droit d'un outil ne se voyait pas.**
- *Hypothèse :* « lire » cache les outils d'écriture, et Hermes garde sa liste. L'agent dit à l'utilisateur de changer le droit, puis répond encore que l'outil est en lecture seule. Reconnecter l'outil doit faire passer T17, T18 et G3 au code. Gain prédit : 3 cas, 12,5 points.
- *Premier essai réfuté :* reposer l'outil avec un en-tête changé ne fait rien : Hermes compare les noms, pas les réglages. Le retirer pour une relecture (70 s) marche.
- *Mesure :* T17, T18 et G3 passent le code (carte d'accord, l'outil reçoit `creer_fiche` après Autoriser, rien après Refuser), et échouent encore aux juges sur la phrase suivante.
- *Risque :* l'outil disparaît 70 s, et `tests/tools/mcp_test.py` échoue à l'étape 9 sur la branche pour cette raison. Un défaut trouvé après la mesure (un deuxième changement ne retirait pas l'outil) est corrigé sur la branche, sans nouvelle mesure. **NON RETENU.**

**Tour 4, annulé :** faire dire à la voix le résultat d'une demande arrivé hors d'un tour (`Rita a fini`). Le filtre n'a rien fait entendre, en deux essais. Code retiré, cause non trouvée.

**Décision par la règle : rien n'est gardé sur `feat/mvp-skeleton`.** La borne basse du gain ne dépasse pas zéro, G4 tombe, et le réservé ne peut pas confirmer. Les 3 commits restent sur `hc/voix-resultats`. À l'humain de trancher : le tour 1 corrige un défaut lisible dans le code, avec 0 sur 6 puis 6 sur 6, et la règle demande plus de cas que ce lot n'en donne pour un défaut qui touche 3 cas.

### Ce qui reste faux, classé par gain

1. **La voix lit le nom interne de l'outil** : « Outil « outil-192-168-65-254 » : creerfiche ». C'est ce qui fait échouer T17, T18 et G3 sur la branche, et T19 en partie. 3 cas d'un coup.
2. **La voix rapide promet ce qu'elle ne sait pas** : « D'accord, j'envoie un courriel », puis l'agent dit qu'il ne peut pas (G4, T19, T20). Le tri change d'une série à l'autre sur ces cas.
3. **Le résultat d'une demande à Rita n'est jamais dit**, sauf par rappel. L'agent annonce pourtant qu'il arrivera « ici ». T10 et T11 réussissent quand même, car ces scénarios ne demandent pas de l'entendre : ce trou n'est pas dans le score.
4. **« trente et un » devient « 30 et 1 »** à la transcription, à chaque série (T12). `gpt-audio-mini` comprend « 31 ».
5. L'agent garde en conversation ce qu'il a dit d'un outil, et s'y tient même après un changement.

### Juges

Haiku 5.5 (Anthropic), `kimi-k3:cloud` (Moonshot), `glm-5.3:cloud` (Zhipu). Modèle testé : `deepseek-v4.1-flash:cloud`, voix rapide `gpt-oss:20b-cloud`. Ils ne voient ni le banc, ni le lot, ni la note attendue. Chaque verdict porte une citation vérifiée dans ce qui a été entendu.

| Juge | Constance sur 3 passes : alpha, unités constantes (série finale) | Verdicts sans citation valide | Invention glissée, vue sur 24 | Dont citation de l'invention |
|---|---|---|---|---|
| Haiku 5.5 | 0,82, 74 sur 79 | 6 sur 237 | 23 | 18 |
| Kimi K3 | 0,76, 75 sur 79 | 0 | 24 | 19 |
| GLM 5.3 | 0,49, 77 sur 79 | 0 | 24 | 16 |
| MiniMax M3, **écarté** (série de base v1) | 0,93, 78 sur 79 | **56 sur 237** | 23 | 15 |

L'accord entre juges est faible : alpha de 0,37 sur la série finale, 0,28 à 0,55 selon les séries. Les verdicts « non » étant rares, cet alpha chute vite. Les juges tiennent une invention flagrante ; ils ne s'accordent pas sur le reste. **GLM est plus indulgent que MiniMax** sur 4 unités où MiniMax refusait (T07, T17, G3 deux fois) : le remplacement a pu lever 1 ou 2 cas. Il a été décidé sur le format, sans regarder le score, mais c'est moi, l'optimiseur, qui l'ai décidé.

Un juge a parfois refusé une phrase vraie qu'il ne pouvait pas vérifier : T07 (« pas de dossier de travail configuré ») et G4 (« ton agenda ne contient rien »). Aucun verdict humain ne les a tranchés.

### Speech-to-speech : `openai/gpt-audio-mini`, essai isolé (H4)

Mêmes scénarios, mêmes voix, mêmes juges, sans rien brancher dans le produit (`tests/real/taches_audio.py`). **24 sur 24, soit 100 %, 1 série. Coût : 0,021 $, soit 0,0009 $ par appel.** Premier son : médiane 0,91 s, p95 1,36 s, 26 mesures.

**Ce n'est pas une comparaison à égalité, et le chiffre ne dit pas que ce modèle fait mieux :**

- Ses outils sont simulés et répondent à l'avance. Il n'a ni vrai agent, ni vrai fichier, ni vraie Rita, ni attente, ni carte d'accord à l'écran, et seulement 5 outils décrits exprès.
- Rien ne vérifie ce qu'il a compris : le texte de référence tient lieu de transcription.
- Son son n'est pas joué dans le vrai composant. Le temps part de l'envoi complet de la voix, sans détection de fin de tour : il n'est pas comparable aux 2,4 s de la cascade.

Ce qu'il montre quand même : le français tient, les nombres aussi, et il a appelé les bons outils avec les bons arguments. Cela justifie un essai sur de vrais agents (H4), pas une conclusion.

### Coût réel

Compteur de Noah (transcription, synthèse ; le cerveau Ollama vaut 0 $ au compteur) : 0,072 $ pour la série finale de 24 appels, soit 0,003 $ par appel, 0,052 $ pour la base. Durée de la série : 1 937 s. Juges : 0,034 $ par série en Haiku, 0,012 $ par sabotage ; Kimi et GLM passent par le compte Ollama, sans prix par jeton connu. Tout compris sur le chantier, compteur et Haiku : environ 0,5 $, dont l'essai `gpt-audio-mini` à 0,021 $. Estimation, les filtres n'étant pas tous relevés un par un.

### Non vérifié

- **Le code final mêle deux chantiers.** Une autre session a poussé `precall.py` (branché dans `voice_reply`) et modifié `Call.tsx` pendant le travail. Les images du filtre final et de la série finale les contiennent, pas la base. Une partie de l'écart, dans un sens ou l'autre, peut venir de là. Cette session a pu aussi solliciter les mêmes agents.
- La base n'a qu'une série par version : pas de bruit mesuré sur la même image, ni de répétition de la série finale. Haiku et GLM varient d'une série à l'autre.
- Niveau 2 seulement : voix de synthèse sans bruit, sans vrai micro, sans 4G ni VPS. La transcription est ici un plafond.
- Les agents gardent leur mémoire entre les séries. La conversation est neuve à chaque série, pas à chaque appel.
- Le classement des causes est une heuristique relue à la main sur le lot de travail, jamais sur le réservé.
- Les ajouts d'après-mesure sur la branche n'ont pas été rejoués.

**G10.5 reste à 0 dans la grille** : le critère dit « au moins 71 % », et un critère n'est compté que tenu, comme G10.1, mesuré mais non tenu. Le banc existe et est cité comme test.

## 2026-11-04 : premier vrai VPS

VPS Hostinger de la personne, qui héberge d'autres applications. Noah tourne dans son propre Docker, limité à 3 Go et 1,5 processeur, derrière le Traefik déjà en place, avec un vrai certificat. Le modèle est un faux modèle (`tests/real/faux_modele.py`) : aucune clé déposée sur ce serveur.

- **Tenu :** installation par `get.sh` en 14 à 29 s, 23 vérifications sur 23 depuis l'extérieur (compte par code à usage unique, liaison d'un téléphone et d'un bureau avec accord, conversation), première réponse à 148 s, image Hermes comprise. Les autres projets du serveur sont restés en marche.
- **Défauts trouvés et corrigés :** l'installateur conseillait d'arrêter le Traefik de Hostinger, ce qui aurait coupé les autres sites : il se range maintenant derrière lui. Le choix du modèle figeait l'écran pendant les 4 Go de l'image de l'agent : elle se télécharge dès l'installation. Il reste 103 s d'attente si la personne va très vite. Deux sabotages ne visaient plus rien depuis les audits : la CI l'a vu. La suite de tests dépassait les 40 min de la CI.
- **À regarder :** après un vrai redémarrage, mon script n'a pas relancé le faux modèle (défaut du script, corrigé). L'agent a alors laissé la conversation 5 min sans réponse ni message : un modèle injoignable ne le dit pas assez vite.
- **Non prouvé :** VPS neuf, vrai modèle, Caddy et son certificat (ici c'est Traefik), app réelle.

## 2026-11-04, pré-contexte d'appel

- **Hypothèse :** la voix rapide répond « je vérifie » à ce que l'agent sait déjà. Un modèle rapide qui choisit huit faits à l'ouverture de l'appel lui permet de répondre tout de suite, sans lancer l'agent. Risque : inventer davantage, ou répéter un secret ou une injection lue dans une conversation.
- **Banc :** `tests/real/precontexte.py`, vrai modèle `gpt-oss:20b-cloud`, 9 questions dont la réponse est connue et 5 dont elle ne l'est pas, 3 répétitions, mêmes données avant et après. Une clé et une injection sont glissées dans les conversations, avec 16 messages de bruit.
- **Deux premiers essais sans notes :** le raisonnement du modèle mangeait la réponse, puis le JSON revenait invalide et le modèle de secours dépassait le délai. Une simple liste à puces, sur moins de texte, règle les deux.

| Mesure | Sans | Avec |
|---|---|---|
| Réponse directe et juste | 3 sur 27 | **27 sur 27** |
| Réponse sans recherche ni aveu sur ce qu'elle ignore | 2 sur 15 | **0 sur 15** |
| Temps de réponse, médiane | 971 ms | 599 ms |
| Secret ou injection dans les notes ou à l'oral | sans objet | 0 |

- **Décision : GARDÉ.** Préparation : 1,7 s, ici. Un fait sans intérêt s'est glissé dans les notes (« 15 compilations »).
- **Limite :** le banc n'a que neuf faits pour huit places et je l'ai écrit moi-même, sans lot réservé. Avec une mémoire bien plus riche, le tri comptera davantage : le résultat reste à confirmer. La voix de vrais appels n'a pas été entendue.

## 2026-11-04, appel réel sur émulateur et modèle injoignable

- **Appel, tenu :** app sur émulateur reliée au VPS, écran verrouillé et éteint. « Appelle-moi : … » envoyé à l'agent : écran d'appel au premier plan en 2 à 3 s, écran rallumé. Limite : téléphone connecté en permanence, sans Doze ni 4G.
- **Défauts trouvés en regardant les captures, corrigés :** Répondre ouvrait une seconde sonnerie dans l'application (`&decroche` dans l'adresse). Le visage de l'agent était décentré et presque transparent, web et panneau vocal : le sélecteur des ondes attrapait aussi son `<span>`. Aucun test ne voyait ces deux défauts.
- **Modèle injoignable :** 5 min de silence observées sur le VPS. Le relais rend maintenant un 502 lisible et retient la panne ; la conversation le dit à la première panne (2 s au plus après l'échec), et une tâche qui n'a jamais joint le modèle s'arrête après 30 s d'échecs avec son motif. Après une première réponse, elle continue d'attendre : une coupure courte ne doit pas perdre un long travail. Test : `tests/coordination/injoignable_test.py`, Hermes simulé. À rejouer sur le VPS.

### Vérifié sur le VPS réel, puis défaut trouvé au redémarrage

- **Appel, sur `f59e736` :** décroché en un geste, panneau d'appel ouvert sur l'écran verrouillé. Refus et expiration (66 s) ferment l'écran et l'appel. Doze profond forcé : écran d'appel en 2 s. Limites : Doze forcé sur émulateur, pas 4G, et la voix n'a pas pu lire le compte rendu, faute de service de synthèse sur ce serveur sans clé.
- **Modèle coupé pour de vrai :** avertissement à 2,3 s, arrêt avec motif à 32,7 s, contre 5 min de silence. Modèle rétabli ensuite.
- **Défaut grave trouvé par `apres-redemarrage` :** un redémarrage pendant un tour bloquait la conversation pour toujours. Hermes refuse tout nouveau message (`unknown_execution`) tant qu'on n'a pas pris acte du tour perdu, et l'application affichait ce code brut, en ligne. Corrigé : le serveur prend acte (`hermes sessions discard`) et relance le message. Le tour perdu n'est pas rejoué, la personne le voit dans la ligne de travail seulement, qui disparaît : à améliorer.

### Droit d'un outil passé de lire à confirmer

Le correctif mis de côté (`f581e5e`) retirait l'outil 70 s, et un redémarrage du serveur pendant ces 70 s l'aurait perdu. Remplacé : le relais ouvre le flux MCP et envoie `tools/list_changed`. Avec le vrai client d'Hermes (`tests/tools/mcp_hermes_liste.py`, à la main) : outil d'écriture vu en 0,05 s, retiré en 0,10 s, sans reconnexion. Piège trouvé là : la sonde d'Hermes lit `GET` jusqu'au bout, donc le flux n'existe qu'avec `Mcp-Session-Id`. Non prouvé : un tour de modèle complet avec un vrai agent.

## 2026-11-04, l'appel devient un mode

Demande de la personne : un appel où l'on voit le logo et le travail de l'agent, où il présente ce qu'il produit, qui dure des minutes ou des heures, et qui continue pendant qu'on utilise l'application ou qu'on en sort.

- **Fait :** la conversation de l'appel reste ouverte quand on navigue, l'appel se réduit en barre ou s'agrandit en vue d'appel (visage, ce que fait l'agent, images et fichiers cliquables). On peut écrire pendant l'appel, couper le micro, voir son écran. Une carte d'accord réduit la vue, pour qu'on la voie. Écran de sonnerie Android : le vrai visage, à la couleur de l'agent. Android : service de premier plan « micro », fenêtre flottante, Raccrocher depuis la notification ou la fenêtre.
- **Tenu :** `tests/real/appel_en_cours.mjs`, vrai navigateur, ordinateur et téléphone, sur le VPS avec le faux modèle. Faux micro : ce test ne prouve pas la voix.
- **À prouver :** Android sur émulateur, micro réel écran éteint, un appel long, une vraie image produite par un vrai agent.

### Un appel qui dure des heures

Écrit en lisant le code, puis mesuré : le code d'avant échoue à 10 contrôles de `tests/real/appel_long.mjs`, le nouveau les passe tous.

- **Long silence :** le morceau de micro n'était coupé qu'après de la parole. 16 Ko/s mesurés : la limite de 20 Mo du serveur tombait au bout de 21 min, et la phrase suivante était refusée sans le dire. Avant cette limite, tout ce silence partait à la transcription avec elle. Le morceau silencieux est maintenant jeté toutes les 30 s (100 Ko au lieu de 1 065 Ko après une minute).
- **Parole sans pause :** un morceau part au bout d'une minute, même sans pause.
- **Réseau coupé :** 2 s d'attente seulement, puis ce qui venait d'être dit était perdu. Le son attend maintenant environ une minute, et l'écran le dit.
- **Coupure pendant la réponse :** le résultat revenait à l'écran sans être lu. Il est lu au retour. Si le message n'a jamais atteint le serveur, il repart, et l'ancienne réponse n'est pas relue.
- **Micro repris par une autre application :** l'appel restait sourd sans le dire. Il en rouvre un.
- **Écran :** il reste allumé dans un navigateur, où l'éteindre coupe le micro. Le micro demandé puis abandonné pendant qu'on raccroche est refermé.
- **Limites :** réseau et micro perdus sont provoqués dans un vrai navigateur, sur le VPS avec le faux modèle et une transcription remplacée. Reste à prouver : vrai passage du Wi-Fi à la 4G, écran verrouillé sur téléphone, appel réellement long. Si la première phrase d'une nouvelle conversation tombe sur une coupure, l'appel ne la renvoie pas : il attend 10 min puis se libère.

## 2026-11-04, voix directe branchée dans le produit (H4)

**Hypothèse, écrite avant le code.** Quand le modèle entend le son lui-même et tranche par un seul outil (`confier_a_l_agent`), au lieu d'un transcripteur puis d'une voix rapide qui trie en JSON, et que le vrai agent ne reçoit que ce qui lui est confié :

- *Doit monter :* la réussite des tâches, de 5 points au moins, borne basse du gain appariée au-dessus de zéro. Cas attendus : T12 (« trente et un » entendu juste), G4, T19 et T20 (la voix rapide promet ce qu'elle ne sait pas), parce que l'agent ne double plus chaque tour.
- *Premier son :* gain faible. L'attente de fin de tour ne change pas (`endOfTurnDelay`, 1 à 2,3 s) : c'est elle qui coupe la parole à tort si on la raccourcit. Le seul gain possible vient de la réponse prête plus tôt, car elle part dès 500 ms de pause sans attendre la transcription. Gain minimal : 150 ms.
- *Interruption :* rien ne doit bouger. Même élément `Audio`, même code ; le risque est le WAV de longueur inconnue au lieu du MP3.
- *Peut reculer :* le modèle répond lui-même sans confier (T07, T08, T13) ou invente un résultat, le coût par tour (0,0009 $ en essai isolé, contre 0,003 $ par appel en cascade, mais le son jeté d'une réponse préparée se paie aussi), et l'accusé de réception peut venir d'une voix différente de la synthèse qui lit le résultat.
- *Pas du vrai full duplex :* une requête-réponse par tour, le micro reste ouvert et l'interruption vit dans le navigateur. La fin de tour reste décidée chez nous, et le transcripteur reste nécessaire pour elle, pour l'écran et pour le repli.

**Base.** La base citée de 19 sur 24 (79,2 %, sur tout le lot et non sur le travail) mesurait la branche `hc/voix-resultats`, avec son tour 3 qui n'est pas sur `main`, et sans le pré-contexte ni les changements d'appel. Elle ne vaut donc plus : je la rejoue en cascade sur la même image, voie désactivée, avant de comparer.

**Décision : ANNULÉ.** La voie reste désactivée. Le code reste sur la branche `hc/voix-directe` : il est isolé, désactivé par défaut (`media_direct` vide), et les deux bases ont tourné dessus avec la voie coupée. Lot réservé non consulté, car le lot de travail ne monte pas : **0 consultation de plus, le total reste à 2.**

**Ce qui est branché.** `POST /api/voice/direct` : le navigateur envoie le son du tour en WAV dès 500 ms de pause, et le modèle répond en pcm16 dans le même `AudioStream`. Il garde le pré-contexte, le fil, le budget et le compteur. Son seul outil, `confier_a_l_agent`, rend au navigateur une demande envoyée par `say` vers `/api/chat`, donc avec accords, Rita et rappels. Le résultat et l'interruption passent par le code existant. Réglage : `POST /api/media {kind: "direct", model}`, sans écran pour l'instant. Refusé si un serveur de voix est choisi, pour que le son ne parte pas à l'insu de la personne. Si une panne survient avant le premier son, le navigateur repasse en cascade pour le reste de l'appel : test simulé (`tests/voice/direct_test.py`) et filtre réel avec un modèle inexistant (400, puis réponse de la cascade dans le même appel).

**Résultats.** 24 scénarios en version 3, mêmes juges, gain apparié par cas contre la moyenne des deux bases, intervalle à 95 % groupé par cas. Une série par état de voix directe.

| État | Tout (24) | Travail (20) | Garde (4) | Gain sur tout, intervalle | Gain travail, intervalle | OpenRouter, série |
|---|---|---|---|---|---|---|
| **Cascade, base 1** | 17 (70,8 %) | 15 | 2 | | | 0,074 $ |
| **Cascade, base 2** | 20 (83,3 %) | 18 | 2 | | | 0,072 $ |
| `gpt-audio-mini`, demande reformulée | 16 (66,7 %) | 13 | 3 | -10,4 [-29,2 ; +8,3] | -17,5 [-37,5 ; +2,5] | non isolé, environ 0,06 $ |
| `gpt-audio-mini`, mots répétés | 13 (54,2 %) | 11 | 2 | **-22,9 [-41,7 ; -4,2]** | -27,5 [-50 ; -5] | 0,057 $ |
| `openai/gpt-audio`, mots répétés | 17 (70,8 %) | 15 | 2 | **-6,2 [-20,8 ; +6,2]** | -7,5 [-25 ; +7,5] | 0,215 $ |

**Règle : borne basse au-dessus de zéro et gain de 5 points. Aucun état ne l'atteint.** Le meilleur, `gpt-audio`, égale la moins bonne base et n'atteint pas la meilleure. Les deux bases, sur le même code, diffèrent de 3 cas sur 24 : le bruit d'une série à l'autre est de l'ordre de ce qu'on cherche à mesurer.

La base citée de 19 sur 24 n'est plus la bonne : elle mesurait `hc/voix-resultats` avec son tour 3. Le code de `main` fait 17 et 20 sur 24, soit 77,1 % en moyenne. **Sur ces deux séries, la cible de 71 % est atteinte sur le lot du dépôt, mais pas sur 30 scénarios : le lot réservé n'a pas de nouvelle mesure, et G10.5 ne change pas.**

**Pourquoi `gpt-audio-mini` recule, lu dans les échecs.**

- Il promet sans appeler l'outil : « je demande à Rita » en T10, T12 et T14, « je crée le fichier » en T09. Rien ne part à l'agent, et la phrase est fausse. La deuxième question de T09 reçoit alors une réponse tirée de ce fil, sans note écrite.
- Il résume ce qu'il transmet : avec la première consigne, T10 perd « Rita » et T13 et T14 perdent le rappel. Lui demander de répéter les mots règle ces trois cas au filtre, puis la série complète montre que ce n'est pas stable (T13 devient « écris le résultat dans un fichier », T15 « Lier la fiche »).

**`gpt-audio` tranche beaucoup mieux, sans gagner.**

- Tout ce qui demande d'agir part à l'agent, avec les bons mots, sauf G4. « 31 » est juste en T12 sur la série, mais le filtre de T12 avait rendu « 30 et 1 » : 1 sur 2. T01 à T06, G1 et G2 sont réglés sans l'agent. T20 passe, alors qu'en cascade l'accusé promet parfois d'allumer.
- Ses échecs : T12 (le résultat de Rita n'est pas dit : trou déjà connu), T14 et T19 (le texte final de l'agent, lu ou résumé), T17, T18 et G3 (le droit de l'outil n'est pas pris en compte, le tour 3 n'étant pas sur `main`), G4 (« j'envoie un courriel à Marie », promesse fausse). Seul G4 lui revient en propre : T17, T18 et G3 échouent dans tous les états, et T12, T14 et T19 tiennent au résultat de l'agent.
- Il appelle presque toujours l'outil sans un mot : la personne entend l'accusé fixe « D'accord, je m'en occupe », dans la voix de la synthèse. Sur une demande impossible (T20), cette phrase promet avant de se dédire.

**Premier son réel,** de la fin de la parole à « playing », dans le vrai composant, 14 tours, 1 répétition, agents arrêtés.

| Mesure | Cascade | `gpt-audio-mini` |
|---|---|---|
| Médiane | 2 781 ms | **2 303 ms** |
| p95 | 4 354 ms | 2 704 ms |
| Gain apparié | | **702 ms [190 ; 1 244]** |
| De l'envoi au premier son, médiane | 1 595 ms | 1 734 ms |

Le gain dépasse les 150 ms exigés, avec moins de queue. Il ne vient pas d'un modèle plus rapide : le modèle met plutôt plus de temps à répondre, mais la requête part dès la pause, sans attendre la transcription. **La médiane de 2 303 ms est le délai de fin de tour lui-même (2,3 s) : descendre plus bas demande une autre fin de tour, pas un autre modèle.** `gpt-audio` : 2 tours seulement (3 689 et 2 303 ms, contre 2 976 et 4 477), trop peu pour conclure ; je n'ai pas payé plus.

**Interruption, `gpt-audio-mini`, sur la cascade :** arrêt franc 699 ms contre 693 ms, voix baissée 100 ms contre 90 ms, 0 raté sur 5 des deux côtés. Arrêts à tort sur un mot bref : 0 sur 6 des deux côtés. Coupures, pause de 1,5 s : 0 sur 9 des deux côtés, 0 sur 6 à 2 s. Le WAV de longueur inconnue ne change rien. Le critère de coupure compte ici le son entendu et les tours envoyés, or un tour gardé par le modèle n'est pas envoyé : il est un peu moins sévère en voix directe. **Non mesuré sur `gpt-audio`.**

**Coût réel, solde OpenRouter avant et après.** Par appel : cascade 0,003 $, `gpt-audio-mini` 0,0024 $, `gpt-audio` 0,009 $, transcription de la fin de tour et synthèse des résultats comprises. Le compteur de Noah suit le solde (0,215 $ contre 0,215 $ sur `gpt-audio`). Une réponse coupée en route n'a pas de coût connu : le compteur la sous-estime. Cerveau et voix rapide Ollama : compte sans prix par jeton. Total du tour sur OpenRouter : **0,72 $** sur 1 $, dont une garde qui coupait la voie à 0,89 $ et qui n'a pas servi. Haiku pour les juges : environ 0,16 $ à part, sur le compte Anthropic.

**Juges.** Haiku 5.5, Kimi K3, GLM 5.3, 3 passes. Accord entre juges : alpha de 0,24 et 0,31 sur les bases, de 0,43 à 0,59 sur la voix directe. Constance : Haiku 0,81 à 0,92, Kimi 0,51 à 0,87, GLM 0,32 à 0,65. Verdicts sans citation valide : au plus 10 sur 237. Inventions glissées dans la série `gpt-audio` : vues 24 sur 24 par les trois, citées 19, 23 et 17 fois. Les juges ne voient que le son transcrit : ils ne jugent ni la qualité de la voix, ni le changement de voix entre accusé et résultat.

**Ce n'est pas du vrai full duplex.** C'est une requête-réponse par tour sur chat/completions. Le micro reste ouvert et l'interruption vit dans le navigateur, comme en cascade. Le modèle n'entend rien avant que le navigateur ne décide d'une pause, il n'entend pas la personne pendant qu'il parle, et le transcripteur reste nécessaire pour la fin de tour et le repli. OpenRouter ne liste que ces deux modèles audio, tous deux sur ce mode, sans session continue. **À essayer ensuite : OpenAI Realtime,** car son modèle vient de la même famille que `gpt-audio`, le meilleur ici, et il gère lui-même la fin de tour et l'interruption. Il demande une clé OpenAI directe (pas celle d'OpenRouter), un jeton éphémère délivré par le serveur et un transport WebRTC ou WebSocket (H3). Gemini Live (clé Google) et Grok Voice (clé xAI) restent des options. Ce sera un plus gros changement que celui-ci, et je n'ai vérifié aucun de ces services dans ce tour.

**Ce que le tour apprend pour la cascade.** Partir dès la pause sans attendre la transcription donne l'essentiel du gain de premier son. `gpt-audio` entend parfois mieux les nombres que le transcripteur. Ces deux pistes sont distinctes de la voix directe et n'ont pas été essayées seules.

**Non vérifié.**

- Une seule série par état de voix directe ; trois états essayés sur le même lot de travail, sans correction pour comparaisons multiples. Les bases sont avant et après, pas intercalées avec chaque état (ordre : base 1, mini 1, mini 2, base 2, `gpt-audio`). Les agents gardent leur mémoire entre séries.
- Mémoire libre au plus bas : 410 à 1 017 Mo selon la série. Les conteneurs `brolls-browser-local-*`, lancés par une autre session, ont démarré pendant les séries.
- Voix de synthèse, sans bruit, sans vrai micro, sans 4G ni VPS. Personne n'a écouté le son : ni sa qualité, ni le passage d'une voix à l'autre.
- Dans la voie directe, **un tour que le modèle garde pour lui n'est pas écrit dans la conversation.** Il ne vit que dans le fil de l'appel, et l'agent ne l'apprend pas. À corriger avant toute activation. Le réglage n'a pas d'écran.
- Le repli du navigateur est prouvé par un filtre réel et une lecture du code en CI, pas par un test de navigateur en CI. L'application mobile n'a pas été touchée.

## 2026-11-04, l'appel en mode Android, vu sur émulateur

APK de la CI, relié au VPS, faux modèle, sans son.

- **Tenu :**
  - écran éteint : sonnerie en 4 à 10 s, vrai visage de l'agent, décroché en un geste ;
  - écran allumé : bandeau avec Répondre et Refuser, les deux essayés ;
  - refus écrit dans la conversation (« Appel refusé »), décroché écrit (« Appel pris ») ;
  - sortie de l'application : fenêtre flottante avec visage et durée, retour dans l'application sur le même appel ;
  - Raccrocher, depuis la notification comme depuis l'appel : service d'appel arrêté, micro relâché, fenêtre fermée.
- **Page vivante, mesurée :** `tests/real/appel_android_vivant.mjs`, 20 relevés de micro par seconde en fenêtre flottante et pendant 30 s d'écran éteint.
- **Défauts trouvés en regardant les captures, corrigés :**
  - corps du visage presque transparent à la sonnerie (l'opacité d'une ombre restait sur le dégradé) ;
  - clavier ouvert par-dessus l'appel (focus automatique sur téléphone) ;
  - Raccrocher caché sous un chevron dans « Silencieux » : c'est maintenant une notification d'appel ;
  - bandeau sans boutons quand l'écran est allumé ;
  - bouton Répondre coupé par son animation.
- **Non prouvé :** vrai son (`-no-audio`), vrai téléphone, Doze sur plusieurs heures, 4G. La fenêtre flottante a son bouton Raccrocher, pas essayé : c'est le bouton de la notification qui l'a été.
- **Vu pendant l'essai :** un premier redémarrage du conteneur d'essai sur le VPS est resté 6 min sans rien démarrer, le second a marché en 55 s. Cause non cherchée : c'est le conteneur d'essai, pas une installation réelle.

### L'appel avec un vrai agent

`tests/real/appel_vrai.mjs` : pile locale, vrai modèle, vraie synthèse dans un faux micro, un seul essai. Demande à la voix : créer une image et la montrer.

- **Tenu :** le travail de l'agent se voit dans l'appel à 19,5 s. Une question posée pendant le travail a sa réponse parlée en 7 s (« Rome »), puis part à l'agent. L'image de 2 048 px arrive dans l'appel à 49 s et s'ouvre d'un clic.
- **Défaut trouvé parce que l'agent était arrêté :** l'appel restait sur « Je t'écoute » alors que la demande avait échoué. L'appel dit maintenant que l'agent n'a pas pu répondre. Testé par `appel_long.mjs`, avec un refus simulé.
- **Limites :** personne n'a écouté le son, faux micro. Le nom de l'image est affiché tel quel, long et peu lisible.
