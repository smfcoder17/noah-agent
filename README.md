# Noah Agent

Des agents personnels auto-hébergés, construits sur [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Noah Agent ajoute une interface simple au-dessus d'Hermes : un compte local, le choix du modèle en quelques clics,
plusieurs agents isolés, et un chat qui montre ce que fait l'agent sans afficher ses prompts ni ses commandes.

## Démarrer

Le guide complet, du premier lancement au téléphone : [docs/installation.md](docs/installation.md).

Prérequis : Docker (Docker Desktop sous Windows et macOS).

```sh
sh install.sh
```

Puis ouvre http://localhost:8080 :

1. crée le compte administrateur (il reste sur ta machine) ;
2. choisis un fournisseur (Ollama, Ollama Cloud, un serveur compatible OpenAI, OpenRouter, Anthropic, OpenAI ou Gemini) et le modèle ;
3. ton premier agent, « Assistant », démarre en une trentaine de secondes ;
4. crée d'autres agents avec « + Nouveau » : un nom et un rôle suffisent.

### Avec Ollama

Ollama doit tourner sur la machine hôte. Les agents le joignent via `host.docker.internal:11434`.
Les modèles `:cloud` d'Ollama fonctionnent aussi. Choisis un modèle qui gère les outils (*tools*).

### Depuis ton téléphone

Un téléphone a besoin d'une adresse HTTPS : sans elle, le navigateur refuse l'installation, le micro et les
notifications. Sur un VPS, Noah en a une dès le départ. Sur ton ordinateur, `tailscale serve 8080` en donne une à
tes appareils Tailscale.

Ouvre Noah à cette adresse, puis **Réglages → Appareils** affiche un QR code à usage unique (10 min) : le téléphone
qui le scanne arrive connecté. Le QR code n'apparaît que sur une page en HTTPS.

### Sur un VPS (accessible partout, en HTTPS)

Un VPS Linux (Ubuntu ou Debian) avec 4 Go de RAM, les ports 80 et 443 libres. Aucun nom de domaine n'est nécessaire.

- **Hostinger** : VPS > Docker Manager > Compose > « Compose from URL », colle
  `https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml`, puis Deploy. Le lien de création du compte s'affiche dans les journaux du service
  `server`.
- **Ailleurs**, en root : `curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | sh`

Noah répond en HTTPS sur `<ip-en-tirets>.sslip.io` (ou ton domaine : `NOAH_DOMAIN=noah.exemple.com` devant la
commande). Le lien affiché porte un code d'installation à usage unique : personne d'autre ne peut créer le compte.
Relie ensuite ton ordinateur et ton téléphone depuis Réglages > Appareils.

### Mises à jour

Noah se met à jour seul, dépendances comprises (Hermes, le navigateur, Caddy) : chaque version publiée fixe
leurs images par empreinte, dans un manifeste signé. Le serveur le lit toutes les heures, télécharge la nouvelle
version à l'avance et l'installe pendant ton créneau calme, dans ton fuseau (de 3 h à 6 h, ou les heures où tu
n'utilises pas Noah). Jamais pendant une tâche, une validation, un écran ouvert ou juste avant une routine.
Tout est sauvegardé avant (bases SQLite vérifiées) ; si un composant ne répond plus, l'ancienne version revient
avec ses données. Une version majeure attend 7 jours (ou un clic). Tout se règle dans Réglages > Mises à jour.

Pour publier des versions signées depuis ton dépôt : `python scripts/release-manifest.py cle`, puis le secret
`NOAH_RELEASE_KEY` et la variable `NOAH_UPDATE_KEY` dans GitHub Actions ; chaque étiquette `vX.Y.Z` publie les
images et le manifeste.

### Sauvegardes

```sh
sh scripts/backup.sh                                   # backups/noah-AAAAMMJJ-HHMM.tar, garde les 7 dernières
sh scripts/restore.sh backups/noah-20261030-0300.tar   # restaure, ici ou sur un nouveau serveur
```

Une sauvegarde contient le compte et l'historique, la machine de chaque agent (mémoire, routines, fichiers,
connexions), son navigateur (sessions de sites) et le `.env`, qui porte la clé de chiffrement : garde-la en lieu sûr.
Pour une sauvegarde chaque nuit, ajoute avec `crontab -e` :
`0 3 * * * cd /chemin/vers/noah-agent && sh scripts/backup.sh >> backups/backup.log 2>&1`.

### Application de bureau

```sh
cd desktop && npm install && npm start    # npm run dist : installateur Windows dans desktop/dist/
```

L'application démarre Noah avec Docker Desktop, ouvre l'interface dans sa propre fenêtre et reste dans la zone
de notification quand on la ferme, pour que les routines continuent. Elle donne le vrai sélecteur de dossier pour
**Détails → Dossiers** : tu confies à un agent des dossiers de ton ordinateur, en lecture seule ou en écriture,
et l'un d'eux devient son dossier de travail (là où il range ce qu'il crée, même pendant une routine).

Le partage n'est possible que sous les racines de `NOAH_SHARE_ROOTS` dans `.env` (l'application y met ton dossier
personnel au premier lancement ; plusieurs racines séparées par `;`). Les dossiers de clés et de réglages
(`.ssh`, `.aws`, `AppData`, `.config`…) sont toujours refusés. Sur un VPS, laisse la variable vide : le partage
est coupé.

## Ce qui tourne

| Service | Rôle |
|---|---|
| `noah-server` | API, comptes, traduction des événements d'Hermes, interface web. Seul port exposé. |
| `noah-launcher` | Seul service qui parle à Docker. Crée un conteneur par agent à partir d'une image fixe, sans privilège ni montage de l'hôte. |
| `noah-agent-*` | Un conteneur Hermes par agent, avec son volume (mémoire, fichiers). Jamais exposé. |

Les données sont dans les volumes Docker `noah_noah-data` (compte, clé chiffrée, historique)
et `noah-agent-*` (un par agent). `sh scripts/reset.sh` efface tout.

### Le socket Docker

Le lanceur, et lui seul, monte `/var/run/docker.sock`. Ce montage donne l'équivalent d'un accès root à la machine :
qui contrôle le lanceur peut créer n'importe quel conteneur, monter n'importe quel dossier de l'hôte. C'est le prix pour
qu'une app crée et mette à jour les machines des agents toute seule. Ce qui le limite :

- le lanceur n'a aucun port publié ; il n'écoute que sur le réseau Docker interne, derrière le serveur ;
- chaque appel exige sa clé, tirée au hasard à l'installation et rangée dans le volume des secrets (`0600`), jamais
  dans une variable d'environnement visible par `docker inspect` ou le Docker Manager de Hostinger ;
- il ne lance que des images fixes (Hermes, Camoufox) ou signées (mises à jour), sans privilège, et ne monte un dossier
  de l'hôte que s'il fait partie des racines autorisées (`NOAH_SHARE_ROOTS`) ;
- les agents et leurs navigateurs n'ont jamais accès au socket.

Si tu installes Noah à côté d'autres projets sur un VPS de Hostinger, garde-le dans son propre projet Docker : un autre
conteneur qui monterait aussi le socket aurait les mêmes pouvoirs.

### Ce qui sort de ton serveur

Réglages → Confidentialité liste chaque flux sortant, construit depuis la configuration en service : le fournisseur
et le modèle de chaque agent, les sites que visitent les agents, les mises à jour, les notifications. Aucune
télémétrie. Pendant que tu as la main sur l'écran d'un agent (connexion, code), son navigateur refuse toute capture.

## Interface

`frontend/` : Vite + React + TypeScript + Tailwind, avec [assistant-ui](https://www.assistant-ui.com)
pour le chat (runtime « external store » branché sur nos événements SSE) et des composants
dans l'esprit de shadcn/ui. L'image Docker du serveur la compile et la sert ; rien à installer
pour l'utilisateur.

Pour la développer avec rechargement à chaud (le serveur Noah Agent doit tourner dans Docker) :

```sh
cd frontend && npm install && npm run dev
```

puis ouvre http://localhost:5173 (l'API et l'écran noVNC sont relayés vers le port 8080).

## Relais de modèle et budget

Les agents n'ont jamais la clé du fournisseur. Ils appellent `noah-server` (`/relay/v1`, compatible OpenAI)
avec un jeton propre à chacun ; le serveur ajoute la clé, transmet la requête et enregistre les jetons
et le coût de chaque appel (exact avec OpenRouter, estimé avec les prix publics chez les grands fournisseurs, estimé
au catalogue pour la synthèse vocale). Ollama et un serveur compatible OpenAI comptent 0 $ : Noah n'a pas leur tarif,
et un plafond ne les arrête donc pas. Un budget mensuel optionnel bloque les appels une fois atteint. La dépense du mois s'affiche en bas
de la colonne de gauche.

## Navigateur et écran de l'agent

Chaque agent a son navigateur [Camoufox](https://camoufox.com) (Firefox anti-détection), dans un conteneur
`noah-browser-*` basé sur [camofox-browser](https://github.com/jo-inc/camofox-browser), que Hermes pilote
nativement (`CAMOFOX_URL`). Le profil (cookies, sessions connectées) est gardé dans un volume.

Le bouton « Ordinateur » ouvre l'écran du navigateur en direct (noVNC, relayé par le serveur derrière ta
connexion). « Prendre le contrôle » passe en mode interactif : tu te connectes toi-même à un site ou tu
résous un CAPTCHA. L'agent a pour consigne de ne jamais demander de mot de passe dans la conversation : quand
une étape est la tienne, il t'appelle (`noah.py appeler`). Un bandeau s'affiche au-dessus de la conversation, son
écran s'ouvre, une notification arrive sur l'ordinateur, et il attend ton « C'est fait » pour reprendre.

## Comptes : Google

Détails → Connexions → Google : tu coches ce que l'agent peut faire (lire ou écrire tes courriels, voir ou
modifier ton agenda, lire ou modifier Drive, Docs et Sheets, voir tes contacts). Ce choix vaut accord : tu n'as
ensuite qu'à te connecter à ton compte Google. Noah Agent étant auto-hébergé, il passe par ta propre application Google :

1. La première fois, l'agent la crée dans son navigateur en suivant une recette (`noah.py recette google`) :
   projet Google Cloud, API utiles, écran d'accord, toi comme testeur, ID client « Application de bureau ». Il
   accepte lui-même les conditions de Google Cloud et ne t'appelle que pour te connecter ; l'appel se ferme seul
   une fois connecté.
2. Noah Agent ouvre la page d'accord dans le navigateur de l'agent et la valide lui-même (compte, avertissement,
   accès cochés). Google renvoie vers une adresse locale qui ne répond pas ; Noah Agent lit le code dans la barre
   d'adresse et l'échange, sans rien à recopier.
3. L'application reste en mode Test (publier exigerait un site et des règles de confidentialité). Google y coupe
   l'accès au bout de 7 jours : Noah Agent refait l'accord tout seul tous les 6 jours.

Les identifiants servent ensuite à tous tes agents ; chaque agent a son propre jeton, limité aux accès cochés.
Si tu as déjà un fichier d'identifiants, « J'ai déjà un fichier d'identifiants » saute l'étape 1.

## Fichiers

- Joindre : bouton « + », glisser-déposer ou coller dans la zone de message. Les fichiers arrivent dans
  `/opt/data/workspace/uploads/` et le message les cite à l'agent.
- L'onglet « Fichiers » liste l'espace de travail de l'agent (livrables, applications, captures, envois)
  avec téléchargement et aperçu. Les applications web générées s'ouvrent dans un bac à sable sans accès
  à la session Noah Agent.

## Cache de prompt

Le début du prompt de chaque agent (identité, capacités) est un texte fixe ; le rôle propre vient à la fin.
Les fournisseurs mettent ce préfixe en cache. Pour Claude, Kimi et Qwen, qui demandent des marqueurs
explicites, le relais est déclaré à Hermes comme route avec `prompt_caching`. La part lue depuis le cache
s'affiche dans l'onglet « Détails ».

## Images

Quand un agent veut montrer une capture, il l'enregistre dans `/opt/data/workspace/captures/` et écrit
`MEDIA:/chemin.png`. L'interface l'affiche dans la conversation. Le lanceur ne sert que des images,
et seulement depuis les dossiers de travail de l'agent.

## Limites connues

- Le lanceur a accès au socket Docker. Il n'expose qu'un petit vocabulaire, mais reste
  le composant le plus sensible.
- Un seul compte administrateur pour l'instant.
- Noah doit avoir son propre nom d'hôte (`noah.exemple.org`), sans autre service web sur le
  même hôte. Les cookies ne distinguent pas les ports (RFC 6265 §8.5) : un service sur
  `noah.exemple.org:8443` recevrait la session de Noah. Les apps bloquent ces requêtes, mais
  pas une image redirigée vers ce port. L'installation VPS (`get.sh`) respecte cette règle.
- Notifications web : si l'on se déconnecte au moment même où une notification s'affiche,
  son contenu peut apparaître un instant avant d'être refermé (l'API ne permet pas de
  vérifier et d'afficher d'un seul tenant).

## Feuille de route

1. ~~Un agent derrière une interface simple.~~
2. ~~Plusieurs agents, un conteneur chacun, historique, version mobile.~~
3. ~~Relais de modèle (clé hors des agents, budgets), choix du modèle par catalogue, images.~~
   ~~Navigateur Camoufox, vue en direct et prise de contrôle, fichiers.~~
   ~~Nouvelle interface (assistant-ui + shadcn).~~ ~~Modèle par agent.~~
4. ~~Veille programmatique (collecte sans LLM, triage par petit modèle).~~ ~~Google (Gmail, Agenda, Drive) en un accord.~~
   Microsoft (Outlook, Calendrier, OneDrive) sur le même modèle.
5. ~~App desktop, appairage du téléphone par QR code, installation en une commande sur VPS.~~ App mobile native.

L'architecture complète est décrite dans [docs/architecture.html](docs/architecture.html).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Le code est public et gratuit pour tout usage personnel et non commercial, y compris par une école, une association ou un organisme public. Un usage commercial demande un accord à part.

Ce n'est pas une licence « open source » au sens de l'OSI, qui interdit de restreindre le commerce : Noah Agent est à code source ouvert, avec cette restriction. Les dépendances gardent leurs licences, voir [docs/licences.md](docs/licences.md).
