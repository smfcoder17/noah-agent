"""Un navigateur éteint s'arrête après un délai ; jamais pendant qu'il sert, ni pendant une tâche de l'agent.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" -w /app noah-server python /tests/budget/repos_navigateur_test.py
"""
import asyncio
import os
import sys
import tempfile

os.environ.setdefault("NOAH_DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("NOAH_SECRET_KEY", "x" * 64)
os.environ.setdefault("LAUNCHER_KEY", "k")
sys.path.insert(0, "/app")

import httpx  # noqa: E402

from noah import hermes, main, relay  # noqa: E402

stopped, health = [], {}


async def fake_call(agent_id, method, path, **kw):
    if health is None:
        raise httpx.ConnectError("arrêté")
    return health


async def fake_stop(agent_id):
    stopped.append(agent_id)


hermes.browser_call = fake_call
hermes.stop_browser = fake_stop
main._agents = lambda: [{"id": "a"}]
main.BROWSER_REST_AFTER = 0.05


async def turn(state, active=None, wait=0.1):
    global health
    health = state
    relay.active["a"] = active or []
    await main.rest_browsers()
    await asyncio.sleep(wait)
    await main.rest_browsers()


async def run():
    await turn({"browserRunning": True})
    assert not stopped, "arrêté alors que Firefox tourne"
    await turn({"browserRunning": False}, active=["conv"])
    assert not stopped, "arrêté pendant une tâche de l'agent"
    await turn({"browserRunning": False, "recovering": True})
    assert not stopped, "arrêté pendant qu'il se relance"
    health_off = {"browserRunning": False}
    global health
    health = health_off
    relay.active["a"] = []
    await main.rest_browsers()
    assert not stopped, "arrêté sans le délai"
    await asyncio.sleep(0.1)
    await main.rest_browsers()
    assert stopped == ["a"], "un navigateur éteint reste allumé"
    health = None
    await main.rest_browsers()
    assert stopped == ["a"], "un conteneur déjà arrêté n'a rien à arrêter"
    print("navigateur au repos : tout est vert")


asyncio.run(run())
