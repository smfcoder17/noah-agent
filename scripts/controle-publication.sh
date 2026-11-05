#!/bin/sh
# Première étape de la publication (release.yml) : dit de quelle version il s'agit, et refuse tout de suite une version
# stable sans ses clés, avant de dépenser une heure de CI et de déplacer quoi que ce soit.
#
# Lit GITHUB_REF et les secrets en variables d'environnement ; écrit version= et stable= dans GITHUB_OUTPUT.
#   - pas une étiquette (image edge à la demande) : version vide, rien à vérifier ;
#   - vX.Y.Z-rc1 (préversion) : sans les clés, elle part quand même, sans manifeste et sans APK ; un avertissement le dit ;
#   - vX.Y.Z : tout est exigé. Sans clé du manifeste, les serveurs ne se mettraient jamais à jour ; sans keystore, l'APK
#     demanderait de désinstaller l'app à chaque version.
set -eu
OUT=${GITHUB_OUTPUT:-/dev/null}
HERE=$(dirname "$0")
REF=${GITHUB_REF:-}

case "$REF" in
  refs/tags/*) TAG=${REF#refs/tags/} ;;
  *)
    echo "Pas une étiquette ($REF) : image edge seulement."
    { echo "version="; echo "stable=false"; } >>"$OUT"
    exit 0
    ;;
esac
if ! echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "::error::Étiquette invalide : $TAG (attendu : v1.2.3 ou v1.2.3-rc1)"
  exit 1
fi
VERSION=${TAG#v}
case "$VERSION" in
  *-*) STABLE=false ;;
  *) STABLE=true ;;
esac

MISSING=""
for name in NOAH_RELEASE_KEY NOAH_UPDATE_KEY NOAH_APK_KEYSTORE NOAH_APK_KEYSTORE_PASSWORD NOAH_APK_KEY_ALIAS; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || MISSING="$MISSING $name"
done

if [ "$STABLE" = false ] && [ -n "$MISSING" ]; then
  echo "::warning title=Préversion sans ses clés::Absents :$MISSING. Elle part sans ce qui en dépend (manifeste, APK signé)."
  { echo "version=$VERSION"; echo "stable=$STABLE"; } >>"$OUT"
  exit 0
fi
if [ -n "$MISSING" ]; then
  echo "::error title=Version $VERSION refusée::Absents :$MISSING. Rien n'a été construit. Prépare-les avec sh scripts/preparer-signatures.sh --generer, pose-les, puis relance."
  exit 1
fi

PYTHON=python
command -v python >/dev/null 2>&1 || PYTHON=python3
"$PYTHON" "$HERE/release-manifest.py" verifier || {
  echo "::error::Clés du manifeste : NOAH_RELEASE_KEY et NOAH_UPDATE_KEY ne vont pas ensemble."
  exit 1
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
if ! printf '%s' "$NOAH_APK_KEYSTORE" | base64 -d >"$WORK/noah.keystore" 2>/dev/null; then
  echo "::error::NOAH_APK_KEYSTORE n'est pas du base64."
  exit 1
fi
# -storepass:env : le mot de passe n'apparaît ni dans la liste des processus ni dans le journal.
if ! keytool -list -v -keystore "$WORK/noah.keystore" -alias "$NOAH_APK_KEY_ALIAS" -storepass:env NOAH_APK_KEYSTORE_PASSWORD >"$WORK/liste" 2>&1; then
  echo "::error::Keystore illisible avec ce mot de passe et cet alias (NOAH_APK_KEYSTORE, NOAH_APK_KEYSTORE_PASSWORD, NOAH_APK_KEY_ALIAS)."
  exit 1
fi
if grep -q "CN=Android Debug" "$WORK/liste"; then
  echo "::error::NOAH_APK_KEYSTORE est la clé de débogage d'Android : elle ne signe pas une version."
  exit 1
fi
echo "Keystore lisible : $(grep -m1 'SHA256:' "$WORK/liste" | sed 's/^[[:space:]]*//')"

{ echo "version=$VERSION"; echo "stable=$STABLE"; } >>"$OUT"
echo "Version $VERSION : clés présentes et cohérentes."
