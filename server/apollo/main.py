import asyncio
import json
import re
import secrets
import uuid

from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, db, events, hermes
from .config import WEB_DIR
from .hermes import Agent

app = FastAPI(title="Apollo")

# Agents en cours de création : id -> message d'étape ou d'erreur affiché dans l'interface.
provisioning: dict[str, str] = {}


@app.on_event("startup")
def startup() -> None:
    db.init()


# --- État, compte, connexion -------------------------------------------------------

@app.get("/api/status")
def status():
    return {"has_account": auth.has_users(), "model_configured": db.get_setting("provider") is not None}


class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=8, max_length=256)


def _login_response(response: Response, user_id: int) -> dict:
    token = auth.new_session(user_id)
    response.set_cookie(auth.COOKIE, token, httponly=True, samesite="lax", max_age=30 * 86400)
    # Le jeton est aussi rendu pour les apps mobile et desktop, qui l'envoient en Bearer.
    return {"token": token}


@app.post("/api/setup/account")
def setup_account(body: Credentials, response: Response):
    if auth.has_users():
        raise HTTPException(409, "Le compte administrateur existe déjà")
    return _login_response(response, auth.create_user(body.username, body.password))


@app.post("/api/login")
def login(body: Credentials, response: Response):
    user_id = auth.check_password(body.username, body.password)
    if user_id is None:
        raise HTTPException(401, "Nom d'utilisateur ou mot de passe incorrect")
    return _login_response(response, user_id)


@app.post("/api/logout")
def logout(response: Response, apollo_session: str | None = Cookie(None)):
    if apollo_session:
        auth.drop_session(apollo_session)
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user: int = Depends(auth.current_user)):
    with db.connect() as c:
        row = c.execute("SELECT username FROM users WHERE id = ?", (user,)).fetchone()
    return {"id": user, "username": row["username"]}


# --- Modèle (partagé par tous les agents) ----------------------------------------------

@app.get("/api/providers")
def providers():
    return [
        {"id": k, "label": v["label"], "needs_key": v["env"] is not None, "default_model": v["model"]}
        for k, v in hermes.PROVIDERS.items()
    ]


class ModelChoice(BaseModel):
    provider: str
    api_key: str | None = None
    model: str | None = None
    base_url: str | None = None


def current_model() -> dict | None:
    provider = db.get_setting("provider")
    if not provider:
        return None
    return {
        "provider": provider,
        "model": db.get_setting("model"),
        "base_url": db.get_setting("base_url") or None,
        "api_key": db.get_setting("api_key", secret=True) if db.get_setting("api_key") else None,
    }


@app.get("/api/model")
def get_model(user: int = Depends(auth.current_user)):
    m = current_model()
    return {"provider": m["provider"], "model": m["model"], "has_key": bool(m["api_key"])} if m else None


@app.post("/api/model")
async def set_model(body: ModelChoice, user: int = Depends(auth.current_user)):
    p = hermes.PROVIDERS.get(body.provider)
    if not p:
        raise HTTPException(400, "Fournisseur inconnu")
    previous = current_model()
    # Garder la clé déjà enregistrée si on ne change que le modèle.
    api_key = body.api_key or (previous["api_key"] if previous and previous["provider"] == body.provider else None)
    if p["env"] and not api_key:
        raise HTTPException(400, "Cette option demande une clé API")
    db.set_setting("provider", body.provider)
    db.set_setting("model", body.model or p["model"])
    db.set_setting("base_url", body.base_url or "")
    if api_key:
        db.set_setting("api_key", api_key, secret=True)

    agents = _agents()
    if not agents:
        await _start_agent("Assistant", "Tu es l'assistant personnel de l'utilisateur. Réponds en français, de façon brève et concrète.")
    else:
        model = current_model()
        await asyncio.gather(*(hermes.configure(a["id"], model) for a in agents), return_exceptions=True)
    return {"ok": True}


# --- Agents ------------------------------------------------------------------------------

def _agents() -> list[dict]:
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT id, name, role, api_key FROM agents ORDER BY created_at")]


def _agent(agent_id: str) -> Agent:
    with db.connect() as c:
        row = c.execute("SELECT id, api_key FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Agent introuvable")
    return Agent(row["id"], row["api_key"])


def _soul(name: str, role: str) -> str:
    """Identité donnée à l'agent : il se présente sous son nom, pas comme le moteur qui le fait tourner."""
    intro = (
        f"Tu t'appelles {name}. Tu es un agent personnel qui travaille pour l'utilisateur dans Apollo. "
        "Présente-toi sous ce nom ; ne parle du logiciel ou du modèle qui te fait fonctionner que si on te le demande."
    )
    return f"{intro}\n\n{role}" if role else intro


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:20] or "agent"
    return f"{base}-{secrets.token_hex(2)}"


async def _start_agent(name: str, role: str) -> str:
    agent_id = _slug(name)
    provisioning[agent_id] = "Création de la machine…"
    api_key = await hermes.create_container(agent_id)
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key) VALUES (?, ?, ?, ?)", (agent_id, name, role, api_key))
    asyncio.create_task(_provision(Agent(agent_id, api_key), _soul(name, role)))
    return agent_id


async def _wait_online(agent: Agent, seconds: int = 180) -> bool:
    for _ in range(seconds // 2):
        if await hermes.health(agent):
            return True
        await asyncio.sleep(2)
    return False


async def _provision(agent: Agent, soul: str) -> None:
    """Attend le premier démarrage d'Hermes (qui crée ses fichiers), puis applique modèle et identité."""
    try:
        provisioning[agent.id] = "Premier démarrage de l'agent…"
        if not await _wait_online(agent):
            provisioning[agent.id] = "L'agent n'a pas démarré. Supprime-le et réessaie."
            return
        provisioning[agent.id] = "Configuration du modèle…"
        await hermes.configure(agent.id, current_model(), soul)
        await asyncio.sleep(3)
        if await _wait_online(agent):
            provisioning.pop(agent.id, None)
        else:
            provisioning[agent.id] = "L'agent n'a pas redémarré après la configuration."
    except Exception as e:
        provisioning[agent.id] = f"Erreur pendant la création : {e}"


@app.get("/api/agents")
async def list_agents(user: int = Depends(auth.current_user)):
    agents = _agents()
    online = await asyncio.gather(*(hermes.health(Agent(a["id"], a["api_key"])) for a in agents))
    return [
        {
            "id": a["id"],
            "name": a["name"],
            "role": a["role"],
            "online": ok and a["id"] not in provisioning,
            "step": provisioning.get(a["id"]),
        }
        for a, ok in zip(agents, online)
    ]


class AgentBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    role: str = Field(default="", max_length=4000)


@app.post("/api/agents")
async def create_agent(body: AgentBody, user: int = Depends(auth.current_user)):
    if not current_model():
        raise HTTPException(400, "Choisis d'abord un modèle")
    return {"id": await _start_agent(body.name.strip(), body.role)}


@app.patch("/api/agents/{agent_id}")
async def update_agent(agent_id: str, body: AgentBody, user: int = Depends(auth.current_user)):
    agent = _agent(agent_id)
    with db.connect() as c:
        c.execute("UPDATE agents SET name = ?, role = ? WHERE id = ?", (body.name.strip(), body.role, agent_id))
    provisioning[agent.id] = "Application du nouveau rôle…"
    asyncio.create_task(_provision(agent, _soul(body.name.strip(), body.role)))
    return {"ok": True}


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str, user: int = Depends(auth.current_user)):
    _agent(agent_id)
    try:
        await hermes.delete_container(agent_id)
    except Exception:
        pass  # conteneur déjà absent : on nettoie quand même la base
    with db.connect() as c:
        c.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    provisioning.pop(agent_id, None)
    return {"ok": True}


# --- Conversations ----------------------------------------------------------------------

@app.get("/api/agents/{agent_id}/conversations")
def conversations(agent_id: str, user: int = Depends(auth.current_user)):
    with db.connect() as c:
        rows = c.execute(
            "SELECT id, title, updated_at FROM conversations WHERE user_id = ? AND agent_id = ? "
            "ORDER BY updated_at DESC LIMIT 50",
            (user, agent_id),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/conversations/{conv_id}/messages")
def messages(conv_id: str, user: int = Depends(auth.current_user)):
    with db.connect() as c:
        if not c.execute("SELECT 1 FROM conversations WHERE id = ? AND user_id = ?", (conv_id, user)).fetchone():
            raise HTTPException(404, "Conversation introuvable")
        rows = c.execute(
            "SELECT role, text, created_at FROM messages WHERE conversation_id = ? ORDER BY id", (conv_id,)
        ).fetchall()
    return [dict(r) for r in rows]


@app.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: str, user: int = Depends(auth.current_user)):
    with db.connect() as c:
        c.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", (conv_id, user))
    return {"ok": True}


def _save_message(conv_id: str, role: str, text: str) -> None:
    with db.connect() as c:
        c.execute("INSERT INTO messages (conversation_id, role, text) VALUES (?, ?, ?)", (conv_id, role, text))
        c.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (conv_id,))


class ChatMessage(BaseModel):
    agent_id: str
    text: str = Field(min_length=1, max_length=20000)
    conversation_id: str | None = None
    details: bool = False


@app.post("/api/chat")
async def chat(body: ChatMessage, user: int = Depends(auth.current_user)):
    agent = _agent(body.agent_id)
    conv_id = body.conversation_id
    with db.connect() as c:
        if conv_id and not c.execute(
            "SELECT 1 FROM conversations WHERE id = ? AND user_id = ? AND agent_id = ?", (conv_id, user, agent.id)
        ).fetchone():
            raise HTTPException(404, "Conversation introuvable")
        if not conv_id:
            conv_id = uuid.uuid4().hex
            c.execute(
                "INSERT INTO conversations (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)",
                (conv_id, user, agent.id, body.text[:60]),
            )
    _save_message(conv_id, "user", body.text)

    try:
        run_id = await hermes.start_run(agent, body.text, session_id=f"apollo-{conv_id}")
    except Exception:
        raise HTTPException(503, "L'agent ne répond pas. Il démarre peut-être encore : réessaie dans un instant.")

    async def stream():
        yield _sse({"type": "start", "conversation_id": conv_id, "run_id": run_id})
        reply: list[str] = []
        final: dict | None = None
        try:
            async for kind, data in hermes.run_events(agent, run_id):
                out = events.translate(kind, data, body.details)
                if not out:
                    continue
                if out["type"] == "message":
                    reply.append(out["text"])
                yield _sse(out)
                if out["type"] == "done":
                    final = out
                    break
        except Exception:
            final = {"type": "done", "status": "failed",
                     "error": "L'agent ne répond plus. Il redémarre peut-être : réessaie dans un instant."}
            yield _sse(final)
        text = "".join(reply).strip() or (final or {}).get("output") or ""
        if text:
            _save_message(conv_id, "agent", text)
        elif final and final.get("error"):
            _save_message(conv_id, "error", final["error"])

    return StreamingResponse(stream(), media_type="text/event-stream")


class ApprovalAnswer(BaseModel):
    request_id: str
    generation: int
    approve: bool


@app.post("/api/agents/{agent_id}/runs/{run_id}/approval")
async def approval(agent_id: str, run_id: str, body: ApprovalAnswer, user: int = Depends(auth.current_user)):
    await hermes.answer_approval(_agent(agent_id), run_id, body.request_id, body.generation, body.approve)
    return {"ok": True}


@app.post("/api/agents/{agent_id}/runs/{run_id}/stop")
async def stop(agent_id: str, run_id: str, user: int = Depends(auth.current_user)):
    await hermes.stop_run(_agent(agent_id), run_id)
    return {"ok": True}


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# --- Interface web -------------------------------------------------------------------------

if WEB_DIR.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIR), name="assets")

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/manifest.webmanifest")
    def manifest():
        return FileResponse(WEB_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js")
    def service_worker():
        # Servi à la racine pour couvrir toute l'application.
        return FileResponse(WEB_DIR / "sw.js", media_type="text/javascript")
