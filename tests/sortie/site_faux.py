"""Un faux site pour tests/sortie/docker_test.sh : répond « ip=<adresse de celui qui s'est connecté> ». Derrière une sortie, cette
adresse est celle du faux amont (maison ou VPN) qui a relayé la connexion ; en repli direct, celle de l'aiguillage lui-même."""
import asyncio
import os


async def un(r, w):
    try:
        await r.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError:  # une sonde qui se contente de se connecter
        w.close()
        return
    body = f"ip={w.get_extra_info('peername')[0]}".encode()
    w.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%b" % (len(body), body))
    await w.drain()
    w.close()


async def main():
    server = await asyncio.start_server(un, "0.0.0.0", int(os.environ.get("PORT", "8080")))
    async with server:
        await server.serve_forever()

asyncio.run(main())
