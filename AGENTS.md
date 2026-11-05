# Déployer Noah Agent

Tu es un agent de déploiement. Ta mission : installer Noah sur le VPS de la personne, puis lui remettre le lien de création du compte. La personne fait le reste dans son navigateur.

Tu travailles sur le code de Noah, sans déployer ? Ce fichier ne te concerne pas : `node scripts/verifier.mjs` lance les tests en local.

Parle à la personne en français clair, sans jargon. Toute commande ci-dessous se lance sur le VPS, en root, sauf mention contraire.

## Ce qui appartient à la personne

- **Mot de passe, clés d'API, choix du modèle :** elle les saisit elle-même dans son navigateur. Si elle te donne une clé dans la conversation, ne t'en sers pas : renvoie-la vers Réglages > Cerveau et conseille-lui de la renouveler.
- **Lien d'installation :** il porte un code à usage unique. Remets-le à la personne seule, dans la conversation. Il reste hors des fichiers, des tickets et des commits. Elle l'ouvre elle-même.
- **Données :** les volumes `noah_noah-*` et `noah-agent-*` portent son compte et ses clés. Avant tout geste qui efface (Delete du projet, `docker compose down -v`, `docker volume rm`), obtiens son accord explicite.

## Ce que tu demandes, et quand

| Question | Quand | Si pas de réponse |
|---|---|---|
| Comment accéder au VPS : SSH root, ou API et MCP Hostinger ? | Étape 2 | Guide la personne dans le panneau Hostinger (branche C) |
| As-tu un sous-domaine pour Noah, comme `noah.exemple.com` ? | Étape 3 | Secours : `<ip-en-tirets>.sslip.io` |
| Ce serveur héberge-t-il d'autres sites ? | Étape 2 | Lis la réponse dans les ports |

Pour le sous-domaine, dis-lui ceci : « Sans domaine, l'adresse contient l'IP du serveur. Avec un sous-domaine, l'adresse est simple, mais qui consulte le DNS trouve quand même l'IP. Seul un relais comme Cloudflare la cache vraiment, et il voit alors passer le trafic. Noah n'a pas été testé derrière un relais. »

## Étapes

### 1. Vérifier qu'une version est publiée

Depuis n'importe où :

```sh
curl -sL -o /dev/null -w '%{http_code}\n' https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml
```

**Fini quand :** la réponse est `200`.

Sinon, arrête-toi ici. Dis à la personne : « Aucune version de Noah n'est publiée pour l'instant, donc l'installation sur un serveur ne peut pas aboutir. Seule l'installation sur un ordinateur marche (`sh install.sh`). » Le `docker-compose.yml` à la racine sert à cette installation locale, jamais à un VPS : il compile sur place et laisse les clés dans des variables d'environnement.

### 2. Examiner le serveur

Demande d'abord comment accéder au VPS. Sans shell (branches B et C), obtiens ces points par l'API Hostinger (`GET /api/vps/v1/virtual-machines/{id}` et `.../docker`), ou demande à la personne de lancer ces commandes dans la Web Console.

```sh
. /etc/os-release; echo "$ID"
uname -m
free -g | awk '/Mem:/{print $2" Go"}'
df -h / | tail -1
docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null
ss -ltnp 'sport = :80 or sport = :443'
curl -4 -fsS https://api.ipify.org
```

**Fini quand :** tu as noté chacun de ces points :

- système Ubuntu ou Debian, architecture `x86_64` ou `aarch64`. Autre cas : `get.sh` n'est pas prévu pour, signale-le ;
- mémoire de 4 Go au moins, et 10 Go libres sur le disque. En dessous, préviens la personne avant de continuer ;
- l'IP publique ;
- les ports 80 et 443 : libres, tenus par un conteneur dont l'image contient `traefik`, tenus par autre chose, ou tenus par `noah-caddy` ;
- un conteneur `noah-server` déjà présent ou non.

`noah-server` présent : Noah est déjà installé. Passe à [Déjà installé](#déjà-installé).
Ports tenus par autre chose qu'un Traefik : demande à la personne quoi faire de ce service. Installer Noah à côté échouerait.

### 3. Préparer l'adresse

Propose d'abord le sous-domaine. Sans sous-domaine, passe à l'étape 4 : l'adresse sera `<ip-en-tirets>.sslip.io`.

Avec un sous-domaine, demande à la personne de créer un enregistrement A, du nom vers l'IP de l'étape 2, en mode « DNS seulement » si son fournisseur a un relais. Vérifie :

```sh
getent hosts noah.exemple.com
```

**Fini quand :** le nom donne l'IP de l'étape 2, ou la personne a choisi le secours sslip.io. Attends et réessaie : un nouveau nom peut prendre plusieurs minutes. Déployer avant coûterait un certificat refusé.

### 4. Déployer

Prends une seule branche. Dans chacune, l'URL est celle du **fichier**. L'URL du dépôt (`https://github.com/smfcoder17/noah-agent`) ne convient pas : Hostinger la traduit en fichier compose de la branche `master`, qui n'existe pas ici.

**A. SSH.**

```sh
curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | NOAH_DOMAIN=noah.exemple.com sh
```

Sans sous-domaine, retire `NOAH_DOMAIN=noah.exemple.com`. La variable se place devant `sh`, jamais devant `curl`. Avec un Traefik en place, le script se range derrière lui ; fais ensuite `docker network connect noah-net <nom-du-conteneur-traefik>`. Installation dans `/opt/noah`.

**B. API ou MCP Hostinger.** Outil `VPS_createNewProjectV1` (`POST /api/vps/v1/virtual-machines/{id}/docker`) :

- `project_name` : `noah`, exactement ;
- `content` : `https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml` ;
- `environment` : `NOAH_DOMAIN=noah.exemple.com`, ou rien sans sous-domaine.

Un projet du même nom serait remplacé : l'étape 2 doit avoir écarté ce cas. Avec un Traefik en place, `content` devient `https://raw.githubusercontent.com/smfcoder17/noah-agent/main/deploy/docker-compose.traefik.yml`, `NOAH_DOMAIN` est obligatoire, et il reste à connecter le réseau comme en A.

**C. Panneau Hostinger, par la personne.** Dicte-lui : VPS > Manage > Docker Manager > Compose > « Compose from URL », l'URL de `content` ci-dessus, le nom de projet `noah`, puis Deploy. Avec un sous-domaine, elle remplace ensuite dans le YAML Editor du projet `NOAH_DOMAIN: ${NOAH_DOMAIN:-auto}` par `NOAH_DOMAIN: noah.exemple.com`, puis redéploie. Ce panneau change parfois : fie-toi à ce qu'elle voit à l'écran et décris le but, pas le bouton.

**Fini quand :** le déploiement s'est terminé sans erreur, ou la personne confirme que Deploy a abouti. Le téléchargement prend quelques minutes.

### 5. Vérifier l'installation

Avec un accès au VPS :

```sh
docker ps --filter name=noah- --format '{{.Names}} {{.Status}}'
docker volume ls --format '{{.Name}}' | grep '^noah_noah-'
docker exec noah-server printenv NOAH_DOMAIN
docker logs noah-server 2>&1 | grep -E 'installation=|Noah est prêt :' | tail -1
```

Puis, avec l'adresse lue dans le journal (répète pendant 3 minutes : le premier certificat se demande à la première visite) :

```sh
curl -fsS https://noah.exemple.com/api/status
```

Sans accès au VPS, la personne lit le lien dans le menu du projet (⋮) > View logs, et l'API Hostinger donne `GET .../docker/noah/logs`.

**Fini quand :** tout ceci est vrai à la fois :

- `noah-server`, `noah-launcher` et `noah-caddy` sont `Up`, sans `Restarting` (derrière Traefik, pas de `noah-caddy`) ;
- `noah_noah-data` et `noah_noah-secrets` existent. Un autre préfixe veut dire que le projet ne s'appelle pas `noah` : les sauvegardes ne le trouveraient pas ;
- `NOAH_DOMAIN` vaut le sous-domaine, ou `auto` ;
- le journal donne un lien en `https://…/?installation=…` ;
- `/api/status` répond en HTTPS valide, avec `"has_account":false`, `"setup_code":true` et `"secrets_lisibles":true`.

### 6. Remettre le lien

Donne le lien à la personne, avec ceci :

> Ouvre ce lien dans ton navigateur. Choisis « Nouvelle installation », crée ton compte, puis choisis ton modèle et colle sa clé. Ces informations restent entre toi et ton serveur : je n'en ai pas besoin. Crée ensuite ton premier agent et échange un message avec lui. Son premier démarrage peut prendre quelques minutes, le temps de télécharger son image. Dis-moi quand c'est fait.

Conseil si elle n'a pas de clé : Ollama Cloud est le plus simple sur un VPS. Ollama local n'est pas joignable depuis ce compose.

**Fini quand :** elle confirme, et `/api/status` donne `"has_account":true`, `"model_configured":true`, `"onboarded":true`.

### 7. Relier ses appareils

Ces gestes sont les siens ; guide-la. Chacun passe par un accord qu'elle donne elle-même, avec un nombre à 3 chiffres à recopier.

- **Bureau :** installateur Windows sur `https://github.com/smfcoder17/noah-agent/releases/latest`. « Sur mon serveur », l'adresse en `https://`, « Relier ». Dans le navigateur, « Autoriser cet appareil », puis le nombre dans l'application.
- **Android :** `app-debug.apk` sur la même page. Sur l'ordinateur, Réglages > Appareils > « Relier un appareil ». Dans l'app, « Scanner le QR code ». Le nombre s'affiche sur le téléphone : elle le recopie sur l'ordinateur, puis « Autoriser ».
- **iPhone ou autre :** l'adresse HTTPS dans le navigateur, puis « Ajouter à l'écran d'accueil ».

Pas de fichier sur la page des versions : signale-le, cette étape attendra.

**Fini quand :** chaque appareil voulu apparaît dans Réglages > Appareils, ou la personne remet cette étape à plus tard.

### 8. Rendre compte

**Fini quand :** la personne a reçu, en quelques phrases, son adresse, la voie d'installation et le dossier, ce qui reste à faire, et une offre de sauvegarde chaque nuit (détails : `docs/installation.md`, section « Sauvegarder »). Mets en place la tâche planifiée seulement si elle accepte.

## Déjà installé

Noah se met à jour seul ; ne réinstalle rien pour le mettre à jour. Sers-toi de Réglages > Mises à jour pour voir son état.

- **Changer l'adresse, installation par `get.sh` :** relance la commande de la branche A depuis le même serveur. Les données restent.
- **Changer l'adresse, installation par Hostinger :** demande à la personne de modifier la ligne `NOAH_DOMAIN` dans le YAML Editor. Par l'API, relis le projet (`GET .../docker/noah`) avant tout envoi, et garde son contenu.
- **Compte déjà créé :** le journal ne donne plus de lien, seulement `Noah est prêt : https://…`. Il n'y a pas de lien à remettre.

## En cas d'échec

Diagnostique avec la colonne du milieu, puis applique le geste. Après deux essais sans progrès, arrête-toi et donne à la personne la commande, sa sortie et ton hypothèse. Les secrets de `noah_noah-secrets` chiffrent ses données : les recréer rendrait tout illisible.

| Symptôme | Diagnostic | Geste |
|---|---|---|
| Étape 1 : `404` | Pas de version publiée | Arrête-toi, préviens la personne |
| `manifest unknown` ou `denied` au téléchargement | `docker pull ghcr.io/smfcoder17/noah-server:stable` | Images non publiées : arrête-toi, préviens la personne. Le VPS ne compile rien |
| `port is already allocated` | `docker ps --filter publish=443` | Traefik : voie Traefik de l'étape 4. Autre service : demande à la personne |
| `noah-server` ou `noah-launcher` en `Restarting` | `docker logs <conteneur> --tail 50` | Disque plein : libère de la place. `Secrets illisibles` : volume abîmé, ne recrée rien, rends compte |
| Journal : `adresse publique introuvable` | Le VPS ne joint pas `api.ipify.org` | Vérifie le réseau sortant, ou passe par `NOAH_DOMAIN` |
| Certificat refusé ou `curl` en erreur TLS | `docker logs noah-caddy --tail 50` et `getent hosts` | Nom faux : corrige le DNS. Ports fermés : ouvre 80 et 443 dans le pare-feu de l'hébergeur |
| Quota Let's Encrypt atteint sur sslip.io | `rateLimited` dans le journal de Caddy | Essaie `<ip-en-tirets>.nip.io`, que Noah accepte aussi |
| Derrière Traefik : erreur 404, 502 ou 504 | `docker inspect <traefik> --format '{{json .NetworkSettings.Networks}}'` | Connecte-le à `noah-net`. Vérifie `NOAH_TRAEFIK_RESOLVER` et l'entrée `websecure` |
| `get.sh` : `déjà installé dans …` | Noah vient d'un autre dossier ou de Hostinger | Passe à [Déjà installé](#déjà-installé), sans forcer |
| `/api/status` : `"secrets_lisibles":false` | Clé et données ne correspondent plus | Ne touche à rien, rends compte. Une sauvegarde peut réparer |

Pour aller plus loin : `docs/installation.md` (Traefik, adresse, sauvegardes, ce qui tourne) et `docs/etat.md` (ce qui est prouvé). Ce parcours n'a pas encore été suivi sur un VPS neuf : si une consigne ne correspond pas à ce que tu vois, dis-le à la personne et décris l'écart.
