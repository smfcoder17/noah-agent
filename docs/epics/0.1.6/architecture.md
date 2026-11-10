# Architecture 0.1.6

Rédigée le 2026-11-09 par trois architectes (lecture du code, fichier:ligne vérifiés à cette date), arbitrée ici. Critique : section « Critique et arbitrages finaux ». Référence des critères : [pbi.md](pbi.md).

Rôles d'exécution (décision de Franck) : GPT-6.1 Sol (high, `codex exec`) écrit le code ; GLM 5.3 Flash relit chaque diff ; Claude orchestre et relit après le lot 2.

## Arbitrages sur les écarts relevés

| # | Écart | Décision |
|---|---|---|
| A1 | Pas de flux d'événements global (SSE par tâche seulement, `main.py:2390`) | Un seul bus `server/noah/events.py` + `GET /api/events` (SSE par utilisateur, `Last-Event-ID`, table `evenements` bornée à 5 min, keepalive 15 s), créé en #36, étendu en #46. Sondage de secours à 60 s. |
| A2 | Autonomie « par agent » contre `juge_mode` global (`juge.py:46`) | Par agent, avec repli sur le réglage global : `juge_mode_{agent}`. |
| A3 | Push « sans contenu » alors que `push.py:268` envoie titre et texte chiffrés RFC 8291 | On garde la charge chiffrée de bout en bout : ntfy ne voit que du chiffré, l'invariant 5 tient. Écran verrouillé : `setPublicVersion` selon « Masquer les données sensibles ». |
| A4 | QR interdit en http (`PhonePairing.tsx:176`) alors qu'un ordinateur en LAN est en http | Exception pour les adresses privées (mêmes plages que `desktop/main.js:157`) et Tailscale (100.64.0.0/10). |
| A5 | `task_approval` en mémoire, une entrée par conversation (`main.py:2735`) | Table `accords` persistée (voir #36). |
| A6 | Écrire `.html` : le serveur peut-il lever la garde du bureau ? | Non. L'app de bureau garde sa propre copie du niveau d'autonomie pour l'ordinateur (réglé dans l'app de bureau, jamais par le serveur) et applique la ligne 2 du tableau elle-même. Un serveur compromis ne peut rien élargir. |
| A7 | Ordre des onglets du bas : appareil ou compte | Par compte (synchronisé), réglage serveur. |
| A8 | Clavier Android | Ajouter `@capacitor/keyboard` ; `visualViewport` sur le web. |
| A9 | #44 trop gros | Découpé en #44a (registre, cartes, isolation), #44b (liens, masquage), #44c (natif Android). |
| A10 | Pas de vitest dans `frontend/` | Prérequis du lot 2 : vitest + jsdom, script `test`, étape dans `.github/workflows/tests.yml`. |
| A11 | `ecrans.mjs` cible les anciens libellés | Figer la mesure 0.1.5 avant #42. |
| A12 | Google n'est pas un MCP (HTTP direct, `launcher/agent_admin.py:304-342`) ; GitHub n'a pas de connecteur Noah | Faux googleapis HTTP derrière `NOAH_GOOGLE_BASE` (accepté seulement si `NOAH_BANC=1`) ; faux GitHub = vrai serveur MCP branché par adresse, manifeste `tools/list` figé. |
| A13 | Deux planificateurs (cron d'Hermes dans le conteneur, veilles et proactivité dans Noah) | `server/noah/horloge.py` côté Noah, `libfaketime` dans l'image de test côté Hermes, un seul facteur. |

## Lot 1

### #33 Écran de l'ordinateur
- `SidePanel.tsx` `Computer` (497-612) : `screen-url` lu une fois, URL vide après une erreur (518-528) ; `visible = awake` (547) confond veille et aucune page ; `poll` mappe toute erreur sur « arrêté » (509) ; `screen-url` appelle `take_control` à chaque fois (`main.py:3291`).
- `screen-status` ajoute `etat` ∈ {pret, veille, aucune_page, injoignable} depuis `_browser_diagnosis` (`main.py:3374`).
- `screen-url` mis en cache par agent (`lib/screenCache.ts`) ; iframe montée une fois, masquée hors de l'onglet, mise en lecture seule après 60 s en arrière-plan ; « Écran injoignable » après 2 échecs, réessai 3/6/12 s. Garder le retour en lecture seule du cleanup (G7.7).
- Tests : `tests/exposition/ecran_etats_test.py`, adapter `tests/profiles/profiles_test.py:298-301`, test front de montage unique.

### #34 Juge : un seul tableau
- Hypothèse à prouver d'abord par un test : `date` préfixé (`TZ=… date`, `/bin/date`) est refusé par `_reading_segment` (`agent_plugin:927`), part au juge, et le tour durci le fait demander.
- `juge.py` : table `AUTONOMY` (6 classes = 6 lignes du PBI × Auto/Prudent/Initiative « Me prévenir »), `classify(tool, args)` sur `no_effect`, `tidies_folder`, `must_ask`, `sends_out`. Consultée avant `_ask_model` ; le modèle ne tranche plus que l'écart à la demande. Supprimer `SETTLED_HERE`, `habit_known`, `ASK_WHY`. `surely_local` devient un sous-cas de la ligne 2.
- Ligne 3 : comparaison déterministe (compte, destinataires, texte, pièces jointes) via un champ `exact` dans `Call` (`juge.py:160`) rempli par le plugin ; toute différence demande, avec le diff dans la carte (`_shown_call`, plugin 1178).
- Tests : `tests/tools/juge_test.py` sections « tableau » et « durci » (6 × 3, `date` préfixé) ; `tests/tools/juge_journal_test.py` (20 tâches du journal, sans modèle).

### #35 Bureau sans fenêtre Windows
- `desktop/bandeau.js`, `bandeau.html`, `bandeau-preload.js` : `WebContentsView` en haut de la fenêtre, `loadFile`, `sandbox`, `contextIsolation`, `partition: "bandeau"` sans cookie, tout http(s) bloqué. Texte construit par `actions.js` (`clean()`), clics par `ipcMain.handle("noah:accord")` avec contrôle `senderFrame.url`.
- Usage unique : jeton aléatoire + empreinte sha256 (action, programme, arguments, chemin), expiration `ANSWER_WITHIN` (280 s, `actions.js:16`), empreinte revérifiée juste avant `run()`. Le jeton ne quitte jamais le processus principal.
- `ask()` garde sa signature ; `new Notification` ramène à la fenêtre. Raccourci clavier pour le bandeau.
- Niveau d'autonomie de l'ordinateur gardé par l'app (A6).
- Tests : `tests/desktop/accord_test.mjs` (autre frame refusée, jeton unique, empreinte différente refusée, expiration) ; `tests/desktop/dossiers_test.mjs` : `.html` sans `dialog`.

### #36 Accords synchronisés
- Table `accords(id, user_id, agent_id, conv_id, request_id, generation, run_id, summary_json, state, created, answered_by, answered_at)`, `state` ∈ {attend, donne, refuse, expire, annule} ; remplace `task_approval` ; balayage au démarrage.
- Événements `accord.demande`, `accord.clos {id, par, etat}` sur le bus (A1) ; `GET /api/accords` pour se resynchroniser ; réponse par `UPDATE … WHERE state='attend'` atomique ; `par` = type d'appareil (user-agent) ; expiration 300 s.
- Les accords de bureau y figurent, visibles partout, répondables seulement dans l'app de bureau.
- Garder cohérents `mcp.approval_seen` et `answered` (`mcp.py:1020-1041`).
- Tests : `tests/exposition/accords_sync_test.py` (deux demandes, réponse à la seconde, 2 clients SSE, < 2 s, redémarrage, coupure et rejeu).

### #37 Notifications sans hébergement
- UnifiedPush existe (`NoahPush.java:42-148`, `push.py`, `ntfy.sh` accepté 37-46). Cause du retour : `CallWatch.start` repasse par `onStartCommand` (49-66) et refait `startForeground`. Correctif : drapeau `running`, `startForeground` une fois, `setSilent`, `IMPORTANCE_MIN`.
- « Tâche finie » : vérifier `notifications.py` (`wants`, `saw`) et ajouter l'appel dans la branche `done` (~`main.py:2884`) si besoin ; la conclusion « écran caché » doit tenir app fermée.
- Réglages par type, sonnerie, silencieux, ne pas déranger : `notifications.py` + `NotificationSettings.tsx` + canaux Android par type (`NoahPush.show` 236-239). `NOAH_PUSH_HOSTS` saisissable.
- Tests : invariant 5 (aucun hôte hors liste, charge chiffrée) ; test manuel Android 13 et 14.

### #38 Versions
- `Updates.tsx:71` : `appShell()?.version()` → « Application X · serveur Y ». Numéro monté à 0.1.6 sur décision de Franck (mémoire « version sur demande »). Test `Updates.test.tsx` (web, bureau, Android).

### #39 Ordinateur comme cerveau
- Mode local existant (`desktop/main.js:654-659`, `noah.js:71`), appairage existant (`PhonePairing.tsx:152-204`).
- `server/noah/lan.py` : IP LAN et Tailscale ; `/api/pairing` renvoie cette adresse sans domaine public. mDNS `noah.local` + `NsdManager` côté Android. « Ordinateur éteint » après échec de `/api/health` ; routines manquées rejouées au réveil (à vérifier dans `proactif.py`). Exception QR http (A4). Message d'installation de Docker.
- Tests : `tests/desktop/local_pairing_test.py`, étendre `tests/desktop/appareils_test.py`.

Ordre : #34, #36, #35, #33, #38, #37, #39.

## Lot 1 bis

### #40 Banc de l'autonomie
- `server/noah/horloge.py` (`now`, `sleep`, `local`) ; `NOAH_TEMPS_ACCELERE` ; `POST /api/banc/avancer` seulement en banc. Remplacer `time.time()`/`asyncio.sleep` dans `watch.py` (417, 474, 367, 378), `proactif.py` (553, 618, 637), `apprentissage.py:83`, `relay.spending_refusal`, délais de `mcp._request` (263). Côté Hermes : `libfaketime` dans l'image de test.
- `tests/banc/faux_google.py` (http.server, `/__injecter`, `/__etat`), `tests/banc/faux_github.py` (MCP JSON-RPC, `Mcp-Session-Id`), `tests/banc/manifestes/github.json`, `tests/banc/scenarios/*.json` (16), `tests/banc/banc.py`, `tests/banc/conformite_test.py` ; agrégation `tools/eval/autonomie.mjs --passages 3 --modele <alias>` (réutilise `stats.mjs`, `score.mjs`).
- Preuves : état des faux, fichiers du dossier confié, table des notifications, `messages`, routines. « Zéro action hors tableau » : journal des appels côté faux contre une liste autorisée par scénario.
- Garde : faux jeton jamais vers un vrai hôte ; budget du banc plafonné et suivant l'horloge simulée.
- Ordre : horloge, faux Google, faux GitHub + conformité, 8 scénarios obligatoires, 8 autres, 3 passages réels.

### #41 Compétences apprises visibles
- Hermes écrit `skills/<catégorie>/<nom>/SKILL.md` ; les enseignées sont dans `skills/competences/` (`agent_admin.py:590-597`) ; `competence_list` (650) et `_competence_folder` (627) cachent le reste.
- `competence_list` renvoie `enseignees` et `apprises` (hors skills livrés avec Hermes), avec `origine`, `utilisations`, `cree_a` ; table `competences_apprises(agent_id, nom, cree_a, origine, message_id, utilisations)` remplie par différence de liste avant/après relecture ; usages comptés par `tool.completed` sur `skill_view`. À vérifier dans l'image : ce que porte `skill_usage`.
- Retirer : `skill_manage delete` + mémoire du refus. Modifier par la personne : épinglée, origine « toi ». « Dans la discussion » : côté interface seulement. Carte unique par compétence (`db.set_setting`).
- Sécurité : « Après ta demande » seulement si un message de la personne a déclenché (`_written_by_her`, `apprentissage.py:168`), sinon « origine incertaine » ; scénario courriel piège sans compétence apprise ; motifs refusés à l'écriture dans `check_learning` (URL, `curl|sh`, `inline_shell`).
- Tests : inverser `connecteurs_test.py:501`, invariant 6.

## Lot 2

Ordre : #46a (mesure avant + vitest), #46b (bus + `forceMount`), #44a (en parallèle), #42 (extrait `MobileShell`, `DesktopShell`, `ChatPane` de `App.tsx`), #43, #45, #44b, #44c, #46c (mémorisation, paquet, mesure après).

### #46 Fluidité
- Relèves à remplacer : `App.tsx:407`, `:411` ; `useAgentChat.ts:383` ; `SidePanel.tsx:514` ; `Inbox.tsx:25` ; `AgentPowers.tsx:625`, `:1134` ; `Handoff.tsx:32` ; `Call.tsx:110` ; `Updates.tsx:39` ; `ConnectorScope.tsx:77`. Garder `PhonePairing.tsx:210` et les chronomètres.
- `frontend/src/lib/events.ts` (un seul `EventSource`, `subscribe`, reconnexion) ; `SidePanel.tsx` sans `key={tab}` (80), `forceMount` + `hidden`, onglets visités gardés ; `vite.config.ts` `manualChunks`, écrans en `lazy` ; `React.memo` sur `Sidebar`, `Thread`, lignes de messages, `Files`, `Competences`.
- `tools/eval/fluidite.mjs` : CPU ×4, 4G, 300 messages, 20 fichiers ; démarrage froid/chaud, 30 changements d'onglet (p75), images sautées, taille du paquet, requêtes par minute au repos ; JSON daté, `--compare`.
- Proxys : `flush_interval -1` (Caddy, Traefik).

### #42 Navigation mobile
- `components/mobile/` : `MobileHeader`, `Drawer`, `BottomTabs` (48 px, `aria-label`, appui long + flèches), `CustomizeTabs`, `AgentPage`, `ObjectPage` ; `lib/keyboard.ts` (`useKeyboardInset`, `--kb`) ; `lib/navPrefs.ts` (A7).
- `App.tsx` : `Shell` choisit `MobileShell`/`DesktopShell` (`matchMedia`) ; pile de navigation unique (Retour Android) à la place de `door` (465) et `noahRetour` (329).
- Tests : vitest `navPrefs`, pile ; `ecrans.mjs` réécrit ; clavier émulé sur 4 écrans ; vérifier `windowSoftInputMode`.

### #43 Ordinateur et web
- `components/desktop/` : `SideRail`, `RightPanel`, `SettingsTwoColumns` ; repli sous ~1100 px (chat ≥ 480 px) ; web : « Télécharger » seulement. Tests Playwright 1280/1000/800 px ; vérifier `listenFileMenus` côté Electron.

### #44 Éléments ouvrables
- #44a : `lib/elements.ts` (`ElementSpec`, registre type → Card, Viewer, nom accessible), `components/elements/` (`ElementCard`, `ElementViewer`, `VideoMini`, `AudioBar`) ; extension du bloc ```` ```noah ```` (`Widgets.tsx:24`) avec `{"type":"element","kind":…}` ; consigne de `main.py:1804-1812` complétée (types, grille 2/3-4 colonnes, lien seul sur sa ligne, données sensibles en clair) ; `SandboxedFrame` unique (`allow-scripts` sans `allow-same-origin`) ; `canFrame` (`Viewer.tsx:24`) corrigé.
- #44b : `server/noah/safefetch.py` (garde SSRF partagée avec #45), `server/noah/linkpreview.py` (`POST /api/liens/apercu`, OpenGraph/oEmbed, nettoyage, cache) ; `LinkCard`, `LinkList` ; `lib/sensitive.ts` + `SensitiveText` (courriel, téléphone, carte avec Luhn ; adresses postales non promises) ; réglage `masquer_sensibles`.
- #44c : `NoahShellPlugin.java` `openImage`, `openPdf`, `openWith` (`ACTION_VIEW` + `FileProvider`), `share` ; replis dans `lib/platform.ts`.
- Tests : vitest `sensitive.ts` (faux positifs), registre ; pytest SSRF (127.0.0.1, 169.254.169.254, redirection, DNS rebinding) ; Playwright : chaque carte s'ouvre, widget isolé sans `document.cookie`.

### #45 Cerveau et fournisseurs
- `AgentBrain.tsx` un seul écran ; `ProviderLogo.tsx` `providerLogo(id)` (Mammouth en fichier local `assets/providers/`) ; `components/Providers.tsx` ; `catalog.provider_icon(base_url)` via `safefetch`, stockée, servie par `GET /api/fournisseurs/{id}/icone` ; SVG servi en `<img>` avec CSP sandbox ou converti. Vérifier `licences.mjs`.

## Lots 3 et 4 (conception courte)

- **#47** : `tools/eval/navigateur.mjs` lancé depuis le VPS, 10 tâches × 3 passages, Camoufox contre Chrome par CDP (agent-browser) ; seuils du PBI ; si Chrome gagne : `BROWSER_CDP_URL` au lieu de `cloud_provider: camofox` (`hermes.py:270-283`), portage des routes `/noah` (mode privé, envoi de fichiers, saisie d'identifiants), import `storage_state`, ancien volume gardé un mois.
- **#48** : `mobile/` : `bundleRelease` AAB, cible API 36, déclaration `foregroundServiceType` ; `desktop/` : cible `appx`/MSIX dans electron-builder, electron-updater coupé pour la version Store ; `docs/boutiques.md` : fiches, confidentialité, formulaire données, guides de compte.

## Critique et arbitrages finaux

Relecture de GLM 5.3 Flash le 2026-11-09 (10 points, tous retenus). Ces décisions remplacent ce qui les contredit plus haut.

| # | Point de GLM | Décision |
|---|---|---|
| C1 | A3 contredit le PBI (« signal sans contenu ») | Revenir au PBI : le push est un réveil chiffré sans contenu ; au réveil, `NoahPush.onMessage` demande au serveur ce qu'il y a de neuf (`GET /api/notifications/attente`, jeton de l'appareil) et affiche. Si la demande échoue : « Noah a du nouveau ». A3 est annulé. |
| C2 | #34 : le modèle pourrait se déclarer « exact » | La référence est le texte littéral des messages de la personne, lu par le serveur (`turn.person`), jamais un champ produit par l'agent. Le serveur compare de façon déterministe : texte envoyé contenu mot pour mot (après normalisation des espaces) dans un message d'elle ; compte et destinataires nommés par elle, ou seuls possibles ; aucune pièce jointe qu'elle n'a pas fournie ou désignée. Tout doute demande, avec le diff. |
| C3 | `safefetch` créé après son premier usage | `server/noah/safefetch.py` et ses tests SSRF passent dans #44a. |
| C4 | Banc repoussé en fin de lot 1 | #40 démarre en parallèle du lot 1 : horloge et faux connecteurs d'abord, utiles aussi aux tests de #34 et #39. |
| C5 | Deux mécanismes de temps | Un seul : `libfaketime` dans les conteneurs de test de Noah et d'Hermes, piloté par un fichier d'horodatage commun (`FAKETIME_TIMESTAMP_FILE`) que le banc fait avancer. `horloge.py` et `/api/banc/avancer` sont abandonnés ; seuls les délais réseau de `mcp._request` restent en temps réel. |
| C6 | #41 : différence de listes fragile | Le plugin de l'agent signale chaque `skill_manage` réussi (`tool.completed`) au serveur, qui écrit la ligne de `competences_apprises` avec le message source. Plus de comparaison de listes. |
| C7 | Accords de bureau répondables seulement sur le bureau | Exception de sécurité ajoutée au PBI. Test ajouté à `accord_test.mjs` : le serveur pousse « Auto » vers un bureau réglé « Prudent », le bureau reste Prudent et demande. |
| C8 | « Tâche finie < 30 s » et rejeu au réveil non couverts par le banc | Deux scénarios de plus : « ordinateur réveillé, routines manquées rejouées » et « tâche finie notifiée », mesurés dans la table des notifications en temps simulé. Le banc passe à 18 scénarios, 9 obligatoires. |
| C9 | Rejeu des événements limité à 5 min | Révision monotone par utilisateur : au retour, si le client a un trou, il relit tout (accords, agents, conversations, tâches) puis rouvre le flux. Test de coupure de 10 min. |
| C10 | Ligne 3 du juge sans test d'écart | `juge_test.py` : texte modifié, pièce jointe ajoutée, autre compte, autre destinataire, chacun doit demander et montrer le contenu exact. |

Ordre final : #34 et #40 (horloge, faux connecteurs) en parallèle ; puis #36, #35, #33, #38, #37, #39 ; banc complet ; lot 2 dans l'ordre ci-dessus avec `safefetch` dans #44a.
