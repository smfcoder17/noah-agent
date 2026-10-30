"""Mesure la réactivité de Noah Agent, du point de vue de l'utilisateur.

Usage, dans le conteneur du serveur : python -m apollo.bench [étiquette] [répétitions]
Les messages partent dans un fil archivé « Mesure de vitesse » : la conversation principale reste propre.
Chaque mesure de chat coûte un petit appel au modèle de l'agent.

Ce qui compte pour l'utilisateur :
- premier signe : l'interface montre que l'agent a reçu (événement « start ») ;
- première réaction : la première ligne d'activité ou le premier mot ;
- premier mot : le début de la réponse écrite ;
- fin : la réponse complète.
"""
import asyncio
import json
import statistics
import sys
import time
import uuid

import httpx

from . import auth, db
from .config import DATA_DIR

BASE = "http://localhost:8080"
PROMPTS = [
    ("salut", "Réponds seulement : OK."),
    ("question", "En une phrase : pourquoi le ciel est-il bleu ?"),
    ("outil", "Quelle est la date et l'heure exactes sur ta machine ? Vérifie avec une commande, puis réponds en une phrase."),
]


def _setup() -> tuple[str, str, str]:
    with db.connect() as c:
        user = c.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()["id"]
        agent = c.execute("SELECT id FROM agents ORDER BY pinned DESC, created_at LIMIT 1").fetchone()["id"]
        row = c.execute("SELECT id FROM conversations WHERE agent_id = ? AND title = 'Mesure de vitesse'", (agent,)).fetchone()
        if row:
            conv = row["id"]
        else:
            import uuid

            conv = uuid.uuid4().hex
            c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, origin, archived) VALUES (?, ?, ?, ?, 0, 'agent', 1)",
                      (conv, user, agent, "Mesure de vitesse"))
    return auth.new_session(user), agent, conv


async def _chat(client: httpx.AsyncClient, agent: str, conv: str, text: str) -> dict:
    t0 = time.perf_counter()
    marks: dict[str, float] = {}
    async with client.stream("POST", f"{BASE}/api/chat", json={"agent_id": agent, "text": text, "conversation_id": conv,
                                                               "attachments": [], "details": False}) as r:
        r.raise_for_status()
        buf = ""
        async for chunk in r.aiter_text():
            buf += chunk
            while "\n\n" in buf:
                frame, buf = buf.split("\n\n", 1)
                if not frame.startswith("data:"):
                    continue
                ev = json.loads(frame[5:])
                now = (time.perf_counter() - t0) * 1000
                kind = ev.get("type")
                marks.setdefault(kind, now)
                if kind in ("activity", "message"):
                    marks.setdefault("reaction", now)
    marks["end"] = (time.perf_counter() - t0) * 1000
    return {"premier_signe": marks.get("start"), "premiere_reaction": marks.get("reaction"),
            "premier_mot": marks.get("message"), "fin": marks.get("done", marks["end"])}


async def _timed(client: httpx.AsyncClient, method: str, path: str, **kw) -> float:
    t0 = time.perf_counter()
    r = await client.request(method, f"{BASE}{path}", **kw)
    r.raise_for_status()
    return (time.perf_counter() - t0) * 1000


async def _first_sound(client: httpx.AsyncClient, agent: str, text: str) -> dict:
    """Délai avant le premier son en mode vocal : réponse puis synthèse complète (ancien), ou tout en flux (nouveau)."""
    turn = {"agent_id": agent, "text": text, "history": [], "mode": "turn"}
    t0 = time.perf_counter()
    r = await client.post(f"{BASE}/api/voice/reply", json=turn)
    dire = r.json().get("dire") or "D'accord."
    (await client.post(f"{BASE}/api/voice/speak", json={"agent_id": agent, "text": dire.split(". ")[0]})).raise_for_status()
    old = (time.perf_counter() - t0) * 1000

    sid = uuid.uuid4().hex
    t0 = time.perf_counter()

    async def listen() -> float | None:
        async with client.stream("GET", f"{BASE}/api/voice/audio/{sid}") as s:
            async for _ in s.aiter_bytes():
                return (time.perf_counter() - t0) * 1000
        return None

    first, _ = await asyncio.gather(listen(), client.post(f"{BASE}/api/voice/reply", json={**turn, "audio_id": sid}))
    return {"ancien": old, "flux": first}


async def main() -> None:
    label = sys.argv[1] if len(sys.argv) > 1 else "mesure"
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    token, agent, conv = _setup()
    out: dict = {"etiquette": label, "date": time.strftime("%Y-%m-%d %H:%M"), "api": {}, "chat": {}, "voix": None}
    async with httpx.AsyncClient(cookies={"apollo_session": token}, timeout=300) as c:
        main_conv = next((x["id"] for x in (await c.get(f"{BASE}/api/agents/{agent}/conversations")).json() if x.get("main")), None)
        for name, path in (("agents", "/api/agents"), ("conversations", f"/api/agents/{agent}/conversations"),
                           ("messages", f"/api/conversations/{main_conv}/messages"), ("page", "/")):
            out["api"][name] = round(statistics.median([await _timed(c, "GET", path) for _ in range(5)]))
        for name, text in PROMPTS if "voix" not in sys.argv[3:] else ():
            runs = [await _chat(c, agent, conv, text) for _ in range(reps)]
            out["chat"][name] = {k: round(statistics.median([r[k] for r in runs if r[k] is not None]))
                                 for k in runs[0] if any(r[k] is not None for r in runs)}
        try:
            out["voix"] = round(statistics.median([await _timed(c, "POST", "/api/voice/reply", json={
                "agent_id": agent, "text": "Salut, tu vas bien ?", "history": [], "mode": "turn"}) for _ in range(reps)]))
            sounds = [await _first_sound(c, agent, text) for text in ("Salut, tu vas bien ?", "Regarde mes derniers courriels.")
                      for _ in range(reps)]
            out["voix_premier_son"] = {k: round(statistics.median([s[k] for s in sounds if s[k]])) for k in ("ancien", "flux")}
        except httpx.HTTPError:
            pass
    print(json.dumps(out, ensure_ascii=False, indent=1))
    results = DATA_DIR / "bench.jsonl"
    with results.open("a", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
