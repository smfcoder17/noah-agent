#!/usr/bin/env sh
# Installe (ou met à jour) et démarre Noah Agent. À lancer depuis la racine du dépôt.
#   sh install.sh                              sur ton ordinateur : http://localhost:8080
#   sh install.sh --domaine noah.example.com   sur un VPS : HTTPS automatique avec Caddy
set -eu

domain=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domaine|--domain) domain="${2:-}"; shift 2 ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker est introuvable. Sur un VPS Linux : curl -fsSL https://get.docker.com | sh" >&2
  echo "Sinon : https://docs.docker.com/get-docker/ puis relance ce script." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker est installé mais ne répond pas. Démarre Docker puis relance ce script." >&2
  exit 1
fi

random() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Ajoute une variable à .env si elle n'y est pas encore (les mises à jour gardent les secrets existants).
ensure() {
  grep -q "^$1=" .env 2>/dev/null || { echo "$1=$2" >> .env; echo "✓ $1 ajouté à .env"; }
}
# Remplace (ou ajoute) une variable de .env.
set_env() {
  if grep -q "^$1=" .env; then
    sed -i.bak "s#^$1=.*#$1=$2#" .env && rm -f .env.bak
  else
    echo "$1=$2" >> .env
  fi
}
touch .env
ensure LAUNCHER_KEY "$(random)"
ensure APOLLO_SECRET_KEY "$(random)"
ensure APOLLO_PORT 8080
ensure APOLLO_BIND 127.0.0.1

if [ -n "$domain" ]; then
  # Caddy obtient le certificat tout seul ; il faut que le domaine pointe déjà vers ce serveur (ports 80 et 443 ouverts).
  set_env NOAH_DOMAIN "$domain"
  set_env COMPOSE_FILE "docker-compose.yml:deploy/docker-compose.vps.yml"
  echo "✓ Domaine $domain configuré (HTTPS via Caddy)"
fi

echo "Téléchargement de l'image des agents (une seule fois, quelques minutes)…"
docker pull -q nousresearch/hermes-agent:stable
docker compose up -d --build

if grep -q "^NOAH_DOMAIN=" .env; then
  echo "✓ Noah Agent démarre. Ouvre https://$(grep '^NOAH_DOMAIN=' .env | cut -d= -f2) pour créer ton compte."
  echo "  Sauvegarde quotidienne conseillée : voir « Sauvegardes » dans le README."
else
  port=$(grep '^APOLLO_PORT=' .env | cut -d= -f2)
  echo "✓ Noah Agent démarre. Ouvre http://localhost:${port:-8080} pour créer ton compte."
fi
