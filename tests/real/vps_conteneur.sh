#!/bin/sh
# Lancé dans un conteneur docker:dind sur un vrai VPS qui héberge d'autres applications : Noah s'installe par get.sh
# dans son propre Docker, sans voir ceux de l'hôte. Le Traefik de l'hôte lui envoie le trafic. Voir docs/installation.md.
set -eu
RAW="https://raw.githubusercontent.com/smfcoder17/noah-agent/main"
apk add --quiet --no-cache curl
curl -fsSL "$RAW/get.sh" -o /tmp/get.sh
start=$(date +%s)
NOAH_COMPOSE_URL="$RAW/deploy/docker-compose.traefik.yml" sh /tmp/get.sh
echo "INSTALLATION_SECONDES=$(( $(date +%s) - start ))"
if ! docker start faux-modele >/dev/null 2>&1; then
  mkdir -p /var/lib/docker/faux
  curl -fsSL "$RAW/tests/real/faux_modele.py" -o /var/lib/docker/faux/f.py
  docker run -d --name faux-modele --network apollo-net --restart unless-stopped -v /var/lib/docker/faux/f.py:/f.py:ro python:3.12-alpine python /f.py 11434 >/dev/null
fi
echo "FAUX_MODELE_PRET"
