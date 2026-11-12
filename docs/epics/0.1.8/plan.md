# Noah Agent 0.1.8 et suivantes : plan

But : un agent pour les tâches de tous les jours, rapide, autonome, prêt dès la création, au niveau de Grok Bot et de Meta Muse en facilité, capacités, UX et textes.

Source : revue du 12 novembre 2026 par huit lecteurs (serveur, agent, lanceur, web, mobile, bureau, presets, état connu), environ 110 constats avec preuve `fichier:ligne`. Le détail est dans [mesures/revue.json](mesures/revue.json). Rien n'y a été exécuté : chaque constat se vérifie dans le code avant d'être corrigé.

## Ce que la revue dit

| Zone | Forces | Ce qui coûte le plus |
|---|---|---|
| Agent | Garde soignée, mode Agir sans carte, routines et veilles, coffre | En mode auto, chaque clic du navigateur demande un accord ; outils MCP de lecture soumis à accord ; `todo` jugé ; aucun preset ; pas de consigne de recherche sourcée |
| Serveur | Run suivi sans client, plafonds, bascule de modèle | Flux d'événements qui lit SQLite 5 fois par seconde et par écran ; fin de réponse retenue jusqu'à 7 s ; pas de reprise du flux ; fichiers sans Range |
| Lanceur | Isolation, mises à jour avec retour arrière | `applications_extra.py` refusé (régression 0.1.7 à confirmer) ; verrou global qui refuse à tort ; 4 Go fixes par conteneur ; journaux sans rotation |
| Web | Jetons groupés par image, panneaux en lazy | Messages reclonés à chaque image ; repères remesurés ; 1,19 Mo de JS au premier écran ; écran vide sans exemple |
| Mobile | Jeton au Keystore, appel natif | Démarrage qui attend le réseau ; impasse « serveur ne répond pas » ; pas de notification sans ntfy ; pas de partage Android |
| Bureau | Sandbox, accords liés par empreinte | Pas de démarrage avec Windows, pas de raccourci, pas de mise à jour ; résultat d'action perdu ; réglages de notifications cassés |

## Catalogue de l'agent (résumé)

Présent : terminal, fichiers, recherche web et X, navigateur piloté, coffre d'identifiants, mémoire, plan de tâche, sous-agents, skills (lire, créer), vision image et vidéo, création d'images, vidéos, musique et voix, routines, routines à condition, veilles, tours « de lui-même », appels et notifications, fils parallèles, demandes entre agents, ordinateur de la personne, Google Workspace, publication Instagram et X, outils MCP, apprentissage.

Partiel : navigateur (accord à chaque clic en auto), MCP (accord sans indication de lecture), achats (paiement laissé à la personne).

Absent : presets d'agent, rappel simple à heure fixe, courriel et agenda hors Google, bibliothèque de skills du quotidien.

## 0.1.8 « Prêt à l'emploi et fluide » (cette session)

Sept lots, un agent de code par lot, fichiers disjoints autant que possible.

| Lot | Contenu | Fini quand |
|---|---|---|
| A. Presets | `server/noah/presets.json` versionné, `GET /api/presets`, preset appliqué à la création (rôle, apparence, compétences, routines suggérées en pause, demandes d'exemple), choix dans le dialogue de création et l'onboarding, écran vide avec demandes à toucher | Un test crée un agent depuis chaque preset ; l'écran vide montre 4 demandes |
| B. Serveur rapide | Flux d'événements réveillé à la publication ; `done` émis avant les réponses à toucher ; client httpx partagé ; liste des agents sans N+1 ; cache des réglages ; en-têtes anti-tampon ; tâches asyncio retenues | Tests du bus et du chat verts ; plus de lecture à 0,2 s au repos |
| C. Autonomie | En auto, les clics de navigation ne demandent plus d'accord (les envois, achats et suppressions oui) ; `todo` hors juge ; MCP de lecture reconnus ; tri qui ne durcit plus sur « vous devez » ; réveil du navigateur qui rend compte ; consigne de recherche sourcée | Corpus du juge vert, sabotages compris ; nouveaux cas ajoutés |
| D. Lanceur | Régression `applications_extra.py` confirmée puis corrigée ; verrou qui attend au lieu de refuser ; mémoire selon la RAM du VPS ; rotation des journaux ; dossiers partagés recréés sans perte ; conteneurs `-ancien` nettoyés | Tests du lanceur verts ; un test couvre la régression |
| E. Web fluide | Messages non reclonés pendant le flux ; repères non remesurés ; `resync` qui garde la réponse en cours ; requêtes en double supprimées ; `content-visibility` ; caches vidés au changement de compte ; textes d'attente et d'erreur ; accessibilité | tsc, vitest et build verts ; tests ajoutés |
| F. Bureau du quotidien | Démarrage avec Windows (réglable) ; raccourci global ; résultat d'action renvoyé après coupure, transferts avec délai ; réglages de notifications ; page de secours ; `config.json` atomique ; zone de notification | Tests `tests/desktop` verts, cas ajoutés |
| G. Mobile | Démarrage sans aller-retour bloquant ; sortie de l'écran « serveur ne répond pas » (réessayer, changer de serveur) ; pas d'éclair clair en sombre ; boucles de fond coupées app cachée ; installateur de mise à jour ; textes d'appairage | Tests `tests/android` et `tests/pairing` verts |

Chaque lot : preuve relue dans le code, changement, test, puis relecture par un second agent qui corrige. Jamais de test affaibli.

## 0.1.9 « Toujours joignable »

- Reprise du flux après une coupure réseau (`/api/conversations/{id}/flux?depuis=n`).
- Fichiers servis en flux avec Range et ETag (vidéos sur iPhone).
- Notifications de fin de tâche sans ntfy, avec actions (répondre, autoriser).
- Partage Android vers Noah (lien, texte, image).
- Bureau : mise à jour automatique, Electron à jour.
- Rappel simple à heure fixe sans réveiller le modèle.
- Portée des accords (« toujours pour ce site »), carte avec cible et montant.
- Briefing du matin intégré, heures actives et budget de notifications.
- Création d'agent non bloquante avec progression ; un seul démarrage d'Hermes.

## 0.2.0 « Au niveau des références, prouvé »

- Vocal : premier son en 1,2 s (2,3 s aujourd'hui), son d'attente pendant le travail.
- Courriel et agenda hors Google (IMAP, CalDAV, Outlook).
- Bibliothèque de skills du quotidien livrée avec Noah, attachée aux presets.
- Parcours J1 à J10 prouvés en conditions réelles (VPS neuf, téléphone, 4G).
- Facilité à 18/20 sur ordinateur et téléphone, banc rejoué.
- Paquets Play Store et Microsoft Store (#48).
- `main.py` découpé par domaine.

## Mesure

- Facilité : `tools/eval/facilite.mjs` (base 16,7 et 15,5 sur 20). A3 « créer un agent » doit gagner avec les presets.
- Rapidité : `docs/perf.md` (première réaction 534 à 861 ms en local).
- Autonomie : corpus du juge (40 sur 40) plus les nouveaux cas du lot C.
- Avant publication : `node scripts/verifier.mjs`, build de l'interface, puis les parcours réels.

## Livré en 0.1.8 (12 novembre)

Sept lots codés en parallèle, chacun relu et corrigé par un second agent, fusionnés sans conflit sur `feat/018`.

- **Lanceur.** La 0.1.7 refusait `applications_extra.py`, donc toute configuration d'agent échouait : corrigé, avec un test qui compare les fichiers envoyés à ceux acceptés. Le verrou attend 30 s au lieu de refuser. Les journaux tournent (10 Mo × 3). La mémoire suit la RAM du serveur, avec des planchers. Changer les dossiers partagés ne détruit plus rien en cas d'échec. Les conteneurs `-ancien` sont nettoyés.
- **Presets.** Six modèles d'agent dans `server/noah/presets.json`, choisis dans la création et l'onboarding. L'écran vide propose quatre demandes à toucher. Le double agent après un échec de couleur est corrigé.
- **Serveur.** Le flux d'événements se réveille à la publication au lieu de lire la base 5 fois par seconde. La réponse se termine avant les choix à toucher. En-têtes anti-tampon. Client HTTP partagé. Tâches de fond retenues. Attente longue des appels sans lecture chaque seconde.
- **Autonomie.** En auto, naviguer, défiler, lire et suivre un lien de navigation ne demandent plus d'accord ; saisies, boutons, envois, achats et suppressions en demandent toujours un. `todo` hors juge. Un « vous devez » dans une page ne durcit plus le tour. Réveil du navigateur borné. Consigne de recherche sourcée.
- **Web.** Les messages ne sont plus recopiés à chaque image. Les repères ne remesurent plus la page. Un resync garde la réponse en cours. Moins de requêtes au démarrage. Caches vidés au changement de compte.
- **Bureau.** Résultat d'action renvoyé avec délai et nouvel essai, sans action exécutée deux fois. `config.json` écrit de façon atomique. Démarrage avec l'ordinateur, réglable, désactivé par défaut. Permissions limitées aux notifications. AltGr+A ne valide plus un accord.
- **Android.** L'écran « Ton serveur ne répond pas » a « Réessayer » et « Changer de serveur ». Démarrage sans échange bloquant en double. Fond sombre au lancement. Boucles de fond arrêtées app cachée, les appels continuent.

### À valider par Franck

- Six presets au lieu de neuf : voyages, coach et bricoleur d'apps restent à écrire.
- Autonomie en auto : une saisie dans le navigateur, même dans un champ de recherche, demande toujours un accord.

### Reporté en 0.1.9

Liste des agents sans N+1, cache des réglages, `content-visibility`, raccourci global, clic sur une notification de bureau, réglage des notifications côté interface, installateur de mise à jour Android, textes d'appairage, verrou par agent, routines des presets créées en pause.
