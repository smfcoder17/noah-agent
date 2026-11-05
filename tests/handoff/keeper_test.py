"""G7.7 côté serveur : un seul gardien du mode privé par agent. La fin d'une prise en main ne coupe jamais celle qui
la remplace, et « Prendre le contrôle » dans l'écran attend que le navigateur confirme le mode privé.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/handoff/keeper_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from noah import db, desktop, handoff  # noqa: E402

db.init()
desktop.notify = lambda *a, **k: None
sent: list[int] = []
browser = {"until": 0, "up": True}


async def fake_private(agent_id: str, seconds: int) -> bool:
    await asyncio.sleep(0.05 if seconds else 0.2)  # « rendre » lent : la course que Codex a reproduite
    if not browser["up"]:
        return False
    sent.append(seconds)
    browser["until"] = seconds
    return True


handoff._private = fake_private
handoff.PRIVATE_EVERY = 0.3


async def main():
    a = handoff.open_call("a1", "Connecte-toi")
    await asyncio.sleep(0.1)
    assert browser["until"] > 0
    handoff.close_call("a1", a["id"], "fait")      # fin de A : « rendre » en route…
    b = handoff.open_call("a1", "Tape le code")    # … B commence aussitôt
    await asyncio.sleep(0.8)
    assert browser["until"] > 0, f"B ouvert mais captures permises : {sent}"
    print("1. A finit pendant que B commence : B reste protégé", sent)

    handoff.close_call("a1", b["id"], "fait")
    await asyncio.sleep(0.5)
    assert browser["until"] == 0 and not handoff._keepers
    print("2. plus personne n'a la main : captures rendues, gardien arrêté")

    assert await handoff.take_control("a1", True) and browser["until"] > 0
    await asyncio.sleep(0.5)
    assert browser["until"] > 0
    assert await handoff.take_control("a1", False)
    await asyncio.sleep(0.5)
    assert browser["until"] == 0
    browser["up"] = False
    assert not await handoff.take_control("a1", True), "contrôle donné sans mode privé confirmé"
    assert "a1" not in handoff._manual
    print("3. « Prendre le contrôle » : privé confirmé avant la main ; navigateur muet = refus")
    print("gardien du mode privé : tout est vert")


asyncio.run(main())
