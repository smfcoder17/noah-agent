#!/usr/bin/env sh
# Test d'intégration des mises à jour (Docker requis). Crée puis supprime : un registre local, quatre versions d'une
# petite application qui écrit une base SQLite, trois versions du lanceur, un réseau et des volumes noahtest-*.
# Ne touche pas à Noah (noms et relais réservés aux tests).
set -eu
cd "$(dirname "$0")/../.."
REG=localhost:5055
HERE="$(pwd -W 2>/dev/null || pwd)"
cleanup() {
  docker rm -f noahtest-registry noahtest-runner noahtest-runner-caddy noahtest-launcher noahtest-launcher-ancien noahtest-relais noahtest-caddy noahtest-server \
    noahtest-agent-a noahtest-agent-b noahtest-agent-a-ancien noahtest-agent-b-ancien noahtest-agent-a-neuf >/dev/null 2>&1 || true
  for owner in noahtest-runner noahtest-launcher; do
    docker ps -aq --filter label=noah.outil=$owner | xargs -r docker rm -f >/dev/null 2>&1 || true
  done
  docker volume rm -f noahtest-backups noahtest-tiny noahtest-state noahtest-state2 noahtest-state3 noahtest-agent-a-data \
    noahtest-agent-b-data >/dev/null 2>&1 || true
  docker network rm noahtest-net >/dev/null 2>&1 || true
}
# Noms et port fixes : deux passages en même temps se détruiraient l'un l'autre. Le second attend (30 min au plus, puis prend la main).
for _ in $(seq 180); do docker network create noahtest-verrou >/dev/null 2>&1 && break; sleep 10; done
cleanup
trap 'cleanup; docker network rm noahtest-verrou >/dev/null 2>&1 || true' EXIT
docker network create noahtest-net >/dev/null
docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=64k noahtest-tiny >/dev/null
docker run -d --rm --name noahtest-registry -p 5055:5000 registry:2 >/dev/null
pids=""
for v in v1 v2 v3 v4 v1b; do
  { docker build -q --build-arg APPV=$v -t $REG/noahtest/app:$v -f tests/updates/app.Dockerfile tests/updates >/dev/null &&
    docker push -q $REG/noahtest/app:$v >/dev/null; } &
  pids="$pids $!"
done
for p in $pids; do wait $p; done
docker build -q -t noahtest/launcher launcher >/dev/null
KEY=$(MSYS_NO_PATHCONV=1 docker run --rm -v "$HERE/tests:/tests" noahtest/launcher python /tests/updates/key.py)
run() {
  MSYS_NO_PATHCONV=1 docker run --rm --network noahtest-net -e PYTHONUNBUFFERED=1 -e AGENT_NETWORK=x -e REGISTRY=$REG -e TEST_PRIVATE_KEY="$KEY" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$HERE/launcher:/l" -v "$HERE/tests:/tests" "$@"
}
# Le lanceur remplacé par son relais : trois versions du lanceur (a, b saine, « casse » qui ne démarre pas).
docker tag noahtest/launcher $REG/noahtest/launcher:a
printf 'FROM noahtest/launcher\nENV NOAH_TEST_VERSION=b\n' | docker build -q -t $REG/noahtest/launcher:b - >/dev/null
printf 'FROM noahtest/launcher\nCMD ["sh", "-c", "exit 1"]\n' | docker build -q -t $REG/noahtest/launcher:casse - >/dev/null
pids=""
for t in a b casse; do docker push -q $REG/noahtest/launcher:$t >/dev/null & pids="$pids $!"; done
for p in $pids; do wait $p; done
docker image inspect caddy:2.10-alpine >/dev/null 2>&1 || docker pull -q caddy:2.10-alpine >/dev/null

# Trois bancs côte à côte : conteneurs, journal et volume d'état à eux, rien de commun que le réseau et le registre.
run --name noahtest-runner -e NOAH_LAUNCHER_NAME=noahtest-runner -v noahtest-state2:/state \
  noahtest/launcher python /tests/updates/docker_test.py &
transaction=$!
# Contrôle de bout en bout à travers un vrai Caddy.
run --name noahtest-runner-caddy -e NOAH_LAUNCHER_NAME=noahtest-runner-caddy -e TESTS_DIR="$HERE/tests" -v noahtest-state3:/state \
  noahtest/launcher python /tests/updates/caddy_test.py &
caddy=$!
run -e NOAH_LAUNCHER_NAME=noahtest-launcher -v noahtest-state:/state noahtest/launcher python /tests/updates/relay_test.py &
relay=$!
status=0
for p in $transaction $caddy $relay; do wait $p || status=1; done
exit $status
