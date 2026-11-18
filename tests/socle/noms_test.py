"""S0, garde-fou 2 : les noms de `main`. Les tests lisent et remplacent des noms de `main` (`main.X = …`) ;
si un nom part dans un autre fichier sans être réexporté, le test remplace un nom que plus personne ne lit.
Un nom en plus est permis, un nom en moins est un échec. Chaque `main.X =` trouvé dans `tests/` doit rester
un attribut de `main`.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/socle/noms_test.py"

`NOAH_ECRIRE=1` écrit `noms.json` au lieu de comparer.
"""
import json
import os
import re
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import main  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FILE = os.path.join(HERE, "noms.json")
TESTS = os.path.dirname(HERE)
now = sorted(n for n in dir(main) if not n.startswith("__"))

if os.environ.get("NOAH_ECRIRE") == "1":
    with open(FILE, "w", encoding="utf-8") as f:
        json.dump(now, f, ensure_ascii=False, indent=0)
        f.write("\n")
    print(f"{len(now)} noms écrits dans {FILE}")
    sys.exit(0)

with open(FILE, encoding="utf-8") as f:
    frozen = json.load(f)
missing = sorted(set(frozen) - set(now))
assert not missing, f"AssertionError : des noms de main ont disparu : {missing}"

assigned: dict[str, set[str]] = {}
for folder, _, files in os.walk(TESTS):
    for name in files:
        path = os.path.join(folder, name)
        if not name.endswith(".py") or path == os.path.abspath(__file__):
            continue
        with open(path, encoding="utf-8") as f:
            for found in re.finditer(r"\bmain\.(\w+)\s*=[^=]", f.read()):
                assigned.setdefault(found.group(1), set()).add(os.path.relpath(path, TESTS))
lost = {n: sorted(p) for n, p in assigned.items() if not hasattr(main, n)}
assert not lost, f"AssertionError : des tests remplacent un nom qui n'est plus un attribut de main : {lost}"
print(f"OK : {len(now)} noms de main (aucun en moins sur {len(frozen)} figés), {len(assigned)} noms remplacés par les tests, tous présents")
