"""Client des agents : le lanceur (cycle de vie, fichiers) et la gateway Hermes de chaque agent."""
import json
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx
import yaml

from .config import LAUNCHER_KEY, LAUNCHER_URL

LAUNCHER = {"Authorization": f"Bearer {LAUNCHER_KEY}"}


@dataclass
class Agent:
    id: str
    api_key: str

    @property
    def url(self) -> str:
        return f"http://apollo-agent-{self.id}:8642"

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}


# --- Lanceur ---------------------------------------------------------------------

async def _launcher(method: str, path: str, **kw) -> dict:
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.request(method, f"{LAUNCHER_URL}{path}", headers=LAUNCHER, **kw)
    r.raise_for_status()
    return r.json()


async def statuses() -> dict[str, str]:
    try:
        return {a["id"]: a["status"] for a in await _launcher("GET", "/agents")}
    except httpx.HTTPError:
        return {}


async def create_container(agent_id: str) -> str:
    api_key = secrets.token_hex(32)
    await _launcher("POST", f"/agents/{agent_id}", json={"api_key": api_key})
    return api_key


async def delete_container(agent_id: str) -> None:
    await _launcher("DELETE", f"/agents/{agent_id}")


async def restart(agent_id: str) -> None:
    await _launcher("POST", f"/agents/{agent_id}/restart")


async def media(agent_id: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as c:
        return await c.get(f"{LAUNCHER_URL}/agents/{agent_id}/media", params={"path": path}, headers=LAUNCHER)


async def _read(agent_id: str, name: str) -> str:
    return (await _launcher("GET", f"/agents/{agent_id}/files/{name}"))["content"]


# --- Configuration du modèle et du rôle ------------------------------------------

# "env" ne sert plus qu'à nettoyer d'anciennes clés dans les agents et à savoir si une clé est requise.
PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "env": "OPENROUTER_API_KEY", "model": "anthropic/claude-sonnet-4.5"},
    "anthropic": {"label": "Anthropic (Claude)", "env": "ANTHROPIC_API_KEY", "model": "claude-sonnet-4-5"},
    "openai": {"label": "OpenAI", "env": "OPENAI_API_KEY", "model": "gpt-5"},
    "gemini": {"label": "Google Gemini", "env": "GEMINI_API_KEY", "model": "gemini-2.5-pro"},
    "ollama": {"label": "Ollama", "env": None, "model": "gpt-oss:20b"},
}


def _strip_provider_keys(text: str) -> str:
    """Retire toute clé de fournisseur du .env de l'agent : elles restent dans le serveur."""
    names = {p["env"] for p in PROVIDERS.values() if p["env"]}
    lines = [l for l in text.splitlines() if l.split("=", 1)[0].strip() not in names]
    return "\n".join(lines) + "\n"


async def configure(agent_id: str, model: dict, role: str | None = None) -> None:
    """Branche l'agent sur le relais du serveur avec le modèle choisi (et son rôle), puis le redémarre.

    L'agent ne reçoit jamais la clé du fournisseur : seulement l'adresse du relais et son jeton.
    """
    from .relay import RELAY_URL, token_for

    p = PROVIDERS[model["provider"]]
    files: dict[str, str] = {".env": _strip_provider_keys(await _read(agent_id, ".env"))}

    cfg = yaml.safe_load(await _read(agent_id, "config.yaml") or "{}") or {}
    cfg["model"] = {
        "provider": "custom",
        "default": model.get("model") or p["model"],
        "base_url": RELAY_URL,
        "api_key": token_for(agent_id),
        "api_mode": "chat_completions",
    }
    # Les commandes de l'agent démarrent dans son espace de travail, pas au milieu de sa config.
    cfg.setdefault("terminal", {})["cwd"] = "/opt/data/workspace"
    files["config.yaml"] = yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True)

    if role is not None:
        files["SOUL.md"] = role.strip() + "\n"

    await _launcher("PUT", f"/agents/{agent_id}/files", json={"files": files})
    await restart(agent_id)


# --- Gateway Hermes ---------------------------------------------------------------

async def health(agent: Agent) -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{agent.url}/health")
        return r.status_code == 200
    except httpx.HTTPError:
        return False


async def start_run(agent: Agent, text: str, session_id: str) -> str:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{agent.url}/v1/runs",
            headers=agent.headers,
            json={"input": text, "session_id": session_id},
        )
    r.raise_for_status()
    return r.json()["run_id"]


async def run_events(agent: Agent, run_id: str) -> AsyncIterator[tuple[str, dict]]:
    """Lit le flux SSE d'un run et rend des paires (type d'événement, données).

    Hermes envoie des trames `data: {"event": "tool.started", "run_id": …, …}` ;
    le type est dans le champ "event" du JSON.
    """
    async with httpx.AsyncClient(timeout=None) as c:
        async with c.stream("GET", f"{agent.url}/v1/runs/{run_id}/events", headers=agent.headers) as r:
            r.raise_for_status()
            data: list[str] = []
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    data.append(line[5:].strip())
                elif line == "" and data:
                    try:
                        payload = json.loads("\n".join(data))
                    except json.JSONDecodeError:
                        payload = {}
                    data = []
                    if payload.get("event"):
                        yield payload["event"], payload


async def answer_approval(agent: Agent, run_id: str, request_id: str, generation: int, approve: bool) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{agent.url}/v1/runs/{run_id}/approval",
            headers=agent.headers,
            json={
                "request_id": request_id,
                "execution_generation": generation,
                "choice": "once" if approve else "deny",
            },
        )
    r.raise_for_status()


async def stop_run(agent: Agent, run_id: str) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        await c.post(f"{agent.url}/v1/runs/{run_id}/stop", headers=agent.headers)
