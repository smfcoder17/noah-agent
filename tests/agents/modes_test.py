"""Les modes : la personne décide quel modèle fait quoi. Gratuit et Custom passent au suivant quand l'un est épuisé, sans jamais dépasser
ni les clés ni le budget. Vrais modèles de décision (Jev, Clef) et réglages d'une routine, sans réseau.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/agents/modes_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from noah import access, auth, catalog, db, decision, hermes, machine, main, media, modes, relay, watch  # noqa: E402

db.init()
watch.init()
alice = auth.create_user("alice", "motdepasse-a")
bruno = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a2', 'Lea', '', 'k', ?)", (alice,))
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('b1', 'Marc', '', 'k', ?)", (bruno,))
SECRET = "sk-or-v1-secret-a-ne-jamais-montrer"
db.set_setting("provider", "openrouter")
db.set_setting("model", "lab/cerveau")
db.set_setting("api_key", SECRET, secret=True)


async def launcher(method, path, **kw):
    return {}


async def nothing(*a, **k):
    return {}


async def read_nothing(agent_id, name):
    return ""


hermes._launcher, hermes._read, hermes.browser_identity = launcher, read_nothing, nothing
hermes.browser_secrets = lambda agent_id: ("cle-navigateur", "x")
main.mcp.seal_rights = nothing
decision.schedule_refresh = lambda: None


def m(mid, price_in=None, price_out=None, free=False, context=200000, created=1):
    return {"id": mid, "name": mid, "lab": mid.split("/")[0], "created": created, "context": context, "price_in": price_in, "price_out": price_out,
            "tools": True, "vision": False, "free": free}


LISTED = [m("lab/cerveau", 3, 15), m("lab/a", 1, 2), m("lab/b", 0.5, 1), m("lab/c", 0.2, 0.4), m("lab/gratuit-1:free", 0, 0, True, created=5), m("lab/gratuit-2:free", 0, 0, True, created=9),
          m("lab/sans-prix"), m("openrouter/free", 0, 0, True), m("lab/image-seule", 0, 0, True), m("lab/petit-contexte:free", 0, 0, True, context=8000), m("anthropic/claude-sonnet", 3, 15),
          m("anthropic/claude-haiku", 0.1, 0.5)]


async def listed():
    return LISTED


catalog.openrouter_catalog = listed

calls: list[dict] = []
behavior: dict[str, object] = {}  # modèle -> code d'erreur, ou fonction qui rend la réponse


def ok_body(model, text="ok"):
    return {"id": "x", "object": "chat.completion", "created": 1, "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0.001}}


async def sse(model, then_fail=False):
    yield f'data: {json.dumps({"choices": [{"delta": {"content": "bonjour"}}], "model": model})}\n\n'.encode()
    if then_fail:
        raise httpx.ReadError("coupé")
    yield b'data: {"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "cost": 0.001}}\n\ndata: [DONE]\n\n'


def upstream(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    calls.append({"url": str(request.url), "model": body.get("model"), "auth": request.headers.get("authorization", ""), "body": body})
    what = behavior.get(body.get("model"))
    if callable(what):
        return what(body)
    if isinstance(what, int):
        return httpx.Response(what, headers={"retry-after": "120"} if what == 429 else {}, json={"error": {"message": "non", "code": what}})
    if body.get("stream"):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse(body.get("model")))
    return httpx.Response(200, json=ok_body(body.get("model")))


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
web = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(alice, 'Firefox', 'web')}"})
other = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {auth.new_session(bruno, 'Firefox', 'web')}"})
agent = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a1')}"})
agent2 = TestClient(main.app, raise_server_exceptions=False, headers={"Authorization": f"Bearer {relay.token_for('a2')}"})


def ask(client=agent, model="lab/cerveau", **extra):
    return client.post("/relay/v1/chat/completions", json={"model": model, "messages": [{"role": "user", "content": "bonjour"}], **extra})


def reset():
    calls.clear()
    behavior.clear()
    modes._cooling.clear()


def tried():
    return [c["model"] for c in calls]


def chain(*names):
    r = web.put("/api/modes/cerveau", json={"chaine": [{"modele": n} for n in names], "actif": "custom"})
    assert r.status_code == 200, r.text
    return r.json()


# --- La chaîne ------------------------------------------------------------------------------------------------------------

chain("lab/a", "lab/b", "lab/c")
assert db.get_setting("model") == "lab/a" and modes.active("cerveau") == "custom"
assert ask().status_code == 200 and tried() == ["lab/a"]
print("1. le premier de la liste répond ; il devient le modèle en service")

reset()
behavior["lab/a"] = 429
r = ask()
assert r.status_code == 200 and tried() == ["lab/a", "lab/b"] and r.json()["model"] == "lab/b", tried()
calls.clear()
assert ask().status_code == 200 and tried() == ["lab/b"], tried()
assert modes._cooling[("openrouter", "lab/a")] - time.time() <= 120, "le délai du fournisseur est respecté"
print("2. 429 : le suivant prend le relais, et l'épuisé n'est plus essayé pendant son délai")

reset()
behavior["lab/a"], behavior["lab/b"] = 503, 402
assert ask().status_code == 200 and tried() == ["lab/a", "lab/b", "lab/c"], tried()
reset()
behavior["lab/a"] = lambda body: httpx.Response(200, json={"error": {"message": "fournisseur tombé", "code": 502}})
r = ask()
assert tried() == ["lab/a", "lab/b"] and r.json()["model"] == "lab/b", tried()
print("3. 503, crédit épuisé chez le fournisseur, erreur annoncée dans un 200 : au suivant")


def boom(body):
    raise httpx.ConnectError("injoignable")


reset()
behavior["lab/a"] = boom
assert ask().status_code == 200 and tried() == ["lab/a", "lab/b"], tried()
reset()
behavior["lab/a"], behavior["lab/b"], behavior["lab/c"] = 429, 429, 429
r = ask()
assert r.status_code == 429 and len(tried()) == 3, (r.status_code, tried())
print("4. injoignable : au suivant ; tous épuisés : la dernière réponse revient, rien n'est inventé")

reset()
behavior["lab/a"] = 400
r = ask()
assert r.status_code == 400 and tried() == ["lab/a"], tried()
reset()
behavior["lab/a"] = 401
r = ask()
assert r.status_code == 401 and tried() == ["lab/a"], tried()
print("5. demande mal formée, clé refusée : pas de bascule, la vraie raison remonte")

reset()
db.set_setting("budget_monthly", "0")
r = ask()
assert r.status_code == 402 and calls == [] and r.json()["error"]["type"] == "budget_exceeded", r.text
r = ask(stream=True)
assert r.status_code == 402 and calls == [], r.text
db.set_setting("budget_monthly", "")
print("6. budget de Noah atteint : refus, aucun appel, aucun autre modèle tenté")

reset()
behavior["lab/a"] = 429
with agent.stream("POST", "/relay/v1/chat/completions", json={"model": "x", "stream": True, "messages": [{"role": "user", "content": "b"}]}) as r:
    assert r.status_code == 200
    text = b"".join(r.iter_bytes()).decode()
assert tried() == ["lab/a", "lab/b"] and "lab/b" in text and "[DONE]" in text, (tried(), text)
print("7. en flux : bascule tant que rien n'est parti")

reset()
behavior["lab/a"] = lambda body: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse("lab/a", then_fail=True))
try:
    with agent.stream("POST", "/relay/v1/chat/completions", json={"model": "x", "stream": True, "messages": [{"role": "user", "content": "b"}]}) as r:
        got = b""
        for chunk in r.iter_bytes():
            got += chunk
except Exception:  # noqa: BLE001 - la coupure remonte à Hermes, qui sait reprendre
    pass
assert tried() == ["lab/a"], tried()
print("8. en flux commencé : plus de bascule, un autre modèle ne continuerait pas la phrase")

reset()
behavior["lab/a"] = 429
assert ask().status_code == 200 and modes._cooling
modes._cooling[("openrouter", "lab/a")] = time.time() - 1
behavior.clear()
calls.clear()
assert ask().status_code == 200 and tried() == ["lab/a"], tried()
print("9. l'épuisé est remis en jeu après son délai")

# --- Gratuit ------------------------------------------------------------------------------------------------------------

reset()
listing = [{**x, "fournisseur": "openrouter"} for x in LISTED]
order = [x["id"] for x in modes.free_order(listing)]
assert order[:2] == ["lab/gratuit-2:free", "lab/gratuit-1:free"], order
assert "openrouter/free" not in order and "lab/image-seule" not in order and "lab/petit-contexte:free" not in order, order
assert order.index("anthropic/claude-haiku") < order.index("lab/c") < order.index("lab/b") < order.index("lab/a") < order.index("lab/sans-prix"), order
print("10. Gratuit : les gratuits, puis du moins cher au plus cher, les prix inconnus en dernier ; ni routeur, ni image, ni petit contexte")

r = web.put("/api/modes/cerveau", json={"actif": "gratuit"})
assert r.status_code == 200 and r.json()["actif"] == "gratuit" and r.json()["gratuit"][0]["modele"] == "lab/gratuit-2:free", r.text
real_rotation = modes.rotation
modes.rotation = lambda: 0
assert ask().status_code == 200 and tried() == ["lab/gratuit-2:free"], tried()
calls.clear()
modes.rotation = lambda: 1
assert ask().status_code == 200 and tried() == ["lab/gratuit-1:free"], tried()
modes.rotation = lambda: 0
calls.clear()
behavior["lab/gratuit-2:free"] = 429
assert ask().status_code == 200 and tried() == ["lab/gratuit-2:free", "lab/gratuit-1:free"], tried()
modes.rotation = real_rotation
print("11. les gratuits alternent ; l'épuisé passe la main")

# --- Réglages, propriétaire -------------------------------------------------------------------------------------------

reset()
before = db.get_setting("modes")
for body in ({"actif": "fast"}, {"mode": "fast", "modele": "lab/a"}, {"chaine": [{"modele": "lab/a"}]}):
    assert other.put("/api/modes/cerveau", json=body).status_code == 403, body
assert db.get_setting("modes") == before and modes.active("cerveau") == "gratuit"
assert other.get("/api/modes/image").status_code == 403 and other.get("/api/modes/cerveau").status_code == 200
print("12. un profil invité lit le cerveau, et ne change rien")

assert web.put("/api/modes/cerveau", json={"chaine": [{"modele": "lab/invente"}]}).status_code == 400
assert web.put("/api/modes/cerveau", json={"mode": "fast", "modele": "lab/invente"}).status_code == 400
assert web.put("/api/modes/cerveau", json={"actif": "n-importe-quoi"}).status_code == 400
assert web.put("/api/modes/autre", json={"actif": "fast"}).status_code == 404
print("13. un modèle hors des clés de la personne est refusé")

r = web.put("/api/modes/cerveau", json={"mode": "fast", "modele": "lab/c", "actif": "fast"})
assert r.status_code == 200 and db.get_setting("model") == "lab/c" and r.json()["actif"] == "fast", r.text
row = next(x for x in r.json()["modes"] if x["id"] == "fast")
assert row["personnalise"] and row["modele"]["modele"] == "lab/c", row
r = web.put("/api/modes/cerveau", json={"mode": "fast", "modele": "lab/b"})
assert db.get_setting("model") == "lab/b", "changer le mode en service change le cerveau"
assert ask().status_code == 200 and tried() == ["lab/b"], tried()
print("14. la personne choisit le modèle d'un mode : pris en compte tout de suite")

r = web.post("/api/model", json={"provider": "openrouter", "model": "lab/a"})
assert r.status_code == 200 and modes.active("cerveau") is None, r.text
print("15. un modèle précis choisi ailleurs quitte le mode, sans autre geste")

reset()
db.set_setting("media_api_key", SECRET, secret=True)
MEDIA = [{"id": "x/image-chere", "name": "C", "cost": {"value": 0.3, "label": "30 c"}, "quality": 5, "speed": 2, "strengths": ["photo"]},
         {"id": "x/image-rapide", "name": "R", "cost": {"value": 0.05, "label": "5 c"}, "quality": 3, "speed": 5, "strengths": ["vite"]},
         {"id": "x/image-gratuite", "name": "G", "cost": {"value": 0, "label": "gratuit"}, "quality": 2, "speed": 3, "strengths": []}]


async def media_models(kind):
    return MEDIA if kind == "image" else []


media.models = media_models
state = web.get("/api/modes/image").json()
rows = {x["id"]: x["modele"]["modele"] for x in state["modes"]}
assert rows == {"fast": "x/image-rapide", "balanced": "x/image-rapide", "smart": "x/image-chere"}, rows
assert state["gratuit"][0]["modele"] == "x/image-gratuite", state["gratuit"]
assert web.put("/api/modes/image", json={"actif": "gratuit"}).status_code == 200 and media.setting("image") == "x/image-gratuite"

done = []


async def fake_image(agent_id, prompt, aspect, model, beyond):
    done.append(model)
    if model == "x/image-gratuite":
        raise media.MediaError("saturé", temporary=True)
    return b"png", "png", model


media._image = fake_image
got = asyncio.run(media.image("a1", "un chat"))
assert got[2] == "x/image-rapide" and done == ["x/image-gratuite", "x/image-rapide"], done
done.clear()
try:
    asyncio.run(media.image("a1", "un chat", model="x/image-gratuite"))
except media.MediaError:
    pass
assert done == ["x/image-gratuite"], "un modèle demandé précisément reste seul"
print("16. création : mêmes modes, et le suivant prend le relais pour une image")

# --- Par agent -----------------------------------------------------------------------------------------------------------

reset()
db.set_setting("model", "lab/cerveau")
assert other.put("/api/agents/a1/model", json={"mode": "gratuit"}).status_code in (403, 404)
assert db.get_setting("model_mode_a1") is None
r = web.put("/api/agents/a1/model", json={"mode": "gratuit", "raisonnement": "high"})
assert r.status_code == 200 and r.json()["mode"] == "gratuit" and r.json()["raisonnement"] == "high", r.text
modes.rotation = lambda: 0
assert ask().status_code == 200 and tried() == ["lab/gratuit-2:free"] and calls[-1]["body"]["reasoning"] == {"effort": "high"}, calls[-1]
calls.clear()
assert ask(agent2).status_code == 200 and tried() == ["lab/cerveau"] and "reasoning" not in calls[-1]["body"], calls[-1]
print("17. par agent : son mode et son raisonnement, sans toucher aux autres ; il faut le droit d'administrer")

calls.clear()
r = web.put("/api/agents/a1/model", json={"raisonnement": "low"})
assert r.json()["mode"] == "gratuit" and modes.reasoning("a1") == "low", r.text
r = web.put("/api/agents/a1/model", json={"model": None})
assert r.json()["mode"] is None and r.json()["model"] is None, r.text
assert ask().status_code == 200 and tried() == ["lab/cerveau"], tried()
web.put("/api/agents/a1/model", json={"raisonnement": None})
assert modes.reasoning("a1") is None
modes.rotation = real_rotation
print("18. changer le raisonnement ne touche pas au mode ; « celui de tous » revient à l'héritage")

# --- Auto par défaut, hérité sans écraser les choix individuels -------------------------------------------------------------

from noah import complexite, providers  # noqa: E402

saved_modes = db.get_setting("modes")
real_tier_for = complexite.tier_for
real_decision_model = decision.model
selected_tier = {"value": "fast"}


async def selected_complexity(agent_id, body):
    return selected_tier["value"]


complexite.tier_for = selected_complexity
decision.model = lambda: "lab/c"  # le petit modèle ne doit pas devenir le nom inscrit du cerveau Auto
for tier, model in (("fast", "lab/c"), ("balanced", "lab/a"), ("smart", "lab/cerveau")):
    assert web.put("/api/modes/cerveau", json={"mode": tier, "modele": model}).status_code == 200
assert other.put("/api/modes/cerveau", json={"actif": "auto"}).status_code == 403
r = web.put("/api/modes/cerveau", json={"actif": "auto"})
assert r.status_code == 200 and r.json()["actif"] == "auto", r.text
assert web.get("/api/modes/cerveau").json()["actif"] == "auto", "Auto doit persister à la relecture"
assert db.get_setting("model") == "lab/a", "ne pas confondre cerveau et petit modèle de décision"
for tier, model in (("fast", "lab/c"), ("balanced", "lab/a"), ("smart", "lab/cerveau")):
    selected_tier["value"] = tier
    reset()
    assert ask().status_code == 200 and tried() == [model], (tier, tried())
    reset()
    assert ask(agent2).status_code == 200 and tried() == [model], (tier, tried())
reset()
behavior["lab/cerveau"] = 429
assert ask().status_code == 200 and tried() == ["lab/cerveau", "lab/a"], tried()
reset()
assert web.put("/api/agents/a2/model", json={"model": "lab/a"}).json()["model"] == "lab/a"
assert ask(agent2).status_code == 200 and tried() == ["lab/a"], "un modèle précis égal au modèle global quitte quand même Auto"
assert web.put("/api/agents/a2/model", json={"mode": "fast"}).status_code == 200
reset()
assert ask(agent2).status_code == 200 and tried() == ["lab/c"], "le mode individuel prime sur Auto global"
assert web.put("/api/agents/a2/model", json={"model": None}).status_code == 200
reset()
assert ask(agent2).status_code == 200 and tried() == ["lab/cerveau"], "retour à l'héritage Auto"
reset()
assert ask(model="lab/c").status_code == 200 and tried() == ["lab/c"], "les petits travaux gardent leur modèle"
r = web.put("/api/modes/cerveau", json={"mode": "smart", "modele": "lab/b"})
assert r.status_code == 200 and r.json()["actif"] == "auto", "changer un niveau conserve Auto global"
reset()
assert ask().status_code == 200 and tried() == ["lab/b"], "le niveau modifié est pris en compte dès l'appel suivant"
assert web.put("/api/modes/image", json={"actif": "auto"}).status_code == 400, "Auto du cerveau ne change pas les modes média"
same_model = db.get_setting("model")
assert web.post("/api/model", json={"provider": "openrouter", "model": same_model}).status_code == 200
assert web.get("/api/modes/cerveau").json()["actif"] is None, "le choix précis quitte Auto même à modèle identique"
complexite.tier_for, decision.model = real_tier_for, real_decision_model
db.set_setting("modes", saved_modes or "{}")
db.set_setting("model", "lab/cerveau")
print("18b. Auto global persiste : trois niveaux, secours, héritage, priorité individuelle et choix précis identique")

# Le modèle précis peut venir de tout fournisseur déjà branché ; sa clé ne part jamais vers une autre adresse.
providers.remember("custom", "cle-locale-enregistree", "http://local:8000/v1")
r = web.post("/api/model", json={"provider": "custom", "model": "local-1"})
assert r.status_code == 200 and main.current_model()["api_key"] == "cle-locale-enregistree", r.text
assert main.current_model()["base_url"] == "http://local:8000/v1"
r = web.post("/api/model", json={"provider": "custom", "model": "local-2", "base_url": "http://autre:8000/v1"})
assert r.status_code == 200 and main.current_model()["api_key"] is None, "la clé enregistrée ne suit pas une autre adresse"
assert web.post("/api/model", json={"provider": "openrouter", "model": "lab/cerveau"}).status_code == 200
with db.connect() as c:
    for key in ("provider_key:custom", "provider_base:custom", "provider_connected:custom"):
        c.execute("DELETE FROM settings WHERE key = ?", (key,))
print("18c. modèle précis d'un fournisseur branché : adresse et clé réutilisées, jamais vers une autre adresse")

# --- Par routine ----------------------------------------------------------------------------------------------------------

reset()
jobs: dict[str, dict] = {}
admin_calls: list[tuple] = []


async def fake_admin(agent_id, action, body=None, timeout=90):
    admin_calls.append((agent_id, action, body))
    if action == "routine_creer":
        job = {"id": f"r{len(jobs) + 1}", "name": body["nom"], "prompt": body["consigne"], "model": body.get("model"), "enabled_toolsets": body.get("enabled_toolsets")}
        jobs[job["id"]] = job
        return job
    if action == "routines":
        return {"routines": list(jobs.values())}
    if action == "routine_action":
        job = jobs[body["id"]]
        if "consigne" in body:
            job["prompt"] = body["consigne"]
        for field in ("model", "enabled_toolsets"):
            if field in body:
                job[field] = body[field]
        return job
    return {}


machine.admin = fake_admin
NEW = {"nom": "Matin", "consigne": "Résume", "quand": "every day at 8am"}
assert web.post("/api/agents/a1/routines", json={**NEW, "modele": "lab/invente"}).status_code == 400
assert web.post("/api/agents/a1/routines", json={**NEW, "outils": ["pirate"]}).status_code == 400
assert web.post("/api/agents/a1/routines", json={**NEW, "image": "x/inconnue"}).status_code == 400
assert agent.post("/agent-api/routines", json={**NEW, "modele": "lab/invente"}).status_code == 400
assert admin_calls == [], "un refus part avant Hermes"
print("19. routine : modèle hors des clés, outil inconnu, image inconnue : refusés, à l'écran comme par l'agent")

r = web.post("/api/agents/a1/routines", json={**NEW, "modele": "lab/c", "outils": ["internet", "commandes"], "image": "x/image-rapide"})
assert r.status_code == 200, r.text
shown = r.json()
assert shown["modele"] == "lab/c" and shown["outils"] == ["internet", "commandes"] and shown["image"] == "x/image-rapide" and shown["prompt"] == "Résume", shown
job = jobs[shown["id"]]
assert job["model"].startswith(modes.ROUTINE_PREFIX) and "--modele x/image-rapide" in job["prompt"], job
assert set(job["enabled_toolsets"]) == {"web", "search", "terminal", "code_execution"}, job
assert ask(model=job["model"]).status_code == 200 and tried() == ["lab/c"], tried()
print("20. routine : son modèle (par un jeton du relais), ses outils, son modèle d'image, que l'agent lit dans sa consigne")

calls.clear()
assert ask(model="anthropic/claude-sonnet").status_code == 200 and tried() == ["lab/cerveau"], "un nom écrit par l'agent n'est pas suivi"
calls.clear()
assert ask(model=modes.ROUTINE_PREFIX + "inventé/lab/a").status_code == 200 and tried() == ["lab/cerveau"], tried()
calls.clear()
assert ask(agent2, model=job["model"]).status_code == 200 and tried() == ["lab/cerveau"], "le jeton d'un autre agent ne vaut rien"
calls.clear()
db.set_setting("budget_monthly", "0")
assert ask(model=job["model"]).status_code == 402 and calls == []
db.set_setting("budget_monthly", "")
print("21. seul un jeton de cet agent ouvre un autre modèle, et le budget passe avant")

r = agent.post(f"/agent-api/routines/{shown['id']}/regler", json={"modele": "gratuit"})
assert r.status_code == 200 and r.json()["modele"] == "gratuit", r.text
modes.rotation = lambda: 0
calls.clear()
assert ask(model=jobs[shown["id"]]["model"]).status_code == 200 and tried() == ["lab/gratuit-2:free"], tried()
modes.rotation = real_rotation
r = web.post(f"/api/agents/a1/routines/{shown['id']}/modifier", json={"modele": "", "outils": ["tous"], "image": ""})
assert r.status_code == 200 and r.json()["modele"] is None and r.json()["outils"] is None and r.json()["image"] is None and r.json()["prompt"] == "Résume", r.text
assert other.post(f"/api/agents/a1/routines/{shown['id']}/modifier", json={"modele": "lab/c"}).status_code in (403, 404)
source = open("/app/noah/hermes.py", encoding="utf-8").read()
assert '["routine-regler"]' in source and "routine_choices" in source
print("22. l'agent le règle à la demande (donc à la voix), l'écran revient au réglage de l'agent ; un invité ne touche à rien")

# --- Vrais modèles de décision ------------------------------------------------------------------------------------------------

reset()
TYPED = [{"id": "typesafe/jev-1.14", "name": "Jev 1.14", "created": 9, "context": 262144, "price_in": 0.042},
         {"id": "typesafe/jev-1.13", "name": "Jev 1.13", "created": 5, "context": 262144, "price_in": 0.042},
         {"id": "cloudflare/clef-flash", "name": "Clef Flash", "created": 8, "context": 24576, "price_in": 0.038},
         {"id": "cloudflare/clef", "name": "Clef", "created": 8, "context": 65537, "price_in": 0.192},
         {"id": "openai/gpt-6-luna-decisions", "name": "Luna", "created": 8, "context": 1050000, "price_in": 0.1},
         {"id": "autre/tres-bas", "name": "Inconnu", "created": 8, "context": 8000, "price_in": 0.001}]


async def typed_listed():
    return TYPED


catalog.decision_catalog = typed_listed
typed_calls: list[dict] = []


def decide_reply(body):
    typed_calls.append(body)
    assert "messages" not in body
    answers = {}
    for name, q in body["questions"].items():
        if q["type"] == "noul":
            answers[name] = {"type": "noul", "noul": 0.1 if "élément 1" in q["instructions"] or "nouveauté 1" in q["instructions"] else 0.9}
        else:
            first = next(iter(q["criteria"]))
            answers[name] = {"type": "choice", "choice": "temporaire" if name == "note_1" else first, "confidence": 0.9}
    return httpx.Response(200, json={"answers": answers, "model": body["model"], "usage": {"input_tokens": 100, "output_tokens": 5, "cost": 0.000004}})


def with_decisions(request: httpx.Request) -> httpx.Response:
    if "/alpha/decisions" in str(request.url) or "/v1/systemone" in str(request.url):
        body = json.loads(request.content)
        assert request.headers.get("authorization", "").startswith("Bearer "), "avec la clé"
        what = behavior.get("decisions")
        if isinstance(what, int):
            return httpx.Response(what, json={"error": {"message": SECRET}})
        typed_calls.append({"url": str(request.url)})
        return decide_reply(body)
    return upstream(request)


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(with_decisions))
db.set_setting(decision.KEY, "{}")
asyncio.run(decision.refresh())
shown = web.get("/api/decision").json()
assert shown["type"]["modele"] == "cloudflare/clef-flash" and shown["type"]["service"] == "openrouter" and shown["type"]["choisi_par"] == "auto", shown["type"]
tried_typed = {c["model"] for c in typed_calls if "model" in c}
assert "autre/tres-bas" not in tried_typed and "typesafe/jev-1.14" in tried_typed and "typesafe/jev-1.13" not in tried_typed and "cloudflare/clef" not in tried_typed, tried_typed
print("23. par défaut : le moins cher des vrais modèles de référence qui réussit l'essai, avec la clé OpenRouter déjà là")

ids = [o["modele"] for o in shown["decisions"]]
assert "lab/a" not in ids and "anthropic/claude-sonnet" not in ids and "typesafe/jev-1.14" in ids and "cloudflare/clef" in ids, ids
small = [o["modele"] for o in shown["petits"]]
assert "anthropic/claude-haiku" in small and "anthropic/claude-sonnet" not in small, small
assert SECRET not in json.dumps(shown) and shown["cles"]["openrouter"] is True, "une clé dans ce que lit l'écran"
print("24. la liste : les vrais modèles de décision, les petits modèles à part, aucun modèle général mêlé, aucune clé")

r = web.post("/api/decision", json={"modele": "openrouter:typesafe/jev-1.14"})
assert r.status_code == 200 and r.json()["type"]["modele"] == "typesafe/jev-1.14" and r.json()["type"]["choisi_par"] == "toi", r.text
assert other.post("/api/decision", json={"modele": "auto"}).status_code == 403
assert web.post("/api/decision", json={"modele": "typesafe:jev-latest"}).status_code == 400, "sans sa clé"
asyncio.run(decision.refresh())
assert decision.typed_model()["modele"] == "typesafe/jev-1.14", "un choix de la personne reste le sien"
print("25. la personne choisit Jev : il reste, et il faut une clé pour le service direct")

behavior["anthropic/claude-haiku"] = lambda body: httpx.Response(200, json=ok_body("anthropic/claude-haiku", json.dumps({"pertinent": True, "retenues": [2]})))
r = web.post("/api/decision", json={"modele": "anthropic/claude-haiku"})
assert r.status_code == 200 and r.json()["type"] is None and r.json()["modele"] == "anthropic/claude-haiku" and r.json()["aucun"], r.text
assert asyncio.run(decision.decide("a1", "s", {"q": decision.yes_no("x")})) is None
print("26. un petit modèle choisi : c'est lui qui décide, en JSON")
web.post("/api/decision", json={"modele": "openrouter:typesafe/jev-1.14"})

real_get = httpx.AsyncClient.get


async def typesafe_models(self, url, **kw):
    assert "api.typesafe.ai" in str(url)
    return httpx.Response(401 if "mauvaise" in kw["headers"]["Authorization"] else 200, json={"models": [{"name": "jev-latest", "description": "", "release_date": "2026-09-15"}]})


httpx.AsyncClient.get = typesafe_models
TYPESAFE = "ts-cle-secrete-a-ne-pas-montrer"
assert web.post("/api/decision/cle", json={"cle": "mauvaise"}).status_code == 400 and not db.get_setting(decision.TYPESAFE_KEY)
r = web.post("/api/decision/cle", json={"cle": TYPESAFE})
httpx.AsyncClient.get = real_get
assert r.status_code == 200 and TYPESAFE not in r.text and r.json()["cles"]["typesafe"] is True, r.text
assert TYPESAFE not in (db.get_setting(decision.TYPESAFE_KEY) or ""), "chiffrée en base"
assert other.post("/api/decision/cle", json={"cle": "x"}).status_code == 403
assert any(o["id"] == "typesafe:jev-latest" for o in r.json()["decisions"]), r.json()["decisions"]
print("27. clé TypeSafe : vérifiée, chiffrée, jamais renvoyée, réservée au propriétaire")

reset()
typed_calls.clear()
decided = asyncio.run(decision.decide("a1", {"texte": "x"}, {"q": decision.yes_no("x ?")}))
assert decided.answers["q"]["noul"] == 0.9 and decided.cost == 0.000004 and calls == [], decided
behavior["decisions"] = 503
assert asyncio.run(decision.decide("a1", {"texte": "x"}, {"q": decision.yes_no("x ?")})) is None
del behavior["decisions"]
print("28. décision typée comptée ; en panne, l'appelant retombe sur le petit modèle")

ITEMS = [{"titre": "Promotion", "texte": "-20 %", "lien": "https://x/1"}, {"titre": "Facture", "texte": "Paul", "lien": "https://x/2"}]
db.set_setting("model", "lab/cerveau")


async def no_prefs(agent_id, w):
    return ""


watch._preferences = no_prefs
WATCH = {"criteria": "un courriel de Paul", "name": "Boîte", "url": "gmail", "instruction": ""}


def asked_all_no(body):
    return httpx.Response(200, json={"answers": {name: {"type": "noul", "noul": 0.1} for name in body["questions"]}, "usage": {"input_tokens": 10, "output_tokens": 1, "cost": 0.0000004}})


calls.clear()
real_decide = decide_reply
decide_reply = asked_all_no
out = asyncio.run(watch.triage("a1", WATCH, ITEMS))
decide_reply = real_decide
assert out["pertinent"] is False and calls == [] and out["cout"] > 0, (out, calls)
print("29. veille : rien de pertinent, le modèle de décision suffit, aucun résumé payé")

calls.clear()
behavior["anthropic/claude-haiku"] = lambda body: httpx.Response(200, json=ok_body("anthropic/claude-haiku", json.dumps({"pertinent": True, "resume": "Paul réclame sa facture.", "retenues": [2]})))
out = asyncio.run(watch.triage("a1", WATCH, ITEMS))
assert out["pertinent"] and out["resume"].startswith("Paul") and len(calls) == 1, (out, calls)
assert "Promotion" not in json.dumps(calls[0]["body"]["messages"]), "seul ce qui a été retenu est résumé"
print("30. veille : le petit modèle ne résume que ce qui a été retenu")

reset()
r = agent.post("/agent-api/memoire/juger", json={"cible": "user", "notes": ["en train de corriger un bug", "il préfère le tutoiement"]})
assert r.status_code == 200 and [x["i"] for x in r.json()["refus"]] == [0] and calls == [], (r.text, calls)
print("31. mémoire : jugée en questions fermées, le doute profite à la note")

reset()
routed = []


def thinking_router(request: httpx.Request) -> httpx.Response:
    routed.append(json.loads(request.content))
    return httpx.Response(200, json={"choices": [{"message": {"content": None, "reasoning": "je réfléchis"}}], "usage": {"cost": 0.001}})


async def voice():
    return "openai/gpt-oss-120b"


real_client = httpx.AsyncClient
media.voice_model = voice
typed_state = db.get_setting(decision.TYPED_KEY)
db.set_setting(decision.TYPED_KEY, "{}")
media.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(thinking_router), **kw)
from noah import diagnostics  # noqa: E402

noted = []
real_record = diagnostics.record
diagnostics.record = lambda *a, **k: noted.append(a)
got = asyncio.run(media.route("image", "un chat"))
media.httpx.AsyncClient = real_client
diagnostics.record = real_record
db.set_setting(decision.TYPED_KEY, typed_state)
assert got["methode"] == "generation" and got["modele"] and not [n for n in noted if "NoneType" in str(n)], (got, noted)
assert routed[0]["reasoning"] == {"effort": "low", "exclude": True} and routed[0]["max_tokens"] == 600, routed[0]
print("32. routeur de médias : un modèle à raisonnement réfléchit peu, et une réponse vide n'est plus une erreur")

# --- La liste complète de la recherche : toutes les clés branchées, pas seulement le cerveau ----------------------------

reset()
real_usable, real_models_of = modes.usable_providers, modes._models_of
async def two_keys():
    return ["openrouter", "anthropic"]
async def per_provider(provider):
    if provider == "openrouter":
        return [m("lab/cerveau", 3, 15), m("anthropic/claude-sonnet", 3, 15), m("lab/gratuit:free", 0, 0, True)]
    return [m("claude-sonnet-4-5", 3, 15), m("claude-haiku-4", 0.1, 0.5), m("claude-sonnet-4-5")] if provider == "anthropic" else []
modes.usable_providers = lambda: ["openrouter", "anthropic"]
modes._models_of = per_provider
shown = web.get("/api/modes/cerveau/modeles").json()
assert [x["fournisseur"] for x in shown["modeles"]].count("openrouter") == 3, shown
assert [x["fournisseur"] for x in shown["modeles"]].count("anthropic") == 3, shown
assert len(shown["modeles"]) == 6, shown  # le même identifiant chez deux fournisseurs reste deux rangées
assert shown["fournisseurs"] == [{"id": "anthropic", "label": "Anthropic (Claude)"}, {"id": "openrouter", "label": "OpenRouter"}], shown["fournisseurs"]
modes.usable_providers = real_usable
modes._models_of = real_models_of
db.set_setting("provider_connected:custom", "1")  # branché mais injoignable ici : la liste de l'autre ne meurt pas pour lui
modes._listed.clear()
modes.usable_providers = lambda: ["openrouter", "anthropic", "custom"]
async def broken(provider):
    if provider == "custom":
        raise RuntimeError("panne")
    return await per_provider(provider)
modes._models_of = broken
shown = web.get("/api/modes/cerveau/modeles").json()
assert [b["id"] for b in shown["fournisseurs"]] == ["anthropic", "openrouter"], shown["fournisseurs"]
assert len(shown["modeles"]) == 6, "une clé en panne n'enlève pas les autres"
modes.usable_providers, modes._models_of = real_usable, real_models_of
modes._listed.clear()
print("33. la recherche voit toutes les clés branchées, chaque fournisseur avec son nom ; une clé en panne cache ses modèles seuls")

print("Tout est tenu.")
