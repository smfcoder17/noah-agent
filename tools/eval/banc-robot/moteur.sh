#!/bin/sh
# Installe UN moteur dans un conteneur jetable (python:3.12-slim), le passe au banc, et tout disparaît à la sortie.
#     sh /banc/moteur.sh chromium|patchright|camoufox [options de banc.py]
set -eu
MOTEUR="$1"; shift
export DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1
echo "[$MOTEUR] installation…"
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends xvfb xauth ca-certificates libatomic1 fonts-liberation fonts-noto-color-emoji >/dev/null
case "$MOTEUR" in
  chromium)
    pip install -q playwright
    playwright install --with-deps chromium >/dev/null ;;
  patchright)
    pip install -q patchright
    if [ "$(uname -m)" = "x86_64" ]; then patchright install --with-deps chrome >/dev/null
    else patchright install --with-deps chromium >/dev/null; fi ;;
  camoufox)
    pip install -q "camoufox[geoip]" playwright
    # Seulement les bibliothèques dont Firefox a besoin : « playwright install-deps firefox » en ajoute 2 Go de plus.
    apt-get install -y -qq --no-install-recommends libgtk-3-0 libx11-xcb1 libasound2 libdbus-glib-1-2 libxtst6 libpci3 >/dev/null
    python -m camoufox fetch >/dev/null ;;
  *) echo "moteur inconnu : $MOTEUR"; exit 2 ;;
esac
rm -rf /var/lib/apt/lists/* /root/.cache/pip
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
echo "[$MOTEUR] banc…"
exec python /banc/banc.py --moteurs "$MOTEUR" "$@"
