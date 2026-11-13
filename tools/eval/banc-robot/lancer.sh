#!/bin/sh
# Lance le banc anti-robot sur le VPS, à côté de Noah sans y toucher. En root :
#
#     curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/feat/020/tools/eval/banc-robot/lancer.sh | sh
#
# Options après « sh -s -- » : --passages 3, --moteurs camoufox,patchright, --taches cloudflare,google.
# Durée : 10 à 15 minutes la première fois (construction de l'image), puis 5 à 10 minutes par passage.
# Résultats dans /root/banc-robot/<date>/ ; l'image se retire avec « docker image rm noah-banc-robot ».
set -eu

BRANCHE="${NOAH_BANC_BRANCHE:-feat/020}"
BASE="https://raw.githubusercontent.com/smfcoder17/noah-agent/$BRANCHE/tools/eval/banc-robot"
DIR="${NOAH_BANC_DIR:-/root/banc-robot}"

libre=$(df -Pk / | awk 'NR==2 {print int($4/1048576)}')
if [ "$libre" -lt 10 ]; then
  echo "Il faut 10 Go libres sur le disque : l'image du banc en prend environ 8 (il y en a $libre). Rien n'a été lancé."
  exit 1
fi

mkdir -p "$DIR/src"
curl -fsSL "$BASE/Dockerfile" -o "$DIR/src/Dockerfile"
curl -fsSL "$BASE/banc.py" -o "$DIR/src/banc.py"

echo "Construction de l'image du banc (quelques minutes la première fois)…"
docker build -q -t noah-banc-robot "$DIR/src" >/dev/null

OUT="$DIR/$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"
docker run --rm --shm-size=2g -v "$OUT:/out" noah-banc-robot "$@"

echo
echo "Résultats et captures : $OUT"
echo "Copie le tableau ci-dessus dans la conversation."
