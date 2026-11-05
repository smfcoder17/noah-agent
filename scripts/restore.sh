#!/usr/bin/env sh
# Restaure une sauvegarde faite par scripts/backup.sh (sur cette machine ou un nouveau VPS).
#   sh scripts/restore.sh backups/noah-20261030-0300.tar
# Remplace les données actuelles : compte, historique, agents et leur machine.
set -eu
cd "$(dirname "$0")/.."
# Sous Git Bash (Windows), Docker veut des chemins Windows et aucune conversion automatique.
here=$(pwd -W 2>/dev/null || pwd)
export MSYS_NO_PATHCONV=1

archive="${1:?Indique l'archive : sh scripts/restore.sh backups/noah-AAAAMMJJ-HHMM.tar}"
[ -f "$archive" ] || { echo "Archive introuvable : $archive" >&2; exit 1; }

printf "Remplacer les données actuelles par %s ? Tape « oui » : " "$archive"
read -r answer
[ "$answer" = "oui" ] || { echo "Annulé."; exit 0; }

work=$(mktemp -d)
tar xf "$archive" -C "$work"
src=$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)

# Le .env de la sauvegarde porte la clé qui déchiffre les secrets : il remplace l'actuel (gardé en .env.avant-restauration).
if [ -f "$src/env" ]; then
  [ -f .env ] && cp .env .env.avant-restauration
  cp "$src/env" .env
fi

docker ps -aq --filter label=noah.agent | xargs -r docker rm -f
docker ps -aq --filter label=noah.browser | xargs -r docker rm -f
docker compose down

for f in "$src"/*.tar.gz; do
  v=$(basename "$f" .tar.gz)
  docker volume create "$v" >/dev/null
  docker run --rm -v "$v:/v" -v "$(cd "$src" && (pwd -W 2>/dev/null || pwd)):/b:ro" alpine sh -c "rm -rf /v/* /v/.[!.]* 2>/dev/null; tar xzf /b/$v.tar.gz -C /v"
  echo "✓ $v"
done
rm -rf "$work"

docker compose up -d
echo "✓ Restauré. Les agents redémarrent à la première ouverture de Noah Agent."
