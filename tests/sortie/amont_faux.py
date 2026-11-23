"""Un faux mandataire amont (« maison » ou « VPN ») pour tests/sortie/docker_test.sh : un CONNECT et rien d'autre, comme le mandataire HTTP
d'un VPN (Gluetun). On l'arrête et on le relance avec `docker stop` et `docker start`."""
import asyncio


async def pipe(r, w):
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except OSError:
        pass
    finally:
        w.close()


async def un(r, w):
    try:
        head = await r.readuntil(b"\r\n\r\n")
        host, _, port = head.split(b" ")[1].decode().rpartition(":")
        ar, aw = await asyncio.open_connection(host, int(port))
    except (OSError, asyncio.IncompleteReadError):
        w.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        w.close()
        return
    w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
    await w.drain()
    await asyncio.gather(pipe(r, aw), pipe(ar, w))


async def main():
    server = await asyncio.start_server(un, "0.0.0.0", 3128)
    async with server:
        await server.serve_forever()

asyncio.run(main())
