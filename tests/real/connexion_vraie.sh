#!/bin/sh
# Se connecter à un site, de bout en bout : vrai Hermes, vrai Firefox (extension du dépôt), vrai serveur, faux modèle, page factice,
# faux mot de passe. Puis on cherche ce mot de passe partout : il ne doit être que dans le site. Trop lourd pour la CI (images de 4 Go).
#     sh tests/real/connexion_vraie.sh
# Rien n'est partagé avec une installation en cours : réseau, volumes et conteneurs à part, effacés à la fin. Il faut les images en local.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && { pwd -W 2>/dev/null || pwd; })
NET=noah-essai-coffre
HERMES=${NOAH_ESSAI_HERMES:-nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d}
BROWSER=${NOAH_ESSAI_NAVIGATEUR:-ghcr.io/smfcoder17/noah-browser:stable}
SECRET=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
export MSYS_NO_PATHCONV=1
MDP="Faux-Mdp-Coffre-$(od -An -tx1 -N6 /dev/urandom | tr -d ' \n')"
ALL="noah-essai-site noah-essai-modele noah-server-essai noah-agent-essai noah-browser-essai"

cleanup() {
  docker rm -f $ALL >/dev/null 2>&1
  docker volume rm noah-essai-coffre-agent noah-essai-coffre-donnees >/dev/null 2>&1
  docker network rm $NET >/dev/null 2>&1
}
cleanup
[ "${GARDER:-}" = 1 ] || trap cleanup EXIT
docker network create $NET >/dev/null
docker volume create noah-essai-coffre-agent >/dev/null
docker volume create noah-essai-coffre-donnees >/dev/null

docker run -d --name noah-essai-site --network $NET --network-alias autre-site -v "$ROOT/tests/real:/t:ro" python:3.12-slim python /t/connexion_site.py >/dev/null
docker run -d --name noah-essai-modele --network $NET -v "$ROOT/tests/real:/t:ro" python:3.12-slim python /t/connexion_modele.py >/dev/null
docker run -d --name noah-server-essai --network $NET --network-alias noah-server -p 127.0.0.1:18765:8080 \
  -e NOAH_SECRET_KEY="$SECRET" -e ESSAI_MOT_DE_PASSE="$MDP" -e ESSAI_ATTENTE="${ESSAI_ATTENTE:-0}" -e NOAH_WEB_DIR=/web \
  -v noah-pip-cache:/root/.cache/pip -v noah-essai-coffre-agent:/agentdata -v noah-essai-coffre-donnees:/donnees \
  -v "$ROOT/server:/app" -v "$ROOT/tests:/tests:ro" -v "$ROOT/frontend/dist:/web:ro" python:3.12-slim sh -c \
  "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/connexion_serveur.py" >/dev/null

echo "Le serveur s'installe…"
for _ in $(seq 1 150); do
  docker logs noah-server-essai 2>&1 | grep -q "clés du navigateur" && break
  sleep 2
done
KEYS=$(docker logs noah-server-essai 2>&1 | grep "clés du navigateur" | tail -1)
API=$(echo "$KEYS" | awk '{print $(NF-1)}')
PRIVATE=$(echo "$KEYS" | awk '{print $NF}')
docker run -d --name noah-browser-essai --network $NET -e CAMOFOX_API_KEY="$API" -e CAMOFOX_ACCESS_KEY="$API" -e NOAH_PRIVATE_KEY="$PRIVATE" -e CAMOFOX_PORT=9377 -e CAMOFOX_BIND_HOST=0.0.0.0 \
  -e CAMOFOX_DISABLE_DEFAULT_ADDONS=1 -e ENABLE_VNC=0 -e TAB_INACTIVITY_MS=3600000 -e SESSION_TIMEOUT_MS=7200000 -e BROWSER_IDLE_TIMEOUT_MS=1800000 -e CAMOFOX_PROFILE_DIR=/data/profiles -e CAMOFOX_COOKIES_DIR=/data/cookies \
  -v "$ROOT/launcher/camofox-noah/index.js:/app/plugins/noah/index.js:ro" -v "$ROOT/launcher/camofox-noah/camofox.config.json:/app/camofox.config.json:ro" "$BROWSER" >/dev/null
for _ in $(seq 1 30); do
  docker run --rm -v noah-essai-coffre-agent:/d alpine test -f /d/.pret && break
  sleep 2
done
docker run -d --name noah-agent-essai --network $NET -e API_SERVER_ENABLED=true -e API_SERVER_HOST=0.0.0.0 -v noah-essai-coffre-agent:/opt/data "$HERMES" gateway run >/dev/null

docker logs -f noah-server-essai 2>&1 | grep --line-buffered -E "^(OK|ÉCHEC|TOUT|DES ÉCHECS|Jamais)" &
LOGS=$!
for _ in $(seq 1 240); do
  docker logs noah-server-essai 2>&1 | grep -qE "^(TOUT EST VERT|DES ÉCHECS|Jamais)" && break
  sleep 5
done
sleep 1
kill $LOGS 2>/dev/null

echo
echo "On cherche le faux mot de passe partout."
FAILED=0
absent() { # nom, nombre d'occurrences
  if [ "$2" = 0 ]; then echo "OK    absent : $1"; else echo "ÉCHEC trouvé $2 fois : $1"; FAILED=1; fi
}
count() { grep -c -F -- "$MDP" || true; }
present=$(docker exec noah-essai-site python -c "import urllib.request as u;print(u.urlopen('http://localhost:9999/_recu').read().decode())" | count)
[ "$present" -gt 0 ] && echo "OK    présent : le site l'a bien reçu" || { echo "ÉCHEC le site ne l'a jamais reçu : recherche sans valeur"; FAILED=1; }
for c in noah-agent-essai noah-browser-essai; do
  absent "journaux du conteneur $c" "$(docker logs $c 2>&1 | count)"
done
# Le serveur d'essai reçoit le mot de passe en variable pour jouer la personne : ce sont ses journaux qui comptent.
absent "journaux du serveur" "$(docker logs noah-server-essai 2>&1 | count)"
absent "fichiers de l'agent (session Hermes, state.db, journaux, coffre)" "$(docker exec noah-agent-essai sh -c "grep -r -l -a -F -- '$MDP' /opt/data 2>/dev/null | wc -l" | tr -d ' ')"
absent "la machine de l'agent, /tmp compris" "$(docker exec noah-agent-essai sh -c "grep -r -l -a -F -- '$MDP' /tmp /root /home 2>/dev/null | wc -l" | tr -d ' ')"
absent "fichiers de la base Noah" "$(docker exec noah-server-essai sh -c "grep -r -l -a -F -- '$MDP' /donnees 2>/dev/null | wc -l" | tr -d ' ')"
absent "fichiers du navigateur (profil, cookies, /tmp)" "$(docker exec noah-browser-essai sh -c "grep -r -l -a -F -- '$MDP' /data /tmp /root/.camofox 2>/dev/null | wc -l" | tr -d ' ')"
absent "ce que le modèle a reçu" "$(docker exec noah-essai-modele cat /tmp/recu_modele.jsonl | count)"
echo "Requêtes reçues par le modèle : $(docker exec noah-essai-modele sh -c 'wc -l < /tmp/recu_modele.jsonl')"
docker logs noah-server-essai 2>&1 | grep -q "^TOUT EST VERT" || FAILED=1
[ "$FAILED" = 0 ] && echo "Bout en bout : tout est vert" || echo "Bout en bout : ÉCHEC"
exit $FAILED
