# Grille de validation de Noah Agent

Le score officiel est calculé par niveau de preuve : [etat.md](etat.md) et [evaluation.md](evaluation.md). Les objectifs G10 à G15 sont décrits dans [etat.md](etat.md).

## Règles de notation

- Chaque critère est binaire : il passe ou il échoue. Un critère échoué ne donne aucun point.
- **Score de l'objectif = (points obtenus / points possibles) × 10.** Un critère vaut 1 point, ou 2 points s'il est marqué **[B]**.
- Les critères **[B]** sont bloquants. S'il en manque un seul, l'objectif est à 0, quel que soit le reste. Ce sont les critères de sécurité, d'intégrité des données et de promesse « sans tiers ».
- Chaque critère se vérifie par un test reproductible : script, capture, `openssl`, `nmap`, `docker inspect` ou capture de trafic. La preuve est rangée avec le rapport de l'objectif.
- On ne passe à l'objectif suivant qu'au seuil indiqué. Les objectifs qui ne dépendent pas l'un de l'autre peuvent avancer en parallèle (voir l'ordre recommandé).
- Une référence marquée **(non vérifié)** vient de la recherche sans confirmation officielle. Le critère qui s'y rattache commence par un test de faisabilité.

---

## G0. Socle de publication : images préconstruites

Cet objectif manquait. G1 en dépend entièrement.

**Référence qui fait foi :** GitHub Actions vers GHCR (docs.github.com, *publish-docker-images*), avec le modèle de tags de Hermes Agent (`stable` déplacé uniquement par promotion, `X.Y.Z` figé, digest).

| # | Critère vérifiable | Référence |
|---|---|---|
| G0.1 [B] | Sur un VPS neuf, `docker compose pull` puis `up -d` ne lance aucun `docker build`. Toutes les images viennent de `ghcr.io/...`. | GHCR ; piège « compiler sur un petit VPS » (concurrents) |
| G0.2 | Les paquets GHCR sont publics : un `docker pull` sans `docker login` réussit sur une machine vierge. | Piège GHCR privé par défaut |
| G0.3 | Chaque release publie un tag `X.Y.Z` et un tag `stable`, en amd64 et en arm64 (`docker manifest inspect` montre les deux). | Tags Hermes ; GHCR multi-architecture |
| G0.4 | Les images portent une attestation (`actions/attest`), vérifiable avec `gh attestation verify`. | GHCR (`attestations: write`, `id-token: write`) |
| G0.5 [B] | L'image Camoufox contient déjà le binaire du navigateur. Un premier lancement sans accès réseau sortant démarre le navigateur. | Camoufox (installation au premier lancement) |
| G0.6 | Le couple paquet `camoufox` + binaire navigateur est figé dans l'image et noté dans ses labels OCI. | Camoufox (versions séparées : 0.5.9 et v158.0.1-beta.41) |

**Score pour passer : 9/10**

**Pile :** GitHub Actions, `docker/metadata-action`, `docker/build-push-action` (buildx multi-architecture), `actions/attest`, GHCR public, labels OCI.

---

## G1. Installation sur VPS en un clic

**Référence qui fait foi :** le bouton « Deploy on Hostinger » (`https://www.hostinger.com/docker-hosting?compose_url=...`) et Docker Manager « Compose from URL ». La porte de secours est le script `curl | sh` sur le modèle de Coolify. Pour le premier lancement, le modèle est l'assistant de Home Assistant.

| # | Critère vérifiable | Référence |
|---|---|---|
| G1.1 | Le `deploy/docker-compose.yml` public se déploie tel quel par « Compose from URL », sans aucune variable d'environnement à saisir. | Hostinger Docker Manager (aucun champ de variables documenté) |
| G1.2 | Sur un VPS Hostinger neuf, il faut 10 minutes au plus entre le paiement et la page `/bienvenue` en HTTPS valide, sans taper une commande (chronométré, capture d'écran). | Bouton Deploy on Hostinger ; parcours OpenClaw sur Hostinger |
| G1.3 [B] | Le certificat est émis par Let's Encrypt pour `<ip-en-tirets>.sslip.io` (`openssl s_client -connect ... -servername ...`) et le navigateur n'affiche aucun avertissement. Si la limite est atteinte, la bascule vers nip.io est testée. | nip.io / sslip.io ; Caddy HTTPS automatique |
| G1.4 [B] | `/bienvenue` refuse tout accès sans le code d'installation à usage unique. Une fois le propriétaire créé, le code est invalide et la route renvoie 404 ou 410. | Coolify, Dokploy et Open WebUI (le premier visiteur devient admin) |
| G1.5 [B] | Les secrets et le volume `/data` de Caddy survivent à `docker compose down` puis `up` et à une mise à jour d'image : aucune session n'est perdue et aucun nouveau certificat n'est demandé. | Open WebUI (`WEBUI_SECRET_KEY`) ; limites Let's Encrypt |
| G1.6 | `curl -fsSL <site>/install.sh \| sh` aboutit sur Ubuntu 24.04 et sur Debian 12 chez un autre hébergeur. La dernière ligne affichée contient l'URL et le code. | Coolify, installation par script |
| G1.7 | Si les ports 80 ou 443 sont déjà pris (par exemple par le Traefik de Hostinger), l'installation s'arrête avec un message qui nomme le processus en cause et propose une solution. Elle ne doit pas planter en silence. | Piège Traefik de Hostinger ; Dokploy (échec sur les ports pris) |
| G1.8 | L'assistant se déroule dans cet ordre : code d'installation, nouvelle installation ou restauration, compte propriétaire, modèle (aucun fournisseur américain présélectionné, télémétrie désactivée), premier agent. Il ne se termine qu'après une vraie réponse du modèle. | Home Assistant, onboarding ; OpenClaw « inference first » |

**Score pour passer : 8/10**

**Pile :** un `docker-compose.yml` sans variables ; un conteneur d'initialisation qui détecte l'IP, écrit le Caddyfile, génère les secrets dans un volume et le code d'installation ; Caddy 2.11.x épinglé par digest ; sslip.io, puis nip.io, puis certificat d'IP `shortlived` en dernier recours ; `install.sh` POSIX ; option `--domaine` conservée ; badge Hostinger dans le README et sur le site.

---

## G2. Appairage et comptes d'appareils

**Référence qui fait foi :** l'appairage OpenClaw (QR qui contient l'URL et un jeton d'amorçage de 10 min, approbation, jeton d'appareil), avec la RFC 8628 pour le code manuel et les jetons de Home Assistant (accès 30 min, refresh 90 jours glissants, révocation).

| # | Critère vérifiable | Référence |
|---|---|---|
| G2.1 | Un téléphone en 4G, hors du Wi-Fi, s'appaire en scannant le QR en moins de 30 s, sans rien taper. | OpenClaw Android ; Home Assistant (contre-exemple mDNS) |
| G2.2 [B] | Le jeton du QR fait au moins 128 bits, ne sert qu'une fois (un second scan donne une erreur claire) et expire au bout de 10 min. | OpenClaw (10 min) ; Jellyfin Quick Connect |
| G2.3 [B] | Le jeton n'apparaît pas dans les journaux de Caddy : il est dans le fragment `#` ou envoyé en POST (vérifié par `grep` sur l'access log). | Piège query string (RFC 8628, pièges) |
| G2.4 [B] | La base ne contient que des hachages SHA-256 des jetons d'appairage et d'appareil, jamais un jeton en clair (vérifié par un dump SQL). | OpenClaw (secrets en clair dans SQLite, contre-exemple) |
| G2.5 | La page Appareils affiche le nom, la plateforme, la version, `created_at`, `last_seen_at` et `last_ip`. Une révocation coupe le WebSocket en moins de 5 s ; l'appareil reçoit un 401 et revient à l'écran d'appairage. | Nextcloud, gestion des appareils ; Home Assistant `/auth/revoke` |
| G2.6 | Le code manuel fait 8 caractères en base 20, est refusé après 5 essais, et l'écran d'accord affiche le type et le nom de l'appareil demandeur. | RFC 8628 ; Jellyfin (aucune limite, contre-exemple) |
| G2.7 | Révoquer un lien ou un code d'appairage ne déconnecte pas les appareils déjà appairés, et l'interface le dit. Le bouton « Déconnecter tous les appareils » existe et fonctionne. | Tailscale (clés d'auth) ; OpenClaw `devices rotate` |
| G2.8 | « Oublier ce serveur » appelle `DELETE /api/devices/self`. Si l'appel échoue, l'appareil s'efface quand même en local, et l'appel est rejoué plus tard jusqu'à ce que l'appareil disparaisse côté serveur. | Nextcloud Login Flow v2 (révocation côté client) |

**Score pour passer : 9/10.** C'est la sécurité de tout le reste.

**Pile :** une table `devices` (id, user_id, nom, plateforme, version, hash du jeton, clé publique, scopes, dates, IP) ; endpoints `/api/pair/start`, `/api/pair/claim` et `/api/pair/poll` ; jeton d'accès de 30 min et refresh de 90 jours glissants ; lien profond `noahagent://pair?u=...#t=...`, puis App Links vérifiés sur Android ; aucun épinglage du certificat feuille.

---

## G3. App de bureau reliée au VPS

**Référence qui fait foi :** Nextcloud Login Flow v2 (le navigateur autorise, l'app interroge le serveur et reçoit un jeton propre à l'appareil). Pour le mode local et la migration, le modèle est la restauration de sauvegarde de Home Assistant.

| # | Critère vérifiable | Référence |
|---|---|---|
| G3.1 [B] | L'app s'appaire par le flux navigateur : POST pour démarrer, ouverture du navigateur, « Autoriser cet appareil », puis sondage. Le mot de passe du compte n'est jamais tapé dans l'app (vérifié par une capture du trafic). | Nextcloud Login Flow v2 |
| G3.2 | Le jeton de sondage expire au bout de 20 min, et le serveur ne le livre qu'une seule fois (un second sondage renvoie 404). | Nextcloud Login Flow v2 |
| G3.3 [B] | Le jeton d'appareil est rangé dans le trousseau de l'OS par `safeStorage`, jamais en clair sur le disque (recherche du jeton dans le profil de l'app). | Recommandation appairage (`safeStorage`, non vérifié) |
| G3.4 | L'app gère deux modes : « local », où elle lance Docker comme aujourd'hui, et « relié au VPS ». On passe de l'un à l'autre sans réinstaller. | Hermes Desktop (Settings > Gateway > Remote) |
| G3.5 | Une sauvegarde du mode local, restaurée sur le VPS depuis l'écran « Restaurer » de l'assistant, retrouve les agents, la mémoire et les sessions. `state.db` passe `PRAGMA integrity_check`. | Home Assistant onboarding ; Hermes (`state.db` en WAL) |
| G3.6 | Si le VPS coupe le WebSocket, l'app se reconnecte seule en moins de 30 s après son retour, sans redemander l'appairage. | Issues Hermes #58578 et #56775 |
| G3.7 | En mode local, les données Hermes sont dans des volumes nommés et non dans un montage du dossier hôte. On évite ainsi les corruptions WAL sur virtiofs ou 9p. | Hermes Docker (risque virtiofs/9p) |

**Score pour passer : 8/10**

**Pile :** Electron (existant) ; `safeStorage` ; Login Flow v2 maison ; client API versionné partagé avec le frontend ; `electron-updater` (voir G6).

---

## G4. App mobile, Android d'abord

**Référence qui fait foi :** Capacitor 8 autour du build Vite existant, avec UnifiedPush (connector et embedded FCM distributor) pour le push. Pour la connexion permanente sans Google, le modèle est le Local Push de Home Assistant.

| # | Critère vérifiable | Référence |
|---|---|---|
| G4.1 | Sur une machine propre (JDK 21, SDK API 36, Node 22), `npm run build && npx cap sync android && ./gradlew assembleDebug` produit un APK qui s'installe sur Android 7+ (minSdk 24). | Capacitor 8 (mise à jour v8) ; Capgo (JDK 21) |
| G4.2 | Le même build Vite sert la PWA et l'app. Seul un module de plateforme (`Capacitor.isNativePlatform()`) diffère, et le code n'est pas forké. | Capacitor ; Expo DOM (contre-exemple) |
| G4.3 [B] | La notification « l'agent t'appelle » arrive en moins de 5 s, écran éteint, dans deux cas : (a) téléphone sans Google avec ntfy, (b) téléphone avec Google sans distributeur, par l'embedded FCM. | UnifiedPush connector ; embedded FCM distributor |
| G4.4 [B] | Aucun contenu de message ne passe en clair chez un tiers : le payload est chiffré (RFC 8291) ou ne contient qu'un ID que l'app va chercher sur le VPS (vérifié par une capture). | KUnifiedPush Web Push ; ntfy `poll_request` |
| G4.5 [B] | Le jeton d'appareil est chiffré par une clé AES du Keystore Android. `EncryptedSharedPreferences` n'est pas utilisé (vérifié par `grep` dans les dépendances). | Android Keystore (EncryptedSharedPreferences déprécié en 2025) |
| G4.6 | Le micro fonctionne dans la WebView : `RECORD_AUDIO` est déclaré et demandé, et `getUserMedia` est accepté. Partager un fichier depuis la galerie le fait arriver dans la conversation. | Limites des PWA ; Web Share Target |
| G4.7 | L'app survit à un redémarrage du VPS et à un passage du Wi-Fi à la 4G : elle se reconnecte et se réenregistre auprès d'UnifiedPush toute seule. | UnifiedPush (réenregistrement périodique) |
| G4.8 | Le mode « connexion permanente », s'il est activé, déclare son `foregroundServiceType` et consomme moins de 3 % de batterie par jour, mesuré sur 24 h. | Home Assistant Local Push ; piège foreground service |

**Score pour passer : 8/10.** iOS est hors périmètre de cet objectif.

**Pile :** Capacitor 8 avec `dist/` embarqué (pas de `server.url`) ; AGP 8.13.0, Gradle 8.14.3, Kotlin 2.2.20 ; un plugin Capacitor UnifiedPush maison en Kotlin (`org.unifiedpush.android:connector` et `embedded_fcm_distributor`, version de Tink épinglée) ; scan de QR natif ; Keystore ; distribution en APK signé sur GitHub Releases, puis F-Droid et Play. `@capacitor/push-notifications` est écarté parce qu'il dépend de FCM.

---

## G5. Version web (PWA)

**Référence qui fait foi :** l'usage d'Open WebUI en PWA, avec les limites des PWA sur iOS (Web Push depuis iOS 16.4, uniquement depuis l'écran d'accueil) et l'émetteur Web Push VAPID côté serveur.

| # | Critère vérifiable | Référence |
|---|---|---|
| G5.1 [B] | La première URL montrée à l'utilisateur est toujours en HTTPS. Aucune page, ni la doc ni la sortie du script, ne donne `http://IP:port`. | OpenClaw (« requires secure context ») |
| G5.2 | Lighthouse marque la PWA comme installable sur Chrome Android et sur Edge pour bureau. Le service worker sert l'écran de connexion hors ligne. | Open WebUI en tant qu'app |
| G5.3 | Le serveur n'a qu'un émetteur Web Push VAPID, dont la paire de clés est générée une fois par instance et conservée. La PWA Chrome reçoit la notification d'appel en moins de 5 s. | KUnifiedPush ; piège VAPID (ne jamais changer la paire) |
| G5.4 | Sur iOS 16.4+, une fois la PWA ajoutée à l'écran d'accueil, l'autorisation de notification se déclenche par un geste de l'utilisateur et une notification de test arrive. | Limites des PWA sur iOS |
| G5.5 | Web Share Target fonctionne quand la PWA est installée sur Android. Sur iOS, l'interface n'affiche pas l'option, faute de prise en charge. | Web Share Target (bug WebKit 194593) |
| G5.6 | Le serveur garde la compatibilité d'API avec la version N-1 et annonce `min_client_version`. Un client trop ancien affiche « mettez à jour » au lieu de planter. | OpenClaw (`protocol mismatch`) ; mises à jour |

**Score pour passer : 8/10**

**Pile :** React et Vite (existant) ; service worker (Workbox ou fait main) ; manifeste avec `share_target` ; `pywebpush` côté FastAPI (état de la bibliothèque à vérifier) ; API versionnée `/api/v1`.

---

## G6. Mises à jour automatiques

**Référence qui fait foi :** la mécanique de WUD (préchargement, hook *pre* bloquant, rollback selon la santé, fenêtre de 300 s), la séparation vérification/installation de Coolify et son conteneur helper, et la règle d'Immich et d'Umbrel : jamais de version majeure sans accord.

| # | Critère vérifiable | Référence |
|---|---|---|
| G6.1 [B] | `docker inspect` ne montre que des images épinglées par digest, et ces digests correspondent au manifeste signé. Un manifeste à la signature invalide est rejeté et l'événement est journalisé. | Caddy (tag reconstruit sous le même nom) ; tags Hermes |
| G6.2 [B] | Test de panne : une image Hermes qui renvoie 500 sur `/health` déclenche un retour arrière en moins de 5 min. L'ancien conteneur et l'instantané de données reviennent, et l'utilisateur est notifié. | WUD (ROLLBACK, ROLLBACKWINDOW) ; OpenClaw (`state-migrated-no-rollback`) |
| G6.3 [B] | Si la sauvegarde d'avant mise à jour échoue (disque plein simulé), rien ne démarre. Après une restauration, `state.db` passe `PRAGMA integrity_check`. | Coolify (sauvegarde en garde-fou) ; hook pre de WUD |
| G6.4 | Si une tâche agent tourne, qu'un cron Hermes tombe dans les 15 min ou qu'une session Camoufox est ouverte, la mise à jour est repoussée et non interrompue (le journal le prouve). | Recommandation mises à jour ; Coolify (aucun déploiement en cours) |
| G6.5 | Après 3 semaines d'activité simulée de 8 h à 23 h, le créneau choisi tombe en dehors de ces heures, dans le fuseau de l'utilisateur et non dans celui du VPS. | Windows, heures d'activité ; piège fuseau UTC |
| G6.6 | Une version majeure est annoncée et attend 7 jours avant le créneau calme (l'utilisateur veut que les majeures passent aussi) ; un clic l'installe avant. Une version marquée `migration` ne s'installe jamais sans un clic. « Ignorer » la masque jusqu'à la version suivante. | Immich (`IMMICH_VERSION`) ; Umbrel ; entité `update` de Home Assistant |
| G6.7 | Le lanceur est mis à jour par un conteneur helper, et l'opération survit à un `kill -9` en cours de route : l'état final est l'ancienne ou la nouvelle version, jamais aucune des deux. | Coolify (étape Helper) |
| G6.8 | Sur une mise à jour mineure, la coupure de l'agent dure moins de 60 s (image préchargée). La santé vérifiée après redémarrage inclut le WebSocket du chat derrière Caddy. | WUD PRELOAD ; issues Hermes #58578 et #56775 ; docker-rollout |

**Score pour passer : 9/10.** Cet objectif tourne seul la nuit, sans personne pour réparer.

**Pile :** un updater intégré au lanceur (pas de Watchtower : l'original est archivé et le fork se déconseille lui-même en production) ; un manifeste signé avec minisign ou cosign, deux canaux (stable et « en avance ») et un rodage de 3 à 7 jours ; sauvegarde SQLite par l'API backup ; ordre canari, agents, Caddy, app ; `docker-rollout` pour le serveur FastAPI ; `unattended-upgrades` aligné sur le même créneau ; `electron-updater` avec `stagingPercentage` pour le bureau ; contrôle de version maison sur Android hors Play.

---

## G7. Sécurité, exposition et vie privée vérifiable

Cet objectif manquait.

**Référence qui fait foi :** l'accès distant d'OpenClaw (loopback par défaut, `wss://` obligatoire), avec les incidents OpenClaw en contre-exemple (instances exposées, ClawHavoc) et le partage de données désactivé par défaut de Home Assistant.

| # | Critère vérifiable | Référence |
|---|---|---|
| G7.1 [B] | Un `nmap` lancé depuis Internet juste après l'installation ne montre que 80 (redirection) et 443. Le port 8642 de Hermes et les ports de Camoufox ne sont joignables que sur le réseau Docker interne. | OpenClaw (bind sur toutes les interfaces) ; Hermes API server |
| G7.2 [B] | Aucun jeton d'administration n'apparaît dans les variables d'environnement visibles depuis le Docker Manager de Hostinger (vérifié avec `docker inspect`). | Piège gateway token d'OpenClaw chez Hostinger |
| G7.3 [B] | Une capture du trafic sortant sur 24 h ne montre que le fournisseur de modèle choisi, les sites visités par l'agent, le registre et le manifeste des mises à jour, et le distributeur de push. Aucune télémétrie. | Concurrents, point 7 (vie privée vérifiable) |
| G7.4 | L'interface liste chaque flux sortant et le fournisseur de modèle utilisé par chaque agent. | Piège fournisseur américain par défaut |
| G7.5 | Le montage de `/var/run/docker.sock` est documenté, avec ce qu'il implique (accès root à l'hôte), et il est réservé au seul lanceur. | Piège socket Docker hors du projet Hostinger |
| G7.6 | Aucun skill tiers ne s'installe sans signature ou vérification, et aucun skill n'exécute de prérequis téléchargé. | ClawHavoc (341 skills malveillants sur 2 857) |
| G7.7 | Pendant une prise en main du navigateur de l'agent pour une connexion, aucune capture n'est faite ni journalisée. | Mode takeover de ChatGPT agent |

**Score pour passer : 9/10**

**Pile :** Caddy seul exposé ; réseaux Docker internes ; secrets dans un volume en `0600` ; politique de sortie documentée ; registre de skills signés.

---

## G8. Coûts et fonctionnement 24 h/24

Cet objectif manquait.

**Référence qui fait foi :** les plaintes OpenClaw (plus de 100 $ par jour, plus de 10 000 tokens pour un mot) en contre-exemple, et la messagerie de Hermes (crons, restart policy) pour la continuité.

| # | Critère vérifiable | Référence |
|---|---|---|
| G8.1 [B] | Un plafond de dépense quotidien par agent arrête l'agent et prévient l'utilisateur sur son téléphone avant le dépassement (test avec un plafond de 0,10 $). | Plaintes OpenClaw (coûts) |
| G8.2 | Un compteur de tokens et de coûts est visible par agent, par jour et par tâche. | Plaintes OpenClaw ; Manus (crédits brûlés) |
| G8.3 | Une boucle de veille ou une veille de page n'appelle aucun gros modèle quand rien n'a changé : 0 appel au modèle sur 24 h avec une page stable. | Commit « Veilles » ; requêtes Opus nocturnes d'OpenClaw |
| G8.4 | Après un redémarrage du VPS, tous les conteneurs (app, Caddy, agents, Camoufox) reviennent seuls en moins de 3 min, grâce à la restart policy. | Hermes gateway ; piège unattended-upgrades |
| G8.5 | Un agent tourne 72 h sans fuite mémoire au-delà de 20 % de hausse du RSS, sur un KVM 2 (8 Go) avec 2 agents et leur Camoufox. | Hostinger KVM 2 conseillé |

**Score pour passer : 8/10**

**Pile :** compteur de tokens côté serveur, plafonds dans la config de l'agent, restart policy `unless-stopped`, métriques légères exposées seulement en interne.

---

## G9. Formation et mise sur le marché

Cet objectif manquait.

**Référence qui fait foi :** la vidéo de 1littlecoder (environ 16 min, avec deux chemins : web et CLI) et la page Hermes Agent du catalogue Hostinger, qui est le concurrent direct dans le même parcours.

| # | Critère vérifiable | Référence |
|---|---|---|
| G9.1 | Une personne non technique, avec la vidéo pour seul support, va d'un VPS vide à une première réponse de l'agent en 10 minutes au plus (test avec 3 personnes, au moins 2 réussites). | Vidéo 1littlecoder ; concurrents, critère 1 |
| G9.2 | Le README et le site expliquent en 5 points ce que Noah ajoute par rapport au Hermes du catalogue Hostinger : multi-agent, navigateur par agent, apps, aucun fournisseur imposé, mises à jour sûres. | Hermes dans le catalogue Hostinger |
| G9.3 | Le badge « Deploy on Hostinger » fonctionne depuis le README (testé de bout en bout). Le paramètre d'affiliation, s'il est présent, est signalé. | Bouton Deploy on Hostinger |
| G9.4 | La page iOS dit franchement que les notifications passent forcément par Apple, et qu'avec le réglage `upstream-base-url`, un ID et un hash transitent par ntfy.sh. | ntfy ; relais APNs d'OpenClaw |

**Score pour passer : 8/10**

**Pile :** vidéo de 10 à 15 min, doc du parcours, page de comparaison.

---

## Ordre recommandé

1. **G0, socle d'images.** Sans images publiques préconstruites, ni le bouton Hostinger ni les mises à jour par digest ne peuvent exister.
2. **G1 et G7 ensemble.** La sécurité (code d'installation, exposition, secrets) se construit dans l'installation, pas après. G1 n'est validé qu'avec G7.1 et G7.2 au vert.
3. **G2, appairage.** C'est le contrat commun au bureau, au mobile et au web. Il doit être stable avant de construire les clients.
4. **G5, PWA.** C'est le client le moins cher à valider. Elle pose l'émetteur Web Push VAPID que G4 réutilise.
5. **G3, bureau.** Il reprend un existant (Electron) ; ajouter Login Flow v2 et la migration du local vers le VPS débloque les utilisateurs actuels.
6. **G4, Android.** Il réutilise G2, G5 et le VAPID. Le plugin UnifiedPush maison est le gros chantier.
7. **G6, mises à jour automatiques.** Elles n'ont de sens qu'une fois toutes les pièces en place, et elles doivent connaître tous les services pour vérifier leur santé, WebSocket compris. Une version minimale (vérification et notification seules, installation manuelle par clic) peut sortir dès G1.
8. **G8, en continu à partir de G1.** Le plafond de dépense (G8.1) est exigé avant toute communication publique.
9. **G9, en dernier.** La vidéo se tourne sur le parcours final.

## Risques principaux

1. **Hostinger et ses inconnues.** La doc ne dit pas si `compose_url` demande des variables ni s'il accepte un dépôt privé, et le Traefik de Hostinger occupe les ports 80 et 443. Parade : un test réel sur un VPS neuf avant toute communication, une détection du conflit de ports, et un mode « derrière Traefik » à étudier.
2. **Le premier visiteur devient admin.** Le risque existe sur tout VPS public tant que le propriétaire n'est pas créé. Le code d'installation à usage unique est obligatoire (G1.4 bloquant).
3. **Mises à jour Hermes et Camoufox instables en amont.** Hermes est en semver 0.x (v0.22.1 publiée par erreur) et Camoufox ne sort que des `-beta`. Parade : rodage avant promotion, digests figés, rollback avec les données. La migration de config de Hermes ne sauvegarde pas `state.db`.
4. **Push sans Google sur Android.** Il n'existe aucun plugin Capacitor UnifiedPush, et Tink entre en conflit avec d'autres dépendances. C'est le chantier le plus risqué de G4. Le repli est la connexion permanente par service au premier plan.
5. **iOS ne peut pas être « sans tiers ».** APNs est incontournable ; il faut le dire sans détour (G9.4).
6. **Socket Docker.** Le lanceur a un accès root à l'hôte, et les conteneurs d'agents échappent au Docker Manager de Hostinger (ni Update ni Delete ne les touchent). Il faut le documenter, et un nettoyage complet doit exister côté Noah.
7. **Limites de Let's Encrypt sur sslip.io.** Le quota est partagé entre tous les utilisateurs du service. Parade : nip.io en secours, certificat d'IP `shortlived` en dernier recours (pris en charge par Caddy seulement sur master), et ne jamais perdre le volume `/data` de Caddy.
8. **Références non vérifiées.** Sont concernés : l'API Hostinger pour un déploiement depuis l'app de bureau, le JDK officiel de Capacitor 8, l'état de `pywebpush`, `safeStorage` et le statut des PWA iOS dans l'UE. Les critères qui en dépendent commencent par un test de faisabilité.
9. **La concurrence directe.** Hermes est déjà en un clic dans le catalogue Hostinger, avec ses crédits IA. Si la différence n'est pas visible dès la première page, le parcours de Noah ressemble à une copie plus longue.