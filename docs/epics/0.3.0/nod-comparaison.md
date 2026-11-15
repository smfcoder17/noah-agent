# 0.3.0 : Nod (n8n) comparé à Noah (recherche)

Recherche du 15 novembre 2026, sans code de Noah changé. Dépôt lu : `n8n-io/nod`, commit `f41c721` du 14 novembre 2026, cloné en lecture seule (aucun script lancé). Chaque affirmation sur Nod cite le fichier lu, chemin relatif à la racine de leur dépôt. Côté Noah, les chemins sont ceux de cette branche (`feat/020`).

## En bref (pour Franck)

1. **Nod est un agent personnel pour une seule personne**, sur son Mac ou son serveur, avec un serveur Node, un conteneur « atelier » et un conteneur navigateur. Sa force : **toute la politique vit dans le serveur** (juge, coffre, paiements, plafonds), et le modèle ne touche jamais au navigateur ni aux secrets directement.
2. **Noah fait mieux sur le reste du produit** : plusieurs agents, la voix et les appels, l'app Android, l'installation en un clic sur un VPS, les profils et le partage, un navigateur bien plus discret (Camoufox).
3. **Nos deux bugs ont une cause claire, et Nod montre la réparation.** Instagram redemandé : chez nous, c'est l'agent qui doit penser à lire le coffre ; chez Nod, le serveur prend tout seul l'identifiant unique du site. Faux sites « connectés » : chez nous, la liste devine à partir des cookies ; chez Nod, un site n'est connecté qu'après une connexion explicite, vérifiée par le serveur.
4. **Licence Apache 2.0 : on peut reprendre leur code**, en gardant leur mention de copyright. Leur code est en TypeScript, le nôtre en Python : on reprendra surtout des idées, des règles et des textes de consigne.
5. **À décider** : l'ordre des reprises (liste classée plus bas), et si le coffre devient commun à tous les agents d'une personne au lieu d'un coffre par agent.

## 1. Comment Nod est construit

### Processus et services

- Un seul processus Node sert l'interface React, l'API Fastify, l'exécution de l'agent, le travailleur des tours et les routines. Docker fait tourner PostgreSQL, l'atelier et le navigateur (`docs/src/content/docs/how-it-works/architecture.mdx`, `compose.yaml` : services `postgres`, `browser`, `workspace`).
- Chaque message, routine ou événement devient un « tour » rangé dans PostgreSQL, puis repris par une file `pg-boss` (`architecture.mdx`, « One process and a few containers »).
- L'agent tourne avec le moteur open source **Pi**, qui appelle les outils (`README.md`, « Under the hood » ; `src/providers/pi/`).
- Le code est découpé en couches, avec une règle vérifiée par un script : `ports` (interfaces), `providers` (fournisseurs), `runtime` (outils de l'agent), `server` (politique). Seul `src/server/composition.ts` assemble le tout (`architecture.mdx`, « Where the code lives » ; `scripts/check-architecture.mjs`).

### Isolation

- **Atelier** : les commandes tournent sous un utilisateur sans droits, sans `sudo`, sans variables de l'hôte. Le conteneur retire toutes les capacités Linux et pose `no-new-privileges`, avec des limites de mémoire, de CPU et de processus (`docs/src/content/docs/how-it-works/sandbox-and-browser.md`, « The workspace container »).
- **Un superviseur** dans le conteneur tue tout l'arbre d'une commande à la fin ou à l'arrêt, et bloque l'atelier si l'accusé de fin se perd (`sandbox-and-browser.md`, « The command supervisor » ; `src/providers/docker/command.ts`).
- **Pare-feu** : un conteneur à part bloque les adresses privées et les métadonnées du cloud pour l'atelier ; le navigateur ne joint que des adresses publiques, vérifiées à chaque connexion (`sandbox-and-browser.md`, « Limits » ; `docs/src/content/docs/trust/security-model.md`, « Browser » ; `src/providers/agent-browser/network.ts`).
- **Outils en ligne de commande** : chaque outil connecté s'installe sous son propre utilisateur Linux, dans un dossier que lui seul lit, et reçoit son jeton dans un environnement vide. Un programme écrit par le modèle ne reçoit jamais ce jeton (`docs/src/content/docs/connect/mcp-api-cli.md`, « How connected CLIs keep the token safe »).
- **Les clés des fournisseurs ne quittent jamais le serveur** : ni l'atelier, ni le navigateur, ni le prompt (`sandbox-and-browser.md`, tableau « What each part can and can't reach »).

### Règles et accords (« Trust »)

- Avant chaque action dans une app, et chaque geste du navigateur qui envoie, valide ou change quelque chose, le serveur demande à **un seul juge** si la personne l'a demandé (`docs/src/content/docs/trust/approvals.mdx`, introduction ; `src/server/trust.ts`).
- Le juge ne voit que les derniers messages de la personne, ses règles, sa consigne de fond et l'action. Jamais une page, un e-mail ou un résultat d'outil (`approvals.mdx`, « What the checker sees »).
- **« Parce que tu as dit »** : pour laisser passer une action, le juge doit citer mot pour mot les paroles de la personne. Le serveur vérifie que la citation existe vraiment, sinon il demande. La citation s'affiche dans l'historique d'usage (`approvals.mdx`, « Because you said » ; consigne `checkInstructions` dans `src/server/trust.ts`).
- Les lectures, recherches, la navigation et la frappe dans un champ passent sans juge ; seuls les gestes qui engagent passent par lui (`approvals.mdx`, « Browser steps » ; `commits(step)` dans `src/runtime/tools.ts`).
- Un accord est lié à l'action exacte et à ses arguments, et ne sert qu'une fois. Si la page a changé, rien ne part (`approvals.mdx`, « The confirmation » ; `src/server/approvals.ts`).
- La personne fixe des **règles durables** (« demande-moi avant d'écrire hors de l'entreprise ») et une **consigne de fond** pour le travail lancé seul ; une règle « demande d'abord » l'emporte toujours (`approvals.mdx`, « Your rules », « Standing instructions »).

### Coffre (« Vault »)

- Identifiants, clés d'authentificateur et cartes sont chiffrés en AES-256-GCM ; la clé vit hors de la base (trousseau du système, fichier privé ou variable d'environnement) (`docs/src/content/docs/trust/vault.mdx`, « How Vault stores secrets » ; `src/server/vault-crypto.ts`).
- **Le modèle ne voit jamais un secret** : d'un identifiant, il reçoit le nom, le site et les deux premiers caractères de l'identifiant ; d'une carte, la marque, les 4 derniers chiffres et l'expiration (`vault.mdx`, tableau « What the model receives »).
- Le modèle choisit les champs et le bouton ; **le serveur remplit et envoie en une seule étape** que le modèle ne peut pas observer (`vault.mdx`, « How sign-in works »).
- **Origine exacte** : un identifiant ne sert que sur son protocole, son hôte et son port, vérifiés champ par champ, même dans un cadre (`vault.mdx`, « Exact website origins »).
- **Choix automatique** : le serveur liste les identifiants du site ; s'il n'y en a qu'un, il le prend lui-même, sans que le modèle ait à le désigner (`src/server/composition.ts`, lignes 2341-2389 ; description de l'outil `sign_in` dans `src/runtime/tools.ts`, ligne 386 : « one matching login is used automatically »).
- Codes à usage unique : Nod tape lui-même le code d'authentificateur, ou va chercher le code reçu par e-mail dans la boîte connectée, sans que le modèle le voie (`vault.mdx`, « Verification codes » ; `src/server/authenticator.ts`).
- Import depuis un CSV de gestionnaire de mots de passe, ou depuis 1Password par un petit processus à part (`vault.mdx`, « Use a login from 1Password » ; `src/providers/onepassword/`).
- Chaque usage est réservé une fois avant de commencer ; une saisie coupée devient « résultat inconnu », jamais rejouée (`security-model.md`, « One use » ; `src/server/vault-use.ts`).
- Paiements : la carte n'est envoyée qu'après l'accord de la personne pour un paiement précis (boutique, page, destination des champs, bouton, montant), et elle tape elle-même le code de sécurité (`docs/src/content/docs/trust/payments.mdx` ; `src/server/payments.ts`).

### Sites « connectés au navigateur »

- Un site connecté est une **session enregistrée** : la personne demande « connecte-toi à ce site », Nod ouvre **un profil de navigateur neuf, propre à ce site**, elle se connecte, puis Nod l'enregistre (`docs/src/content/docs/trust/browser-sessions.md`, « Save a session » ; `src/server/browser-connections.ts`, lignes 180-208).
- L'enregistrement n'est accepté que si la page est toujours sur le site demandé ; sinon l'état reste « connexion nécessaire » (`browser-connections.ts`, lignes 229-258).
- À chaque usage, si l'ouverture atterrit ailleurs (une page de connexion d'un autre domaine), l'état passe à « Sign-in needed » avec un bouton « Sign in again » (`browser-sessions.md`, « Use a session » ; `browser-connections.ts`, lignes 278-297).
- La liste affichée vient seulement de cette table : « connecté » veut dire état `saved`, rien d'autre (`browser-connections.ts`, lignes 330-350). Les identifiants du coffre sont listés à part, marqués `savedLogin` (`src/server/integrations.ts`, lignes 784-799), et la doc distingue « identifiant retenu » et « session enregistrée » (`browser-sessions.md`, tableau « Saved session or saved login? »).
- Se déconnecter supprime le profil (`browser-sessions.md`, « Sign out »). Une routine ou un travail de fond démarre dans un navigateur neuf, déconnecté (`browser-sessions.md`, « When the browser stays signed in »).

### Navigateur

- Chromium avec écran virtuel, dans un conteneur à part, piloté par le **serveur** via `agent-browser` de Vercel Labs, par un pont fixe. Le modèle lit un instantané d'accessibilité (`sandbox-and-browser.md`, « The browser container »).
- Les secrets connus sont retirés des sorties et masqués sur les captures ; les passkeys sont désactivées (`sandbox-and-browser.md`, « Browser handoff » et paragraphe précédent).
- Prise en main : la personne voit l'onglet en direct dans la conversation et rend la main avec « Return to Nod » (`sandbox-and-browser.md`, « Browser handoff »).
- Rien contre la détection des robots dans ce qu'on a lu : `Dockerfile.browser` part d'une image Node et d'un Chromium ordinaire.

### Mémoire

- Les notes ne viennent **que des messages de la personne** et de ce qu'elle écrit dans Réglages > Mémoire ; jamais d'une page, d'un e-mail ou d'une réponse de Nod. Chaque note garde le lien vers son message d'origine (`docs/src/content/docs/use/memory.md`, « Where Nod learns from »).
- Une note dite une fois est « mentionnée », deux fois « apprise » ; les notes remplacées vont dans « Let go » au lieu d'être effacées (`use/memory.md`, « How a memory grows »).
- Nod écrit aussi ses propres « skills » après une tâche, avec les données personnelles remplacées par des repères (`use/memory.md`, « Skills Nod learns »). Stockage : un document JSON de 256 Kio au plus (`docs/src/content/docs/how-it-works/memory.md`, « Where memory lives »).

### Connecteurs et outils

- Gmail, Agenda, Slack et les autres passent par **Composio**, via un service de connexion hébergé par n8n par défaut. Les jetons restent chez Composio, chaque installation signe ses requêtes (`docs/src/content/docs/connect/apps.mdx`, « How Nod protects app connections »).
- Notion et Linear par leur serveur MCP officiel ; d'autres services par MCP, HTTP ou CLI (`connect/mcp-api-cli.md`).
- Tout résultat d'app, de page ou d'outil arrive au modèle encadré comme donnée non fiable (`src/runtime/untrusted.ts`, fonction `delimit` ; `README.md`, « Untrusted by default »).

### L'argent

- Nod est gratuit ; la personne paie son fournisseur de modèle, ou utilise son forfait ChatGPT (`README.md`, « What does it cost? »).
- **Plafond mensuel de 200 $ posé à la fin de l'installation**. À la limite, routines et travail de fond s'arrêtent avant d'appeler le modèle ; la personne peut encore écrire, mais seulement pour changer le plafond (`docs/src/content/docs/use/spending.md`, « Set a monthly limit », « What happens at the limit » ; `src/server/ledger.ts`).
- **Points d'étape** : une tâche s'arrête et demande la permission de continuer chaque fois qu'elle a dépensé 5 $ depuis le dernier message de la personne (`spending.md`, « Task check-ins »).
- Le travail de fond a son enveloppe à part (5 $ par mois, éteinte au départ) ; chaque appel réserve son coût maximal avant de partir, et **un prix inconnu bloque** au lieu de compter zéro (`spending.md`, « Automatic preparation allowance » ; `src/server/ledger.ts`, réservations lignes 397-457).
- Un modèle sans prix connu s'affiche « No price », jamais 0 $ (`spending.md`, « How each model is priced »).
- Écran Usage : chaque appel de modèle, chaque action et la citation qui l'a permise, avec export CSV (`spending.md`, « See your spending »).

### Plusieurs appareils

- Une seule conversation par propriétaire, partagée entre web, bureau, Telegram et WhatsApp (`architecture.mdx`, « Main ideas »).
- L'app de bureau (Mac, Windows et Linux en préversion) fait tourner Nod en local, ou se relie à un serveur avec son adresse et le jeton `NOD_AUTH_TOKEN` (`docs/src/content/docs/deploy/desktop-app.mdx`, « Connect to your server »).
- **Pas d'app mobile** : le téléphone passe par Telegram ou WhatsApp, et les étapes privées (connexion, paiement) se font dans l'app web ou de bureau (`docs/src/content/docs/use/channels.mdx`, « Private steps happen in the Nod app »).
- Pas encore de version hébergée ni d'équipe : c'est dans « Next on the list » (`README.md`).

## 2. Ce qu'ils font mieux

| Sujet | Nod | Noah aujourd'hui |
|---|---|---|
| Où vit la politique | Dans le serveur, qui pilote aussi le navigateur (`README.md`, « Policy lives in the server » ; `sandbox-and-browser.md`) | Le juge est appelé depuis la machine de l'agent : « C'est un filtre, pas un bac à sable » (`server/noah/juge.py`, docstring) |
| Choix de l'identifiant | Le serveur prend l'unique identifiant du site (`src/server/composition.ts` 2341-2389) | L'agent doit appeler `list` puis `fill` (`server/noah/agent_plugin/__init__.py`, `VAULT_SCHEMA`) |
| Sites connectés | Registre explicite, vérifié, un profil par site (`src/server/browser-connections.ts`) | Liste devinée par les cookies (`server/noah/sites.py`, `live`) |
| Accords | Citation exacte vérifiée, accord lié à l'action et à usage unique (`approvals.mdx`) | 39 accords au titre muet « Faire cette action », accords pour `sleep` et `cd` (`docs/epics/0.3.0/audit-vps-2026-11-14.md`, constat 15) |
| Secrets collés dans la conversation | Un code attendu ne passe pas au modèle, les formes de clé sont retirées (`security-model.md`, « Secrets » ; `src/server/redaction.ts`) | Une clé `sk_` collée est restée en titre de tâche (audit, constat 16) |
| Prix inconnu | « No price », et bloque le travail de fond (`spending.md`) | 0 $ affiché pour 97,8 M de jetons (audit, constat 13) |
| Codes à usage unique | Authentificateur et e-mail pris par le serveur (`vault.mdx`) | La personne tape chaque code (`server/noah/coffre.py`, `enter_code`) |
| Paiements | Carte liée à un paiement précis (`payments.mdx`) | Rien |
| Mémoire | Seulement les mots de la personne, avec la source de chaque note (`use/memory.md`) | Mémoire d'Hermes, sans cette règle écrite dans ce qu'on a lu |
| Isolation réseau | Pare-feu contre les adresses privées, un utilisateur par CLI (`sandbox-and-browser.md`) | Agents et navigateurs sur le même réseau Docker, protégés par clé d'accès (`launcher/launcher.py`, commentaire après la création du navigateur) |
| Mesure | 226 tâches, 3 passages chacune, 0 action dangereuse annoncée (`README.md`, « Measured, not promised ») | 0 parcours tenu sur 10 au niveau exigé (`docs/etat.md`) |

## 3. Ce qu'on fait mieux

- **Navigateur discret** : Camoufox, avec le plan d'empreinte fixe par agent (`docs/epics/0.3.0/navigateur.md`, `audit-vps-2026-11-14.md`). Nod utilise un Chromium ordinaire (`Dockerfile.browser`).
- **Plusieurs agents qui se parlent**, chacun avec son ordinateur (`server/noah/coordination.py`). Nod n'a qu'un assistant par propriétaire (`architecture.mdx`).
- **Voix et appels**, qui font sonner le téléphone (`docs/etat.md`, G10 et G11). Nod n'a que les messages vocaux sur Telegram et WhatsApp (`use/channels.mdx`, « Files and voice messages »).
- **App Android, PWA, appairage par QR code** avec un nombre à 3 chiffres, alerte « nouvel appareil » (`server/noah/appareils.py`). Nod n'a pas d'app mobile.
- **Installation en un clic sur un VPS** et mises à jour seules (`AGENTS.md`, `get.sh` ; G6 au seuil dans `docs/etat.md`). Nod demande Docker Compose et un jeton (`docs/src/content/docs/deploy/self-host.mdx`).
- **Profils et partage d'un agent**, avec des droits révocables (`server/noah/access.py`). Nod est pour une seule personne (`README.md`, « Nod for your team » est à venir).
- **Plafond du jour par agent**, en plus du mois (`server/noah/relay.py`, lignes 161-188).
- **Aucun service tiers obligatoire** : Nod fait passer les apps par le service de n8n et Composio, et envoie des données d'usage à n8n, activé par défaut (`README.md`, « Where does my data go? »).
- **Écran partagé en direct** de l'ordinateur de l'agent (noVNC). Nod montre l'onglet seulement pendant une prise en main (`sandbox-and-browser.md`, « Browser handoff »).

## 4. Nos deux problèmes, et comment Nod les évite

### 4.1 L'agent redemande les identifiants Instagram alors qu'ils sont dans le coffre

**Chez Noah, d'après le code (non reproduit sur le VPS) :**

1. **C'est l'agent qui choisit.** L'outil `browser_vault` propose `list`, `fill` et `save_login` (`server/noah/agent_plugin/__init__.py`, `VAULT_SCHEMA`). Le rappel ajouté sur une page de connexion dit « list, puis fill, ou save_login » (`LOGIN_HINT`, même fichier). Si l'agent saute `list`, il prend `save_login`.
2. **Le serveur ne vérifie pas le coffre avant d'ouvrir la carte.** `_ask` lit la page et ouvre la carte sans regarder `agent_logins` (`server/noah/coffre.py`, lignes 202-234).
3. **Un coffre par agent.** Les identifiants sont rangés par `agent_id` (`coffre.py`, `_rows` et `_remember`, lignes 154-169). Un identifiant donné à BMD n'existe pas chez Noah, comme les sessions du navigateur (audit, constat 3).
4. **L'origine doit être identique.** `_fill_saved` refuse si la page n'a pas exactement l'origine enregistrée (`coffre.py`, ligne 193). Hypothèse à vérifier : un identifiant retenu sur `https://www.instagram.com` ne sert pas sur une page servie depuis une autre origine, et l'agent repasse alors par `save_login`.

**Comment Nod l'évite :**

- Le serveur cherche lui-même les identifiants de l'origine exacte. S'il n'y en a qu'un, il le prend sans que le modèle le désigne. S'il y en a plusieurs, le modèle doit demander lequel (`src/server/composition.ts`, lignes 2341-2389).
- La consigne dit de lire les identifiants du site d'abord, et de ne demander que si le compte est ambigu (`src/runtime/prompt.ts`, ligne 56 ; outil `sign_in`, `src/runtime/tools.ts`, ligne 386).
- Le coffre appartient à la personne, pas à une conversation (`vault.list(ownerId)` dans `composition.ts`, ligne 2341).
- Après une connexion faite à la main, Nod propose une fois de retenir l'identifiant (`src/runtime/prompt.ts`, ligne 56).

**Ce qu'on ferait :** dans `coffre.py`, `_ask(kind="connexion")` regarde d'abord les identifiants du site et remplit tout seul s'il n'y en a qu'un ; la carte ne s'ouvre que s'il n'y a rien, ou plusieurs comptes. À décider par Franck : un coffre par personne, partagé par ses agents, avec un droit par agent. Nod n'a pas ce cas, puisqu'il n'a qu'un assistant par personne.

### 4.2 La liste des sites « connectés » montre des sites où la personne ne s'est jamais connectée

**Chez Noah :** `GET /api/agents/{id}/sites` mélange trois sources (`server/noah/sites.py`) :

1. ce que l'agent déclare lui-même avec `site-connecte`, sans aucune vérification (`agent_note`, lignes 125-131) ;
2. **tous les sites du coffre**, ajoutés d'office comme « retenus » (`listed`, lignes 56-70) ;
3. **une devinette par les cookies** : tout domaine qui a un cookie de plus d'un jour compte comme « session » (`live`, lignes 73-105). Or presque tout site visité pose un cookie durable (choix des cookies, langue, mesure d'audience). Chaque site lu par l'agent finit donc dans la liste. La liste des pisteurs exclus (`TRACKERS`) ne couvre pas ces cookies-là.

En plus, « Retirer » ne tient pas pour ces sites : `forget` efface la ligne enregistrée (lignes 151-158), mais `live` la remet au prochain affichage (lignes 140-148). Et un seul profil par agent porte tous les sites, lectures comprises.

**Comment Nod l'évite :**

- Un site n'est connecté qu'après une demande explicite, dans **un profil neuf propre à ce site** (`src/server/browser-connections.ts`, lignes 180-208).
- Le serveur n'enregistre que si la page est toujours sur ce site (lignes 229-258). La liste ne montre « connecté » que pour l'état `saved` (lignes 330-350) ; aucune lecture de cookies.
- Si un usage atterrit sur une page de connexion d'un autre domaine, l'état passe à « connexion nécessaire » (lignes 278-297).
- Identifiants retenus et sessions sont deux choses distinctes dans l'interface (`browser-sessions.md`, tableau « Saved session or saved login? »).
- Les lectures se font dans un navigateur sans session : routines et tâches de fond démarrent déconnectées (`browser-sessions.md`, « When the browser stays signed in »). Notre plan « Lecture » et « Compte » va dans le même sens (`docs/epics/0.3.0/navigateur.md`, A).

Limite chez eux aussi : « connecté » repose sur l'avis du modèle (`signedIn: true`) et sur l'origine de la page. Une page du site sans session ouverte passe ce contrôle (`browser-connections.ts`, lignes 31-35 et 237-240).

**Ce qu'on ferait :** retirer `live` de la liste, ou l'afficher à part sous « cookies présents, non vérifiés ». Séparer « identifiants retenus » et « connecté ». Ne noter un site qu'après un contrôle du serveur (page sur le site, et pas de champ mot de passe visible). Ajouter un état « à reconnecter ».

## 5. À reprendre, par ordre de priorité

| # | Quoi | Où chez eux | Où chez nous | Effort |
|---|---|---|---|---|
| 1 | **Coffre : le serveur prend l'identifiant unique du site**, la carte seulement s'il n'y a rien ou plusieurs comptes | `src/server/composition.ts` 2341-2389 ; `src/runtime/tools.ts` 386 | `server/noah/coffre.py` (`_ask`, `_fill_saved`) ; `agent_plugin/__init__.py` (`VAULT_SCHEMA`, `LOGIN_HINT`) | S |
| 2 | **Sites connectés : registre vérifié**, sans devinette par cookies ; « retenu » à part de « connecté » ; état « à reconnecter » | `src/server/browser-connections.ts` ; `docs/.../trust/browser-sessions.md` | `server/noah/sites.py` ; `frontend/src/components/AgentPowers.tsx` (`BrowserSites`) | S à M |
| 3 | **Juge : citation exacte des paroles de la personne**, vérifiée par le serveur et montrée dans l'Activité | `src/server/trust.ts` (`checkInstructions`) ; `src/server/trust-basis.ts` | `server/noah/juge.py` ; Activité dans `frontend/src` | M |
| 4 | **Gestes du navigateur : juger seulement ce qui engage** (envoi final, paiement, suppression), laisser passer lecture, frappe, navigation | `docs/.../trust/approvals.mdx`, « Browser steps » ; `commits(step)` dans `src/runtime/tools.ts` | `server/noah/juge.py` ; `agent_plugin/__init__.py` (`reads_only`, `no_effect`). Répond au constat 15 de l'audit | S à M |
| 5 | **Accord lié à l'action exacte, à usage unique**, états « fait », « annulé », « expiré », « a peut-être eu lieu » ; titre qui dit l'action | `src/server/approvals.ts` ; `src/server/vault-use.ts` ; `docs/.../trust/outcomes.md` | `server/noah/accords.py` ; carte d'accord dans `frontend/src` | M |
| 6 | **Secrets dans la conversation** : un code attendu ne part pas au modèle, les formes de clé sont masquées | `security-model.md`, « Secrets » ; `src/server/redaction.ts` (`tokenShapes`) | `server/noah/sensitive.py` ; entrée des messages dans `server/noah/main.py`. Répond au constat 16 | M |
| 7 | **Argent** : « prix inconnu » au lieu de 0 $, réservation avant l'appel, point d'étape à 5 $ par tâche, plafond posé dès l'installation | `docs/.../use/spending.md` ; `src/server/ledger.ts` | `server/noah/relay.py` (`budget`, plafond du jour). Répond au constat 13 | S à M |
| 8 | **Codes à usage unique pris par le serveur** : clé d'authentificateur dans le coffre, code lu dans la boîte connectée | `src/server/authenticator.ts` ; `docs/.../trust/vault.mdx`, « Verification codes » | `server/noah/coffre.py` ; Gmail via `server/noah/courriel.py` | M |
| 9 | **Règles durables et consigne de fond**, lues par le juge comme des paroles de la personne | `approvals.mdx`, « Your rules », « Standing instructions » ; `src/server/owner-instructions.ts` | `server/noah/juge.py` ; Réglages dans `frontend/src` | M |
| 10 | **Mémoire : seulement les mots de la personne**, avec la source de chaque note et un état « mis de côté » | `docs/.../use/memory.md` ; `src/server/memory.ts` | Mémoire d'Hermes ; `server/noah/apprentissage.py` | M |
| 11 | **Isolation** : le serveur pilote seul le navigateur, pare-feu contre les adresses privées, un utilisateur par outil connecté | `sandbox-and-browser.md` ; `src/providers/agent-browser/network.ts` ; `src/providers/docker/command.ts` | `launcher/launcher.py` (réseau `NETWORK`, `cap_drop`) ; `launcher/camofox-noah/` | L |
| 12 | **Import d'identifiants** par CSV (Chrome, 1Password, Bitwarden) | `docs/.../trust/vault.mdx`, « Add a login » | `server/noah/coffre.py` ; Réglages > Coffre | S |
| 13 | **Contrôle des dépendances entre couches** par un script lancé avec les tests | `scripts/check-architecture.mjs` | `scripts/verifier.mjs` | S |
| 14 | **Paiement par carte** lié à une boutique, une page, un montant | `src/server/payments.ts` ; `docs/.../trust/payments.mdx` | Nouveau, à côté de `server/noah/coffre.py` | L |

Interface : leurs bonnes idées tiennent dans les lignes 3, 5 et 7. La carte d'accord reprend les destinataires et le texte depuis l'action enregistrée, pas depuis le résumé du modèle. Le formulaire de connexion privé s'ouvre à côté de la conversation. L'écran Usage met chaque action à côté de la citation qui l'a permise (`approvals.mdx`, « The confirmation » ; `vault.mdx`, « Add one during a task » ; `spending.md`, « See your spending »).

## 6. Licence : peut-on reprendre leur code ?

- **Oui, sous Apache 2.0** (`LICENSE`, `NOTICE`, badge du `README.md`). Elle permet de copier et de modifier, y compris dans Noah, qui est sous PolyForm Noncommercial (`LICENSE` de Noah). Conditions : joindre une copie de la licence Apache, garder la mention « Copyright 2026 n8n GmbH » et le contenu de leur `NOTICE`, et signaler les fichiers modifiés.
- **Exception** : `src/providers/local-speech/phonemizer-worker.ts` est sous GPL-3.0 (`NOTICE`). On ne le reprend pas. Les polices et logos fournis gardent leurs propres conditions (pied du `README.md`).
- **En pratique** : leur code est en TypeScript, le nôtre en Python. On reprendra surtout des règles et des textes de consigne, comme celle du juge dans `src/server/trust.ts`. Ces textes sont aussi sous Apache 2.0 : même mention si on les copie.
- Ce point est une lecture de la licence, pas un avis juridique.

## 7. Ce qui n'est pas vérifié

- Je n'ai rien lancé, ni chez eux ni chez nous. Les comportements de Nod viennent de leur doc et de leur code, pas d'un essai.
- La cause exacte du cas Instagram n'est pas reproduite. Les quatre causes de 4.1 viennent du code ; laquelle a joué se lit dans l'Activité de l'agent (appel `browser_vault` avec `list` ou sans, `origin_mismatch`).
- Je n'ai pas lu le code de la mémoire d'Hermes ; le point 10 compare donc la règle écrite de Nod à ce que nos fichiers en disent.
- Les chiffres de Nod (98 % de tâches, 0 action dangereuse) sont les leurs, sur leurs bancs simulés (`README.md`, « Measured, not promised »).
