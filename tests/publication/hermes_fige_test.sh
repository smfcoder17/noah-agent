#!/bin/sh
# Hermes ne bouge jamais tout seul. Vu sur le premier VPS : la publication a pris le canal « stable » du jour, où le
# navigateur Camofox avait quitté le cœur d'Hermes. Les tests tournaient sur une autre version ; l'agent naviguait dans un
# Chromium invisible, et l'écran Ordinateur restait vide.
#   sh tests/publication/hermes_fige_test.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
if git grep -n "hermes-agent:\\(stable\\|latest\\)" -- . ':!docs' ':!tests/publication/hermes_fige_test.sh' ':!tests/publication/publication_test.sh'; then
  echo "ÉCHEC : Hermes suit un canal au lieu d'une empreinte"; exit 1
fi
HERMES=$(sed -n 's/^ *AGENT_IMAGE: //p' deploy/docker-compose.yml)
case "$HERMES" in nousresearch/hermes-agent@sha256:*) ;; *) echo "ÉCHEC : deploy/docker-compose.yml : $HERMES"; exit 1 ;; esac
autres=$(git grep -h -o -E "nousresearch/hermes-agent@sha256:[0-9a-f]{64}" -- . ':!docs' ':!tests/updates' ':!tests/publication' | sort -u)
[ "$autres" = "$HERMES" ] || { echo "ÉCHEC : plusieurs versions d'Hermes dans le dépôt :"; echo "$autres"; exit 1; }
echo "1. une seule version d'Hermes dans le code, les composes et les tests : $HERMES"
docker run --rm --entrypoint sh "$HERMES" -c 'test -f /opt/hermes/tools/browser_camofox.py' ||
  { echo "ÉCHEC : cette version d'Hermes n'a plus le navigateur Camofox dans son cœur (plugin ?) : l'écran Ordinateur resterait vide"; exit 1; }
echo "2. cette version pilote bien le navigateur Camofox que montre l'écran Ordinateur"
