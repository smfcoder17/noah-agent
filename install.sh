#!/usr/bin/env sh
# Installe et démarre Apollo. À lancer depuis la racine du dépôt.
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker est introuvable. Installe Docker (https://docs.docker.com/get-docker/) puis relance ce script." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker est installé mais ne répond pas. Démarre Docker puis relance ce script." >&2
  exit 1
fi

random() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [ ! -f .env ]; then
  {
    echo "HERMES_API_KEY=$(random)"
    echo "APOLLO_SECRET_KEY=$(random)"
    echo "APOLLO_PORT=8080"
  } > .env
  echo "✓ Secrets générés dans .env"
fi

docker compose up -d --build

port=$(grep '^APOLLO_PORT=' .env | cut -d= -f2)
echo "✓ Apollo démarre. Ouvre http://localhost:${port:-8080} pour créer ton compte."
