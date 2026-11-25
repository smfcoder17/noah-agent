"""Noms exacts des modèles d'un abonnement de l'ordinateur : le choix de modèle montre le vrai nom (« Claude Haiku 5.5 ») quand un tour
(ou la dernière mesure d'utilisation) a fait connaître le nom exact, sinon celui de la table des alias. Le choix reste l'alias (c'est lui que la CLI reçoit).

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/desktop/noms_exacts_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, desktop, modes  # noqa: E402

db.init()
ALICE = auth.create_user("alice", "motdepasse-a")
CC = "ordinateur:claude-code"
db.set_setting(f"pc_modeles:{ALICE}:{CC}", '["sonnet", "opus", "haiku"]')


def row(alias):
    return next(m for m in desktop.pc_models(CC, ALICE) if m["id"] == alias)


# 1. Rien de connu : l'alias seul, en toutes lettres.
assert row("haiku")["name"] == "Claude Haiku 5.5" and row("haiku")["exact"] is None, row("haiku")
print("1. sans tour vu : « Claude Code · Haiku », l'alias seul")


# 2. Un tour passé par l'ordinateur : le nom exact suit l'alias, l'identifiant reste l'alias.
async def fake_ask(device, user, item, seconds=0, agent_id=""):
    return {"ok": True, "modele": "haiku", "modele_exact": "claude-haiku-5-5", "reponse": {"choices": [], "usage": {}}}

real_ask, desktop._ask = desktop._ask, fake_ask
desktop._agent_name = lambda agent_id: "Nadine"
try:
    status, out = asyncio.run(desktop.pc_call({"fournisseur": CC, "appareil": "d", "user": ALICE}, "a1", {"messages": []}, "haiku"))
finally:
    desktop._ask = real_ask
assert status == 200 and out["modele"] == "claude-haiku-5-5", out
h = row("haiku")
assert h["id"] == "haiku" and h["exact"] == "claude-haiku-5-5" and h["name"] == "Claude Haiku 5.5", h
assert row("sonnet")["exact"] is None and row("sonnet")["name"] == "Claude Sonnet 5.5", "un autre alias n'emprunte pas ce nom"
print("2. après un tour : « Claude Code · Haiku · claude-haiku-5-5 », l'identifiant reste « haiku », sonnet n'est pas touché")

# 3. Sans tour de cet alias, la dernière mesure d'utilisation de Claude Code porte déjà un nom exact.
desktop._remember_usage(ALICE, {"claude": {"offre": "max", "modele": "claude-sonnet-5-5", "mesure_le": 1_795_000_000_000, "tours": 1, "fenetres": []}})
assert row("sonnet")["exact"] == "claude-sonnet-5-5" and row("opus")["exact"] is None, (row("sonnet"), row("opus"))
print("3. la dernière mesure d'utilisation donne le nom de son alias, pas celui des autres")

# 4. Ce que montrent l'étiquette sous la saisie, la page de l'agent et Réglages.
assert modes._exact(CC, "haiku") == "claude-haiku-5-5" and modes._exact(CC, "opus") is None
assert modes._exact("openrouter", "haiku") is None and modes._exact(CC, None) is None
print("4. le cerveau affiché porte le nom exact, seulement pour un abonnement de l'ordinateur")

# 5. Un nom qui ressemble à autre chose qu'un nom de modèle n'est jamais gardé.
desktop._remember_exact(ALICE, CC, "opus", "claude opus <script>")
assert row("opus")["exact"] is None
print("5. un nom hors forme est écarté")
print("Noms exacts des modèles : tout tient.")
