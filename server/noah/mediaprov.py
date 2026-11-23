"""Image, vidéo et voix chez OpenAI et chez Google Gemini, avec la clé du fournisseur branché (providers.py).

OpenRouter les expose tous derrière une seule clé et reste dans media.py. Ici, chaque fournisseur a ses propres routes :
  OpenAI : /images/generations, /videos (tâche asynchrone), /audio/speech, /audio/transcriptions.
  Gemini : models/{modèle}:generateContent (image, voix, dictée), :predict (Imagen), :predictLongRunning (Veo).
La clé ne part que vers l'adresse de son fournisseur. Les listes de modèles sont lues chez lui, jamais écrites ici.
"""
import asyncio
import base64
import re
import struct

import httpx

from . import relay

OPENAI = "https://api.openai.com/v1"
GEMINI = "https://generativelanguage.googleapis.com/v1beta"
PROVIDERS = ("openai", "gemini")
LABELS = {"openai": "OpenAI", "gemini": "Google Gemini"}

# Ce que chaque fournisseur propose, reconnu à l'identifiant du modèle (leurs listes ne disent pas toujours à quoi sert un modèle).
OPENAI_KINDS = {
    "image": re.compile(r"^(gpt-image|chatgpt-image|dall-e)"),
    "video": re.compile(r"^sora"),
    "speech": re.compile(r"(^tts-|-tts($|-))"),
    "transcription": re.compile(r"(whisper|transcribe)"),
}
GEMINI_KINDS = {
    "image": re.compile(r"(-image($|-)|^imagen-)"),
    "video": re.compile(r"^veo-"),
    "speech": re.compile(r"-tts($|-)"),
    "transcription": re.compile(r"^gemini-[\d.]+-flash(-lite)?$"),  # Gemini comprend l'audio : une demande de transcription
}
KINDS = {"openai": OPENAI_KINDS, "gemini": GEMINI_KINDS}
OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]
GEMINI_VOICES = ["Kore", "Puck", "Zephyr", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Callirrhoe", "Autonoe"]
PRICE = "prix de ton fournisseur"
LANDSCAPE, PORTRAIT = {"16:9", "3:2", "4:3", "21:9"}, {"9:16", "2:3", "3:4"}


class Refused(Exception):
    """Le fournisseur a refusé ou n'a pas répondu. temporary : une panne passagère, la même demande peut réussir plus tard."""

    def __init__(self, message: str, temporary: bool = False):
        super().__init__(message)
        self.temporary = temporary


def _refuse(r: httpx.Response, key: str) -> Refused:
    try:
        error = r.json().get("error", {})
        message = (error.get("message") if isinstance(error, dict) else error) or r.text
    except (ValueError, AttributeError):
        message = r.text
    message = str(message).replace(key, "[clé]")[:300]  # un serveur peut répéter la clé reçue
    return Refused(f"Le fournisseur a refusé la demande ({r.status_code}) : {message}", r.status_code in (408, 409, 425, 429, 500, 502, 503, 504, 529))


def _headers(provider: str, key: str) -> dict:
    return {"x-goog-api-key": key} if provider == "gemini" else {"Authorization": f"Bearer {key}"}


async def _send(method: str, url: str, provider: str, key: str, *, timeout: float = 120, **kw) -> httpx.Response:
    try:
        r = await relay.upstream_client().request(method, url, headers={**_headers(provider, key), **kw.pop("headers", {})}, timeout=timeout, **kw)
    except httpx.HTTPError as e:
        raise Refused(f"{LABELS[provider]} injoignable : {type(e).__name__}", temporary=True) from None
    if r.status_code not in (200, 202):
        raise _refuse(r, key)
    return r


# --- Listes -------------------------------------------------------------------------------------------------------------

async def models(provider: str, kind: str, key: str) -> list[dict]:
    """Les modèles de ce fournisseur pour ce type : [{id, name, created, cost, voices?}], vide s'il n'en propose pas."""
    pattern = KINDS[provider].get(kind)
    if not pattern:
        return []
    if provider == "openai":
        data = (await _send("GET", f"{OPENAI}/models", provider, key, timeout=30)).json().get("data", [])
        ids = [(m["id"], m.get("created") or 0, m["id"]) for m in data]
    else:
        data = (await _send("GET", f"{GEMINI}/models", provider, key, timeout=30, params={"pageSize": 1000})).json().get("models", [])
        wanted = {"image": ("generateContent", "predict"), "video": ("predictLongRunning",), "speech": ("generateContent",),
                  "transcription": ("generateContent",)}[kind]
        ids = [(m["name"].removeprefix("models/"), 0, m.get("displayName") or m["name"].removeprefix("models/")) for m in data
               if not m.get("supportedGenerationMethods") or set(m["supportedGenerationMethods"]) & set(wanted)]
    out = []
    for mid, created, name in sorted(ids, reverse=True):
        if not pattern.search(mid) or (kind == "image" and provider == "gemini" and "tts" in mid):
            continue
        row = {"id": mid, "name": name, "created": created, "cost": {"value": None, "label": PRICE}, "fournisseur": provider}
        if kind == "speech":
            row["voices"] = OPENAI_VOICES if provider == "openai" else GEMINI_VOICES
        out.append(row)
    return out


# --- Image ----------------------------------------------------------------------------------------------------------------

def _size(model: str, aspect: str | None) -> str:
    wide, tall = (aspect in LANDSCAPE), (aspect in PORTRAIT)
    if model.startswith("dall-e-3"):
        return "1792x1024" if wide else "1024x1792" if tall else "1024x1024"
    if model.startswith("dall-e"):
        return "1024x1024"
    return "1536x1024" if wide else "1024x1536" if tall else "1024x1024"


async def image(provider: str, key: str, model: str, prompt: str, aspect: str | None) -> tuple[bytes, str]:
    """(octets, extension)."""
    if provider == "openai":
        body = {"model": model, "prompt": prompt, "n": 1, "size": _size(model, aspect)}
        if model.startswith("dall-e"):
            body["response_format"] = "b64_json"
        item = ((await _send("POST", f"{OPENAI}/images/generations", provider, key, timeout=300, json=body)).json().get("data") or [{}])[0]
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"]), "png"
        raise Refused("Le modèle n'a renvoyé aucune image.")
    if model.startswith("imagen-"):
        body = {"instances": [{"prompt": prompt}], "parameters": {"sampleCount": 1, **({"aspectRatio": aspect} if aspect else {})}}
        item = ((await _send("POST", f"{GEMINI}/models/{model}:predict", provider, key, timeout=300, json=body)).json().get("predictions") or [{}])[0]
        if item.get("bytesBase64Encoded"):
            return base64.b64decode(item["bytesBase64Encoded"]), "jpg" if "jpeg" in item.get("mimeType", "") else "png"
        raise Refused("Le modèle n'a renvoyé aucune image.")
    body = {"contents": [{"parts": [{"text": prompt + (f" (format {aspect})" if aspect else "")}]}], "generationConfig": {"responseModalities": ["IMAGE"]}}
    for candidate in (await _send("POST", f"{GEMINI}/models/{model}:generateContent", provider, key, timeout=300, json=body)).json().get("candidates") or []:
        for part in (candidate.get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") or {}
            if inline.get("data"):
                return base64.b64decode(inline["data"]), {"image/jpeg": "jpg", "image/webp": "webp"}.get(inline.get("mimeType", ""), "png")
    raise Refused("Le modèle n'a renvoyé aucune image.")


# --- Voix -----------------------------------------------------------------------------------------------------------------

def wav(pcm: bytes, rate: int) -> bytes:
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


async def speech(provider: str, key: str, model: str, text: str, voice: str | None) -> tuple[bytes, str]:
    """(octets, type MIME) : du MP3 chez OpenAI, du WAV chez Gemini (qui rend du PCM)."""
    if provider == "openai":
        body = {"model": model, "input": text[:4000], "voice": voice or OPENAI_VOICES[0], "response_format": "mp3"}
        return (await _send("POST", f"{OPENAI}/audio/speech", provider, key, json=body)).content, "audio/mpeg"
    body = {"contents": [{"parts": [{"text": text[:4000]}]}],
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice or GEMINI_VOICES[0]}}}}}
    for candidate in (await _send("POST", f"{GEMINI}/models/{model}:generateContent", provider, key, json=body)).json().get("candidates") or []:
        for part in (candidate.get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") or {}
            if inline.get("data"):
                rate = int((re.search(r"rate=(\d+)", inline.get("mimeType", "")) or [0, 24000])[1])
                return wav(base64.b64decode(inline["data"]), rate), "audio/wav"
    raise Refused("Le modèle n'a renvoyé aucun son.")


GEMINI_AUDIO = {"wav": "audio/wav", "mp3": "audio/mp3", "ogg": "audio/ogg", "flac": "audio/flac", "aac": "audio/aac", "webm": "audio/webm", "m4a": "audio/aac"}


async def transcribe(provider: str, key: str, model: str, audio: bytes, fmt: str, language: str | None) -> str:
    if provider == "openai":
        r = await _send("POST", f"{OPENAI}/audio/transcriptions", provider, key, timeout=60,
                        data={"model": model, **({"language": language} if language else {})}, files={"file": (f"audio.{fmt}", audio)})
        return (r.json().get("text") or "").strip()
    ask = "Transcris cet audio mot pour mot, dans la langue parlée. Réponds seulement par la transcription, sans commentaire."
    body = {"contents": [{"parts": [{"text": ask}, {"inlineData": {"mimeType": GEMINI_AUDIO.get(fmt, "audio/" + fmt), "data": base64.b64encode(audio).decode()}}]}]}
    out = (await _send("POST", f"{GEMINI}/models/{model}:generateContent", provider, key, timeout=60, json=body)).json()
    parts = ((out.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts).strip()


# --- Vidéo ----------------------------------------------------------------------------------------------------------------

async def video(provider: str, key: str, model: str, prompt: str, duration: int | None, aspect: str | None, *, step: float = 5, tries: int = 120) -> bytes:
    """Une tâche asynchrone : on soumet, on attend la fin (jusqu'à 10 minutes), puis on télécharge le MP4."""
    if provider == "openai":
        size = "720x1280" if aspect in PORTRAIT else "1280x720"
        body = {"model": model, "prompt": prompt, "size": size, **({"seconds": str(duration)} if duration else {})}
        job = (await _send("POST", f"{OPENAI}/videos", provider, key, json=body)).json()
        for _ in range(tries):
            if job.get("status") in ("completed", "failed", "cancelled", "expired"):
                break
            await asyncio.sleep(step)
            job = (await _send("GET", f"{OPENAI}/videos/{job['id']}", provider, key, timeout=30)).json()
        if job.get("status") != "completed":
            raise Refused(f"La vidéo n'a pas abouti ({job.get('status')}) : {(job.get('error') or {}).get('message') or 'délai dépassé'}")
        return (await _send("GET", f"{OPENAI}/videos/{job['id']}/content", provider, key, timeout=300)).content
    body = {"instances": [{"prompt": prompt}], "parameters": {**({"aspectRatio": aspect} if aspect in ("16:9", "9:16") else {}),
                                                              **({"durationSeconds": duration} if duration else {})}}
    op = (await _send("POST", f"{GEMINI}/models/{model}:predictLongRunning", provider, key, json=body)).json()
    for _ in range(tries):
        if op.get("done"):
            break
        await asyncio.sleep(step)
        op = (await _send("GET", f"{GEMINI}/{op['name']}", provider, key, timeout=30)).json()
    if not op.get("done") or op.get("error"):
        raise Refused(f"La vidéo n'a pas abouti : {(op.get('error') or {}).get('message') or 'délai dépassé'}")
    samples = ((op.get("response") or {}).get("generateVideoResponse") or {}).get("generatedSamples") or []
    uri = ((samples[0] if samples else {}).get("video") or {}).get("uri")
    if not uri or not uri.startswith(GEMINI.split("/v1beta")[0]):  # la clé ne part que chez Google
        raise Refused("La vidéo est prête mais sans lien de téléchargement.")
    return (await _send("GET", uri, provider, key, timeout=300)).content
