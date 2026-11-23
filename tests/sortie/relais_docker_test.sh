#!/usr/bin/env sh
# Relais de l'app de bureau sur de vrais conteneurs (Docker requis, aucun compte) : le vrai serveur (route WebSocket, jeton d'appareil,
# mandataire interne), le vrai module du bureau (desktop/relais.js, dans un conteneur Node sans Electron) et le vrai aiguillage
# (image du lanceur, mêmes limites qu'en production). Un faux site dit quelle adresse l'a joint. On coupe l'« ordinateur » et on le
# rallume. Crée puis supprime des conteneurs, un volume et un réseau noahtest-relais-* ; ne touche à rien d'autre.
#   sh tests/sortie/relais_docker_test.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
HERE="$(pwd -W 2>/dev/null || pwd)"
P=noahtest-relais
NET=$P-net
VOL=$P-partage
cleanup() {
  docker rm -f $P-site $P-serveur $P-client $P-aig $P-aig2 >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  docker volume rm $VOL >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT
fail() {
  echo "ÉCHEC : $*"
  docker logs --tail 15 $P-aig 2>&1 | sed 's/^/    aiguillage : /'
  docker logs --tail 15 $P-serveur 2>&1 | sed 's/^/    serveur : /'
  docker logs --tail 15 $P-client 2>&1 | sed 's/^/    ordinateur : /'
  exit 1
}

docker network create $NET >/dev/null
docker volume create $VOL >/dev/null
docker build -q -t noahtest/sortie-lanceur launcher >/dev/null
PY=python:3.12-slim
NODE=node:22-alpine
for i in $PY $NODE; do docker image inspect $i >/dev/null 2>&1 || docker pull -q $i >/dev/null; done
T="-v $HERE/tests/sortie:/t:ro"

# Le faux site, sur le port 80 : le relais n'ouvre que 80 et 443.
docker run -d --name $P-site --network $NET --network-alias site.essai.test -e PORT=80 $T $PY python /t/site_faux.py >/dev/null
# Le serveur : le vrai module, dans une petite application.
docker run -d --name $P-serveur --network $NET -e PYTHONDONTWRITEBYTECODE=1 -v "$HERE/server:/app:ro" -v $VOL:/shared $T $PY \
  sh -c "pip install -q -r /app/requirements.txt && python /t/relais_docker_serveur.py" >/dev/null
for _ in $(seq 120); do docker exec $P-serveur test -f /shared/pret 2>/dev/null && break; sleep 1; done
docker exec $P-serveur test -f /shared/pret || fail "le serveur ne démarre pas"

ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"; }
AMONT="[{\"nom\":\"maison\",\"hote\":\"$P-serveur\",\"port\":3130}]"
# L'aiguillage comme le lanceur le crée (launcher.py, _make_aiguillage), plus les réglages de banc : sondes à la seconde, retour après 6 s.
aiguillage() {  # nom, variables d'environnement en plus
  name=$1; shift
  docker run -d --name "$name" --network $NET --user 65534:65534 --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 256 -e NOAH_SORTIE_AMONT="$AMONT" -e NOAH_SORTIE_SITE=site.essai.test \
    -e NOAH_SORTIE_SITE_PORT=80 -e NOAH_SORTIE_SITE_INFO=info.essai.test -e NOAH_SORTIE_SONDE=1 -e NOAH_SORTIE_INACTIVITE=6 "$@" \
    noahtest/sortie-lanceur python /app/aiguillage.py >/dev/null
}
# Le faux site est sur un réseau privé : l'aiguillage de banc l'accepte (NOAH_SORTIE_PRIVE_OK) ; l'app, elle, applique ses vraies règles.
aiguillage $P-aig -e NOAH_SORTIE_PRIVE_OK=1
for _ in $(seq 40); do docker exec $P-aig python /app/aiguillage.py --etat >/dev/null 2>&1 && break; sleep 1; done
etat() { docker exec $P-aig python /app/aiguillage.py --etat; }
etat >/dev/null || fail "l'aiguillage ne répond pas"
AIG=$(ip $P-aig)
vu() { docker run --rm --network $NET $T $PY python /t/client_essai.py $P-aig site.essai.test 80; }
attend() {  # sortie attendue : maison ou direct
  want=$1
  for _ in $(seq 25); do etat | grep -q "\"active\": \"$want\"" && return 0; sleep 1; done
  fail "l'aiguillage n'est pas passé sur « $want » : $(etat | cut -c1-300)"
}
doit() {  # ce que le faux site doit voir, et pourquoi
  got=$(vu)
  [ "$got" = "ip=$1" ] || fail "$2 : le site a vu « $got », attendu ip=$1"
}
demarre_client() {
  docker run -d --name $P-client --network $NET -v "$HERE:/repo:ro" -v $VOL:/shared:ro -e SERVEUR=http://$P-serveur:8080 \
    -e SITE_REEL=$P-site $NODE node /repo/tests/sortie/relais_client_faux.mjs >/dev/null
}

# 1. Aucun ordinateur relié : le mandataire répond « 503 », l'aiguillage sort en direct, le navigateur ne voit aucune erreur.
doit $AIG "aucun ordinateur relié : sortie directe, sans erreur"
echo "1. aucun ordinateur relié : sortie directe ($AIG), sans erreur"

# 2. L'ordinateur se relie : le navigateur sort par lui (le faux site voit l'adresse de l'ordinateur, pas celle de l'aiguillage).
demarre_client
attend maison
CLIENT=$(ip $P-client)
doit $CLIENT "l'ordinateur est relié : la connexion sort par lui"
doit $CLIENT "l'ordinateur est relié : encore"
echo "2. l'ordinateur relié : une requête du navigateur sort par lui ($CLIENT)"

# 3. Les destinations privées sont refusées par l'app, après résolution : un nom qui résout vers le réseau privé, une adresse du
# réseau local, un port qui n'est ni 80 ni 443.
refus() { got=$(docker run --rm --network $NET $T $PY python /t/client_essai.py $P-aig "$1" "$2"); case "$got" in "refus 40"?|"refus 502") ;; *) fail "$1:$2 devait être refusé, obtenu « $got »" ;; esac; }
refus interne.essai.test 80
refus 192.168.1.10 80
refus 169.254.169.254 80
refus 100.101.102.103 443
refus localhost 80
refus site.essai.test 25
docker logs $P-client 2>&1 | grep -q "refus interne.essai.test:80 (résolu vers une adresse privée)" || fail "le refus n'est pas dans le journal de l'app"
doit $CLIENT "après les refus, le relais marche encore"
echo "3. adresses privées (après résolution), réseau local, CGNAT, localhost et port 25 : refusés par l'app, le relais continue"

# 4. L'ordinateur s'éteint : la connexion suivante sort directement, sans erreur.
docker stop -t 1 $P-client >/dev/null
doit $AIG "ordinateur coupé : sortie directe, sans erreur"
attend direct
echo "4. ordinateur coupé : sortie directe ($AIG), le navigateur ne voit aucune erreur"

# 5. L'ordinateur revient : tant que la session bouge, l'adresse ne change pas ; après le délai sans connexion, retour au relais.
docker start $P-client >/dev/null
for _ in $(seq 20); do etat | grep -A1 '"nom": "maison"' | grep -q '"prete"' && break; sleep 1; done
doit $AIG "l'ordinateur est revenu mais une connexion vient d'avoir lieu : pas de changement d'adresse en pleine session"
sleep 9
attend maison
CLIENT=$(ip $P-client)
doit $CLIENT "après le délai sans connexion : retour par l'ordinateur"
echo "5. ordinateur revenu : l'adresse ne change pas en pleine session, retour par lui après 6 s sans connexion"

# 6. Le jeton de l'appareil n'est ni dans le journal du serveur, ni dans celui de l'app, ni dans celui de l'aiguillage.
JETON=$(docker run --rm -v $VOL:/shared:ro $PY cat /shared/token)
[ -n "$JETON" ] || fail "jeton introuvable"
for c in $P-serveur $P-client $P-aig; do
  docker logs $c 2>&1 | grep -q "$JETON" && fail "le jeton de l'appareil est dans le journal de $c"
done
echo "6. le jeton de l'appareil n'apparaît dans aucun journal"

# 7. Sans réglage de banc, l'aiguillage de production refuse lui-même une destination privée, avant d'atteindre le relais.
aiguillage $P-aig2
for _ in $(seq 40); do docker exec $P-aig2 python /app/aiguillage.py --etat >/dev/null 2>&1 && break; sleep 1; done
got=$(docker run --rm --network $NET $T $PY python /t/client_essai.py $P-aig2 192.168.1.10 80)
[ "$got" = "refus 403" ] || fail "l'aiguillage de production devait refuser 192.168.1.10 (403), obtenu « $got »"
echo "7. l'aiguillage de production refuse le réseau local avant le relais"
echo "OK : relais de l'app de bureau sur de vrais conteneurs"
