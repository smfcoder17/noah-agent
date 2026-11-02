"""Processus qui lance une mise à jour et meurt net à l'étape NOAH_TEST_CRASH_AT (comme un kill -9 du lanceur)."""
import sys

sys.path.insert(0, "/tests/updates")
from harness import ref, signed, u  # noqa: E402

if sys.argv[1] == "recover":
    u.recover()
else:
    tag, version = sys.argv[1], sys.argv[2]
    print(u.apply(*signed({"hermes": ref("app", tag)}, version)), flush=True)
