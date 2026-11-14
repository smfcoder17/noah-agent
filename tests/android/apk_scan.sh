#!/bin/sh
# G4.5, dépendances réellement embarquées : grep dans l'APK construit (classes de toutes les bibliothèques, transitives
# comprises) et, si donné, dans l'arbre résolu par Gradle.
#
#   sh tests/android/apk_scan.sh app-github-debug.apk [sortie de ./gradlew :app:dependencies --configuration githubDebugRuntimeClasspath]
set -eu
APK=$1
DEPS=${2:-}
fail() { echo "ECHEC : $1" >&2; exit 1; }
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

unzip -p "$APK" 'classes*.dex' >"$W/classes"
# Témoins : le grep doit trouver ce qui est là, sinon il ne regarde rien.
for present in 'Lagent/noah/mobile/Pairing;' 'Lorg/unifiedpush/android/connector/UnifiedPush;' 'AndroidKeyStore'; do
  grep -aq "$present" "$W/classes" || fail "$present absent de l'APK : le grep ne regarde pas le bon contenu"
done
for absent in 'Landroidx/security/crypto/' 'EncryptedSharedPreferences'; do
  if grep -aq "$absent" "$W/classes"; then fail "$absent embarqué dans l'APK"; fi
done
echo "APK : Pairing, UnifiedPush et AndroidKeyStore présents ; androidx.security.crypto et EncryptedSharedPreferences absents"

if [ -n "$DEPS" ]; then
  grep -q 'org.unifiedpush.android:connector' "$DEPS" || fail "$DEPS sans UnifiedPush : ce n'est pas l'arbre de l'app"
  if grep -E 'androidx\.security|security-crypto' "$DEPS"; then fail "dépendance transitive interdite"; fi
  echo "Gradle : arbre résolu sans androidx.security ni security-crypto"
fi
