# Noah sur Hostinger

Ce que Hostinger propose, ce que Noah en fait, et ce qui reste à confirmer. Lu et constaté le 5 novembre 2026, dans le panneau et sur les pages de Hostinger.

## Les trois voies

| Voie | État | Formulaire au déploiement | Remarque |
|---|---|---|---|
| Bouton `docker-hosting?compose_url=…` | Ouverte, déjà dans le README | Non constaté | Sans code partenaire pour l'instant |
| Programme « Open source partners » : `deploy?template=…&ref=…` | Liste d'attente ; `/deploy` répond 404 | Non documenté | 20 % de commission pour nous, 20 % de réduction pour l'acheteur |
| Catalogue Docker (1015 applications, dont Hermes Agent) | Écrit par Hostinger, aucune voie publique pour y entrer | Oui | Le meilleur parcours, à demander |

## Ce que fait le formulaire du catalogue

La fiche de Hermes Agent montre : une description, les liens Documentation et Quick start, un bouton qui génère une clé AI Router, puis des champs obligatoires avec leur explication, dont un identifiant et un mot de passe déjà tirés au hasard, lisibles avec l'icône en forme d'œil.

Rien n'y permet d'afficher un texte libre après le déploiement. Le code d'installation ne peut donc pas s'y afficher tel quel. Mieux vaut ne pas en avoir besoin : le compte se crée directement depuis ce formulaire, et Noah sait déjà le faire.

## Le formulaire à demander pour Noah

| Variable | Obligatoire | Valeur proposée | Texte d'aide |
|---|---|---|---|
| `NOAH_ADMIN_USER` | Oui | `admin` | Ton identifiant pour te connecter à Noah |
| `NOAH_ADMIN_PASSWORD` | Oui | Tirée au hasard, 24 caractères | Ton mot de passe provisoire. Noah t'en demandera un nouveau à la première connexion |
| `NOAH_DOMAIN` | Non | `auto` | Ton sous-domaine, s'il pointe déjà vers ce serveur. Sinon, laisse `auto` |

Le mot de passe est retiré du fichier d'environnement dès que le compte existe sur une installation par `get.sh`. Par le panneau, la valeur reste visible dans le projet jusqu'à ce que la personne la vide. Elle n'ouvre plus rien une fois le mot de passe changé.

Quick start à fournir : « Ouvre le lien Open de ton projet, connecte-toi avec l'identifiant choisi, puis choisis ton modèle et colle sa clé. »

## Sans formulaire : le bouton d'aujourd'hui

1. Le bouton mène à l'offre VPS, puis au Docker Manager avec le fichier prêt.
2. Le lien « Open » du projet mène à `http://<IP>`, et Noah envoie vers `https://<ip-en-tirets>.sslip.io`.
3. L'écran demande le code d'installation et dit où le lire : menu ⋮ du projet, View logs.

Le nom donné au projet n'a plus d'effet sur les données : les volumes portent un nom fixe.

## Avant d'envoyer la demande

- **Licence.** Le programme demande une licence open source qui permet le déploiement. PolyForm Noncommercial n'en est pas une au sens de l'OSI. C'est une décision à prendre, pas un détail de formulaire.
- **Fichier à la racine.** `template=` vise un dépôt, sans dire quel fichier il lit. Le `docker-compose.yml` à la racine sert à l'installation locale et compile sur place. Si le contrôle de Hostinger le lit, il faudra le déplacer et mettre `deploy/docker-compose.yml` à sa place.
- **VPS neuf.** Le parcours par le bouton n'a pas encore été suivi sur un VPS neuf. L'achat et l'écran après paiement restent à constater.

## Texte de la demande

- **GitHub repository :** `https://github.com/smfcoder17/noah-agent`
- **App name :** Noah Agent
- **Description :** Un agent personnel qui tourne 24 h/24 sur ton propre VPS, relié à ton ordinateur et à ton téléphone. Plusieurs agents isolés, chacun avec son navigateur visible, ses routines et sa mémoire. Tes clés et tes conversations restent sur ton serveur. Mises à jour signées et automatiques, avec retour arrière. Pour qui veut un assistant qui agit vraiment, sans confier ses comptes à un service tiers.

## Sources

- [Open source partners](https://www.hostinger.com/open-source-partners)
- [Deploy on Hostinger button](https://www.hostinger.com/support/deploy-on-hostinger-button/)
- [Docker Manager](https://www.hostinger.com/support/vps/docker-manager/)
- [Déployer un conteneur](https://www.hostinger.com/support/12040815-how-to-deploy-your-first-container-with-hostinger-docker-manager/)
- [Identifiants de Faraday dans les journaux](https://www.hostinger.com/support/how-to-find-faraday-login-credentials-after-deployment/)
