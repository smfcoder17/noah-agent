"""Banc d'essai commun : updater.py branché sur des conteneurs jetables (noahtest-agent-a, -b), jamais sur Noah."""
import base64
import json
import os
import sys

os.environ.setdefault("NOAH_UPDATE_STATE", "/state/updates.json")
os.environ.setdefault("NOAH_BACKUP_VOLUME", "noahtest-backups")
os.environ.setdefault("NOAH_UPDATE_HEALTH", "30")
os.environ.setdefault("NOAH_UPDATE_OBSERVE", "20")
os.environ.setdefault("NOAH_RELAY_NAME", "noahtest-relais")
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

KEY = Ed25519PrivateKey.from_private_bytes(base64.b64decode(os.environ["TEST_PRIVATE_KEY"]))
os.environ["NOAH_UPDATE_KEY"] = base64.b64encode(
    KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
sys.path.insert(0, "/l")
import docker  # noqa: E402
import updater as u  # noqa: E402

c = docker.from_env()
REG = os.environ["REGISTRY"]
AGENTS = ["noahtest-agent-a", "noahtest-agent-b"]
u.components = lambda: {"hermes": list(AGENTS)}
_component = u._component
u._component = lambda name: "hermes" if name.startswith("noahtest-agent-") else _component(name)
_health = u._health_url
u._health_url = lambda name: f"http://{name}:8000/health" if name.startswith("noahtest-agent-") else _health(name)
u.LAUNCHER = os.environ.get("NOAH_LAUNCHER_NAME", "noahtest-runner")  # image des outils : celle de ce conteneur


def ref(repo: str, tag: str) -> str:
    return next(d for d in c.images.get(f"{REG}/noahtest/{repo}:{tag}").attrs["RepoDigests"] if d.startswith(REG))


def signed(images: dict, version: str, key=KEY) -> tuple[bytes, str]:
    raw = json.dumps({"version": version, "images": images}).encode()
    return raw, base64.b64encode(key.sign(raw)).decode()
