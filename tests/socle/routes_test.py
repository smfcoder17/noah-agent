"""S0, garde-fou 1 : l'ordre des routes. FastAPI essaie les routes dans l'ordre où elles sont déclarées :
déplacer un bloc de `main.py` sans garder sa place change quelle route répond.
La table `[chemin, méthodes, nom]` de `main.app.routes` est figée dans `routes.json`.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/socle/routes_test.py"

`NOAH_ECRIRE=1` écrit le fichier au lieu de comparer (à lancer dans ce même conteneur : la page web ne se monte
que si le dossier de l'interface existe, et il n'existe pas ici).
"""
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import main  # noqa: E402

FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "routes.json")
now = [[getattr(r, "path", ""), sorted(getattr(r, "methods", None) or []), getattr(r, "name", "")] for r in main.app.routes]

if os.environ.get("NOAH_ECRIRE") == "1":
    with open(FILE, "w", encoding="utf-8") as f:
        json.dump(now, f, ensure_ascii=False, indent=0)
        f.write("\n")
    print(f"{len(now)} routes écrites dans {FILE}")
    sys.exit(0)

with open(FILE, encoding="utf-8") as f:
    frozen = json.load(f)
for i in range(max(len(frozen), len(now))):
    a = frozen[i] if i < len(frozen) else None
    b = now[i] if i < len(now) else None
    assert a == b, f"AssertionError : la table des routes a changé à la position {i} : figée {a}, actuelle {b} ({len(frozen)} figées, {len(now)} actuelles)"
print(f"OK : {len(now)} routes, dans l'ordre figé")
