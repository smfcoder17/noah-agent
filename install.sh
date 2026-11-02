#!/usr/bin/env sh
# Installe (ou met à jour) et démarre Noah Agent sur ton ordinateur, depuis la racine du dépôt :
#   sh install.sh        http://localhost:8080
# Sur un VPS, c'est get.sh (ou « Compose from URL » chez Hostinger) : ses clés restent dans un volume en 0600, jamais
# dans des variables d'environnement visibles par docker inspect ou le Docker Manager.
set -eu

case "${1:-}" in
  "") ;;
  --domaine|--domain)
    echo "Sur un VPS, installe avec get.sh (clés hors des variables d'environnement, HTTPS automatique) :" >&2
    echo "  NOAH_DOMAIN=${2:-auto} sh get.sh" >&2
    exit 1 ;;
  *) echo "Option inconnue : $1" >&2; exit 1 ;;
esac

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
touch .env
ensure LAUNCHER_KEY "$(random)"
ensure APOLLO_SECRET_KEY "$(random)"
ensure APOLLO_PORT 8080
ensure APOLLO_BIND 127.0.0.1

echo "Téléchargement de l'image des agents (une seule fois, quelques minutes)…"
docker pull -q nousresearch/hermes-agent:stable
docker compose up -d --build

port=$(grep '^APOLLO_PORT=' .env | cut -d= -f2)
echo "✓ Noah Agent démarre. Ouvre http://localhost:${port:-8080} pour créer ton compte."
