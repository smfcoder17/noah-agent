"""Un bouton qui envoie {} ne doit jamais tomber sur une route qui exige un champ. Vu en vrai : « Connecter » d'une application répondait
422, « Vérifie les champs du formulaire », depuis son premier jour. On croise le code de l'interface avec les vraies routes du serveur.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/frontend:/frontend:ro" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/sources/corps_vides_test.py"
"""
import os
import re
import sys
import tempfile
from pathlib import Path

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from noah import main  # noqa: E402

FRONT = Path("/frontend/src")
routes = []
for r in main.app.routes:
    field = getattr(getattr(r, "body_field", None), "type_", None) or getattr(getattr(r, "body_field", None), "field_info", None)
    dependant = getattr(r, "dependant", None)
    if not dependant:
        continue
    for param in dependant.body_params:
        annotation = param.field_info.annotation
        models = [a for a in getattr(annotation, "__args__", (annotation,)) if hasattr(a, "model_fields")]
        required = [n for m in models for n, f in m.model_fields.items() if f.is_required()]
        if required:
            routes.append((r.path_regex, r.path, r.methods, required))
assert len(routes) > 20, "trop peu de routes lues : le test ne lit plus rien"

calls = 0
bad = []
for file in [*FRONT.rglob("*.tsx"), *FRONT.rglob("*.ts")]:
    text = file.read_text(encoding="utf-8")
    for found in re.finditer(r"send(?:<[^(]*>)?\(\s*[\"`]([^\"`]+)[\"`],\s*\{\s*\}", text):
        path = found.group(1)
        bases = re.findall(r"const base = `([^`]+)`", text[:found.start()])  # celle du composant : la dernière écrite avant l'appel
        for full in [path.replace("${base}", bases[-1]) if "${base}" in path and bases else path]:
            url = re.sub(r"\$\{[^}]+\}", "x", full).split("?")[0]
            calls += 1
            for regex, route, methods, required in routes:
                if "POST" in methods and regex.match(url):
                    bad.append(f"{file.name} : {full} -> {route} exige {required}")
assert calls > 15, f"trop peu d'appels lus : {calls}"
assert not bad, "\n".join(bad)
print(f"{calls} appels au corps vide, {len(routes)} routes à champs obligatoires : aucun bouton ne tombe sur un champ exigé")

# Le sabotage du test lui-même : l'erreur d'origine doit être vue.
from pydantic import BaseModel, Field  # noqa: E402


class Ancienne(BaseModel):
    adresse: str = Field(min_length=4)


annotation = Ancienne | None
models = [a for a in getattr(annotation, "__args__", (annotation,)) if hasattr(a, "model_fields")]
assert [n for m in models for n, f in m.model_fields.items() if f.is_required()] == ["adresse"]
print("la forme de l'erreur d'origine (corps facultatif, champ exigé) est bien reconnue")
