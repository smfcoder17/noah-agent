#!/bin/sh
# Ce que la CI vérifierait, en local, avant tout déploiement. Rejoue chaque commande docker de tests.yml, puis le build de l'interface.
#   sh scripts/verifier.sh            tout
#   sh scripts/verifier.sh voice      seulement les étapes dont la commande contient « voice »
cd "$(dirname "$0")/.." || exit 1
[ -n "$MSYS_VERSION$MSYSTEM" ] && export MSYS_NO_PATHCONV=1 && PWD_DOCKER="$(pwd -W)" || PWD_DOCKER="$(pwd)"
filter="${1:-}"
fail=0
total=0
tmp=$(mktemp)
# Les pip install se partagent un cache : la suite complète ne retélécharge pas tout à chaque étape.
sed -n 's/^ *\(docker run --rm .*\)$/\1/p' .github/workflows/tests.yml | grep "${filter:-.}" > "$tmp"
while IFS= read -r line; do
  total=$((total + 1))
  name=$(printf '%s' "$line" | grep -oE '/tests/[^ "]+' | tail -1)
  cmd=$(printf '%s' "$line" | sed "s|\$PWD|$PWD_DOCKER|g; s|docker run --rm|docker run --rm -v noah-pip-cache:/root/.cache/pip|")
  if out=$(sh -c "$cmd" </dev/null 2>&1); then
    echo "OK     ${name:-$line}"
  else
    echo "ÉCHEC  ${name:-$line}"
    printf '%s\n' "$out" | tail -6
    fail=$((fail + 1))
  fi
done < "$tmp"
rm -f "$tmp"
if [ -z "$filter" ] || [ "$filter" = "front" ]; then
  if (cd frontend && npm run build >/dev/null 2>&1); then echo "OK     interface (npm run build)"; else echo "ÉCHEC  interface : cd frontend && npm run build"; fail=$((fail + 1)); fi
fi
echo "$total étape(s) docker, $fail échec(s)"
[ "$fail" -eq 0 ]
