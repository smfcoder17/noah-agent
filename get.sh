#!/usr/bin/env sh
# Installation de Noah Agent sur un VPS vierge, en une commande (Ubuntu ou Debian, en root) :
#
#   curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | sh
#
# Installe Docker s'il le faut, télécharge le fichier deploy/docker-compose.yml dans /opt/noah, ouvre les ports web et
# démarre Noah à partir des images publiées (rien n'est compilé sur le VPS). Sans nom de domaine, Noah répond en
# HTTPS sur <ip>.sslip.io. Variables facultatives :
#   NOAH_DOMAIN=noah.example.com   ton domaine (il doit déjà pointer vers ce serveur)
#   NOAH_DIR=/opt/noah             dossier d'installation
#   NOAH_COMPOSE_URL=https://…     fichier compose à utiliser (une copie à toi, par exemple)
# Relancer la commande met Noah Agent à jour sans toucher aux données ni aux secrets.
set -eu

RAW="https://raw.githubusercontent.com/smfcoder17/noah-agent/main"
# Compose de la dernière version, images épinglées par empreinte ; à défaut, celui du dépôt.
RELEASE_COMPOSE="https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml"
COMPOSE_URL="${NOAH_COMPOSE_URL:-}"
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

# Une installation faite avec install.sh (dépôt cloné) garde ses clés dans son .env : la reprendre ici en tirerait
# d'autres et ses données deviendraient illisibles. On s'arrête plutôt.
if docker ps -a --format '{{.Names}}' | grep -q '^noah-server$'; then
  owner=$(docker inspect noah-server --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
  if [ -n "$owner" ] && [ "$owner" != "$DIR" ]; then
    fail "Noah Agent est déjà installé dans $owner (avec install.sh). Mets-le à jour depuis ce dossier :
  cd $owner && git pull && sh install.sh"
  fi
fi

# Ports 80 et 443 : Caddy en a besoin pour le certificat HTTPS. Sur une nouvelle installation, on dit qui les tient.
port_holder() {
  container=$(docker ps --filter "publish=$1" --format '{{.Names}}' | head -1)
  if [ -n "$container" ]; then echo "le conteneur $container"; return; fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/le programme \1/p' | head -1
  elif [ -r /proc/net/tcp ]; then
    hex=$(printf '%04X' "$1")
    if grep -q ":$hex 00000000:0000 0A" /proc/net/tcp /proc/net/tcp6 2>/dev/null; then echo "un programme du serveur"; fi
  fi
}
# Un Traefik tient déjà les ports (Docker Manager de Hostinger) : Noah se range derrière lui, les autres sites ne bougent pas.
if ! docker ps --format '{{.Names}}' | grep -q '^noah-caddy$'; then
  for port in 80 443; do
    holder=$(port_holder "$port")
    [ -n "$holder" ] || continue
    if docker ps --format '{{.Names}} {{.Image}}' | grep -qi 'traefik' && [ -z "$COMPOSE_URL" ]; then
      COMPOSE_URL="$RAW/deploy/docker-compose.traefik.yml"
      if [ -z "${NOAH_DOMAIN:-}" ]; then
        ip=$(curl -4 -fsS https://api.ipify.org) || fail "Adresse publique introuvable. Indique ton domaine : NOAH_DOMAIN=noah.exemple.com"
        NOAH_DOMAIN="$(echo "$ip" | tr . -).sslip.io"
      fi
      say "Un Traefik tient déjà les ports 80 et 443 : Noah Agent se place derrière lui, sur $NOAH_DOMAIN."
      break
    fi
    [ -n "$COMPOSE_URL" ] && break
    fail "Le port $port est déjà pris par $holder. Noah en a besoin pour le HTTPS. Libère-le, ou indique un fichier compose avec NOAH_COMPOSE_URL, puis relance."
  done
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
fi

mkdir -p "$DIR"
cd "$DIR"
say "Téléchargement de Noah Agent…"
if [ -n "$COMPOSE_URL" ]; then
  curl -fsSL "$COMPOSE_URL" -o docker-compose.yml.new
else
  if ! curl -fsSL "$RELEASE_COMPOSE" -o docker-compose.yml.new 2>/dev/null; then
    # Pas encore de version publiée : compose du dépôt, qui suit les étiquettes (stable). Les mises à jour signées
    # épingleront chaque image par empreinte dès la première version.
    printf '\n\033[33mAucune version publiée : installation depuis le dépôt (images non épinglées).\033[0m\n' >&2
    curl -fsSL "$RAW/deploy/docker-compose.yml" -o docker-compose.yml.new
  fi
fi
mv docker-compose.yml.new docker-compose.yml
# Sauvegarde et restauration (sh scripts/backup.sh) : à côté du compose.
mkdir -p scripts
for f in backup.sh restore.sh; do curl -fsSL "$RAW/scripts/$f" -o "scripts/$f" 2>/dev/null || true; done
# Le domaine choisi reste dans .env : une mise à jour (nouveau compose) ne le perd pas.
touch .env
if [ -n "${NOAH_DOMAIN:-}" ]; then
  grep -v '^NOAH_DOMAIN=' .env > .env.new || true
  echo "NOAH_DOMAIN=$NOAH_DOMAIN" >> .env.new && mv .env.new .env
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
url=$(docker compose logs server 2>/dev/null | sed -n 's/.*\(https:\/\/[^ ?]*\).*/\1/p' | tail -1)
url=${url%/}
# Les journaux peuvent dater d'un démarrage précédent : on demande au serveur si le compte existe déjà.
has_account=$(docker compose exec -T server python -c "import json,urllib.request;print(json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/status'))['has_account'])" 2>/dev/null || true)
[ "$has_account" = "True" ] && code=""
if [ -n "$code" ]; then
  url="$url/?installation=$code"
  say "✓ Noah Agent est installé. Le certificat HTTPS peut prendre une minute. Code d'installation : $code"
  say "Ouvre ce lien pour créer ton compte : $url"
elif [ -n "$url" ]; then
  say "✓ Noah Agent est à jour : $url"
else
  say "Noah démarre encore. Le lien s'affichera dans : cd $DIR && docker compose logs server"
fi
