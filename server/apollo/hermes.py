"""Client de la gateway Hermes : API Runs (événements SSE, approbations) et configuration."""
import json
from collections.abc import AsyncIterator

import httpx
import yaml

from .config import DOCKER_URL, HERMES_API_KEY, HERMES_CONTAINER, HERMES_DATA_DIR, HERMES_URL

HEADERS = {"Authorization": f"Bearer {HERMES_API_KEY}"}


async def health() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{HERMES_URL}/health")
        return r.status_code == 200
    except httpx.HTTPError:
        return False


async def start_run(text: str, session_id: str) -> str:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{HERMES_URL}/v1/runs",
            headers=HEADERS,
            json={"input": text, "session_id": session_id},
        )
    r.raise_for_status()
    return r.json()["run_id"]


async def run_events(run_id: str) -> AsyncIterator[tuple[str, dict]]:
    """Lit le flux SSE d'un run et rend des paires (type d'événement, données).

    Hermes envoie des trames `data: {"event": "tool.started", "run_id": …, …}` ;
    le type est dans le champ "event" du JSON.
    """
    async with httpx.AsyncClient(timeout=None) as c:
        async with c.stream(
            "GET", f"{HERMES_URL}/v1/runs/{run_id}/events", headers=HEADERS
        ) as r:
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


async def get_run(run_id: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{HERMES_URL}/v1/runs/{run_id}", headers=HEADERS)
    r.raise_for_status()
    return r.json()


async def answer_approval(run_id: str, request_id: str, generation: int, approve: bool) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{HERMES_URL}/v1/runs/{run_id}/approval",
            headers=HEADERS,
            json={
                "request_id": request_id,
                "execution_generation": generation,
                "choice": "once" if approve else "deny",
            },
        )
    r.raise_for_status()


async def stop_run(run_id: str) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        await c.post(f"{HERMES_URL}/v1/runs/{run_id}/stop", headers=HEADERS)


# --- Configuration du modèle --------------------------------------------------

# provider Hermes, variable d'environnement de la clé, modèle par défaut, base_url éventuelle
PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "env": "OPENROUTER_API_KEY", "model": "anthropic/claude-sonnet-4.5"},
    "anthropic": {"label": "Anthropic (Claude)", "env": "ANTHROPIC_API_KEY", "model": "claude-sonnet-4-5"},
    "openai": {"label": "OpenAI", "env": "OPENAI_API_KEY", "model": "gpt-5"},
    "gemini": {"label": "Google Gemini", "env": "GEMINI_API_KEY", "model": "gemini-2.5-pro"},
    # Hermes traite Ollama comme un fournisseur "custom" compatible OpenAI.
    "ollama": {"label": "Ollama (local)", "env": None, "model": "qwen3:8b", "base_url": "http://host.docker.internal:11434/v1"},
}


def _set_env_line(path, key: str, value: str) -> None:
    lines = path.read_text().splitlines() if path.exists() else []
    lines = [l for l in lines if not l.startswith(f"{key}=")]
    lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")


def write_model_config(provider: str, api_key: str | None, model: str | None, base_url: str | None) -> None:
    """Écrit la clé dans /opt/data/.env et le modèle dans config.yaml, sans passer par l'assistant d'Hermes."""
    p = PROVIDERS[provider]
    HERMES_DATA_DIR.mkdir(parents=True, exist_ok=True)
    if p["env"] and api_key:
        _set_env_line(HERMES_DATA_DIR / ".env", p["env"], api_key)

    cfg_path = HERMES_DATA_DIR / "config.yaml"
    cfg = yaml.safe_load(cfg_path.read_text()) if cfg_path.exists() else {}
    cfg = cfg or {}
    if provider == "ollama":
        cfg["model"] = {
            "provider": "custom",
            "default": model or p["model"],
            "base_url": base_url or p["base_url"],
            "api_key": "none",
        }
    else:
        cfg["model"] = {"provider": provider, "default": model or p["model"], "base_url": ""}
    cfg_path.write_text(yaml.safe_dump(cfg, sort_keys=False))


async def restart_gateway() -> None:
    """Redémarre le conteneur Hermes via le proxy Docker restreint, pour qu'il relise sa config."""
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{DOCKER_URL}/containers/{HERMES_CONTAINER}/restart")
    r.raise_for_status()
