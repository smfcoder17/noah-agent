#!/bin/sh
# Le vrai get.sh avec un faux docker : NOAH_ADMIN_USER et NOAH_ADMIN_PASSWORD arrivent à « docker compose up » par .env, quittent le
# disque dès que le compte existe, et jamais la sortie du script ne montre le mot de passe.
#     docker run --rm -v "$PWD:/repo:ro" alpine sh /repo/tests/install/get_admin.sh
set -eu
FAUX=$(mktemp -d)
TRAVAIL=$(mktemp -d)
export NOAH_VU="$FAUX/env-au-demarrage"

cat > "$FAUX/docker" <<'EOF'
#!/bin/sh
case "$1 ${2:-} ${3:-}" in
  "compose up "*) cp .env "$NOAH_VU" ;;
  "compose logs "*) echo "Noah est prêt : https://noah.exemple.com" ;;
  "compose exec "*) echo True ;;
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
printf '#!/bin/sh\nexit 0\n' > "$FAUX/sleep"
chmod +x "$FAUX/docker" "$FAUX/curl" "$FAUX/systemctl" "$FAUX/sleep"
export PATH="$FAUX:$PATH"
MOT='p@ss $avec espaces'

sortie=$(NOAH_DIR="$TRAVAIL" NOAH_DOMAIN=noah.exemple.com NOAH_ADMIN_USER=patronne NOAH_ADMIN_PASSWORD="$MOT" sh /repo/get.sh 2>&1)
grep -qF "NOAH_ADMIN_USER='patronne'" "$NOAH_VU" || { echo "ÉCHEC nom absent au démarrage"; cat "$NOAH_VU"; exit 1; }
grep -qF "NOAH_ADMIN_PASSWORD='$MOT'" "$NOAH_VU" || { echo "ÉCHEC mot de passe absent au démarrage"; exit 1; }
echo "ok   transmis au démarrage par .env, tel quel"
if grep -q 'NOAH_ADMIN' "$TRAVAIL/.env"; then echo "ÉCHEC encore dans .env après la création du compte"; exit 1; fi
grep -q '^NOAH_DOMAIN=noah.exemple.com$' "$TRAVAIL/.env" || { echo "ÉCHEC le domaine a disparu de .env"; exit 1; }
echo "ok   retiré de .env dès que le compte existe, le domaine reste"
if printf '%s' "$sortie" | grep -qF "$MOT"; then echo "ÉCHEC mot de passe dans la sortie du script"; exit 1; fi
printf '%s' "$sortie" | grep -q 'avec le compte patronne' || { echo "ÉCHEC la sortie ne dit pas comment se connecter : $sortie"; exit 1; }
printf '%s' "$sortie" | grep -q 'installation=' && { echo "ÉCHEC un lien à code d'installation est montré"; exit 1; }
echo "ok   la fin du script dit de se connecter avec ce compte, sans montrer le mot de passe"

# Sans les variables : .env ne les porte pas.
TRAVAIL2=$(mktemp -d)
NOAH_DIR="$TRAVAIL2" sh /repo/get.sh >/dev/null 2>&1
if grep -q 'NOAH_ADMIN' "$NOAH_VU"; then echo "ÉCHEC variables écrites sans raison"; exit 1; fi
echo "ok   sans les variables, rien n'est écrit"
