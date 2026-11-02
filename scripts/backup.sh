#!/usr/bin/env sh
# Sauvegarde Noah Agent : compte, historique, clés chiffrées (volume du serveur) et la machine de chaque
# agent (mémoire, routines, fichiers, connexions). Plus la clé qui les déchiffre : le .env (install.sh) ou le
# volume des secrets (installation sans variables, get.sh).
#   sh scripts/backup.sh            garde les 7 dernières sauvegardes dans backups/
#   KEEP=30 sh scripts/backup.sh    en garde 30
# Pour une sauvegarde chaque nuit à 3 h (crontab -e) :
#   0 3 * * * cd /chemin/vers/noah-agent && sh scripts/backup.sh >> backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
# Sous Git Bash (Windows), Docker veut des chemins Windows et aucune conversion automatique.
here=$(pwd -W 2>/dev/null || pwd)
export MSYS_NO_PATHCONV=1

keep="${KEEP:-7}"
stamp=$(date +%Y%m%d-%H%M)
dir="backups/noah-$stamp"
mkdir -p "$dir"

volumes=$(docker volume ls -q | grep -E '^(apollo_apollo-data|apollo_noah-secrets|apollo-agent-.+|apollo-browser-.+) || true)
[ -n "$volumes" ] || { echo "Aucun volume Noah Agent trouvé." >&2; exit 1; }

for v in $volumes; do
  # Archive lue depuis un conteneur jetable : pas besoin d'arrêter les agents (SQLite est en WAL).
  docker run --rm -v "$v:/v:ro" -v "$here/$dir:/b" alpine tar czf "/b/$v.tar.gz" -C /v .
  echo "✓ $v"
done
if [ -f .env ]; then cp .env "$dir/env" && chmod 600 "$dir/env"; fi

tar cf "$dir.tar" -C backups "noah-$stamp" && rm -rf "$dir"
echo "✓ Sauvegarde : $dir.tar ($(du -h "$dir.tar" | cut -f1))"

# Rotation : on garde les $keep plus récentes.
ls -1t backups/noah-*.tar 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
 || true)
[ -n "$volumes" ] || { echo "Aucun volume Noah Agent trouvé." >&2; exit 1; }

for v in $volumes; do
  # Archive lue depuis un conteneur jetable : pas besoin d'arrêter les agents (SQLite est en WAL).
  docker run --rm -v "$v:/v:ro" -v "$here/$dir:/b" alpine tar czf "/b/$v.tar.gz" -C /v .
  echo "✓ $v"
done
cp .env "$dir/env"
chmod 600 "$dir/env"

tar cf "$dir.tar" -C backups "noah-$stamp" && rm -rf "$dir"
echo "✓ Sauvegarde : $dir.tar ($(du -h "$dir.tar" | cut -f1))"

# Rotation : on garde les $keep plus récentes.
ls -1t backups/noah-*.tar 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
