#!/bin/sh
# Les compétences sur le VRAI Hermes (skill_manage, épingle, liste des skills), dans un conteneur jetable de l'image de l'agent. Rien n'est lancé sur un agent en service.
#     MSYS_NO_PATHCONV=1 docker run --rm --entrypoint sh -v "$PWD/launcher:/l:ro" -v "$PWD/tests/tools:/t:ro" <image noah-agent> /t/competences_hermes_check.sh
set -e
P=/opt/hermes/.venv/bin/python
export HOME=/opt/data HERMES_HOME=/opt/data
mkdir -p /opt/data/skills
cd /opt/data
admin() { "$P" -c "$(cat /l/agent_admin.py)" "$@"; }
admin competence_ajouter '{"titre":"Répondre à mes clients","texte":"Vouvoie-les."}' | grep -q '"nom": "repondre-a-mes-clients"'
admin competence_ajouter '{"titre":"Répondre à mes clients","texte":"Deux."}' | grep -q 'repondre-a-mes-clients-2'
admin competence_modifier '{"nom":"repondre-a-mes-clients","titre":"Un titre bien plus long que les soixante caractères de la description","texte":"Tutoie-les."}' | grep -q 'Tutoie-les'
"$P" - <<'EOF'
import json, sys
sys.path.insert(0, "/opt/hermes")
from tools import skill_usage
from tools.skill_manager_tool import skill_manage
from tools.skills_tool import skills_list
assert skill_usage.load_usage()["repondre-a-mes-clients"]["pinned"] is True, "épinglée : le tri automatique n'y touche pas"
assert "pinned" in skill_manage(action="delete", name="repondre-a-mes-clients-2"), "l'agent ne retire pas ce qu'on lui a enseigné"
assert json.loads(skill_manage(action="create", name="appris-seul", category="devops", content="---\nname: appris-seul\ndescription: Appris.\n---\n\nCorps\n"))["success"]
names = [s["name"] for s in json.loads(skills_list(category="competences")).get("skills", [])]
assert names == ["repondre-a-mes-clients", "repondre-a-mes-clients-2"], f"l'agent les voit : {names}"
EOF
admin competences | grep -qv appris-seul
if admin competence_retirer '{"nom":"appris-seul"}'; then echo "ÉCHEC : un skill appris seul s'est retiré"; exit 1; fi
if admin competence_retirer '{"nom":"../devops/appris-seul"}'; then echo "ÉCHEC : un chemin est passé"; exit 1; fi
admin competence_retirer '{"nom":"repondre-a-mes-clients"}' | grep -q '"ok": true'
test ! -e /opt/data/skills/competences/repondre-a-mes-clients
test -e /opt/data/skills/devops/appris-seul/SKILL.md
echo OK
