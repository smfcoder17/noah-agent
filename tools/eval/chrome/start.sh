#!/bin/sh
# Écran 1920x1080 comme Camoufox, Chromium avec fenêtre, CDP relayé hors du conteneur (Chromium n'écoute que 127.0.0.1).
set -e
Xvfb :0 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:0
sleep 1
openbox &
x11vnc -display :0 -forever -shared -localhost -rfbport 5900 -nopw -quiet -bg
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
exec chromium --no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --remote-debugging-port=9222 --user-data-dir=/data/profil --window-size=1920,1040 --window-position=0,0 \
  --autoplay-policy=no-user-gesture-required about:blank
