"""X13 : image, vidéo et voix avec la clé de n'importe quel fournisseur branché. Une image avec une clé OpenAI, une voix avec une clé Gemini, la
dictée de chacun, une vidéo chez les deux, OpenRouter débranché. Faux serveurs aux formats réels des API (OpenAI : images/generations, audio/speech,
audio/transcriptions, videos ; Gemini : generateContent, predictLongRunning), aucun réseau.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/providers/medias_test.py"
"""
import asyncio
import base64
import json
import os
import sys
import tempfile


os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import db, media, mediaprov, modes, providers, relay  # noqa: E402

db.init()
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key) VALUES ('a1', 'Noah', '', 'k')")

OPENAI_KEY, GEMINI_KEY = "sk-openai-cle-de-test", "AIza-gemini-cle-de-test"
PNG = b"\x89PNG\r\n\x1a\n" + b"image-openai"
PCM = b"\x01\x02" * 480
seen: list[httpx.Request] = []
polls = {"n": 0}


def upstream(request: httpx.Request) -> httpx.Response:
    seen.append(request)
    host, path = request.url.host, request.url.path
    assert host != "openrouter.ai", "OpenRouter est débranché : rien ne doit partir chez lui"
    if host == "api.openai.com":
        assert request.headers["authorization"] == f"Bearer {OPENAI_KEY}", "la clé d'OpenAI ne part que chez OpenAI"
        if path == "/v1/models":
            ids = ["gpt-4o", "gpt-image-1", "dall-e-3", "gpt-4o-mini-tts", "tts-1", "whisper-1", "gpt-4o-transcribe", "sora-2", "text-embedding-3-small"]
            return httpx.Response(200, json={"object": "list", "data": [{"id": i, "object": "model", "created": 1700000000, "owned_by": "openai"} for i in ids]})
        if path == "/v1/images/generations":
            return httpx.Response(200, json={"created": 1, "data": [{"b64_json": base64.b64encode(PNG).decode()}], "usage": {"total_tokens": 100}})
        if path == "/v1/audio/speech":
            return httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=b"ID3-openai-voix")
        if path == "/v1/audio/transcriptions":
            assert b'name="file"' in request.content and b"whisper-1" in request.content, "multipart comme l'API OpenAI"
            return httpx.Response(200, json={"text": "bonjour par openai"})
        if path == "/v1/videos":
            return httpx.Response(200, json={"id": "video_123", "object": "video", "status": "queued", "progress": 0})
        if path == "/v1/videos/video_123":
            polls["n"] += 1
            return httpx.Response(200, json={"id": "video_123", "object": "video", "status": "completed" if polls["n"] > 1 else "in_progress", "progress": 100})
        if path == "/v1/videos/video_123/content":
            return httpx.Response(200, headers={"content-type": "video/mp4"}, content=b"mp4-sora")
    if host == "generativelanguage.googleapis.com":
        assert request.headers["x-goog-api-key"] == GEMINI_KEY and "authorization" not in request.headers, "la clé de Gemini ne part que chez Google"
        if path == "/v1beta/models":
            models = [("gemini-2.5-pro", ["generateContent"]), ("gemini-2.5-flash", ["generateContent"]), ("gemini-2.5-flash-image", ["generateContent"]),
                      ("imagen-4.0-generate-001", ["predict"]), ("gemini-2.5-flash-preview-tts", ["generateContent"]),
                      ("veo-3.1-fast-generate-preview", ["predictLongRunning"]), ("text-embedding-004", ["embedContent"])]
            return httpx.Response(200, json={"models": [{"name": f"models/{n}", "displayName": n, "supportedGenerationMethods": m} for n, m in models]})
        body = json.loads(request.content) if request.content else {}
        if path.endswith("gemini-2.5-flash-image:generateContent"):
            assert body["generationConfig"]["responseModalities"] == ["IMAGE"]
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(PNG).decode()}}]}}]})
        if path.endswith("gemini-2.5-flash-preview-tts:generateContent"):
            assert body["generationConfig"]["responseModalities"] == ["AUDIO"]
            voice = body["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"]
            assert voice in mediaprov.GEMINI_VOICES
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "audio/L16;codec=pcm;rate=24000", "data": base64.b64encode(PCM).decode()}}]}}]})
        if path.endswith("gemini-2.5-flash:generateContent"):
            assert body["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "audio/wav"
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "bonjour par gemini"}]}}]})
        if path.endswith("veo-3.1-fast-generate-preview:predictLongRunning"):
            return httpx.Response(200, json={"name": "models/veo-3.1-fast-generate-preview/operations/op-9"})
        if path == "/v1beta/models/veo-3.1-fast-generate-preview/operations/op-9":
            return httpx.Response(200, json={"name": "x", "done": True, "response": {"generateVideoResponse": {"generatedSamples": [
                {"video": {"uri": "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media"}}]}}})
        if path == "/v1beta/files/abc:download":
            return httpx.Response(200, content=b"mp4-veo")
    raise AssertionError(f"route inattendue : {host}{path}")


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
real_sleep = asyncio.sleep
mediaprov.asyncio.sleep = lambda s: real_sleep(0)  # les attentes de la vidéo ne comptent pas ici

# OpenRouter n'est pas branché : ni clé du cerveau, ni clé de création. OpenAI et Gemini le sont, par leur propre clé.
providers.remember("openai", OPENAI_KEY, None)
providers.remember("gemini", GEMINI_KEY, None)
db.set_setting("provider", "openai")
db.set_setting("model", "gpt-5")
db.set_setting("api_key", OPENAI_KEY, secret=True)
assert set(media.capable_keys()) == {"openai", "gemini"}, media.capable_keys()
print("0. sans OpenRouter, OpenAI et Gemini suffisent à créer et à parler")


async def main_test() -> None:
    # --- Les listes de modèles de chaque fournisseur branché ---------------------------------------------------------------------------
    async def listed(kind):
        return {m["id"]: m["fournisseur"] for m in await media.models(kind)}

    assert await listed("image") == {"gpt-image-1": "openai", "dall-e-3": "openai", "gemini-2.5-flash-image": "gemini", "imagen-4.0-generate-001": "gemini"}, await listed("image")
    assert await listed("speech") == {"gpt-4o-mini-tts": "openai", "tts-1": "openai", "gemini-2.5-flash-preview-tts": "gemini"}
    assert await listed("transcription") == {"whisper-1": "openai", "gpt-4o-transcribe": "openai", "gemini-2.5-flash": "gemini"}
    assert await listed("video") == {"sora-2": "openai", "veo-3.1-fast-generate-preview": "gemini"}
    assert await listed("music") == {}, "la musique reste à OpenRouter : aucun des deux ne la propose par une clé simple"
    voices = next(m["voices"] for m in await media.models("speech") if m["id"] == "gemini-2.5-flash-preview-tts")
    assert "Kore" in voices
    print("1. chaque fournisseur branché liste ses modèles d'image, de voix, de dictée et de vidéo")

    # La liste se présente à l'écran comme celle d'un niveau de modes : chaque modèle avec son fournisseur.
    rows = await modes.available("image")
    assert {(r["id"], r["fournisseur"]) for r in rows} >= {("gpt-image-1", "openai"), ("gemini-2.5-flash-image", "gemini")}

    # --- Une image avec la clé OpenAI ----------------------------------------------------------------------------------------------
    assert media.setting("image") == "auto" and await media.auto_choice("image") == "gpt-image-1"
    data, ext, model = await media.image("a1", "un chat sur un toit", "16:9")
    request = [r for r in seen if r.url.path == "/v1/images/generations"][-1]
    assert (data, ext, model) == (PNG, "png", "gpt-image-1")
    assert json.loads(request.content) == {"model": "gpt-image-1", "prompt": "un chat sur un toit", "n": 1, "size": "1536x1024"}
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) AS n FROM usage WHERE model = 'gpt-image-1'").fetchone()["n"] == 1, "l'appel est compté"
    print("2. une image est créée avec la clé OpenAI (gpt-image-1, 1536x1024), OpenRouter débranché")

    # --- Une voix avec la clé Gemini ------------------------------------------------------------------------------------------------
    db.set_setting("media_speech", "gemini-2.5-flash-preview-tts")
    audio, ctype, model = await media.speak("a1", "Bonjour, ceci est un essai.")
    assert model == "gemini-2.5-flash-preview-tts" and ctype == "audio/wav" and audio[:4] == b"RIFF" and audio.endswith(PCM), (ctype, audio[:8])
    assert [r for r in seen if r.url.path.endswith("preview-tts:generateContent")], "la voix est partie chez Google"
    print("3. une voix est créée avec la clé Gemini (PCM 24 kHz rendu en WAV), OpenRouter débranché")

    # --- La voix qui parle au fil de l'eau (mode vocal), même fournisseur --------------------------------------------------------------------
    out = media.AudioStream()
    await media.speak_stream("a1", media._drain_list(["Bonjour.", "Et la suite."]), out)
    sent = []
    while not out.queue.empty():
        sent.append(out.queue.get_nowait())
    body = b"".join(x for x in sent if x)
    assert out.ctype == "audio/wav" and body[:4] == b"RIFF" and body.endswith(PCM + PCM), "deux phrases, un seul en-tête WAV"
    print("4. la voix du mode vocal passe aussi par Gemini, phrase par phrase")

    # --- Un autre fournisseur pour la même fonction : OpenAI parle ----------------------------------------------------------------------------
    db.set_setting("media_speech", "gpt-4o-mini-tts")
    audio, ctype, model = await media.speak("a1", "Bonjour.")
    assert (audio, ctype, model) == (b"ID3-openai-voix", "audio/mpeg", "gpt-4o-mini-tts")
    assert json.loads([r for r in seen if r.url.path == "/v1/audio/speech"][-1].content)["voice"] == "alloy"

    # --- La dictée, des deux côtés ----------------------------------------------------------------------------------------------------------------
    assert await media.transcribe("a1", b"RIFFxxxxWAVE", "wav") == "bonjour par openai", "en automatique : le premier du classement"
    db.set_setting("media_transcription", "gemini-2.5-flash")
    assert await media.transcribe("a1", b"RIFFxxxxWAVE", "wav") == "bonjour par gemini"
    print("5. la dictée passe par OpenAI (whisper-1, multipart) ou par Gemini (audio dans generateContent)")

    # --- La vidéo : tâche asynchrone chez chacun ------------------------------------------------------------------------------------------------------
    db.set_setting("media_video", "sora-2")
    assert (await media.video("a1", "une vague", 4, "16:9"))[0] == b"mp4-sora"
    db.set_setting("media_video", "veo-3.1-fast-generate-preview")
    assert (await media.video("a1", "une vague", None, "16:9"))[0] == b"mp4-veo"
    print("6. une vidéo chez OpenAI (Sora : soumise, attendue, téléchargée) et chez Google (Veo : opération longue)")

    # --- Une image chez Gemini, modèle choisi -------------------------------------------------------------------------------------------------------------
    db.set_setting("media_image", "gemini-2.5-flash-image")
    assert (await media.image("a1", "un logo", None))[2] == "gemini-2.5-flash-image"

    # --- Le refus d'un fournisseur s'explique, sans la clé -----------------------------------------------------------------------------------------------
    err_before = len(seen)

    def refuse(request):
        return httpx.Response(401, json={"error": {"message": f"Incorrect API key provided: {OPENAI_KEY}", "type": "invalid_request_error"}})

    real = relay._client
    relay._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: refuse(r) if r.url.path == "/v1/images/generations" else upstream(r)))
    db.set_setting("media_image", "gpt-image-1")
    try:
        await media.image("a1", "x", None)
    except media.MediaError as e:
        assert OPENAI_KEY not in str(e) and "401" in str(e), str(e)
    else:
        raise AssertionError("une clé refusée doit se dire")
    relay._client = real
    assert err_before <= len(seen)
    print("7. une clé refusée : le message est lisible et ne répète jamais la clé")

    # --- Sans aucun fournisseur capable, une phrase claire -------------------------------------------------------------------------------------------------
    providers.remember("openai", None, None)
    providers.remember("gemini", None, None)
    db.set_setting("api_key", "", secret=False)
    media._cache.clear()
    try:
        await media.models("image")
    except media.MediaError as e:
        assert "OpenRouter, OpenAI, Google Gemini" in str(e)
    else:
        raise AssertionError("aucun fournisseur : une phrase pour l'écran")
    print("8. sans fournisseur capable, la phrase dit lesquels brancher")


asyncio.run(main_test())
print("médias par fournisseur : tout est vert")
