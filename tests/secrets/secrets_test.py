"""G7.2 : aucun jeton dans la config Docker des conteneurs créés par le lanceur (ce que montrent `docker inspect` et le
Docker Manager de Hostinger), et l'API de l'agent comme le navigateur refusent toujours qui n'a pas le jeton.

À lancer dans le conteneur du lanceur (il a le socket Docker et la clé) :
    docker cp tests/secrets/secrets_test.py apollo-launcher:/tmp/ && docker exec apollo-launcher python /tmp/secrets_test.py
"""
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

import docker

sys.path.insert(0, "/app")
from launcher import KEY  # noqa: E402

client = docker.from_env()
agent_id = "essai" + secrets.token_hex(3)
api_key, browser_key, vnc = secrets.token_hex(24), secrets.token_hex(24), secrets.token_hex(4)
SECRETS = {"API_SERVER_KEY": api_key, "CAMOFOX_API_KEY": browser_key, "VNC_PASSWORD": vnc}


def call(method: str, url: str, body: dict | None = None, token: str | None = KEY, timeout: float = 600) -> int:
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        return urllib.request.urlopen(req, timeout=timeout).status
    except urllib.error.HTTPError as e:
        return e.code


def leaked(name: str) -> list[str]:
    env = client.containers.get(name).attrs["Config"]["Env"] or []
    return [k for k in SECRETS if any(e.startswith(k + "=") for e in env) or any(SECRETS[k] in e for e in env)]


def wait_up(url: str, token: str | None) -> int:
    for _ in range(90):
        try:
            return call("GET", url, token=token, timeout=3)
        except Exception:
            time.sleep(2)
    raise SystemExit(f"{url} ne répond pas")


try:
    assert call("POST", f"http://localhost:9000/agents/{agent_id}", {"api_key": api_key}) == 200
    agent = f"apollo-agent-{agent_id}"
    assert not leaked(agent), f"jeton dans la config Docker de l'agent : {leaked(agent)}"
    url = f"http://{agent}:8642/v1/models"
    assert wait_up(url, api_key) == 200, "l'agent refuse son propre jeton"
    assert call("GET", url, token=None) == 401 and call("GET", url, token="faux") == 401, "API de l'agent ouverte sans jeton"
    print("1. agent : aucun jeton dans docker inspect ; son API exige le jeton (401 sans)")

    body = {"api_key": browser_key, "vnc_password": vnc, "locale": "fr-FR", "timezone": "Europe/Paris"}
    assert call("POST", f"http://localhost:9000/agents/{agent_id}/browser", body) == 200
    browser = f"apollo-browser-{agent_id}"
    assert not leaked(browser), f"jeton dans la config Docker du navigateur : {leaked(browser)}"
    wait_up(f"http://{browser}:9377/health", None)
    # Import de cookies : la route que Camoufox protège par CAMOFOX_API_KEY (lu du fichier au démarrage).
    cookies = f"http://{browser}:9377/sessions/noah/cookies"
    assert call("POST", cookies, {"cookies": []}, token=browser_key) == 200, "le navigateur refuse son jeton"
    assert call("POST", cookies, {"cookies": []}, token=None) == 403, "import de cookies ouvert sans jeton"
    assert call("POST", cookies, {"cookies": []}, token="faux") == 403
    print("2. navigateur : aucun jeton dans docker inspect ; son API exige le jeton")

    # Changement des dossiers partagés : l'agent est recréé, il garde son jeton sans qu'il réapparaisse.
    assert call("PUT", f"http://localhost:9000/agents/{agent_id}/folders", {"dossiers": []}) == 200
    assert not leaked(agent) and wait_up(url, api_key) == 200
    print("3. agent recréé : même jeton, toujours hors de la config Docker")

    # Agent d'avant ce changement (jeton dans sa config) : une mise à jour qui le recrée déplace le jeton dans son .env.
    import updater
    c = client.containers.get(agent)
    c.stop(timeout=30)
    legacy = client.containers.create(c.image.id, command="gateway run", name=agent + "-avant", labels={"apollo.agent": agent_id},
                                      environment={"API_SERVER_ENABLED": "true", "API_SERVER_HOST": "0.0.0.0", "API_SERVER_KEY": api_key},
                                      volumes={agent: {"bind": "/opt/data", "mode": "rw"}}, network=c.attrs["HostConfig"]["NetworkMode"])
    c.remove(force=True)
    updater.put_env(legacy, "/opt/data/.env", {"API_SERVER_KEY": ""})  # .env d'avant : sans le jeton
    updater._create_like(legacy, agent, legacy.image.id)
    legacy.remove(force=True)
    client.containers.get(agent).start()
    assert not leaked(agent), "jeton resté dans la config après la mise à jour"
    assert wait_up(url, api_key) == 200 and call("GET", url, token=None) == 401
    print("4. agent d'avant : la recréation par une mise à jour déplace son jeton dans son .env")

    # 5. Codex : migration au démarrage du lanceur. Un « -ancien » resté d'une opération coupée : on ne touche à rien.
    # Un nouveau conteneur qui ne répond pas : lui seul est supprimé, l'original revient sous son nom et redémarre.
    import launcher as L  # noqa: E402
    img = client.containers.get(agent).image.id
    mig = f"apollo-agent-{agent_id}-mig"
    orig = client.containers.create(img, entrypoint=["sleep", "3600"], name=mig, labels={"apollo.agent": agent_id + "-mig"},
                                    environment={"API_SERVER_KEY": api_key}, volumes={mig: {"bind": "/opt/data", "mode": "rw"}})
    orig.start()
    stale = client.containers.create(img, entrypoint=["sleep", "3600"], name=mig + "-ancien")
    L._migrate_agent_tokens()
    assert client.containers.get(mig).id == orig.id and client.containers.get(mig + "-ancien").id == stale.id
    stale.remove(force=True)
    healthy, L.updater.healthy = L.updater.healthy, lambda name, seconds=None: False
    try:
        L._migrate_agent_tokens()
    finally:
        L.updater.healthy = healthy
    back = client.containers.get(mig)
    assert back.id == orig.id and back.status == "running", (back.id, orig.id, back.status)
    assert not [c for c in client.containers.list(all=True) if c.name.startswith(mig) and c.id != orig.id]
    print("5. migration au démarrage : « -ancien » déjà là, rien ne bouge ; nouveau muet, l'original revient intact")

    # 6. Codex (3e passage) : création à moitié faite (copie d'un fichier qui échoue après la création du conteneur).
    L.updater.COPIED_FILES[mig] = ["/introuvable/fichier"]
    try:
        L._migrate_agent_tokens()
    finally:
        L.updater.COPIED_FILES.pop(mig, None)
    back = client.containers.get(mig)
    assert back.id == orig.id and back.status == "running", (back.id, orig.id, back.status)
    assert not [c for c in client.containers.list(all=True) if c.name.startswith(mig) and c.id != orig.id]
    print("6. création à moitié faite : le conteneur neuf est retiré, l'original revient sous son nom")
    print("secrets hors de la config Docker : tout est vert")
finally:
    call("DELETE", f"http://localhost:9000/agents/{agent_id}")
    for name in (f"apollo-agent-{agent_id}", f"apollo-agent-{agent_id}-avant", f"apollo-browser-{agent_id}",
                 f"apollo-agent-{agent_id}-mig", f"apollo-agent-{agent_id}-mig-ancien"):
        try:
            client.containers.get(name).remove(force=True)
        except docker.errors.NotFound:
            pass
    for v in (f"apollo-agent-{agent_id}", f"apollo-browser-{agent_id}", f"apollo-agent-{agent_id}-mig"):
        try:
            client.volumes.get(v).remove(force=True)
        except docker.errors.NotFound:
            pass
