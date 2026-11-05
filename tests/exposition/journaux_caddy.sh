#!/bin/sh
# Ce que le journal d'accès du vrai Caddy garde, avec le Caddyfile du déploiement : ni code d'installation, ni jeton d'aperçu.
# Sans serveur derrière : Caddy répond 502 et journalise quand même. Valide aussi le Caddyfile écrit dans le compose du VPS.
#   sh tests/exposition/journaux_caddy.sh
set -e
export MSYS_NO_PATHCONV=1
ROOT=$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))
TAG=noah-essai-journaux-$$
cleanup() { docker rm -f "$TAG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

sed -n '/^    content: |/,/^networks:/p' "$ROOT/deploy/docker-compose.yml" | sed '1d;$d' | sed 's/^      //' |
  docker run -i --rm caddy:2.10-alpine sh -c 'cat > /tmp/Caddyfile && caddy validate --config /tmp/Caddyfile --adapter caddyfile' >/dev/null 2>&1 ||
  { echo "ÉCHEC : le Caddyfile du compose est refusé"; exit 1; }

docker run -d --name "$TAG" -e NOAH_DOMAIN=http://:80 -v "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine >/dev/null
visit() { docker exec "$TAG" wget -q -O /dev/null "$@" 2>/dev/null || true; }
i=0
until docker exec "$TAG" wget -q -O /dev/null http://localhost/ 2>&1 | grep -q "502"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { docker logs --tail 20 "$TAG"; echo "ÉCHEC : Caddy ne répond pas"; exit 1; }
  sleep 1
done
visit "http://localhost/?installation=CODE-SECRET-A&autre=gardee"
visit --header "Referer: https://noah.example/?installation=CODE-SECRET-B" http://localhost/assets/x.js
visit "http://localhost/api/apercu/JETON-SECRET.signature/index.html"
visit "http://localhost/api/status"
sleep 1
LOG=$(docker exec "$TAG" cat /data/access.log)
case "$LOG" in
  *SECRET*) echo "ÉCHEC : un secret dans le journal d'accès"; echo "$LOG" | grep SECRET | cut -c1-400; exit 1 ;;
esac
case "$LOG" in
  */api/status*) ;;
  *) echo "ÉCHEC : le journal d'accès ne garde plus rien"; echo "$LOG" | cut -c1-400; exit 1 ;;
esac
case "$LOG" in
  *autre=gardee*) ;;
  *) echo "ÉCHEC : le filtre retire plus que le code d'installation"; echo "$LOG" | cut -c1-400; exit 1 ;;
esac
echo "OK : ni code d'installation (adresse, Referer) ni jeton d'aperçu dans le journal de Caddy ; le reste y est"
