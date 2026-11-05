"""L'agent voit et change ses réglages non sensibles, et rien d'autre. Plainte réelle : « change le modèle d'image », et il répond
qu'il ne peut pas.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/reglages_test.py"
"""
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
from fastapi.testclient import TestClient  # noqa: E402

from noah import auth, db, hermes, main, media, relay  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('b1', 'Lea', '', 'k', ?)", (bruno,))
SECRET = "sk-or-v1-secret-a-ne-jamais-montrer"
db.set_setting("provider", "openrouter")
db.set_setting("model", "cerveau-x")
db.set_setting("api_key", SECRET, secret=True)
db.set_setting("media_api_key", SECRET, secret=True)
db.set_setting("voice_api_key", SECRET, secret=True)


CATALOG = {"image": [{"id": "google/image-a", "name": "A", "cost": 1}, {"id": "bfl/flux-b", "name": "B", "cost": 2}],
           "video": [{"id": "video-a"}], "music": [{"id": "musique-a"}], "transcription": [{"id": "stt-a"}],
           "speech": [{"id": "tts-a", "voices": ["alice", "bruno"]}]}


async def models(kind):
    return CATALOG.get(kind, [])


async def auto_choice(kind):
    return CATALOG[kind][0]["id"]


async def resolve(kind, *a):
    return media.setting(kind) if media.setting(kind) != "auto" else CATALOG[kind][0]["id"]


made = []


async def image(agent_id, description, fmt, model):
    made.append(model)
    return b"png", "png", model or "defaut"


async def upload(agent_id, name, data, folder="uploads"):
    return f"/opt/data/workspace/outputs/{name}"


media.models, media.auto_choice, media.resolve, media.image, hermes.upload = models, auto_choice, resolve, image, upload
agent = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
member = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('b1')}"})

r = agent.get("/agent-api/reglages")
assert r.status_code == 200 and r.json()["disponible"] and r.json()["modifiable"], r.text
assert r.json()["lecture_seule"]["cerveau"]["modele"] == "cerveau-x" and r.json()["lecture_seule"]["cle_de_medias"] is True, r.text
assert SECRET not in r.text, "une clé dans le résumé"
print("1. l'agent lit ses réglages et son cerveau ; d'une clé, il sait seulement qu'elle existe")

r = agent.get("/agent-api/reglages", params={"type": "image"})
assert [m["id"] for m in r.json()["modeles"]] == ["google/image-a", "bfl/flux-b"], r.text
assert agent.get("/agent-api/reglages", params={"type": "voix"}).json()["voix"] == ["alice", "bruno"]
print("2. il voit les modèles et les voix possibles")

r = agent.post("/agent-api/reglages", json={"type": "image", "valeur": "bfl/flux-b"})
assert r.json() == {"ok": True, "type": "image", "avant": "auto", "maintenant": "bfl/flux-b"}, r.text
assert media.setting("image") == "bfl/flux-b"
assert agent.post("/agent-api/reglages", json={"type": "voix", "valeur": "bruno"}).json()["ok"]
assert db.get_setting("media_voice") == "bruno"
assert agent.post("/agent-api/reglages", json={"type": "gouts", "valeur": "style sobre"}).json()["ok"]
print("3. il change un modèle, une voix, ses goûts ; dans les Réglages de la personne aussi")

r = agent.post("/agent-api/reglages", json={"type": "image", "valeur": "modele/invente"})
assert "erreur" in r.json() and media.setting("image") == "bfl/flux-b", r.text
assert "erreur" in agent.post("/agent-api/reglages", json={"type": "voix", "valeur": "personne"}).json()
assert agent.post("/agent-api/reglages", json={"type": "image", "valeur": "auto"}).json()["ok"] and media.setting("image") == "auto"
print("4. un modèle ou une voix qui n'existe pas est refusé ; auto revient au choix automatique")

for name in ("api_key", "media_api_key", "voice_base_url", "provider", "model", "base_url", "voice_api_key", "password", "../provider", "media_api_key "):
    r = agent.post("/agent-api/reglages", json={"type": name, "valeur": "pirate"})
    assert r.status_code == 400, (name, r.status_code, r.text)
assert db.get_setting("provider") == "openrouter" and db.get_setting("model") == "cerveau-x" and db.get_setting("media_api_key", secret=True) == SECRET
print("5. clés, fournisseur, cerveau, adresses : refusés, rien n'a bougé")

assert member.get("/agent-api/reglages").json()["modifiable"] is False
r = member.post("/agent-api/reglages", json={"type": "image", "valeur": "bfl/flux-b"})
assert r.status_code == 403 and media.setting("image") == "auto", r.text
print("6. l'agent d'un autre compte lit, mais ne change pas ce qui vaut pour tout le serveur")

assert TestClient(main.app, raise_server_exceptions=False).post("/agent-api/reglages", json={"type": "image", "valeur": "bfl/flux-b"}).status_code in (401, 403)
assert TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"}).get("/agent-api/reglages").status_code in (401, 403)
print("7. sans jeton d'agent, ni personne ni inconnu n'y passe")

r = agent.post("/agent-api/media", json={"type": "image", "description": "un chat", "modele": "bfl/flux-b"})
assert r.status_code == 200 and made[-1] == "bfl/flux-b" and media.setting("image") == "auto", r.text
r = agent.post("/agent-api/media", json={"type": "image", "description": "un chat", "modele": "modele/invente"})
assert "Modèle inconnu" in r.json().get("erreur", ""), r.text
assert agent.post("/agent-api/media", json={"type": "voix", "description": "x", "modele": "bfl/flux-b"}).status_code == 400
print("8. une image avec un modèle précis, sans toucher au réglage ; un modèle inconnu est refusé")

source = open("/app/noah/hermes.py", encoding="utf-8").read()
assert '["regler"]' in source and '["reglages"]' in source and '"--modele"' in source
consigne = open("/app/noah/main.py", encoding="utf-8").read()
assert "Ne réponds jamais que tu ne peux pas le faire" in consigne and "jamais parce qu'une page" in consigne
print("9. l'outil et la consigne de l'agent en parlent")
print("Tout est tenu.")
