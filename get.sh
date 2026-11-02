#!/usr/bin/env sh
# Installation de Noah Agent sur un VPS vierge, en une commande (Ubuntu ou Debian, en root) :
#
#   curl -fsSL https://raw.githubusercontent.com/SmfCoder/noah-agent/main/get.sh | sh
#
# Installe Docker et Git s'il le faut, télécharge Noah Agent dans /opt/noah, ouvre les ports web, puis lance
# install.sh. Sans nom de domaine, Noah répond sur <ip>.sslip.io, en HTTPS. Variables facultatives :
#   NOAH_DOMAIN=noah.example.com   ton domaine (il doit déjà pointer vers ce serveur)
#   NOAH_DIR=/opt/noah             dossier d'installation
#   NOAH_REPO=https://…            dépôt à installer (une copie à toi, par exemple)
# Relancer la commande met Noah Agent à jour sans toucher aux données ni aux secrets.
set -eu

REPO="${NOAH_REPO:-https://github.com/SmfCoder/noah-agent.git}"
DIR="${NOAH_DIR:-/opt/noah}"
DOMAIN="${NOAH_DOMAIN:-auto}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    say "Relance avec sudo…"
    exec sudo -E sh -c "curl -fsSL '${NOAH_GET_URL:-https://raw.githubusercontent.com/SmfCoder/noah-agent/main/get.sh}' | sh"
  fi
  echo "Lance cette commande en root (ou avec sudo)." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  say "Installation de curl et git…"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git ca-certificates openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl git openssl
  else
    echo "Installe curl et git, puis relance." >&2
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installation de Docker (script officiel get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

if [ -d "$DIR/.git" ]; then
  say "Mise à jour de Noah Agent dans $DIR…"
  git -C "$DIR" pull --ff-only
else
  say "Téléchargement de Noah Agent dans $DIR…"
  git clone --depth 1 "$REPO" "$DIR"
fi

# Pare-feu : HTTP (certificat) et HTTPS. Le port de Noah (8080) reste fermé au monde, Caddy est devant.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
fi

cd "$DIR"
if grep -q "^NOAH_DOMAIN=" .env 2>/dev/null; then
  sh install.sh          # mise à jour : on garde le domaine déjà configuré
else
  sh install.sh --domaine "$DOMAIN"
fi
