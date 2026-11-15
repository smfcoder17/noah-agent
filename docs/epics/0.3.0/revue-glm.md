# Relecture GLM 5.3 Flash des lots fusionnés (sécurité, interface, coffre)

15 novembre 2026. Diff feat/020..feat/030 coupé en 7 parties, chacune relue avec le plan 0.3.0. Brut ci-dessous ; l'état de chaque constat est suivi dans le compte rendu de correction.

## Partie 0

**Aucun defect bloquant détecté ; 3 importants, 2 mineurs.**

1. **desktop/main.js:601 — important (sécurité).** `stayHome` laisse passer toute URL pour laquelle `sameOrigin(url)` est vrai ; si `sameOrigin` compare `new URL(a).origin === new URL(b).origin`, deux URL `file://` ont la même origine « null » → `sameOrigin("file:///…/autre.html") === true` et la restriction au seul `setup.html` (audit Sonnet n°10) est contournée : un fichier local arbitraire peut être chargé dans la fenêtre. Scénario : un lien/incrustation dans une page affichée déclenche `location = "file:///…/coffre.db"`, navigation autorisée. Correction : tester `url.startsWith("file:")` et n'autoriser que l'égalité exacte avec `SETUP_URL`, avant l'appel à `sameOrigin`.

2. **App.tsx:511 — important (lot D1).** `SideRail` n'a pas de prop `showTabs` et `AgentNav` a `showTabs = true` par défaut : à moins que SideRail.tsx (hors diff) ne passe `showTabs={false}`, le sous-menu des options (Discussion par défaut, Fichiers…) reste déplié sous l'agent dans la barre de gauche — D1 « plus de sous-menu sous l'agent dans la barre de gauche » non livré. Correction : passer `showTabs={false}` dans SideRail et un test vitest qui vérifie que la rail ne rend pas les options sur ordinateur.

3. **Files.tsx:249 — important (sécurité).** Le clic sur le nom du fichier ouvre FilePreview sans la garde `image || canFrame(file.path)` qui protégeait l'œil, et ce chemin ne passe plus par `useViewer` : n'importe quel type (HTML, SVG) du workspace peut s'afficher en ligne. Scénario : l'agent enregistre `outputs/piege.html` (contenu téléchargé, non approuvé) ; la personne clique le nom ; si `ElementViewer` n'impose pas un bac à sable pour ce kind, le script s'exécute sur l'origine de l'app (vol des jetons d'API). Correction : appliquer le même garde au bouton-nom ou forcer `sandbox` sans `allow-same-origin` pour tout aperçu en ligne.

4. **Files.tsx:79 — mineur.** Le garde `if (preview)` est placé après `if (!files.length)` : si la liste se vide pendant l'aperçu (suppression par l'agent, rafraîchissement), l'aperçu est remplacé par « Aucun fichier pour l'instant. » sans bouton retour. Correction : tester `preview` avant le garde de liste vide.

5. **AgentPowers.tsx:910 — mineur.** « Retirer » apparaît désormais même quand un identifiant est retenu pour ce site ; `DELETE /sites/{hote}` ne touche que le registre des sessions → l'utilisateur croit révoquer l'accès, mais le remplissage auto (B1) rejoue les identifiants du coffre à la connexion suivante sans accord. Correction : signaler sur la ligne que les identifiants restent dans le Coffre, ou proposer aussi la suppression de l'entrée du coffre.

VERDICT: FAIL

## Partie 1

**Constats (aucun bloquant)**

1. **Session.tsx:34,78 + SidePanel.tsx:115 — important** — `<Session>` est rendu sans `key={agent.id}` (contrairement à `<Files>`) : ouvrir l'aperçu d'un fichier avec l'agent A, puis changer d'agent dans la barre de gauche, panneau ouvert → `preview` garde le `path` de A et `FilePreview` est rendu avec `agentId` = B → contenu de B (ou 404) affiché comme si c'était l'aperçu en cours ; `data` est filtré par agent (`data?.agent === agentId`) mais pas `preview`. Correction : `key={agent.id}` sur `<Session>` et/ou effet qui efface `preview` au changement d'`agentId`.

2. **LoginCard.tsx:31-32 — important** — `chosen` est initialisé une seule fois (`useState(comptes[0]?.id)`) : si `asked` change sans remount du composant (relance serveur après refus d'un identifiant, liste de comptes réduite), le compte refusé reste précoché et renvoyé tel quel en `choix` → rejets en boucle, ou aucune radio cohérente (choix hors liste). Correction : key sur `asked.id` côté parent, ou effet qui réinitialise `chosen` quand `asked.id` change.

3. **Vault.tsx:44,66-68 — important** — le champ Identifiant n'a pas `required: !editing` (contrairement au mot de passe) et le filtre `if (v !== "" || k === "nom")` exclut les champs vides du corps : on peut ajouter un login avec mot de passe seul, sans identifiant → entrée inutilisable qui fait re-demander l'identifiant à chaque connexion, contredisant B1. Correction : `required` sur identifiant (et validation équivalente côté serveur).

4. **Session.tsx:36-48 — mineur** — le sondage toutes les 2 s démarre au montage et ne s'arrête que si l'onglet du navigateur est masqué : KeptTab garde le contenu monté, donc `/api/agents/{id}/session` est interrogé en continu même quand une autre rubrique du panneau est affichée, en rupture du contrat KeptTab (« ses lectures suivent sa visibilité »). Correction : recevoir `shown` et conditionner l'intervalle.

5. **LoginCard.tsx:143-147 — mineur** — `Promise.all` tout-ou-rien dans `SavedLogins.load` : un échec (404/403) sur `/coffre-droit` empêche aussi `setLogins` alors que `/coffre` répondait → la liste des identifiants retenus du propriétaire disparaît entièrement (régression vs rendu précédent). Correction : deux fetchs indépendants avec capture séparée.

6. **Settings.tsx:43 — mineur** — la rubrique Coffre est ajoutée inconditionnellement dans `rubrics()` : un profil non propriétaire ouvre Réglages > Coffre → `GET /api/coffre` en 403 (doute 3 : réservé au propriétaire) → seul un message d'erreur brut s'affiche au lieu de masquer l'onglet. Correction : n'ajouter la rubrique que si `owner`.

Rien de bloquant : les flux critiques (choix de compte, coffre, session) fonctionnent dans les cas nominaux ; les constats ci-dessus sont des régressions de bord.

VERDICT: PASS

## Partie 2

1. **workPanel.ts:61 + WorkPanel.tsx:62 — important** — `panelMax()` est évalué seulement au `change`, jamais au rendu : largeur mémorisée 1000 px sur écran 1920, puis fenêtre réduite à 900 → `style={{width:1000}}` rendu tel quel, `.work-main` (flex:1, min-width:0) collapsé à 0 → conversation invisible, état persistant après rechargement (localStorage). Correction : serrer au rendu (`Math.min(width, panelMax())`) et re-serrer sur resize.

2. **WorkPanel.tsx:26-31 + WorkBar.tsx:52 — important** — focus de retour perdu quand le panneau est ouvert depuis le menu « … » : `before` = l'élément cliqué dans la liste, que `pick` (`setOpen(false)` + `onOpen` dans le même cycle) démonte → `isConnected` false (ou body) → après « Retour » ou Échap, le focus tombe sur body, navigation clavier cassée (lot E2 : tout au clavier). Correction : mémoriser le déclencheur (bouton « … », gardé connected) et lui rendre le focus.

3. **WorkBar.tsx:29-30 — important** — l'icône Détails bascule `onDetails` (ancien volet séparé, `aria-pressed`) au lieu d'ouvrir le panneau de droite ; D1 dit « Elles ouvrent le panneau » et le test « chaque icône ouvre son panneau » échouera pour Détails tant qu'elle pilote un autre volet. Correction : en faire un onglet du panneau ou trancher le scénario D1.

4. **WorkPanel.tsx:48 + workPanel.ts:70 — mineur** — le glissement écrit dans localStorage à chaque `pointermove` (~60×/s, I/O synchrone) → à-coups sur la poignée sur machine chargée. Correction : écrire une fois au `pointerup`.

5. **WorkPanel.tsx:13 + 34-35 — mineur** — `covered()` bloque Échap dès qu'un `[role="dialog"]`/`[role="menu"]`/`.right-panel` existe *n'importe où* dans le document, y compris un élément resté monté mais masqué ; si un tel nœud traîne, Échap devient inopérant et l'utilisateur ne peut fermer le panneau qu'à la souris. Correction : restreindre au test de couverture réelle (éléments visibles au-dessus du panneau).

Rien de bloquant (pas de faille sécurité, pas de perte de données).

VERDICT: PASS

## Partie 3

**Constats**

1. `launcher/launcher.py:570-577` — **important** — Le garde-fou SYSTEM prétend fermer M2 « même sous une racine large ( / ) », mais `_shareable("/var")` et `_shareable("/")` passent : l'alternation `^/(var/run|run|…)(/|$)` ne matche que les chemins exacts, et `SENSITIVE.search("/var")` ne voit rien (le socket n'est pas dans la chaîne). Scénario : SHARE_ROOTS contenant `/`, l'agent demande le dossier `/var` → le montage expose `/var/run/docker.sock` (et `/var/lib/docker`) dans le conteneur. Correction : refuser `/` et `/var` (et tout préfixe dont un descendant est sensible : matcher composant par composant).

2. `launcher/launcher.py:567-577` — **important** — Aucune résolution de liens symboliques (`_norm` = normalisation de chaîne). Scénario : un lien symbolique sous SHARE_ROOTS pointant vers `/etc` ou `/var/run` passe les regex (la chaîne est saine), Docker résout le lien côté hôte au moment du bind → secrets/socket montés dans le conteneur. Correction : `os.path.realpath()` avant les tests SYSTEM/SHARE_ROOTS/SENSITIVE.

3. `launcher/updater.py:64-68` — **mineur (conditionnel)** — Les préfixes ancrés `caddy@`, `nousresearch/hermes-agent@` couvrent uniquement la forme sans tag ni registre. Scénario : un manifeste signé qui écrit `caddy:2-alpine@sha256:…` ou `docker.io/library/caddy@sha256:…` (formes acceptées par `REF`, valides avant) est rejeté par `allowed_ref` → `verify_manifest` lève « manifeste sans empreintes » → plus aucune mise à jour appliquée. Correction : aligner SOURCES sur le format exact des refs publiées, ou comparer le dépôt après normalisation registre/tag.

4. `get.sh:104-105` — **mineur** — Le `fail` dit « relance la même commande », mais la même commande rééchoue à l'identique quand la cause réelle est « aucune version publiée » (et non le réseau) ; l'opt-out `NOAH_DEPUIS_DEPOT=1` n'est mentionné ni dans le message ni ailleurs. Scénario : premier utilisateur avant la première version publiée, `curl … | bash` → échec définitif sans piste. Correction : nommer `NOAH_DEPUIS_DEPOT=1` dans le message et distinguer les deux causes.

5. `server/noah/agent_plugin/__init__.py:1560-1561` — **mineur** — LOGIN_HINT impose désormais `action=save_login` sans mentionner de repli, alors que le lot B (doute 6) fait refuser `save_login` par le plugin pendant une routine (seul `list` puis `fill` y passe). Scénario : routine rencontrant une page de connexion → le modèle suit l'indice, appelle `save_login`, est refusé, boucle ou termine son tour sans carte. Correction : compléter l'indice par « (en routine : `list` puis `fill`) » ou faire précéder l'appel d'office selon le contexte.

Le passage `umask 077`/`chmod 600 .env` de `get.sh` est correct (.env.new aussi en 600 via umask avant le `mv`), `cap_drop`/`pids_limit` dans `launcher.py` ne cassent rien d'établi.

Rien de bloquant démontré dans ce diff.

VERDICT: PASS

## Partie 4

**Relecture `server/noah/coffre.py` (lot B)**

1. **coffre.py, `_ask` ≈l.389-410 — bloquant (sécurité).** L'auto-remplissage (1 seul identifiant, ou 1 seule clé TOTP) se fait **avant** le garde-fou `if choices and row["user_id"] != owner(agent_id): choices = []` (≈l.415). Scénario : agent du propriétaire partagé (`agent_shares`) dont le droit a survécu à la migration (doute 1 : « garde le droit allumé »), invité dans la conversation → `_use_login` tape le mot de passe du propriétaire dans l'onglet que l'invité voit et contrôle, sans aucune carte ni accord ; idem pour le code TOTP du propriétaire (branche `kind == "code"`), qui peut servir à franchir la 2FA du compte du propriétaire. Incohérence interne : à 2 comptes la carte est vide pour l'invité, à 1 compte son secret est saisi. Correction : ne pas auto-remplir si le répondant (`row["user_id"]`) n'est pas `owner(agent_id)` — ouvrir une carte vide — pour les deux branches.

2. **coffre.py, `_after_fill` ≈l.240-248 — mineur (B5).** `sites.verify(agent_id, origin)` est appelé sans savoir qui a répondu ; via `answer_login`, un invité qui se connecte fait basculer le site du propriétaire en « connecté » sur une session qui n'est pas la sienne (« Retirer », `a_reconnecter` fondent alors sur cette session). Correction : propager le user et ne marquer que pour le propriétaire.

3. **coffre.py, `_remember` ≈l.340-355 — mineur.** Coffre plein (`≥ MAX_ITEMS`, 2000) : retourne `""` silencieusement alors que `keep` était vrai → identifiants valides mais jamais retenus, aucun message d'erreur ; `_outcome(saved=False)` demande au modèle de relancer `save_login` → nouvelle carte, boucle. Correction : renvoyer une raison (409 « coffre plein ») ou un distinctif pour que le modèle prévienne au lieu de relancer.

4. **coffre.py, `origin_of` ≈l.97-108 — mineur.** Hôte IPv6 (`http://[::1]:8080`) : `hostname` = `::1`, sans point et ≠ `localhost` → retourne `""` → 400 à l'ajout/édition ; impossible de retenir un identifiant pour un service IPv6 (tests Docker locaux). Correction : accepter les hôtes contenant « : » s'ils forment une adresse IPv6 valide.

5. **coffre.py, `reveal` ≈l.760+ — mineur.** `totp_code(secret["cle"])` sans capture : une clé base32 malformée parvenue en base (import CSV, partie du diff coupée ; sinon via une ligne migrée) lève `binascii.Error` → 500 sur « voir ». `_ask` capture `(ValueError, TypeError)`, pas `reveal`. Correction : même capture, répondre 400/500 propre sans trace de clé.

Points vérifiés sans défaut : scoping par `user_id` de toutes les routes `/api/coffre*` et `_mine` (pas d'IDOR), `_owner_only` correct, masquage à 2 caractères conforme au doute 5, `_failed` purgé par `_sweep` (600 s), ports normalisés dans `same_site`, Luhn/expiration corrects.

La partie `import_csv` du diff étant tronquée, non relue.

VERDICT: FAIL

## Partie 5

**Constats**

1. `server/noah/session.py:45-52` — **important**. Dans `note()`, la fin d'un appel `terminal` dépile `_waiting` FIFO sans comparer l'identifiant d'appel : lançer `terminal background=true` (serveur de dev) puis une commande avant-plan (`ls`) → la complétion de `ls` consomme l'entrée du background ; le vrai proc id qui arrivera plus tard est ignoré → le processus fini reste affiché « en cours » 2 h ; variante : la commande avant-plan **échoue** → `tool.failed` supprime l'entrée du background qui tourne réellement → barre du lot D4 mensongère. Correction : stocker le call id à `tool.started` (`data["id"]`/`call_id`) et n'apparier/dépiler que sur égalité exacte.

2. `server/noah/main.py:1508` (`agent_session`) — **important**. `confided = (await desktop.user_tasks(...))` attend le bureau sans try/except ni délai, sur chaque poll (toutes les 2 s) du propriétaire : bureau éteint → exception → 500 en boucle, le panneau Session du lot D4 est mort tant que le PC est éteint ; bureau lent → la route traîne alors que sa docstring promet qu'elle « n'attend jamais ». Correction : délai court + `except httpx.HTTPError` + valeur de secours/cache, comme pour les routines.

3. `server/noah/main.py:109-113` (middleware) — **important**. La garde de taille ne regarde que `content-length`/`transfer-encoding` : en HTTP/2 (uvicorn/h2), ni l'un ni l'autre n'existe et le contrôle saute → le corps est lu intégralement sur `/api/login`, `/api/setup`, etc. Le correctif « DeepSeek M3 » reste contournable (DoS mémoire sur les routes ouvertes). Correction : compter les octets lus pendant le streaming, ou refuser tout corps sans longueur déclarée sur ces routes.

4. `server/noah/sites.py:74-83` (`verify`/`signed_in`) — **important**. Une page publique du site sans champ de mot de passe (accueil déconnecté, page marketing) suffit à noter `connecte` : l'agent visite `https://site.com` sans aucune session → Connexions affiche « connecté » alors que B5 exige que « la liste dit la vérité ». Correction : exiger un marqueur de session réelle (élément post-login ou cookie de session du site, lu ponctuellement pour ce site seul), sinon état `non_verifie`.

5. `server/noah/session.py:60-64` — **mineur**. `session.run_ended()` n'est appelé qu'en fin normal de `_run`, pas dans un `finally` : déconnexion du client SSE en cours de tour → `_waiting` jamais purgé → entrées `_processes` fantômes affichées jusqu'à 2 h (et fuite des dicts). Correction : `try/finally` autour du tour.

6. `server/noah/main.py:1517-1524` (`_read_routines`) — **mineur**. Seuls `TimeoutError`, `HTTPException`, `httpx.HTTPError` sont attrapés : toute autre erreur (`OSError`, `JSONDecodeError`, `KeyError` dans le traitement de la réponse) tue la tâche en silence, le cache ne se met plus jamais à jour et chaque relecture à 10 s replante. Correction : `except Exception` avec journalisation.

7. `server/noah/sites.py:86-94` (`needs_sign_in`) — **mineur**. La correspondance sur tout le site enregistrable fait trop large : déconnexion d'`accounts.google.com` (ou logout volontaire sur un seul produit) passe tous les hôtes `google.com` enregistrés en `a_reconnecter`, y compris les sessions intactes. Correction : limiter à l'hôte exact ou à une liaison de sous-domaine explicite, pas `site_of`.

8. `server/noah/main.py:110` — **mineur**. `/api/setup/restore` est explicitement exclue de la garde : un corps arbitraire de taille illimitée reste lu en mémoire sans compte sur cette route — le DoS M3 subsiste intact sur cette voie. Correction : limite de taille dédiée contrôlée avant lecture du corps.

Rien de bloquant : la migration `_migrate_logins` et le filtre `relay_path_allowed` tiennent aux scénarios testés (traversée de chemin, `%`, `..`).

VERDICT: FAIL

## Partie 6

**1. updates.py:41-44 — gravité : important.** Le préfixe `ghcr.io/smfcoder17/` autorise **tout** dépôt du namespace, pas seulement ceux de Noah. Scénario : clé de signature volée (menace visée explicitement par le commentaire) + une image compromise au même namespace (cache de build, image de dev, ancien tag — pratique courante sur ghcr) référencée comme `ghcr.io/smfcoder17/noah-dev-cache@sha256:<digest>` dans le manifeste → la source passe, la signature est valide (clé volée), l'image arbitraire est tirée puis lancée avec l'accès Docker de l'hôte. Correction : liste de références exactes par composant (`comp → registry/repo` sans wildcard de namespace), pas de préfixe ouvert.

**2. updates.py:236-238 — gravité : important (régression probable).** Le regex existant accepte un nom contenant `:` (`[a-z0-9./_:-]+`), donc des références avec tag ; le préfixe les casse. Scénario : manifeste légitime signé avec `caddy:2@sha256:abc…` ou `nousresearch/hermes-agent:0.2@sha256:…` → le regex passe mais `startswith("caddy@")`/`"nousresearch/hermes-agent@"` échouent → `verify()` lève « image d'une source inconnue », **toutes les mises à jour (y compris correctifs de sécurité) sont bloquées**. Idem pour les formes canoniques `docker.io/library/caddy@…` ou `index.docker.io/…`. Correction : normaliser la ref (couper un éventuel `:tag` avant le digest) ou aligner les préfixes sur les formes réellement publiées.

**3. updates.py:41-43 — gravité : mineur.** `os.environ.get("NOAH_IMAGE_SOURCES", défaut)` retourne `""` si la variable est définie mais vide (cas d'un fork/document d'hébergement laissant la valeur vide), et `split(",")` sans `strip()` laisse des éléments `" b@"` avec espace → tuple vide ou préfixes inattendus → `startswith` toujours faux → chaque mise à jour refusée en silence (log « source inconnue » pour chaque composant, déni de mise à jour). Correction : fallback sur le défaut si la valeur est vide, `strip()` de chaque entrée, et refus bruyant (raise au démarrage) si la liste résultante est vide.

**4. updates.py:41-44 — gravité : important (couverture F2).** La liste des sources est lue dans l'environnement du conteneur, même surface que `NOAH_UPDATE_KEY` (déjà env). Scénario de l'audit F2 : un attaquant ayant sorti du conteneur (socket Docker) recrée le service avec `NOAH_UPDATE_KEY=<sa clé publique>` et `NOAH_IMAGE_SOURCES=<son registre>`, puis signe son propre manifeste → installation arbitraire ; la nouveauté n'atténue que le vol de clé isolé, pas le contrôle de l'env. Correction : valeurs par défaut non écrasables ou contrôle côté hôte/lanceur, avec test rejoué (critère F3).

Rien de bloquant immédiat (aucune faille exploitable sans clé volée ni accès à l'env), mais les constats 1, 2 et 4 doivent être corrigés avant fusion du lot F.

VERDICT: FAIL

## Suivi des constats (correction du 15 novembre 2026)

Chaque constat vérifié dans le code avant correction. « Corrigé » : avec son test. « Non fondé » : avec la ligne qui le prouve.

| Constat | État | Preuve |
|---|---|---|
| P0 n°1 `sameOrigin` et `file:` | Non fondé | `desktop/main.js:221-227` compare à `origin`, posé seulement l.154 (`noah.start`, http://localhost) et l.200 (adresse validée par `serverOrigin`, l.212-213 : https ou http local) : jamais « null ». Une URL `file:` a l'origine « null » et ne passe donc jamais ; seule l'égalité exacte avec `SETUP_URL` l'admet (l.607). |
| P0 n°2 options sous l'agent dans la barre de gauche | Non fondé | `desktop/SideRail.tsx:45` passe `showTabs={false}` ; test « D5 barre de gauche minimale » (`lot-d-interface.test.tsx`) vérifie qu'aucune option n'est rendue. |
| P0 n°3 HTML ou SVG ouvert par son nom | Non fondé, prouvé par test | `kindOfFile` classe html/htm/svg en `page`, rendue par `SandboxedFrame` (`sandbox="allow-scripts"`, sans `allow-same-origin`) ; le serveur ajoute `Content-Security-Policy: sandbox …` à tout fichier brut (`main.py:3497`). Test « P0n3 » (`lot-d-interface.test.tsx`). |
| P0 n°4 aperçu remplacé par la liste vide | Corrigé | `Files.tsx` teste l'aperçu avant la liste vide ; test « P0n4 ». |
| P0 n°5 « Retirer » et coffre | Corrigé | `BrowserSites` dit que les identifiants restent dans Réglages > Coffre ; test « P0n5 » (`Vault.test.tsx`). |
| P1 n°1 aperçu de session hérité par un autre agent | Corrigé | `key={agent.id}` sur `<Session>` et aperçu rattaché à son agent ; test « P1n1 ». |
| P1 n°2 choix de compte gardé d'une demande à l'autre | Corrigé | `LoginCard` : choix rattaché à `asked.id` et à la liste ; test « P1n2 ». |
| P1 n°3 identifiant facultatif dans le coffre | Corrigé | `required` côté écran, `Saisis l'identifiant.` dans `coffre._validated` et à l'import CSV ; tests « P1n3 » (vitest et `coffre_030_test.py`). |
| P1 n°4 sondage de session en continu | Non fondé | `Session.tsx:41` `if (!active) return;` : `active` vient de `SeenActive`, fourni par `KeptTab` (`SidePanel.tsx:33-39`) selon sa visibilité. |
| P1 n°5 `Promise.all` dans `SavedLogins` | Corrigé | deux lectures indépendantes, liste affichée même si le droit échoue ; test « P1n5 ». |
| P1 n°6 rubrique Coffre pour un non-propriétaire | Non fondé | le coffre est par personne (B2) : `coffre.py:730` `my_vault` ne demande qu'une session (`auth.current_user`), pas de 403. Masquer la rubrique priverait chaque profil de son propre coffre. |
| P2 n°1 largeur non bornée au rendu | Corrigé | `usePanelWidth` borne au rendu et suit `resize` ; test « P2n1 ». |
| P2 n°2 focus perdu depuis le menu « … » | Corrigé | `WorkMenu.pick` rend le focus à « … » avant l'action ; test « P2n2 ». |
| P2 n°3 Détails n'ouvre pas le panneau | Non fondé (choix à confirmer par Franck) | Détails est un interrupteur assumé (`WorkBar.tsx:31`, `aria-pressed`) et le test D1 l'exige (`lot-d-interface.test.tsx`, « les détails sont un interrupteur ») ; le test « chaque icône ouvre son panneau » passe. |
| P2 n°4 écriture à chaque `pointermove` | Corrigé | largeur écrite au relâchement seulement ; test « P2n4 ». |
| P2 n°5 Échap bloqué par une couche masquée | Corrigé | `covered()` ne compte que les couches visibles ; test « P2n5 ». |
| P3 n°1 `/var` et `/` partageables | Corrigé | `_holds_system` refuse tout ancêtre d'un dossier du système, `//` et `.` normalisés ; test « 5b » (`tests/agents/petit_vps_test.py`). |
| P3 n°2 liens symboliques | Limite notée | `securite-audit.md`, « Limites connues » L1 : le lanceur ne voit pas le disque de l'hôte. |
| P3 n°3 `caddy:tag@sha256` refusé (lanceur) | Corrigé | `launcher/updater.py` : dépôts exacts, `:tag` retiré avant comparaison ; contrôlé dans `tests/updates/logic_test.py` (bloc « lanceur »). |
| P3 n°4 message de `get.sh` | Corrigé | 404 et réseau distingués, `NOAH_DEPUIS_DEPOT=1` nommé ; `tests/install/get_admin.sh` (dernier bloc). |
| P3 n°5 indice de connexion en routine | Reporté | le correctif est dans `server/noah/agent_plugin/__init__.py` (LOGIN_HINT l.1560, refus l.702), réservé à un autre agent ; à faire : « en routine : `list` puis `fill` ». Le refus actuel dit déjà de prévenir la personne et de continuer, sans boucle. |
| P4 n°1 remplissage d'office pour un autre profil | Corrigé | `_ask` lit l'auteur de la tâche avant tout : ni identifiant ni code tapé d'office hors du propriétaire, `fill` par handle refusé (`not_owner`) ; test « P4n1 » (`coffre_030_test.py`). |
| P4 n°2 site noté connecté par un autre profil | Corrigé | `_after_fill(user=…)` ne note que pour le propriétaire ; test « P4n2 ». |
| P4 n°3 coffre plein silencieux | Corrigé | `vault_full` et consigne de ne pas relancer, `coffre_plein` à l'écran ; test « P4n3 ». |
| P4 n°4 IPv6 refusé | Corrigé | `origin_of` accepte une IPv6 valide, entre crochets ; test « P4n4 ». |
| P4 n°5 clé TOTP abîmée → 500 | Corrigé | `reveal` répond 422 sans la clé ; test « P4n5 ». |
| P5 n°1 processus appariés FIFO | Corrigé | `session.py` : identifiant d'appel quand Hermes le donne, sinon `proc_…` vs avant-plan ; tests « P5n1 » (`session_test.py`). |
| P5 n°2 `desktop.user_tasks` qui attendrait le bureau | Non fondé | `desktop.py:779-785` ne lit que `_tasks` en mémoire, sans réseau ; l'appelant (`main.agent_session`) ne l'appelle que pour le propriétaire, donc sans son 404. |
| P5 n°3 garde de taille en HTTP/2 | Non fondé | uvicorn (`server/Dockerfile:27`, `uvicorn[standard]`) ne parle que HTTP/1.1 ; Caddy (`deploy/Caddyfile:40`) relaie en HTTP/1.1, avec `Content-Length` ou `Transfer-Encoding: chunked`, et ce dernier sans longueur est refusé (`main.py:122`). |
| P5 n°4 « connecté » sur une page publique | Corrigé (option la plus sûre) | « connecté » seulement après une connexion envoyée par le serveur (`verify(proven=True)`, coffre) ; sur la parole de l'agent : « non vérifié » ; test « P5n4 » (`sites_test.py`). |
| P5 n°5 purge hors `finally` | Corrigé | `session.run_ended` dans le `finally` du tour (`main.py`) ; test « P5n5 » (AST, `session_test.py`). |
| P5 n°6 erreurs non capturées des routines | Corrigé | `except Exception` journalisé, cache remis à jour ; test « P5n6 ». |
| P5 n°7 déconnexion sur tout le site | Corrigé (option la plus sûre) | « à reconnecter » sur l'hôte exact ; autres hôtes du site : « non vérifié » ; test « P5n7 » (`sites_test.py`). |
| P5 n°8 `/api/setup/restore` sans borne | Corrigé | 20 Go (`NOAH_RESTORE_MAX`), annoncée ou comptée pendant la lecture ; compte existant refusé avant le premier octet ; `tests/install/restauration_taille_test.py`. |
| P6 n°1 espace de noms `ghcr.io/smfcoder17/` | Corrigé | dépôts exacts dans `updates.py` et `updater.py` ; `tests/updates/logic_test.py`. |
| P6 n°2 étiquette avant l'empreinte | Corrigé | dépôt comparé sans `:tag`, formes `docker.io/…` admises ; `logic_test.py`. |
| P6 n°3 variable vide ou mal formée | Corrigé | `image_sources` : entrées `strip()`, valeurs par défaut si vide ou mal formée ; `logic_test.py`. |
| P6 n°4 environnement modifiable par qui a le socket | Limite notée | `securite-audit.md`, « Limites connues » L2. |
