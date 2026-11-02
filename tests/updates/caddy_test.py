"""Contrôle de bout en bout à travers un vrai Caddy (TLS vérifié, flux SSE), sain puis cassé."""
import io
import os
import sys
import tarfile
import time

sys.path.insert(0, "/tests/updates")
from harness import c, docker, u  # noqa: E402

u.SERVER, u.CADDY = "noahtest-server", "noahtest-caddy"
CADDYFILE = b"""noahtest.localhost {
  tls internal
  reverse_proxy noahtest-server:8080 {
    flush_interval -1
  }
}
"""


def remove(name):
    try:
        c.containers.get(name).remove(force=True)
    except docker.errors.NotFound:
        pass


def server(events):
    remove(u.SERVER)
    c.containers.run("python:3.12-slim", ["python", "/tests/updates/server_app.py"], name=u.SERVER, detach=True,
                     network="noahtest-net", environment={"STREAM_EVENTS": str(events)},
                     volumes={os.environ["TESTS_DIR"]: {"bind": "/tests", "mode": "ro"}})
    assert u.healthy(u.SERVER, 30)


remove(u.CADDY)
caddy = c.containers.create("caddy:2.10-alpine", name=u.CADDY, network="noahtest-net")
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w") as tar:
    info = tarfile.TarInfo("Caddyfile")
    info.size = len(CADDYFILE)
    tar.addfile(info, io.BytesIO(CADDYFILE))
caddy.put_archive("/etc/caddy", buf.getvalue())
caddy.start()
server(2)
# Autorité locale de Caddy : le contrôle vérifie le certificat comme un navigateur qui lui ferait confiance.
for _ in range(30):
    try:
        stream, _ = c.containers.get(u.CADDY).get_archive("/data/caddy/pki/authorities/local/root.crt")
        break
    except docker.errors.NotFound:
        time.sleep(1)
with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
    pem = tar.extractfile(tar.getmembers()[0]).read()
open("/tmp/caddy-ca.pem", "wb").write(pem)
os.environ["NOAH_TEST_CA"] = "/tmp/caddy-ca.pem"
assert any(u._through_caddy() or time.sleep(2) for _ in range(15)), "flux sain refusé à travers Caddy"
print("caddy 1. flux SSE de bout en bout, HTTPS vérifié, à travers un vrai Caddy : sain")

server(1)
t0 = time.time()
assert not u._through_caddy(), "flux sans 2e événement accepté"
assert time.time() - t0 < 25, "pas d'échéance globale"
assert u.observe([u.SERVER], 1, caddy_before=True) == u.SERVER
print("caddy 2. flux qui ne livre jamais son 2e événement : refusé en moins de 25 s, le serveur est désigné fautif")

os.environ.pop("NOAH_TEST_CA")  # sans l'autorité de Caddy, son certificat n'est pas de confiance
server(2)
assert not u._through_caddy(), "certificat non vérifié accepté"
print("caddy 3. certificat d'une autorité inconnue : refusé (TLS vérifié)")
for n in (u.SERVER, u.CADDY):
    remove(n)
