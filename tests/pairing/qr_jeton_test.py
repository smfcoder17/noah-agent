"""G2.2 : le jeton du QR fait au moins 128 bits, ne sert qu'une fois (un second scan donne une erreur claire) et expire au
bout de 10 min. Vrais : les routes et la mémoire du serveur. Simulé : l'horloge (décalée de 599 s, puis de 601 s).
L'écran de l'utilisateur au second scan se vérifie à part, dans un vrai navigateur : tests/pairing/qr_navigateur.mjs.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim \
      sh -c "pip install -q -r /app/requirements.txt && python /tests/pairing/qr_jeton_test.py"
"""
import base64
import collections
import math
import os
import sys
import tempfile
import threading
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
main._ip = lambda request: request.headers.get("x-test-ip", "")
ip = iter(range(1, 60000))


def client(token: str | None = None) -> TestClient:
    n = next(ip)
    c = TestClient(main.app, headers={"X-Test-Ip": f"10.{n >> 8}.{n & 255}.1"})
    if token:
        c.headers["Authorization"] = f"Bearer {token}"
    return c


class Clock:
    """L'horloge du seul module main, décalée : le serveur croit que `offset` secondes ont passé."""
    offset = 0.0

    def time(self) -> float:
        return time.time() + self.offset

    def __getattr__(self, name):
        return getattr(time, name)


clock = Clock()
main.time = clock
web = client(auth.new_session(alice, "Firefox", "web"))


def new_qr() -> tuple[str, dict]:
    p = web.post("/api/pairing").json()
    assert "#appairage=" in p["adresse"] and "?" not in p["adresse"], "jeton hors du fragment : " + p["adresse"]
    return p["adresse"].split("#appairage=")[1], p


def scan(token: str):
    return client().post("/api/pairing/claim", json={"code": token, "appareil": "Pixel 8", "type": "android"})


# 1. Au moins 128 bits de hasard : la taille décodée, et ce qu'on observe sur 500 jetons (répétition, répartition).
tokens = [new_qr()[0] for _ in range(500)]
raw = [base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)) for t in tokens]
assert min(len(b) for b in raw) * 8 >= 128, f"jeton de {min(len(b) for b in raw) * 8} bits"
assert all(base64.urlsafe_b64encode(b).rstrip(b"=").decode() == t for b, t in zip(raw, tokens)), "pas du base64url : taille non mesurable"
assert len(set(tokens)) == len(tokens), "deux QR ont le même jeton"
counts = collections.Counter(byte for b in raw for byte in b)
total = sum(counts.values())
entropy = -sum(n / total * math.log2(n / total) for n in counts.values())
assert entropy > 7.8, f"{entropy:.2f} bits par octet : jeton pas tiré au hasard"
print(f"1. jeton du QR : {min(len(b) for b in raw) * 8} bits, 500 jetons tous différents, {entropy:.2f} bits de hasard par octet")

# 2. Un seul usage : le premier scan passe, le second reçoit une erreur qui dit quoi faire. Rien de nouveau n'est créé.
token, p = new_qr()
first = scan(token)
assert first.status_code == 200 and first.json()["attente"], first.text
flows = len(main._flows)
second = scan(token)
assert second.status_code == 400, f"second scan accepté : {second.status_code}"
detail = second.json()["detail"]
assert "déjà servi" in detail and "nouveau code" in detail, f"erreur pas claire : {detail}"
assert len(main._flows) == flows, "le second scan a créé une demande"
assert scan(p["code"]).status_code == 400, "le code court du même affichage sert encore"
print(f"2. second scan : 400, « {detail} »")

# 3. Un seul usage quand 20 appareils scannent au même instant.
for _ in range(5):
    token, _p = new_qr()
    start = threading.Barrier(20)
    codes: list[int] = []

    def racer(c: TestClient = None) -> None:
        start.wait()
        codes.append(c.post("/api/pairing/claim", json={"code": token, "appareil": "x"}).status_code)

    threads = [threading.Thread(target=racer, args=(client(),)) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [200] + [400] * 19, collections.Counter(codes)
print("3. 20 scans simultanés (5 fois) : un seul passe")

# 4. Expiration à 10 min : annoncée à l'écran, et tenue des deux côtés de la limite.
token, p = new_qr()
assert p["expire"] == 600, f"expiration annoncée : {p['expire']} s"
clock.offset = 599
assert scan(token).status_code == 200, "refusé avant les 10 min"
clock.offset = 0
token, _p = new_qr()
clock.offset = 601
late = scan(token)
assert late.status_code == 400 and "expiré" in late.json()["detail"], late.text
assert auth.digest(token) not in main._pairing, "jeton expiré gardé en mémoire"
clock.offset = 0
print(f"4. expiration annoncée {p['expire']} s : accepté à 599 s, refusé à 601 s, oublié par le serveur")

# 5. Un jeton expiré ou déjà servi le reste : refaire un QR ne le ressuscite pas.
old = token
new_qr()
assert scan(old).status_code == 400, "ancien jeton ressuscité par un nouveau QR"
print("5. nouveau QR : l'ancien jeton reste mort")
print("G2.2 : tout est vert")
