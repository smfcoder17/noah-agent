#!/bin/sh
# Ce que l'app ne doit jamais pouvoir faire, lu dans ses sources : pas de position en arrière-plan, pas d'accès à la galerie, rien qui lise
# l'écran des autres apps, une bulle qui ne repart jamais seule et qui ne garde pas le jeton.
#
#   sh tests/android/droits_test.sh
set -eu
ROOT=$(dirname "$0")/../../mobile/android/app/src/main
MANIFEST=$ROOT/AndroidManifest.xml
JAVA=$ROOT/java/agent/noah/mobile
fail() { echo "ECHEC : $1" >&2; exit 1; }

# Témoins : le test lit le bon fichier.
grep -q 'android.permission.SYSTEM_ALERT_WINDOW' "$MANIFEST" || fail "manifeste sans superposition : mauvais fichier"
grep -q 'android:name=".NoahBubble"' "$MANIFEST" || fail "bulle absente du manifeste"
for absent in ACCESS_BACKGROUND_LOCATION READ_MEDIA_IMAGES READ_MEDIA_VISUAL_USER_SELECTED READ_EXTERNAL_STORAGE BIND_ACCESSIBILITY_SERVICE FOREGROUND_SERVICE_MEDIA_PROJECTION; do
  if grep -q "$absent" "$MANIFEST"; then fail "$absent demandé dans le manifeste"; fi
done
for absent in AccessibilityService MediaProjection PixelCopy getRunningTasks; do
  if grep -q "$absent" "$JAVA/NoahBubble.java"; then fail "$absent dans la bulle : elle ne doit rien lire des autres apps"; fi
done
echo "manifeste : ni position en arrière-plan, ni galerie, ni lecture d'écran"

# Une seule porte d'entrée pour la bulle : le geste dans l'app.
if grep -q 'NoahBubble' "$JAVA/BootReceiver.java"; then fail "la bulle repartirait au redémarrage"; fi
grep -q 'return START_NOT_STICKY; // jamais relancé' "$JAVA/NoahBubble.java" || fail "la bulle serait relancée par Android"
callers=$(grep -l 'NoahBubble.start(' "$JAVA"/*.java | wc -l)
[ "$callers" -eq 1 ] || fail "NoahBubble.start appelé ailleurs que dans le plugin"
grep -q 'NoahBubble.start(' "$JAVA/NoahShellPlugin.java" || fail "NoahBubble.start hors du plugin"
echo "bulle : démarrée seulement par le geste dans l'app, jamais au redémarrage"

# Le jeton : lu au moment d'envoyer, jamais rangé ni montré.
if grep -nE 'putString\("(token|jeton)|setText\(.*token|Log\.[a-z]+\(.*token' "$JAVA/NoahBubble.java"; then fail "le jeton sortirait de Pairing"; fi
grep -q 'BuildConfig.DEBUG) heardFrom' "$JAVA/NoahBubble.java" || fail "le seuil d'essai doit rester réservé à l'APK de débogage"
echo "jeton : ni rangé, ni affiché, ni journalisé par la bulle"

# Rien à l'ouverture de l'app : les demandes de droit passent par le plugin, sur un geste.
if grep -n 'requestPermissions' "$JAVA/NoahPush.java" "$JAVA/MainActivity.java" "$JAVA/CallWatch.java"; then fail "un droit demandé sans geste de la personne"; fi
echo "droits : aucune demande à l'ouverture de l'app"
