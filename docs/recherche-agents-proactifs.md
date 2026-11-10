# Agents proactifs : ce que les gens attendent, et ce que Noah doit avoir

Recherche du 9 novembre 2026, faite pendant le chantier 0.1.6. Trois enquêtes en lecture seule :

- Hey Noah : fiche Product Hunt (98 commentaires, 4 avis), FAQ, changelog et MakerStack ;
- Grok Bot et Muse ;
- OpenClaw, Poke, Dots et les appels sortants open source.

Les sources sont citées dans chaque enquête. Ce document en garde les conclusions, rapportées à Noah.

## Ce qui ressort partout

1. **Tout faire, mais ne rien envoyer seul.** La phrase qui résume Product Hunt : « total delegation of the work and zero delegation of the send ». Les gens veulent que l'agent prépare tout et qu'ils n'aient plus qu'à approuver. Mettre la personne en copie de chaque envoi revient à en faire la relectrice, et c'est critiqué.
2. **Décider selon que l'action se défait, pas selon la confiance du modèle.** Ce qui se défait passe, ce qui ne se défait pas demande. C'est le principe de la table d'autonomie de Noah 0.1.6.
3. **Un journal lisible de ce que l'agent a fait.** C'est le premier reproche fait à Hey Noah (MakerStack). Dots en fait un écran, « Activity ».
4. **Le bruit tue la proactivité.** Hey Noah coupe chaque alerte par défaut, regroupe le non-urgent et arrête une relance que la personne ignore. OpenClaw répond `NO_REPLY` quand il n'y a rien à dire et respecte des heures actives. Ses utilisateurs se plaignent du coût en jetons de ces réveils.
5. **Ne jamais deviner.** Dès qu'un cas est ambigu (« plutôt fin du mois », un « jeudi 4 » qui n'existe pas), l'agent écrit en privé avec une réponse suggérée.
6. **Les priorités rédigées à la main se périment.** Les listes « manual lists rot » : l'agent doit redemander de temps en temps si une priorité tient encore. Une priorité déduite de la fréquence des échanges classe mal les gens, Hey Noah l'a abandonnée.
7. **La confiance se gagne.** Accords à plusieurs portées (une fois, cette tâche, ce site, toujours), un mode « montre-moi le plan », et une autonomie qui s'élargit avec l'usage. Les gros utilisateurs veulent vite tout déléguer.
8. **Les besoins les plus cités :**
   - le tri du courrier, avec des brouillons ;
   - l'agenda et ses conflits ;
   - le briefing du matin ;
   - la relance des gens qui ne répondent pas ;
   - les engagements pris en réunion ;
   - les comparaisons de prix ;
   - les réservations par téléphone.
9. **Une veille qui ne marche plus doit le dire.** Une veille cassée qui se tait est pire qu'aucune veille.
10. **L'oubli doit être vérifiable.** Quand on demande à l'agent d'oublier, on doit pouvoir constater que c'est oublié.

## Noah face à ces attentes

| Attente | Noah aujourd'hui | En cours (0.1.6) | À ajouter |
|---|---|---|---|
| Tout préparer, ne rien envoyer seul | Juge et accords « À toi » | Table d'autonomie : ce qui ne se défait pas demande toujours, sauf en Auto ; accord à usage unique sur l'action exacte (#34) | Ce que lance une routine part en brouillon par défaut |
| Accords à plusieurs portées | Une fois, et « toujours » pour certains sites | Accord unique exact (#34) | « Pour cette tâche », « pour ce site », « toujours », révocables dans Réglages |
| Journal lisible | Comptes rendus dans la conversation, « Tout voir » dans la vue de l'agent | — | Un écran Activité : chaque action, son niveau, qui l'a accordée, et un bouton pour la défaire quand c'est possible |
| Peu de bruit | Rien de neuf : aucun appel de modèle ; notification seulement s'il y a quelque chose ; une proposition par jour au plus | Réglages de notifications complets, fin du « Noah peut t'appeler » (#38) | Heures actives, regroupement du non-urgent, arrêt d'une relance ignorée, budget de notifications par jour |
| Ne jamais deviner | Le juge demande sur les lignes à risque | C2 : comparaison aux mots de la personne (#34) | Règle dans le prompt : en cas d'ambiguïté, écrire avec une réponse suggérée, ne rien choisir |
| Priorités à jour | Objectifs de la personne (proactif.py) | — | Relecture des objectifs chaque mois : « ça tient toujours ? » |
| Veille qui dit sa panne | Veilles sans modèle (watch.py) | Banc de l'autonomie (#40) | Une veille qui échoue deux fois de suite prévient |
| Briefing du matin | Possible par une routine | — | Un briefing intégré, réglable en un geste, comme chez Poke |
| Relancer les silencieux | — | — | Relance d'un courriel resté sans réponse, en brouillon soumis à accord |
| Engagements de réunion | — | — | Plus tard : demande les notes de réunion |
| Mémoire et oubli | Apprentissage automatique, mémoire visible | Compétences apprises visibles (#41) | Un « oublie ça » qui montre ce qui a été retiré |
| Canaux | L'app Noah (bureau, Android, web), appel simulé vers la personne | Appel qui se comporte comme un vrai appel (#38) | Plus tard : Telegram, WhatsApp ou SMS comme canal de secours |
| Appeler un tiers (restaurant, médecin) | — | — | Voir la section suivante |

Hey Noah en face :

- il envoie et relance seul, par SMS, WhatsApp, Slack et e-mail, et il appelle des tiers ;
- il coûte 49 $ par mois, ses données sont chez lui, il n'existe pas en Europe et n'a pas d'app iOS.

Noah tourne chez la personne, avec ses propres modèles, et a un ordinateur à lui. L'écart à combler, c'est la sortie vers les autres : relancer par courriel, appeler des tiers, d'autres canaux.

Hey Noah, Noah AI et TheNoah.ai occupent le même nom : à trancher avant les stores.

## Appeler un tiers en open source

Architecture conseillée, sans service hébergé par nous :

- **Voix :** LiveKit Agents, open source, sur le VPS de la personne. Il réutilise la voie vocale de Noah (transcription, modèle, synthèse).
- **Téléphonie :** un numéro SIP Telnyx ou Twilio, pris et payé par la personne, qui colle ses identifiants dans Réglages. Compter environ 0,05 à 0,15 $ la minute en tout.
- **Avant l'appel :** une carte d'appel (qui, pourquoi, ce que l'agent peut accepter, ses limites) que le juge fait toujours approuver. Un appel ne se défait pas.
- **Pendant :**
  - l'agent dit dès la première phrase qu'il est une IA qui appelle pour la personne ;
  - aucun clone de voix ;
  - 5 minutes au plus ;
  - seulement des numéros d'entreprise, ou une liste blanche ;
  - un plafond d'appels par jour, et un bouton qui coupe tout.
- **Après :** transcription écrite plutôt que l'enregistrement audio, compte rendu dans la conversation, confirmation par message.
- **Droit :** TCPA aux États-Unis, CRTC au Canada, article 50 de l'AI Act en Europe (dire qu'on est une IA), et lois sur l'enregistrement des appels. La transcription sans audio et l'annonce d'entrée couvrent l'essentiel. Une relecture juridique reste à faire avant de l'ouvrir à tous.
- **Limite connue :** ça ne marche que si l'interlocuteur accepte de parler à une IA. Si on raccroche, Noah doit le dire et proposer d'appeler lui-même.

## Feuille de route proposée

**0.1.7, la confiance (court) :**

- écran Activité ;
- accords à plusieurs portées ;
- brouillon par défaut pour ce qui naît d'une routine ;
- heures actives et budget de notifications ;
- une veille en panne prévient ;
- règle « ne jamais deviner ».

**0.1.8, l'utilité quotidienne :**

- briefing du matin intégré ;
- relance des silencieux en brouillon ;
- relecture mensuelle des objectifs ;
- « oublie ça » vérifiable.

**0.2, la sortie vers les autres :**

- appels à des tiers (LiveKit et le numéro SIP de la personne), derrière un drapeau, après relecture juridique ;
- un canal de secours, Telegram d'abord, car il est gratuit et ne demande aucun numéro payant.

**Plus tard :** engagements de réunion, priorité des contacts déclarée à la main, iOS natif.
