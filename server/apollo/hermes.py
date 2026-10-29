"""Client des agents : le lanceur (cycle de vie, fichiers) et la gateway Hermes de chaque agent."""
import hashlib
import hmac
import json
import re
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


def browser_secrets(agent_id: str) -> tuple[str, str]:
    """Clé d'API Camoufox et mot de passe VNC propres à l'agent (dérivés, rien à stocker)."""
    from .config import SECRET_KEY

    base = hmac.new(SECRET_KEY.encode(), f"browser:{agent_id}".encode(), hashlib.sha256).hexdigest()
    return base[:48], base[48:56]  # x11vnc ne lit que 8 caractères de mot de passe


def browser_host(agent_id: str) -> str:
    return f"apollo-browser-{agent_id}"


async def ensure_browser(agent_id: str) -> None:
    api_key, vnc_password = browser_secrets(agent_id)
    await _launcher("POST", f"/agents/{agent_id}/browser", json={"api_key": api_key, "vnc_password": vnc_password})


async def list_files(agent_id: str) -> list[dict]:
    return await _launcher("GET", f"/agents/{agent_id}/files")


async def read_file(agent_id: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=120) as c:
        return await c.get(f"{LAUNCHER_URL}/agents/{agent_id}/file", params={"path": path}, headers=LAUNCHER)


async def upload(agent_id: str, name: str, data: bytes) -> str:
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.put(f"{LAUNCHER_URL}/agents/{agent_id}/upload", params={"name": name}, content=data, headers=LAUNCHER)
    r.raise_for_status()
    return r.json()["path"]


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


def _agent_env(text: str, agent_id: str) -> str:
    """Retire toute clé de fournisseur du .env de l'agent (elles restent dans le serveur)
    et le branche sur son navigateur Camoufox."""
    api_key, _ = browser_secrets(agent_id)
    managed = {"CAMOFOX_URL": f"http://{browser_host(agent_id)}:9377", "CAMOFOX_API_KEY": api_key}
    drop = {p["env"] for p in PROVIDERS.values() if p["env"]} | set(managed)
    lines = [l for l in text.splitlines() if l.split("=", 1)[0].strip() not in drop]
    lines += [f"{k}={v}" for k, v in managed.items()]
    return "\n".join(lines) + "\n"


# Familles qui ont besoin de marqueurs de cache explicites (style Anthropic) ; les autres
# fournisseurs mettent en cache tout seuls tant que le début du prompt ne change pas.
CACHE_MARKER_MODELS = re.compile(r"claude|kimi|moonshot|qwen", re.I)


async def configure(agent_id: str, model: dict, role: str | None = None) -> None:
    """Branche l'agent sur le relais du serveur avec le modèle choisi (et son rôle), puis le redémarre.

    L'agent ne reçoit jamais la clé du fournisseur : seulement l'adresse du relais et son jeton.
    """
    from .relay import RELAY_URL, token_for

    p = PROVIDERS[model["provider"]]
    model_id = model.get("model") or p["model"]
    files: dict[str, str] = {".env": _agent_env(await _read(agent_id, ".env"), agent_id)}

    cfg = yaml.safe_load(await _read(agent_id, "config.yaml") or "{}") or {}
    cfg["model"] = {
        "provider": "custom",
        "default": model_id,
        "base_url": RELAY_URL,
        "api_key": token_for(agent_id),
        "api_mode": "chat_completions",
    }
    # Déclare le relais comme route connue pour activer le cache de prompt quand le modèle en a besoin.
    cfg["custom_providers"] = [{
        "name": "apollo",
        "base_url": RELAY_URL,
        "api_key": token_for(agent_id),
        "models": {model_id: {"prompt_caching": bool(CACHE_MARKER_MODELS.search(model_id))}},
    }]
    # Navigateur Camoufox (anti-détection), profil et cookies gardés entre les sessions.
    browser = cfg.setdefault("browser", {})
    browser["cloud_provider"] = "camofox"
    browser.setdefault("camofox", {})["managed_persistence"] = True
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
