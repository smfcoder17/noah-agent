#!/bin/sh
# Lance le banc anti-robot sur le VPS, à côté de Noah sans y toucher. En root :
#
#     curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/feat/020/tools/eval/banc-robot/lancer.sh | sh
#
# Options après « sh -s -- » : --passages 3, --taches cloudflare,google. Moteurs : NOAH_BANC_MOTEURS="camoufox patchright".
#
# Léger par construction : un moteur à la fois, dans un conteneur jetable (--rm) bridé à 1,5 Go de mémoire (pic mesuré : 1,3 Go) et un
# processeur, en priorité basse. Rien ne reste après : ni image construite, ni conteneur ; seule l'image python:3.12-slim
# (~150 Mo) est téléchargée, puis retirée si elle n'était pas là avant. Pic sur le disque : 4,4 Go pendant le tour de Camoufox (son navigateur pèse 2,4 Go), rendus à la fin.
set -eu

BRANCHE="${NOAH_BANC_BRANCHE:-feat/020}"
BASE="https://raw.githubusercontent.com/smfcoder17/noah-agent/$BRANCHE/tools/eval/banc-robot"
DIR="${NOAH_BANC_DIR:-/root/banc-robot}"
MOTEURS="${NOAH_BANC_MOTEURS:-chromium patchright camoufox}"
IMAGE=python:3.12-slim-bookworm

libre_disque=$(df -Pk / | awk 'NR==2 {print int($4/1048576)}')
libre_mem=$(awk '/MemAvailable/ {print int($2/1048576*10)/10}' /proc/meminfo)
echo "Disque libre : ${libre_disque} Go. Mémoire disponible : ${libre_mem} Go."
if [ "$libre_disque" -lt 6 ]; then
  echo "Il faut 6 Go libres sur le disque (Camoufox seul en prend 4,4 pendant son tour). Rien n'a été lancé."; exit 1
fi
if awk "BEGIN {exit !($libre_mem < 2)}"; then
  echo "Il faut 2 Go de mémoire disponible pour ne gêner aucune autre application. Rien n'a été lancé."; exit 1
fi

mkdir -p "$DIR/src"
curl -fsSL "$BASE/banc.py" -o "$DIR/src/banc.py"
curl -fsSL "$BASE/moteur.sh" -o "$DIR/src/moteur.sh"
OUT="$DIR/$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"

avait_image=$(docker image inspect "$IMAGE" >/dev/null 2>&1 && echo oui || echo non)
for m in $MOTEURS; do
  docker run --rm --name "banc-robot-$m" --memory=1536m --memory-swap=1536m --cpus=1 --cpu-shares=256 \
    --shm-size=512m -v "$DIR/src:/banc:ro" -v "$OUT:/out" "$IMAGE" sh /banc/moteur.sh "$m" "$@" \
    || echo "[$m] le banc s'est arrêté en erreur, on passe au suivant."
done
docker run --rm -v "$DIR/src:/banc:ro" -v "$OUT:/out" "$IMAGE" python /banc/banc.py --fusion
[ "$avait_image" = non ] && docker image rm "$IMAGE" >/dev/null 2>&1 || true

echo
echo "Résultats et captures : $OUT"
