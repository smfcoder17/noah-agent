"""Une seule voix par réponse. Plainte réelle : « je parle et j'entends plusieurs voix », avec plusieurs fournisseurs. La
synthèse passe phrase par phrase, et chaque phrase pouvait basculer sur le modèle de secours, jusqu'au milieu d'une phrase.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \\
      "pip install -q -r /app/requirements.txt && python /tests/voice/une_voix_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import db, media, relay  # noqa: E402

db.init()
db.set_setting("media_api_key", "cle-openrouter", secret=True)


async def two_models(kind, n):
    return ["voix-a", "voix-b"]


async def one_voice(model):
    return {"voix-a": "alice", "voix-b": "bruno"}[model]


async def free(model, chars):
    return 0


media.backups, media.voice_for, media._speech_cost = two_models, one_voice, free
media._check_budget = lambda agent: None
media._record = lambda *a, **k: None


class Cut(httpx.AsyncByteStream):
    """Un début de son, puis la connexion tombe."""

    async def __aiter__(self):
        yield b"debut-coupe|"
        raise httpx.ReadError("coupure")

    async def aclose(self):
        pass


class Out:
    closed = False
    ctype = "audio/mpeg"

    def __init__(self):
        self.data = b""
        self.finished = asyncio.Event()

    def put(self, data):
        if data is None:
            self.finished.set()
        else:
            self.data += data


calls: list[tuple[str, str]] = []
refuse: set[tuple[str, str]] = set()  # (modèle, phrase) refusés
cut: set[str] = set()


def upstream(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    m, text = body["model"], body["input"]
    calls.append((m, text))
    if (m, text) in refuse or (m, "*") in refuse:
        return httpx.Response(429, json={"error": "limite"})
    if text in cut and m == "voix-a":
        return httpx.Response(200, stream=Cut(), headers={"content-type": "audio/mpeg"})
    return httpx.Response(200, content=f"<{m}:{text}>".encode(), headers={"content-type": "audio/mpeg"})


relay._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))


async def speak(*phrases, agent="a1"):
    async def texts():
        for p in phrases:
            yield p
    out = Out()
    await media.speak_stream(agent, texts(), out)
    await asyncio.wait_for(out.finished.wait(), 5)
    return out.data.decode()


async def main():
    # 1. Tout va bien : une voix, les phrases dans l'ordre, sans attendre la fin de la précédente pour demander la suivante.
    heard = await speak("Un.", "Deux.", "Trois.", agent="ok")
    assert heard == "<voix-a:Un.><voix-a:Deux.><voix-a:Trois.>", heard
    print("1. tout va bien : une voix, phrases dans l'ordre")

    # 2. La deuxième phrase est refusée deux fois puis passe : même voix, jamais le secours.
    calls.clear()
    tries = {"n": 0}
    real = relay._client

    def refuse_twice(request):
        body = json.loads(request.content)
        if body["input"] == "Deux." and body["model"] == "voix-a" and tries["n"] < 2:
            tries["n"] += 1
            calls.append((body["model"], body["input"]))
            return httpx.Response(429, json={"error": "limite"})
        return upstream(request)

    relay._client = httpx.AsyncClient(transport=httpx.MockTransport(refuse_twice))
    heard = await speak("Un.", "Deux.", "Trois.", agent="refus")
    relay._client = real
    assert heard == "<voix-a:Un.><voix-a:Deux.><voix-a:Trois.>", heard
    assert not any(m == "voix-b" for m, _ in calls), calls
    print("2. phrase refusée en cours de réponse : réessayée dans la même voix, le secours ne parle pas")

    # 3. Toujours refusée : la phrase manque, l'autre voix ne vient pas, la suite garde la voix.
    calls.clear()
    refuse.add(("voix-a", "Deux."))
    heard = await speak("Un.", "Deux.", "Trois.", agent="perdue")
    refuse.clear()
    assert heard == "<voix-a:Un.><voix-a:Trois.>", heard
    assert not any(m == "voix-b" for m, _ in calls), calls
    print("3. phrase toujours refusée : elle manque, aucune autre voix n'est entendue")

    # 4. Coupure en pleine phrase : ni la fin dans une autre voix, ni la phrase répétée.
    calls.clear()
    cut.add("Deux.")
    heard = await speak("Un.", "Deux.", "Trois.", agent="coupe")
    cut.clear()
    assert heard == "<voix-a:Un.>debut-coupe|<voix-a:Trois.>", heard
    assert not any(m == "voix-b" for m, _ in calls), calls
    print("4. coupure en pleine phrase : la fin ne part pas dans une autre voix")

    # 5. Le modèle choisi est en panne dès le début : le secours parle, et il reste la voix de toute la réponse...
    calls.clear()
    refuse.add(("voix-a", "*"))
    heard = await speak("Un.", "Deux.", agent="secours")
    assert heard == "<voix-b:Un.><voix-b:Deux.>", heard
    print("5. panne avant le premier son : le secours parle, et une seule voix sur toute la réponse")

    # 6. ... et de la réponse suivante du même appel, même si le modèle choisi est revenu.
    refuse.clear()
    calls.clear()
    heard = await speak("Encore.", agent="secours")
    assert heard == "<voix-b:Encore.>", heard
    assert calls == [("voix-b", "Encore.")], calls
    print("6. réponse suivante du même appel : toujours la même voix")

    # 7. Une fois le temps passé, on revient au modèle choisi.
    media._LAST_VOICE["secours"] = ("voix-b", media._LAST_VOICE["secours"][1] - media._VOICE_KEPT - 1)
    heard = await speak("Plus tard.", agent="secours")
    assert heard == "<voix-a:Plus tard.>", heard
    print("7. après quinze minutes de silence : retour au modèle choisi")

    # 8. Tout en panne : du silence, pas d'attente sans fin.
    refuse.update({("voix-a", "*"), ("voix-b", "*")})
    heard = await asyncio.wait_for(speak("Rien.", "Toujours rien.", agent="panne"), 5)
    refuse.clear()
    assert heard == "", heard
    print("8. tous les modèles en panne : silence, et la réponse se termine")


asyncio.run(main())
print("Tout est tenu.")
