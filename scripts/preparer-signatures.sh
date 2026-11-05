#!/usr/bin/env sh
# Prépare, une seule fois et sur demande explicite, les deux clés d'une version de Noah Agent :
#   - la clé Ed25519 qui signe le manifeste des mises à jour automatiques ;
#   - le keystore qui signe l'APK Android.
# Tout reste hors du dépôt. Ce script ne pose aucun secret et n'envoie rien : il affiche les commandes à lancer.
#
#   sh scripts/preparer-signatures.sh                    explique, ne crée rien
#   sh scripts/preparer-signatures.sh --generer [--dossier CHEMIN]
#
# Dossier par défaut : ~/.noah-signatures. Refuse un dossier dans un dépôt git et n'écrase jamais une clé existante :
# remplacer le keystore obligerait chaque utilisateur à désinstaller l'app ; remplacer la clé du manifeste couperait les
# mises à jour automatiques de tous les serveurs déjà installés.
# Il faut keytool (un JDK), et Python avec cryptography, ou Docker.
set -eu

REPO=smfcoder17/noah-agent
ALIAS=noah
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${HOME:-}/.noah-signatures
GENERATE=false

die() { printf 'ECHEC : %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Rien n'a été créé. Pour générer les clés (une seule fois) :
  sh scripts/preparer-signatures.sh --generer [--dossier CHEMIN]

Secrets GitHub qu'une version stable exige :
  NOAH_RELEASE_KEY            clé privée du manifeste
  NOAH_APK_KEYSTORE           keystore Android, en base64
  NOAH_APK_KEYSTORE_PASSWORD  mot de passe du keystore
  NOAH_APK_KEY_ALIAS          alias de la clé dans le keystore
Variable GitHub (publique) :
  NOAH_UPDATE_KEY             clé publique du manifeste, copiée dans les images
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --generer) GENERATE=true ;;
    --dossier)
      [ $# -ge 2 ] || die "--dossier demande un chemin"
      DIR=$2
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
  shift
done

if [ "$GENERATE" != true ]; then
  usage
  exit 0
fi

case "$DIR" in
  /*|[A-Za-z]:*) ;;
  *) DIR=$(pwd)/$DIR ;;
esac

# Jamais dans un dépôt git, celui-ci ou un autre : un « git add -A » suffirait à publier une clé.
p=$DIR
while :; do
  [ ! -e "$p/.git" ] || die "$DIR est dans le dépôt git $p : choisis un dossier hors de tout dépôt"
  parent=$(dirname "$p")
  case "$parent" in "$p"|.) break ;; esac
  p=$parent
done

PRIVATE=$DIR/release.key
PUBLIC=$DIR/release.pub
KEYSTORE=$DIR/noah-apk.keystore
KEYSTORE_B64=$DIR/noah-apk.keystore.b64
PASSWORD_FILE=$DIR/noah-apk.password
for f in "$PRIVATE" "$PUBLIC" "$KEYSTORE" "$KEYSTORE_B64" "$PASSWORD_FILE"; do
  [ ! -e "$f" ] || die "$f existe déjà : on ne remplace jamais une clé. Si elle est vraiment à refaire, déplace-la d'abord toi-même."
done

KEYTOOL=keytool
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then KEYTOOL=$JAVA_HOME/bin/keytool; fi
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool.exe" ]; then KEYTOOL=$JAVA_HOME/bin/keytool.exe; fi
command -v "$KEYTOOL" >/dev/null 2>&1 || die "keytool introuvable : installe un JDK ou pose JAVA_HOME"

# La clé du manifeste : le même code que la CI, sur cette machine si elle a de quoi, sinon dans un conteneur jetable.
manifest_key() {
  for py in python3 python; do
    if "$py" -c 'import cryptography' >/dev/null 2>&1; then
      PYTHONIOENCODING=utf-8 "$py" "$HERE/release-manifest.py" cle
      return
    fi
  done
  command -v docker >/dev/null 2>&1 || die "ni Python avec cryptography, ni Docker"
  docker run --rm -i python:3.12-slim sh -c 'pip install -q cryptography==44.0.0 >/dev/null 2>&1 && python - cle' <"$HERE/release-manifest.py"
}

umask 077
KEYS=$(manifest_key) || die "clé du manifeste impossible à générer"
PRIVATE_VALUE=$(printf '%s\n' "$KEYS" | sed -n 1p | awk '{print $NF}')
PUBLIC_VALUE=$(printf '%s\n' "$KEYS" | sed -n 2p | awk '{print $NF}')
[ "${#PRIVATE_VALUE}" = 44 ] && [ "${#PUBLIC_VALUE}" = 44 ] || die "clé du manifeste inattendue"

mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true
printf '%s' "$PRIVATE_VALUE" >"$PRIVATE"
printf '%s' "$PUBLIC_VALUE" >"$PUBLIC"

# Mot de passe tiré au hasard, passé par l'environnement : jamais sur une ligne de commande.
NOAH_KS_PASS=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
export NOAH_KS_PASS
printf '%s' "$NOAH_KS_PASS" >"$PASSWORD_FILE"
NATIVE=$KEYSTORE
if command -v cygpath >/dev/null 2>&1; then NATIVE=$(cygpath -m "$KEYSTORE"); fi  # keytool.exe sous Git Bash
"$KEYTOOL" -genkeypair -keystore "$NATIVE" -storetype PKCS12 -alias "$ALIAS" -keyalg RSA -keysize 4096 \
  -validity 10000 -dname "CN=Noah Agent, O=Noah Agent" -storepass:env NOAH_KS_PASS -keypass:env NOAH_KS_PASS >/dev/null 2>&1 \
  || die "keytool n'a pas pu créer le keystore"
base64 <"$KEYSTORE" | tr -d '\r\n' >"$KEYSTORE_B64"
FINGERPRINT=$("$KEYTOOL" -list -v -keystore "$NATIVE" -alias "$ALIAS" -storepass:env NOAH_KS_PASS 2>/dev/null | grep -m1 'SHA256:' | sed 's/^[[:space:]]*//')
unset NOAH_KS_PASS

cat <<EOF

Clés créées dans $DIR (les valeurs ne sont affichées nulle part).
Certificat de l'APK : $FINGERPRINT

Secrets et variable à poser, depuis la racine du dépôt :
  gh secret set NOAH_RELEASE_KEY -R $REPO < "$PRIVATE"
  gh secret set NOAH_APK_KEYSTORE -R $REPO < "$KEYSTORE_B64"
  gh secret set NOAH_APK_KEYSTORE_PASSWORD -R $REPO < "$PASSWORD_FILE"
  gh secret set NOAH_APK_KEY_ALIAS -R $REPO --body "$ALIAS"
  gh variable set NOAH_UPDATE_KEY -R $REPO < "$PUBLIC"

À copier maintenant hors de cette machine (gestionnaire de mots de passe, support hors ligne) :
  release.key, noah-apk.keystore, noah-apk.password.
Keystore perdu : chaque utilisateur devra désinstaller l'app pour la version suivante.
Clé du manifeste perdue : les serveurs déjà installés ne se mettront plus à jour seuls.
EOF
