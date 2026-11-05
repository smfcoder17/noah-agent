"""Le lanceur sur un petit VPS : Docker refuse une limite de CPU au-dessus des cœurs de la machine, et le navigateur ne démarrait jamais.

    docker run --rm -v "$PWD/launcher:/launcher:ro" -v "$PWD/tests:/tests:ro" python:3.12-slim sh -c \
      "pip install -q fastapi pydantic httpx && python /tests/agents/petit_vps_test.py"
"""
import os
import sys
import tempfile
from unittest.mock import MagicMock

docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
os.environ.update(LAUNCHER_KEY="k", AGENT_NETWORK="reseau", NOAH_UPDATES_DIR=tempfile.mkdtemp())
sys.path.insert(0, "/launcher")
import launcher  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = launcher.client
launcher.updater.put_env = lambda *a, **k: None
client.containers.get.side_effect = docker.errors.NotFound()
launcher.container = lambda agent_id: None


def limits(cores):
    client.info.return_value = {"NCPU": cores}
    launcher._cores.cache_clear()
    client.containers.create.reset_mock()
    launcher._run_agent("essai", "k", [])
    agent = client.containers.create.call_args.kwargs["nano_cpus"]
    client.containers.create.reset_mock()

    class Created(Exception):
        pass

    client.containers.create.return_value.get_archive.side_effect = Created()  # la suite (fichiers à déposer) ne sert pas ici
    try:
        launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b"))
    except Created:
        pass
    browser = client.containers.create.call_args.kwargs["nano_cpus"]
    client.containers.create.return_value.get_archive.side_effect = None
    return agent / 1e9, browser / 1e9


assert limits(2) == (2, 2), "VPS à 2 cœurs : Docker refuse 4 CPU pour le navigateur"
assert limits(1) == (1, 1), "VPS à 1 cœur"
assert limits(16) == (2, 4), "grosse machine : les limites voulues"
print("1. les limites de CPU ne dépassent jamais les cœurs de la machine")

client.info.side_effect = RuntimeError("Docker occupé")
launcher._cores.cache_clear()
assert launcher._cpus(4) == 4_000_000_000
client.info.side_effect = None
print("2. nombre de cœurs illisible : la limite voulue")

client.images.get.side_effect = docker.errors.NotFound()
client.images.pull.reset_mock()
launcher._prefetch_images()
pulled = [c.args[0] for c in client.images.pull.call_args_list]
assert launcher.IMAGE in pulled and launcher.BROWSER_IMAGE in pulled, pulled
client.images.get.side_effect = None
print("3. les deux images sont préchargées : le premier usage du navigateur ne fige pas l'agent plusieurs minutes")

web = TestClient(launcher.app, raise_server_exceptions=False, headers={"x-launcher-key": "k", "Authorization": "Bearer k"})


@launcher.app.get("/essai-docker")
def refused():
    raise docker.errors.APIError("range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available")


r = web.get("/essai-docker")
assert r.status_code == 502 and "range of CPUs" in r.json()["detail"], r.text
print("4. un refus de Docker est rendu avec sa raison")
print("OK")
