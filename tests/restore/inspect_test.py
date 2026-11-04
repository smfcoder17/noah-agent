"""G3.5 : le lanceur n'accepte qu'une archive de scripts/backup.sh ; tout autre contenu fait refuser l'archive entière
avant qu'un seul volume soit touché.

    docker run --rm -e NOAH_TOOL=1 -v "$PWD/launcher:/l" -v "$PWD/tests:/tests" python:3.12-slim \
      python /tests/restore/inspect_test.py
"""
import io
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, "/l")
import restore  # noqa: E402

work = Path(tempfile.mkdtemp())


def archive(name: str, files: dict[str, bytes], symlink: str | None = None) -> Path:
    path = work / name
    with tarfile.open(path, "w") as tar:
        top = tarfile.TarInfo("noah-20261102-0300")
        top.type = tarfile.DIRTYPE
        tar.addfile(top)
        for n, data in files.items():
            info = tarfile.TarInfo(n)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if symlink:
            link = tarfile.TarInfo(symlink)
            link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
            tar.addfile(link)
    return path


def refused(path: Path, why: str) -> None:
    try:
        restore.inspect(path)
    except ValueError:
        return
    raise AssertionError(f"archive acceptée : {why}")


D = "noah-20261102-0300/"
good = archive("ok.tar", {D + "apollo_apollo-data.tar.gz": b"x", D + "apollo-agent-noah-1a2b.tar.gz": b"x",
                          D + "apollo-browser-noah-1a2b.tar.gz": b"x", D + "env": b"APOLLO_SECRET_KEY=k\n"})
assert set(restore.inspect(good)) == {"apollo_apollo-data.tar.gz", "apollo-agent-noah-1a2b.tar.gz",
                                      "apollo-browser-noah-1a2b.tar.gz", "env"}
print("1. sauvegarde de backup.sh : acceptée")

refused(archive("trav.tar", {D + "apollo_apollo-data.tar.gz": b"x", "noah/../../etc/cron.d/x": b"x"}), "chemin ..")
refused(archive("abs.tar", {D + "apollo_apollo-data.tar.gz": b"x", "/etc/x": b"x"}), "chemin absolu")
refused(archive("link.tar", {D + "apollo_apollo-data.tar.gz": b"x"}, symlink=D + "env"), "lien symbolique")
refused(archive("vol.tar", {D + "apollo_apollo-data.tar.gz": b"x", D + "apollo-caddy-data.tar.gz": b"x"}), "volume inconnu")
refused(archive("deep.tar", {D + "apollo_apollo-data.tar.gz": b"x", D + "a/b.tar.gz": b"x"}), "sous-dossier")
refused(archive("nodata.tar", {D + "apollo-agent-noah.tar.gz": b"x"}), "données du serveur absentes")
print("2. chemins .. ou absolus, liens, volumes inconnus, sous-dossiers, données absentes : archive refusée")

# 3. Avant tout : chaque archive intérieure se lit, et ce qu'elle déposera tient sur le disque (bombe de décompression).
import gzip  # noqa: E402
import shutil  # noqa: E402
from collections import namedtuple  # noqa: E402


def inner(files: dict[str, int]) -> bytes:
    """Archive .tar.gz dont les fichiers annoncent la taille donnée (que des zéros : elle se compresse très bien)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as t:
        for n, size in files.items():
            info = tarfile.TarInfo(n)
            info.size = size
            t.addfile(info, io.BytesIO(bytes(size)))
    return gzip.compress(raw.getvalue())


bomb = archive("bomb.tar", {D + "apollo_apollo-data.tar.gz": inner({"apollo.db": 1000}),
                            D + "apollo-agent-x.tar.gz": inner({"zeros": 20 << 20})})
Usage = namedtuple("Usage", "total used free")
shutil.disk_usage = lambda _: Usage(0, 0, (2 << 30) + (10 << 20))  # 2 Go de marge + 10 Mo libres
with tarfile.open(bomb) as tar:
    try:
        restore._preflight(tar, restore.inspect(bomb))
        raise AssertionError("archive plus grosse que la place libre acceptée")
    except ValueError as e:
        assert "Pas assez de place" in str(e), e
shutil.disk_usage = lambda _: Usage(0, 0, 100 << 30)
with tarfile.open(bomb) as tar:
    restore._preflight(tar, restore.inspect(bomb))
broken = archive("broken.tar", {D + "apollo_apollo-data.tar.gz": inner({"apollo.db": 1000})[:-20]})
with tarfile.open(broken) as tar:
    try:
        restore._preflight(tar, restore.inspect(broken))
        raise AssertionError("archive intérieure tronquée acceptée")
    except ValueError as e:
        assert "abîmée" in str(e), e
print("3. 20 Mo à déposer pour 10 Mo libres : refusé avant tout ; archive intérieure tronquée : refusée")

# 4. Codex : la copie de vérification des données du serveur occupe le disque en même temps que les volumes restaurés.
two = archive("two.tar", {D + "apollo_apollo-data.tar.gz": inner({"apollo.db": 6 << 20}),
                          D + "apollo-agent-x.tar.gz": inner({"state.db": 1 << 20})})
shutil.disk_usage = lambda _: Usage(0, 0, (2 << 30) + (9 << 20))  # 7 Mo à restaurer, 9 Mo libres : 13 Mo au plus fort
with tarfile.open(two) as tar:
    try:
        restore._preflight(tar, restore.inspect(two))
        raise AssertionError("pic d'occupation (copie de vérification comprise) ignoré")
    except ValueError as e:
        assert "au plus fort" in str(e), e
print("4. place disque : la copie de vérification des données compte (13 Mo au plus fort pour 9 Mo libres : refusé)")

# 4 bis. Codex (3e passage) : une archive peu compressible existe deux fois avant d'être décompressée.
def raw(n: int) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as t:
        info = tarfile.TarInfo("apollo.db")
        info.size = n
        t.addfile(info, io.BytesIO(os.urandom(n)))
    return gzip.compress(data.getvalue())


import os  # noqa: E402

dense = archive("dense.tar", {D + "apollo_apollo-data.tar.gz": raw(3 << 20)})
shutil.disk_usage = lambda _: Usage(0, 0, (2 << 30) + (10 << 20))  # 3 + 3 + 2 × 3 Mo au plus fort : 12 Mo
with tarfile.open(dense) as tar:
    try:
        restore._preflight(tar, restore.inspect(dense))
        raise AssertionError("deux copies temporaires de l'archive oubliées")
    except ValueError as e:
        assert "au plus fort" in str(e), e
print("4 bis. archive peu compressible : ses deux copies temporaires comptent (12 Mo pour 10 Mo libres : refusé)")

# 5. Codex : la clé de la sauvegarde doit signer ses secrets, sinon rien n'est remplacé.
import base64  # noqa: E402
import hashlib  # noqa: E402

from cryptography.fernet import Fernet  # noqa: E402

key = "k" * 64
token = Fernet(base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest())).encrypt(b"sk-or-v1-abc").decode()
restore._check_key(key, [token])
restore._check_key(key, [])
for wrong, tokens in (("z" * 64, [token]), (key, [token[:-4] + "AAAA"]), (key, ["gAAAAApasunjeton"])):
    try:
        restore._check_key(wrong, tokens)
        raise AssertionError("mauvaise clé acceptée")
    except ValueError as e:
        assert "ne correspond pas" in str(e), e
print("5. secrets : la clé de la sauvegarde doit les avoir signés (mauvaise clé, secret altéré : refusé avant tout)")
print("restauration (archive) : tout est vert")
