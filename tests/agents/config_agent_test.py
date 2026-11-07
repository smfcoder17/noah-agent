"""La configuration que Noah écrit dans chaque agent : l'heure de la personne, et un réveil du navigateur qu'Hermes laisse finir.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/config_agent_test.py"
"""
import asyncio
import os
import re
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import yaml  # noqa: E402

from noah import db, hermes, updates  # noqa: E402

db.init()
written: dict = {}


async def launcher(method, path, **kw):
    written.update((kw.get("json") or {}).get("files") or {})
    return {}


async def read(agent_id, name):
    return written.get(name, "")


async def identity():
    return {"locale": "fr-FR", "timezone": "Europe/Paris"}  # l'adresse du serveur : un VPS en France


hermes._launcher, hermes._read, hermes.browser_identity = launcher, read, identity
MODEL = {"provider": next(iter(hermes.PROVIDERS)), "model": "essai"}


def config() -> dict:
    asyncio.run(hermes.configure("agent-1", MODEL, restart_after=False))
    return yaml.safe_load(written["config.yaml"])


assert config()["timezone"] == "Europe/Paris", "tant qu'aucune app n'a parlé : le fuseau du serveur"
updates.saw_client("America/Toronto")
assert config()["timezone"] == "America/Toronto", "l'agent suit l'heure de la personne, pas celle du serveur"
updates.saw_client("Pas/UnFuseau")
assert config()["timezone"] == "America/Toronto", "un fuseau invalide ne change rien"
print("fuseau : celui de la personne dès qu'une app l'a donné, jamais une valeur invalide")

# Seule l'app du propriétaire donne l'heure : un invité ne change pas celle de ses agents.
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, main  # noqa: E402

owner = auth.create_user("proprio", "mot-de-passe-essai-1", role="owner")
guest = auth.create_user("invite", "mot-de-passe-essai-2", role="user")
client = TestClient(main.app)


def seen_from(user: int, zone: str) -> None:
    client.cookies.set(auth.COOKIE, auth.new_session(user))
    assert client.get("/api/status", headers={"X-Noah-Timezone": zone}).status_code == 200


seen_from(guest, "Pacific/Kiritimati")
assert updates.client_zone() == "America/Toronto", "un invité a changé l'heure du propriétaire"
seen_from(owner, "Europe/Madrid")
assert updates.client_zone() == "Europe/Madrid", "le propriétaire change de fuseau"
print("fuseau : seule l'app du propriétaire le change")

plugin = written["plugins/noah-garde/__init__.py"]
seconds = int(re.search(r"^HOOK_SECONDS = (\d+)", plugin, re.M).group(1))
timeout = config()["plugins"]["hook_callback_timeout"]
assert timeout == seconds <= 600, (timeout, seconds)
assert "timeout=HOOK_SECONDS - 30)" in plugin, "le réveil doit finir avant qu'Hermes coupe le crochet"
assert "noah-garde" in config()["plugins"]["enabled"]
print(f"réveil du navigateur : Hermes laisse {timeout} s au crochet, et le crochet s'arrête avant")
