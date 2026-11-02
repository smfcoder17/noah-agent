#!/usr/bin/env sh
# Test d'intégration des mises à jour (Docker requis). Crée puis supprime : un registre local, trois versions d'une
# petite application qui écrit une base SQLite, trois versions du lanceur, un réseau et des volumes noahtest-*.
# Ne touche pas à Noah.
set -eu
cd "$(dirname "$0")/../.."
REG=localhost:5055
HERE="$(pwd -W 2>/dev/null || pwd)"
docker network create noahtest-net >/dev/null 2>&1 || true
docker run -d --rm --name noahtest-registry -p 5055:5000 registry:2 >/dev/null
trap 'docker rm -f noahtest-registry noahtest-launcher noahtest-launcher-ancien apollo-launcher-relais >/dev/null 2>&1; docker volume rm -f noahtest-backups noahtest-state noahtest-agent-a-data noahtest-agent-b-data >/dev/null 2>&1; docker network rm noahtest-net >/dev/null 2>&1; true' EXIT
for v in v1 v2 v1b; do
  docker build -q --build-arg APPV=$v -t $REG/noahtest/app:$v -f tests/updates/app.Dockerfile tests/updates >/dev/null
  docker push -q $REG/noahtest/app:$v >/dev/null
done
docker build -q -t noahtest/launcher launcher >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm --name noahtest-runner --network noahtest-net -e AGENT_NETWORK=x -e REGISTRY=$REG \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$HERE/launcher:/l" -v "$HERE/tests:/tests" \
  noahtest/launcher python /tests/updates/docker_test.py

# Le lanceur remplacé par son relais : trois versions du lanceur (a, b saine, « casse » qui ne démarre pas).
docker tag noahtest/launcher $REG/noahtest/launcher:a
printf 'FROM noahtest/launcher\nENV NOAH_TEST_VERSION=b\n' | docker build -q -t $REG/noahtest/launcher:b - >/dev/null
printf 'FROM noahtest/launcher\nCMD ["sh", "-c", "exit 1"]\n' | docker build -q -t $REG/noahtest/launcher:casse - >/dev/null
for t in a b casse; do docker push -q $REG/noahtest/launcher:$t >/dev/null; done
KEY=$(MSYS_NO_PATHCONV=1 docker run --rm -v "$HERE/tests:/tests" noahtest/launcher python /tests/updates/key.py)
MSYS_NO_PATHCONV=1 docker run --rm --network noahtest-net -e AGENT_NETWORK=x -e REGISTRY=$REG -e TEST_PRIVATE_KEY="$KEY" \
  -e NOAH_UPDATE_STATE=/state/updates.json -e NOAH_LAUNCHER_NAME=noahtest-launcher -v noahtest-state:/state \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$HERE/launcher:/l" -v "$HERE/tests:/tests" \
  noahtest/launcher python /tests/updates/relay_test.py
