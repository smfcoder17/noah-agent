"""La configuration que Noah écrit dans chaque agent : l'heure de la personne, et un réveil du navigateur qu'Hermes laisse finir.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c "pip install -q -r /app/requirements.txt && python /tests/agents/config_agent_test.py"
"""
import asyncio
import json
import os
import re
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import yaml  # noqa: E402

from noah import db, hermes, updates  # noqa: E402

db.init()
written: dict = {}


async def launcher(method, path, **kw):
    written.update((kw.get("json") or {}).get("files") or {})
    return {}


async def read(agent_id, name):
    return written.get(name, "")


async def identity():
    return {"locale": "fr-FR", "timezone": "Europe/Paris"}  # l'adresse du serveur : un VPS en France


hermes._launcher, hermes._read, hermes.browser_identity = launcher, read, identity
MODEL = {"provider": next(iter(hermes.PROVIDERS)), "model": "essai"}


def config() -> dict:
    asyncio.run(hermes.configure("agent-1", MODEL, restart_after=False))
    return yaml.safe_load(written["config.yaml"])


assert config()["timezone"] == "Europe/Paris", "tant qu'aucune app n'a parlé : le fuseau du serveur"
updates.saw_client("America/Toronto")
assert config()["timezone"] == "America/Toronto", "l'agent suit l'heure de la personne, pas celle du serveur"
updates.saw_client("Pas/UnFuseau")
assert config()["timezone"] == "America/Toronto", "un fuseau invalide ne change rien"
print("fuseau : celui de la personne dès qu'une app l'a donné, jamais une valeur invalide")

# Seule l'app du propriétaire donne l'heure : un invité ne change pas celle de ses agents.
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, main  # noqa: E402

owner = auth.create_user("proprio", "mot-de-passe-essai-1", role="owner")
guest = auth.create_user("invite", "mot-de-passe-essai-2", role="user")
client = TestClient(main.app)


def seen_from(user: int, zone: str) -> None:
    client.cookies.set(auth.COOKIE, auth.new_session(user))
    assert client.get("/api/status", headers={"X-Noah-Timezone": zone}).status_code == 200


seen_from(guest, "Pacific/Kiritimati")
assert updates.client_zone() == "America/Toronto", "un invité a changé l'heure du propriétaire"
seen_from(owner, "Europe/Madrid")
assert updates.client_zone() == "Europe/Madrid", "le propriétaire change de fuseau"
print("fuseau : seule l'app du propriétaire le change")

plugin = written["plugins/noah-garde/__init__.py"]
seconds = int(re.search(r"^HOOK_SECONDS = (\d+)", plugin, re.M).group(1))
timeout = config()["plugins"]["hook_callback_timeout"]
assert timeout == seconds <= 600, (timeout, seconds)
# 0.1.8 : le réveil a deux délais (premier réveil avec téléchargement, puis réveil court) ; les deux finissent avant le crochet.
wake = int(re.search(r"^WAKE_SECONDS = (\d+)", plugin, re.M).group(1))
assert "WAKE_SECONDS if _browser_ever_awake else HOOK_SECONDS - 30" in plugin and wake < seconds - 30, "le réveil doit finir avant qu'Hermes coupe le crochet"
assert "noah-garde" in config()["plugins"]["enabled"]
print(f"réveil du navigateur : Hermes laisse {timeout} s au crochet, et le crochet s'arrête avant")

# 0.2.0, lot 3 : l'agent va au bout, et propose une suite sans relancer de lui-même.
soul = main._soul("Essai", "")
for needed, why in [
    ("le critère de fin", "1. un critère de fin avant une tâche en plusieurs étapes"),
    ("dans ton plan (todo) et pas dans ta réponse", "1. le critère reste dans le plan, pas dans le récit"),
    ("vérifie ce critère pour de vrai : relis le fichier, recharge la page, relance la commande", "2. une vraie vérification"),
    ("prends une autre voie (une autre source, un autre outil, un petit script à toi)", "3. une autre voie avant de demander"),
    ("en disant en une phrase ce que tu as essayé", "3. ce qu'il a essayé, en une phrase"),
    ("ce qui est fait et ce qui reste", "4. ce qui est fait et ce qui reste"),
    ("une seule suite concrète que tu peux faire toi-même, ou une routine si la tâche reviendra, en question à choix", "4. une suite, à toucher"),
    ("rien ne part avant", "4. la suite attend son geste"),
    ("écris un skill qui garde la leçon", "5. un skill après une tâche réussie qui reviendra"),
    ("pas le récit de ce tour", "5. une leçon, pas un journal"),
    ("devient un script dans /opt/data/workspace/outils/", "6. ses propres petits outils"),
    ("réponds-y sans outil, et ajoute au plus une phrase sur ce qui attend", "un « hi » ne reprend toujours pas une demande en suspens"),
    ("Ne raconte pas ton travail", "pas de récit"),
    ("Un paiement demande toujours confirmation", "les murs restent"),
]:
    assert needed in soul, why
assert "ne relance rien" not in soul, "la phrase qui empêchait toute suite proposée est retirée"
assert main._soul("Essai", "") == soul, "le prompt reste identique d'un appel à l'autre (cache du fournisseur)"
assert int(main.AGENT_SETUP_VERSION.split("-")[0]) >= 44, "les agents existants doivent recevoir le nouveau prompt"
print("prompt : critère de fin, vérification, autre voie, suite à toucher, skill, petits outils ; plus de « ne relance rien »")

# 0.2.0 : les widgets servent enfin. Une table dit quel bloc pour quoi, un exemple par bloc, trois blocs de plus.
widgets = soul[soul.index("## Montrer plutôt qu'écrire"):soul.index("## Dépannage")]
for row, block in [
    ("une question dont la réponse se touche", "choice"),
    ("un ou plusieurs posts de réseau social", "posts"),
    ("des produits ou des offres pour un achat", "products"),
    ("des sources, articles ou pages", "links"),
    ("des vidéos, lieux, images ou idées à parcourir en vignettes", "grid"),
    ("une comparaison de quelques lignes", "un tableau markdown"),
    ("beaucoup de lignes, ou des données à télécharger", "table"),
    ("des chiffres qui évoluent", "chart"),
    ("un fichier que tu as créé", "preview"),
    ("des étapes à suivre", "une liste numérotée"),
]:
    line = next((l for l in widgets.splitlines() if l.startswith("| " + row)), "")
    assert line and line.split("|")[2].strip().startswith(block), f"table de décision : {row} → {block} ({line!r})"


def first_object(text: str) -> str:
    depth = 0
    for i, c in enumerate(text):
        depth += {"{": 1, "}": -1}.get(c, 0)
        if depth == 0:
            return text[: i + 1]
    raise AssertionError(text)


for kind in ("choice", "posts", "products", "links", "grid", "table", "chart", "preview", "video"):
    example = next((l for l in widgets.splitlines() if f'{{"type": "{kind}"' in l), "")
    assert example, f"un exemple minimal pour {kind}"
    if kind in ("choice", "posts", "products", "links", "table", "preview"):
        shown = json.loads(first_object(example[example.index("{"):]))
        assert shown["type"] == kind, shown
for needed, why in [
    ('"state": "publié"', "un post dit son état"),
    ("sans code d'erreur", "pas de « code 344 » dans un bilan de posts"),
    ('"price": "129 €"', "un produit a son prix"),
    ("jamais une liste qui le répète", "pas de liste à puces en double du bloc"),
    ("termine ta réponse par un bloc links", "les sources en bloc links"),
    ("dans un bloc posts", "le post publié se montre en bloc"),
]:
    assert needed in soul, why
assert "liste compacte" not in soul and "Quand une structure aide plus qu'un paragraphe" not in soul, "l'ancienne consigne vague est retirée"
assert len(widgets) < 3800, f"la section reste courte (3 000 caractères avant la table et les trois blocs) : {len(widgets)} caractères"
assert main.AGENT_SETUP_VERSION.startswith("46-"), "les agents existants doivent recevoir la table des widgets (45) et le rythme sur X (46)"
print(f"prompt : table « ce que tu présentes → le bloc », exemple par bloc, posts, products, links ({len(widgets)} caractères)")
