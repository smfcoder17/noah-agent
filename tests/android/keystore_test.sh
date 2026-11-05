#!/bin/sh
# G4.5, simulé, sans téléphone : grep des sources et dépendances déclarées, puis le vrai Pairing.java compilé et exécuté
# au-dessus d'un faux fournisseur AndroidKeyStore. La preuve sur téléphone reste à faire (voir docs/grille-validation.md).
#
#   docker run --rm -v "$PWD/mobile:/mobile:ro" -v "$PWD/tests:/tests:ro" eclipse-temurin:21-jdk-alpine sh /tests/android/keystore_test.sh
set -eu
M=/mobile
A=$M/android
J=$A/app/src/main/java/agent/noah/mobile
fail() { echo "ECHEC : $1" >&2; exit 1; }

# 1. Dépendances déclarées et code : EncryptedSharedPreferences (déprécié) n'y est pas, sous aucun de ses noms.
INTERDIT='security-crypto|androidx\.security|EncryptedSharedPreferences|EncryptedFile|MasterKey'
FILES="$A/app/build.gradle $A/build.gradle $A/variables.gradle $A/settings.gradle $A/capacitor.settings.gradle $A/app/capacitor.build.gradle $M/package.json $M/package-lock.json"
for f in $FILES; do [ -f "$f" ] || fail "$f absent : le grep ne regarderait rien"; done
grep -q 'org.unifiedpush.android:connector' "$A/app/build.gradle" || fail "build.gradle sans ses dépendances : le grep ne regarde pas le bon fichier"
grep -q '@capacitor/core' "$M/package-lock.json" || fail "package-lock.json vide : le grep ne regarde pas le bon fichier"
if grep -nEi "$INTERDIT" $FILES; then fail "dépendance interdite déclarée"; fi
if grep -rnEi "$INTERDIT" "$A/app/src/main" "$M/www"; then fail "stockage déprécié utilisé dans le code"; fi
echo "1. EncryptedSharedPreferences et security-crypto absents des dépendances déclarées et du code"

# 2. Le jeton n'a pas d'autre rangement : Pairing est seul à écrire, et rien ne le journalise ni ne le met en clair ailleurs.
OTHERS=$(grep -rlE 'getSharedPreferences|openFileOutput|FileOutputStream|getExternalFilesDir' "$A/app/src/main/java" | grep -v '/Pairing.java$' || true)
[ -z "$OTHERS" ] || fail "autre rangement sur le disque : $OTHERS"
if grep -rnE 'Log\.[a-z]+\(.*([tT]oken|[sS]ession)|System\.out.*[tT]oken|printStackTrace' "$A/app/src/main/java"; then fail "jeton journalisé"; fi
if grep -nE 'localStorage|sessionStorage|indexedDB|document\.cookie' "$M/www/app.js"; then fail "l'écran de connexion range quelque chose en clair"; fi
# Le fournisseur est nommé : le faux Keystore ci-dessous ne peut pas distinguer une demande sans fournisseur (retombée sur lui).
grep -q 'KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")' "$J/Pairing.java" || fail "clé générée hors du Keystore"
grep -q 'KeyStore.getInstance("AndroidKeyStore")' "$J/Pairing.java" || fail "clé lue hors du Keystore"
grep -q 'android:allowBackup="false"' "$A/app/src/main/AndroidManifest.xml" || fail "sauvegarde Android permise"
for rule in cloud-backup device-transfer; do
  sed -n "/<$rule>/,/<\/$rule>/p" "$A/app/src/main/res/xml/data_extraction_rules.xml" | grep -q 'domain="sharedpref"' || fail "$rule : préférences non exclues"
done
echo "2. seul Pairing écrit sur le disque, rien n'est journalisé, ni sauvegarde ni transfert des préférences"

# 3. Le vrai Pairing.java, compilé tel quel, exécuté.
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
javac -nowarn -d "$W" -encoding UTF-8 "$J/Pairing.java" /tests/android/PairingKeystoreTest.java /tests/android/FauxKeystore.java \
  $(find /tests/android/stubs -name '*.java')
java -cp "$W" agent.noah.mobile.PairingKeystoreTest
