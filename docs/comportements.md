# Comportements de référence (G15.1)

Relevé du 4 novembre 2026. Vingt comportements observables sur Grok Bot, Dots, Duet et Muse, avec OpenClaw et Hermes pour l'open source. Méthode générale : [evaluation.md](evaluation.md), section « Goût et expérience ».

Cette grille décrit ce que font les références. Elle ne juge pas leur qualité et ne classe personne : la comparaison à l'aveugle (G15.2) et le verdict humain (G15.3) restent à faire.

## Niveaux de preuve

| Marque | Sens | Limite |
|---|---|---|
| **[V]** vue de mes yeux | Image de la vidéo capturée à ce minutage dans le navigateur intégré | Une image fixe, pas la séquence. Je n'ai entendu aucun son |
| **[D]** documentation officielle | Page de l'éditeur ou du projet | Dit ce qui est prévu, pas ce qui marche. Plusieurs pages ont été lues par un extrait résumé, pas mot à mot (voir [Limites](#limites)) |
| **[S]** source secondaire | Ce que dit une vidéo tierce, lu dans ses sous-titres, sans image capturée à ce minutage | Récit ou dialogue transcrit, parfois sous-titres automatiques avec des erreurs |

Tout ce qui se rapporte au **son** (ton, latence, qualité d'une interruption) n'est pas prouvé ici, même marqué [V] : je n'ai lu que les sous-titres.

## Ce que j'ai vraiment regardé

Aucune vidéo n'a été regardée en continu ni écoutée. Pour les dix, j'ai ouvert la page, lu toute la transcription affichée par YouTube, puis capturé des images en me plaçant à des minutages choisis. Aucune connexion à un compte, aucun téléchargement.

| Vidéo | Auteur et date | Durée | Transcription lue | Images capturées | Utilité des images |
|---|---|---|---|---|---|
| [DdSRXsKkHOg](https://www.youtube.com/watch?v=DdSRXsKkHOg) Dots | Mark Kashef, 29 sept. 2026 | 7:00 | Oui, automatique | 1:02, 3:04, 3:37 | Bonne |
| [rM_paQG09K4](https://www.youtube.com/watch?v=rM_paQG09K4) Dots | Dante's Datalab, 30 sept. 2026 | 34:27 | Oui, sous-titres coréens de l'auteur, lus sans traduction automatique | 3:20, 7:50, 10:07, 17:50, 25:10 | Bonne ; 7:50 n'est qu'un titre de chapitre |
| [JU0lX7y2Au0](https://www.youtube.com/watch?v=JU0lX7y2Au0) Duet | John Aspinall, 22 oct. 2026 | 11:43 | Oui, automatique | 3:45, 10:52 | 3:45 ne montre que l'auteur |
| [onchw06kP7Y](https://www.youtube.com/watch?v=onchw06kP7Y) Duet | Shaz Mathew, 23 oct. 2026 | 18:10 | Oui, automatique | 5:45, 9:45 | 5:45 floutée par l'auteur |
| [q_PKk3MiR9Y](https://www.youtube.com/watch?v=q_PKk3MiR9Y) Muse | Alex Volkov, 9 sept. 2026 | 23:10 | Oui, automatique | 6:10, 16:14 | Bonne |
| [2UwemqPkJSQ](https://www.youtube.com/watch?v=2UwemqPkJSQ) Muse | How I AI, 16 sept. 2026 | 37:12 | Oui, automatique | 24:32, 26:45, 28:35 | Bonne |
| [sFLRy_jV_Eg](https://www.youtube.com/watch?v=sFLRy_jV_Eg) Grok Bot | Helena, 3 sept. 2026 | 9:22 | Oui, automatique | 1:10, 6:33 | Bonne |
| [17oWTaelCuc](https://www.youtube.com/watch?v=17oWTaelCuc) Grok Bot | alexusadays, 15 août 2026 | 13:27 | Oui, automatique | 2:05 | Faible : liste de plugins |
| [NwyittYtt0o](https://www.youtube.com/watch?v=NwyittYtt0o) OpenClaw voix | Phil Lougher, 22 mars 2026 | 12:00 | Oui, automatique | 4:26 | Faible : l'auteur masque l'écran |
| [CGQeNzMJ3us](https://www.youtube.com/watch?v=CGQeNzMJ3us) OpenClaw voix | Luiz, LFSA Digital, 8 fév. 2026 | 15:13 | Oui, automatique | 13:19 | Nulle : visage seul. L'agent vocal montré est bâti sur Retell AI, pas la voix d'OpenClaw : non retenue dans la grille |

## Résumé

| # | Comportement | Références | Noah |
|---|---|---|---|
| C1 | Démarrer un appel et première réplique | Dots, Grok Bot, Duet, OpenClaw | Partiel |
| C2 | Contrôles pendant l'appel | Grok Bot, Dots | Partiel |
| C3 | L'appel survit à la navigation et au téléphone verrouillé | Dots | Partiel |
| C4 | Fin d'appel : le travail continue, une trace reste | Dots, Grok Bot, OpenClaw | Partiel |
| C5 | Couper la parole | Dots, Hermes, OpenClaw | Tenu |
| C6 | Accusé oral immédiat, travail en arrière-plan | Dots, Muse, Hermes | Tenu |
| C7 | Ce qu'on entend pendant qu'un outil travaille | Dots | Absent |
| C8 | Ce qu'on voit pendant qu'un outil travaille | Dots, Muse, Hermes, Grok Bot | Tenu |
| C9 | Demander où ça en est et obtenir un état vrai | Dots | Partiel |
| C10 | Corriger le travail en cours | Dots, Grok Bot, Duet | Partiel |
| C11 | Journal consultable de ce qui a été fait et accordé | Muse, Dots, Grok Bot | Absent |
| C12 | Carte de confirmation avec le détail de l'action | Muse, Duet, Grok Bot | Partiel |
| C13 | Confirmation pendant la voix : à l'écran, jamais à l'oral | ChatGPT Voice | Tenu |
| C14 | Portée de l'accord : une fois, toujours, par site | Muse, Grok Bot, Dots | Partiel |
| C15 | Programmer une tâche à la voix | Dots, Grok Bot, Muse | Partiel |
| C16 | Comment il rappelle | Dots, Duet, Muse, Grok Bot | Tenu |
| C17 | Heures calmes et fréquence des alertes | Duet, Dots, Grok Bot | Absent |
| C18 | Relier un appareil | OpenClaw, Dots, Grok Bot, Hermes | Tenu |
| C19 | Prendre la main sur l'ordinateur de l'agent | Dots, Grok Bot (Duet s'en passe) | Tenu |
| C20 | Premier contact : nom, visage, première proposition | Duet, Muse, Dots, OpenClaw | Partiel |

**Noah : 7 tenus, 10 partiels, 3 absents.** « Tenu » veut seulement dire que le code existe : je n'ai lancé aucun service. Rien ici ne dit que Noah fait aussi bien qu'une référence.

## Grille

### Appel

#### C1. Démarrer un appel et première réplique

- **Observé.** Un bouton téléphone ou voix dans la conversation. Dès le premier mot, Duet répond en citant le contexte : l'heure tardive, le bloc prévu samedi. Je ne sais pas qui parle en premier : l'auteur dit bonjour juste avant.
- **Sources.**
  - [V] Dots : bouton « Call » sur le profil du dot, [DdSRXsKkHOg à 1:02](https://www.youtube.com/watch?v=DdSRXsKkHOg&t=62s).
  - [D] Dots : bouton téléphone dans la conversation, [canaux](https://learn.chatgpt.com/docs/dots/channels).
  - [D] Grok Bot : « Start voice chat » depuis un compositeur vide, [discussion](https://docs.x.ai/grok-bot/chat-and-collaboration).
  - [D] OpenClaw : bouton Talk, brouillon vide et aucun travail en cours, [Android](https://docs.openclaw.ai/platforms/android).
  - [V] Duet : écran vocal au téléphone, réplique qui cite le contexte, [onchw06kP7Y à 9:45](https://www.youtube.com/watch?v=onchw06kP7Y&t=585s).
  - [S] Dots : à la demande, le bot résume les travaux récents et propose par quoi commencer, [rM_paQG09K4 à 2:08](https://www.youtube.com/watch?v=rM_paQG09K4&t=128s).
  - [S] Désaccord sur Duet : pas d'appel vocal sur la version web, [JU0lX7y2Au0 à 2:05](https://www.youtube.com/watch?v=JU0lX7y2Au0&t=125s). La [doc Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) parle de message vocal, pas d'appel. Non tranché.
- **Vérifier dans Noah.** Vrai navigateur : compter les gestes et le temps entre le clic et le micro ouvert ; dire « salut » et noter si la première réplique s'appuie sur la mémoire de l'agent.
- **État : partiel.** Le bouton est là ([Thread.tsx:360](../frontend/src/components/Thread.tsx#L360), [Voice.tsx:289-295](../frontend/src/components/Voice.tsx#L289)). À l'ouverture, « Je t'écoute… » s'affiche et l'agent se tait, sauf pour un rappel pris ([Voice.tsx:676](../frontend/src/components/Voice.tsx#L676), [601-616](../frontend/src/components/Voice.tsx#L601)). La première réplique vient de la voix rapide, qui ne reçoit que les 6 derniers messages et le rôle ([Voice.tsx:490](../frontend/src/components/Voice.tsx#L490), [media.py:474-486](../server/apollo/media.py#L474)).

#### C2. Contrôles pendant l'appel

- **Observé.** Raccrocher et couper le micro à portée de main, transcription et réglages de voix, de vitesse et de langue. Chez Dots, l'appel réduit tient dans une pastille avec bouton rouge.
- **Sources.**
  - [D] Grok Bot : Mute, Hang up, Show transcript, Show settings, [discussion](https://docs.x.ai/grok-bot/chat-and-collaboration).
  - [D] ChatGPT Voice (produit voisin, non propre à Dots) : micro et sortie, [aide](https://help.openai.com/en/articles/20001274-chatgpt-voice).
  - [V] Dots : pastille d'appel en haut à droite, [rM_paQG09K4 à 3:20](https://www.youtube.com/watch?v=rM_paQG09K4&t=200s).
  - [S] Dots : on demande à l'oral de parler plus lentement, et il le fait, [rM_paQG09K4 à 26:46](https://www.youtube.com/watch?v=rM_paQG09K4&t=1606s).
- **Vérifier dans Noah.** Vrai navigateur et téléphone : liste des contrôles visibles pendant l'appel. Couper le micro, vérifier qu'aucun son ne part.
- **État : partiel.** Quitter et Interrompre existent ([Voice.tsx:699-714](../frontend/src/components/Voice.tsx#L699)), le choix de la voix est dans les Réglages ([Settings.tsx:243](../frontend/src/components/Settings.tsx#L243)). Je n'ai trouvé ni coupure du micro, ni vitesse, ni réglage pendant l'appel.

#### C3. L'appel survit à la navigation et au téléphone verrouillé

- **Observé.** On change de page de l'app sans couper l'appel ; le bot continue de parler et de rapporter. La voix ChatGPT continue téléphone verrouillé.
- **Sources.**
  - [V] Dots : pastille d'appel présente pendant la consultation de l'activité, [rM_paQG09K4 à 17:50](https://www.youtube.com/watch?v=rM_paQG09K4&t=1070s).
  - [S] Dots : l'auteur constate que passer à Spaces ne coupe pas l'appel, [rM_paQG09K4 à 13:21](https://www.youtube.com/watch?v=rM_paQG09K4&t=801s).
  - [D] ChatGPT Voice (produit voisin) : conversation en arrière-plan, écran verrouillé, [aide](https://help.openai.com/en/articles/20001274-chatgpt-voice).
- **Vérifier dans Noah.** Téléphone réel, 4G : pendant un appel, ouvrir les Réglages, changer d'agent, verrouiller, revenir. Noter à quel moment le son s'arrête.
- **État : partiel.** Le mode vocal vit dans le pied de la conversation ([Thread.tsx:426-427](../frontend/src/components/Thread.tsx#L426)), sans pastille flottante, et il ferme le micro quand il disparaît ([Voice.tsx:592-597](../frontend/src/components/Voice.tsx#L592)). Le manifeste Android donne le micro et le plein écran, sans service au premier plan ([AndroidManifest.xml:60-63](../mobile/android/app/src/main/AndroidManifest.xml#L60)). Le changement d'agent reste à vérifier en vrai.

#### C4. Fin d'appel : le travail continue, une trace reste

- **Observé.** Raccrocher n'arrête pas le travail. Grok Bot laisse une carte avec la durée et la transcription.
- **Sources.**
  - [D] Dots : terminer un appel n'arrête pas le travail, [canaux](https://learn.chatgpt.com/docs/dots/channels).
  - [D] Grok Bot : carte « Voice chat » avec durée et transcription, [discussion](https://docs.x.ai/grok-bot/chat-and-collaboration).
  - [D] OpenClaw : le travail accepté continue et la réponse arrive dans le chat, seul Stop l'annule, [Android](https://docs.openclaw.ai/platforms/android).
- **Vérifier dans Noah.** Vrais conteneurs : lancer une tâche à la voix, quitter, vérifier que le résultat arrive. Dire une phrase pendant le travail, quitter aussitôt, chercher si elle arrive à l'agent.
- **État : partiel.** Quitter coupe le son et le micro, pas le travail ([Voice.tsx:592-597](../frontend/src/components/Voice.tsx#L592)), et l'échange reste écrit ([Voice.tsx:433-434](../frontend/src/components/Voice.tsx#L433)). Pas de carte de fin. Risque à vérifier : ce qui attend dans `queue` n'est envoyé qu'à la fin du tour ([Voice.tsx:663-668](../frontend/src/components/Voice.tsx#L663)), et rien ne l'envoie à la fermeture.

#### C5. Couper la parole

- **Observé.** On parle par-dessus l'agent : il s'arrête, s'excuse et écoute.
- **Sources.**
  - [S] Dots : « attends » répété, le bot se tait, [rM_paQG09K4 à 3:15](https://www.youtube.com/watch?v=rM_paQG09K4&t=195s) et [5:20](https://www.youtube.com/watch?v=rM_paQG09K4&t=320s).
  - [D] Hermes : parler coupe la lecture, un « stop » seul finit la conversation, [voix](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode).
  - [D] OpenClaw : `interruptOnSpeech` actif par défaut, [Talk](https://docs.openclaw.ai/nodes/talk).
- **Vérifier dans Noah.** Banc audio : phrase jouée par-dessus l'agent, temps jusqu'au silence ; un « mm-hm » ne doit pas l'arrêter. À comparer à l'oreille, je n'ai rien entendu des références.
- **État : tenu (code).** Baisse de la voix à 100 ms, arrêt à 600 ms, bouton Interrompre ([Voice.tsx:18-23](../frontend/src/components/Voice.tsx#L18), [546-558](../frontend/src/components/Voice.tsx#L546), [699-709](../frontend/src/components/Voice.tsx#L699)).

#### C6. Accusé oral immédiat, travail en arrière-plan

- **Observé.** Une phrase courte tout de suite, le travail part à côté, la conversation continue.
- **Sources.**
  - [S] Dots : le bot annonce le plan puis lance la production, [rM_paQG09K4 à 4:24](https://www.youtube.com/watch?v=rM_paQG09K4&t=264s) ; l'auteur décrit la voix qui répond pendant que le travail tourne, [6:33](https://www.youtube.com/watch?v=rM_paQG09K4&t=393s).
  - [D] Muse : le mode vocal avance des tâches pendant qu'on parle, [Connect 2026](https://www.meta.com/blog/meta-connect-2026-everything-we-announced/).
  - [D] Hermes : GPT-Live délègue le travail à l'agent, [voix](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode).
- **Vérifier dans Noah.** Banc existant (`server/apollo/bench_voice.py`) : délai avant le premier son, accusés sans résultat inventé.
- **État : tenu (code).** Voix rapide et agent en parallèle ([Voice.tsx:509-522](../frontend/src/components/Voice.tsx#L509), [media.py:474-481](../server/apollo/media.py#L474)).

### Pendant le travail

#### C7. Ce qu'on entend pendant qu'un outil travaille

- **Observé.** Chez Dots, le bot prend la parole de lui-même entre deux demandes pour dire l'étape franchie et l'étape en cours. Le même auteur ajoute qu'il se trompe parfois, puis se corrige.
- **Sources.**
  - [S] Dots : compte rendu spontané en plein appel, [rM_paQG09K4 à 12:46](https://www.youtube.com/watch?v=rM_paQG09K4&t=766s) et [14:54](https://www.youtube.com/watch?v=rM_paQG09K4&t=894s).
  - [S] Dots : l'auteur relève que le bot parle sans être sollicité, [rM_paQG09K4 à 9:16](https://www.youtube.com/watch?v=rM_paQG09K4&t=556s).
  - [S] Avis inverse d'un autre testeur de Dots : rien n'indique toujours qu'il travaille, [DdSRXsKkHOg à 2:35](https://www.youtube.com/watch?v=DdSRXsKkHOg&t=155s).
  - Limite : le son n'a pas été écouté, et je n'ai pas de source sur un bruit d'attente chez Grok Bot, Duet ou Muse.
- **Vérifier dans Noah.** Appel de 3 minutes sur une tâche longue : mesurer les silences de plus de 10 s et ce qui les rompt ; vérifier que chaque phrase correspond à une étape réelle de l'agent.
- **État : absent.** Après l'accusé, plus rien jusqu'au résumé final ([Voice.tsx:637-659](../frontend/src/components/Voice.tsx#L637)). Le texte « s'en occupe » n'est qu'à l'écran ([Voice.tsx:679](../frontend/src/components/Voice.tsx#L679)). La voix rapide n'a pas le droit de parler de l'état du travail ([media.py:482-483](../server/apollo/media.py#L482)), et je n'ai trouvé ni son d'attente ni suivi d'étapes à l'oral.

#### C8. Ce qu'on voit pendant qu'un outil travaille

- **Observé.** Une réaction posée sur le message, une bulle mise à jour sur place, ou un avatar qui se met au travail.
- **Sources.**
  - [V] Dots : coche sur le message une fois le travail fini, [DdSRXsKkHOg à 3:04](https://www.youtube.com/watch?v=DdSRXsKkHOg&t=184s).
  - [V] Muse : réaction pouce levé à la demande, [q_PKk3MiR9Y à 16:14](https://www.youtube.com/watch?v=q_PKk3MiR9Y&t=974s).
  - [V] Muse : avatar et liste d'activité en colonne droite, [2UwemqPkJSQ à 26:45](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1605s).
  - [S] Muse : l'avatar prend un petit ordinateur quand il travaille, [2UwemqPkJSQ à 26:32](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1592s).
  - [D] Hermes : une seule bulle mise à jour, « Working — N min », [messagerie](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/).
  - [D] Grok Bot : la transcription montre l'activité des outils, [discussion](https://docs.x.ai/grok-bot/chat-and-collaboration).
- **Vérifier dans Noah.** Vrai navigateur : temps entre l'envoi et le premier signal ; le signal disparaît-il à la fin, même en cas d'erreur.
- **État : tenu (code).** Ligne d'activité unique, « Réflexion… » avant ([Thread.tsx:124-133](../frontend/src/components/Thread.tsx#L124), [297-300](../frontend/src/components/Thread.tsx#L297)). L'avatar de Noah, lui, ne s'anime que quand il parle ([Voice.tsx:689](../frontend/src/components/Voice.tsx#L689)).

#### C9. Demander où ça en est et obtenir un état vrai

- **Observé.** Questionné en plein travail, le bot Dots dit ce qui est confirmé et ce qui ne l'est pas, puis va vérifier.
- **Sources.**
  - [S] Dots : le rendu n'est pas annoncé fini tant que rien ne le confirme, [rM_paQG09K4 à 10:59](https://www.youtube.com/watch?v=rM_paQG09K4&t=659s) et [19:13](https://www.youtube.com/watch?v=rM_paQG09K4&t=1153s).
  - [S] Dots : il corrige après coup un état mal rapporté, [rM_paQG09K4 à 28:52](https://www.youtube.com/watch?v=rM_paQG09K4&t=1732s).
  - [D] Dots : l'activité montre progression, fichiers et résultats, [tâches](https://learn.chatgpt.com/codex/dots/tasks-and-memory).
- **Vérifier dans Noah.** Vrais conteneurs : pendant une tâche de 2 minutes, demander « où ça en est » ; mesurer le délai d'une réponse fondée, et contrôler qu'aucun faux « c'est fini » n'est dit.
- **État : partiel.** Noah ne ment pas : la voix rapide reformule sans donner d'état ([media.py:480-483](../server/apollo/media.py#L480)). Mais la question attend la fin du travail en cours avant d'arriver à l'agent ([Voice.tsx:510-516](../frontend/src/components/Voice.tsx#L510), [662-669](../frontend/src/components/Voice.tsx#L662)).

#### C10. Corriger le travail en cours

- **Observé.** Une correction dite en plein travail change le travail en cours, sans repartir de zéro.
- **Sources.**
  - [S] Dots : changement de style, repris dans la même tâche, [rM_paQG09K4 à 5:28](https://www.youtube.com/watch?v=rM_paQG09K4&t=328s) et [6:03](https://www.youtube.com/watch?v=rM_paQG09K4&t=363s).
  - [D] Grok Bot : un nouveau message est prioritaire et peut réorienter le tour, « Stop now » l'arrête, [discussion](https://docs.x.ai/grok-bot/chat-and-collaboration).
  - [D] Duet : on peut l'orienter en cours de route depuis la page de la tâche, [sécurité](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
  - [D] Hermes : parler pendant la génération interrompt le tour et devient le message suivant, [voix](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode).
- **Vérifier dans Noah.** Vrais conteneurs : donner une consigne, la corriger après 20 s, vérifier le résultat final et le coût gaspillé.
- **État : partiel.** À la voix, la correction attend : « Je lui transmets ensuite » ([Voice.tsx:510-516](../frontend/src/components/Voice.tsx#L510)). À l'écrit, pendant le travail, seul Arrêter est proposé ([Thread.tsx:380-384](../frontend/src/components/Thread.tsx#L380)).

#### C11. Journal consultable de ce qui a été fait et accordé

- **Observé.** Une liste chronologique des tâches, des étapes et des accords, qu'on peut relire après coup.
- **Sources.**
  - [V] Muse : étapes d'une tâche et résumé à côté, [2UwemqPkJSQ à 24:32](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1472s).
  - [D] Muse : journal des actions et des permissions, [aide](https://www.meta.com/help/artificial-intelligence/1385290430137537/).
  - [D] Dots : Activité et Programmé, [contrôles](https://learn.chatgpt.com/codex/dots/controls).
  - [D] Grok Bot : historique des routines, les 20 dernières exécutions, [routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).
- **Vérifier dans Noah.** Vrai navigateur : après une tâche avec un accord, retrouver les étapes et l'accord dans l'interface, une heure et une semaine plus tard.
- **État : absent.** La ligne d'activité est remplacée puis retirée ([Thread.tsx:124](../frontend/src/components/Thread.tsx#L124)). Aucun composant ne porte « journal » ou « audit ». Le serveur note les accords vus ([main.py:1634](../server/apollo/main.py#L1634)), je n'ai pas trouvé d'écran qui les montre. Le panneau de coût ne remplace pas ce journal ([SidePanel.tsx:147](../frontend/src/components/SidePanel.tsx#L147)).

### Confirmation

#### C12. Carte de confirmation avec le détail de l'action

- **Observé.** La conversation affiche l'action, sa cible et son montant, avec Autoriser et Refuser. Une notification permet de répondre à distance.
- **Sources.**
  - [V] Muse : carte de paiement, total estimé, moyen de paiement, Allow et Deny, [q_PKk3MiR9Y à 6:10](https://www.youtube.com/watch?v=q_PKk3MiR9Y&t=370s).
  - [D] Duet : action, destinataires et contenu affichés avant l'accord, [sécurité](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
  - [D] Grok Bot : opération, entrées et trois choix, [sécurité](https://docs.x.ai/grok-bot/security).
  - [S] Duet : une tâche propose d'envoyer 27 relances et attend le oui, [onchw06kP7Y à 5:38](https://www.youtube.com/watch?v=onchw06kP7Y&t=338s) ; l'image à 5:45 est floutée.
- **Vérifier dans Noah.** Vrai navigateur et notification sur téléphone : déclencher un envoi de courriel, lire la carte ; un inconnu comprend-il la cible et l'effet sans ouvrir autre chose.
- **État : partiel.** Carte et boutons sont là, avec une notification urgente ([Thread.tsx:135-165](../frontend/src/components/Thread.tsx#L135), [main.py:1638](../server/apollo/main.py#L1638)). Le contenu reste un résumé libre, sans champs fixes pour la cible et le montant, ni lien vers le détail.

#### C13. Confirmation pendant la voix : à l'écran, jamais à l'oral

- **Observé.** Pendant un échange vocal, l'accord se donne sur l'écran. Aucun mot prononcé ne le vaut.
- **Sources.**
  - [D] ChatGPT Voice : « spoken approval is not supported », [aide](https://help.openai.com/en/articles/20001274-chatgpt-voice). Page générale de la voix ChatGPT : je n'ai pas de source propre aux appels Dots.
  - [D] Hermes : la page de la voix ne décrit aucune approbation orale, [voix](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode).
- **Vérifier dans Noah.** Vrai navigateur : en appel, dire « oui » à une demande d'accord et vérifier que rien ne part ; refaire en touchant Autoriser.
- **État : tenu (code).** L'agent le dit à voix haute, l'écran l'indique, seule la carte décide ([Voice.tsx:618-635](../frontend/src/components/Voice.tsx#L618), [679](../frontend/src/components/Voice.tsx#L679)).

#### C14. Portée de l'accord : une fois, toujours, par site

- **Observé.** On choisit jusqu'où vaut l'accord, puis on le retire plus tard.
- **Sources.**
  - [D] Muse : une fois, cette tâche, ce site, toujours pour ce connecteur, refus, [aide](https://www.meta.com/help/artificial-intelligence/1385290430137537/).
  - [D] Grok Bot : Allow once, Always allow, Deny, [sécurité](https://docs.x.ai/grok-bot/security).
  - [D] Dots : règles personnalisées en quatre options, [contrôles](https://learn.chatgpt.com/codex/dots/controls).
  - [S] Muse : l'autrice loue qu'il demande au bon moment, sans mode tout automatique, [2UwemqPkJSQ à 25:29](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1529s).
- **Vérifier dans Noah.** Vrai navigateur : accorder pour un cas, vérifier ce qui est redemandé ensuite, puis révoquer.
- **État : partiel.** La carte n'offre qu'Autoriser et Refuser ([Thread.tsx:156-157](../frontend/src/components/Thread.tsx#L156)). Un droit existe par serveur d'outils ([AgentPowers.tsx:584](../frontend/src/components/AgentPowers.tsx#L584)), pas par site ni par tâche.

### Retour de l'agent

#### C15. Programmer une tâche à la voix

- **Observé.** On demande une tâche récurrente en parlant. L'agent redit les conditions puis confirme l'horaire et la première exécution.
- **Sources.**
  - [S] Dots : brief de 7 h demandé à l'oral, confirmation avec la date de première exécution, [rM_paQG09K4 à 16:32](https://www.youtube.com/watch?v=rM_paQG09K4&t=992s) et [17:38](https://www.youtube.com/watch?v=rM_paQG09K4&t=1058s).
  - [V] Dots : liste d'activité à côté de l'appel à ce moment, [rM_paQG09K4 à 17:50](https://www.youtube.com/watch?v=rM_paQG09K4&t=1070s).
  - [D] Grok Bot : routines, calendrier ou déclencheur, résultat dans le chat, [routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).
  - [V] Muse : rappel proposé pendant la création d'un objectif, avec un choix à toucher, [2UwemqPkJSQ à 26:45](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1605s).
- **Vérifier dans Noah.** Vrais conteneurs : dicter une routine en appel ; vérifier ce qui est dit, l'horaire enregistré et la première exécution.
- **État : partiel.** Routines par la conversation ou par formulaire, prochaine exécution affichée ([AgentPowers.tsx:108-148](../frontend/src/components/AgentPowers.tsx#L108), [125](../frontend/src/components/AgentPowers.tsx#L125)), et la voix sait qu'il s'agit d'une action ([media.py:477-478](../server/apollo/media.py#L477)). Rien n'impose que la confirmation orale donne l'horaire et la première exécution.

#### C16. Comment il rappelle

- **Observé.** Les références reviennent par écrit et par notification. Celles dont j'ai la source ne font pas sonner leur utilisateur : Dots le dit, et Duet ne passe pas d'appels.
- **Sources.**
  - [D] Dots : « Your dot cannot initiate calls to you at launch. », [aide](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).
  - [D] Duet : pas d'appels ni de SMS à d'autres personnes, mais un message quand une décision est nécessaire, [démarrage](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) ; il écrit le premier, [annonce](https://claude.com/resources/articles/claude-duet).
  - [D] Muse : revient quand quelque chose change ou qu'un accord manque, [annonce](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).
  - [D] Grok Bot : notification pour un résultat, une question ou un accord, [mobile](https://docs.x.ai/grok-bot/mobile).
  - [S] Muse : réglage de fréquence du réveil de l'agent, [q_PKk3MiR9Y à 15:11](https://www.youtube.com/watch?v=q_PKk3MiR9Y&t=911s).
- **Vérifier dans Noah.** Téléphone réel, 4G, app fermée : déclenchement, délai de sonnerie, Répondre, Refuser, manqué ; le compte rendu reste écrit dans chaque cas.
- **État : tenu (code).** Sonnerie, écran plein, notification urgente, limite de 6 par heure, 60 s avant « manqué », texte gardé ([Call.tsx:15-54](../frontend/src/components/Call.tsx#L15), [158-195](../frontend/src/components/Call.tsx#L158), [coordination.py:334-355](../server/apollo/coordination.py#L334), [NoahPush.java:262](../mobile/android/app/src/main/java/agent/noah/mobile/NoahPush.java#L262)). Ce n'est pas un avantage prouvé : rien n'a été essayé sur un vrai téléphone dans ce relevé, et personne n'a jugé si ce rappel plaît.

#### C17. Heures calmes et fréquence des alertes

- **Observé.** On règle quand et sur quoi l'agent peut déranger.
- **Sources.**
  - [V] Duet : écran de réglages avec notifications et brief du matin, heures calmes citées par l'auteur juste avant, [JU0lX7y2Au0 à 10:52](https://www.youtube.com/watch?v=JU0lX7y2Au0&t=652s).
  - [D] Duet : sujets et fréquence des alertes au choix, [annonce](https://claude.com/resources/articles/claude-duet).
  - [D] Dots : pour une tâche planifiée, il n'écrit que si un délai est en danger ou si une décision manque, [tâches](https://learn.chatgpt.com/codex/dots/tasks-and-memory).
  - [D] Grok Bot : interrupteur de notifications par Bot, [discussion](https://docs.x.ai/grok-bot/chat-and-collaboration).
- **Vérifier dans Noah.** Test simulé puis téléphone : régler une plage calme, déclencher un rappel et une alerte, vérifier ce qui passe et ce qui attend.
- **État : absent.** Recherche de « quiet », « heures calmes », « silencieux » sans résultat dans `frontend/src` et `server`. On peut seulement couper tout par appareil ([PushToggle.tsx:47-68](../frontend/src/components/PushToggle.tsx#L47)), et les rappels sont limités à 6 par heure ([coordination.py:24](../server/apollo/coordination.py#L24)).

### Appareils

#### C18. Relier un appareil

- **Observé.** Un QR ou un code à durée courte, puis l'accord d'un appareil déjà connecté. Les produits fermés passent par le compte.
- **Sources.**
  - [D] OpenClaw : QR, jeton 10 min, approbation, révocation séparée, [appairage](https://docs.openclaw.ai/gateway/pairing).
  - [D] Hermes : code à usage unique, 1 h, approuvé en ligne de commande, [messagerie](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/).
  - [D] Dots : numéro de téléphone vérifié par code pour écrire au dot, [aide](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).
  - [D] Grok Bot : connexion par navigateur au compte, pas de QR mentionné, [mobile](https://docs.x.ai/grok-bot/mobile).
- **Vérifier dans Noah.** Téléphone réel, 4G : temps du QR à la première réponse, code expiré, révocation depuis un autre appareil et coupure effective.
- **État : tenu (code).** QR et code de 10 min, vérification par un nombre, liste et déconnexion ([PhonePairing.tsx:1-2](../frontend/src/components/PhonePairing.tsx#L1), [25-71](../frontend/src/components/PhonePairing.tsx#L25), [89-90](../frontend/src/components/PhonePairing.tsx#L89), [DeviceApproval.tsx:86-115](../frontend/src/components/DeviceApproval.tsx#L86)).

#### C19. Prendre la main sur l'ordinateur de l'agent

- **Observé.** L'agent demande de l'aide pour une étape humaine, comme un captcha. On voit son écran, on prend la main, on la rend.
- **Sources.**
  - [V] Grok Bot : captcha dans le navigateur de l'agent, bandeau d'appel en haut, [sFLRy_jV_Eg à 6:33](https://www.youtube.com/watch?v=sFLRy_jV_Eg&t=393s).
  - [V] Dots : ordinateur de l'agent ouvert, « has control » et « Take over », [DdSRXsKkHOg à 3:37](https://www.youtube.com/watch?v=DdSRXsKkHOg&t=217s) ; autre vue, [rM_paQG09K4 à 10:07](https://www.youtube.com/watch?v=rM_paQG09K4&t=607s).
  - [D] Dots : Take over et Return control, [ordinateurs](https://learn.chatgpt.com/codex/dots/computers-and-apps).
  - [D] Grok Bot : étapes qui reviennent à l'humain, ne jamais coller un mot de passe dans le chat, [ordinateur](https://docs.x.ai/grok-bot/computer-and-apps).
  - [D] Duet, à l'inverse : ni vue ni prise en main du navigateur, [démarrage](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet).
- **Vérifier dans Noah.** Vrais conteneurs : une connexion qui bloque l'agent, le bandeau, la prise de contrôle, le retour ; aucune capture pendant la saisie.
- **État : tenu (code).** Bandeau et écran qui s'ouvre ([Handoff.tsx:8-12](../frontend/src/components/Handoff.tsx#L8), [56-63](../frontend/src/components/Handoff.tsx#L56)), bouton de prise et de retour ([SidePanel.tsx:517-518](../frontend/src/components/SidePanel.tsx#L517)).

#### C20. Premier contact : nom, visage, première proposition

- **Observé.** On nomme l'agent et on lui donne une apparence ; il se présente, lit le contexte déjà accessible et propose du travail.
- **Sources.**
  - [D] Dots : nom, apparence, présentation puis suggestions, [démarrage](https://learn.chatgpt.com/codex/dots/getting-started).
  - [S] Duet : il parcourt les applications reliées, résume la personne et crée des tâches sans qu'on demande, [onchw06kP7Y à 3:04](https://www.youtube.com/watch?v=onchw06kP7Y&t=184s) et [5:08](https://www.youtube.com/watch?v=onchw06kP7Y&t=308s).
  - [V] Muse : avatar généré, quatre options à choisir, [2UwemqPkJSQ à 28:35](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1715s).
  - [S] Muse : nom demandé d'entrée, page d'idées prête à l'emploi, [2UwemqPkJSQ à 5:21](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=321s) et [16:05](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=965s).
  - [D] OpenClaw : aucune suite avant une vraie réponse du modèle, [onboarding](https://docs.openclaw.ai/start/onboarding-overview).
  - [S] OpenClaw : interroge sur la personnalité dans les premiers messages, [DdSRXsKkHOg à 5:21](https://www.youtube.com/watch?v=DdSRXsKkHOg&t=321s).
- **Vérifier dans Noah.** Personne réelle, chronométrée : de l'installation à la première tâche utile, sans aide. Compter les écrans et noter le premier message de l'agent.
- **État : partiel.** Nom, rôle, couleur, puis premier essai réel ([Onboarding.tsx:284](../frontend/src/components/Onboarding.tsx#L284), [343](../frontend/src/components/Onboarding.tsx#L343), [AgentDialog.tsx:68-81](../frontend/src/components/AgentDialog.tsx#L68)). L'accueil attend une consigne : « Que doit faire {agentName} ? » ([Thread.tsx:412](../frontend/src/components/Thread.tsx#L412)). L'agent ne se présente pas et ne propose rien de lui-même d'après ce que j'ai lu.

## Écarts les plus importants de Noah

1. **C7, le silence pendant le travail.** Sur une longue tâche en appel, on n'entend plus rien entre l'accusé et le résumé.
2. **C10, la correction attend.** À la voix comme à l'écrit, on ne réoriente pas un travail lancé : on patiente ou on arrête.
3. **C9, l'état n'arrive qu'à la fin.** Noah ne ment pas, mais « où ça en est » n'a de vraie réponse qu'une fois le travail terminé.
4. **C11, pas de journal.** Après coup, on ne peut pas relire les étapes ni les accords donnés.
5. **C3, l'appel est fragile.** Pas de pastille, pas de service au premier plan : d'après le code, l'appel tient à la page ouverte et au téléphone allumé.

Ensuite : C17 (heures calmes) et C14 (portée de l'accord). C7, C9 et C10 ont sans doute une cause commune : la voix ne reçoit pas les étapes de l'agent et ne peut pas lui parler pendant un tour. C'est une hypothèse à tester, pas un diagnostic.

## Limites

- **Son :** rien n'a été écouté. C5, C6 et C7 sont notés d'après les sous-titres.
- **Images :** une image prouve un état à un instant, pas une séquence. Là où seule la transcription parle, la marque est [S].
- **Lecture de la doc :** les pages OpenAI (aide et annonce de Dots, ChatGPT Voice) ont été lues dans le navigateur. Les autres pages [D] ont été lues via un extrait résumé par un outil : le sens est repris, le texte exact doit être relu avant d'en faire une exigence.
- **Grok Bot :** les appels vers des tiers évoqués dans [sFLRy_jV_Eg à 7:08](https://www.youtube.com/watch?v=sFLRy_jV_Eg&t=428s) ne figurent pas dans la doc lue : non retenus.
- **Muse :** le mode vocal n'est décrit que par l'annonce de Connect ; je n'ai pas de vidéo qui le montre en détail. How I AI dit seulement qu'il s'est trompé pendant un achat ([2UwemqPkJSQ à 29:49](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1789s)).
- **Non lus :** [ai.meta.com/muse](https://ai.meta.com/muse/) n'a rendu qu'un titre, [chatgpt.com/features/dots](https://chatgpt.com/features/dots/) un refus 403.
- **État de Noah :** lu dans le code, sans lancer de service. Une absence veut dire « je ne l'ai pas trouvée » dans ce que j'ai lu : `Voice.tsx`, `Call.tsx`, `Thread.tsx`, quelques autres composants et des recherches par mots. Une revue du code pourra corriger un état.
- **Pas de classement :** cette grille ne dit pas que Noah dépasse une référence, y compris sur C16.
