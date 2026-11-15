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
