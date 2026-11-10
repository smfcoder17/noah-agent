# Rapport du lot 2 — Noah Agent 0.1.6

Branche : `feat/32-noah-016-lot2-ui`. Aucun envoi ni fusion. Version inchangée.

## Lectures et ordre

Lecture intégrale de `pbi.md`, `architecture.md` (A7–A11, C1–C10, ordre final), `epic.md`, des deux maquettes HTML/CSS et de `plan-natif.md`. Preuves : lectures PowerShell UTF-8 intégrales, complétées par tranches pour les sorties tronquées. Sources lues avant modification. Référence visuelle : couleurs #f6f7f9, #ffffff, #eceff3, #dde2e8, #141b24, #5d6875, #2a47c9 ; police Figtree.

Ordre : #46a, #46b, #44a, #42, #43, #45, #44b, #44c, #46c. Les mesures Docker et captures sont confiées à l'orchestrateur (« Suite 2 »). Relecture GLM 5.3 Flash de chaque diff à effectuer par l'orchestrateur : ce modèle n'est pas accessible ici.

## #46a — Vitest et mesure de référence

Fichiers : `frontend/package.json`, `frontend/package-lock.json` (dépendances installées par l'orchestrateur), `frontend/vitest.config.ts`, `frontend/src/lib/events.test.ts`, `.github/workflows/tests.yml`, `tools/eval/ecrans.mjs`.

Preuves : `npx.cmd --no-install tsc --noEmit` et `npx.cmd --no-install tsc -p tsconfig.app.json --noEmit --incremental false` : code 0, sans sortie. `npx.cmd --no-install vitest run` : 1 fichier, 1 test réussi (accord donné/refusé/expiré), code 0. Vitest 3.2.7, jsdom 26.1.0 et Keyboard 8.0.6 vérifiés dans les dépendances. Aucune installation effectuée ici, aucun changement dans node_modules.

Le banc repart de l'accueil à chaque écran, utilise les libellés 0.1.5 ou lot 2, écrit un JSON daté dans `mesures/` et échoue si un écran manque. Commandes exactes pour l'orchestrateur (PowerShell ; adapter seulement le chemin du module Playwright déjà installé) :

```powershell
$env:NOAH_PLAYWRIGHT = 'C:/chemin/vers/playwright'
$env:BASE = 'http://localhost:8080'
$env:MOBILE = '1'
node tools/eval/ecrans.mjs docs/epics/0.1.6/mesures/015-mobile --reference-015
node tools/eval/ecrans.mjs docs/epics/0.1.6/mesures/lot2-mobile --compare=docs/epics/0.1.6/mesures/015-mobile/ecrans.json
```

Première mesure sur l'application Docker du commit **b12b62f**, avec le script préparé ici (en garder une copie avant le changement de commit). Deuxième sur la présente branche. Refaire sans MOBILE pour le bureau. Aucune baisse de mots n'est encore prouvée. À vérifier : Docker, captures, 12 parcours de facilité et trois juges. Aucun écart visuel introduit par ce prérequis.

## État de la reprise — arrêt pour dépendance Android manquante

**Aucun commit n'a pu être créé.** Preuve : `git add ...` puis `git commit ...` répondent tous deux :

```text
fatal: Unable to create 'D:/Data/Multimedia/SmfCoder/YouTube/apollo/.git/worktrees/apollo-lot2/index.lock': Permission denied
```

Le dossier Git réel du worktree est hors du périmètre autorisé en écriture. Aucun contournement, aucune modification de `.git`, aucun push ni fusion. L'orchestrateur doit permettre les écritures Git ou prendre en charge les commits séparés, avec la signature demandée. #46a est prêt à être isolé dans son commit, mais le rapport ne le présente pas comme commité.

### #46b — flux commun (en cours)

Fichiers : `frontend/src/lib/events.ts`, `events.test.ts`, `useAgentChat.ts`, `useAgentData.ts`, `App.tsx`, `components/Inbox.tsx`, `Handoff.tsx`, `Call.tsx`, `Updates.tsx`, `ConnectorScope.tsx`, `AgentPowers.tsx`, `SidePanel.tsx`, `server/noah/bus.py`, `server/noah/main.py`, `deploy/docker-compose.traefik.yml`.

Un abonnement commun reprend le transport fetch SSE existant des accords (renouvellement Android et Last-Event-ID conservés), un secours commun à 60 s, invalidation sans contenu après les écritures API et pendant/après le travail de l'agent. Les écrans s'abonnent à ce transport. Les chronomètres de sonnerie et d'animation ne sont pas retirés. Caddy a déjà `flush_interval -1` ; ajout du réglage équivalent Traefik. Les onglets du panneau ont déjà `forceMount` dans le code issu du lot 1.

Tests écrits : libellés d'accord et partage d'un seul transport entre deux abonnés, fermeture au dernier départ. Sortie finale : `src/lib/events.test.ts (2 tests)` réussis. TypeScript vert au dernier passage.

**Reste avant de considérer #46b terminé :** raccorder et tester les changements spontanés de tous les producteurs serveur (appels, connexions, mises à jour, état navigateur, veilles/routines), au-delà des écritures API et du flux de travail ; tester le montage unique et la coupure/reprise de dix minutes, vérifier les éventuels doublons de lectures de visibilité. L'App détruit encore le panneau quand on le ferme : conservation globale à réaliser avec les nouvelles coquilles. Python et Docker non exécutés. Aucun écart visuel intentionnel sur ce sous-ticket.

### #44a — registre, cartes, isolation et safefetch (en cours)

Fichiers : `frontend/src/lib/elements.ts`, `elements.test.ts`, `components/elements/ElementCard.tsx`, `ElementViewer.tsx`, `MediaPlayers.tsx`, `SandboxedFrame.tsx`, `components/Viewer.tsx`, `Widgets.tsx`, `server/noah/main.py` (consigne widgets), `server/noah/safefetch.py`, `tests/exposition/safefetch_test.py`.

Registre des formats et noms accessibles, provenance/taille/version, repli inconnu, cartes ouvrables du bloc `noah`, lecture média persistante, déplacement de la petite vidéo et zoom simple d'image. Cadre unique `sandbox="allow-scripts"`, sans accès à la session ; correction des extensions avec paramètres dans `canFrame`. La consigne demande une grille de 2/3–4 colonnes, les métadonnées réelles et les données sensibles en clair pour le futur masquage.

`safefetch` valide toutes les adresses DNS, refuse les plages privées/réservées et identifiants, connecte le socket à l'IP contrôlée, garde SNI pour TLS, revalide les redirections, borne lecture/taille et n'envoie ni cookie ni clé. Tests Python écrits : 127.0.0.1, 169.254.169.254, IPv6, adresses privées, changement DNS et redirection interne. À lancer par l'orchestrateur :

```sh
docker run --rm -v "$PWD:/repo:ro" python:3.12-slim python /repo/tests/exposition/safefetch_test.py
```

Tests front : `src/lib/elements.test.ts (2 tests)` réussis (registre, inconnus, URL actives et cadre isolé).

**Écarts et reste :** aucun CSS des nouveaux éléments n'est encore livré ; apparence et tailles ne correspondent donc pas encore aux maquettes. Les anciens widgets restent affichés directement. Certains formats ont seulement une fiche générique ; actions métier, aperçu lourd, PDF page par page, sous-titres, zoom au pincement, fermeture par glissement et redimensionnement complet restent à faire. Tests Playwright de toutes les cartes et isolation réelle avec cookie à écrire/exécuter. #44a n'est pas terminé.

### #42 — prochain ticket, prérequis manquant

Lecture : sources `App.tsx`, `Sidebar.tsx`, en-tête du panneau, `Settings.tsx`, routines, manifeste Android, manifeste mobile et documentation TypeScript de Keyboard installé dans frontend. Preuve du manque natif : `mobile/package.json` ne déclarait que Capacitor Android, barcode-scanner et core ; `mobile/android/app/capacitor.build.gradle` ne référençait que barcode-scanner.

**Ajout effectué : `@capacitor/keyboard: ^8.0.6` dans `mobile/package.json`.** Aucun paquet installé et aucun fichier généré ni verrou mobile modifié. L'installation frontend fournie par l'orchestrateur ne suffit pas à enregistrer le plugin dans l'application Android. L'orchestrateur doit installer cette dépendance dans `mobile/`, mettre à jour son `package-lock.json` et synchroniser Android avant reprise. Arrêt demandé par la règle sur les paquets manquants.

Navigation mobile, préférences par compte, pile unique, clavier sur quatre écrans et `windowSoftInputMode` restent à réaliser. Aucun test #42 écrit. Écart : interface encore en 0.1.5. Android et captures non vérifiés.

### #43 — non commencé

Aucun fichier ni test spécifique. `tokens.css`, police Figtree locale, coquille ordinateur, rail, panneau de droite, réglages à deux colonnes et tests 1280/1000/800 restent à réaliser. `listenFileMenus` a été lu : il est déjà limité au pont Electron et aux URL de même origine. Écart : design inchangé ; captures et menus Electron non vérifiés.

### #45 — non commencé

Sources `AgentBrain.tsx` et `ProviderLogo.tsx` lues. Aucun changement ni test spécifique. Cerveau sur un écran, fournisseurs/logos, Mammouth local, favicon via safefetch, route d'icône et licences restent à réaliser. Captures non vérifiées.

### #44b et #44c — non commencés

Aucun fichier ni test spécifique. Aperçus de liens côté serveur, nettoyage/cache, masquage sensible et réglage par compte, visionneuses/actions Android et replis web restent à réaliser. Safefetch est préparé en #44a. Aucun résultat Python, Docker, capture ou Android revendiqué.

### #46c — non commencé

Mémorisation, découpage du paquet, script `fluidite.mjs` (300 messages, 20 fichiers, CPU ×4, 4G, 30 changements), mesures avant/après et preuves sur les deux appareils restent à réaliser. Aucun chiffre de performance revendiqué.

## Vérification locale finale avant arrêt

Dans `frontend/` :

```text
npx.cmd --no-install tsc --noEmit
(code 0, aucune sortie)
npx.cmd --no-install tsc -p tsconfig.app.json --noEmit --incremental false
(code 0, aucune sortie)
npx.cmd --no-install vitest run
 RUN v3.2.7
 ✓ src/lib/events.test.ts (2 tests)
 ✓ src/lib/elements.test.ts (2 tests)
 Test Files 2 passed (2)
 Tests 4 passed (4)
```

Un passage intermédiaire avait signalé une prop `loading` absente du cadre : corrigée avant ce passage vert. Les erreurs intermédiaires de montage de l'édition d'App.tsx et du nettoyage de la minuterie d'appel ont également été corrigées. `git diff --check` : code 0. `node --check tools/eval/ecrans.mjs` : code 0. Python local inaccessible et Docker indisponible : les tests Python sont écrits, non exécutés.

**Point exact de reprise :** installer Keyboard dans `mobile/`, résoudre l'accès aux métadonnées Git, isoler/commiter #46a, achever et commiter #46b puis #44a, poursuivre #42, #43, #45, #44b, #44c, #46c. Le lot 2 n'est pas livré.
