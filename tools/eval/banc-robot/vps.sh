#!/bin/sh
# Banc dans UN conteneur lancé par le Docker Manager de Hostinger (sans SSH). Chaque moteur est installé, passé au
# banc, puis effacé avant le suivant, pour garder le disque bas. Le tableau final sort dans le journal du projet.
#     NOAH_BANC_PASSAGES=3 sh vps.sh
set -u
P="${NOAH_BANC_PASSAGES:-3}"
cd /banc
for m in ${NOAH_BANC_MOTEURS:-chromium patchright camoufox}; do
  sh /banc/moteur.sh "$m" --passages "$P" --sortie /out || echo "[$m] arrêté (code $?)."
  rm -rf /root/.cache/ms-playwright /root/.cache/camoufox /opt/google /root/.cache/pip
  pip uninstall -y -q playwright patchright camoufox >/dev/null 2>&1
done
python /banc/banc.py --fusion --sortie /out
echo "BANC TERMINÉ"
sleep infinity
