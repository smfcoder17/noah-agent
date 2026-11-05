#!/bin/sh
# Un APK publié est signé, et pas avec la clé de débogage : sinon chaque build demande de désinstaller l'app.
#
#   sh tests/android/apk_signature.sh noah-agent-android.apk
#   APKSIGNER=chemin/vers/apksigner : sinon le plus récent de $ANDROID_HOME/build-tools
set -eu
APK=$1
fail() { echo "ECHEC : $1" >&2; exit 1; }

SIGNER=${APKSIGNER:-}
if [ -z "$SIGNER" ]; then
  [ -n "${ANDROID_HOME:-}" ] || fail "ni APKSIGNER ni ANDROID_HOME"
  TOOLS=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
  SIGNER=$TOOLS/apksigner
  [ -e "$SIGNER" ] || SIGNER=$TOOLS/apksigner.bat
fi

OUT=$("$SIGNER" verify --verbose --print-certs "$APK" 2>&1) || { echo "$OUT" >&2; fail "$APK n'est pas signé correctement"; }
echo "$OUT" | grep -q "Verified using v2 scheme (APK Signature Scheme v2): true" || fail "pas de signature v2 : $APK"
if echo "$OUT" | grep -q "CN=Android Debug"; then fail "$APK est signé avec la clé de débogage"; fi
echo "$OUT" | grep -E "certificate DN|certificate SHA-256"
echo "APK signé, clé de version"
