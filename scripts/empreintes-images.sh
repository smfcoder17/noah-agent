#!/bin/sh
# Empreinte de chaque image d'une version, pour le manifeste signé et le compose épinglé. Lit les registres, n'écrit rien.
# Les dépendances (Hermes, navigateur, Caddy) sont figées ici : elles n'arrivent chez les utilisateurs qu'avec une version.
#
#   sh scripts/empreintes-images.sh smfcoder17 1.2.3 > refs.txt
set -eu
OWNER=$(echo "$1" | tr 'A-Z' 'a-z')
VERSION=$2

digest() {
  d=$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}')
  case "$d" in
    sha256:*) echo "$d" ;;
    *) echo "Pas d'empreinte pour $1 : $d" >&2; exit 1 ;;
  esac
}

echo "noah-server=ghcr.io/$OWNER/noah-server@$(digest "ghcr.io/$OWNER/noah-server:$VERSION")"
echo "noah-launcher=ghcr.io/$OWNER/noah-launcher@$(digest "ghcr.io/$OWNER/noah-launcher:$VERSION")"
# Hermes : la version figée dans le dépôt, celle que la suite de tests fait tourner. Jamais le canal du jour (docs/installation.md).
hermes=$(sed -n 's/^ *AGENT_IMAGE: //p' deploy/docker-compose.yml)
case "$hermes" in
  nousresearch/hermes-agent@sha256:*) echo "hermes=$hermes" ;;
  *) echo "deploy/docker-compose.yml : Hermes n'est pas figé par empreinte ($hermes)" >&2; exit 1 ;;
esac
echo "navigateur=ghcr.io/$OWNER/noah-browser@$(digest "ghcr.io/$OWNER/noah-browser:$VERSION")"
echo "caddy=caddy@$(digest caddy:2.10-alpine)"
