"""Audit 0.3.0, E1 (et M1 de Kimi) : isolement des conteneurs, lu dans les fichiers et dans les appels Docker du lanceur.

Attendu : agents et navigateurs sur leur réseau à part (noah-agents), sans le lanceur ; toutes les capacités retirées, sauf
celles que l'essai a prouvées nécessaires (agent : CHOWN, DAC_OVERRIDE, SETUID, SETGID, KILL ; navigateur : aucune) ;
no-new-privileges ; le lanceur ne répond qu'au serveur (et au relais des mises à jour).
La preuve sur de vrais conteneurs est dans tests/exposition/isolement_reel.sh (pile jetable -p noahtest).

    docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/isolement_test.py"
"""
import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock

import yaml

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
AGENT_CAPS = ["CHOWN", "DAC_OVERRIDE", "KILL", "SETGID", "SETUID"]
fails = 0


def check(ok: bool, what: str) -> None:
    global fails
    print(("ok   " if ok else "ÉCHEC ") + what)
    fails += not ok


# 1. Fichiers Compose : le lanceur sait quel réseau donner aux agents, et à qui répondre.
for name in ("deploy/docker-compose.yml", "deploy/docker-compose.traefik.yml", "docker-compose.yml"):
    services = yaml.safe_load((REPO / name).read_text(encoding="utf-8"))["services"]
    env = services["launcher"].get("environment") or {}
    check(env.get("AGENT_NETWORK") == "noah-agents", f"{name} : les agents ont leur réseau à part ({env.get('AGENT_NETWORK')})")
    check("noah-server" in str(env.get("NOAH_LANCEUR_CLIENTS", "")).split(","), f"{name} : le lanceur ne répond qu'au serveur")

# 2. Conteneurs créés par le lanceur : réseau, capacités, privilèges.
docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
os.environ.update({"LAUNCHER_KEY": "x", "AGENT_NETWORK": "noah-agents", "NOAH_LANCEUR_CLIENTS": "noah-server",
                   "NOAH_UPDATE_STATE": str(Path(tempfile.mkdtemp()) / "updates.json"),
                   "NOAH_SECRETS_FILE": str(Path(tempfile.mkdtemp()) / "noah.json")})
sys.path.insert(0, str(REPO / "launcher"))
start = threading.Thread.start
threading.Thread.start = lambda self: None  # à l'import, le lanceur lance ses reprises : pas ici
import launcher  # noqa: E402
import updater  # noqa: E402

threading.Thread.start = start
client = launcher.client
updater.client = client
updater.put_env = launcher.updater.put_env = lambda *a, **k: None
client.containers.get.side_effect = docker.errors.NotFound()
client.images.get.return_value.attrs = {"Config": {"Entrypoint": ["node"], "Cmd": ["server.js"]}}
ensure_network = launcher._ensure_agents_network
launcher._ensure_agents_network = lambda: None  # vérifié à part, plus bas

launcher._run_agent("essai", "k", [])
agent = client.containers.create.call_args.kwargs
check(agent["network"] == "noah-agents", f"agent : réseau à part ({agent['network']})")
check(agent.get("cap_drop") == ["ALL"], f"agent : toutes les capacités retirées ({agent.get('cap_drop')})")
check(sorted(agent.get("cap_add") or []) == AGENT_CAPS, f"agent : seulement les capacités prouvées ({agent.get('cap_add')})")
check("no-new-privileges" in (agent.get("security_opt") or []), "agent : no-new-privileges")
client.containers.create.reset_mock()
launcher.container = lambda agent_id: None


class Created(Exception):
    pass


client.containers.create.return_value.get_archive.side_effect = Created()
try:
    launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b", private_key="c", locale="", timezone=""))
except Created:
    pass
browser = client.containers.create.call_args.kwargs
check(browser["network"] == "noah-agents", f"navigateur : réseau des agents ({browser['network']})")
check(browser.get("cap_drop") == ["ALL"] and sorted(browser.get("cap_add") or []) == ["SETGID", "SETUID"],
      f"navigateur : SETUID et SETGID seules, pour le bureau sous le compte 1001 ({browser.get('cap_drop')}, {browser.get('cap_add')})")
check("no-new-privileges" in (browser.get("security_opt") or []), "navigateur : no-new-privileges")
check(int(launcher.BROWSER_VERSION) >= 20, "navigateur : version des réglages montée, les anciens sont recréés isolés")

# 3. Le réseau des agents : créé s'il manque, le serveur y est branché sous son nom ; le lanceur n'y est jamais.
launcher._ensure_agents_network = ensure_network
client.networks.get.side_effect = docker.errors.NotFound()
created_net = MagicMock(name="reseau")
created_net.attrs = {"Containers": {}}
client.networks.create.return_value = created_net
server = MagicMock(name="noah-server")
server.id = "serveur-id"
server.attrs = {"NetworkSettings": {"Networks": {"noah-net": {}}}}
client.containers.get.side_effect = lambda name: server if name == "noah-server" else (_ for _ in ()).throw(docker.errors.NotFound())
launcher._ensure_agents_network()
args, kwargs = client.networks.create.call_args
check(args[0] == "noah-agents" and kwargs.get("driver") == "bridge" and not kwargs.get("internal"), f"réseau créé : {args} {kwargs}")
created_net.connect.assert_called_once()
check(created_net.connect.call_args.kwargs.get("aliases") == ["noah-server"], f"serveur branché sous son nom : {created_net.connect.call_args}")
connected = [c.args[0] for c in created_net.connect.call_args_list]
check(all(getattr(c, "name", c) != "noah-launcher" for c in connected), "le lanceur ne se branche pas sur le réseau des agents")

# 4. Le lanceur ne répond qu'au serveur : un autre conteneur (agent, navigateur, Caddy) reçoit 403, même avec la clé.
from fastapi.testclient import TestClient  # noqa: E402

server.attrs = {"NetworkSettings": {"Networks": {"noah-net": {"IPAddress": "172.18.0.3"}, "noah-agents": {"IPAddress": "172.30.0.2"}}}}
launcher._peers.clear()
box = MagicMock()
box.labels = {launcher.BROWSER_LABEL: "essai"}
box.status = "running"
client.containers.get.side_effect = lambda name: server if name == "noah-server" else box
for ip, wanted in (("172.18.0.3", 200), ("172.30.0.2", 200), ("172.30.0.9", 403), ("172.18.0.4", 403), ("127.0.0.1", 200)):
    r = TestClient(launcher.app, client=(ip, 5000), headers={"Authorization": "Bearer x"}).get("/agents/essai/browser")
    check(r.status_code == wanted, f"lanceur appelé depuis {ip} : {r.status_code} (attendu {wanted})")
r = TestClient(launcher.app, client=("172.30.0.9", 5000)).get("/health")
check(r.status_code == 403, f"/health depuis un agent : {r.status_code}")

# 5. Santé d'un agent ou d'un navigateur : lue dedans (le lanceur n'est plus sur leur réseau).
agent_box = MagicMock()
agent_box.status = "running"
agent_box.attrs = {"State": {}, "RestartCount": 0}
agent_box.exec_run.return_value = (0, b"200")
updater._get = lambda name: agent_box
updater.POLL = 0
opened = []
updater._answers = lambda url: opened.append(url) or False
check(updater.healthy("noah-agent-essai", 5) is True, "santé d'un agent lue dans son conteneur")
cmd = agent_box.exec_run.call_args.args[0]
check("http://127.0.0.1:8642/health" in cmd and not opened, f"par 127.0.0.1, sans passer par le réseau : {cmd} {opened}")
agent_box.exec_run.return_value = (0, b"200")
updater.healthy("noah-browser-essai", 5)
check("http://127.0.0.1:9377/health" in agent_box.exec_run.call_args.args[0], "santé d'un navigateur lue dans son conteneur")

print("isolement : tout est vert" if not fails else f"isolement : {fails} échec(s)")
sys.exit(1 if fails else 0)
