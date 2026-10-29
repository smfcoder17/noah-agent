import json
import uuid

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, db, events, hermes
from .config import WEB_DIR

app = FastAPI(title="Apollo")


@app.on_event("startup")
def startup() -> None:
    db.init()


# --- État et premier lancement -------------------------------------------------

@app.get("/api/status")
async def status():
    return {
        "has_account": auth.has_users(),
        "model_configured": db.get_setting("provider") is not None,
        "agent_online": await hermes.health(),
    }


@app.get("/api/providers")
def providers():
    return [
        {"id": k, "label": v["label"], "needs_key": v["env"] is not None, "default_model": v["model"]}
        for k, v in hermes.PROVIDERS.items()
    ]


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


class ModelChoice(BaseModel):
    provider: str
    api_key: str | None = None
    model: str | None = None
    base_url: str | None = None


@app.post("/api/setup/model")
async def setup_model(body: ModelChoice, user: int = Depends(auth.current_user)):
    p = hermes.PROVIDERS.get(body.provider)
    if not p:
        raise HTTPException(400, "Fournisseur inconnu")
    if p["env"] and not body.api_key:
        raise HTTPException(400, "Cette option demande une clé API")
    hermes.write_model_config(body.provider, body.api_key, body.model, body.base_url)
    db.set_setting("provider", body.provider)
    db.set_setting("model", body.model or p["model"])
    await hermes.restart_gateway()
    return {"ok": True}


# --- Conversations -------------------------------------------------------------

class ChatMessage(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    conversation_id: str | None = None
    details: bool = False


@app.get("/api/conversations")
def conversations(user: int = Depends(auth.current_user)):
    with db.connect() as c:
        rows = c.execute(
            "SELECT id, title, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC",
            (user,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/chat")
async def chat(body: ChatMessage, user: int = Depends(auth.current_user)):
    conv_id = body.conversation_id
    if not conv_id:
        conv_id = uuid.uuid4().hex
        with db.connect() as c:
            c.execute(
                "INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)",
                (conv_id, user, body.text[:60]),
            )
    run_id = await hermes.start_run(body.text, session_id=f"apollo-{conv_id}")

    async def stream():
        yield _sse({"type": "start", "conversation_id": conv_id, "run_id": run_id})
        try:
            async for kind, data in hermes.run_events(run_id):
                out = events.translate(kind, data, body.details)
                if out:
                    yield _sse(out)
                if out and out["type"] == "done":
                    return
        except Exception:  # la connexion à Hermes a coupé
            yield _sse({"type": "done", "status": "failed", "error": "L'agent ne répond plus. Il redémarre peut-être : réessaie dans un instant."})

    return StreamingResponse(stream(), media_type="text/event-stream")


class ApprovalAnswer(BaseModel):
    request_id: str
    generation: int
    approve: bool


@app.post("/api/runs/{run_id}/approval")
async def approval(run_id: str, body: ApprovalAnswer, user: int = Depends(auth.current_user)):
    await hermes.answer_approval(run_id, body.request_id, body.generation, body.approve)
    return {"ok": True}


@app.post("/api/runs/{run_id}/stop")
async def stop(run_id: str, user: int = Depends(auth.current_user)):
    await hermes.stop_run(run_id)
    return {"ok": True}


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# --- Interface web -------------------------------------------------------------

if WEB_DIR.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIR), name="assets")

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")
