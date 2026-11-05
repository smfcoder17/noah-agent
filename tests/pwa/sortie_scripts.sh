#!/bin/sh
# Lance les vrais get.sh et install.sh avec un faux docker : seule leur sortie compte (ce que la personne lit à la fin).
#     sh sortie_scripts.sh <dossier du dépôt> <journal du serveur à servir pour « docker compose logs server »>
set -eu
DEPOT=$1
export NOAH_FAUX_JOURNAL="$2"
FAUX=$(mktemp -d)
TRAVAIL=$(mktemp -d)

cat > "$FAUX/docker" <<'EOF'
#!/bin/sh
case "$1 ${2:-}" in
  "compose logs") cat "$NOAH_FAUX_JOURNAL" ;;
  "compose exec") echo False ;;
esac
exit 0
EOF
cat > "$FAUX/curl" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then echo "faux" > "$2"; fi
  shift
done
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' > "$FAUX/systemctl"
printf '#!/bin/sh\nexit 0\n' > "$FAUX/sleep"  # get.sh attend le lien jusqu'à 2 min quand le journal ne le donne pas
chmod +x "$FAUX/docker" "$FAUX/curl" "$FAUX/systemctl" "$FAUX/sleep"
export PATH="$FAUX:$PATH"

echo "=== get.sh"
NOAH_DIR="$TRAVAIL/noah" sh "$DEPOT/get.sh" 2>&1
echo "=== install.sh"
cd "$TRAVAIL"
sh "$DEPOT/install.sh" 2>&1
