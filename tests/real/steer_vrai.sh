#!/usr/bin/env bash
# Preuve sur un vrai Hermes, sans clé ni dépense : un message glissé dans un run en cours (POST /v1/runs/{id}/steer) arrive
# au modèle pendant ce run, sans l'interrompre. Le test unitaire simule cet appel ; ici, c'est le vrai.
#     bash tests/real/steer_vrai.sh
set -u
export MSYS_NO_PATHCONV=1
ROOT=$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))
PREFIX=noah-essai-steer
NET=$PREFIX-net
KEY=cle-essai-steer-$RANDOM
SERVER_IMAGE=ghcr.io/smfcoder17/noah-server:edge
HERMES_IMAGE=nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d

clean() {
  docker rm -f "$PREFIX-faux" "$PREFIX-agent" "$PREFIX-essai" >/dev/null 2>&1
  docker volume rm "$PREFIX-data" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
clean
trap clean EXIT
docker network create "$NET" >/dev/null
docker volume create "$PREFIX-data" >/dev/null

docker run -d --name "$PREFIX-faux" --network "$NET" -e FAUX_NOM="$PREFIX-faux" -v "$ROOT/tests/real:/t:ro" "$SERVER_IMAGE" python /t/faux_services.py >/dev/null

# Le volume de l'agent : son modèle est le faux, et l'API a sa clé.
docker run --rm -v "$PREFIX-data:/opt/data" --entrypoint sh "$HERMES_IMAGE" -c "cat > /opt/data/config.yaml <<EOF
model:
  provider: custom
  default: faux-modele
  base_url: http://$PREFIX-faux:11500/v1
  api_key: faux
terminal:
  backend: local
EOF
printf 'API_SERVER_KEY=$KEY\n' > /opt/data/.env; chown -R 10000:10000 /opt/data" >/dev/null

docker run -d --name "$PREFIX-agent" --network "$NET" -e API_SERVER_ENABLED=true -e API_SERVER_HOST=0.0.0.0 -v "$PREFIX-data:/opt/data" "$HERMES_IMAGE" gateway run >/dev/null

docker run --rm --name "$PREFIX-essai" --network "$NET" -e AGENT="http://$PREFIX-agent:8642" -e FAUX="http://$PREFIX-faux:11500" -e KEY="$KEY" "$SERVER_IMAGE" python -c '
import json, os, sys, time
import httpx

agent, faux, headers = os.environ["AGENT"], os.environ["FAUX"], {"Authorization": "Bearer " + os.environ["KEY"]}
for _ in range(90):
    try:
        if httpx.get(agent + "/health", timeout=2).status_code == 200:
            break
    except httpx.HTTPError:
        pass
    time.sleep(2)
else:
    sys.exit("Hermes ne démarre pas")
print("1. Hermes répond")

r = httpx.post(agent + "/v1/runs", headers=headers, timeout=30, json={"session_id": "essai-steer",
    "input": "OUTIL terminal {\"command\": \"sleep 12; echo travail-fini\"}"})
r.raise_for_status()
run = r.json()["run_id"]
print("2. run lancé, un outil de 12 s en cours")
for _ in range(30):  # l outil est parti : le modèle a déjà été appelé une fois
    if httpx.get(faux + "/_journal").json()["appels"]:
        break
    time.sleep(0.5)
time.sleep(1)

r = httpx.post(f"{agent}/v1/runs/{run}/steer", headers=headers, timeout=10, json={"input": "PRECISION-ZZZ écris plutôt en anglais"})
print("3. steer :", r.status_code, r.text[:200])
assert r.status_code < 300, r.text
before = len(httpx.get(faux + "/_journal").json()["appels"])
assert before == 1, f"le run a été relancé au lieu de continuer : {before} appels"

final = None
with httpx.stream("GET", f"{agent}/v1/runs/{run}/events", headers=headers, timeout=90) as events:
    for line in events.iter_lines():
        if line.startswith("data:"):
            try:
                event = json.loads(line[5:])
            except ValueError:
                continue
            if str(event.get("event") or event.get("type")) in ("run.completed", "run.failed", "run.cancelled"):
                final = event
                break
print("4. fin du run :", json.dumps(final, ensure_ascii=False)[:300])
assert final and "completed" in str(final.get("event") or final.get("type")), final

calls = httpx.get(faux + "/_journal").json()["appels"]
assert any("PRECISION-ZZZ" in c["tout"] for c in calls[1:]), "la précision n est jamais arrivée au modèle"
assert "travail-fini" in calls[-1]["tout"], "l outil a été coupé : son résultat doit arriver au modèle"
print(f"5. le modèle a reçu la précision pendant le run, après l outil ({len(calls)} appels), sans interruption")
print("OK")
'
code=$?
if [ "$code" != 0 ]; then docker logs "$PREFIX-agent" 2>&1 | tail -25; fi
exit $code
