# Rapport du lot 2 — Noah Agent 0.1.6

Branche : `feat/32-noah-016-lot2-ui`. Reprise depuis `82f1b45`. Aucun push, aucune fusion, aucune montée de version. Aucun paquet installé, supprimé ou modifié dans les jonctions `node_modules`.

## État exact au terme de cette reprise

Le travail couvre les étapes jusqu'à #46c dans le worktree, avec les vérifications front ci-dessous. **Le lot n'est pas déclaré livré** : aucun nouveau commit n'a pu être créé, les ressources Figtree/Mammouth restent à récupérer, et les vérifications Docker, navigateur et Android restent à exécuter par l'orchestrateur. Certains formats utilisent encore un aperçu de leurs métadonnées, détaillé en #44a.

Deux tentatives de `git add docs/epics/0.1.6/rapport-lot2.md` puis de commit #46a, après l'annonce de rétablissement de l'accès, ont donné exactement :

```text
fatal: Unable to create 'D:/Data/Multimedia/SmfCoder/YouTube/apollo/.git/worktrees/apollo-lot2/index.lock': Permission denied
```

Le dernier commit demeure `82f1b45`, celui de l'orchestrateur. Ni les commits #42–#46, ni un nouveau commit #46a ne sont revendiqués. Aucun déplacement de `.git`, changement de droits, index parallèle ou autre contournement n'a été tenté. Le message de commit essayé se terminait bien par `Co-Authored-By: GPT-6.1 Sol <noreply@openai.com>`.

## Lectures et ordre

Avant modification : lectures PowerShell UTF-8 intégrales de [pbi.md](pbi.md), [architecture.md](architecture.md), [epic.md](epic.md), [plan-natif.md](plan-natif.md), [maquette-mobile.html](maquette-mobile.html) et [maquette-ordinateur.html](maquette-ordinateur.html), puis des sources concernées. Les grandes lectures ont été reprises par tranches quand la sortie était tronquée. Les 27 écrans mobiles et les 6 écrans ordinateur, HTML et CSS, ont été lus. `CONTRIBUTING.md`, les scripts de vérification et la méthode `docs/facilite.md` ont également été lus avant adaptation du banc. Aucune capture du lot réservé n'a été consultée.

Ordre d'architecture utilisé pour la reprise : #46a, #46b, #44a, #42, #43, #45, #44b, #44c, #46c. Les modifications partagées entre étapes ne sont pas encore isolées dans des commits à cause du refus Git. Aucun sous-agent n'a été lancé. La relecture GLM 5.3 Flash prescrite dans l'architecture n'est pas accessible dans cette session : **elle reste à faire**, et aucune approbation de ce modèle n'est revendiquée.

Les Suites 2–4 confient les mesures Docker, les captures et `cap sync` à l'orchestrateur : ces étapes n'ont pas été présentées comme exécutées ici.

## Preuves locales

Commande reproductible, depuis la racine :

```powershell
node tools/eval/verifier-lot2.mjs
```

Elle lance dans `frontend/`, sans installation, et conserve **la sortie complète de chaque commande et son code de retour** dans [mesures/verification-locale.json](mesures/verification-locale.json) :

```text
npx --no-install tsc --noEmit
npx --no-install tsc -p tsconfig.app.json --noEmit --incremental false
npx --no-install tsc -p tsconfig.ui.json --noEmit --incremental false
npx --no-install vitest run
npx --no-install vite build
```

Résultat du dernier passage consigné (2026-11-10T06:35 UTC) : trois vérifications TypeScript sans diagnostic, 13 fichiers / 17 tests Vitest réussis, build Vite réussi. Les cinq codes de retour sont 0. Le JSON est la preuve à consulter pour le dernier passage exact ; il ne contient aucune mesure de fluidité sur appareil.

Les scripts `ecrans.mjs`, `facilite.mjs`, `fluidite.mjs`, `lot2-fixtures.mjs`, `ui-lot2.mjs`, `ressources-lot2.mjs` ont été contrôlés avec `node --check`, code 0. `git diff --check` : code 0 ; avertissements de normalisation CRLF seulement.

Un nouveau cas de masquage a révélé qu'un téléphone voisin d'une carte pouvait empêcher la détection de cette dernière. Correction : recherche de candidats se chevauchant, validation Luhn, puis recherche des téléphones hors des plages déjà reconnues. Le test ajouté est conservé. Un avertissement de découpage circulaire du build a été corrigé en faisant passer les modules assistant-ui avant la règle React dans `manualChunks` ; le build suivant ne signale plus ce cycle.

## #46a — Vitest et mesure de référence A11

Fichiers du socle déjà contenus dans `82f1b45` : `frontend/package.json`, son verrou, `frontend/vitest.config.ts`, `.github/workflows/tests.yml`, `frontend/src/lib/events.test.ts`, `tools/eval/ecrans.mjs`, ainsi que les dépendances Keyboard frontend/mobile installées par l'orchestrateur. Cette reprise ajoute la configuration React des tests et complète le banc.

Preuves : Vitest 3.2.7 utilisé ; script `test` et job `interface` de CI présents ; contrôles TypeScript et Vitest dans le JSON de vérification. Le banc des mots repart de l'accueil à chaque écran, reconnaît les libellés de chaque version et produit `ecrans.json`. Avec `--compare`, il échoue si un écran manque ou si sa baisse de mots est inférieure à 40 %.

**Mesure 0.1.5 non exécutée ici**, conformément à la Suite 2. Commandes exactes pour l'orchestrateur, depuis la racine (adapter seulement le chemin du module Playwright installé) :

```powershell
$env:NOAH_PLAYWRIGHT = 'C:/chemin/vers/playwright'
$env:BASE = 'http://localhost:8080'
$env:MOBILE = '1'
node tools/eval/ecrans.mjs docs/epics/0.1.6/mesures/015-mobile --reference-015
node tools/eval/ecrans.mjs docs/epics/0.1.6/mesures/lot2-mobile --compare=docs/epics/0.1.6/mesures/015-mobile/ecrans.json
```

Première commande avec l'application Docker du commit **b12b62f**, seconde avec celle de cette branche. Garder une copie des scripts de cette branche avant de changer de commit. Refaire avec `Remove-Item Env:MOBILE` et les dossiers `015-bureau` / `lot2-bureau`.

Écart visuel : aucun pour le socle. État : code et tests présents, commit supplémentaire refusé, mesures déléguées.

## #46b — Événements et écrans gardés

Fichiers : `frontend/src/lib/events.ts`, `events.test.ts`, `events.resync.test.ts`, `components/KeepAlive.tsx`, son test, `App.tsx`, `SidePanel.tsx`, les abonnements déjà commencés dans `82f1b45` ; `server/noah/bus.py`, `main.py`, `handoff.py`, `connexion.py`, `mcp.py`, `updates.py`, `watch.py`, `proactif.py` ; réglage Traefik déjà inclus dans le commit de reprise.

Le transport fetch SSE partagé conserve le renouvellement de session Android et `Last-Event-ID`. Il a un secours commun à 60 s et un traitement de visibilité commun. Les changements d'appels, de connexions et de mises à jour, ainsi que les passages de veille, signalent les nouvelles données sans transporter de contenu. Les lectures d'aperçus et les signaux de visibilité ne réinvalident pas toute l'app. L'écran de l'ordinateur utilise le secours commun ; ses réessais après erreur gardent des délais 3/6/12 s. Les chronomètres de sonnerie, d'appairage et d'animation sont gardés.

Tests front réussis : un seul transport pour deux abonnés ; fermeture au dernier départ ; relecture après `resync` avant réouverture ; montage unique et conservation de l'instance d'un écran. Test Python écrit dans `lot2_test.py` : événements âgés de dix minutes, révision monotone, signal sans contenu par compte. Les onglets du panneau restent en `forceMount` et la coquille garde aussi le panneau et la discussion montés.

Reste : exécuter les tests Python, la coupure réelle de dix minutes et la vérification noVNC sur Docker ; contrôler les producteurs de navigateur et de routines sur une installation réelle, au-delà des tests du bus. Aucune mesure de synchronisation en réseau réel n'est revendiquée.

## #44a — Registre, cartes, isolation et safefetch

Fichiers : `lib/elements.ts`, son test ; `components/elements/ElementCard.tsx`, son test, `ElementViewer.tsx`, `MediaPlayers.tsx`, `SandboxedFrame.tsx` ; `Widgets.tsx`, `Viewer.tsx`, `Files.tsx`, `styles/elements.css` ; consigne widgets de `server/noah/main.py` ; `server/noah/safefetch.py`, `tests/exposition/safefetch_test.py`. Les fichiers du début de #44a sont déjà dans `82f1b45`.

Les anciens tableaux, graphiques, grilles et aperçus de fichiers deviennent des cartes. Le registre couvre les 29 types, avec nom accessible, provenance, taille renseignée ou explicitement inconnue, version, ouverture et téléchargement. Les fichiers locaux sont contrôlés à l'ouverture par une lecture bornée demandée avec Range ; une erreur ouvre « Fichier introuvable ». Les fichiers lourds demandent de charger l'aperçu. Le cadre commun conserve exactement `sandbox="allow-scripts"`, sans `allow-same-origin`. Les actions des cartes restent liées à l'agent d'origine, même si la personne navigue vers un autre agent.

La visionneuse propose grille 2/3/4 colonnes, tableau, graphique, texte de code/différences, liste d'archive si fournie, formulaire ou choix. Les objets de travail ont une action de discussion ; routine/veille peuvent être activées avec leur identifiant réel. Le lecteur vidéo conserve le même élément en grand et en petit, avec déplacement, coin de redimensionnement, pincement, rangement au bord, vitesse et piste de sous-titres si fournie. L'audio reste au-dessus de la saisie ; sa forme d'onde est calculée à partir du son, avec limite de 6 Mo.

Tests front réussis : registre et repli inconnu, refus des URL actives, attribut du cadre, ouverture de chaque type, choix du lecteur persistant, routage d'une action vers le bon agent. `ui-lot2.mjs` ajoute les tests navigateur de chaque carte, de conservation de la vidéo et de cookie inaccessible dans le cadre : **écrits et vérifiés syntaxiquement, non exécutés**.

`safefetch` refuse adresses privées, métadonnées, identifiants, DNS mixtes, IPv4 mappées et tunnels IPv6 ; connecte à l'IP contrôlée, conserve SNI, recontrôle chaque redirection et borne lecture/taille. Tests SSRF Python écrits, non exécutés ici.

Écarts et limites : Word et présentations utilisent une fiche et les gestes d'ouverture/téléchargement ; ils ne sont pas convertis en pages dans le navigateur. CSV/code/archive fournis uniquement par fichier, sans données structurées, n'ont pas encore de parseur d'aperçu complet. Le PDF web utilise le lecteur intégré au navigateur dans le cadre : compatibilité à vérifier sur un vrai PDF. La lecture effective des médias et les sous-titres ne sont pas prouvés par le simple test d'ouverture des cartes. Vérifier pincement, déplacement, disparition réelle d'un fichier et lecteurs externes sur appareils.

## #42 — Navigation mobile et clavier

Fichiers : `components/mobile/{MobileHeader,Drawer,BottomTabs,CustomizeTabs,AgentPage,ObjectPage,Approvals}.tsx`, `components/{Shell,ChatPane,KeepAlive}.tsx`, `App.tsx`, `AgentPowers.tsx`, `SidePanel.tsx`, `lib/{navPrefs,navigation,keyboard}.ts` et leurs tests ; `server/noah/ui_preferences.py`, création d'une discussion dans `main.py` ; `mobile/android/app/src/main/AndroidManifest.xml`.

Navigation : icônes seules en bas dans l'ordre Discussion / Activité / Tâches / Fichiers / Ordinateur, noms accessibles et cibles de 48 px ; tiroir agents/discussions/recherche/réglages ; page de l'agent ; pages propres aux routines, veilles et accords ; création effective d'une nouvelle discussion. L'ordre choisi se lit et s'écrit sous le compte via `/api/me/interface`, avec signal de mise à jour aux autres appareils. Appui long ouvre Personnaliser ; flèches et déplacement de lignes permettent l'ordre sans imposer de geste.

Clavier : Keyboard Capacitor chargé à la demande sur Android, `visualViewport` sur le web ; variables `--kb` et `--visible-height`, barre du bas cachée, saisie et champ actif remis à l'écran. `windowSoftInputMode="adjustResize"` évite un double décalage Android.

Tests réussis : validation/déplacement des onglets, pile de navigation, calcul du clavier et quatre montages de champs, compte isolé prévu dans le test Python. Tests des vrais écrans discussion/réglages/compétence/fournisseur dans le banc navigateur : écrits, non exécutés. La synchronisation native reste à l'orchestrateur.

Écarts : le tiroir liste les agents et les discussions ; **la gestion des « espaces » n'est pas implémentée**. L'appui long ouvre l'écran de personnalisation plutôt qu'un déplacement immédiat dans la barre du bas. `Shell` choisit le style mobile/ordinateur via `matchMedia` en conservant le même conteneur pour ne pas détruire une conversation au changement de largeur. La pile couvre les pages de la coquille ; les pages d'objets ferment leur dialogue via Échap/Retour. Captures et Retour Android réel à vérifier.

## #43 — Ordinateur, web et jetons

Fichiers : `components/desktop/{SideRail,RightPanel,SettingsTwoColumns}.tsx`, `Settings.tsx`, `Viewer.tsx`, `styles/{tokens,shell,desktop}.css`, `index.css`, `main.tsx`, `frontend/tests/lot2.{html,tsx}`, `tsconfig.ui.json`, `tools/eval/ui-lot2.mjs`.

Jetons autonomes dans `tokens.css`, sans import : palettes exactes des maquettes, variantes sombres, police, rayons et ombres partagés. Rail de 232 px, discussion centrale, aperçus à droite sur 470 px ; double-clic en plein écran. Sous **1182 px**, le panneau recouvre le contenu au lieu de réduire la discussion sous 480 px (232 + 470 + 480). Réglages ordinateur en deux colonnes, dans la zone à droite du rail. Le web ne propose pas les gestes réservés au système ; `listenFileMenus` reste limité au pont Electron et à la même origine.

Preuves : types de l'app et du banc UI vérifiés ; build sans cycle de chunks ; banc Playwright 1280/1000/800 écrit, à exécuter. Aucun résultat de capture n'est inventé.

Écart important : **Figtree n'est pas encore embarquée**. Le chargement local est prêt mais utilise actuellement le repli Segoe UI/système. `curl.exe` vers GitHub a répondu `Failed to connect ... port 443`; voir la préparation des ressources ci-dessous. Les anciennes fonctions secondaires gardent encore une partie de leur présentation antérieure ; la fidélité de l'ensemble des 33 maquettes n'est donc pas certifiée. Les captures clair/sombre et les menus Electron restent à vérifier.

## #45 — Cerveau et fournisseurs

Fichiers : `AgentBrain.tsx`, son test, `Providers.tsx`, `ProviderLogo.tsx`, `Settings.tsx`, `styles/privacy.css` ; `server/noah/{providers,catalog,hermes,modes,relay,main}.py` ; test Python `lot2_test.py`.

Auto et les trois niveaux Simple/Moyen/Complexe, logos, « Comme mes autres agents », « Un modèle précis » et réflexion sur le même écran. Fournisseurs branchés et à brancher ; adresse et clé saisies dans l'interface, jamais lues dans la conversation. Clés de fournisseurs conservées chiffrées ; réutilisation seulement pour leur adresse. Icône personnalisée récupérée par `catalog.provider_icon` via safefetch, conservée et servie par `/api/fournisseurs/{id}/icone`, SVG isolé par CSP. Mistral et DeepSeek ont leur entrée et leur adresse directe ; modèles lus dans leur catalogue.

Tests réussis : écran Cerveau avec ses trois choix et trois logos. Tests Python écrits : clé chiffrée, refus d'un membre, absence de clé dans la réponse et favicon privé refusé. Appels réels aux fournisseurs non effectués.

Logos des fournisseurs existants : bibliothèque LobeHub installée, MIT. **Le logo officiel Mammouth local reste à récupérer** : repli sur l'initiale en attendant, pas de faux logo dessiné. Source officielle : [kit Mammouth](https://info.mammouth.ai/docs/branding-kit/). Adresses vérifiées contre les docs officielles [Mistral](https://docs.mistral.ai/api/endpoint/models) et [DeepSeek](https://api-docs.deepseek.com/).

`tools/eval/licences.mjs` a été lu ; son inventaire serveur nécessite Docker et reste à lancer. Sources et licence de la police seront enregistrées par le script de ressources.

## #44b — Liens et masquage

Fichiers : `server/noah/{linkpreview,sensitive,ui_preferences,push}.py`, `main.py` ; `lib/sensitive.ts`, son test ; `SensitiveText.tsx`, son test, `Appearance.tsx`, `LinkCard.tsx`, `Thread.tsx`, `styles/{privacy,links}.css` ; version publique générique des notifications Android.

OpenGraph et oEmbed lus par le serveur sans cookie, texte nettoyé, jamais de HTML oEmbed envoyé au client ; miniature/favicon relayés sur Noah, caches bornés. Un lien seul a sa carte, plusieurs liens une liste. Le serveur refuse les cibles privées via safefetch. Courriels, téléphones et cartes Luhn sont masqués par défaut, révélables et recachables. La copie d'une réponse contenant encore des valeurs masquées est bloquée avec une explication. Les accords montrent leurs destinataires en entier. Le réglage est par compte et couvre aussi le texte des notifications.

Tests réussis : Luhn, faux positifs (date/prix/version/identifiant), téléphone voisin d'une carte, révélation/recachage sans vraie valeur dans le DOM masqué. Tests Python écrits : nettoyage des scripts, oEmbed sans HTML, cache, relais d'image, cible privée et notifications. Ils restent à lancer.

Écarts : adresses postales non promises, suivant la section #44b de l'architecture ; images/PDF/code non masqués, indiqué dans Apparence. Les graphiques et certaines anciennes fonctions secondaires ne bénéficient pas encore d'un masquage exhaustif de tous leurs libellés. Les expéditeurs/sujets des nouvelles cartes sont traités, mais un contrôle transversal de toutes les anciennes listes et de tous les canaux de notification reste nécessaire.

## #44c — Android et replis

Fichiers : `NoahShellPlugin.java`, `NoahMedia.java`, `ElementActivity.java`, manifeste Android ; `MediaPolicyTest.java` ; `lib/platform.ts`, `Viewer.tsx`, `ElementViewer.tsx`.

`openImage`, `openPdf`, `openWith`, `share` : téléchargement borné dans le cache privé, origine et port du serveur contrôlés, redirections refusées, jeton envoyé uniquement au serveur relié. FileProvider et permission temporaire de lecture pour l'app choisie. Image avec zoom/pan, PDF par pages avec zoom, partage et enregistrement ; absence d'app externe signalée. Les anciens APK reviennent à la visionneuse web si le pont manque. Le web conserve Télécharger.

Écart : utilisation de **PdfRenderer d'Android**, déjà disponible, au lieu d'ajouter Jetpack PDF proposé dans `plan-natif.md` ; aucun nouveau paquet Gradle n'a été ajouté. Pas d'extraction de texte PDF pour lecteur d'écran. Compilation Java, JUnit et essais réels non exécutés ici.

Commandes à lancer par l'orchestrateur :

```powershell
cd mobile
npx cap sync android
cd android
.\gradlew.bat testDebugUnitTest --tests agent.noah.mobile.MediaPolicyTest
.\gradlew.bat assembleDebug
```

Vérifier aussi permission refusée, PDF/image introuvable ou volumineux, absence d'app compatible, changement d'orientation, partage et retour d'une app externe.

## #46c — Mémorisation, paquet et mesure après

Fichiers : `Sidebar.tsx`, `Thread.tsx` (fil et lignes), `Files.tsx`, `Competences.tsx` mémorisés ; `App.tsx` et `Viewer.tsx` chargent les écrans à la demande ; `vite.config.ts` découpe React, conversation, Markdown et icônes ; `tools/eval/{fluidite,lot2-fixtures,verifier-lot2}.mjs`.

Preuves locales : tests de conservation d'instance, build réussi avec chunks séparés ; tailles exactes de tous les fichiers dans la sortie du build consignée. Le fichier d'entrée reste de l'ordre de **306 Ko bruts / 100 Ko gzip**, auquel s'ajoutent React, conversation, Markdown et les icônes. Ce n'est **pas** une preuve de gain de démarrage par rapport à la 0.1.5.

`fluidite.mjs` impose CPU ×4, 4G 1,6 Mb/s / 80 ms, 300 messages et 20 fichiers ; contrôle leur présence effective ; prépare les écrans visités, mesure 30 changements (p75), défilement sur 5 s, démarrage froid/chaud, repos pendant 60 s et poids JS/gzip. JSON daté et `--compare`. Les données API sont simulées et constantes ; les fichiers de l'interface sont réels. **Ce banc n'est pas un test de bout en bout du serveur.** Il n'invente pas une RAM de 4 Go : celle-ci doit être réglée dans l'émulateur et est consignée quand le navigateur l'expose.

Commandes depuis la racine (Playwright installé à fournir dans l'environnement) :

```powershell
$env:NOAH_PLAYWRIGHT = 'C:/chemin/vers/playwright'
$env:BASE = 'http://localhost:8080'
$env:MOBILE = '1'
node tools/eval/fluidite.mjs docs/epics/0.1.6/mesures/fluidite-015 --reference-015 --device=emulateur-4go
node tools/eval/fluidite.mjs docs/epics/0.1.6/mesures/fluidite-lot2 --device=emulateur-4go --compare=docs/epics/0.1.6/mesures/fluidite-015/fluidite.json
```

Comme A11 : première application au commit b12b62f, seconde sur cette branche, scripts de cette branche conservés à part. Pour le téléphone de Franck : un profil de test exposé par `adb`, `NOAH_CDP=http://127.0.0.1:9222`, `--device=telephone-franck`. Ne pas viser un navigateur personnel chargé d'autres onglets. Refaire sur ordinateur sans MOBILE.

Aucun seuil (<300 ms, 1,5/3 s, 95 % sans saut) n'est déclaré atteint. Les deux appareils, avant/après et réseau réel restent à mesurer.

## Commandes de reprise de l'orchestrateur

1. Rétablir l'écriture effective Git, puis isoler les commits par ticket avec la signature demandée. Les dépendances et le premier socle sont déjà dans 82f1b45 ; les modifications de cette reprise sont toutes dans le worktree. Relecture GLM de chaque diff, puis Claude selon l'architecture.
2. Préparer les deux ressources officielles (sans paquet supplémentaire), puis refaire le build et vérifier leur rendu :

```powershell
node tools/eval/ressources-lot2.mjs
node tools/eval/verifier-lot2.mjs
```

3. Tests serveur et SSRF, ajoutés également à la CI :

```sh
docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/safefetch_test.py && python /repo/tests/exposition/lot2_test.py"
```

4. Banc de cartes, isolation, largeurs et clavier : lancer Vite avec `npx vite --host 127.0.0.1` dans `frontend/`, puis depuis la racine :

```powershell
$env:BASE = 'http://localhost:5173'
node tools/eval/ui-lot2.mjs docs/epics/0.1.6/mesures/ui-lot2
```

Le banc utilise les vrais composants avec des réponses API simulées. Il vérifie l'ouverture, pas la décodabilité effective de tous les fichiers multimédias. Les tests et captures ne sont pas intégrés aux fichiers de production.

5. Sur une installation de test avec modèle, les 12 parcours, puis les trois juges de la méthode de facilité :

```powershell
$env:BASE = 'http://localhost:8080'
$env:MOBILE = '1'
node tools/eval/facilite.mjs docs/epics/0.1.6/mesures/facilite-lot2 A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,R1
```

Ce banc envoie réellement des demandes au modèle pour A1/A2/A5 ; il faut une installation et un budget de test. Répéter sur ordinateur. Exécuter aussi `node tools/eval/licences.mjs` et la suite `node scripts/verifier.mjs` avec Docker ; elles n'ont pas été présentées comme exécutées ici.

**Point exact de reprise :** vérifications front consignées, code jusqu'à #46c présent mais non commité ; récupérer Figtree/Mammouth, exécuter Docker/Playwright/Android et les mesures, corriger les limites décrites, faire relire et créer les commits séparés. Le contrôle de `git diff --name-only` contre tous les chemins interdits est passé, sans correspondance ; vérifier encore la liste Git avant les commits. Le lot 2 reste ouvert.
