#!/usr/bin/env sh
# Efface TOUTES les données Noah (compte, clés, agents, mémoire) et repart de zéro.
# Garde le fichier .env (les secrets d'installation).
set -eu
cd "$(dirname "$0")/.."

printf "Effacer le compte, les agents et leur mémoire ? Tape « oui » : "
read -r answer
[ "$answer" = "oui" ] || { echo "Annulé."; exit 0; }

docker ps -aq --filter label=noah.agent | xargs -r docker rm -f
docker volume ls -q | grep '^noah-agent-' | xargs -r docker volume rm
docker compose down -v
docker compose up -d
echo "✓ Noah est remis à zéro. Ouvre http://localhost:$(grep '^NOAH_PORT=' .env | cut -d= -f2) pour créer un compte."
