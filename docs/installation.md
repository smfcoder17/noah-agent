# Installer Noah Agent

Le guide complet. Le [README](../README.md) donne l'essentiel ; ici, le détail de chaque voie, puis ce qui tourne sur le serveur.

Il faut Docker, et de la place : environ 5 Go sur le disque, plus 4 Go la première fois qu'un agent navigue.

| Tu veux | Fais | Temps |
|---|---|---|
| L'essayer sur ton ordinateur | [Sur ton ordinateur](#sur-ton-ordinateur) | 10 min, surtout le téléchargement |
| Un agent 24 h/24, joignable partout | [Sur un VPS](#sur-un-vps) | 10 min |
| Le relier à ton téléphone | [Ton téléphone](#ton-téléphone) | 2 min |

> **À savoir aujourd'hui.** L'installation sur VPS télécharge des images et un fichier publiés par le dépôt GitHub. Tant que la première version n'est pas publiée, seule l'installation sur ton ordinateur marche. Elle compile tout depuis le code.

## Sur ton ordinateur

Installe [Docker Desktop](https://docs.docker.com/get-docker/) et démarre-le, puis, à la racine du dépôt :

```bash
sh install.sh
```

Ouvre http://localhost:8080, crée ton compte et choisis ton modèle. Noah reste sur ta machine : il n'est pas ouvert au réseau. Le port se règle avec `NOAH_PORT` dans `.env`.

Avec Ollama : il doit tourner sur ta machine, et Noah le joint par `host.docker.internal:11434`. Les modèles `:cloud` d'Ollama fonctionnent aussi.

`sh scripts/reset.sh` efface tout et repart de zéro. Il sert à cette installation-là seulement.

## Sur un VPS

Un VPS Ubuntu ou Debian, 4 Go de mémoire au moins, ports 80 et 443 libres. Compte plutôt 8 Go (KVM 2 chez Hostinger) dès que plusieurs agents naviguent. Choisis d'abord ton adresse : voir [Adresse et domaine](#adresse-et-domaine).

### Hostinger Docker Manager

VPS > Manage > Docker Manager > Compose > « Compose from URL ».

- **URL :** `https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml`
- **Nom du projet :** `noah`, exactement. Le fichier fixe ce nom (`name: noah`), et les sauvegardes cherchent les volumes `noah_noah-*`.

Puis Deploy. Le menu du projet (⋮) > View logs affiche le lien de création du compte, dans les lignes du service `server`.

Colle l'adresse du fichier, pas celle du dépôt. Hostinger transforme une adresse de dépôt en « fichier compose de la branche master » : ici, cette branche n'existe pas, et le `docker-compose.yml` à la racine sert à l'installation sur ton ordinateur.

Ne clique sur Delete que pour tout effacer : Hostinger supprime aussi les volumes du projet, donc ton compte et tes secrets. Les conteneurs d'agents (`noah-agent-*`, `noah-browser-*`) sont créés par le lanceur, hors du projet : Docker Manager ne les affiche pas et ne les supprime pas.

### Par une commande

En root :

```bash
curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | NOAH_DOMAIN=noah.exemple.com sh
```

Sans sous-domaine : `curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | sh`.

`NOAH_DOMAIN` se place après le `|`, devant `sh`. Devant `curl`, il ne parviendrait pas au script.

Le script installe Docker s'il manque, ouvre les ports web si `ufw` est actif, place le compose dans `/opt/noah` et démarre Noah sans rien compiler. Le lien de création du compte s'affiche à la fin, ou plus tard avec `cd /opt/noah && docker compose logs server`. Son code est après le `#` : il ne part pas vers le serveur et ne finit pas dans les journaux d'accès.

Relancer la commande met Noah à jour sans toucher aux données ni aux secrets. Le domaine reste noté dans `/opt/noah/.env`. Autres variables : `NOAH_DIR` (dossier d'installation), `NOAH_COMPOSE_URL` (un autre fichier compose).

### Derrière un Traefik

Un Traefik tient déjà les ports 80 et 443 ? Le Caddy de Noah ne pourrait pas démarrer.

- **Par la commande :** `get.sh` voit le Traefik et place Noah derrière lui. Tes autres sites ne bougent pas. Sans domaine, il prend `<ip-en-tirets>.sslip.io`.
- **Par Docker Manager :** déploie plutôt `https://raw.githubusercontent.com/smfcoder17/noah-agent/main/deploy/docker-compose.traefik.yml`. Ce fichier exige `NOAH_DOMAIN` : dans le YAML Editor, remplace ses deux occurrences `${NOAH_DOMAIN…}` par ton sous-domaine. Ses images ne sont pas épinglées par empreinte.

Dans les deux cas, ton Traefik doit partager un réseau avec Noah : `docker network connect noah-net <nom-du-conteneur-traefik>`. Si son résolveur de certificats ne s'appelle pas `letsencrypt`, donne son nom dans `NOAH_TRAEFIK_RESOLVER`. Noah publie aussi le serveur sur `127.0.0.1:8088` (`NOAH_PUBLISH`), pour un Traefik qui ne lit pas Docker.

Ce chemin n'a pas encore été suivi avec le Traefik de Hostinger.

## Adresse et domaine

Le fichier compose ne met l'IP nulle part en dur. Caddy publie les ports 80 et 443 ; le serveur et le lanceur ne publient rien. Ce qui compte, c'est le nom que tu donnes à Noah.

| Voie | Adresse | L'IP se voit-elle ? |
|---|---|---|
| `NOAH_DOMAIN=noah.exemple.com`, **conseillé** | `https://noah.exemple.com` | Pas dans l'adresse. Oui pour qui consulte le DNS |
| Rien (`auto`), en secours | `https://203-0-113-7.sslip.io` | Oui, dans l'adresse |
| Domaine derrière un relais | `https://noah.exemple.com` | Non, tant que le relais tient. [Lire d'abord](#cacher-lip-du-serveur) |

**Avec un sous-domaine.** Crée un enregistrement A, de `noah` vers l'IP du serveur, puis attends qu'il réponde. Sur le serveur, `getent hosts noah.exemple.com` doit donner cette IP. Caddy obtient le certificat tout seul à la première visite, en une minute environ.

- **Hostinger :** dans le YAML Editor du projet, remplace `NOAH_DOMAIN: ${NOAH_DOMAIN:-auto}` par `NOAH_DOMAIN: noah.exemple.com`, puis redéploie.
- **Commande :** relance `get.sh` avec `NOAH_DOMAIN`, comme ci-dessus. Tu peux aussi l'écrire dans `/opt/noah/.env`, puis `cd /opt/noah && docker compose up -d`.

**Le nom sslip.io reste actif.** Même avec ton domaine, `<ip-en-tirets>.sslip.io` et `<ip-en-tirets>.nip.io` continuent de répondre. C'est un secours si ton domaine a un souci. Ces noms demandent le même compte et la même connexion. Le QR code suit le nom par lequel tu as ouvert Noah.

**Changer d'adresse.** Tes données ne bougent pas. Un appareil déjà relié garde son ancienne adresse tant qu'elle répond. Relie-le de nouveau pour passer à la nouvelle.

### Cacher l'IP du serveur

Un sous-domaine ne cache rien : un nom est public, et il mène à l'IP. Seul un relais qui répond à la place du serveur, comme le proxy de Cloudflare (« nuage orange »), cache vraiment l'IP.

**Noah n'a pas été testé derrière un relais.** Ce que le code permet déjà d'annoncer :

- Le relais déchiffre le trafic, donc il voit tes conversations. C'est le prix à payer, et ça pèse sur la promesse de Noah.
- Noah verra l'adresse du relais à la place de la tienne. Les limites d'essais de connexion sont comptées par adresse : plusieurs personnes pourraient se les partager. Réglages > Appareils affichera l'adresse du relais.
- Le premier certificat et ses renouvellements passent par le relais, à vérifier chez toi.
- Le nom `<ip-en-tirets>.sslip.io` répond toujours : ne l'utilise plus et ne le partage pas. Il révélerait l'IP.
- Les sites que visitent tes agents voient toujours l'IP du serveur.

## Mot de passe oublié

Noah n'envoie pas de courriel : qui a la main sur le serveur peut changer le mot de passe du propriétaire. Sur la page de connexion, « Mot de passe oublié ? », puis « Créer un code ». Le code se lit dans les journaux du service `server`. Il sert une fois, pendant 15 minutes.

- **Hostinger :** VPS > Manage > Docker Manager > Projects, menu ⋮ de ton projet > View logs. Cherche « Code de récupération ».
- **Avec un terminal sur le serveur :** `docker exec noah-server python -m noah.recuperation` crée un nouveau code et l'affiche. L'ancien ne sert plus.

Toutes les sessions du serveur se ferment après le changement : relie de nouveau tes applications. Trop d'essais faux bloquent l'adresse quelques minutes (5 en 10 min), et 20 essais faux annulent le code.

La double vérification du propriétaire reste active, sauf si tu coches la case de cette page. Qui a la main sur le serveur peut donc aussi la couper, et le journal du service `server` le note.

## La double vérification

En plus du mot de passe, Noah peut demander un code à 6 chiffres donné par une application sur ton téléphone (Google Authenticator, Aegis, 1Password…). Chaque compte l'active pour lui-même : propriétaire comme profil.

- **Activer :** Réglages > Appareils > « Activer la double vérification ». Noah demande ton mot de passe, affiche un QR code et sa clé en clair, puis attend un premier code. Il montre ensuite 8 codes de secours, une seule fois : note-les ailleurs que sur ce téléphone.
- **Se connecter :** après le mot de passe, saisis le code de l'application, ou un code de secours si tu n'as plus ton téléphone. Un même code ne sert qu'une fois.
- **Tes applications reliées :** elles gardent leur accès et ne demandent aucun code à l'usage.
- **Codes faux :** 5 codes faux en 30 minutes bloquent le compte pendant ce délai, quelle que soit l'adresse, et tes appareils abonnés aux notifications sont prévenus. Seul qui a le bon mot de passe atteint cette limite : si cela arrive sans toi, change-le.
- **Désactiver :** même endroit, avec ton mot de passe et un code. Changer de mot de passe ne la coupe pas.
- **Plus de téléphone ni de code de secours :** le propriétaire passe par [Mot de passe oublié](#mot-de-passe-oublié). Pour un profil, le propriétaire la coupe dans Réglages > Profils.

## Choisir le modèle

Réglages > Cerveau, un seul choix pour tous tes agents.

| Fournisseur | Il te faut | Pour qui |
|---|---|---|
| **Ollama local** | Ollama lancé sur ton ordinateur (installation locale). Adresse facultative, sans clé | Tes modèles locaux, et les modèles `:cloud` de ton compte Ollama |
| **Ollama Cloud** | Une clé Ollama | Les modèles cloud sans rien installer, le plus simple sur un VPS |
| **Compatible OpenAI** | Une adresse en `/v1`, clé facultative | LM Studio, vLLM, LiteLLM ou tout autre serveur compatible |
| OpenRouter, Anthropic, OpenAI, Gemini | Une clé | Leurs modèles |

Choisis un modèle qui sait utiliser des outils. Une clé ne suit jamais un autre fournisseur ni une autre adresse : si tu changes l'adresse, retape la clé.

## La voix

Le modèle ne suffit pas pour parler : il faut aussi transcrire et synthétiser. Réglages > Voix propose deux chemins :

- **Une clé OpenRouter,** le plus simple : tout marche tout de suite. Elle ne sert qu'à la voix et aux images si ton cerveau est ailleurs.
- **Ton propre serveur de voix,** compatible OpenAI (par exemple [Speaches](https://speaches.ai/)) : son adresse, sa clé facultative, ses modèles. Aucune donnée vocale ne part alors chez un tiers.

La réponse rapide à l'oral suit le fournisseur du cerveau.

## Ton téléphone

Réglages > Appareils > « Relier un appareil » affiche un QR code et un code court, valables 10 minutes. Le QR code n'apparaît que sur une page en HTTPS. Sur un VPS, c'est déjà le cas. Sur ton ordinateur, `tailscale serve 8080` donne une telle adresse à tes appareils Tailscale.

- **Android :** installe l'APK (`noah-agent-android.apk` sur la [page des versions](https://github.com/smfcoder17/noah-agent/releases/latest)), puis « Scanner le QR code ». L'app affiche un nombre à 3 chiffres : recopie-le sur l'ordinateur, puis clique sur « Autoriser ». Sans appareil photo, « Saisir l'adresse et le code ».
- **iPhone ou autre :** scanne le QR code avec l'appareil photo, ou ouvre l'adresse HTTPS de ton VPS, puis « Ajouter à l'écran d'accueil ».

Pour construire l'APK toi-même (Node 22, JDK 21, SDK Android) : `cd mobile && npm ci && npx cap sync android`, puis `./gradlew assembleDebug` dans `mobile/android`. Il arrive dans `app/build/outputs/apk/debug/`. C'est une version de débogage : Android demandera d'autoriser l'installation hors du Play Store.

Accepter un nouvel appareil demande ton mot de passe, et ton code si la double vérification est active. Seul un navigateur où tu as saisi ton mot de passe il y a moins de 15 minutes en est dispensé : un jeton d'appareil volé ne peut pas en relier un autre.

Accepte les notifications : c'est par elles qu'un agent te rappelle.

## L'application de bureau

Installateur Windows sur la [page des versions](https://github.com/smfcoder17/noah-agent/releases/latest), non signé : Windows peut afficher un avertissement au premier lancement. Pour le construire sous Windows : `cd desktop && npm install && npm run dist`, il arrive dans `desktop/dist/`.

**Relier au VPS.** « Sur mon serveur », l'adresse en `https://`, « Relier ». Le navigateur s'ouvre : connecte-toi, « Autoriser cet appareil », puis recopie le nombre dans l'application. « J'ai un code à la place » utilise le code court de Réglages > Appareils. L'icône de la zone de notification propose « Changer de serveur… ».

**En local.** « Sur cet ordinateur » démarre Noah avec Docker Desktop. `cd desktop && npm install && npm start`, depuis une copie du dépôt, va directement dans ce mode, sans montrer le choix : pour relier un VPS, passe par l'installateur.

**Dossiers (en local seulement).** Détails > Dossiers donne le vrai sélecteur de dossier : tu confies à un agent des dossiers de ton ordinateur, en lecture seule ou en écriture, et l'un d'eux devient son dossier de travail. Le partage n'est possible que sous les racines de `NOAH_SHARE_ROOTS` dans `.env` (l'application y met ton dossier personnel au premier lancement ; plusieurs racines séparées par `;`). Les dossiers de clés et de réglages (`.ssh`, `.aws`, `AppData`, `.config`…) sont toujours refusés. Sur un VPS, la variable reste vide : le partage est coupé.

L'application fermée reste dans la zone de notification, pour que les routines continuent.

## Tes agents

- **Créer un agent :** « Créer un agent », un nom et un rôle. Il répond en moins d'une minute. Le tout premier prend plus longtemps si son image est encore en téléchargement.
- **Lui parler :** le bouton de voix à côté du champ, sans rien appuyer ensuite. Parle pour l'interrompre.
- **Faire travailler un agent pour un autre :** « Demande à Rita de… ». Ajoute « et rappelle-moi quand c'est fini » pour qu'il te rappelle.
- **Brancher un outil :** Détails > Connexions > Ajouter un outil, l'adresse d'un serveur MCP, un test, puis Enregistrer. Choisis son droit : lire, agir, ou demander confirmation (par défaut). L'agent l'a en moins d'une minute.
- **Ajouter une personne :** Réglages > Profils. Chacun a ses agents, ses appareils et son plafond de dépenses.
- **Partager un agent :** Détails > Partager, avec le droit lecture, usage ou admin. Avec le droit usage, la personne a sa propre mémoire et son propre navigateur, sans tes comptes connectés ni terminal ; le dossier de travail reste commun. Le droit admin est le choix de tout mettre en commun : ta mémoire, ton navigateur, tes comptes connectés et tes dossiers.

## En cas de souci

| Ce que tu vois | Quoi faire |
|---|---|
| Le déploiement échoue sur le port 80 ou 443 | Un autre service les tient : [Derrière un Traefik](#derrière-un-traefik) |
| `manifest unknown` ou `denied` en téléchargeant les images | Aucune version publiée pour l'instant, ou images encore privées. Rien à corriger de ton côté |
| Le navigateur refuse le certificat de ton domaine | Le nom ne pointe pas vers le serveur, ou un pare-feu de l'hébergeur ferme les ports 80 et 443. En attendant, `<ip-en-tirets>.sslip.io` répond |
| Plus de lien de création dans les journaux | Le compte existe déjà : les journaux affichent seulement « Noah est prêt » |
| Un agent « Hors ligne » | Le bouton Redémarrer en haut de sa conversation. Il repart avec ses données |
| « Docker ne répond pas » | Démarre Docker Desktop, puis `sh install.sh` |
| Un outil « En panne » | Vérifie son serveur. L'agent continue sans lui |
| Un outil sur ton réseau privé est refusé | Ajoute le réseau dans « Serveur sur ton réseau privé », sous l'ajout d'un outil |
| La voix ne répond pas | Réglages > Voix : une clé OpenRouter ou un serveur de voix est nécessaire |
| Pas de notification sur le téléphone | Autorise les notifications de Noah dans les réglages du téléphone |

## Sauvegarder

```bash
sh scripts/backup.sh                                   # backups/noah-AAAAMMJJ-HHMM.tar, garde les 7 dernières
sh scripts/restore.sh backups/noah-20261030-0300.tar   # restaure, ici ou sur un nouveau serveur
```

Une sauvegarde contient le compte et l'historique, la machine de chaque agent (mémoire, routines, fichiers, connexions), son navigateur (sessions de sites), et la clé qui déchiffre tes secrets. Cette clé est dans le volume `noah_noah-secrets` sur un VPS, dans `.env` en local. Range la sauvegarde en lieu sûr.

`get.sh` place ces scripts dans `/opt/noah/scripts`. L'installation locale les a dans le dépôt. Avec Docker Manager, récupère-les une fois, depuis la console du VPS (Web Console) :

```bash
DIR=$(docker inspect noah-server --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
mkdir -p "$DIR/scripts"
for f in backup.sh restore.sh; do curl -fsSL "https://raw.githubusercontent.com/smfcoder17/noah-agent/main/scripts/$f" -o "$DIR/scripts/$f"; done
cd "$DIR" && sh scripts/backup.sh
```

Pour une sauvegarde chaque nuit, ajoute avec `crontab -e` :

```text
0 3 * * * cd /opt/noah && sh scripts/backup.sh >> backups/backup.log 2>&1
```

Pour migrer, l'assistant de premier lancement propose aussi « Restaurer une sauvegarde ».

## Mettre à jour

Noah se met à jour seul sur un VPS, dépendances comprises (Hermes, le navigateur, Caddy) : chaque version publiée fixe leurs images par empreinte, dans un manifeste signé. Le serveur le lit toutes les heures, télécharge la nouvelle version à l'avance et l'installe pendant ton créneau calme, dans ton fuseau (de 3 h à 6 h, ou les heures où tu n'utilises pas Noah). Jamais pendant une tâche, une validation, un écran ouvert ou juste avant une routine.

Tout est sauvegardé avant (bases SQLite vérifiées) ; si un composant ne répond plus, l'ancienne version revient avec ses données. Une version majeure attend 7 jours (ou un clic), et une version qui transforme les données attend toujours un clic. Tout se règle dans Réglages > Mises à jour.

En local, les images sont compilées chez toi : `git pull && sh install.sh`.

Pour publier des versions signées depuis ton dépôt : `python scripts/release-manifest.py cle`, puis le secret `NOAH_RELEASE_KEY` et la variable `NOAH_UPDATE_KEY` dans GitHub Actions ; chaque étiquette `vX.Y.Z` publie les images et le manifeste.

## Les limites à connaître

- **Plusieurs profils :** l'isolation tient entre agents distincts. Un agent partagé garde une seule machine : donne-le seulement à quelqu'un en qui tu as confiance.
- **Outils OAuth :** ils tournent dans la machine de l'agent. « Demander confirmation » arrête le modèle, pas un agent déjà détourné. Les outils ajoutés sans authentification ou avec un jeton passent par Noah, qui garde le contrôle.
- **Coûts :** Ollama et les serveurs compatibles OpenAI comptent 0 $. Le plafond ne les arrête pas.
- **Son propre nom d'hôte :** Noah doit avoir son nom (`noah.exemple.com`), sans autre service web sur le même hôte. Les cookies ne distinguent pas les ports (RFC 6265 §8.5) : un service sur `noah.exemple.com:8443` recevrait la session de Noah. Les apps bloquent ces requêtes, mais pas une image redirigée vers ce port.
- **Notifications web :** si l'on se déconnecte au moment même où une notification s'affiche, son contenu peut apparaître un instant avant d'être refermé.

## Ce qui n'est pas encore vérifié

Ce guide n'a pas été suivi sur un VPS neuf ni sur un vrai téléphone. L'écran d'appel Android existe, mais n'a pas été vérifié en conditions réelles. L'état exact, parcours par parcours, est dans [etat.md](etat.md).

## Ce qui tourne sur le serveur

| Service | Rôle |
|---|---|
| `noah-server` | API, comptes, traduction des événements d'Hermes, interface web |
| `noah-launcher` | Seul service qui parle à Docker. Crée un conteneur par agent à partir d'une image fixe, sans privilège ni montage de l'hôte |
| `noah-caddy` | HTTPS, sur un VPS seulement (absent derrière Traefik). Seul à publier des ports : 80 et 443 |
| `noah-agent-*` | Un conteneur Hermes par agent, avec son volume (mémoire, fichiers). Jamais exposé |
| `noah-browser-*` | Le navigateur de l'agent, avec son profil. Jamais exposé |

En local, c'est `noah-server` qui publie le port, sur `127.0.0.1:8080`. Derrière Traefik, il publie `127.0.0.1:8088`.

Les données sont dans les volumes Docker `noah_noah-data` (compte, clé chiffrée, historique), `noah_noah-secrets` (clés, sur un VPS), `noah-agent-*` et `noah-browser-*` (un par agent).

### Le socket Docker

Le lanceur, et lui seul, monte `/var/run/docker.sock`. Ce montage donne l'équivalent d'un accès root à la machine : qui contrôle le lanceur peut créer n'importe quel conteneur, monter n'importe quel dossier de l'hôte. C'est le prix pour qu'une app crée et mette à jour les machines des agents toute seule. Ce qui le limite :

- le lanceur n'a aucun port publié ; il n'écoute que sur le réseau Docker interne, derrière le serveur ;
- sur un VPS, chaque appel exige sa clé, tirée au hasard à l'installation et rangée dans le volume des secrets (`0600`), jamais dans une variable d'environnement visible par `docker inspect` ou le Docker Manager de Hostinger ;
- il ne lance que des images fixes (Hermes, Camoufox) ou signées (mises à jour), sans privilège, et ne monte un dossier de l'hôte que s'il fait partie des racines autorisées (`NOAH_SHARE_ROOTS`) ;
- les agents et leurs navigateurs n'ont jamais accès au socket.

Si tu installes Noah à côté d'autres projets sur un VPS de Hostinger, garde-le dans son propre projet Docker : un autre conteneur qui monterait aussi le socket aurait les mêmes pouvoirs.

### Ce qui sort de ton serveur

Réglages > Confidentialité liste chaque flux sortant, construit depuis la configuration en service : le fournisseur et le modèle de chaque agent, les sites que visitent les agents, les mises à jour, les notifications. Aucune télémétrie. Pendant que tu as la main sur l'écran d'un agent (connexion, code), son navigateur refuse toute capture.

## Comment ça marche

### Relais de modèle et budget

Les agents n'ont jamais la clé du fournisseur. Ils appellent `noah-server` (`/relay/v1`, compatible OpenAI) avec un jeton propre à chacun ; le serveur ajoute la clé, transmet la requête et enregistre les jetons et le coût de chaque appel (exact avec OpenRouter, estimé avec les prix publics chez les grands fournisseurs, estimé au catalogue pour la synthèse vocale). Un budget mensuel optionnel bloque les appels une fois atteint. La dépense du mois s'affiche en bas de la colonne de gauche.

### Navigateur et écran de l'agent

Chaque agent a son navigateur [Camoufox](https://camoufox.com) (Firefox anti-détection), dans un conteneur `noah-browser-*` construit sur [camofox-browser](https://github.com/jo-inc/camofox-browser) avec un petit bureau (fichiers, éditeur de texte, sans terminal), que Hermes pilote nativement (`CAMOFOX_URL`). Le profil (cookies, sessions connectées) est gardé dans un volume.

L'onglet « Ordinateur » ouvre l'écran du navigateur en direct (noVNC, relayé par le serveur derrière ta connexion). « Prendre le contrôle » passe en mode interactif : tu te connectes toi-même à un site ou tu résous un CAPTCHA. L'agent a pour consigne de ne jamais demander de mot de passe dans la conversation : quand une étape est la tienne, il t'appelle (`noah.py appeler`). Un bandeau s'affiche au-dessus de la conversation, son écran s'ouvre, une notification arrive sur l'ordinateur, et il attend ton « C'est fait » pour reprendre.

### Comptes : Google

Détails > Connexions > Google : tu coches ce que l'agent peut faire (lire ou écrire tes courriels, voir ou modifier ton agenda, lire ou modifier Drive, Docs et Sheets, voir tes contacts). Ce choix vaut accord : tu n'as ensuite qu'à te connecter à ton compte Google. Noah Agent étant auto-hébergé, il passe par ta propre application Google :

1. La première fois, l'agent la crée dans son navigateur en suivant une recette (`noah.py recette google`) : projet Google Cloud, API utiles, écran d'accord, toi comme testeur, ID client « Application de bureau ». Il accepte lui-même les conditions de Google Cloud et ne t'appelle que pour te connecter ; l'appel se ferme seul une fois connecté.
2. Noah Agent ouvre la page d'accord dans le navigateur de l'agent et la valide lui-même (compte, avertissement, accès cochés). Google renvoie vers une adresse locale qui ne répond pas ; Noah Agent lit le code dans la barre d'adresse et l'échange, sans rien à recopier.
3. L'application reste en mode Test (publier exigerait un site et des règles de confidentialité). Google y coupe l'accès au bout de 7 jours : Noah Agent refait l'accord tout seul tous les 6 jours.

Les identifiants servent ensuite à tous tes agents ; chaque agent a son propre jeton, limité aux accès cochés. Si tu as déjà un fichier d'identifiants, « J'ai déjà un fichier d'identifiants » saute l'étape 1.

### Fichiers et images

- Joindre : bouton « + », glisser-déposer ou coller dans la zone de message. Les fichiers arrivent dans `/opt/data/workspace/uploads/` et le message les cite à l'agent.
- L'onglet « Fichiers » liste l'espace de travail de l'agent (livrables, applications, captures, envois) avec téléchargement et aperçu. Les applications web générées s'ouvrent dans un bac à sable sans accès à la session Noah Agent.
- Quand un agent veut montrer une capture, il l'enregistre dans `/opt/data/workspace/captures/` et écrit `MEDIA:/chemin.png`. L'interface l'affiche dans la conversation. Le lanceur ne sert que des images, et seulement depuis les dossiers de travail de l'agent.

### Cache de prompt

Le début du prompt de chaque agent (identité, capacités) est un texte fixe ; le rôle propre vient à la fin. Les fournisseurs mettent ce préfixe en cache. Pour Claude, Kimi et Qwen, qui demandent des marqueurs explicites, le relais est déclaré à Hermes comme route avec `prompt_caching`. La part lue depuis le cache s'affiche dans l'onglet « Détails ».

### Développer l'interface

`frontend/` : Vite + React + TypeScript + Tailwind, avec [assistant-ui](https://www.assistant-ui.com) pour le chat et des composants dans l'esprit de shadcn/ui. L'image Docker du serveur la compile et la sert. Pour la développer avec rechargement à chaud (le serveur Noah Agent doit tourner dans Docker) :

```bash
cd frontend && npm install && npm run dev
```

Puis ouvre http://localhost:5173 (l'API et l'écran noVNC sont relayés vers le port 8080). Avant tout déploiement, `node scripts/verifier.mjs` lance en local ce que la CI vérifierait.

Feuille de route : [roadmap.md](roadmap.md). Architecture : [architecture.html](architecture.html).
