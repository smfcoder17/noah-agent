#!/usr/bin/env sh
# Sortie réseau sur de vrais conteneurs (Docker requis, aucun compte) : deux faux amonts jouent « maison » et « VPN », un faux site dit
# par quelle adresse il a été joint, et l'aiguillage tourne dans l'image du lanceur avec les mêmes limites qu'en production
# (utilisateur 65534, système de fichiers en lecture seule, aucune capacité). On coupe et on rallume les amonts.
# Crée puis supprime des conteneurs et un réseau noahtest-sortie-* ; ne touche à rien d'autre.
#   sh tests/sortie/docker_test.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
HERE="$(pwd -W 2>/dev/null || pwd)"
P=noahtest-sortie
NET=$P-net
cleanup() {
  docker rm -f $P-agent $P-site $P-maison $P-vpn $P-aig $P-aig2 >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT
fail() { echo "ÉCHEC : $*"; docker logs --tail 15 $P-aig 2>&1 | sed 's/^/    aiguillage : /'; exit 1; }

docker network create $NET >/dev/null
docker build -q -t noahtest/sortie-lanceur launcher >/dev/null
PY=python:3.12-slim
docker image inspect $PY >/dev/null 2>&1 || docker pull -q $PY >/dev/null
T="-v $HERE/tests/sortie:/t:ro"
docker run -d --name $P-site --network $NET --network-alias site.essai.test --network-alias direct.essai.test $T $PY python /t/site_faux.py >/dev/null
docker run -d --name $P-maison --network $NET $T $PY python /t/amont_faux.py >/dev/null
docker run -d --name $P-vpn --network $NET $T $PY python /t/amont_faux.py >/dev/null
ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"; }
MAISON=$(ip $P-maison); VPN=$(ip $P-vpn)
AMONT="[{\"nom\":\"maison\",\"hote\":\"$P-maison\",\"port\":3128},{\"nom\":\"vpn\",\"hote\":\"$P-vpn\",\"port\":3128}]"
# L'aiguillage comme le lanceur le crée (launcher.py, _make_aiguillage), plus les réglages de banc : sondes à la seconde, retour après 6 s.
aiguillage() {  # nom, variables d'environnement en plus
  name=$1; shift
  docker run -d --name "$name" --network $NET --user 65534:65534 --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 256 -e NOAH_SORTIE_AMONT="$AMONT" -e NOAH_SORTIE_SITE=site.essai.test \
    -e NOAH_SORTIE_SITE_PORT=8080 -e NOAH_SORTIE_SITE_INFO=info.essai.test -e NOAH_SORTIE_SONDE=1 -e NOAH_SORTIE_INACTIVITE=6 "$@" \
    noahtest/sortie-lanceur python /app/aiguillage.py >/dev/null
}
aiguillage $P-aig -e NOAH_SORTIE_PRIVE_OK=1
for _ in $(seq 40); do docker exec $P-aig python /app/aiguillage.py --etat >/dev/null 2>&1 && break; sleep 1; done
etat() { docker exec $P-aig python /app/aiguillage.py --etat; }
etat >/dev/null || fail "l'aiguillage ne répond pas"
AIG=$(ip $P-aig)
vu() { docker run --rm --network $NET $T $PY python /t/client_essai.py $P-aig site.essai.test 8080; }
attend() {  # sortie attendue : maison, vpn ou direct
  want=$1
  for _ in $(seq 20); do etat | grep -q "\"active\": \"$want\"" && return 0; sleep 1; done
  fail "l'aiguillage n'est pas passé sur « $want » : $(etat | cut -c1-300)"
}
doit() {  # ce que le faux site doit voir, et pourquoi
  got=$(vu)
  [ "$got" = "ip=$1" ] || fail "$2 : le site a vu « $got », attendu ip=$1"
}

doit $MAISON "toutes les sorties répondent : la maison"
doit $MAISON "la maison, encore"
echo "1. avec les deux sorties, tout passe par la maison ($MAISON)"

# Les outils d'un agent : un conteneur de l'image Hermes figée, avec les variables que le lanceur pose (aiguillage.env_proxy_agent). Un site
# vu par curl ou par Python (requests, httpx) passe par l'aiguillage ; un nom de la liste NO_PROXY (le serveur Noah, le navigateur de
# l'agent : ici direct.essai.test) reste direct. L'image pèse 4 Go : sans elle sur la machine, cette partie est sautée.
HERMES=$(sed -n 's/^IMAGE = os.environ.get("AGENT_IMAGE", "\(.*\)")$/\1/p' launcher/launcher.py)
if docker image inspect "$HERMES" >/dev/null 2>&1; then
  ENVS=$(docker run --rm noahtest/sortie-lanceur python -c "import sys; sys.path.insert(0, '/app'); import aiguillage; print('\n'.join(f'{k}={v}' for k, v in aiguillage.env_proxy_agent('$P-aig', 3128, ['direct.essai.test']).items()))")
  set --; for e in $ENVS; do set -- "$@" -e "$e"; done
  docker run -d --name $P-agent --network $NET --entrypoint sleep "$@" "$HERMES" 300 >/dev/null
  AGENT=$(ip $P-agent)
  PYA=/opt/hermes/.venv/bin/python
  agent_voit() {  # outil, URL ; ce que le faux site a vu
    case $1 in
      curl) docker exec $P-agent curl -fsS -m 20 "$2" ;;
      tunnel) docker exec $P-agent curl -fsS -m 20 -p "$2" ;;
      requests) docker exec $P-agent $PYA -c "import requests,sys; print(requests.get(sys.argv[1], timeout=20).text)" "$2" ;;
      httpx) docker exec $P-agent $PYA -c "import httpx,sys; print(httpx.get(sys.argv[1], timeout=20).text)" "$2" ;;
    esac
  }
  for outil in curl tunnel requests httpx; do
    got=$(agent_voit $outil http://site.essai.test:8080/ 2>&1) || true
    [ "$got" = "ip=$MAISON" ] || fail "outil $outil de l'agent : le site a vu « $got », attendu ip=$MAISON (la sortie maison)"
    got=$(agent_voit $outil http://direct.essai.test:8080/ 2>&1) || true
    [ "$got" = "ip=$AGENT" ] || fail "outil $outil de l'agent, nom dans NO_PROXY : le site a vu « $got », attendu ip=$AGENT (direct)"
  done
  echo "1b. les outils de l'agent (curl, tunnel CONNECT, requests, httpx) sortent par la maison ($MAISON) ; un nom de NO_PROXY reste direct ($AGENT)"
else
  echo "1b. sauté : l'image Hermes figée n'est pas sur cette machine"
fi

docker stop -t 1 $P-maison >/dev/null
doit $VPN "maison coupée : la connexion suivante passe tout de suite par le VPN, sans erreur"
doit $VPN "le VPN reste choisi"
attend vpn
echo "2. la maison coupée : bascule immédiate vers le VPN ($VPN), le navigateur ne voit aucune erreur"

docker stop -t 1 $P-vpn >/dev/null
doit $AIG "plus aucune sortie : repli direct (l'adresse du serveur)"
attend direct
echo "3. plus aucune sortie : repli direct ($AIG)"

docker start $P-maison >/dev/null
for _ in $(seq 20); do etat | grep -A1 '"nom": "maison"' | grep -q '"prete"' && break; sleep 1; done
doit $AIG "la maison répond de nouveau mais une connexion vient d'avoir lieu : on reste en direct, pas de changement d'adresse en pleine session"
echo "4. la maison revient : tant que la session bouge, l'adresse ne change pas"
sleep 9
attend maison
doit $MAISON "après le délai sans connexion : retour à la maison"
echo "5. après 6 s sans connexion : retour à la maison"

# Le VPN revient aussi : la maison est meilleure, rien ne bouge.
docker start $P-vpn >/dev/null
sleep 5
doit $MAISON "le VPN revient : la maison reste"
echo "6. le VPN revenu ne reprend pas la place de la maison"

# Isolement du conteneur de l'aiguillage.
[ "$(docker exec $P-aig id -u)" = "65534" ] || fail "l'aiguillage ne tourne pas en 65534"
docker exec $P-aig sh -c 'test ! -e /var/run/docker.sock' || fail "le socket Docker est visible dans l'aiguillage"
docker exec $P-aig sh -c 'touch /app/x 2>/dev/null' && fail "le système de fichiers de l'aiguillage n'est pas en lecture seule"
docker exec $P-aig sh -c 'grep -q "^CapEff:.0000000000000000$" /proc/1/status' || fail "l'aiguillage a des capacités"
docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.SecurityOpt}} {{.HostConfig.CapDrop}}' $P-aig | grep -q 'true \[no-new-privileges\] \[ALL\]' || fail "réglages d'isolement"
echo "7. l'aiguillage : utilisateur 65534, lecture seule, aucune capacité, ni socket Docker"

# Sans réglage de banc : une destination privée ou interne est refusée, un site public non (ici il n'y a pas d'Internet à joindre).
aiguillage $P-aig2
for _ in $(seq 40); do docker exec $P-aig2 python /app/aiguillage.py --etat >/dev/null 2>&1 && break; sleep 1; done
refus() { got=$(docker run --rm --network $NET $T $PY python /t/client_essai.py $P-aig2 "$1" "$2"); [ "$got" = "refus 403" ] || fail "$1:$2 devait être refusé (403), obtenu « $got »"; }
refus 192.168.1.10 445
refus 100.101.102.103 3389
refus 169.254.169.254 80
refus mon-pc.tailnet.ts.net 443
refus $P-maison 3128
refus site.essai.test 25
echo "8. l'aiguillage de production refuse le réseau local, le CGNAT, les noms internes et le courrier"
echo "OK : sortie réseau sur de vrais conteneurs"
