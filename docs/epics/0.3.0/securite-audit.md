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
