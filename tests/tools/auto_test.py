"""Mode Auto du cerveau : une demande classée une fois, le bon niveau en tête, les autres en relais, Équilibré en panne.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/tools/auto_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, complexite, db, decision, modes, relay  # noqa: E402

db.init()
owner = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (owner,))
db.set_setting("provider", "openrouter")
db.set_setting("model", "lab/cerveau")
db.set_setting("api_key", "sk-essai", secret=True)

LINKS = {"fast": {"modele": "lab/petit", "fournisseur": "openrouter"}, "balanced": {"modele": "lab/moyen", "fournisseur": "openrouter"},
         "smart": {"modele": "lab/fort", "fournisseur": "openrouter"}}


async def fake_links(level, mode, rotate=True):
    return [LINKS[mode]] if mode in LINKS else []

modes.links_of = fake_links
modes._keep_usable = lambda links: links
asked: list[str] = []
answer = {"niveau": "simple"}
broken = [False]


async def fake_ask(agent_id, system, user, **kw):
    asked.append(user)
    if broken[0]:
        raise decision.DecisionError("panne")
    return decision.Answer(json.dumps(answer), answer, "lab/decision", 0.0, 10)

decision.ask = fake_ask


def body(text, *steps):
    return {"model": "x", "messages": [{"role": "system", "content": "consignes"}, {"role": "user", "content": text},
                                         *({"role": "tool", "content": s} for s in steps)]}


async def main():
    db.set_setting("model_mode_a1", "auto")
    chain = await relay._chain_of("a1", "x", body("Salut, ça va ?"))
    assert [link["modele"] for link in chain] == ["lab/petit", "lab/moyen", "lab/fort"], chain
    answer["niveau"] = "complexe"
    chain = await relay._chain_of("a1", "x", body("Écris un programme qui analyse mes ventes et corrige le bug du graphique"))
    assert chain[0]["modele"] == "lab/fort", chain
    n = len(asked)
    chain = await relay._chain_of("a1", "x", body("Écris un programme qui analyse mes ventes et corrige le bug du graphique", "résultat d'outil"))
    assert len(asked) == n and chain[0]["modele"] == "lab/fort", "les étapes d'une même tâche ne reclassent pas"
    parts = {"model": "x", "messages": [{"role": "user", "content": [{"type": "text", "text": "Rédige un post"}, {"type": "image_url", "image_url": {"url": "data:"}}]}]}
    assert complexite.last_request(parts) == "Rédige un post"
    broken[0] = True
    chain = await relay._chain_of("a1", "x", body("Une demande jamais vue"))
    assert chain[0]["modele"] == "lab/moyen", ("panne : Équilibré", chain)
    chain = await relay._chain_of("a1", "x", {"messages": [{"role": "system", "content": "s"}]})
    assert chain[0]["modele"] == "lab/moyen", "sans demande : Équilibré"
    broken[0] = False
    db.set_setting("model_mode_a1", "fast")
    db.set_setting("model_a1", "lab/petit")
    n = len(asked)
    await relay._chain_of("a1", "x", body("Encore une autre demande"))
    assert len(asked) == n, "hors Auto, aucune classification"
    # Revue : Rapide est aussi le modèle de décision ; le modèle inscrit pour l'agent ne doit pas l'être, sinon tout passerait pour un petit travail.
    decision.model = lambda: "lab/petit"
    db.set_setting("model_a1", "lab/petit")
    await modes.set_agent_mode("a1", "auto")
    assert db.get_setting("model_a1") not in (None, "lab/petit"), db.get_setting("model_a1")
    answer["niveau"] = "complexe"
    chain = await relay._chain_of("a1", db.get_setting("model_a1"), body("Refais toute l'architecture du site et migre la base"))
    assert chain[0]["modele"] == "lab/fort", chain
    assert (await relay._chain_of("a1", "lab/petit", body("titre")))[0]["modele"] == "lab/petit", "un petit travail d'Hermes reste au modèle de décision"
    print("Auto : une classification par demande, le bon niveau en tête puis les autres en relais, Équilibré en panne ou sans demande")


asyncio.run(main())
