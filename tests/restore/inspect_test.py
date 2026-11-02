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
print("restauration (archive) : tout est vert")
