#!/bin/sh
# G4.4 sur vrais conteneurs : le code du serveur envoie à un vrai ntfy (tiers) en HTTPS, on capture ce que ce tiers voit
# (journal trace avec en-têtes et corps, sa base, ce qu'il redistribue) et l'appareil déchiffre ce qu'il reçoit.
#
#   sh tests/push/ntfy_test.sh [dossier où garder la capture]
#
# NOAH_TEST_IMAGE : image avec Python, python:3.12-slim par défaut. Pas de clé, pas de téléphone.
set -eu
export MSYS_NO_PATHCONV=1
ROOT=$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))
IMAGE=${NOAH_TEST_IMAGE:-python:3.12-slim}
NTFY_IMAGE=binwiederhier/ntfy:v2.11.0
ID=noah-g44-$$
HOST_DIR=$(mktemp -d)
KEEP=${1:-}

clean() {
  docker rm -f "$ID-ntfy" "$ID-serveur" >/dev/null 2>&1 || true
  docker volume rm "$ID" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
  rm -rf "$HOST_DIR"
}
trap clean EXIT

docker network create "$ID" >/dev/null
docker volume create "$ID" >/dev/null
docker run -d --name "$ID-serveur" --network "$ID" --entrypoint sleep -v "$ROOT/server:/app:ro" -v "$ROOT/tests:/tests:ro" \
  -v "$ID:/certs" "$IMAGE" 900 >/dev/null
docker exec "$ID-serveur" sh -c "mkdir -p /capture && pip install -q --root-user-action=ignore --disable-pip-version-check -r /app/requirements.txt http_ece==1.2.1"
docker exec "$ID-serveur" python /tests/push/ntfy_capture.py cert

docker run -d --name "$ID-ntfy" --network "$ID" --network-alias ntfy.test -e NTFY_LOG_LEVEL=trace -v "$ID:/certs:ro" "$NTFY_IMAGE" serve \
  --base-url https://ntfy.test --listen-http - --listen-https :443 \
  --key-file /certs/key.pem --cert-file /certs/cert.pem --cache-file /tmp/cache.db >/dev/null

if ! docker exec "$ID-serveur" python /tests/push/ntfy_capture.py send; then
  docker logs --tail 30 "$ID-ntfy" 2>&1
  exit 1
fi

docker logs "$ID-ntfy" >"$HOST_DIR/ntfy.log" 2>&1
docker exec "$ID-ntfy" sh -c 'cat /tmp/cache.db*' >"$HOST_DIR/cache.db"  # base et journal WAL : tout ce qu'elle garde
docker exec -i "$ID-serveur" sh -c 'cat >/capture/ntfy.log' <"$HOST_DIR/ntfy.log"
docker exec -i "$ID-serveur" sh -c 'cat >/capture/cache.db' <"$HOST_DIR/cache.db"
docker exec "$ID-serveur" python /tests/push/ntfy_capture.py scan
if [ -n "$KEEP" ]; then
  mkdir -p "$KEEP"
  cp "$HOST_DIR/ntfy.log" "$HOST_DIR/cache.db" "$KEEP/"
  docker exec "$ID-serveur" cat /capture/distribue.jsonl >"$KEEP/distribue.jsonl"
fi
echo "ntfy : tout est vert"
