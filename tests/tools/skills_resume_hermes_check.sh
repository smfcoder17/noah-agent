#!/bin/sh
# La liste courte des skills pour la saisie (« / »), sur le VRAI Hermes : nom, titre, une ligne, origine, jamais le texte ; un skill que le réglage
# `skills.disabled` d'Hermes écarte sort « désactivé ». Conteneur jetable de l'image de l'agent, rien ne tourne sur un agent en service.
#     MSYS_NO_PATHCONV=1 docker run --rm --entrypoint sh -v "$PWD/launcher:/l:ro" -v "$PWD/tests/tools:/t:ro" nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d /t/skills_resume_hermes_check.sh
set -e
P=/opt/hermes/.venv/bin/python
export HOME=/opt/data HERMES_HOME=/opt/data
mkdir -p /opt/data/skills
cd /opt/data
admin() { "$P" -c "$(cat /l/agent_admin.py)" "$@"; }
admin competence_ajouter '{"titre":"Note de frais","texte":"Remplis la note avec le texte secret-du-corps."}' >/dev/null
admin competence_ajouter '{"titre":"Compte rendu","texte":"Cinq lignes."}' >/dev/null
admin skills_resume > /tmp/avant.json
"$P" - <<'EOF'
import json
d = json.load(open("/tmp/avant.json"))["skills"]
names = {s["nom"]: s for s in d}
assert "competences/note-de-frais" in names and "competences/compte-rendu" in names, names.keys()
s = names["competences/note-de-frais"]
assert set(s) == {"nom", "titre", "resume", "origine", "desactivee"}, set(s)
assert s["titre"] == "Note de frais" and s["origine"] == "enseigné par toi" and s["desactivee"] is False, s
assert "secret-du-corps" not in json.dumps(d), "jamais le texte d'un skill"
assert d[0]["origine"] == "enseigné par toi", "ceux de la personne d'abord"
EOF
printf 'skills:\n  disabled:\n    - note-de-frais\n' > /opt/data/config.yaml
admin skills_resume > /tmp/apres.json
"$P" - <<'EOF'
import json
names = {s["nom"]: s for s in json.load(open("/tmp/apres.json"))["skills"]}
assert names["competences/note-de-frais"]["desactivee"] is True, names["competences/note-de-frais"]
assert names["competences/compte-rendu"]["desactivee"] is False
EOF
echo OK
