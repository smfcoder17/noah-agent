#!/bin/sh
# Ce que release.yml ne peut pas essayer sans publier : les workflows se lisent et s'enchaînent, le manifeste signé est
# accepté par le vrai code du lanceur, le compose est épinglé, une version stable sans ses clés est refusée, et
# preparer-signatures.sh ne touche à rien sans qu'on le demande. Clés jetables, dossier temporaire, aucun réseau.
#
#   docker run --rm -v "$PWD:/repo:ro" eclipse-temurin:21-jdk-alpine \
#     sh -c "apk add -q --no-cache python3 py3-cryptography py3-yaml && sh /repo/tests/publication/publication_test.sh"
set -eu
REPO=${REPO:-/repo}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
fail() { echo "ECHEC : $1" >&2; exit 1; }
ok() { echo "OK    $1"; }
# La commande doit échouer, et dire ce qu'on attend.
refuse() {
  what=$1; expected=$2; shift 2
  if out=$("$@" 2>&1); then fail "$what : accepté alors qu'il devait être refusé"; fi
  echo "$out" | grep -q "$expected" || fail "$what : refusé sans dire « $expected » : $out"
  ok "$what : refusé"
}

# --- Les workflows : un YAML invalide coûte un run à 0 s, comme au commit 0cc07df ----------------------------------
python3 - "$REPO" <<'EOF'
import glob, sys, yaml
repo = sys.argv[1]
flows = {}
for path in glob.glob(f"{repo}/.github/workflows/*.yml") + [f"{repo}/deploy/docker-compose.yml", f"{repo}/deploy/docker-compose.traefik.yml"]:
    flows[path.rsplit("/", 1)[1]] = yaml.safe_load(open(path, encoding="utf-8"))
print("OK    YAML :", ", ".join(sorted(flows)))

release, apps = flows["release.yml"], flows["apps.yml"]
jobs = release["jobs"]
on = lambda f: f.get("on", f.get(True))  # YAML 1.1 lit « on » comme un booléen
assert "push" in on(release) and "push" not in on(apps), "une étiquette ne déclenche que release.yml : un seul Release, écrit à la fin"
assert set(jobs["publier"]["needs"]) >= {"image", "apps"}, "le Release attend les images et les applications"
assert jobs["image"]["needs"] == "controle" or "controle" in jobs["image"]["needs"], "rien ne se construit sans les clés"
assert "tests" not in jobs, "la suite se joue en local : la CI est payée à la minute"
assert jobs["apps"]["uses"].endswith("apps.yml")
everything = open(f"{repo}/.github/workflows/release.yml", encoding="utf-8").read() + open(f"{repo}/.github/workflows/apps.yml", encoding="utf-8").read()
assert "action-gh-release" not in everything, "plusieurs jobs qui écrivent le même Release : latest cassé pendant une heure"
meta = next(s for s in jobs["image"]["steps"] if s.get("id") == "meta")["with"]
assert "stable" not in meta["tags"], ":stable ne bouge qu'à la fin de publier"
steps = jobs["publier"]["steps"]
names = [s.get("name", "") for s in steps]
assert names.index("Release en brouillon") < names.index("Étiquette stable, seulement maintenant") < names.index("Release publié")
assert "--draft " in next(s for s in steps if s.get("name") == "Release en brouillon")["run"]
# Les noms de fichiers du Release sont des liens publics (latest/download/) : pas de changement discret.
files = next(s for s in steps if s.get("name") == "Applications jointes")["run"]
for f in ("docker-compose.yml", "manifest.json", "manifest.json.sig", "noah-agent-android.apk", "noah-agent-windows-setup.exe"):
    assert f in files, f
android = {s.get("name"): s for s in apps["jobs"]["android"]["steps"]}
assert "assembleRelease" in android["APK signé"]["run"] and android["APK signé"]["if"]
assert "apk_scan.sh" in android["Pas d'EncryptedSharedPreferences dans l'APK ni dans les dépendances résolues"]["run"]
print("OK    enchaînement : contrôle, tests, images et applications, puis un seul Release écrit à la fin")
EOF

# --- Le manifeste : signé par le script de la CI, accepté par le vrai code du lanceur ------------------------------
python3 "$REPO/scripts/release-manifest.py" cle >paire
NOAH_RELEASE_KEY=$(sed -n 1p paire | awk '{print $NF}')
NOAH_UPDATE_KEY=$(sed -n 2p paire | awk '{print $NF}')
export NOAH_RELEASE_KEY NOAH_UPDATE_KEY
python3 "$REPO/scripts/release-manifest.py" cle >autre-paire
OTHER_PRIVATE=$(sed -n 1p autre-paire | awk '{print $NF}')
OTHER_PUBLIC=$(sed -n 2p autre-paire | awk '{print $NF}')

D=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
cat >refs.txt <<EOF
noah-server=ghcr.io/smfcoder17/noah-server@$D
noah-launcher=ghcr.io/smfcoder17/noah-launcher@$D
hermes=nousresearch/hermes-agent@$D
navigateur=ghcr.io/jo-inc/camofox-browser@$D
caddy=caddy@$D
EOF
printf 'Ce qui change\n[migration]\n' >notes.md
# shellcheck disable=SC2046
python3 "$REPO/scripts/release-manifest.py" signer 1.2.3 notes.md $(cat refs.txt) >/dev/null
NOAH_TOOL=1 PYTHONPATH="$REPO/launcher" python3 - "$NOAH_UPDATE_KEY" "$OTHER_PUBLIC" <<'EOF'
import os, sys
good, other = sys.argv[1], sys.argv[2]
os.environ["NOAH_UPDATE_STATE"] = "/tmp/etat-essai.json"
os.environ["NOAH_UPDATE_KEY"] = good
import updater
raw, sig = open("manifest.json", "rb").read(), open("manifest.json.sig").read()
m = updater.verify_manifest(raw, sig)
assert m["version"] == "1.2.3" and m["migration"] is True and "[migration]" not in m["notes"] and m["notes"] == "Ce qui change"
assert set(m["images"]) == {"noah-server", "noah-launcher", "hermes", "navigateur", "caddy"}
for label, data, key in (("modifié", raw.replace(b"1.2.3", b"9.9.9"), good), ("autre clé", raw, other)):
    updater.PUBLIC_KEY = key
    try:
        updater.verify_manifest(data, sig)
    except ValueError:
        continue
    raise SystemExit(f"manifeste {label} accepté")
print("OK    manifeste : accepté par updater.py, refusé s'il est modifié ou signé par une autre clé")
EOF
refuse "image sans empreinte" "sans empreinte" python3 "$REPO/scripts/release-manifest.py" signer 1.2.3 notes.md noah-server=ghcr.io/x/y:stable
refuse "signature sans clé" "NOAH_RELEASE_KEY absente" env -u NOAH_RELEASE_KEY python3 "$REPO/scripts/release-manifest.py" signer 1.2.3 notes.md "noah-server=x@$D"

# --- Le compose joint à la version ----------------------------------------------------------------------------------
sh "$REPO/scripts/compose-version.sh" smfcoder17 refs.txt "$REPO/deploy/docker-compose.yml" >compose.yml
grep -q "noah-server@$D" compose.yml || fail "serveur non épinglé"
grep -q "BROWSER_IMAGE: ghcr.io/jo-inc/camofox-browser@$D" compose.yml || fail "navigateur non épinglé"
if grep -E "image: .*:(stable|latest|2\.10)" compose.yml; then fail "image non épinglée"; fi
python3 -c "import yaml; yaml.safe_load(open('compose.yml', encoding='utf-8'))"
ok "compose : toutes les images par empreinte"
sed '/^caddy=/d' refs.txt >incomplet.txt
refuse "compose sans une empreinte" "pas d'empreinte pour caddy" sh "$REPO/scripts/compose-version.sh" smfcoder17 incomplet.txt "$REPO/deploy/docker-compose.yml"
sed 's#caddy:2.10-alpine#caddy:3#' "$REPO/deploy/docker-compose.yml" >autre-image.yml
refuse "compose avec une image inconnue" "image non épinglée" sh "$REPO/scripts/compose-version.sh" smfcoder17 refs.txt autre-image.yml

# --- preparer-signatures.sh : rien sans demande explicite, rien dans un dépôt, rien d'écrasé -------------------------
PREPARE="$REPO/scripts/preparer-signatures.sh"
HOME=$WORK/maison sh "$PREPARE" >sans-demande
[ ! -e "$WORK/maison" ] || fail "sans --generer, quelque chose a été créé"
grep -q NOAH_APK_KEYSTORE_PASSWORD sans-demande || fail "sans --generer, les noms de secrets ne sont pas donnés"
ok "préparation : sans --generer, rien n'est créé"
mkdir -p depot/.git
refuse "préparation dans un dépôt" "dans le dépôt git" sh "$PREPARE" --generer --dossier "$WORK/depot/sous/dossier"
[ ! -e depot/sous ] || fail "dossier créé dans un dépôt"
refuse "préparation dans ce dépôt" "dans le dépôt git" sh "$PREPARE" --generer --dossier "$REPO/cles" 2>/dev/null || [ ! -e "$REPO/.git" ]

sh "$PREPARE" --generer --dossier "$WORK/cles" >prepare.txt
for f in release.key release.pub noah-apk.keystore noah-apk.keystore.b64 noah-apk.password; do
  [ -s "cles/$f" ] || fail "$f absent"
done
[ "$(stat -c %a cles/release.key)" = 600 ] && [ "$(stat -c %a cles)" = 700 ] || fail "droits trop larges"
for secret in "$(cat cles/release.key)" "$(cat cles/noah-apk.password)" "$(cut -c1-40 cles/noah-apk.keystore.b64)"; do
  if grep -qF "$secret" prepare.txt; then fail "une valeur secrète est affichée"; fi
done
for name in NOAH_RELEASE_KEY NOAH_APK_KEYSTORE NOAH_APK_KEYSTORE_PASSWORD NOAH_APK_KEY_ALIAS NOAH_UPDATE_KEY; do
  grep -q "$name" prepare.txt || fail "$name n'est pas donné"
done
ok "préparation : cinq fichiers, droits fermés, aucune valeur affichée, les cinq noms donnés"
sum=$(sha256sum cles/noah-apk.keystore)
refuse "préparation sur des clés existantes" "existe déjà" sh "$PREPARE" --generer --dossier "$WORK/cles"
[ "$sum" = "$(sha256sum cles/noah-apk.keystore)" ] || fail "keystore écrasé"

# --- controle-publication.sh : ce qui part, ce qui ne part pas --------------------------------------------------------
CONTROL="$REPO/scripts/controle-publication.sh"
export GITHUB_OUTPUT="$WORK/sortie"
good() {
  env GITHUB_REF=refs/tags/v0.1.0 \
    NOAH_RELEASE_KEY="$(cat cles/release.key)" NOAH_UPDATE_KEY="$(cat cles/release.pub)" \
    NOAH_APK_KEYSTORE="$(cat cles/noah-apk.keystore.b64)" NOAH_APK_KEYSTORE_PASSWORD="$(cat cles/noah-apk.password)" \
    NOAH_APK_KEY_ALIAS=noah "$@"
}
: >sortie
good sh "$CONTROL" >/dev/null
grep -qx "version=0.1.0" sortie && grep -qx "stable=true" sortie || fail "version stable mal lue : $(cat sortie)"
ok "contrôle : version stable avec les clés de preparer-signatures.sh, acceptée"
: >sortie
env -u NOAH_RELEASE_KEY -u NOAH_UPDATE_KEY GITHUB_REF=refs/heads/main sh "$CONTROL" >/dev/null
grep -qx "version=" sortie || fail "main : pas de version attendue"
ok "contrôle : main, image edge, aucune clé demandée"
: >sortie
env -u NOAH_RELEASE_KEY -u NOAH_UPDATE_KEY GITHUB_REF=refs/tags/v0.1.0-rc1 sh "$CONTROL" | grep -q "::warning" || fail "préversion sans clés : pas d'avertissement"
grep -qx "version=0.1.0-rc1" sortie && grep -qx "stable=false" sortie || fail "préversion mal lue : $(cat sortie)"
ok "contrôle : préversion sans clés, acceptée avec un avertissement"
refuse "étiquette invalide" "Étiquette invalide" env GITHUB_REF=refs/tags/vert.moi.ça sh "$CONTROL"
for name in NOAH_RELEASE_KEY NOAH_UPDATE_KEY NOAH_APK_KEYSTORE NOAH_APK_KEYSTORE_PASSWORD NOAH_APK_KEY_ALIAS; do
  refuse "version stable sans $name" "$name" good env "$name=" sh "$CONTROL"
done
refuse "clé publique d'une autre paire" "ne correspond pas" good env NOAH_UPDATE_KEY="$OTHER_PUBLIC" sh "$CONTROL"
refuse "clé privée d'une autre paire" "ne correspond pas" good env NOAH_RELEASE_KEY="$OTHER_PRIVATE" sh "$CONTROL"
refuse "mauvais mot de passe du keystore" "Keystore illisible" good env NOAH_APK_KEYSTORE_PASSWORD=faux sh "$CONTROL"
refuse "mauvais alias" "Keystore illisible" good env NOAH_APK_KEY_ALIAS=autre sh "$CONTROL"
refuse "keystore qui n'en est pas un" "Keystore illisible" good env NOAH_APK_KEYSTORE=YWJj sh "$CONTROL"
keytool -genkeypair -keystore debug.keystore -storetype PKCS12 -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 100 \
  -dname "CN=Android Debug,O=Android,C=US" -storepass android -keypass android >/dev/null 2>&1
refuse "clé de débogage d'Android" "clé de débogage" good env NOAH_APK_KEYSTORE="$(base64 debug.keystore | tr -d '\n')" \
  NOAH_APK_KEYSTORE_PASSWORD=android NOAH_APK_KEY_ALIAS=androiddebugkey sh "$CONTROL"

echo "Publication : tout est bon"
