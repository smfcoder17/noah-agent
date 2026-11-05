"""G14.3, vrai agent et vrai navigateur : rien ne tourne avant le premier usage, et il démarre seul quand l'agent navigue.

Noah démarré, son navigateur arrêté (docker stop noah-browser-<agent>) :
    docker cp tests/real/navigateur.py noah-server:/tmp/ && docker exec -w /app -e PYTHONPATH=/app noah-server python /tmp/navigateur.py
"""
import json
import sys
import time

import httpx

from noah import auth, db, hermes

web = httpx.Client(base_url="http://localhost:8080", headers={"Authorization": "Bearer " + auth.new_session(db.owner_id())}, timeout=300)
noah = [a for a in web.get("/api/agents").json() if a["name"] == "Noah"][0]["id"]


def up() -> bool:
    return web.get(f"/api/agents/{noah}/screen-status").json()["reachable"]


bad = []


def check(name, ok, detail=""):
    print("OK   " if ok else "ÉCHEC", name, detail, flush=True)
    if not ok:
        bad.append(name)


check("Le navigateur ne tourne pas avant le premier usage", not up())
t0 = time.monotonic()
reply = ""
with web.stream("POST", "/api/chat", json={"agent_id": noah, "attachments": [], "details": False,
                                           "text": "Ouvre https://example.com dans ton navigateur et donne-moi le titre exact de la page."}) as r:
    for line in r.iter_lines():
        if line.startswith("data:"):
            e = json.loads(line[5:])
            if e.get("type") == "done":
                reply = e.get("output") or ""
took = time.monotonic() - t0
print("     réponse :", reply[:200], flush=True)
check("L'agent navigue sans qu'on allume rien", "Example Domain" in reply, f"{took:.0f} s")
check("Le navigateur tourne maintenant", up())
print(f"\n{'ratés : ' + str(bad) if bad else 'tout est tenu'}")
sys.exit(1 if bad else 0)
