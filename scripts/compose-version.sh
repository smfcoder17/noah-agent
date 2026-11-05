#!/bin/sh
# Le docker-compose.yml joint à une version : chaque image remplacée par son empreinte (celle du manifeste signé).
# C'est ce fichier que servent releases/latest/download/docker-compose.yml, Hostinger et get.sh.
#
#   sh scripts/compose-version.sh smfcoder17 refs.txt deploy/docker-compose.yml > docker-compose.yml
set -eu
OWNER=$(echo "$1" | tr 'A-Z' 'a-z')
REFS=$2
SOURCE=$3

ref() {
  value=$(sed -n "s/^$1=//p" "$REFS")
  [ -n "$value" ] || { echo "$REFS : pas d'empreinte pour $1" >&2; exit 1; }
  echo "$value"
}
SERVER=$(ref noah-server)
LAUNCHER=$(ref noah-launcher)
CADDY=$(ref caddy)
BROWSER=$(ref navigateur)

OUT=$(sed \
  -e "s#ghcr.io/$OWNER/noah-server:stable#$SERVER#" \
  -e "s#ghcr.io/$OWNER/noah-launcher:stable#$LAUNCHER#" \
  -e "s#caddy:2.10-alpine#$CADDY#" \
  -e "s#ghcr.io/$OWNER/noah-browser:stable#$BROWSER#" \
  "$SOURCE")
if echo "$OUT" | grep -nE "image: [^@]+$|_IMAGE: [^@]+$" >&2; then
  echo "image non épinglée" >&2
  exit 1
fi
echo "$OUT"
