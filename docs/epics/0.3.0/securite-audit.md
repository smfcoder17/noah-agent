# Audit de sécurité 0.3.0 (15 novembre 2026)

Trois agents indépendants, en local, sur feat/020. Chaque constat est repris ici avec son état. Corrections : lot F du plan.

## Kimi K3 : infrastructure et isolation

Réponse courte : depuis Internet, sans compte ni clé, aucun chemin d'entrée trouvé. Le point faible est le réseau Docker plat et la clé du lanceur qui y circule en clair.

| # | Gravité | Constat | Où | Correction | État |
|---|---|---|---|---|---|
| E1 | Élevé | Navigateur sans cap_drop (garde NET_RAW) sur le réseau plat noah-net : après une faille du navigateur, écoute de la clé du lanceur en clair, puis /restore, suppression d'agents, code écrit dans un agent | launcher.py:263-275, hermes.py:17,50-51 | cap_drop ALL au navigateur ; réseau interne pour serveur et lanceur ; clé du lanceur renouvelée au démarrage | à faire |
| E2 | Élevé | get.sh se replie sur le compose de main et tire `:stable` sans vérifier de signature | get.sh:98-106,130-131 | version figée par digest, pas de repli sur main | à faire |
| M1 | Moyen | Réseau plat : agents et navigateurs joignent tous les services | launcher.py:264 | réseaux séparés, ICC coupé | à faire |
| M2 | Moyen | Mot de passe VNC de 32 bits | hermes.py:105-106 | 16 caractères aléatoires | à faire |
| M3 | Moyen | Mot de passe admin provisoire en 644 dans .env | get.sh:123-127 | umask 077 | à faire |
| M4 | Moyen | Manifeste : n'importe quel dépôt d'image accepté, clé sans rotation | updater.py:63, updates.py:231 | liste blanche des dépôts | à faire |
| M5 | Moyen | Clé du lanceur jamais renouvelée | config.py:12 | rotation | à faire |
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
| 4 | Élevé sous condition | Tâche Claude Code « complet » sans fenêtre quand le PC est en Auto | desktop/actions.js:383 | fenêtre toujours pour le profil « complet » | après fusion du lot A |
| 5 | Moyen | Carte d'accord : ne décrit que la première ligne d'une commande, détails coupés à 600 caractères | mcp.py:993-995 ; agent_plugin:1639-1643 | décrire toutes les lignes ou refuser au-delà | lot C |
| 6 | Moyen | Secrets de la machine de l'agent protégés par regex (glob, concaténation passent) | agent_plugin:747-756,906-921 | jeton illisible du processus piloté par le modèle | lot C |
| 7 | Moyen, opt-in | PC en Auto : écriture sans carte de `.bat`, `.ps1`, profils, démarrage | desktop/actions.js:442-453 | refus d'office de ces emplacements | après fusion du lot A |
| 8 | Faible | Un 422 recopiait la valeur envoyée (jeton collé) | connecteurs_cles.py:56-60 | gestionnaire global sans `input` | **corrigé**, même test |
| 9 | Faible | Clés collées dans le chat non masquées | sensitive.py | masque par forme de clé | lot C (C4) |
| 10 | Faible | `fromSetup` acceptait tout `setup.html` du disque | desktop/main.js:817,602 | chemin exact du fichier de l'app | **corrigé** |
| 11 | Faible | Publication X : `client_id` choisi par l'agent | mcp.py:874-891 | `client_id` fixé par le serveur | à faire |
| 12 | Faible | SECURITY.md surestime le chiffrement des jetons d'outils | SECURITY.md:23 | corriger le texte | à faire |

## DeepSeek : web, authentification, isolation entre profils

Réponse courte : personne de l'extérieur n'a obtenu de droits, ni accès au conteneur. 43 routes du propriétaire refusées à un invité, pas de CSRF, pas de SSRF, aucun secret dans les réponses, non-indexation sur toutes les routes.

| # | Gravité | Constat | Où | Correction | État |
|---|---|---|---|---|---|
| M1 | Moyen | uvicorn croit X-Forwarded-For de tout conteneur de 10/8 et 172.16/12 : un agent compromis choisit son adresse et contourne une partie du verrou de connexion | server/Dockerfile:27 ; main.py:386,1156-1178 | ne croire que Caddy (réseau d'entrée séparé), avec E1 | à faire |
| M2 | Moyen, conditionnel | Racine de partage « / » : le socket Docker devient partageable | launcher.py:538-590 | liste de refus (/var/run, /run, /proc, /sys, /dev, /etc, /var/lib/docker, « / ») | **corrigé** |
| M3 | Moyen | Aucune limite de taille de corps sur les routes sans compte | Dockerfile:27 ; Caddyfile | 1 Mo sur les routes sans session | **corrigé** |
| F1 | Faible | Surrogate Unicode : erreur 500 sans compte | main.py:641 | rejet propre | à faire |
| F2 | Faible | 422 recopie la valeur saisie | — | voir Sonnet n°8 | **corrigé** |
| F3 | Faible | Mot de passe de départ d'un profil non marqué provisoire | profiles.py:66 | `temporary=True` | **corrigé** |
| F4 | Faible | Verrous de connexion en mémoire, remis à zéro au redémarrage | main.py:457,791,920 | persister | à faire |
| F5 | Faible | CSRF comparé au Host reçu | main.py:84-101 | comparer à NOAH_DOMAIN | à faire |
| F6-F8 | Faible | Appairage : GET qui modifie l'état, verrou global des codes courts ; réglages média modifiables par l'agent | main.py:520-669, 4228-4255 | voir rapport | à faire |
