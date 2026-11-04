"""Un agent figé, qui ne ferme pas la connexion et n'envoie plus rien, ne garde pas une tâche ouverte pour toujours.

Vrai flux HTTP sur une vraie socket : le faux Hermes n'envoie ses signes de vie que tant qu'on le lui dit.
    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" -w /app apollo-server python /tests/coordination/silence_test.py
"""
import asyncio
import os
import sys
import tempfile
import time

os.environ.setdefault("APOLLO_DATA_DIR", tempfile.mkdtemp())
sys.path.insert(0, "/app")

import httpx  # noqa: E402

from apollo import hermes  # noqa: E402

alive = {"signs": 3}


async def fake_hermes(reader, writer):
    await reader.readuntil(b"\r\n\r\n")
    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
    for _ in range(alive["signs"]):
        writer.write(b": keepalive\n\n")
        await writer.drain()
        await asyncio.sleep(0.1)
    await asyncio.sleep(30)  # figé : la connexion reste ouverte, plus rien ne passe


class Stuck(hermes.Agent):
    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{PORT}"


async def main() -> None:
    global PORT
    server = await asyncio.start_server(fake_hermes, "127.0.0.1", 0)
    PORT = server.sockets[0].getsockname()[1]
    hermes.RUN_SILENCE = 0.3
    t0 = time.monotonic()
    try:
        async for _ in hermes.run_events(Stuck("a", "k"), "run"):
            pass
    except httpx.ReadTimeout:
        took = time.monotonic() - t0
        # Les signes de vie repoussent l'échéance : une tâche longue qui vit n'est pas coupée.
        assert took >= 0.5, f"coupée trop tôt, malgré les signes de vie : {took:.2f} s"
        assert took < 2, f"coupée trop tard : {took:.2f} s"
        print(f"agent figé : coupé {took:.2f} s après le début", flush=True)
        server.close()
        os._exit(0)
    raise AssertionError("un agent figé garde la tâche ouverte")


asyncio.run(main())
