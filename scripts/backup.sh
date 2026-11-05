#!/usr/bin/env sh
# Sauvegarde Noah Agent : compte, historique, clés chiffrées (volume du serveur) et la machine de chaque
# agent (mémoire, routines, fichiers, connexions). Plus la clé qui les déchiffre : le .env (install.sh) ou le
# volume des secrets (installation sans variables, get.sh).
#   sh scripts/backup.sh            garde les 7 dernières sauvegardes dans backups/
#   KEEP=30 sh scripts/backup.sh    en garde 30
# Pour une sauvegarde chaque nuit à 3 h (crontab -e) :
#   0 3 * * * cd /chemin/vers/noah-agent && sh scripts/backup.sh >> backups/backup.log 2>&1
set -eu
# Clés, bases, jetons et cookies : lisibles par toi seul (fichiers 0600, dossiers 0700).
umask 077
cd "$(dirname "$0")/.."
# Sous Git Bash (Windows), Docker veut des chemins Windows et aucune conversion automatique.
here=$(pwd -W 2>/dev/null || pwd)
export MSYS_NO_PATHCONV=1

keep="${KEEP:-7}"
stamp=$(date +%Y%m%d-%H%M)
dir="backups/noah-$stamp"
mkdir -p "$dir"

volumes=$(docker volume ls -q | grep -E '^(noah_noah-data|noah_noah-secrets|noah-agent-.+|noah-browser-.+)' || true)
[ -n "$volumes" ] || { echo "Aucun volume Noah Agent trouvé." >&2; exit 1; }

# Bases SQLite copiées par l'API de sauvegarde de SQLite (instantané cohérent, même pendant que les agents écrivent) ;
# copier le fichier et son WAL l'un après l'autre peut perdre une transaction validée. Le reste est archivé tel quel.
SNAPSHOT='
import os, sqlite3, sys, tarfile, tempfile
src, out = "/v", sys.argv[1]
skip = (".db", ".db-wal", ".db-shm", ".db-journal")
with tarfile.open(out, "w:gz") as tar:
    tar.add(src, arcname=".", filter=lambda t: None if t.name.endswith(skip) else t)
    for root, _, files in os.walk(src):
        for name in files:
            if not name.endswith(".db"):
                continue
            path = os.path.join(root, name)
            try:
                db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                db.execute("SELECT 1 FROM sqlite_master LIMIT 1")
            except sqlite3.DatabaseError:
                tar.add(path, arcname=os.path.relpath(path, src))  # pas une base SQLite : copié tel quel
                continue
            with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
                copy = sqlite3.connect(tmp.name)
                db.backup(copy)
                copy.close()
                info = tar.gettarinfo(tmp.name, arcname=os.path.relpath(path, src))
                st = os.stat(path)
                info.uid, info.gid, info.mode = st.st_uid, st.st_gid, st.st_mode
                with open(tmp.name, "rb") as f:
                    tar.addfile(info, f)
            db.close()
'
image=$(docker image inspect nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d >/dev/null 2>&1 && echo nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d || echo python:3.12-alpine)
for v in $volumes; do
  # Conteneur jetable, sans arrêter les agents.
  docker run --rm --user root --entrypoint python -v "$v:/v" -v "$here/$dir:/b" "$image" -c "$SNAPSHOT" "/b/$v.tar.gz"
  echo "✓ $v"
done
if [ -f .env ]; then cp .env "$dir/env" && chmod 600 "$dir/env"; fi

tar cf "$dir.tar" -C backups "noah-$stamp" && rm -rf "$dir" && chmod 600 "$dir.tar"
echo "✓ Sauvegarde : $dir.tar ($(du -h "$dir.tar" | cut -f1))"

# Rotation : on garde les $keep plus récentes.
ls -1t backups/noah-*.tar 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
