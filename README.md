# Noah Agent

Une alternative privée aux agents hébergés : tes agents tournent sur ton serveur, pas chez un service tiers.

Noah sert à qui veut un assistant qui travaille 24 h/24, joignable depuis l'ordinateur et le téléphone, sans lui confier ses conversations. Plusieurs agents, chacun avec sa mémoire, son navigateur et ses fichiers. Tu choisis le modèle : local avec Ollama, ou la clé d'un fournisseur.

Tes conversations, ta mémoire et tes clés restent sur ton serveur. Elles ne partent que vers le fournisseur de modèle choisi, et vers les sites et les outils que tu confies à tes agents. Aucune télémétrie. La liste de ce qui sort est dans Réglages > Confidentialité.

Noah est construit sur [Hermes Agent](https://github.com/NousResearch/hermes-agent). Il y ajoute plusieurs agents isolés, un navigateur par agent, des applications de bureau et Android, aucun fournisseur imposé, et des mises à jour avec retour arrière.

## Installer

Trois voies. Toutes finissent sur la même page : créer ton compte, choisir ton modèle, créer ton premier agent.

Tu préfères confier le déploiement à un agent (Codex, Claude Code) ? Donne-lui l'adresse de ce dépôt et demande-lui de suivre [AGENTS.md](AGENTS.md).

> **À savoir aujourd'hui.** Aucune version n'est encore publiée. Les voies 1 et 2 ne marcheront qu'après la première. Seule la voie 3 marche, car elle compile tout depuis le code.

Pour un serveur, il faut Ubuntu ou Debian, 4 Go de mémoire au moins, et les ports 80 et 443 libres.

### 1. Hostinger, sans taper de commande

1. Dans ton VPS, ouvre Docker Manager > Compose > « Compose from URL ».
2. Colle cette adresse :

   ```text
   https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml
   ```

   Colle bien l'adresse de ce fichier. L'adresse du dépôt mènerait au mauvais fichier.
3. Nomme le projet `noah`, exactement. Les sauvegardes s'appuient sur ce nom.
4. Clique sur Deploy.
5. Ouvre les journaux du projet (View logs). Le lien de création du compte s'y affiche.

Un autre projet utilise déjà les ports 80 et 443 ? Lis [Derrière un Traefik](docs/installation.md#derrière-un-traefik).

### 2. Ailleurs, par une commande

En root sur le serveur :

```sh
curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | NOAH_DOMAIN=noah.exemple.com sh
```

Sans sous-domaine, retire `NOAH_DOMAIN=noah.exemple.com`. La commande installe Docker s'il manque, place Noah dans `/opt/noah`, puis affiche le lien de création du compte.

### 3. En local, sur ton ordinateur

Installe [Docker Desktop](https://docs.docker.com/get-docker/) et démarre-le. Puis, dans une copie de ce dépôt :

```sh
sh install.sh
```

Ouvre http://localhost:8080. Noah reste sur ta machine : il n'est pas ouvert au réseau.

### Premier lancement

Le lien porte un code à usage unique : personne d'autre ne peut créer le compte. Ouvre-le, puis laisse-toi guider :

1. « Nouvelle installation », ou « Restaurer une sauvegarde ».
2. Ton compte. Le mot de passe se choisit ici, dans ton navigateur.
3. Ton modèle et sa clé. La clé reste chiffrée sur ton serveur, et les agents ne la voient jamais.
4. Ton premier agent, puis un premier échange.

Le détail des fournisseurs, de la voix et des outils est dans [docs/installation.md](docs/installation.md).

## Relier le bureau

Installe l'application de bureau : l'installateur Windows est sur la [page des versions](https://github.com/smfcoder17/noah-agent/releases/latest). Sans version publiée, construis-le sous Windows : `cd desktop && npm install && npm run dist`. Il arrive dans `desktop/dist/`.

1. Au premier lancement, choisis « Sur mon serveur ».
2. Saisis l'adresse de ton Noah, en `https://`, puis clique sur « Relier ».
3. Ton navigateur s'ouvre. Connecte-toi si besoin, puis clique sur « Autoriser cet appareil ».
4. Recopie dans l'application le nombre affiché par le navigateur.

Ton mot de passe n'est jamais tapé dans l'application. L'application fermée reste dans la zone de notification.

## Relier le téléphone

**Android.** Installe l'APK de la [page des versions](https://github.com/smfcoder17/noah-agent/releases/latest) (`app-debug.apk`).

1. Sur l'ordinateur, ouvre Noah, puis Réglages > Appareils > « Relier un appareil ». Un QR code s'affiche, valable 10 minutes.
2. Dans l'app, touche « Scanner le QR code ». Sans appareil photo, saisis l'adresse et le code court.
3. L'app affiche un nombre à 3 chiffres. Recopie-le sur l'ordinateur, sous « Un appareil a utilisé ton code », puis clique sur « Autoriser ».

**iPhone ou autre.** Il n'y a pas encore d'app. Scanne le QR code avec l'appareil photo, ou ouvre l'adresse HTTPS de ton Noah, puis « Ajouter à l'écran d'accueil ».

Le QR code n'apparaît que sur une page en HTTPS. Sur ton ordinateur, `tailscale serve 8080` en donne une à tes appareils Tailscale.

## Adresse et domaine

**Conseillé : un sous-domaine à toi,** par exemple `noah.exemple.com`. L'adresse est simple et ne montre pas de chiffres. Le HTTPS se règle seul.

1. Chez ton fournisseur de domaine, crée un enregistrement A : le nom `noah` pointe vers l'IP de ton serveur.
2. Donne ce nom à Noah :
   - **Hostinger :** dans le YAML Editor du projet, remplace `NOAH_DOMAIN: ${NOAH_DOMAIN:-auto}` par `NOAH_DOMAIN: noah.exemple.com`, puis redéploie.
   - **Commande :** relance la commande de la voie 2 avec ton sous-domaine. Tes données ne bougent pas.

**En secours, sans domaine :** Noah répond sur `<ip-en-tirets>.sslip.io`, par exemple `203-0-113-7.sslip.io`, avec un vrai certificat. Rien à régler, mais l'IP se lit dans l'adresse.

**Ce qu'un sous-domaine ne fait pas :** il retire l'IP de l'adresse, il ne cache pas ton serveur. N'importe qui peut lire vers où pointe un nom. Seul un relais comme le proxy de Cloudflare cache vraiment l'IP, et ce relais voit alors passer ton trafic. Noah n'a pas encore été testé derrière un relais : lis [Cacher l'IP](docs/installation.md#cacher-lip-du-serveur) avant de l'essayer.

## Mises à jour

Sur un serveur, Noah se met à jour seul : il sauvegarde d'abord, installe pendant ton créneau calme (3 h à 6 h par défaut), et revient à l'ancienne version si un composant ne répond plus. Une version majeure attend 7 jours ou un clic. Tout se règle dans Réglages > Mises à jour.

En local : `git pull && sh install.sh`.

## Sauvegardes

Depuis le dossier de Noah (`/opt/noah` avec la voie 2, la copie du dépôt avec la voie 3) :

```sh
sh scripts/backup.sh                                   # backups/noah-AAAAMMJJ-HHMM.tar, garde les 7 dernières
sh scripts/restore.sh backups/noah-20261030-0300.tar   # restaure, ici ou sur un nouveau serveur
```

Une sauvegarde contient ton compte, l'historique, la machine et le navigateur de chaque agent, et la clé qui déchiffre tes secrets. Range-la en lieu sûr. Voie Hostinger et sauvegarde chaque nuit : [docs/installation.md](docs/installation.md#sauvegarder).

## Pour aller plus loin

- [Guide complet](docs/installation.md) : chaque voie en détail, modèles, voix, problèmes courants, ce qui tourne sur le serveur.
- [État réel du projet](docs/etat.md) : ce qui est prouvé, parcours par parcours. Ce guide n'a pas encore été suivi de bout en bout sur un VPS neuf ni sur un vrai téléphone.
- [Architecture](docs/architecture.html).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Le code est public et gratuit pour tout usage personnel et non commercial, y compris par une école, une association ou un organisme public. Un usage commercial demande un accord à part.

Ce n'est pas une licence « open source » au sens de l'OSI, qui interdit de restreindre le commerce : le code est ouvert à la lecture, avec cette restriction. Les dépendances gardent leurs licences : voir [docs/licences.md](docs/licences.md).
