"""Banc du mode vocal : ce qu'on entend depuis la fin de la parole, et non depuis la fin de la transcription.

Usage, dans le conteneur du serveur : python -m apollo.bench_voice <étiquette> <répétitions> [travail|reserve|garde]
Le lot réservé vit hors du dépôt (/data/bench-voix/reserve.json), écrit par un autre modèle, et ne rend que son score.

Ce banc mesure le serveur seul : transcription, premier octet de la voix, tri, erreurs de mots, coût. Le temps entendu
se mesure dans le vrai composant : node tools/eval/voice_browser.mjs. Les voix de test viennent de la synthèse, plus
faciles qu'une vraie voix : la transcription est ici un plafond.
"""
import asyncio
import base64
import hashlib
import json
import re
import statistics
import sys
import time
import unicodedata
import uuid

import httpx

from . import auth, db, media
from .config import DATA_DIR

BASE = "http://localhost:8080"

VERSION = 2
# (phrase, l'agent doit-il agir ?). Lots figés : version 2. Un cas changé rend les anciens scores incomparables.
CORPUS = {
    "travail": [
        ("Salut, tu vas bien ?", False),
        ("Regarde mes derniers courriels et dis-moi ce qui est urgent.", True),
        ("C'est quoi la capitale de l'Australie ?", False),
        ("Crée un fichier avec la liste des courses pour ce soir.", True),
        ("Où est-ce qu'on en est sur le rapport de vendredi ?", True),
        ("Merci, c'est parfait.", False),
        ("Demande à l'autre agent de préparer le résumé de la réunion.", True),
        ("Explique-moi en deux phrases ce qu'est un conteneur Docker.", False),
        ("Programme un rappel demain matin à huit heures.", True),
        ("Cherche le prix actuel du billet Montréal Paris en décembre.", True),
        ("Pourquoi le ciel est-il bleu ?", False),
        ("Ouvre mon agenda et bloque deux heures jeudi après-midi.", True),
        ("Tu peux répéter ce que tu viens de dire ?", False),
        ("Trouve les trois derniers articles sur la sécurité de Docker et résume-les.", True),
    ],
    "garde": [
        ("Bonjour.", False),
        ("Envoie un courriel à Marie pour confirmer le rendez-vous.", True),
    ],
}
# Une phrase coupée par une longue pause : les deux moitiés sont dites avec un silence entre elles (navigateur seulement).
PAUSES = [
    ("Demande à l'autre agent", "de préparer le résumé de la réunion."),
    ("Je voudrais que tu regardes", "les courriels de ce matin."),
    ("Crée un fichier avec la liste des courses", "et ajoute le lait."),
]


def corpus(lot: str) -> list:
    if lot == "reserve":
        return json.loads((DATA_DIR / "bench-voix/reserve.json").read_text(encoding="utf-8"))
    return CORPUS[lot]


def _words(text: str) -> list[str]:
    plain = "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")
    return re.findall(r"[a-z0-9]+", plain)


def word_errors(reference: str, heard: str) -> tuple[int, int]:
    """Distance d'édition sur les mots, et nombre de mots de la référence."""
    a, b = _words(reference), _words(heard)
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1], len(a)


def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


async def _fixture(agent: str, sentence: str) -> tuple[bytes, str]:
    folder = DATA_DIR / "bench-voix"
    folder.mkdir(exist_ok=True)
    path = folder / (hashlib.sha1(sentence.encode()).hexdigest()[:16] + ".audio")
    if not path.exists():
        data, _, _ = await media.speak(agent, sentence)
        path.write_bytes(data)
    data = path.read_bytes()
    return data, "wav" if data[:4] == b"RIFF" else "mp3"


async def _turn(c: httpx.AsyncClient, agent: str, sentence: str, expected: bool, audio: bytes, fmt: str) -> dict:
    t0 = time.perf_counter()
    r = await c.post(f"{BASE}/api/voice/transcribe", params={"format": fmt, "agent_id": agent}, content=audio,
                     headers={"Content-Type": "application/octet-stream"})
    r.raise_for_status()
    heard = r.json()["text"]
    stt = (time.perf_counter() - t0) * 1000

    sid = uuid.uuid4().hex
    t0 = time.perf_counter()

    async def listen() -> float | None:
        async with c.stream("GET", f"{BASE}/api/voice/audio/{sid}") as s:
            if s.status_code != 200:
                return None
            async for _ in s.aiter_bytes():
                return (time.perf_counter() - t0) * 1000
        return None

    first, answer = await asyncio.gather(listen(), c.post(f"{BASE}/api/voice/reply", json={
        "agent_id": agent, "text": heard, "history": [], "mode": "turn", "audio_id": sid}))
    answer.raise_for_status()
    errors, words = word_errors(sentence, heard)
    return {
        "stt": round(stt), "premier_octet": round(first) if first else None,
        "action_juste": bool(answer.json().get("action")) == expected, "erreurs": errors, "mots": words,
    }


def _cost() -> float:
    with db.connect() as c:
        return c.execute("SELECT COALESCE(SUM(cost), 0) AS s FROM usage").fetchone()["s"]


async def _dump(lot: str) -> None:
    """Les voix du lot, pour le banc du navigateur."""
    with db.connect() as c:
        agent = c.execute("SELECT id FROM agents ORDER BY pinned DESC, created_at LIMIT 1").fetchone()["id"]

    async def voice(text: str) -> str:
        return base64.b64encode((await _fixture(agent, text))[0]).decode()

    if lot == "pauses":
        out = [[await voice(x), await voice(y)] for x, y in PAUSES]
    else:
        out = [[await voice(text), action] for text, action in corpus(lot)]
    print(json.dumps(out))


async def main() -> None:
    if sys.argv[1:2] == ["corpus"]:
        return await _dump(sys.argv[2])
    label = sys.argv[1] if len(sys.argv) > 1 else "mesure"
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    lot = sys.argv[3] if len(sys.argv) > 3 else "travail"
    with db.connect() as c:
        user = db.owner_id()
        agent = c.execute("SELECT id FROM agents WHERE owner_id = ? ORDER BY pinned DESC, created_at LIMIT 1", (user,)).fetchone()["id"]
    token = auth.new_session(user)
    cases = corpus(lot)
    voices = [await _fixture(agent, sentence) for sentence, _ in cases]  # avant le compteur : leur coût n'est pas celui du tour
    rows, spent = [], _cost()
    try:
        async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=120) as c:
            for case, ((sentence, expected), (audio, fmt)) in enumerate(zip(cases, voices)):
                for run in range(reps):
                    try:
                        rows.append({"case": case, "run": run, **await _turn(c, agent, sentence, expected, audio, fmt)})
                    except httpx.HTTPError as e:
                        rows.append({"case": case, "run": run, "echec": type(e).__name__})
    finally:
        auth.drop_session(token)
    good = [r for r in rows if r.get("premier_octet")]
    out = {
        "etiquette": label, "date": time.strftime("%Y-%m-%d %H:%M"), "version": VERSION, "lot": lot, "tours": len(rows), "echecs": len(rows) - len(good),
        "premier_octet_mediane": round(statistics.median(r["premier_octet"] for r in good)) if good else None,
        "premier_octet_p95": round(_percentile([r["premier_octet"] for r in good], 0.95)) if good else None,
        "stt_mediane": round(statistics.median(r["stt"] for r in good)) if good else None,
        # Un tour en échec compte comme un mauvais tri : un banc qui ignore ses échecs flatte le résultat.
        "tri_action_juste": round(sum(r["action_juste"] for r in good) / max(1, len(rows)), 3),
        # Total des erreurs sur total des mots : une phrase d'un mot ne pèse pas autant qu'une longue commande.
        "erreurs_mots": round(sum(r["erreurs"] for r in good) / max(1, sum(r["mots"] for r in good)), 3),
        "cout_par_tour": round((_cost() - spent) / max(1, len(rows)), 5),
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if lot != "reserve":
        print(json.dumps(rows, ensure_ascii=False))
    with (DATA_DIR / "bench-voix.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({**out, "lignes": rows if lot != "reserve" else None}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
