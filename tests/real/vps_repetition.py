"""Répétition de J1, J2 et J3 sur un VPS simulé : Docker dans Docker, installé par get.sh, joint par Caddy en HTTPS.

Ce que ça ne prouve pas : un vrai VPS, un vrai certificat, le téléchargement des images, une vraie app, la 4G.
Le client ne parle qu'à l'adresse HTTPS publique, comme un appareil de l'extérieur.

    docker exec noah-vps docker run --rm --network host --add-host noah.test:127.0.0.1 -e NOAH_CODE=<code> -e NOAH_OLLAMA=<adresse> \
      -v /src/tests:/t ghcr.io/smfcoder17/noah-server:stable python /t/real/vps_repetition.py [apres-redemarrage]
"""
import json
import os
import secrets
import sys
import time

import httpx

BASE = os.environ.get("NOAH_BASE", "https://noah.test")
VERIFY = os.environ.get("NOAH_VERIFY") == "1"  # un vrai certificat sur un vrai serveur
MODEL = os.environ.get("NOAH_MODEL", "deepseek-v4.1-flash:cloud")
BAD = []


def check(name, ok, detail=""):
    print("OK   " if ok else "ÉCHEC", name, detail, flush=True)
    if not ok:
        BAD.append(name)


def client(token=None):
    # Sans autorité publique pour noah.test, Caddy signe lui-même : seule la vérification du certificat est retirée.
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.Client(base_url=BASE, verify=VERIFY, timeout=60, headers=headers)


def say(c, agent, text):
    t0 = time.monotonic()
    out = ""
    with c.stream("POST", "/api/chat", json={"agent_id": agent, "text": text, "attachments": [], "details": False}, timeout=240) as r:
        if r.status_code != 200:
            return f"[{r.status_code}]", 0
        for line in r.iter_lines():
            if line.startswith("data:"):
                e = json.loads(line[5:])
                if e.get("type") == "done":
                    out = e.get("output") or ""
    return out, time.monotonic() - t0


def pair(owner, kind, name):
    code = owner.post("/api/pairing").json()["code"]
    phone = client()
    claim = phone.post("/api/pairing/claim", json={"code": code, "appareil": name, "type": kind}).json()
    check(f"{name} : le code est accepté, en attente d'accord", bool(claim.get("attente")))
    check(f"{name} : pas de session avant l'accord", phone.post("/api/pairing/flow/poll", json={"sondage": claim["sondage"]}).status_code == 202)
    demand = [d for d in owner.get("/api/pairing/pending").json()["demandes"] if d["appareil"] == name][0]
    wrong = str((int(claim["verification"]) % 900) + 100)
    assert wrong != claim["verification"]
    ok = owner.post(f"/api/pairing/flow/{demand['id']}/autoriser", json={"verification": claim["verification"]})
    check(f"{name} : accord avec le nombre affiché", ok.status_code == 200, ok.text[:100])
    token = phone.post("/api/pairing/flow/poll", json={"sondage": claim["sondage"]}).json().get("token")
    check(f"{name} : session reçue", bool(token))
    again = client().post("/api/pairing/claim", json={"code": code, "appareil": "Autre", "type": kind})
    check(f"{name} : le code ne sert qu'une fois", again.status_code == 400, str(again.status_code))
    return token


def first_install() -> None:
    t0 = time.monotonic()
    web = client()
    status = web.get("/api/status")
    check("Noah répond en HTTPS", status.status_code == 200, f"{status.json()}"[:120])
    check("Sans code d'installation, pas de compte", web.post("/api/setup/account", json={"username": "moi", "password": "x" * 12}).status_code == 403)
    password = secrets.token_urlsafe(12)
    account = web.post("/api/setup/account", json={"username": "moi", "password": password, "installation": os.environ["NOAH_CODE"]})
    check("Compte créé avec le code", account.status_code == 200, account.text[:120])
    token = account.json().get("token") or web.cookies.get("apollo_session")
    owner = client(token)
    again = client().post("/api/setup/account", json={"username": "autre", "password": "x" * 12, "installation": os.environ["NOAH_CODE"]})
    check("Le code ne sert qu'une fois", again.status_code in (400, 403, 409, 410), str(again.status_code))

    chosen = owner.post("/api/model", json={"provider": "ollama", "model": MODEL, "base_url": os.environ["NOAH_OLLAMA"]})
    check("Modèle choisi : Ollama par son adresse", chosen.status_code == 200, chosen.text[:200])
    agent = None
    t1 = time.monotonic()
    while time.monotonic() - t1 < 300:
        agents = owner.get("/api/agents").json()
        if agents and agents[0]["online"] and not agents[0].get("step"):
            agent = agents[0]["id"]
            break
        time.sleep(3)
    check("Premier agent prêt", bool(agent), f"{time.monotonic() - t1:.0f} s")
    if not agent:
        return
    reply, took = say(owner, agent, "Réponds seulement : PRET.")
    check("Première réponse de l'agent", "PRET" in reply.upper(), f"{reply[:80]!r}, {took:.0f} s")
    print(f"     de l'ouverture à la première réponse : {time.monotonic() - t0:.0f} s", flush=True)
    done = owner.post("/api/setup/done")
    check("Assistant terminé : le modèle a vraiment répondu", done.status_code == 200, done.text[:120])

    # J2 et J3 : la même demande que l'app de bureau et l'app mobile, sans leur coque.
    phone = pair(owner, "android", "Téléphone d'essai")
    desktop = pair(owner, "desktop", "Bureau d'essai")
    for name, token_ in (("Téléphone", phone), ("Bureau", desktop)):
        reply, took = say(client(token_), agent, f"Réponds seulement : {name.upper()} OK.")
        check(f"{name} : conversation avec l'agent du VPS", "OK" in reply.upper(), f"{reply[:60]!r}, {took:.0f} s")
    devices = owner.get("/api/devices").json()
    check("Les appareils sont listés", len(devices if isinstance(devices, list) else devices.get("appareils", [])) >= 3)
    print("ETAT " + json.dumps({"phone": phone, "agent": agent}), flush=True)


def after_reboot() -> None:
    """La machine a redémarré : tout repart seul, l'appareil reste relié, l'agent répond."""
    state = json.loads(os.environ["NOAH_ETAT"])
    phone = client(state["phone"])
    t0 = time.monotonic()
    ready = False
    while time.monotonic() - t0 < 300:
        try:
            agents = phone.get("/api/agents")
            if agents.status_code == 200 and agents.json() and agents.json()[0]["online"]:
                ready = True
                break
        except httpx.HTTPError:
            pass
        time.sleep(3)
    check("Après le redémarrage : Noah et l'agent reviennent seuls", ready, f"{time.monotonic() - t0:.0f} s")
    reply, took = say(phone, state["agent"], "Réponds seulement : ENCORE LA.")
    check("Le téléphone reste relié et l'agent répond", "ENCORE" in reply.upper(), f"{reply[:60]!r}, {took:.0f} s")


after_reboot() if sys.argv[1:] == ["apres-redemarrage"] else first_install()
print(f"\n{'ratés : ' + str(BAD) if BAD else 'tout est tenu'}")
sys.exit(1 if BAD else 0)
