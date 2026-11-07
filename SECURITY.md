# Sécurité de Noah Agent

Ce document dit où sont tes données, ce qui sort de ton serveur, qui peut entrer et ce que Noah ne protège pas. Aucun audit externe n'a été fait. L'état des preuves est dans [docs/etat.md](docs/etat.md).

## Signaler une faille

Ne décris pas la faille dans un ticket public. [Ouvre un ticket](https://github.com/smfcoder17/noah-agent/issues/new) sans détail et demande un moyen de contact privé.

Noah se met à jour seul sur un VPS : les corrections arrivent dans la dernière version publiée. Il n'y a pas de correctif séparé pour les anciennes versions.

## Les quatre gardes

<!-- À RELIRE À LA PUBLICATION : Juge et Coffre décrivent du code pas encore publié. -->
- **Machine isolée.** Chaque agent a son conteneur et son navigateur, sans accès à Docker et sans dossier de l'hôte sur un VPS. Il n'a jamais la clé du fournisseur : il passe par le serveur, avec un jeton propre à lui.
- **Accords.** Une carte montre l'action, et tu autorises ou tu refuses. « Demander confirmation » est le droit par défaut d'un outil branché, et l'irréversible demande toujours ton accord. À la voix, seule la carte décide. Le droit « agir » passe sans carte, par ton choix.
- **Juge (pas encore publié).** Avant une action vers l'extérieur, un modèle à part, hors de la machine de l'agent, lit tes derniers messages et l'action, sans les pages que l'agent a lues. En panne, il demande ton accord ou refuse, sans jamais laisser passer. Son appel part de la machine de l'agent, et il lit ce que l'agent recopie dans l'action. Il se coupe dans Réglages > Serveur > Confidentialité.
- **Coffre (pas encore publié).** Tes identifiants passent par le serveur, qui les pose dans la page. Ils n'entrent jamais dans la machine de l'agent, ni dans les messages et les journaux. Le serveur lit lui-même l'origine affichée sur la carte. Ce que tu choisis de retenir est scellé avec une clé qui reste sur ton serveur.

## Où sont tes données

Sur ton serveur, dans des volumes Docker : ton compte et l'historique, les clés, puis la mémoire, les fichiers et le navigateur de chaque agent.

- **Les clés des fournisseurs et les jetons d'outils sont chiffrés.** Tes agents ne reçoivent jamais la clé du fournisseur : ils passent par le serveur, avec un jeton propre à chacun.
- **Les comptes que tu connectes pour un agent restent dans sa machine :** les sessions de son navigateur et sa connexion Google, par exemple.
- **Ton mot de passe n'est pas conservé,** seulement son empreinte (bcrypt).
- **Tes conversations, la mémoire et les fichiers ne sont pas chiffrés sur le disque.** La clé des secrets est sur le même serveur. Qui a un accès root à la machine, ton hébergeur compris, peut tout lire.
- **Une sauvegarde n'est pas chiffrée non plus,** et elle contient cette clé. Range-la en lieu sûr.

## Ce qui sort du serveur

Noah n'envoie rien à ses développeurs. Il n'a aucune télémétrie. Réglages > Serveur > Confidentialité affiche la liste réelle chez toi.

| Quoi | Vers où | Quand |
|---|---|---|
| **Tes messages et ce que l'agent lit pour répondre** | Le fournisseur de modèle choisi. Personne avec un Ollama sur ta machine | À chaque message et à chaque étape d'une tâche |
| Voix, images, vidéos, musique | OpenRouter, ou ton serveur de voix | Quand tu t'en sers |
| Les pages visitées, avec l'IP du serveur | Les sites de la tâche | Quand une tâche le demande |
| Rien de toi : liste publique des modèles et des prix | openrouter.ai | Au plus une fois par heure |
| Rien de toi : recherche de mises à jour et téléchargement | github.com, ghcr.io, registry-1.docker.io | Une fois par heure, et à l'installation |
| Ta position, si tu la joins à un message depuis l'app Android | Le fournisseur de modèle, dans le message | Quand tu touches « Joindre ma position » |
| Notifications, au contenu chiffré | Le service de ton appareil : Google, Apple, Mozilla, Microsoft ou ntfy | À chaque notification |
| Rien de toi : l'IP et le certificat du serveur | api.ipify.org (ifconfig.me, icanhazip.com en secours), Let's Encrypt | Au démarrage, puis tous les deux mois environ |
| Pays et fuseau du serveur | ipinfo.io | Une seule fois, évitable avec `NOAH_LOCALE` et `NOAH_TIMEZONE` |
| Ce que tu autorises sur ton compte Google | googleapis.com | Si tu connectes Google à un agent |
| Ce que l'agent envoie à un outil | Les outils que tu ajoutes | Quand il s'en sert |
| Tes codes de confirmation et tes alertes de connexion | Ton serveur de courriel, si tu en règles un | Quand tu confirmes une action ou qu'un nouvel appareil se connecte |

Chacun de ces services voit l'IP de ton serveur. Un test vérifie le serveur de Noah contre cette liste : [sorties_test.py](tests/exposition/sorties_test.py). Il ne voit pas ce que font les conteneurs des agents (Hermes), de leurs navigateurs et de Caddy. La mesure sur 24 h depuis un vrai VPS reste à faire.

## Comment tu restes le seul à entrer

- **Le compte.** Il se crée avec le code à usage unique du lien, puis ce code est effacé, ou au déploiement avec [`NOAH_ADMIN_USER` et `NOAH_ADMIN_PASSWORD`](docs/installation.md#choisir-son-compte-au-déploiement), un mot de passe à changer à la première connexion. Il n'y a pas d'inscription publique : toi seul peux ajouter un profil.
- **Les profils.** Depuis Réglages > Personnes, sur l'ordinateur comme sur le téléphone, tu crées, réinitialises ou supprimes un profil, et tu vois et coupes ses appareils ; chaque geste demande ton mot de passe.
- **La connexion.** En HTTPS, avec 10 essais ratés au plus par réseau toutes les 10 minutes. Tu peux ajouter une [double vérification](docs/installation.md#la-double-vérification), et faire confirmer les actions critiques par un [code reçu par courriel](docs/installation.md#le-code-reçu-par-courriel).
- **Les appareils.** Un QR code ou un code court sert une fois et expire en 10 minutes. Il ne suffit pas : tu acceptes sur un appareil déjà relié, avec le nombre à 3 chiffres. Accepter demande aussi ton mot de passe, sauf depuis un navigateur où tu viens de le saisir (moins de 15 minutes) : un téléphone volé ne relie pas un autre appareil. Un nouvel appareil se signale sur les autres, avec « C'est moi » et « [Ce n'est pas moi](docs/installation.md#nouvel-appareil-sur-ton-compte) », qui le coupe aussitôt.
- **Le réseau.** Seul Caddy publie des ports, le 80 et le 443. Le serveur, le lanceur, les agents et leurs navigateurs n'en publient aucun ([exposition_test.py](tests/exposition/exposition_test.py) lit les fichiers et les appels à Docker ; le scan depuis Internet reste à faire).
- **Les mises à jour.** Le serveur n'installe une version que si son manifeste porte la bonne signature, et chaque image y est fixée par empreinte.

## Ce que Noah ne protège pas

- **Pas de récupération du mot de passe par courriel.** Choisis un mot de passe long. Qui a la main sur le serveur peut changer le mot de passe du propriétaire et couper sa double vérification.
- **Un agent peut être trompé.** Une page ou un message piégé peut lui donner de fausses consignes, et il agit avec ce que tu lui as confié. Pour un outil branché, « Demander confirmation » est le droit par défaut. Il arrête le modèle, mais pas toujours un agent déjà détourné : [les limites](docs/installation.md#les-limites-à-connaître). Donne à chaque agent le moins d'accès possible.
- **La machine d'un agent est un conteneur Docker,** pas une machine virtuelle. Il partage le noyau du serveur.
- **Le lanceur a l'équivalent d'un accès root à la machine,** car il crée les conteneurs des agents par Docker. Il n'est pas exposé et chaque appel exige sa clé : [le détail](docs/installation.md#le-socket-docker).
- **Un sous-domaine ne cache pas ton serveur :** le DNS mène à l'IP. [Cacher l'IP](docs/installation.md#cacher-lip-du-serveur).
- **Un agent partagé garde une seule machine.** Ne le donne qu'à quelqu'un en qui tu as confiance.
