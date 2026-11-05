#!/bin/sh
# X-Forwarded-For contre les limites par adresse, avec le vrai relais (Caddy, même image que le déploiement) et la vraie
# commande du conteneur serveur (--proxy-headers, relais de confiance). Attendu : à travers Caddy, changer cet en-tête à
# chaque essai ne donne aucun essai de plus. Témoin : sans Caddy, l'en-tête fait foi, et c'est pourquoi le port du serveur
# n'est jamais publié sur un VPS (tests/exposition/exposition_test.py). Lance deux conteneurs, supprimés à la fin.
#   sh tests/pairing/xff_caddy.sh
set -e
export MSYS_NO_PATHCONV=1
ROOT=$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))
TAG=noah-essai-qr-xff-$$
NET=$TAG
SRV=$TAG-serveur
RELAY=$TAG-caddy
PORT=${XFF_PORT:-18652}
PORT_DIRECT=$((PORT + 1))
cleanup() {
  docker rm -f "$SRV" "$RELAY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$NET" >/dev/null
docker run -d --name "$SRV" --network "$NET" --network-alias server -p "127.0.0.1:$PORT_DIRECT:8080" \
  -e NOAH_DATA_DIR=/tmp/d -e LAUNCHER_KEY=x -e NOAH_SECRET_KEY=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy \
  -v "$ROOT/server:/app:ro" -w /app python:3.12-slim sh -c \
  "mkdir -p /tmp/d && pip install -q -r /app/requirements.txt && exec uvicorn noah.main:app --host 0.0.0.0 --port 8080 --proxy-headers --forwarded-allow-ips 127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16" >/dev/null
docker run -d --name "$RELAY" --network "$NET" -p "127.0.0.1:$PORT:80" caddy:2.10-alpine \
  caddy reverse-proxy --from :80 --to server:8080 >/dev/null

i=0
until curl -fs "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 240 ] || { docker logs --tail 20 "$SRV"; echo "ÉCHEC : le serveur ne répond pas"; exit 1; }
  sleep 1
done

try() { # port, numéro de l'essai : un code faux avec une adresse inventée
  curl -s -w '\n%{http_code}\n' -X POST "http://127.0.0.1:$1/api/pairing/claim" -H 'Content-Type: application/json' \
    -H "X-Forwarded-For: 203.0.113.$2" -d '{"code":"BCDF-GHJK"}' | tail -n 1 | tr -d '\r'
}

through=""
for n in 1 2 3 4 5 6 7; do through="$through $(try "$PORT" "$n")"; done
echo "à travers Caddy, X-Forwarded-For changé à chaque essai :$through"
case "$through" in
  *" 400 400 400 400 400 429 429"*) ;;
  *) echo "ÉCHEC : l'en-tête falsifié donne des essais de plus à travers Caddy"; exit 1 ;;
esac

direct=""
for n in 21 22 23 24 25 26 27; do direct="$direct $(try "$PORT_DIRECT" "$n")"; done
echo "témoin, port du serveur joint sans relais :$direct"
case "$direct" in
  *429*) echo "le témoin ne voit plus la confiance dans l'en-tête : à relire" ;;
  *) echo "sans relais, l'en-tête fait foi : c'est pourquoi le port du serveur n'est pas publié sur un VPS" ;;
esac
echo "X-Forwarded-For à travers Caddy : tout est vert"
