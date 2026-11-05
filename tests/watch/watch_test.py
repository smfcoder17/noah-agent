"""G8.3 : une veille sur une page qui ne bouge pas ne fait aucun appel au modèle. Seule une vraie nouveauté coûte un tri.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/watch/watch_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import json  # noqa: E402

import httpx  # noqa: E402

from noah import db, desktop, media, relay, watch  # noqa: E402

db.init()
watch.init()
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Veilleur', '', 'k')")
db.set_setting("media_voice_brain", "petit-modele")
media._key = lambda: "k"

PAGE = """<html><body><h1>Prix du jour</h1>
<p>Mis à jour il y a {ago} minutes, à {clock}. Les tarifs ci-dessous sont relevés chaque matin.</p>
<p>Abonnement Pro : 49 $ par mois, facturé annuellement, sans engagement de durée.</p>
{extra}</body></html>"""
page = {"ago": 3, "clock": "08:12", "extra": ""}
model_calls = []


def upstream(request: httpx.Request) -> httpx.Response:
    if request.url.host == "concurrent.example":
        return httpx.Response(200, text=PAGE.format(**page), headers={"content-type": "text/html"})
    model_calls.append(request)
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(
        {"pertinent": True, "resume": "Nouveau forfait Équipe à 99 $.", "retenues": [1]})}}], "usage": {"cost": 0.0004}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
desktop.notify = lambda *a, **k: None
saved = []
w = watch._create("a1", watch.NewWatch(nom="Prix", url="https://concurrent.example/prix", critere="un nouveau forfait"))


def run() -> dict:
    return asyncio.run(watch.check(w["id"], lambda conv, role, text: saved.append(text), lambda agent: "conv"))


# 1. Premier passage : la page est apprise, sans tri.
assert run()["nouveautes"] == 0 and not model_calls
# 2. Mêmes blocs, seules l'heure et « il y a N minutes » changent : aucun appel au modèle, sur 20 passages.
for i in range(20):
    page.update(ago=4 + i, clock=f"{8 + i // 6:02d}:{(13 + i) % 60:02d}")
    r = run()
    assert r["nouveautes"] == 0 and not r["alerte"], r
assert not model_calls, f"{len(model_calls)} appels au modèle pour une page immobile"
print("1. page immobile (heure et « il y a N minutes » qui changent) : 21 passages, aucun appel au modèle")

# 3. Une vraie nouveauté : un seul tri, une alerte ; le passage suivant ne repaie pas.
page["extra"] = "<p>Nouveau : forfait Équipe à 99 $ par mois pour cinq personnes, disponible dès aujourd'hui.</p>"
r = run()
assert r["nouveautes"] == 1 and r["alerte"] and len(model_calls) == 1, (r, len(model_calls))
assert saved and "Équipe" in saved[-1]
assert run()["nouveautes"] == 0 and len(model_calls) == 1
print("2. nouveau bloc : un seul tri et une alerte ; ensuite plus rien")

# 4. Un prix qui change est une nouveauté (les nombres hors heure comptent).
page["extra"] = page["extra"].replace("99 $", "89 $")
assert run()["nouveautes"] == 1 and len(model_calls) == 2
print("3. un prix qui change compte comme nouveauté")

# 5. Mise à jour du format des empreintes : réapprentissage silencieux, pas de tri de toute la page.
db.set_setting("veille_cles", "1")
watch.init()
r = run()
assert r["nouveautes"] == 0 and len(model_calls) == 2, (r, len(model_calls))
print("4. nouveau format d'empreinte : la page est réapprise sans tri ni fausse alerte")

# 6. Codex (3e passage) : une heure du contenu qui change est une nouveauté ; l'heure d'un horodatage ne l'est pas.
k = watch._key
assert k("Le prochain départ du train Montréal Québec est prévu à 14h30.") != k("Le prochain départ du train Montréal Québec est prévu à 15h30.")
assert k("Last updated 2:05 pm. Prices below are checked daily for all plans.") == k("Last updated 3:47 pm. Prices below are checked daily for all plans.")
assert k("Publié le 2 novembre à 08:12 par la rédaction, lecture de cinq minutes.") == k("Publié le 2 novembre à 09:40 par la rédaction, lecture de cinq minutes.")
print("6. « départ prévu à 14h30 » → « 15h30 » : nouveauté ; « mis à jour / publié à HH:MM » : ignoré")

# 7. Page stable de plus de SEEN_MAX blocs : aucun tri, passage après passage.
page["extra"] = "".join(f"<p>Produit numéro {i} de la gamme, disponible en trois couleurs et deux tailles.</p>" for i in range(3100))
before = len(model_calls)
run()
for _ in range(5):
    r = run()
    assert r["nouveautes"] == 0, r
assert len(model_calls) - before <= 1, f"{len(model_calls) - before} tris pour une page stable de 3 100 blocs"
print("7. page stable de 3 100 blocs : plus aucun tri après son apprentissage")
print("veilles : tout est vert")
