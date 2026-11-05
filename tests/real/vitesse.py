"""Découpe du temps d'un message court sur le vrai chemin : serveur, conteneur Hermes, relais, faux fournisseur à latence connue.

Dans le conteneur du serveur (pile d'essai de compose.essai.yml, faux_services.py derrière le relais) :
    docker exec -w /app -e PYTHONPATH=/app noah-server python /t/vitesse.py [--latence 0.3] [--tours 8] [--texte bonjour] [--agent <id>]

Toutes les horloges sont celles de la même machine : l'instant où le faux fournisseur a reçu la requête découpe le temps en
« avant le modèle » (notre part) et « après le modèle » (le chemin du retour). Ne dépense rien.
"""
import argparse
import json
import random
import statistics
import time
import uuid

import httpx

from noah import auth, db

BASE = "http://localhost:8080"
FAUX = "http://noah-faux:11500"


def _median(values: list) -> int | None:
    kept = [v for v in values if v is not None]
    return round(statistics.median(kept)) if kept else None


def tour(c: httpx.Client, agent: str, conv: str | None, text: str) -> dict:
    c.post(f"{FAUX}/_vider", json={})
    t0 = time.time()
    marks: dict[str, float] = {}
    kinds: list[str] = []
    answer = ""
    with c.stream("POST", f"{BASE}/api/chat", json={"agent_id": agent, "text": text, "conversation_id": conv, "attachments": [], "details": False}) as r:
        r.raise_for_status()
        buf = ""
        for chunk in r.iter_text():
            buf += chunk
            while "\n\n" in buf:
                frame, buf = buf.split("\n\n", 1)
                if not frame.startswith("data:"):
                    continue
                ev = json.loads(frame[5:])
                now = (time.time() - t0) * 1000
                kind = ev.get("type")
                kinds.append(kind + (f":{ev.get('label')}" if kind == "activity" else ""))
                marks.setdefault(kind, now)
                if kind in ("activity", "message"):
                    marks.setdefault("reaction", now)
                if kind == "message":
                    answer += ev.get("text", "")
                if kind == "start":
                    conv = ev.get("conversation_id") or conv
                if kind == "done":
                    answer = answer or ev.get("output") or ""
    end = (time.time() - t0) * 1000
    calls = c.get(f"{FAUX}/_journal").json()["appels"]
    first = calls[0] if calls else None
    return {"conv": conv, "start": marks.get("start"), "avant_modele": (first["t"] - t0) * 1000 if first else None, "reaction": marks.get("reaction"),
            "premier_mot": marks.get("message"), "fin": marks.get("done", end), "allers_retours": len(calls), "premier_appel": first, "tous": calls, "evenements": kinds, "reponse": answer}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--latence", type=float, default=0)
    p.add_argument("--tours", type=int, default=8)
    p.add_argument("--texte", default="bonjour")
    p.add_argument("--agent")
    p.add_argument("--dump", action="store_true", help="écrit le prompt système et les schémas dans /tmp/vitesse-*.json")
    p.add_argument("--nouvelle", action="store_true", help="une conversation neuve à chaque tour (premier message d'une conversation)")
    p.add_argument("--histoire", type=int, default=0, help="jetons d'historique à créer avant de mesurer, sur le faux modèle (2 000 par réponse)")
    p.add_argument("--par-reponse", type=int, default=2000)
    p.add_argument("--outils", action="store_true")
    p.add_argument("--pause", type=float, default=0, help="secondes entre deux tours de l'historique : le temps qu'une personne écrive")
    p.add_argument("--latence-resume", type=float, default=0, help="délai du faux modèle pendant l'historique et le résumé")
    a = p.parse_args()
    user = db.owner_id()
    token = auth.new_session(user)
    with db.connect() as d:
        agent = a.agent or d.execute("SELECT id FROM agents WHERE owner_id = ? ORDER BY pinned DESC, created_at LIMIT 1", (user,)).fetchone()["id"]
    with httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=300) as c:
        conv = None
        if a.histoire:
            conv = uuid.uuid4().hex
            with db.connect() as d:
                d.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, origin, archived) VALUES (?, ?, ?, 'Mesure', 0, 'agent', 1)", (conv, user, agent))
            c.post(f"{FAUX}/_latence", json={"jetons_reels": True, "latence_resume": a.latence_resume})
            words = "rapport page liens formulaire paragraphe texte compte personne navigateur connexion service fichier réglage mesure tableau courriel agenda".split()
            size = 0
            while size < a.histoire:  # du texte qui ne se répète pas : Hermes coupe une réponse qui boucle
                text = " ".join(random.choice(words) + str(random.randint(0, 999)) for _ in range(a.par_reponse * 4 // 12))
                # --outils : du volume en résultats d'outil, comme une page ou un fichier lu, que Hermes peut réduire sans modèle
                tool = [{"outil": "terminal", "args": {"command": f"seq {random.randint(1, 999)} {a.par_reponse * 4 // 5}"}}] if a.outils else []
                c.post(f"{FAUX}/_suite", json={"suite": [*tool, {"texte": "Vu." if a.outils else text}]})
                row = tour(c, agent, conv, "Continue s'il te plaît.")
                size += a.par_reponse
                print(f"  {size} jetons fabriqués : première réaction {round(row['reaction'] or 0)} ms, appels {[x['octets'] // 4 for x in row['tous']]}")
                time.sleep(a.pause)
            c.post(f"{FAUX}/_suite", json={"suite": []})
        c.post(f"{FAUX}/_latence", json={"latence": a.latence, "jetons_reels": bool(a.histoire), "latence_resume": a.latence_resume})
        rows = []
        for _ in range(a.tours):
            if a.nouvelle or conv is None:
                conv = uuid.uuid4().hex
                with db.connect() as d:
                    d.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, origin, archived) VALUES (?, ?, ?, 'Mesure', 0, 'agent', 1)", (conv, user, agent))
            rows.append(tour(c, agent, conv, a.texte))
            time.sleep(0.2)
        c.post(f"{FAUX}/_latence", json={"latence": 0})
    keys = ("start", "avant_modele", "reaction", "premier_mot", "fin")
    summary = {k: _median([r[k] for r in rows]) for k in keys}
    firsts = [r["premier_appel"] for r in rows if r["premier_appel"]]
    if any(c.get("t_premier_octet") for c in firsts):  # vrai fournisseur derrière le faux : sa part, mesurée à sa porte
        summary["fournisseur"] = {
            "premier_octet": _median([(c["t_premier_octet"] - c["t"]) * 1000 for c in firsts if c.get("t_premier_octet")]),
            "premier_mot": _median([(c["t_premier_mot"] - c["t"]) * 1000 for c in firsts if c.get("t_premier_mot")]),
            "premier_outil": _median([(c["t_premier_outil"] - c["t"]) * 1000 for c in firsts if c.get("t_premier_outil")]),
            "raisonnement_vu": sum(1 for c in firsts if c.get("t_premier_raisonnement")),
            "outils_appeles": [c.get("outils_appeles") for c in firsts],
            "usage": [{k: (c.get("usage") or {}).get(k) for k in ("prompt_tokens", "completion_tokens")} | {"cache": ((c.get("usage") or {}).get("prompt_tokens_details") or {}).get("cached_tokens")} for c in firsts],
            "textes": [str(c.get("texte"))[:80] for c in firsts],
            "erreurs": [c["erreur"] for c in firsts if c.get("erreur")],
        }
    summary["premier_tour"] = {k: round(rows[0][k]) if rows[0][k] else None for k in keys}
    last = rows[-1]
    call = last["premier_appel"] or {}
    summary |= {"latence_fournisseur_ms": round(a.latence * 1000), "tours": a.tours, "allers_retours": sorted({r["allers_retours"] for r in rows}), "evenements": last["evenements"][:6], "reponse": last["reponse"][:120],
                "octets_systeme": call.get("octets_systeme"), "octets_outils": call.get("octets_outils"), "octets_requete": call.get("octets"), "nb_outils": len(call.get("outils") or []),
                "jetons_estimes": round((call.get("octets") or 0) / 4), "parametres": call.get("parametres")}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    if a.dump and call:
        with open("/tmp/vitesse-appel.json", "w", encoding="utf-8") as f:
            json.dump(last["tous"], f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
