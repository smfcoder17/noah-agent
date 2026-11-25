"""Les modèles d'un abonnement par l'ordinateur portent leur vrai nom, pas l'alias de la ligne de commande.

Avant : « Claude Code · sonnet », « Claude Code · opus », « Claude Code · haiku ». Après : « Claude Sonnet 5.5 »… d'une seule table (desktop.PC_ALIAS_NAMES),
ou du modèle que Claude Code a réellement servi quand l'ordinateur l'a rapporté (`modele_exact`). ChatGPT et Grok : l'identifiant lu comme un nom.
Aucun nom ne répète le fournisseur : l'écran dit déjà d'où vient le modèle.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/desktop/modeles_noms_test.py"
"""
import asyncio
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")

from noah import auth, db, desktop  # noqa: E402

db.init()
OWNER = auth.create_user("alice", "motdepasse-a")
CLAUDE, CHATGPT, GROK = "ordinateur:claude-code", "ordinateur:chatgpt", "ordinateur:grok"
desktop._remember_models(OWNER, {CLAUDE: {"modeles": ["sonnet", "opus", "haiku"]}, CHATGPT: {"modeles": ["gpt-5.2", "gpt-5.2-codex", "o3"]},
                                 GROK: {"modeles": ["grok-4", "grok-4-fast"]}})


def names(provider):
    return {m["id"]: m["name"] for m in desktop.pc_models(provider, OWNER)}


# 1. Claude Code : la table donne les vrais noms des alias, sans « Claude Code · ».
assert names(CLAUDE) == {"sonnet": "Claude Sonnet 5.5", "opus": "Claude Opus 5.5", "haiku": "Claude Haiku 5.5"}, names(CLAUDE)
print("1. alias de Claude Code : « Claude Sonnet 5.5 », « Claude Opus 5.5 », « Claude Haiku 5.5 »")

# 2. ChatGPT et Grok : l'identifiant devient un nom lisible, jamais « ChatGPT · gpt-5.2 ».
assert names(CHATGPT) == {"gpt-5.2": "GPT 5.2", "gpt-5.2-codex": "GPT 5.2 Codex", "o3": "O3"}, names(CHATGPT)
assert names(GROK) == {"grok-4": "Grok 4", "grok-4-fast": "Grok 4 Fast"}, names(GROK)
for provider in (CLAUDE, CHATGPT, GROK):
    assert not any(" · " in n for n in names(provider).values()), names(provider)
print("2. ChatGPT et Grok : « GPT 5.2 », « GPT 5.2 Codex », « Grok 4 Fast » ; aucun nom ne répète le fournisseur")

# 3. Le modèle que Claude Code a réellement servi l'emporte sur la table (une nouvelle génération se lit toute seule).
desktop.remember_exact(OWNER, CLAUDE, "opus", "claude-opus-5-6-20270105")
assert names(CLAUDE)["opus"] == "Claude Opus 5.6", names(CLAUDE)
assert names(CLAUDE)["sonnet"] == "Claude Sonnet 5.5", "les autres alias gardent la table"
desktop.remember_exact(OWNER, CLAUDE, "haiku", "claude-haiku-5-5[1m]")
assert names(CLAUDE)["haiku"] == "Claude Haiku 5.5", names(CLAUDE)
desktop.remember_exact(OWNER, CLAUDE, "sonnet", "pas un modèle !")  # une valeur piégée n'est pas gardée
assert names(CLAUDE)["sonnet"] == "Claude Sonnet 5.5"
print("3. modèle réellement servi : « claude-opus-5-6-20270105 » donne « Claude Opus 5.6 » ; valeur piégée ignorée")

# 4. Le suivi garde son nom d'appel (« Claude Code · opus · abonnement ») : un seul changement, celui de la liste.
assert desktop.usage_name(CLAUDE, "opus") == "Claude Code · opus · abonnement"

# 5. Un tour réussi retient le modèle exact rapporté par l'ordinateur.
async def ask(device, user, item, seconds=0, agent_id=""):
    return {"ok": True, "reponse": {"choices": []}, "modele": "sonnet", "modele_exact": "claude-sonnet-5-7"}

desktop._ask = ask
status, _ = asyncio.run(desktop.pc_call({"fournisseur": CLAUDE, "appareil": "d", "user": OWNER}, "agent", {"messages": []}, "sonnet"))
assert status == 200 and names(CLAUDE)["sonnet"] == "Claude Sonnet 5.7", names(CLAUDE)
print("5. un tour servi par claude-sonnet-5-7 : la liste dit « Claude Sonnet 5.7 »")
print("OK")
