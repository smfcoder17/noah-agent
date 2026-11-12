# 0.1.9, lot A : mode « Agir » et cartes d'accord

État : enquête faite, cause non trouvée dans le code de `main`. Aucune correction appliquée : sans règle fautive prouvée, changer le garde serait improviser.

## Ce que le code fait en mode Agir (preuve)

Chaque appel d'outil passe dans cet ordre : garde de Noah (plugin), puis juge du serveur, puis garde propre d'Hermes.

- Le mode arrive bien jusqu'au garde. Réglé dans l'écran (`frontend/src/components/Juge.tsx:18`, `POST /api/juge`), il est écrit en base puis réécrit pour chaque agent (`server/noah/juge.py:818-825`, `_seal_all` 801-810). Le fichier des droits porte `@mode` (`server/noah/mcp.py:405-420`), le lanceur le garde (`launcher/launcher.py:815-823`), le garde le lit (`server/noah/agent_plugin/__init__.py:199-203`).
- **Cas 1, agenda Google.** La case « écriture » de la carte Google (`AgentPowers.tsx:1081`, `agenda_ecrire`) est un accès demandé à Google, pas le droit de l'agent. Le droit est le menu à côté (`AgentPowers.tsx:1074-1078`, route `PUT /api/agents/{id}/google/droit`, `accounts.py:534-547`) et vaut « confirmer » par défaut. Avec « confirmer », `check_google` lève la carte en Auto et en Prudent (`agent_plugin/__init__.py:359-374`), mais rend None en Agir (371-372). `check_juge` (1503-1510) envoie ensuite au juge, qui fait passer tout appel en Agir (`juge.py:661-676`). Donc en Agir : pas de carte ; en Auto : une carte, voulue, tant que le menu reste sur « confirmer ».
- **Cas 2, routine ou veille.** `python3 /opt/data/noah.py routine|routine-si|veille|routine-regler …` n'est refusé par aucune règle du garde (`check`, 145-178 ; `must_ask`, 1136-1150). `classify` le laisse sans ligne (`juge.py:468-507`), mais en Agir le juge rend « passe » avant de consulter le tableau ou un modèle (`juge.py:662-676`).
- **Cas 3, skill.** `skill_manage` n'est pas dans `no_effect` (`agent_plugin/__init__.py:1076`) et va donc au juge, qui le fait passer en Agir. `check_learning` (591-601) peut refuser une écriture après une page piégée, mais c'est un refus, pas une carte.
- **Juge en panne en Agir (constat 12 de la revue).** Exception → `verdict` None (1549-1553), puis `if _autonomy() == "agir": return directive` (1583-1585). Pas de carte. Seul cas restant : une connexion en « confirmer » dont `check_mcp` a déjà levé la carte, mais `check_mcp` rend None en Agir (273-276).
- **Garde d'Hermes.** Vérifié dans l'image `nousresearch/hermes-agent:stable` avec `tools.approval_detection.detect_dangerous_command`. Les commandes `noah.py routine`, `routine-si`, `veille`, `routine-regler`, `google_api.py calendar create` et `cat > consigne.txt << 'EOF'` ne déclenchent rien. En revanche, `python3 - <<EOF` (script via heredoc) et `python3 -c "…"` lèvent une carte d'Hermes, quel que soit le mode de Noah : Noah ne règle pas `approvals.mode` (`server/noah/hermes.py:322` ne fixe que `cron_mode`).

## Hypothèses à vérifier sur le serveur du propriétaire

1. L'agent écrit un petit script Python (`python3 -c`, ou heredoc) pour créer l'événement, la routine ou le skill, au lieu de la commande telle quelle. Hermes lève alors sa propre carte, que le mode de Noah ne lève pas. La consigne `main.py:1761` le laisse entendre (« un script demande son accord »).
2. Le fichier `/etc/noah/mcp-droits.json` de l'agent ne contient pas `"@mode": "agir"` (lanceur antérieur à la 0.1.7, ou conteneur recréé sans nouvelle configuration).

Pour trancher, il faut lire sur le serveur, au moment d'une carte :
- `docker exec noah-agent-<id> cat /etc/noah/mcp-droits.json` ;
- le texte de la carte : « Ton juge demande ton accord… » vient de Noah (`agent_plugin/__init__.py:1441`, 374, 281) ; « This action is potentially dangerous… » ou une description en anglais vient d'Hermes.

## Correction proposée, à décider

- Si c'est l'hypothèse 1 : en Agir, poser `approvals.mode: off` dans la configuration d'Hermes et la réécrire au changement de mode. Les règles « hardline » d'Hermes et les deux murs de Noah restent, puisqu'ils vivent dans le plugin, avant Hermes. Il faut d'abord vérifier qu'Hermes relit `approvals.mode` sans redémarrage. Ce changement touche la sécurité : décision de Franck.
- Si c'est l'hypothèse 2 : réécrire les droits au démarrage de chaque agent, pas seulement à la configuration.

## Non fait

Aucun code changé et aucun test ajouté : aucune règle de `main` ne produit de carte dans ces trois cas en Agir, donc il n'y a pas de test rouge à écrire.
