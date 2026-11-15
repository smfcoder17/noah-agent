# Audit de sécurité 0.3.0 (15 novembre 2026)

Trois agents indépendants, en local, sur feat/020. Chaque constat est repris ici avec son état. Corrections : lot F du plan.

## Kimi K3 : infrastructure et isolation

Réponse courte : depuis Internet, sans compte ni clé, aucun chemin d'entrée trouvé. Le point faible est le réseau Docker plat et la clé du lanceur qui y circule en clair.

| # | Gravité | Constat | Où | Correction | État |
|---|---|---|---|---|---|
| E1 | Élevé | Navigateur sans cap_drop (garde NET_RAW) sur le réseau plat noah-net : après une faille du navigateur, écoute de la clé du lanceur en clair, puis /restore, suppression d'agents, code écrit dans un agent | launcher.py:263-275, hermes.py:17,50-51 | cap_drop ALL au navigateur ; réseau interne pour serveur et lanceur ; clé du lanceur renouvelée au démarrage | **corrigé** (branche `fix/030-securite`), voir « E1 et M5 : ce qui a été fait » ; `tests/exposition/isolement_test.py`, `isolement_reel.mjs` |
| E2 | Élevé | get.sh se replie sur le compose de main et tire `:stable` sans vérifier de signature | get.sh:98-106,130-131 | version figée par digest, pas de repli sur main | à faire |
| M1 | Moyen | Réseau plat : agents et navigateurs joignent tous les services | launcher.py:264 | réseaux séparés, ICC coupé | **en partie** : agents et navigateurs sur `noah-agents`, sans le lanceur ni Caddy (E1). ICC non coupé : un agent parle à son navigateur sur ce réseau ; entre agents, seule la clé de chaque service protège |
| M2 | Moyen | Mot de passe VNC de 32 bits | hermes.py:105-106 | 16 caractères aléatoires | à faire |
| M3 | Moyen | Mot de passe admin provisoire en 644 dans .env | get.sh:123-127 | umask 077 | à faire |
| M4 | Moyen | Manifeste : n'importe quel dépôt d'image accepté, clé sans rotation | updater.py:63, updates.py:231 | liste blanche des dépôts | à faire |
| M5 | Moyen | Clé du lanceur jamais renouvelée | config.py:12 | rotation | **corrigé par une commande** : `docker exec noah-server python -m noah.cle_lanceur` ; voir « E1 et M5 » ; `tests/secrets/cle_lanceur_test.py`, `isolement_reel.mjs` |
| M6 | Moyen | Le lanceur ne vérifie pas « aucun compte » avant /restore | launcher.py:959-972 | refus si comptes présents | à faire |
| M7 | Moyen | Sauvegardes non chiffrées contenant la clé maîtresse | installation.md, SECURITY.md:27 | phrase de passe | à faire |
| M8 | Moyen | Pas de pids_limit | launcher.py:234-275,661-679 | pids_limit 512 | à faire |
| M9 | Moyen | Lanceur root avec socket en écriture (connu) | launcher/Dockerfile:13 | proxy à liste blanche | noté |
| M10 | Moyen | Passerelle Docker vers les services de l'hôte | — | règle DOCKER-USER (doc) | à faire |
| F1-F12 | Faible | voir rapport : tar sans contrôle, liens symboliques, /api/status bavard, images non épinglées, etc. | — | — | à trier |

## Sonnet : l'agent comme vecteur, juge, secrets, app de bureau

Réponse courte : un inconnu n'entre pas par ces voies. Le risque réel passe par l'agent : une page, un mail ou un fichier piégé peut lui faire sortir ce qu'il a lu.

| # | Gravité | Constat | Où | Correction | État |
|---|---|---|---|---|---|
| 1 | Élevé | Fuite par simple lecture : chemin ou sous-domaine d'une adresse jamais bornés, même tour durci (`browser_navigate`, `web_extract`, `curl` GET) | agent_plugin/__init__.py:1085, 784-787, 984-1030 ; juge.py:52-53 | tour durci : accord pour tout hôte absent des messages de la personne ; bornes sur chemin et hôte | lot C |
| 2 | Élevé | Le relais ouvrait toute route du fournisseur avec la clé du propriétaire (`../`, toute méthode) | relay.py:491-503 | liste blanche des routes, refus de `..` et `%` | **corrigé**, `tests/exposition/relais_chemins_test.py` |
| 3 | Moyen | Tri des entrées : un texte court sans motif anglais ou français n'est jamais vu par le modèle de tri | agent_plugin/__init__.py:1417-1431,1609 | envoyer au tri tout contenu de dehors au-delà de N caractères | lot C |
| 4 | Élevé sous condition | Tâche Claude Code « complet » sans fenêtre quand le PC est en Auto | desktop/actions.js:383 | fenêtre toujours pour le profil « complet » | **corrigé** : le bandeau local demande toujours pour « complet », même en Auto (`actions.js`, `claudeTask`) ; `tests/desktop/claude_test.mjs` (« Sonnet n°4 ») |
| 5 | Moyen | Carte d'accord : ne décrit que la première ligne d'une commande, détails coupés à 600 caractères | mcp.py:993-995 ; agent_plugin:1639-1643 | décrire toutes les lignes ou refuser au-delà | lot C |
| 6 | Moyen | Secrets de la machine de l'agent protégés par regex (glob, concaténation passent) | agent_plugin:747-756,906-921 | jeton illisible du processus piloté par le modèle | lot C |
| 7 | Moyen, opt-in | PC en Auto : écriture sans carte de `.bat`, `.ps1`, profils, démarrage | desktop/actions.js:442-453 | refus d'office de ces emplacements | **corrigé** : en Auto, écrire ou renommer en `.bat`, `.cmd`, `.ps1`, `.vbs`, `.lnk`, `.url`, ou tout fichier d'un dossier de démarrage (Windows `Start Menu\Programs\Startup`, `~/.config/autostart`, `~/Library/LaunchAgents`) est refusé ; en Prudent, la carte le montre (`dossiers.startsByItself`) ; `tests/desktop/dossiers_test.mjs` (« Sonnet n°7 ») |
| 8 | Faible | Un 422 recopiait la valeur envoyée (jeton collé) | connecteurs_cles.py:56-60 | gestionnaire global sans `input` | **corrigé**, même test |
| 9 | Faible | Clés collées dans le chat non masquées | sensitive.py | masque par forme de clé | lot C (C4) |
| 10 | Faible | `fromSetup` acceptait tout `setup.html` du disque | desktop/main.js:817,602 | chemin exact du fichier de l'app | **corrigé** |
| 11 | Faible | Publication X : `client_id` choisi par l'agent | mcp.py:874-891 | `client_id` fixé par le serveur | à faire |
| 12 | Faible | SECURITY.md surestime le chiffrement des jetons d'outils | SECURITY.md:23 | corriger le texte | à faire |

## DeepSeek : web, authentification, isolation entre profils

Réponse courte : personne de l'extérieur n'a obtenu de droits, ni accès au conteneur. 43 routes du propriétaire refusées à un invité, pas de CSRF, pas de SSRF, aucun secret dans les réponses, non-indexation sur toutes les routes.

| # | Gravité | Constat | Où | Correction | État |
|---|---|---|---|---|---|
| M1 | Moyen | uvicorn croit X-Forwarded-For de tout conteneur de 10/8 et 172.16/12 : un agent compromis choisit son adresse et contourne une partie du verrou de connexion | server/Dockerfile:27 ; main.py:386,1156-1178 | ne croire que Caddy (réseau d'entrée séparé), avec E1 | **corrigé** : plus de `--forwarded-allow-ips` sur les plages privées ; `noah/proxies.py` ne croit X-Forwarded-For et X-Forwarded-Proto que des adresses de `NOAH_TRUSTED_PROXIES` (`noah-caddy` ; `traefik` derrière Traefik) et de la boucle locale ; `tests/exposition/proxies_test.py` (un appel direct depuis 172.30/10/192.168/172.16 garde son adresse) |
| M2 | Moyen, conditionnel | Racine de partage « / » : le socket Docker devient partageable | launcher.py:538-590 | liste de refus (/var/run, /run, /proc, /sys, /dev, /etc, /var/lib/docker, « / ») | **corrigé** |
| M3 | Moyen | Aucune limite de taille de corps sur les routes sans compte | Dockerfile:27 ; Caddyfile | 1 Mo sur les routes sans session | **corrigé** |
| F1 | Faible | Surrogate Unicode : erreur 500 sans compte | main.py:641 | rejet propre | à faire |
| F2 | Faible | 422 recopie la valeur saisie | — | voir Sonnet n°8 | **corrigé** |
| F3 | Faible | Mot de passe de départ d'un profil non marqué provisoire | profiles.py:66 | `temporary=True` | **corrigé** |
| F4 | Faible | Verrous de connexion en mémoire, remis à zéro au redémarrage | main.py:457,791,920 | persister | à faire |
| F5 | Faible | CSRF comparé au Host reçu | main.py:84-101 | comparer à NOAH_DOMAIN | à faire |
| F6-F8 | Faible | Appairage : GET qui modifie l'état, verrou global des codes courts ; réglages média modifiables par l'agent | main.py:520-669, 4228-4255 | voir rapport | à faire |

## E1 et M5 : ce qui a été fait (branche `fix/030-securite`)

**Réseaux.** Agents et navigateurs sont sur `noah-agents`, un réseau que le lanceur crée et tient (`launcher._ensure_agents_network`). Le serveur y est branché sous le nom `noah-server` (une veille le rebranche toutes les 15 s si `docker compose up` l'a recréé). Le lanceur n'y est jamais : un agent ou un navigateur ne le joint ni par son nom ni par son adresse. `noah-net` garde Caddy, le serveur et le lanceur. Un fichier d'avant (`AGENT_NETWORK: noah-net`, gardé par une mise à jour) donne aussi `noah-agents`. Au démarrage, le lanceur déplace les agents et navigateurs existants sans les redémarrer.

**Le lanceur ne répond qu'au serveur.** Avec `NOAH_LANCEUR_CLIENTS: noah-server` (les trois fichiers Compose), toute requête qui ne vient pas d'une adresse du serveur, du relais des mises à jour ou de la boucle locale reçoit 403, même avec la clé. Caddy partage encore `noah-net` avec le lanceur : l'outil de mise à jour contrôle Caddy par ce réseau. Il reçoit 403.

**Capacités.** `cap_drop: ALL` et `no-new-privileges` pour les agents et les navigateurs, puis seulement ce que l'essai a prouvé nécessaire :

| Conteneur | Rendu | Preuve |
|---|---|---|
| Agent (Hermes) | `SETUID`, `SETGID` | sans elles, `s6-applyuidgid: fatal: unable to set supplementary group list: Operation not permitted`, le conteneur s'arrête |
| | `CHOWN` | sans elle, `could not chown /run/s6-rc/servicedirs/...`, le conteneur s'arrête |
| | `DAC_OVERRIDE` | sans elle, `could not create /opt/data/.env` et `s6-svlisten: ... Permission denied` : la passerelle ne démarre pas |
| | `KILL` | sans elle, `docker stop` attend 15 s puis tue (code 137) ; avec elle, arrêt propre en 3 s (code 0) |
| | (pas `FOWNER`) | démarrage et `apt-get install jq` réussis sans elle |
| Navigateur (Camoufox) | aucune | onglet ouvert sur une page, `document.title` lu, x11vnc lancé, avec `cap_drop: ALL` seul. L'arrêt dure 20 s puis code 137, avec ou sans capacités : déjà le cas avant, hors de ce constat |

Un agent existant sans `cap_drop: ALL` est recréé une fois au démarrage du lanceur, sur la même image, avec son volume et son jeton (comme la migration du jeton) ; s'il ne répond pas, l'ancien revient. Les navigateurs sont recréés à leur prochaine ouverture (`BROWSER_VERSION` 19). La santé des agents et des navigateurs se lit dans leur conteneur (`curl 127.0.0.1`), puisque le lanceur n'est plus sur leur réseau (`updater._answers_inside`).

**M5, clé du lanceur.** `docker exec noah-server python -m noah.cle_lanceur` tire une nouvelle clé et la remplace dans `noah-secrets/noah.json`, d'un seul coup (fichier relu avant de remplacer, 600) ; la clé maîtresse et le code d'installation ne bougent pas. Le lanceur relit le fichier quand sa date change : il prend la nouvelle clé sans redémarrer et refuse l'ancienne. Le serveur redémarre seul pour la prendre. Pas de rotation automatique à chaque démarrage : pendant une mise à jour, un serveur neuf aurait changé la clé devant un lanceur ancien qui ne relit pas le fichier, et ils ne se parleraient plus. Une clé fixée dans `.env` (install.sh) ne change pas par cette commande : elle le dit.

**Preuves.** `tests/exposition/isolement_test.py` (fichiers, appels Docker, filtre du lanceur, santé lue dedans) ; `tests/secrets/cle_lanceur_test.py` ; `tests/exposition/isolement_reel.mjs` : une pile entière dans un Docker jetable (`docker:27-dind`, projet `noahtest`), d'abord avec le code des images (agent sur `noah-net`), puis avec ce code. Passage du 15 novembre : 24/24 vertes (agent migré en `cap_drop: ALL`, CapBnd `0xe3` ; navigateur CapBnd `0` ; agent et navigateur ne joignent le lanceur ni par nom ni par adresse ; Caddy reçoit 403 ; chat, fichiers et page ouverte dans le navigateur marchent ; ancienne clé 401, nouvelle 200, lanceur non redémarré).

## Relecture 0.3.0 : défauts corrigés sur `fix/030-securite`

| # | Défaut | Correction | Test | État |
|---|---|---|---|---|
| D1 | En Auto, une citation exacte (C1) faisait passer une ligne 6 sans accord | `juge.py` : `NEVER_ON_QUOTE` (paiement, suppression, irréversible, secrets, protections, droits) ; nouveau motif fermé « droits » | `juge_test.py` 28b | **corrigé** |
| D7 | Un contenu lu par un outil pouvait écrire `<<utilisateur>>` | `desktop/claude.js` : jeton de 16 caractères tiré à chaque tour dans chaque balise, balises du contenu désarmées (`‹‹…››`) | `claude_test.mjs` « D7 cerveau » | **corrigé** |
| D8 | `ANTHROPIC_*`, `CLAUDE_*` héritées faisaient facturer l'API | `desktop/claude.js` : `cleanEnv` pour la tâche, le cerveau et la détection | `claude_test.mjs` « D8 » | **corrigé** |
| D9 | `stayHome`, `fromSetup` : URL comparées à l'égalité stricte | `liens.sameFile` : `fileURLToPath`, `path.normalize`, casse ignorée sous Windows | `liens_test.mjs` « D9 » (espaces, `.asar`) | **corrigé** |
| m1 | Lignes écrites en base non traduites | `frontend/src/lib/lignesServeur.ts` (Activité, début de réponse) | `lignesServeur.test.ts` | **corrigé** |
| m2 | Un invité lisait que l'ordinateur ne répond pas | `relay.BRAIN_UNAVAILABLE` pour `_gatekept` | `abonnements_fournisseurs_test.py` (m2) | **corrigé** |
| m6 | `models/<id>` OpenRouter refusé | `RELAY_GET` accepte des « / » internes ; `..`, `.`, `%`, segments vides refusés | `relais_chemins_test.py` (dont chemins bruts) | **corrigé** |
| m8 | Cerveau par l'ordinateur : embeddings, images, audio en 404 | `relay.py` : par le secours, avec sa clé ; 404 sans secours | `abonnements_fournisseurs_test.py` (m8) | **corrigé** |
| F1 | Cibles tactiles sous 44 px dans la conversation | `.cible-tactile` (44 px au moins sous 768 px), icône inchangée | `lot-d-interface.test.tsx` « F1 » (CSS et boutons) | **corrigé**, mesuré dans le code seulement (pas dans un vrai navigateur à 375×812) |

## Limites connues (relecture GLM 5.3 Flash, `revue-glm.md`)

| # | Limite | Pourquoi elle reste | Ce qui la borne |
|---|---|---|---|
| L1 | Partage de dossiers : un lien symbolique posé sous une racine autorisée (`NOAH_SHARE_ROOTS`) et qui mène vers `/etc` ou `/var/run` passe les contrôles de chemin (partie 3 n°2). | Le lanceur tourne dans son conteneur : il ne voit pas le disque de l'hôte, donc ne peut pas résoudre un lien de l'hôte (`os.path.realpath` lirait son propre système de fichiers). Docker résout le lien au montage. | Racines choisies par le propriétaire de la machine ; refus de tout dossier du système et de tout ancêtre de l'un d'eux (`launcher.py`, `_holds_system`) ; écriture refusée sur une racine entière. Correction propre : résolution côté hôte (app de bureau) avant l'envoi au lanceur. |
| L2 | Mises à jour : qui tient déjà le socket Docker peut recréer le serveur ou le lanceur avec son propre `NOAH_UPDATE_KEY` et ses propres `NOAH_IMAGE_SOURCES` (partie 6 n°4). | Le socket Docker donne déjà l'hôte entier : il n'y a rien à protéger de plus contre lui depuis l'intérieur d'un conteneur. | Sources par dépôt exact (plus d'espace de noms ouvert), valeurs par défaut si la variable est vide ou mal formée ; socket réservé au lanceur (M9). |
