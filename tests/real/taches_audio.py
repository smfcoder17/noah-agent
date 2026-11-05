"""Essai isolé du speech-to-speech (H4) : les mêmes scénarios et les mêmes voix, envoyés à un modèle audio d'OpenRouter.

Rien n'est branché dans le produit. Le modèle reçoit le son, répond en son, et dispose d'outils simulés ici : ils écrivent ce
qu'ils reçoivent et rendent une réponse fixe. Cette preuve est donc plus faible que celle de la cascade : aucun vrai agent, aucun
vrai fichier, et le temps d'exécution d'un vrai agent ne compte pas. Rend des observations au format de taches_vocales.mjs,
à passer aux mêmes juges.

    docker cp tests/real/taches_audio.py noah-server:/tmp/ ; docker cp tests/real/taches_vocales.json noah-server:/tmp/
    docker exec -w /app -e PYTHONPATH=/app noah-server python /tmp/taches_audio.py openai/gpt-audio-mini [T04,T07] > obs.json
"""
import asyncio
import base64
import hashlib
import json
import sys
import time

import httpx

from noah import media
from noah.config import DATA_DIR

MODEL = sys.argv[1] if len(sys.argv) > 1 else "openai/gpt-audio-mini"
ONLY = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
LOT = json.load(open("/tmp/taches_vocales.json", encoding="utf-8"))["scenarios"]
SYSTEM = """Tu es Noah, un agent personnel. L'utilisateur te parle à voix haute et tu lui réponds à voix haute, en français, brièvement, sans liste ni mise en forme.
Tu as des outils pour écrire un fichier, demander quelque chose à l'agent Rita, rappeler l'utilisateur, et lire ou créer des fiches. Si aucun outil ne permet de faire ce qui est demandé, dis-le ; n'invente aucun résultat."""
TOOLS = [
    {"type": "function", "function": {"name": name, "description": desc, "parameters": {"type": "object", "properties": props, "required": list(props)}}}
    for name, desc, props in [
        ("ecrire_fichier", "Écrit un fichier dans l'espace de travail.", {"nom": {"type": "string"}, "contenu": {"type": "string"}}),
        ("demander_agent", "Demande un travail à un autre agent. Rend sa réponse.", {"agent": {"type": "string"}, "consigne": {"type": "string"}}),
        ("rappeler", "Fait sonner le téléphone de l'utilisateur et lui lit ce compte rendu.", {"texte": {"type": "string"}}),
        ("lire_fiche", "Lit une fiche de l'outil de fiches.", {"id": {"type": "string"}}),
        ("creer_fiche", "Crée une fiche dans l'outil de fiches.", {"titre": {"type": "string"}}),
    ]
]
FICHES = {"12": "Fiche 12 : bail de la rue Verte, loyer de 840 euros.", "47": "Fiche 47 : commande de trois cartons, livraison lundi matin."}
# La réponse de Rita est écrite à l'avance : on mesure ce que le modèle en fait, pas ce que Rita sait faire.
RITA = {"T10": "264", "T11": "133, écrit dans le fichier resultat.txt", "T12": "93", "T14": "84"}


def audio(text: str) -> tuple[str, str]:
    data = (DATA_DIR / "bench-voix" / (hashlib.sha1(text.encode()).hexdigest()[:16] + ".audio")).read_bytes()
    return base64.b64encode(data).decode(), "wav" if data[:4] == b"RIFF" else "mp3"


class Run:
    def __init__(self, scn: dict) -> None:
        self.scn, self.cost = scn, 0.0
        self.obs = {"id": scn["id"], "envoyes": [], "transcrits": [], "paroles": [], "tri": [], "trames_outil": [], "delegations": [], "rappels": [], "outil": [],
                    "fichiers": [], "reponses_agent": [], "accord_vu": False, "refus_auto": 0, "premier_son": []}
        self.answer = next((s["accord"] for s in scn["plan"] if s.get("accord") in ("autoriser", "refuser")), None)

    def tool(self, name: str, args: dict) -> str:
        scn, obs = self.scn, self.obs
        if name == "ecrire_fichier":
            obs["fichiers"].append({"agent": "Noah", "chemin": str(args.get("nom")), "contenu": str(args.get("contenu"))})
            return "Fichier écrit."
        if name == "demander_agent":
            reply = RITA.get(scn["id"], "Je ne peux pas répondre.")
            obs["delegations"].append({"vers": str(args.get("agent", "")).strip().capitalize(), "etat": "fini", "consigne": str(args.get("consigne")), "rappeler": False, "reponse": reply})
            if scn["id"] == "T11":
                obs["fichiers"].append({"agent": "Rita", "chemin": "resultat.txt", "contenu": "133"})
            return f"Rita a répondu : {reply}"
        if name == "rappeler":
            obs["rappels"].append({"texte": str(args.get("texte")), "etat": "sonne"})
            return "Le téléphone sonne, le compte rendu sera lu."
        if name == "lire_fiche":
            reply = FICHES.get(str(args.get("id")), "Fiche introuvable.")
            obs["outil"].append({"nom": name, "args": args, "reponse": reply})
            return reply
        if name == "creer_fiche":
            if scn.get("droit_outil") == "lire":
                return "Refusé : ton droit sur cet outil est lecture seule."
            obs["accord_vu"] = True
            if self.answer == "autoriser":
                obs["accord_reponse"] = "Autoriser"
                obs["outil"].append({"nom": name, "args": args})
                return "L'utilisateur a autorisé à l'écran. Fiche créée."
            obs["accord_reponse"] = "Refuser"
            return "L'utilisateur a refusé à l'écran. Fiche non créée."
        return "Outil inconnu."

    async def call(self, c: httpx.AsyncClient, messages: list[dict]) -> tuple[str, list[dict], float | None]:
        body = {"model": MODEL, "messages": messages, "tools": TOOLS, "modalities": ["text", "audio"], "audio": {"voice": "alloy", "format": "pcm16"},
                "stream": True, "usage": {"include": True}, "max_tokens": 800}
        text, calls, first = "", {}, None
        t0 = time.monotonic()
        async with c.stream("POST", f"{media.BASE}/chat/completions", json=body, headers=media._headers(), timeout=180) as r:
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code} {(await r.aread()).decode()[:300]}")
            async for line in r.aiter_lines():
                if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                    continue
                j = json.loads(line[5:])
                self.cost += (j.get("usage") or {}).get("cost") or 0
                for ch in j.get("choices", []):
                    d = ch.get("delta") or {}
                    au = d.get("audio") or {}
                    text += au.get("transcript") or d.get("content") or ""
                    if au.get("data") and first is None:
                        first = time.monotonic() - t0
                    for tc in d.get("tool_calls") or []:
                        slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                        slot["id"] = tc.get("id") or slot["id"]
                        fn = tc.get("function") or {}
                        slot["name"] = fn.get("name") or slot["name"]
                        slot["args"] += fn.get("arguments") or ""
        return text.strip(), list(calls.values()), first

    async def play(self, c: httpx.AsyncClient) -> dict:
        messages = [{"role": "system", "content": SYSTEM}]
        t0 = time.monotonic()
        try:
            for step in self.scn["plan"]:
                if "dire" not in step:
                    continue
                self.obs["envoyes"].append(step["dire"])  # le modèle reçoit le son ; rien ne dit ce qu'il a compris
                b64, fmt = audio(step["dire"])
                messages.append({"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": b64, "format": fmt}}]})
                for _ in range(5):
                    text, calls, first = await self.call(c, messages)
                    if first is not None:
                        self.obs["premier_son"].append(round(first, 2))
                    if text:
                        self.obs["paroles"].append({"source": "say", "texte": text, "joue": first is not None, "fini": True, "abandonne": False})
                        self.obs["reponses_agent"].append(text)
                    if not calls:
                        messages.append({"role": "assistant", "content": text or " "})
                        break
                    messages.append({"role": "assistant", "content": text or None, "tool_calls": [{"id": x["id"], "type": "function", "function": {"name": x["name"], "arguments": x["args"] or "{}"}} for x in calls]})
                    for x in calls:
                        try:
                            args = json.loads(x["args"] or "{}")
                        except ValueError:
                            args = {}
                        self.obs["trames_outil"].append(f"outil: {x['name']}")
                        messages.append({"role": "tool", "tool_call_id": x["id"], "content": self.tool(x["name"], args)})
        except Exception as e:  # noqa: BLE001 - un appel en panne est un échec du modèle, écrit tel quel
            self.obs["erreur_banc"] = str(e)[:300]
        self.obs["duree"] = round(time.monotonic() - t0)
        self.obs["cout_compteur"] = self.cost
        return self.obs


async def main() -> None:
    out = {"etiquette": MODEL, "date": time.strftime("%Y-%m-%d %H:%M"), "appels": []}
    async with httpx.AsyncClient() as c:
        for scn in LOT:
            if ONLY and scn["id"] not in ONLY:
                continue
            run = Run(scn)
            out["appels"].append(await run.play(c))
            print(scn["id"], out["appels"][-1].get("erreur_banc", "ok"), [p["texte"][:90] for p in out["appels"][-1]["paroles"]], file=sys.stderr, flush=True)
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
