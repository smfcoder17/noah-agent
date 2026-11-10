# Noah 0.1.6 : une app qui ne fait plus attendre ni demander pour rien

## L'histoire

En tant que personne qui confie son travail à Noah depuis son téléphone et son ordinateur, je veux une app mobile aussi simple et soignée que Muse, un agent qui agit sans me redemander ce que j'ai déjà demandé, un navigateur qui ne bloque pas, et des apps installées depuis les boutiques officielles, afin de ne plus perdre de temps et de faire confiance à Noah comme à une app premium.

## Le contexte

Aujourd'hui, l'écran de l'ordinateur de l'agent affiche souvent « Aucune page ouverte » alors qu'il y en a une. Changer d'onglet recharge tout, l'écran comme les listes. Le juge demande mon accord pour `date` dès que l'agent a lu une page qui contient des consignes, et le bureau ouvre des fenêtres Windows pour enregistrer un `.html` dans le dossier confié. Sur le téléphone, « Noah peut t'appeler » revient sans cesse, et je ne reçois jamais « tâche finie ». L'app mobile empile des onglets en haut et en bas, avec trop de texte. Le navigateur de l'agent montre des pages blanches. Windows avertit d'un « éditeur inconnu ». Dans Réglages, la version affichée est celle du serveur, pas celle de l'app.

## Ordre de livraison

Une seule version 0.1.6, livrée par lots dans cet ordre, chaque lot testé avant le suivant : 1. ce qui casse et le banc de l'autonomie ; 2. l'interface et les éléments ouvrables ; 3. le navigateur ; 4. les paquets prêts à soumettre aux boutiques. Si un lot glisse, les lots déjà prêts partent sans lui.

## Les deux réglages d'autonomie, et ce qu'ils permettent

Deux réglages distincts, par agent :
- **Autonomie** (Auto ou Prudent) : ce que l'agent fait sans me demander quand il travaille.
- **Initiative** (Rien, Me prévenir, Agir et me prévenir) : ce qu'il fait quand je ne lui parle pas (veilles, routines, événements).

| Action | Auto | Prudent | Initiative « Me prévenir » |
|---|---|---|---|
| Lire, lister, chercher, calculer, naviguer | sans demander | sans demander | sans demander |
| Créer, écrire, déplacer, ranger dans le dossier confié ; remplacer un fichier en gardant l'ancien dans la corbeille | sans demander | demande | prépare et me prévient |
| Envoyer ou publier exactement ce que j'ai demandé (même compte, mêmes destinataires, même contenu, mêmes pièces jointes) | sans demander | demande | prépare et me prévient |
| Envoyer ou publier ce que je n'ai pas demandé, ou s'écarter de la demande | demande | demande | prépare et me prévient |
| Mettre à la corbeille | sans demander | demande | prépare et me prévient |
| Supprimer définitivement, payer, toucher un secret, changer des droits, sortir du dossier confié, lancer un programme téléchargé | demande | demande | prépare et me prévient |

Un outil connecté auquel j'ai donné le droit « agir » écrit sans me demander, quel que soit le niveau : mon réglage par outil fait foi (décision du 9 novembre 2026). Les deux règles suivantes s'appliquent quand même : le cas des consignes lues, ci-dessous, et la dernière ligne du tableau.

Un tour qui a lu un contenu contenant des consignes reste à son niveau pour les lignes 1 et 2, mais demande pour toute la ligne 3 en me montrant le texte exact. Il attend ma réponse ; sans réponse dans une routine, il ne fait rien et me le dit.

## Critères d'acceptation

### Lot 1 : ce qui casse ou fait attendre

**Écran de l'ordinateur de l'agent**
- Étant donné que le navigateur de l'agent a une page ouverte, quand j'ouvre Ordinateur, alors l'écran s'affiche en moins de 3 s, sans ouvrir d'onglet séparé.
- « Aucune page ouverte » n'apparaît que si le navigateur n'a vraiment aucune page. Si l'écran ne répond pas, je vois « Écran injoignable » et un bouton pour réessayer, et il réessaie seul.
- Quand je passe à Compétences puis reviens à Ordinateur, alors l'écran est toujours là, sans reconnexion ni rechargement.
- Chaque onglet déjà vu s'affiche tout de suite avec ses données, puis se met à jour sans spinner.

**Juge et autorisations**
- Le juge applique le tableau ci-dessus, et lui seul. Après la lecture d'une page qui contient des consignes, `date`, lire, lister ou calculer passent sans me demander.
- Quand je demande « poste ce texte sur X », alors l'agent le publie sur mon compte X sans autre accord. S'il change le texte, ajoute une image ou vise un autre compte, il me demande en montrant l'écart.
- Sur 20 tâches réelles tirées du journal du VPS (navigateur, X, dossier, terminal), aucune demande d'accord hors des cases « demande » du tableau.

**Accords synchronisés sur tous mes appareils**
- Une demande d'accord s'affiche sur le téléphone, l'ordinateur et le web en même temps. Dès que je réponds sur l'un, elle disparaît des autres en moins de 2 s, avec une ligne « Accord donné sur l'ordinateur ».
- Plusieurs demandes en attente s'affichent dans l'ordre d'arrivée ; répondre à l'une ne touche pas les autres, et aucune demande déjà répondue, expirée ou annulée ne reste affichée, même après une coupure de réseau ou un redémarrage de l'app.
- Test : deux demandes de suite, réponse à la seconde sur l'ordinateur, puis vérification sur le téléphone et le web.

**Bureau : plus aucune fenêtre Windows**
- Créer, écrire (quel que soit le type, `.html` compris), déplacer ou ranger dans le dossier confié se fait sans fenêtre, selon le tableau.
- Une demande d'accord qui reste nécessaire s'affiche en bandeau dans la fenêtre de Noah, et une notification Windows m'y amène. Aucune boîte de dialogue système.
- Ce bandeau est dessiné par l'app de bureau à partir de ses propres fichiers, isolé de la page servie par le serveur : un serveur compromis ne peut ni l'afficher, ni le cliquer, ni changer ce qu'il montre. Mon accord vaut une seule fois, pour l'action exacte affichée (programme, arguments, chemin), et expire avant les 5 minutes du serveur, comme aujourd'hui (`desktop/actions.js`, `ANSWER_WITHIN`).
- Exception de sécurité : une demande d'accord qui touche l'ordinateur s'affiche sur tous mes appareils, mais ne se donne que dans l'app de bureau. Ailleurs, elle dit « À accepter sur ton ordinateur ». Le niveau d'autonomie de l'ordinateur se règle dans l'app de bureau ; le serveur ne peut pas l'élargir.

**Notifications et appels sur le téléphone**
- Plus de notification « Noah peut t'appeler » qui revient après qu'on l'a effacée.
- « App fermée » veut dire en arrière-plan ou retirée des apps récentes. Un arrêt forcé dans les réglages d'Android bloque tout push : ce cas n'est pas couvert, et l'app le dit dans Notifications.
- App fermée, téléphone verrouillé : « Tâche finie » arrive en moins de 30 s quand une tâche de plus de 30 s se termine, avec son titre, et l'ouvre au toucher. Sur l'écran verrouillé, le titre est masqué si « Masquer les données sensibles » est actif.
- App fermée, écran éteint : un appel de Noah sonne en plein écran (sonnerie, Répondre / Refuser) si Android accorde l'affichage plein écran. Sinon, ou si je l'ai refusé, il arrive en notification d'appel prioritaire avec sonnerie, et Notifications m'explique comment l'activer.
- Dans Réglages > Notifications : activer ou couper chaque type (tâches, accords, appels, messages), choisir la sonnerie, mode silencieux, plages « Ne pas déranger ».
- Rien n'est hébergé pour les notifications, ni par Franck ni chez Google Firebase. Le serveur Noah (VPS ou ordinateur) envoie un signal chiffré, sans contenu, par UnifiedPush quand le téléphone a un distributeur (ntfy, gratuit, avec le serveur public ntfy.sh ou celui du VPS). Sans distributeur, l'app garde sa propre veille.
- Cette veille démarre une seule fois et ne se relance pas en boucle. Sa notification, qu'Android impose, est réduite au minimum : repliée en bas du volet, sans icône dans la barre d'état, sans son. Sur Android 13 et plus, je peux la balayer et elle ne revient pas tant que la veille tourne. Notifications propose « Installer ntfy » pour s'en passer tout à fait.

**Versions**
- Sur le téléphone, Réglages > Mises à jour affiche « Application 0.1.6 » et, en plus petit, « serveur 0.1.6 ». Pareil sur le bureau. Sur le web, seule la version du serveur.

**Sans VPS : l'ordinateur comme cerveau**
- Étant donné une personne sans VPS, quand elle installe l'app de bureau et choisit « Sur cet ordinateur », alors Noah tourne sur son ordinateur (Docker, comme `install.sh` aujourd'hui) avec ses connexions, son navigateur et ses routines.
- Dans Réglages > Appareils > « Relier un téléphone », l'ordinateur affiche un code QR. Le téléphone le scanne (« Mon ordinateur ») et se relie, avec le même accord à 3 chiffres qu'aujourd'hui.
- Sur le même Wi-Fi, le téléphone trouve l'ordinateur seul. Hors de la maison, il faut un chemin gratuit que la personne installe elle-même, sans rien héberger : Tailscale (recommandé, adresse fixe) ; l'app le détecte et le propose.
- Ordinateur éteint ou en veille : le téléphone le dit (« Ton ordinateur est éteint, Noah reprendra à son réveil ») ; les routines manquées partent au réveil, et l'app le dit.
- Les notifications partent de l'ordinateur par le même chemin que d'un VPS (UnifiedPush ou veille de l'app).

### Lot 1 bis : l'agent travaille seul, et on le prouve (priorité)

Le but de Noah : la personne confie une tâche, l'agent trouve comment la rendre possible et la fait, dans la limite de l'autonomie donnée.

**Ce que l'agent doit savoir faire seul**
- Étant donné « regarde mon GitHub ; à chaque nouvelle PR, analyse-la, range l'analyse dans tel dossier et préviens-moi seulement si c'est un bug critique », alors l'agent crée lui-même la veille ou la routine, montre une carte « Nouvelle routine » dans la discussion, et à la PR suivante range l'analyse et n'envoie une notification que si la PR est critique.
- Étant donné une boîte de courriels connectée et une veille « nouveaux courriels », quand un courriel arrive, alors l'agent le détecte au tour suivant de sa veille, agit selon la consigne (brouillon, rangement, rendez-vous) et me prévient selon mes réglages, sans que je le relance.
- Étant donné un outil manquant (pas de connecteur GitHub, par exemple), alors l'agent propose lui-même la connexion ou un autre chemin (navigateur, API publique), au lieu de s'arrêter.
- En initiative « Me prévenir », il prépare et me demande ; en « Agir et me prévenir », il fait selon le tableau d'autonomie et me rend compte. Il ne dépasse jamais le tableau.

**Compétences apprises**
- Quand l'agent apprend à faire quelque chose (après une demande répétée ou mes corrections), la compétence apparaît dans Compétences, section « Apprises par Noah », avec son origine (« Après ta demande du 9 nov. ») et son nombre d'utilisations. Je peux la relire, la corriger, la retirer. Une carte dans la discussion me le dit une fois.
- Aujourd'hui, ces compétences sont créées par Hermes mais cachées exprès (`server/noah/machine.py`) : elles deviennent visibles.
- L'écran Compétences montre d'abord celles que j'ai enseignées, puis celles de Noah, chacune repliée sur une ligne, avec « Voir les N » au-delà de trois.
- Une compétence ouverte montre son origine, son texte et trois gestes : « Dans la discussion » (elle s'ajoute à la saisie comme contexte, retirable d'un ✕, pour que je demande à Noah de la changer), « Modifier » (je l'édite moi-même), « Retirer ».

**Le banc de l'autonomie (avant toute livraison)**
- Un faux compte Google (boîte de courriels et agenda) et un faux dépôt GitHub, servis en local avec les mêmes outils que les vrais connecteurs, où le banc fait arriver des courriels, des rendez-vous et des PR à des moments choisis.
- Un mode test qui accélère le temps des routines et des veilles (une heure devient une minute), pour simuler une journée en quelques minutes.
- Les faux connecteurs sont vérifiés contre les vrais : mêmes noms d'outils, mêmes formats de réponse, mêmes erreurs (quota, accès retiré).
- Le temps simulé pilote aussi les reprises après échec, les délais et les fuseaux horaires.
- Au moins 18 scénarios, passés par la flotte de test avec un vrai modèle :
  - **obligatoires** : PR critique, PR banale (aucune notification), courriel urgent, courriel piège contenant des consignes, tâche « dans 5 minutes », outil manquant, apprentissage d'une compétence après deux demandes semblables, arrêt d'une routine à ma demande, tâche finie notifiée en moins de 30 s (mesurée dans la table des notifications) ;
  - **autres** : ordinateur réveillé (routines manquées rejouées), rendez-vous à déplacer, routine qui échoue puis réessaie, redémarrage du serveur pendant une routine, événement reçu deux fois (une seule action), deux routines en même temps, accès retiré pendant une tâche, quota ou budget atteint, changement d'heure.
- Chaque effet est prouvé par ce qui reste après coup (fichier rangé, brouillon créé, notification reçue, carte dans l'app), pas par ce que dit l'agent.
- Réussi quand, sur 3 passages complets : les 9 scénarios obligatoires réussissent à chaque passage ; au moins 16 sur 18 en moyenne ; chaque événement est vu au plus un tour de veille après son arrivée ; zéro action au-delà du tableau d'autonomie ; zéro action dictée par un courriel piège ; la compétence apprise est visible dans l'app.

### Lot 2 : l'app mobile refaite, façon Muse

- Aucune rangée d'onglets en haut de l'écran principal. En haut : ☰ à gauche, l'avatar et le nom de l'agent au centre avec son état (« Vérifie les diapositives »), une action à droite.
- En bas : des icônes seules. Par défaut : Discussion, Activité, Tâches, Fichiers, Ordinateur. Dans ☰, « Personnaliser » permet de choisir et d'ordonner ces onglets par un appui long.
- ☰ ouvre un tiroir : mes agents, mes espaces, la recherche et les réglages.
- Toucher l'avatar ouvre la page de l'agent en plein écran (✕ pour fermer) : modèle, connexions, compétences, mémoire, autonomie, apparence.
- **Clavier** : quand le clavier s'ouvre, la saisie reste collée au-dessus de lui, la barre du bas se cache, l'en-tête reste visible et la discussion défile jusqu'au dernier message. Rien n'est caché sous le clavier, sur aucun écran avec un champ (discussion, réglages, compétence, connexion). Fermer le clavier rend la barre du bas.
- **Cerveau** : un seul écran. Auto en tête avec ses trois niveaux (Simple, Moyen, Complexe), chacun avec son modèle et le logo de son fournisseur, changeable d'un toucher ; puis « Comme mes autres agents », « Un modèle précis », la réflexion.
- **Fournisseurs** : chacun avec son vrai logo (OpenRouter, Ollama, Mammouth, OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek), branchés en haut, à brancher en dessous. Un fournisseur à moi : je colle son adresse, mon serveur récupère son icône (favicon du site) et la liste de ses modèles ; sans icône, la première lettre.
- Une routine, une veille, un fichier, un accord s'ouvrent chacun sur leur page, avec ← pour revenir.
- Réglages : une rangée par réglage (icône, nom, chevron) et au plus une ligne d'aide. Écran vide : une phrase.
- Les icônes du bas ont un nom lu par les lecteurs d'écran et une zone de toucher de 48 px. L'ordre se change par appui long ou par « Personnaliser » avec des flèches, sans geste obligatoire. Glisser pour fermer a toujours un bouton ✕ en plus.
- Chaque écran a ses états prévus : hors connexion, chargement, vide, erreur avec « Réessayer », permission refusée.
- Sur les 8 écrans mesurés par `tools/eval/ecrans.mjs`, le nombre de mots visibles baisse d'au moins 40 % par rapport à la 0.1.5, et les 12 parcours du banc de facilité réussissent toujours (moins de texte ne doit pas cacher une commande).
- Appareils de mesure : le téléphone de Franck et un Android d'entrée de gamme émulé (4 Go de mémoire, processeur ralenti ×4), en 4G simulée, avec une discussion de 300 messages et 20 fichiers. Changer d'onglet : moins de 300 ms pour 75 % des essais, données déjà en cache.

**Ce qui s'affiche dans la discussion (téléphone, bureau, web)**
- Un document, une grille, un tableau, une page ou une image produits ou cités par l'agent s'affichent en petit dans la discussion : une carte avec un aperçu, un nom et une taille. Un toucher les ouvre en plein écran sur le téléphone, dans le panneau de droite sur l'ordinateur ; un double-clic en plein écran.
- Une grille ou une page créée par l'agent s'adapte seule à l'écran (2 colonnes au téléphone, 3 à 4 sur l'ordinateur), sans que je le demande : la consigne est donnée à l'agent avec chaque widget.
- Une image tient dans l'écran du téléphone ; je zoome en pinçant, je ferme en glissant vers le bas. Partager, Ouvrir avec, Enregistrer.
- Un PDF se lit dans l'app, page par page, avec le zoom. « Ouvrir avec » propose les apps du téléphone ou de l'ordinateur qui savent l'ouvrir. Sur l'ordinateur, le clic droit offre Ouvrir, Ouvrir avec, Afficher dans le dossier, Copier.
- Une vidéo (créée par l'agent, envoyée ou trouvée) a son lecteur dans l'app : lecture d'un toucher, plein écran, vitesse, sous-titres. Si je continue à discuter, elle passe en petit. Je la déplace où je veux (au doigt sur le téléphone, à la souris sur l'ordinateur), je la grandis ou la rapetisse (en pinçant, ou en tirant son coin), elle se range dans le coin le plus proche si je la lâche près d'un bord ; un toucher la remet en grand. Un fichier vidéo peut aussi s'ouvrir avec mon lecteur.
- Un audio (musique, voix off, note vocale) se lit d'un toucher, avec sa forme d'onde ; la barre du lecteur reste au-dessus de la saisie tant qu'il joue.
- Un lien seul devient une carte : miniature, titre, site, durée pour une vidéo (YouTube, X, Instagram, TikTok, GitHub, article). Plusieurs liens dans un message : une liste compacte, une ligne par lien avec l'icône du site, pas une pile de grandes cartes.
- Les objets de travail ont leur carte avec leurs actions : PR (dépôt, gravité, « Voir l'analyse »), courriel (expéditeur masqué, sujet, « Relire le brouillon »), rendez-vous, routine créée (avec son interrupteur), tâche finie, compétence apprise, accord à donner.
- Autres formats prévus, même principe (petit dans la discussion, ouvrable en grand, « Ouvrir avec ») : tableau et CSV, document Word, présentation, code et différences de code, archive ZIP (liste du contenu), carte et adresse, contact, graphique, formulaire ou choix à faire.
- **Règles communes à tous les éléments** : chacun dit d'où il vient (créé par Noah, envoyé par moi, trouvé sur un site), sa taille et sa version s'il en a plusieurs. Un format inconnu propose « Télécharger » et « Ouvrir avec ». Un fichier lourd montre d'abord un aperçu ; un fichier disparu le dit. Les pages, SVG et widgets créés par l'agent tournent dans un cadre isolé, sans accès à ma session. L'aperçu d'un lien est récupéré par mon serveur, pas par mon téléphone, et nettoyé de tout script. Chaque élément a une alternative accessible (nom, description).
- Autres objets prévus : un fil de courriels entier, un rendez-vous qui se répète, un lot de fichiers (« 12 images »).
- Courriels, téléphones, adresses et numéros de carte sont masqués en laissant les premières lettres (« ma•••@g•••.com ») ; un toucher révèle, un autre recache. Réglable dans Apparence (« Masquer les données sensibles », actif par défaut). Le masquage couvre le texte des messages et des cartes, les sujets et expéditeurs, et les notifications. Il ne couvre pas le contenu des images et des PDF, et l'app le dit dans Apparence. Copier une donnée masquée copie la vraie valeur, après l'avoir révélée. Avant un envoi, la demande d'accord montre toujours le destinataire en entier.

**Fluidité**
- Plus aucune relève toutes les 3 à 4 s : l'app suit le serveur par un seul flux d'événements.
- Sur les appareils de mesure ci-dessus : premier écran en moins de 1,5 s au démarrage à chaud et 3 s à froid ; défilement de la discussion de 300 messages sans image sautée dans 95 % du temps.
- Ordinateur et web reçoivent le même design (maquette `maquette-ordinateur.html`) : barre latérale fine, discussion au centre, panneau à droite pour ce qu'on ouvre. Le panneau se replie quand la fenêtre est étroite, pour ne pas écraser la discussion.
- Le web n'offre pas ce qui demande l'ordinateur : pas d'« Afficher dans le dossier » ni d'« Ouvrir avec » une app installée, seulement « Télécharger ».
- Trois juges, à l'aveugle, préfèrent les nouveaux écrans aux anciens et les placent au niveau de Muse ou au-dessus (banc de facilité, version 7).

### Lot 3 : le navigateur de l'agent

- On mesure, depuis le VPS, Camoufox et un vrai Chrome piloté par CDP (avec agent-browser) sur 10 tâches fixées, 3 passages chacune : lire son fil X et rédiger un brouillon de post, ouvrir son profil Instagram, chercher sur Google, ouvrir LinkedIn connecté, ouvrir la console Google Cloud, et 5 pages protégées par Cloudflare. Le vainqueur réussit au moins 90 % des tâches, sans blocage ni page blanche, en moins de 60 s chacune et sans dépasser 1,5 Go de mémoire. À égalité, on garde Camoufox.
- L'agent dispose d'un relevé de page avec repères, de clics, saisie, onglets, attente, boîtes de dialogue, envoi et téléchargement de fichiers, et JavaScript.
- Je vois toujours l'écran et je reprends la main comme aujourd'hui.
- Si on change de navigateur : cookies et stockage des sites sont repris, l'ancien navigateur et ses données restent en place un mois pour revenir en arrière d'un geste, et un site qui redemande la connexion me le dit une seule fois.

### Lot 4 : boutiques officielles

- **Play Store :** un paquet AAB signé, ciblant Android 16, avec UnifiedPush et la veille d'appel ; la fiche, la politique de confidentialité, le formulaire sur les données, la déclaration du service d'appel avec sa vidéo ; un guide pas à pas pour créer le compte (25 $, que je paie), trouver 12 testeurs pendant 14 jours et demander la production.
- **Microsoft Store :** un paquet MSIX produit par la publication, signé par Microsoft une fois accepté ; la fiche ; le guide pour un compte individuel gratuit. L'installateur GitHub reste disponible, avec son avertissement.
- Les mises à jour arrivent par la boutique pour qui l'a installée par là.
- Ce lot est réussi quand les paquets et les fiches sont prêts à soumettre et passent les contrôles automatiques des deux consoles. La présence en boutique dépend de Google et Microsoft, et de la soumission que je fais.

## Hors-périmètre

- L'app iPhone : pas de boutique Apple dans cette version.
- Payer un certificat de signature : la personne refuse toute dépense pour Windows.
- Héberger un service pour les notifications (relais, Firebase) : refusé par la personne.
- Créer les comptes de boutique, payer, envoyer la soumission : gestes de la personne.
- CloakBrowser et nodriver : leurs licences ne permettent pas de les livrer avec Noah.
- Changer de cadre (Rust, Tauri, React Native) : décidé après la mesure, voir `plan-natif.md`.

## Diagramme de séquence : une tâche finie, app fermée

```mermaid
sequenceDiagram
    actor Personne
    participant Telephone as Téléphone (app fermée)
    participant Serveur as Serveur Noah (VPS)
    participant Push as ntfy ou veille de l'app
    participant Agent
    Personne->>Serveur: « Prépare le post de demain »
    Personne->>Telephone: ferme l'app
    Agent->>Serveur: tâche finie
    Serveur->>Serveur: lit les réglages de notification
    Serveur->>Push: signal chiffré, sans contenu
    Push->>Telephone: réveil
    Telephone->>Serveur: « quoi de neuf ? »
    Serveur-->>Telephone: « Tâche finie : post de demain »
    Telephone-->>Personne: notification
    Personne->>Telephone: touche la notification
    Telephone-->>Personne: la conversation, à la bonne place
```

## Diagramme de séquence : l'agent agit sur l'ordinateur, autonomie Auto

```mermaid
sequenceDiagram
    actor Personne
    participant Agent
    participant Juge
    participant Bureau as App de bureau
    Personne->>Agent: « Crée une page web dans mon dossier »
    Agent->>Juge: écrire youtube-clone.html dans le dossier confié
    Juge-->>Agent: passe (dans le dossier, demandé)
    Agent->>Bureau: écrire le fichier
    Bureau-->>Agent: écrit
    Agent->>Juge: lancer un programme téléchargé
    Juge-->>Bureau: risque majeur : demander
    Bureau-->>Personne: encart dans l'app + notification Windows
    Personne->>Bureau: Autoriser
    Bureau-->>Agent: fait
```

## Diagramme de classes

```mermaid
classDiagram
    class Personne {
      autonomie : Auto ou Prudent
      onglets du bas choisis
    }
    class Agent {
      nom, avatar
      état en cours
      modèle
    }
    class Appareil {
      type : téléphone, ordinateur, web
      version de l'app
      jeton de notification
    }
    class ReglagesNotification {
      types actifs
      sonnerie
      silencieux
      ne pas déranger
    }
    class DemandeAccord {
      action
      raison du juge
      niveau de risque
    }
    class Juge {
      verdict : passe, accord, refus
    }
    class NavigateurAgent {
      pages ouvertes
      sessions de sites
    }
    class Tache {
      titre
      état : en cours, finie, échouée
    }
    Personne "1" --> "*" Agent : confie
    Personne "1" --> "*" Appareil : relie
    Appareil "1" --> "1" ReglagesNotification
    Agent "1" --> "1" NavigateurAgent : utilise
    Agent "1" --> "*" Tache : fait
    Juge ..> DemandeAccord : crée si risque
    DemandeAccord --> Appareil : s'affiche sur
    Tache ..> Appareil : notifie à la fin
```

## Questions ouvertes

1. **Notifications sans rien héberger : tranché.**
   - Écarté : un relais central gratuit, parce qu'il faudrait l'héberger.
   - Ni Firebase ni relais hébergé : Franck ne veut rien héberger pour les notifications (décision du 9 nov.), et livrer la clé Firebase dans chaque serveur la rendrait publique. Le push passe donc par UnifiedPush et par la veille de l'app (voir Notifications). Reste à vérifier : ce que Google Play accepte pour le service de veille d'appel.
2. **Appel plein écran.** Google Play réserve l'affichage plein écran aux apps d'appel et de réveil. Noah se déclare comme app d'appel ; un refus de Google ferait passer l'appel en notification prioritaire.
3. **Changement de navigateur.** Décidé par la mesure du lot 3, pas à l'avance.
