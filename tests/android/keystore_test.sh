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
OTHERS=$(grep -rlE 'getSharedPreferences|openFileOutput|FileOutputStream|getExternalFilesDir' "$A/app/src/main/java" | grep -vE '/(Pairing|NoahMedia).java$' || true)
# NoahMedia (0.1.6) écrit seulement les médias téléchargés, dans le cache, pour les ouvrir. Il lit le jeton pour
# s'authentifier auprès de Noah, mais ne doit ni le ranger, ni le passer à FileOutputStream, ni écrire hors du cache.
MEDIA="$A/app/src/main/java/agent/noah/mobile/NoahMedia.java"
grep -q 'getCacheDir()' "$MEDIA" || fail "NoahMedia écrit hors du cache"
if grep -nE 'getSharedPreferences|openFileOutput|getExternalFilesDir|write\(.*([tT]oken|pairing)' "$MEDIA"; then fail "NoahMedia range le jeton"; fi
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

# Le jeton d'appareil ne va jamais dans la WebView, et plus rien ne lit le cookie à sa place.
COOKIES=$(grep -n 'noah_session=' "$J/MainActivity.java")
echo "$COOKIES" | grep -q 'window\.token' || fail "cookie de la fenêtre introuvable : ce contrôle ne regarde rien"
if echo "$COOKIES" | grep -v 'windowSession' | grep -qv 'window\.token'; then fail "autre chose que la session de fenêtre mis en cookie : $COOKIES"; fi
grep -q 'windowSession = window\.token' "$J/MainActivity.java" || fail "windowSession ne vient plus de la session de fenêtre"
if grep -rnE 'windowToken|getCookie|\.session\(\)' "$A/app/src/main/java"; then fail "le cookie est relu : fenêtre fermée, seul le jeton chiffré compte"; fi
echo "2 bis. la fenêtre ne reçoit que sa session courte, et plus rien ne relit le cookie"

# 0.1.8 : « Changer de serveur » sur la page d'attente efface le jeton de l'ancien serveur avant de rouvrir l'app, comme
# « Oublier ce serveur » : sans ça, l'ancien jeton partirait vers le serveur suivant. Bouton écouté seulement sur la page
# d'attente, après un toucher.
CHANGE=$(sed -n '/private void changeServer()/,/^    }/p' "$J/MainActivity.java")
[ -n "$CHANGE" ] || fail "changeServer introuvable : ce contrôle ne regarde rien"
for step in 'pairing.forget();' 'NoahPush.stop(this);' 'revokeForgotten' 'removeAllCookies' 'windowSession = null;' 'recreate();'; do
  echo "$CHANGE" | grep -qF "$step" || fail "changer de serveur sans $step"
done
[ "$(echo "$CHANGE" | grep -nF 'pairing.forget();' | cut -d: -f1)" -lt "$(echo "$CHANGE" | grep -nF 'recreate();' | cut -d: -f1)" ] \
  || fail "l'app se rouvre avant d'oublier le jeton"
grep -q 'if (!waiting || !request.isForMainFrame() || !request.hasGesture()) return true;' "$J/MainActivity.java" \
  || fail "les boutons de la page d'attente répondent hors de la page d'attente ou sans toucher"
# App cachée : la boucle de 5 minutes et les essais hors ligne s'arrêtent ; la réception des appels (CallWatch) reste.
STOP=$(sed -n '/public void onStop()/,/^    }/p' "$J/MainActivity.java")
echo "$STOP" | grep -q 'removeCallbacks(retry)' || fail "boucle de 5 minutes laissée app cachée"
echo "$STOP" | grep -q 'removeCallbacks(reload)' || fail "essais hors ligne laissés app cachée"
if echo "$STOP" | grep -q 'CallWatch'; then fail "app cachée : la réception des appels est coupée"; fi
echo "2 ter. changer de serveur efface l'ancien jeton ; app cachée, plus de boucle, les appels restent"

# 3. Le vrai Pairing.java, compilé tel quel, exécuté.
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
javac -nowarn -d "$W" -encoding UTF-8 "$J/Pairing.java" /tests/android/PairingKeystoreTest.java /tests/android/FauxKeystore.java \
  $(find /tests/android/stubs -name '*.java')
java -cp "$W" agent.noah.mobile.PairingKeystoreTest
