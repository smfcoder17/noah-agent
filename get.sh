#!/usr/bin/env sh
# Installation de Noah Agent sur un VPS vierge, en une commande (Ubuntu ou Debian, en root) :
#
#   curl -fsSL https://raw.githubusercontent.com/SmfCoder/noah-agent/main/get.sh | sh
#
# Installe Docker s'il le faut, télécharge le fichier deploy/docker-compose.yml dans /opt/noah, ouvre les ports web et
# démarre Noah à partir des images publiées (rien n'est compilé sur le VPS). Sans nom de domaine, Noah répond en
# HTTPS sur <ip>.sslip.io. Variables facultatives :
#   NOAH_DOMAIN=noah.example.com   ton domaine (il doit déjà pointer vers ce serveur)
#   NOAH_DIR=/opt/noah             dossier d'installation
#   NOAH_COMPOSE_URL=https://…     fichier compose à utiliser (une copie à toi, par exemple)
# Relancer la commande met Noah Agent à jour sans toucher aux données ni aux secrets.
set -eu

RAW="https://raw.githubusercontent.com/SmfCoder/noah-agent/main"
COMPOSE_URL="${NOAH_COMPOSE_URL:-$RAW/deploy/docker-compose.yml}"
DIR="${NOAH_DIR:-/opt/noah}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "Lance cette commande en root (ou avec sudo)."
  say "Relance avec sudo…"
  exec sudo -E sh -c "curl -fsSL '$RAW/get.sh' | sh"
fi

if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null
  else
    fail "Installe curl, puis relance."
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installation de Docker (script officiel get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || fail "Docker Compose est absent. Installe le paquet docker-compose-plugin, puis relance."

# Ports 80 et 443 : Caddy en a besoin pour le certificat HTTPS. Sur une nouvelle installation, on dit qui les tient.
if ! docker ps --format '{{.Names}}' | grep -q '^apollo-caddy$'; then
  for port in 80 443; do
    holder=$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1)
    if [ -n "$holder" ]; then
      container=$(docker ps --filter "publish=$port" --format '{{.Names}}' | head -1)
      fail "Le port $port est déjà pris par « ${container:-$holder} ». Noah en a besoin pour le HTTPS.
Arrête ce service (par exemple : docker stop ${container:-<nom>}, ou le Traefik du Docker Manager de Hostinger),
puis relance la commande."
    fi
  done
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
fi

mkdir -p "$DIR"
cd "$DIR"
say "Téléchargement de Noah Agent…"
curl -fsSL "$COMPOSE_URL" -o docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml
if [ -n "${NOAH_DOMAIN:-}" ]; then
  sed -i "s/NOAH_DOMAIN: auto/NOAH_DOMAIN: $NOAH_DOMAIN/" docker-compose.yml
fi
# NOAH_LOCAL_IMAGES=1 : images déjà présentes (tests, ou images construites à la main).
[ "${NOAH_LOCAL_IMAGES:-}" = 1 ] || docker compose pull -q
docker compose up -d --remove-orphans

say "Démarrage…"
for _ in $(seq 1 60); do
  line=$(docker compose logs server 2>/dev/null | grep -E "installation=|Noah est prêt :" | tail -1 || true)
  [ -n "$line" ] && break
  sleep 2
done
code=$(docker compose logs server 2>/dev/null | sed -n "s/.*Code d'installation : \([A-Z0-9]*\).*/\1/p" | tail -1)
url=$(docker compose logs server 2>/dev/null | sed -n 's/.*\(https:\/\/[^ ]*\).*/\1/p' | tail -1)
if [ -n "$code" ]; then
  say "✓ Noah Agent est installé. Ouvre ce lien pour créer ton compte (le certificat HTTPS peut prendre une minute) :"
  printf '\n    %s\n\n  Code d%sinstallation : %s\n\n' "$url" "'" "$code"
elif [ -n "$url" ]; then
  say "✓ Noah Agent est à jour : $url"
else
  say "Noah démarre encore. Le lien s'affichera dans : cd $DIR && docker compose logs server"
fi
