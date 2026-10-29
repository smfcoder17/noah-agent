"""Relais de modèle : les agents appellent le serveur, jamais le fournisseur directement.

- La clé du fournisseur reste chiffrée dans le serveur ; chaque agent n'a qu'un jeton de relais.
- Chaque appel est mesuré (jetons, coût) et refusé quand le budget mensuel est atteint.
- Tous les fournisseurs passent par leur point d'accès compatible OpenAI.
"""
import hashlib
import hmac
import json

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import catalog, db
from .config import SECRET_KEY

router = APIRouter()

UPSTREAMS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "ollama": "http://host.docker.internal:11434/v1",
}
# URL que les agents utilisent, sur le réseau Docker interne.
RELAY_URL = "http://apollo-server:8080/relay/v1"


def token_for(agent_id: str) -> str:
    return hmac.new(SECRET_KEY.encode(), f"relay:{agent_id}".encode(), hashlib.sha256).hexdigest()


def _agent_from(request: Request) -> str:
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    with db.connect() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM agents")]
    for agent_id in ids:
        if hmac.compare_digest(token, token_for(agent_id)):
            return agent_id
    raise HTTPException(401, "Jeton de relais invalide")


def month_cost() -> float:
    with db.connect() as c:
        row = c.execute(
            "SELECT COALESCE(SUM(cost), 0) AS total FROM usage "
            "WHERE created_at >= strftime('%Y-%m-01', 'now')"
        ).fetchone()
    return float(row["total"])


def budget() -> float | None:
    value = db.get_setting("budget_monthly")
    return float(value) if value else None


async def _record(agent_id: str, model: str, usage: dict | None) -> None:
    if not usage:
        return
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    cost = usage.get("cost")
    if cost is None and db.get_setting("provider") != "ollama":
        price = (await catalog.price_index()).get(catalog._norm(model))
        if price:
            cost = (prompt * price["price_in"] + completion * price["price_out"]) / 1e6
    with db.connect() as c:
        c.execute(
            "INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost) VALUES (?, ?, ?, ?, ?)",
            (agent_id, model, prompt, completion, float(cost or 0)),
        )


def _upstream_headers(provider: str, api_key: str | None) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://github.com/apollo-agents"
        headers["X-Title"] = "Apollo"
    return headers


@router.api_route("/relay/v1/{path:path}", methods=["GET", "POST"])
async def relay(path: str, request: Request):
    agent_id = _agent_from(request)
    provider = db.get_setting("provider")
    if not provider:
        raise HTTPException(503, "Aucun modèle n'est configuré")
    api_key = db.get_setting("api_key", secret=True) if db.get_setting("api_key") else None
    url = f"{UPSTREAMS[provider]}/{path}"
    headers = _upstream_headers(provider, api_key)

    if request.method == "GET":
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(url, headers=headers, params=request.query_params)
        return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))

    limit = budget()
    if limit is not None and month_cost() >= limit:
        # Message lu par l'agent et remonté tel quel dans l'interface.
        return JSONResponse(
            {"error": {"message": f"Budget mensuel de {limit:.2f} $ atteint. Augmente-le dans Apollo pour continuer.",
                       "type": "budget_exceeded", "code": 402}},
            status_code=402,
        )

    body = await request.json()
    model = body.get("model", "")
    stream = bool(body.get("stream"))
    if path.endswith("chat/completions"):
        if stream:
            body["stream_options"] = {**(body.get("stream_options") or {}), "include_usage": True}
        if provider == "openrouter":
            body["usage"] = {"include": True}  # OpenRouter renvoie alors le coût exact

    if not stream:
        async with httpx.AsyncClient(timeout=600) as c:
            r = await c.post(url, headers=headers, json=body)
        if r.status_code == 200:
            try:
                await _record(agent_id, model, r.json().get("usage"))
            except ValueError:
                pass
        return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))

    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=20))
    upstream = await client.send(client.build_request("POST", url, headers=headers, json=body), stream=True)
    if upstream.status_code != 200:
        content = await upstream.aread()
        await upstream.aclose()
        await client.aclose()
        return Response(content, status_code=upstream.status_code, media_type=upstream.headers.get("content-type"))

    async def passthrough():
        usage = None
        pending = b""
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
                pending += chunk
                *lines, pending = pending.split(b"\n")
                for line in lines:
                    if line.startswith(b"data:") and b'"usage"' in line:
                        try:
                            usage = json.loads(line[5:].strip()).get("usage") or usage
                        except ValueError:
                            pass
        finally:
            await upstream.aclose()
            await client.aclose()
            await _record(agent_id, model, usage)

    return StreamingResponse(passthrough(), status_code=200, media_type=upstream.headers.get("content-type", "text/event-stream"))
