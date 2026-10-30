"""Création de médias et voix : images, vidéos, musique, synthèse vocale et transcription.

Tout passe par la clé du fournisseur gardée dans le serveur (jamais par l'agent). Pour chaque type,
l'utilisateur choisit un modèle ou laisse « Automatique » : on prend alors le meilleur modèle
disponible dans son catalogue, selon un classement tenu à jour ici (qualité d'abord, puis coût).
Seul OpenRouter expose aujourd'hui tous ces types derrière une même clé.
"""
import asyncio
import base64
import json
import re
import time

import httpx

from . import db, relay

BASE = "https://openrouter.ai/api/v1"
CACHE_SECONDS = 3600

KINDS = {
    "image": "Images",
    "video": "Vidéos",
    "music": "Musique",
    "speech": "Voix de l'agent",
    "transcription": "Dictée et transcription",
}

# Classement « Automatique » : le premier modèle présent dans le catalogue gagne.
RANKING = {
    "image": [
        "google/gemini-nano-banana-2.1", "openai/gpt-image-2.5-sunburst", "google/gemini-3.1-flash-image",
        "bytedance-seed/seedream-5-0-pro", "black-forest-labs/flux-3-image", "openai/gpt-image-2",
    ],
    "video": ["google/veo-3.1-fast", "bytedance/seedance-2.0", "kwaivgi/kling-v3.0-std", "minimax/hailuo-3", "alibaba/wan-3.0"],
    "music": ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"],
    "speech": [
        "microsoft/mai-voice-2.1-flash", "elevenlabs/eleven-v4-turbo", "google/gemini-3.8-flash-tts",
        "mistralai/voxtral-mini-tts-3-0",
    ],
    "transcription": [
        "mistralai/voxtral-small-transcribe-3-0", "elevenlabs/scribe-v2", "openai/gpt-4o-mini-transcribe",
        "openai/whisper-large-v3-turbo",
    ],
}

# En automatique, certaines demandes d'image vont mieux à un modèle spécialisé.
IMAGE_HINTS = [
    (re.compile(r"\b(logo|ic[oô]ne|vectori|svg|pictogramme)", re.I), ["recraft/recraft-v4.1-vector", "recraft/recraft-v4.1-pro-vector"]),
    (re.compile(r"\b(affiche|poster|texte|typo|infographi|menu|banni[eè]re|miniature)", re.I), ["openai/gpt-image-2.5-sunburst", "openai/gpt-image-2"]),
]


class MediaError(Exception):
    """Erreur lisible par l'utilisateur et par l'agent."""


def _key() -> str:
    if db.get_setting("provider") != "openrouter":
        raise MediaError("La création de médias et la voix demandent une clé OpenRouter (Réglages > Cerveau).")
    key = db.get_setting("api_key", secret=True) if db.get_setting("api_key") else None
    if not key:
        raise MediaError("Aucune clé OpenRouter enregistrée.")
    return key


def _headers() -> dict:
    return {"Authorization": f"Bearer {_key()}", "HTTP-Referer": "https://github.com/noah-agent", "X-Title": "Noah Agent"}


def _check_budget() -> None:
    limit = relay.budget()
    if limit is not None and relay.month_cost() >= limit:
        raise MediaError(f"Budget mensuel de {limit:.2f} $ atteint. Augmente-le dans Noah Agent pour continuer.")


def _record(agent_id: str, model: str, cost: float | None) -> None:
    with db.connect() as c:
        c.execute(
            "INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost, cached_tokens) VALUES (?, ?, 0, 0, ?, 0)",
            (agent_id, model, float(cost or 0)),
        )


def _fail(r: httpx.Response) -> MediaError:
    try:
        msg = r.json().get("error", {}).get("message") or r.text
    except ValueError:
        msg = r.text
    if r.status_code == 402:
        return MediaError("Le compte OpenRouter n'a plus de crédit.")
    return MediaError(f"Le modèle a refusé la demande ({r.status_code}) : {str(msg)[:300]}")


# --- Catalogue ---------------------------------------------------------------------------

_cache: dict[str, tuple[float, list[dict]]] = {}


async def models(kind: str) -> list[dict]:
    """Modèles disponibles pour un type : [{id, name, voices?}], du plus récent au plus ancien."""
    hit = _cache.get(kind)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    async with httpx.AsyncClient(timeout=30, headers=_headers()) as c:
        if kind == "image":
            r = await c.get(f"{BASE}/images/models")
        elif kind == "video":
            r = await c.get(f"{BASE}/videos/models")
        else:
            modality = {"music": "audio", "speech": "speech", "transcription": "transcription"}[kind]
            r = await c.get(f"{BASE}/models", params={"output_modalities": modality})
    r.raise_for_status()
    items = r.json().get("data", [])
    if kind == "music":  # sortie audio = musique (Lyria) ; les modèles de conversation vocale n'en sont pas
        items = [m for m in items if "lyria" in m["id"] or "music" in m["id"]]
    out = [{"id": m["id"], "name": m.get("name") or m["id"], **({"voices": m["supported_voices"]} if m.get("supported_voices") else {})} for m in items]
    _cache[kind] = (time.time(), out)
    return out


def setting(kind: str) -> str:
    return db.get_setting(f"media_{kind}") or "auto"


async def resolve(kind: str, prompt: str = "") -> str:
    """Modèle à utiliser : celui choisi par l'utilisateur, sinon le meilleur disponible pour cette demande."""
    chosen = setting(kind)
    return chosen if chosen != "auto" else await auto_choice(kind, prompt)


async def auto_choice(kind: str, prompt: str = "") -> str:
    """Le meilleur modèle disponible pour ce type (et cette demande), selon le classement."""
    available = [m["id"] for m in await models(kind)]
    if not available:
        raise MediaError(f"Aucun modèle de type « {KINDS[kind]} » chez ce fournisseur.")
    ranking = list(RANKING.get(kind, []))
    if kind == "image":
        for pattern, preferred in IMAGE_HINTS:
            if pattern.search(prompt):
                ranking = preferred + ranking
                break
    return next((m for m in ranking if m in available), available[0])


async def voice_for(model: str) -> str | None:
    """Voix choisie, sinon la première voix française du modèle, sinon sa première voix."""
    chosen = db.get_setting("media_voice") or "auto"
    voices = next((m.get("voices", []) for m in await models("speech") if m["id"] == model), [])
    if chosen != "auto" and (chosen in voices or not voices):
        return chosen
    return next((v for v in voices if v.lower().startswith("fr")), voices[0] if voices else None)


# --- Génération ---------------------------------------------------------------------------

EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg"}


async def image(agent_id: str, prompt: str, aspect_ratio: str | None = None) -> tuple[bytes, str, str]:
    """Rend (octets, extension, modèle)."""
    _check_budget()
    model = await resolve("image", prompt)
    body = {"model": model, "prompt": prompt}
    if aspect_ratio:
        body["aspect_ratio"] = aspect_ratio
    async with httpx.AsyncClient(timeout=300, headers=_headers()) as c:
        r = await c.post(f"{BASE}/images", json=body)
    if r.status_code != 200:
        raise _fail(r)
    j = r.json()
    item = (j.get("data") or [{}])[0]
    if not item.get("b64_json"):
        raise MediaError("Le modèle n'a renvoyé aucune image.")
    _record(agent_id, model, (j.get("usage") or {}).get("cost"))
    return base64.b64decode(item["b64_json"]), EXT.get(item.get("media_type", ""), "png"), model


async def music(agent_id: str, prompt: str) -> tuple[bytes, str, str]:
    """Lyria passe par chat/completions en flux : l'audio arrive en base64 dans les deltas."""
    _check_budget()
    model = await resolve("music", prompt)
    chunks: list[str] = []
    cost = None
    async with httpx.AsyncClient(timeout=600, headers=_headers()) as c:
        async with c.stream("POST", f"{BASE}/chat/completions", json={
            "model": model, "modalities": ["audio"], "stream": True,
            "messages": [{"role": "user", "content": prompt}],
        }) as r:
            if r.status_code != 200:
                await r.aread()
                raise _fail(r)
            async for line in r.aiter_lines():
                if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                    continue
                try:
                    j = json.loads(line[5:])
                except ValueError:
                    continue
                cost = (j.get("usage") or {}).get("cost", cost)
                for ch in j.get("choices", []):
                    audio = (ch.get("delta") or {}).get("audio")
                    if isinstance(audio, dict) and audio.get("data"):
                        chunks.append(audio["data"])
    if not chunks:
        raise MediaError("Le modèle n'a renvoyé aucun son.")
    _record(agent_id, model, cost)
    return b"".join(base64.b64decode(x) for x in chunks), "mp3", model


async def video(agent_id: str, prompt: str, duration: int | None = None, aspect_ratio: str | None = None) -> tuple[bytes, str, str]:
    """Tâche asynchrone : on soumet, on attend la fin (jusqu'à 10 min), puis on télécharge le MP4."""
    _check_budget()
    model = await resolve("video", prompt)
    body = {"model": model, "prompt": prompt}
    if duration:
        body["duration"] = duration
    if aspect_ratio:
        body["aspect_ratio"] = aspect_ratio
    async with httpx.AsyncClient(timeout=120, headers=_headers()) as c:
        r = await c.post(f"{BASE}/videos", json=body)
        if r.status_code not in (200, 202):
            raise _fail(r)
        job = r.json()
        url = job.get("polling_url") or f"{BASE}/videos/{job['id']}"
        for _ in range(120):
            await asyncio.sleep(5)
            job = (await c.get(url)).json()
            if job.get("status") in ("completed", "failed", "cancelled", "expired"):
                break
        if job.get("status") != "completed":
            raise MediaError(f"La vidéo n'a pas abouti ({job.get('status')}) : {job.get('error') or 'délai dépassé'}")
        links = job.get("urls") or job.get("unsigned_urls") or []
        if not links:
            raise MediaError("La vidéo est prête mais sans lien de téléchargement.")
        link = links[0]["url"] if isinstance(links[0], dict) else links[0]
        r = await c.get(link, timeout=300)
        if r.status_code != 200:
            raise _fail(r)
    _record(agent_id, model, (job.get("usage") or {}).get("cost"))
    return r.content, "mp4", model


async def speak(agent_id: str, text: str) -> tuple[bytes, str, str]:
    """Synthèse vocale en MP3. Rend (octets, type MIME, modèle)."""
    _check_budget()
    model = await resolve("speech")
    body = {"model": model, "input": text[:4000], "response_format": "mp3"}
    voice = await voice_for(model)
    if voice:
        body["voice"] = voice
    async with httpx.AsyncClient(timeout=120, headers=_headers()) as c:
        r = await c.post(f"{BASE}/audio/speech", json=body)
        if r.status_code == 400 and "format" in r.text.lower():  # modèle qui ne rend que du PCM
            body["response_format"] = "pcm"
            r = await c.post(f"{BASE}/audio/speech", json=body)
    if r.status_code != 200:
        raise _fail(r)
    ctype = r.headers.get("content-type", "audio/mpeg")
    data = r.content
    if ctype.startswith("audio/pcm"):
        rate = int((re.search(r"rate=(\d+)", ctype) or [0, 24000])[1])
        data, ctype = _wav(data, rate), "audio/wav"
    # Prix au caractère (champ prompt du catalogue), approximatif.
    _record(agent_id, model, None)
    return data, ctype.split(";")[0], model


def _wav(pcm: bytes, rate: int) -> bytes:
    import struct

    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


# --- Voix rapide du mode vocal --------------------------------------------------------------
# Le cerveau de l'agent fait le travail (outils, navigateur, fichiers) mais met plusieurs secondes.
# Un petit modèle très rapide répond tout de suite à voix haute, et relit le résultat à la fin.
VOICE_MODELS = ["google/gemini-3.1-flash-lite", "openai/gpt-6-luna-pro", "anthropic/claude-haiku-5.5", "google/gemini-3.8-flash"]

VOICE_TURN = """Tu es la voix de {name}, un agent personnel. L'utilisateur te parle à voix haute ; l'agent, lui, a un ordinateur,
un navigateur, des fichiers, une mémoire et des outils, mais il met du temps à répondre.
Réponds uniquement par un objet JSON : {{"dire": "...", "action": true ou false}}.
- action = true si la demande demande à l'agent d'agir ou de chercher (naviguer, créer, écrire un fichier, consulter ses
  courriels, se souvenir, programmer une routine, chercher une info récente ou précise). « dire » est alors un accusé
  très court et naturel qui reformule ce qui va être fait (« D'accord, je regarde tes derniers courriels. »), sans inventer de résultat.
- action = false pour une conversation simple ou une question générale à laquelle tu peux répondre sûrement :
  « dire » est la réponse, une à trois phrases.
Parle comme à l'oral, en français, sans liste ni mise en forme.{role}"""

VOICE_RESULT = """Tu es la voix de {name}. L'agent vient de terminer le travail demandé. Résume son résultat à voix haute
en une ou deux phrases naturelles, en français, sans lire les chemins de fichiers, le code ni les listes en entier.
Si quelque chose attend l'utilisateur (un choix, une validation, un fichier à regarder), dis-le. Réponds en texte simple."""


async def voice_model() -> str:
    chosen = db.get_setting("media_voice_brain") or "auto"
    if chosen != "auto":
        return chosen
    from . import catalog

    ids = {m["id"] for m in await catalog.models_for("openrouter", _key())}
    return next((m for m in VOICE_MODELS if m in ids), VOICE_MODELS[0])


async def voice_reply(agent_id: str, name: str, role: str, text: str, history: list[dict], mode: str) -> dict:
    """Réponse orale immédiate. mode « turn » : {dire, action} ; mode « result » : {dire} (résumé du travail)."""
    _check_budget()
    model = await voice_model()
    if mode == "result":
        messages = [{"role": "system", "content": VOICE_RESULT.format(name=name)}, {"role": "user", "content": text[:12000]}]
    else:
        system = VOICE_TURN.format(name=name, role=f"\nRôle de l'agent : {role[:600]}" if role else "")
        messages = [{"role": "system", "content": system}]
        messages += [{"role": "assistant" if h.get("role") == "assistant" else "user", "content": str(h.get("text", ""))[:1500]} for h in history[-6:]]
        messages.append({"role": "user", "content": text})
    body = {"model": model, "messages": messages, "max_tokens": 300, "temperature": 0.4,
            "provider": {"sort": "latency"}}
    if mode != "result":
        body["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=30, headers=_headers()) as c:
        r = await c.post(f"{BASE}/chat/completions", json=body)
    if r.status_code != 200:
        raise _fail(r)
    j = r.json()
    _record(agent_id, model, (j.get("usage") or {}).get("cost"))
    content = (j["choices"][0]["message"].get("content") or "").strip()
    if mode == "result":
        return {"dire": content, "action": False}
    try:
        data = json.loads(content[content.find("{"): content.rfind("}") + 1])
        return {"dire": str(data.get("dire", "")).strip(), "action": bool(data.get("action"))}
    except ValueError:
        return {"dire": content, "action": True}


async def transcribe(agent_id: str, audio: bytes, fmt: str, language: str | None = "fr") -> str:
    _check_budget()
    model = await resolve("transcription")
    body = {"model": model, "input_audio": {"data": base64.b64encode(audio).decode(), "format": fmt}}
    if language:
        body["language"] = language
    async with httpx.AsyncClient(timeout=120, headers=_headers()) as c:
        r = await c.post(f"{BASE}/audio/transcriptions", json=body)
    if r.status_code != 200:
        raise _fail(r)
    j = r.json()
    _record(agent_id, model, (j.get("usage") or {}).get("cost"))
    return (j.get("text") or "").strip()
