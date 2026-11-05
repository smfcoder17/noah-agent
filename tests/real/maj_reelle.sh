#!/bin/sh
# Essai réel du parcours J4 : version majeure installée seule à une heure calme, sans perte ; panne provoquée : retour
# arrière. Sur une vraie installation faite avec get.sh, avec les vraies images et le vrai manifeste signé. À lancer
# après la première publication, sur un VPS d'essai ou avec l'accord de la personne : les pannes coupent Noah quelques
# minutes.
#
# Se lance depuis ton ordinateur : la clé du manifeste ne quitte jamais cette machine, seul le manifeste signé part.
#
#   export NOAH_VPS=root@1.2.3.4        (sans NOAH_VPS : le Docker de cette machine)
#   sh tests/real/maj_reelle.sh etat                 lecture seule : versions, créneau, ce qu'attend la mise à jour
#   sh tests/real/maj_reelle.sh avant                pose des témoins et note les données (à faire AVANT la version majeure)
#     ... publier la version majeure (v1.0.0 si 0.x est installée) ...
#   sh tests/real/maj_reelle.sh seule 1.0.0          vérifie qu'elle s'est installée seule, dans le créneau, sans perte
#                                                    code 2 : pas encore (la raison est affichée) ; à relancer
#   NOAH_ESSAI_OUI=1 NOAH_RELEASE_KEY_FICHIER=~/.noah-signatures/release.key sh tests/real/maj_reelle.sh panne MODE
#       serveur    le nouveau serveur ne démarre pas : retour arrière au contrôle de santé
#       tardive    il démarre, écrit dans ses données, tombe pendant les 5 minutes d'observation : retour arrière, et ce
#                  qu'il a écrit a disparu
#       coupure    le lanceur est tué en pleine transaction : au redémarrage, tout revient
#   sh tests/real/maj_reelle.sh nettoyer             retire les témoins
#
# Une version majeure attend 7 jours après son annonce. NOAH_ESSAI_RACCOURCIR=1 sur « seule » ramène l'annonce à 7 jours
# en arrière : le reste du parcours est réel, mais le délai n'est alors pas prouvé, et le verdict le dit.
#
# Ce que ça laisse : une entrée « bloquée » et l'historique du lanceur, sur un numéro de version (correctif + 1000) qui ne
# gêne aucune vraie version. Variables : NOAH_ESSAI_DOSSIER (notes, défaut ~/.noah-essai-maj), NOAH_ESSAI_PORT (registre
# d'essai, défaut 5055), NOAH_ESSAI_MANIFESTE (adresse du manifeste vue du serveur, pour une répétition hors GitHub).
set -eu
export MSYS_NO_PATHCONV=1  # Git Bash : /data/... reste un chemin du conteneur

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NOTES=${NOAH_ESSAI_DOSSIER:-${HOME:-.}/.noah-essai-maj}
REGISTRE=noah-essai-registre
PORT=${NOAH_ESSAI_PORT:-5055}
MANIFEST_URL=${NOAH_ESSAI_MANIFESTE:-https://github.com/smfcoder17/noah-agent/releases/latest/download/manifest.json}
LOCAL_DOCKER_HOST=${DOCKER_HOST:-}
if [ -n "${NOAH_VPS:-}" ]; then
  export DOCKER_HOST="ssh://$NOAH_VPS"
fi

ECHECS=0
say() { printf '\n== %s\n' "$*"; }
ok() { printf 'OK     %s\n' "$*"; }
ko() { printf 'ECHEC  %s\n' "$*"; ECHECS=$((ECHECS + 1)); }
die() { printf 'ECHEC : %s\n' "$*" >&2; exit 1; }

# Tout passe par le lanceur : pendant une mise à jour, c'est lui qui reste, le serveur peut être arrêté.
lanceur_py() { docker exec -i noah-launcher python - "$@"; }

# Prélude Python : appels au lanceur avec sa clé, depuis son propre conteneur.
PRELUDE='
import base64, json, os, sys, time, urllib.request, urllib.error
def _key():
    if os.environ.get("LAUNCHER_KEY"):
        return os.environ["LAUNCHER_KEY"]
    return json.load(open(os.environ.get("NOAH_SECRETS_FILE", "/secrets/noah.json")))["LAUNCHER_KEY"]
def lanceur(path, body=None):
    req = urllib.request.Request("http://127.0.0.1:9000" + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + _key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)
'

status() {
  { printf '%s\n' "$PRELUDE"; cat <<'EOF'
print(json.dumps(lanceur("/update/status")))
EOF
  } | lanceur_py
}

# Phase de la transaction ouverte, vide s'il n'y en a pas : le journal se lit même si le serveur est arrêté.
tx_phase() {
  { printf '%s\n' "$PRELUDE"; cat <<'EOF'
path = os.environ.get("NOAH_UPDATE_STATE", "/state/updates.json")
tx = (json.load(open(path)) if os.path.exists(path) else {}).get("en_cours") or {}
print(tx.get("phase", ""))
EOF
  } | lanceur_py
}

# Ce qu'il y a dans les données, lu sans rien écrire : lignes de chaque table du serveur.
data_counts() {
  docker exec -i noah-server python - <<'EOF'
import json, sqlite3
db = sqlite3.connect("file:/data/noah.db?mode=ro", uri=True)
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
print(json.dumps({t: db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}, sort_keys=True))
EOF
}

agents() { docker ps --filter label=noah.agent --format '{{.Names}}'; }

public_address() {
  docker exec -i noah-server python - <<'EOF'
import json, urllib.request
print(json.load(urllib.request.urlopen("http://127.0.0.1:8080/api/public", timeout=10)).get("adresse") or "")
EOF
}

# Le service, comme un utilisateur : API, puis HTTPS de bout en bout quand l'adresse est publique.
check_service() {
  if docker exec -i noah-server python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/status', timeout=10)" >/dev/null 2>&1; then
    ok "le serveur répond"
  else
    ko "le serveur ne répond pas"
    return
  fi
  address=$(public_address 2>/dev/null || true)
  case "$address" in
    https://*)
      if curl -fsS --max-time 20 -o /dev/null "$address/api/status"; then ok "HTTPS répond : $address"; else ko "HTTPS ne répond pas : $address"; fi
      ;;
    *) echo "       (pas d'adresse HTTPS publique à essayer)" ;;
  esac
}

leftovers() {
  left=$(docker ps -a --format '{{.Names}}' | grep -E '^noah-.*-(ancien|neuf)$|^noah-launcher-relais$' || true)
  running=$(docker ps --format '{{.Names}}' | grep -E '^noah-launcher-relais$' || true)
  old=$(printf '%s\n' "$left" | grep -E -- '-(ancien|neuf)$' || true)
  if [ -z "$old" ] && [ -z "$running" ]; then ok "aucun conteneur -ancien ou -neuf, relais arrêté"; else ko "restes de la transaction : $old $running"; fi
}

check_witnesses() {
  [ -f "$NOTES/temoin" ] || die "pas de témoins : lance d'abord « avant »"
  stamp=$(cat "$NOTES/temoin")
  if [ "$(docker exec noah-server cat /data/temoin-maj 2>/dev/null || true)" = "$stamp" ]; then ok "témoin du serveur intact"; else ko "témoin du serveur perdu"; fi
  for agent in $(agents); do
    if [ "$(docker exec "$agent" cat /opt/data/temoin-maj 2>/dev/null || true)" = "$stamp" ]; then
      ok "témoin de $agent intact"
    elif grep -qx "$agent" "$NOTES/agents" 2>/dev/null; then
      ko "témoin de $agent perdu"
    else
      echo "       $agent : créé après « avant »"
    fi
  done
  while read -r agent; do
    [ -n "$agent" ] || continue
    agents | grep -qx "$agent" || ko "$agent tournait avant, il ne tourne plus"
  done <"$NOTES/agents"
}

# Rien de perdu : chaque table a au moins ses lignes d'avant.
check_counts() {
  after=$(data_counts) || { ko "base illisible"; return; }
  verdict=$(printf '%s\n%s\n' "$(cat "$NOTES/lignes")" "$after" | docker exec -i noah-server python -c "
import json, sys
before, after = (json.loads(l) for l in sys.stdin.read().splitlines())
lost = {t: (n, after.get(t, 0)) for t, n in before.items() if after.get(t, 0) < n}
print('perdu ' + json.dumps(lost) if lost else f'ok {sum(before.values())} lignes avant, {sum(after.values())} après')
")
  case "$verdict" in
    ok*) ok "base : ${verdict#ok }" ;;
    *) ko "base : $verdict" ;;
  esac
}

finish() {
  say "Verdict"
  if [ "$ECHECS" = 0 ]; then
    echo "Tout est bon : $1"
    exit 0
  fi
  echo "$ECHECS échec(s) : $1"
  docker logs --tail 40 noah-launcher 2>&1 | grep '\[mise à jour\]' || true
  exit 1
}

# --- etat -----------------------------------------------------------------------------------------------------------
do_etat() {
  docker exec -i noah-server python - <<'EOF'
import json, time
from datetime import datetime
from noah import updates
s = updates._load()
now = time.time()
print("Version installée :", updates.VERSION)
print("Clé de signature dans l'image :", "oui" if updates.PUBLIC_KEY else "NON : aucune mise à jour automatique")
print("Fuseau :", updates._zone(s), "; heure locale :", datetime.fromtimestamp(now, updates._zone(s)).strftime("%H:%M"))
print("Créneau calme : à partir de", updates.quiet_hour(s), "h, pendant", updates.WINDOW_HOURS, "h")
print("Automatique :", s.get("auto", True), "; dernière lecture du manifeste :", s.get("verifie"), "; erreur :", s.get("erreur"))
d = s.get("disponible")
if d:
    print("Disponible :", d["version"], "; majeure :", bool(s.get("majeure")), "; annoncée :", s.get("annoncee"))
    print("Attend :", updates.due(s, now) or "rien : elle part au prochain tour, sauf routine proche")
else:
    print("Rien de disponible")
for r in s.get("reports", [])[-5:]:
    print("Report :", time.strftime("%Y-%m-%d %H:%M", time.gmtime(r["quand"])), "UTC :", r["texte"])
EOF
  { printf '%s\n' "$PRELUDE"; cat <<'EOF'
st = lanceur("/update/status")
etat = st["etat"]
print("Journal du lanceur : en cours :", (etat.get("en_cours") or {}).get("phase"), "; dernier rapport :", json.dumps(etat.get("dernier_rapport"), ensure_ascii=False))
for comp, items in st["actuel"].items():
    for i in items:
        print(" ", comp, i["nom"], (i["digests"] or [i["image_id"]])[0])
for h in etat.get("historique", [])[-8:]:
    print(" ", time.strftime("%Y-%m-%d %H:%M", time.gmtime(h["quand"])), "UTC", h["texte"])
EOF
  } | lanceur_py
}

# --- avant ----------------------------------------------------------------------------------------------------------
do_avant() {
  mkdir -p "$NOTES"
  stamp="temoin-$(date +%s)"
  docker exec noah-server sh -c "printf %s '$stamp' > /data/temoin-maj"
  : >"$NOTES/agents"
  for agent in $(agents); do
    docker exec "$agent" sh -c "printf %s '$stamp' > /opt/data/temoin-maj"
    echo "$agent" >>"$NOTES/agents"
  done
  printf %s "$stamp" >"$NOTES/temoin"
  data_counts >"$NOTES/lignes"
  status >"$NOTES/avant.json"
  ok "témoins posés (serveur et $(wc -l <"$NOTES/agents" | tr -d ' ') agent(s)), données notées dans $NOTES"
  [ -s "$NOTES/agents" ] || echo "       Aucun agent : crée-en un d'abord, sinon l'essai ne couvre pas leur remplacement."
}

# --- seule ----------------------------------------------------------------------------------------------------------
do_seule() {
  expected=${1:-}
  [ -n "$expected" ] || die "dis quelle version est attendue : seule 1.0.0"
  [ -f "$NOTES/temoin" ] || die "pas de témoins : « avant » devait être lancé avant cette version"

  if [ "${NOAH_ESSAI_RACCOURCIR:-}" = 1 ]; then
    docker exec -i noah-server python - <<'EOF'
import time
from noah import updates
updates._patch(lambda s: s.update(annoncee=int(time.time()) - updates.MAJOR_WAIT - 1) if s.get("majeure") else None)
print("Délai de 7 jours raccourci : il n'est pas prouvé par cet essai.")
EOF
    mkdir -p "$NOTES"
    : >"$NOTES/raccourci"
  fi

  say "La version attendue tourne-t-elle ?"
  answer=$(docker exec -i noah-server python - "$expected" <<'EOF'
import sys, time
from noah import updates
expected = sys.argv[1]
if updates.VERSION == expected:
    print("installee")
else:
    s = updates._load()
    d = s.get("disponible") or {}
    if d.get("version") != expected:
        print(f"pas encore annoncée (installée : {updates.VERSION}, disponible : {d.get('version')}, dernière lecture : {s.get('verifie')}, erreur : {s.get('erreur')})")
    else:
        print(f"annoncée, majeure : {bool(s.get('majeure'))}, annoncée le {time.strftime('%Y-%m-%d %H:%M', time.gmtime(s.get('annoncee', 0)))} UTC ; attend : {updates.due(s, time.time()) or 'rien, prochain tour'}")
EOF
  )
  if [ "$answer" != installee ]; then
    echo "Pas encore : $answer"
    exit 2
  fi
  ok "le serveur annonce $expected"

  say "Le vrai manifeste, sa vraie signature, les images qui tournent"
  docker exec -i noah-server python - "$MANIFEST_URL" "$expected" <<'EOF' >/dev/null || ko "le manifeste en ligne n'est pas celui de $expected, ou sa signature est refusée"
import asyncio, sys
import httpx
from noah import updates
url, expected = sys.argv[1], sys.argv[2]
async def main():
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
        raw = (await c.get(url)).raise_for_status().content
        sig = (await c.get(url + ".sig")).raise_for_status().text
    manifest = updates.verify(raw, sig)
    assert manifest["version"] == expected, manifest["version"]
    status = await updates._launcher("GET", "/update/status")
    todo = updates.pending(manifest, status["actuel"], status["etat"].get("images"))
    assert not todo, todo
asyncio.run(main())
EOF
  [ "$ECHECS" != 0 ] || ok "manifeste de releases/latest vérifié avec la clé de l'image ; chaque conteneur tourne sur son empreinte"

  say "Installée seule, à l'heure calme"
  docker exec -i noah-server python - "$expected" <<'EOF' || ko "pas d'installation seule dans le créneau (voir ci-dessus)"
import json, sys, time
from datetime import datetime
from noah import updates
expected = sys.argv[1]
s = updates._load()
installed = s.get("installee") or {}
if installed.get("version") != expected:
    sys.exit(f"journal du serveur : {installed}")
zone = updates._zone(s)
started = datetime.fromtimestamp(installed["depuis"], zone)
quiet = updates.quiet_hour(s)
print(f"Commencée le {started:%Y-%m-%d %H:%M} ({zone}) ; créneau : {quiet} h, {updates.WINDOW_HOURS} h")
if (started.hour - quiet) % 24 >= updates.WINDOW_HOURS:
    sys.exit("commencée hors du créneau : c'est un clic, ou un défaut")
if s.get("majeure") is False:
    print("Attention : cette version n'était pas annoncée comme majeure")
waited = installed["depuis"] - s.get("annoncee", installed["depuis"])
print(f"Attente depuis l'annonce : {waited / 86400:.1f} jours")
if waited < updates.MAJOR_WAIT and s.get("majeure"):
    sys.exit("majeure installée avant les 7 jours")
EOF
  [ "$ECHECS" != 0 ] || ok "commencée dans le créneau calme, après le délai"
  clicks=$(docker exec noah-caddy sh -c "grep -c '/api/updates/install' /data/access.log || true" 2>/dev/null || true)
  case "$clicks" in
    0) ok "aucun clic « Installer maintenant » dans le journal de Caddy" ;;
    "") echo "       (journal de Caddy illisible : l'absence de clic n'est pas vérifiée)" ;;
    *) ko "$clicks appel(s) à /api/updates/install dans le journal de Caddy : ce n'est peut-être pas « seule »" ;;
  esac
  { printf '%s\n' "$PRELUDE"; cat <<'EOF'
report = lanceur("/update/status")["etat"].get("dernier_rapport") or {}
print("Rapport du lanceur :", json.dumps(report, ensure_ascii=False))
sys.exit(0 if report.get("ok") else 1)
EOF
  } | lanceur_py || ko "le dernier rapport du lanceur n'est pas un succès"

  say "Sans perte"
  check_witnesses
  check_counts
  check_service
  leftovers
  if [ -f "$NOTES/raccourci" ]; then
    finish "$expected installée seule, délai de 7 jours RACCOURCI (non prouvé)"
  fi
  finish "$expected installée seule, sans perte"
}

# --- panne ----------------------------------------------------------------------------------------------------------
remove_registry() {
  docker rm -f "$REGISTRE" >/dev/null 2>&1 || true
}

# Signe ici, avec le Docker de cette machine ou son Python : la clé ne va pas sur le VPS.
sign_here() {
  version=$1
  ref=$2
  work=$3
  key=$(cat "$NOAH_RELEASE_KEY_FICHIER")
  printf 'Essai de panne, sans effet sur une vraie version.\n' >"$work/notes.md"
  for py in python3 python; do
    if "$py" -c 'import cryptography' >/dev/null 2>&1; then
      (cd "$work" && NOAH_RELEASE_KEY=$key "$py" "$ROOT/scripts/release-manifest.py" signer "$version" notes.md "noah-server=$ref" >/dev/null)
      return
    fi
  done
  native=$work
  if command -v cygpath >/dev/null 2>&1; then native=$(cygpath -m "$work"); fi
  # shellcheck disable=SC2016
  NOAH_RELEASE_KEY=$key DOCKER_HOST=$LOCAL_DOCKER_HOST MSYS_NO_PATHCONV=1 docker run --rm -i -e NOAH_RELEASE_KEY -v "$native:/w" -w /w python:3.12-slim \
    sh -c 'pip install -q cryptography==44.0.0 >/dev/null 2>&1 && python - signer "$0" notes.md "noah-server=$1"' "$version" "$ref" \
    <"$ROOT/scripts/release-manifest.py" >/dev/null
}

do_panne() {
  mode=${1:-}
  case "$mode" in
    serveur|tardive|coupure) ;;
    *) die "panne serveur|tardive|coupure" ;;
  esac
  [ "${NOAH_ESSAI_OUI:-}" = 1 ] || die "Cette panne coupe Noah quelques minutes sur $(docker info --format '{{.Name}}'). Pour la lancer : NOAH_ESSAI_OUI=1"
  [ -n "${NOAH_RELEASE_KEY_FICHIER:-}" ] && [ -f "${NOAH_RELEASE_KEY_FICHIER:-}" ] || die "NOAH_RELEASE_KEY_FICHIER : le fichier release.key de preparer-signatures.sh"
  [ -f "$NOTES/temoin" ] || do_avant
  phase=$(tx_phase)
  [ -z "$phase" ] || die "une mise à jour est déjà en cours (phase : $phase)"

  before=$(docker inspect noah-server --format '{{.Image}}')
  version=$(docker exec noah-server sh -c 'echo "$NOAH_VERSION"')
  echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "version installée « $version » : cet essai demande une version publiée"
  major=${version%%.*}; rest=${version#*.}; minor=${rest%%.*}; patch=${rest#*.}
  # Un numéro qu'aucune vraie version ne prendra : un échec ne laisse rien de bloqué sur la suivante.
  target="$major.$minor.$((patch + 1000))"
  data_counts >"$NOTES/lignes"

  say "Image cassée, construite sur le VPS depuis l'image qui tourne (mode $mode)"
  # Un vrai registre, sur 127.0.0.1 : le lanceur tire l'image par empreinte, comme une vraie version.
  remove_registry
  trap remove_registry EXIT
  docker run -d --name "$REGISTRE" -p "127.0.0.1:$PORT:5000" registry:2 >/dev/null
  tag="localhost:$PORT/noah-panne:$mode"
  docker tag "$before" noah-panne-base:essai
  # Le serveur cassé écrit toujours, pour prouver ensuite que le retour arrière efface.
  case "$mode" in
    serveur)
      printf 'FROM noah-panne-base:essai\nCMD ["sh", "-c", "touch /data/ecrit-par-la-panne; exit 1"]\n' | docker build -q -t "$tag" - >/dev/null
      ;;
    *)
      printf 'FROM noah-panne-base:essai\nCMD ["sh", "-c", "touch /data/ecrit-par-la-panne; (sleep 150; kill 1) & exec uvicorn noah.main:app --host 0.0.0.0 --port 8080"]\n' \
        | docker build -q -t "$tag" - >/dev/null
      ;;
  esac
  for _ in 1 2 3 4 5; do
    docker push -q "$tag" >/dev/null 2>&1 && break
    sleep 2
  done
  ref=$(docker inspect "$tag" --format '{{index .RepoDigests 0}}')
  [ -n "$ref" ] || die "image cassée non poussée"
  ok "$ref"

  say "Manifeste $target signé ici, envoyé au lanceur"
  mkdir -p "$NOTES"
  work=$(mktemp -d "$NOTES/signature.XXXXXX")
  sign_here "$target" "$ref" "$work"
  started=$(date +%s)
  manifest64=$(base64 <"$work/manifest.json" | tr -d '\r\n')
  signature=$(tr -d '\r\n' <"$work/manifest.json.sig")
  rm -rf "$work"
  { printf '%s\n' "$PRELUDE"; cat <<'EOF'
print(json.dumps(lanceur("/update/apply", {"manifeste": sys.argv[1], "signature": sys.argv[2], "force": True})))
EOF
  } | lanceur_py "$manifest64" "$signature"

  if [ "$mode" = coupure ]; then
    say "On attend la phase d'observation, puis on tue le lanceur"
    for _ in $(seq 1 90); do
      [ "$(tx_phase 2>/dev/null || true)" = observation ] && break
      sleep 5
    done
    [ "$(tx_phase)" = observation ] || ko "la phase d'observation n'est pas arrivée"
    docker kill noah-launcher >/dev/null
    ok "lanceur tué pendant la transaction"
    sleep 5
    docker start noah-launcher >/dev/null
    ok "lanceur redémarré : il doit tout remettre seul"
  fi

  say "Retour arrière (20 minutes au plus)"
  done_ok=false
  for _ in $(seq 1 240); do
    phase=$(tx_phase 2>/dev/null || echo "?")
    printf '\r  phase : %-20s' "$phase"
    if [ -z "$phase" ]; then done_ok=true; break; fi
    if [ "$phase" = intervention ]; then break; fi
    sleep 5
  done
  printf '\n'
  elapsed=$(($(date +%s) - started))
  if [ "$done_ok" = true ]; then ok "journal fermé après $elapsed s"; else ko "journal encore ouvert après $elapsed s (phase : $phase)"; fi
  [ "$phase" != intervention ] || ko "retour arrière incomplet : à régler dans Réglages > Mises à jour"

  say "Tout est revenu"
  if [ "$(docker inspect noah-server --format '{{.Image}}')" = "$before" ]; then ok "le serveur tourne sur son image d'avant"; else ko "le serveur n'est pas sur son image d'avant"; fi
  for _ in $(seq 1 24); do
    docker exec noah-server python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/status', timeout=5)" >/dev/null 2>&1 && break
    sleep 5
  done
  if docker exec noah-server test -e /data/ecrit-par-la-panne 2>/dev/null; then
    ko "ce que la version cassée a écrit est encore là : les données d'avant ne sont pas revenues"
  else
    ok "ce que la version cassée a écrit a disparu : les données d'avant sont revenues"
  fi
  check_witnesses
  check_counts
  check_service
  leftovers
  { printf '%s\n' "$PRELUDE"; cat <<'EOF'
report = lanceur("/update/status")["etat"].get("dernier_rapport") or {}
print("Rapport du lanceur :", json.dumps(report, ensure_ascii=False))
sys.exit(1 if report.get("ok") else 0)
EOF
  } | lanceur_py || ko "le lanceur annonce un succès alors que la version devait échouer"

  echo
  echo "À regarder toi-même : la conversation et Réglages > Mises à jour doivent dire « Mise à jour annulée »."
  finish "panne « $mode » : retour arrière en $elapsed s, données d'avant"
}

# --- nettoyer -------------------------------------------------------------------------------------------------------
do_nettoyer() {
  remove_registry
  docker exec noah-server rm -f /data/temoin-maj /data/ecrit-par-la-panne || true
  for agent in $(agents); do
    docker exec "$agent" rm -f /opt/data/temoin-maj || true
  done
  docker images --format '{{.Repository}}:{{.Tag}}' | grep '/noah-panne:' | while read -r image; do docker rmi "$image" >/dev/null 2>&1 || true; done
  docker rmi noah-panne-base:essai >/dev/null 2>&1 || true
  rm -rf "$NOTES"
  ok "témoins, registre d'essai, images cassées et notes retirés"
}

case "${1:-}" in
  etat) do_etat ;;
  avant) do_avant ;;
  seule) shift; do_seule "${1:-}" ;;
  panne) shift; do_panne "${1:-}" ;;
  nettoyer) do_nettoyer ;;
  *) sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//'; exit 64 ;;
esac
