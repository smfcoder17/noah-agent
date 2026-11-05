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
import socket  # noqa: E402
import time  # noqa: E402

import httpx  # noqa: E402

from noah import db, desktop, media, relay, watch  # noqa: E402

# DNS simulé : le relevé juge les adresses résolues, comme le client MCP.
DNS = {"concurrent.example": ["93.184.216.34"], "piege.example": ["93.184.216.34"], "interne.example": ["10.1.2.3"],
       "metadonnees.example": ["169.254.169.254"], "boucle.example": ["127.0.0.1"], "http.example": ["93.184.216.34"],
       "ailleurs.example": ["93.184.216.35"], "rebond.example": ["93.184.216.34"], "enorme.example": ["93.184.216.34"],
       "sans-fin.example": ["93.184.216.34"], "tourne.example": ["93.184.216.34"]}
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda host, port, *a, **k: (
    [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]] if host in DNS else _getaddrinfo(host, port, *a, **k))

db.init()
watch.init()
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Veilleur', '', 'k')")
db.set_setting("provider", "openrouter")
db.set_setting("model", "petit-modele")
db.set_setting("api_key", "k", secret=True)
media._key = lambda: "k"

PAGE = """<html><body><h1>Prix du jour</h1>
<p>Mis à jour il y a {ago} minutes, à {clock}. Les tarifs ci-dessous sont relevés chaque matin.</p>
<p>Abonnement Pro : 49 $ par mois, facturé annuellement, sans engagement de durée.</p>
{extra}</body></html>"""
page = {"ago": 3, "clock": "08:12", "extra": ""}
model_calls = []


source_calls: list[httpx.Request] = []
read = {"bytes": 0}
LONG = "<p>Une ligne assez longue pour compter comme un bloc de cette page de relevé.</p>"


async def huge():
    for _ in range(80):  # 8 Mo
        read["bytes"] += 100_000
        yield (LONG * (100_000 // len(LONG) + 1))[:100_000].encode()


async def endless():
    while True:
        await asyncio.sleep(0.02)
        yield LONG.encode()


def upstream(request: httpx.Request) -> httpx.Response:
    host = request.headers.get("host", "")
    if host == "concurrent.example":
        return httpx.Response(200, text=PAGE.format(**page), headers={"content-type": "text/html"})
    if request.url.host != "openrouter.ai":
        source_calls.append(request)
        if host == "piege.example":
            return httpx.Response(302, headers={"location": request.url.params.get("vers", "")})
        if host == "tourne.example":
            return httpx.Response(302, headers={"location": "https://tourne.example/encore"})
        if host == "rebond.example":
            if request.url.path == "/depart":
                return httpx.Response(301, headers={"location": "/arrivee?key=abc"})
            return httpx.Response(200, text='<p><a href="article">Un article assez long pour faire un bloc de cette page.</a></p>', headers={"content-type": "text/html"})
        if host == "enorme.example":
            return httpx.Response(200, content=huge(), headers={"content-type": "text/html"})
        if host == "sans-fin.example":
            return httpx.Response(200, content=endless(), headers={"content-type": "text/html"})
        return httpx.Response(200, text=LONG, headers={"content-type": "text/html"})
    model_calls.append(request)
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(
        {"pertinent": True, "resume": "Nouveau forfait Équipe à 99 $.", "retenues": [1]})}}], "usage": {"cost": 0.0004}})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
watch._transport = httpx.MockTransport(upstream)
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


# 8. Une source ne mène jamais au réseau interne : ni directement, ni après une redirection, ni par un nom qui y pointe.
def attempt(url: str) -> tuple[dict, str]:
    made = watch._create("a1", watch.NewWatch(nom="Essai", url=url))
    result = asyncio.run(watch.check(made["id"], lambda *a: None, lambda agent: "conv"))
    error = watch._row(made["id"])["last_error"]
    with db.connect() as c:
        c.execute("DELETE FROM watches WHERE id = ?", (made["id"],))
    return result, error


META = "http://169.254.169.254/latest/meta-data/iam/security-credentials/role"
for target, word in ((META, "métadonnées"), ("http://10.0.0.5/admin", "propriétaire"), ("http://127.0.0.1:9000/health", "machine de Noah"),
                     ("https://interne.example/", "propriétaire"), ("https://metadonnees.example/", "métadonnées"), ("https://boucle.example/", "machine de Noah"),
                     ("http://noah-server:8080/api/status", "réseau interne"), ("http://launcher:9000/agents", "réseau interne"),
                     ("http://[::ffff:169.254.169.254]/", "métadonnées"), ("https://2852039166/", "réseau interne")):
    source_calls.clear()
    for url in (target, f"https://piege.example/feed?vers={target}"):
        result, error = attempt(url)
        assert result.get("erreur") and word in error, f"{url} : {result} {error}"
        assert not any(r.url.host not in ("93.184.216.34",) for r in source_calls), f"{url} : connexion à {[str(r.url) for r in source_calls]}"
print("8. adresse interne, métadonnées ou boucle locale : refusées, y compris après une redirection, sans connexion")

# 9. La connexion part vers l'adresse vérifiée, avec le nom demandé pour Host et pour le certificat. Les sources ordinaires marchent.
source_calls.clear()
assert "erreur" not in attempt("http://http.example/flux?key=abc&token=xyz")[0], "http public et paramètres d'adresse d'une source"
sent = source_calls[-1]
assert sent.url.host == "93.184.216.34" and sent.headers["host"] == "http.example" and sent.url.params.get("key") == "abc", str(sent.url)
source_calls.clear()
attempt("https://ailleurs.example/page")
assert source_calls[-1].extensions.get("sni_hostname") == "ailleurs.example", "certificat vérifié contre le nom demandé"
items = asyncio.run(watch.fetch("https://rebond.example/depart"))
assert items and items[0]["lien"] == "https://rebond.example/article", items
print("9. connexion à l'adresse vérifiée, certificat contre le nom ; http public, clé dans l'adresse et redirection saine marchent")

# 10. Redirections sans fin : arrêtées.
result, error = attempt("https://tourne.example/")
assert result.get("erreur") and "redirections" in error, (result, error)
print("10. boucle de redirections : arrêtée")

# 11. Réponse énorme : lue jusqu'au plafond, pas au-delà. Réponse sans fin : arrêtée à la durée totale.
read["bytes"] = 0
assert asyncio.run(watch.fetch("https://enorme.example/")), "le début d'une page énorme reste lu"
assert read["bytes"] <= 3_100_000, f"{read['bytes']} octets lus sur 8 000 000"
limit, watch.FETCH_SECONDS = watch.FETCH_SECONDS, 0.3
started = time.monotonic()
result, error = attempt("https://sans-fin.example/")
took = time.monotonic() - started
watch.FETCH_SECONDS = limit
assert result.get("erreur") and "ne finit pas" in error and took < 3, (result, error, took)
print(f"11. réponse de 8 Mo : {read['bytes']} octets lus ; réponse sans fin : arrêtée en {took:.1f} s")
print("veilles : tout est vert")
