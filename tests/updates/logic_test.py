"""Logique des mises à jour côté serveur : signature, versions en attente, créneau calme, reports.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim \
      sh -c "pip install -q -r /app/requirements.txt && python /tests/updates/logic_test.py"
"""
import base64
import json
import os
import sys
import tempfile
from datetime import datetime
from zoneinfo import ZoneInfo

os.environ["APOLLO_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("APOLLO_SECRET_KEY", "y" * 32)
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

PRIV = Ed25519PrivateKey.generate()
os.environ["NOAH_UPDATE_KEY"] = base64.b64encode(
    PRIV.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
os.environ["NOAH_VERSION"] = "1.2.0"
sys.path.insert(0, "/app")
from apollo import updates as u  # noqa: E402

D, E = "sha256:" + "a" * 64, "sha256:" + "b" * 64


def signed(manifest: dict, key=PRIV) -> tuple[bytes, str]:
    raw = json.dumps(manifest).encode()
    return raw, base64.b64encode(key.sign(raw)).decode()


m = {"version": "1.3.0", "images": {"noah-server": "ghcr.io/smfcoder17/noah-server@" + D, "caddy": "caddy@" + D,
                                    "hermes": "nousresearch/hermes-agent@" + D}}
raw, sig = signed(m)
assert u.verify(raw, sig)["version"] == "1.3.0"
for bad_raw, bad_sig, why in [(raw + b" ", sig, "contenu modifié"), (raw, signed(m, Ed25519PrivateKey.generate())[1], "autre clé"),
                              (*signed({"version": "1.3.0", "images": {"caddy": "caddy:latest"}}), "étiquette au lieu d'empreinte")]:
    try:
        u.verify(bad_raw, bad_sig)
        sys.exit(f"ÉCHEC : accepté malgré {why}")
    except ValueError:
        print("refusé :", why)
assert u.verify(*signed({"version": "1.3.0", "images": {"x": "localhost:5000/a/b@" + D}}))  # registre avec port

# Versions en attente : instance par instance, et épinglage des agents à venir.
running = {"noah-server": [{"digests": ["ghcr.io/smfcoder17/noah-server@" + D], "image_id": "x"}],
           "caddy": [{"digests": ["caddy@" + E], "image_id": "y"}],
           "hermes": [{"digests": ["nousresearch/hermes-agent@" + D]}, {"digests": ["nousresearch/hermes-agent@" + E]}]}
assert u.pending(m, running) == {"caddy": "caddy@" + D, "hermes": "nousresearch/hermes-agent@" + D}, u.pending(m, running)
assert u.pending(m, {"noah-server": running["noah-server"], "caddy": running["caddy"]}, {}) == \
    {"caddy": "caddy@" + D, "hermes": "nousresearch/hermes-agent@" + D}, "agent à venir non épinglé"
assert "hermes" not in u.pending(m, {"caddy": []}, {"hermes": "nousresearch/hermes-agent@" + D})
print("en attente : parc mélangé détecté, agents à venir épinglés : OK")
assert u._failed_here(m, {"bloquees": [{"image": "caddy@" + D, "version": "1.3.0", "composant": "caddy"}]}) == ["caddy"]
assert u._failed_here(m, {"bloquees": [{"image": "caddy@" + D, "version": "1.2.9", "composant": "caddy"}]}) == []

at = lambda h: datetime(2026, 11, 2, h, 30, tzinfo=ZoneInfo("America/Toronto")).timestamp()  # noqa: E731
st = {"auto": True, "heure": "auto", "fuseau": "America/Toronto", "activite": [0] * 24, "disponible": m}
assert u.quiet_hour(st) == 3
# Trois semaines d'usage de 8 h à 23 h : le créneau tombe en dehors, dans le fuseau de l'utilisateur.
st["activite"] = [21 if 8 <= h < 23 else 0 for h in range(24)]
assert u.quiet_hour(st) == 3 and u.due({**st, "activite": st["activite"]}, at(4)) is None
st["activite"] = [10] * 24
st["activite"][14] = st["activite"][15] = st["activite"][16] = 0
assert u.quiet_hour(st) == 14
st["activite"] = [0] * 24
assert u.due(st, at(4)) is None
assert u.due(st, at(12)) == "en dehors du créneau calme"
u._task_state = {"c1": "work"}
assert u.due(st, at(4)) == "une tâche est en cours"
u._task_state = {"c1": "approve"}
assert "validation" in u.due(st, at(4))
u._task_state, u.screens = {}, 1
assert "écran" in u.due(st, at(4))
u.screens = 0
st.update(majeure=True, annoncee=at(4) - 86400)
assert "7 jours" in u.due(st, at(4))
st["annoncee"] = at(4) - 8 * 86400
assert u.due(st, at(4)) is None
assert "accord" in u.due({**st, "disponible": {**m, "migration": True}}, at(4))
assert "ignorée" in u.due({**st, "ignoree": "1.3.0"}, at(4))
assert "reportée" in u.due({**st, "reportee": at(4) + 3600}, at(4))
assert "coupée" in u.due({**st, "auto": False}, at(4))
assert u.due({**st, "fuseau": "UTC"}, at(4)) == "en dehors du créneau calme"  # 4 h 30 à Toronto = 9 h 30 UTC
u.VERSION = "edge"
assert "développement" in u.due(st, at(4))
u.VERSION = "1.2.0"
print("créneau, fuseau, tâches, écran, majeure, migration, ignorer, report, canal edge : OK")

u.saw_client("Europe/Paris")
u.saw_client("pas/un/fuseau")
assert u._load()["fuseau"] == "Europe/Paris"
u.settings(False, 5)
u.postpone(1)
s = u._load()
assert s["auto"] is False and s["heure"] == 5 and s["reportee"] > 0 and s["fuseau"] == "Europe/Paris", s
print("réglages écrits par morceaux, sans s'écraser : OK")

# --- Ce que les correcteurs ont relevé comme non testé ------------------------------------------------------
import asyncio  # noqa: E402
import time  # noqa: E402

import httpx  # noqa: E402
from apollo import db  # noqa: E402

# Trois semaines d'usage de 8 h à 23 h à Toronto, comptées par activity() (VPS en UTC) : créneau à 3 h, heure de Toronto.
u._patch({"fuseau": "America/Toronto", "activite": [0] * 24, "heure": "auto"})
real_datetime = u.datetime


class Clock(real_datetime):
    now_value = None

    @classmethod
    def now(cls, tz=None):
        return cls.now_value.astimezone(tz)


u.datetime = Clock
for day in range(21):
    for hour in range(8, 23):
        Clock.now_value = real_datetime(2026, 10, 1 + day, hour, 15, tzinfo=ZoneInfo("America/Toronto"))
        u.activity()
u.datetime = real_datetime
st = u._load()
assert sum(st["activite"]) == 21 * 15 and st["activite"][3] == 0 and u.quiet_hour(st) == 3, st["activite"]
print("activity() sur 21 jours, VPS en UTC : créneau à 3 h dans le fuseau de l'utilisateur : OK")

# check() : manifeste signé servi par un faux GitHub, faux lanceur ; majeure annoncée, puis « Ignorer », puis la suivante.
told = []
u.desktop.notify = lambda title, text: told.append((title, text))
launcher_state = {"actuel": {"noah-server": [{"digests": [], "image_id": "old"}]}, "etat": {"images": {}}}
served = {}


def handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if url.endswith(".sig"):
        return httpx.Response(200, text=served["sig"])
    if url.endswith("manifest.json"):
        return httpx.Response(200, content=served["raw"])
    if url.endswith("/update/status"):
        return httpx.Response(200, json=launcher_state)
    if url.endswith("/update/pull"):
        return httpx.Response(200, json={"telechargees": [], "echecs": []})
    return httpx.Response(404)


RealClient = httpx.AsyncClient
u.httpx.AsyncClient = lambda **kw: RealClient(transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})
served["raw"], served["sig"] = signed({"version": "2.0.0", "images": {"noah-server": "ghcr.io/smfcoder17/noah-server@" + D}})
u._patch({"verifie": 0, "max_vue": "", "disponible": None})
asyncio.run(u.check())
st = u._load()
assert st["disponible"]["version"] == "2.0.0" and st["majeure"] is True and st["annoncee"] > 0
assert told and "majeure" in told[-1][1] and "7 jours" in told[-1][1], told
u.skip()
assert u.due(u._load(), time.time()) == "version ignorée"
served["raw"], served["sig"] = signed({"version": "2.0.1", "images": {"noah-server": "ghcr.io/smfcoder17/noah-server@" + E}})
asyncio.run(u.check())
st = u._load()
assert st["disponible"]["version"] == "2.0.1" and st["ignoree"] == "2.0.0" and u.due(st, time.time()) != "version ignorée"
served["raw"], served["sig"] = signed({"version": "1.9.0", "images": {"noah-server": "ghcr.io/smfcoder17/noah-server@" + D}})
asyncio.run(u.check())
assert u._load()["disponible"]["version"] == "2.0.1", "un manifeste plus ancien a remplacé l'annonce"
served["raw"], served["sig"] = signed({"version": "2.0.2", "migration": True, "images": {"noah-server": "ghcr.io/smfcoder17/noah-server@" + D}})
asyncio.run(u.check())
assert "accord" in told[-1][1], told[-1]
served["raw"] = None  # pas encore de version publiée : le manifeste répond 404
_saved_handler = handler


def handler(request):  # noqa: F811
    if str(request.url).endswith(("manifest.json", ".sig")) and served["raw"] is None:
        return httpx.Response(404)
    return _saved_handler(request)


asyncio.run(u.check())
assert u._load()["erreur"] == "Aucune version publiée pour l'instant", u._load()["erreur"]
handler = _saved_handler
print("check() : majeure annoncée 7 jours, Ignorer jusqu'à la suivante, ancien manifeste écarté, migration annoncée, "
      "aucune version publiée dite en clair : OK")

# _follow : la notification dit ce qui s'est vraiment passé.
cases = [({"ok": True, "version": "2.0.2", "composants": {"noah-server": "fait"}}, "Noah est à jour"),
         ({"ok": False, "erreur": "x ne répondait plus", "composants": {"retour_arriere": True}, "non_restaures": []}, "Mise à jour annulée"),
         ({"ok": False, "erreur": "x ne répondait plus", "composants": {"retour_arriere": True}, "non_restaures": ["apollo-agent-a"]}, "à vérifier"),
         ({"ok": True, "composants": {"noah-launcher": "en_cours"}}, None)]
for i, (report, title) in enumerate(cases):
    told.clear()
    launcher_state["etat"] = {"dernier_rapport": {**report, "fin": 10_000 + i}, "en_cours": None}
    asyncio.run(u._follow())
    assert (told[-1][0] if told else None) is None if title is None else title in told[-1][0], (report, told)
launcher_state["etat"] = {"en_cours": {"phase": "observation"}}
asyncio.run(u._follow())
assert u.maintenance is True
launcher_state["etat"] = {"en_cours": {"phase": "intervention"}}
asyncio.run(u._follow())
assert u.maintenance is False
print("_follow : à jour, annulée, à vérifier (avec les noms), rien tant que le lanceur n'a pas fini ; maintenance suit le journal : OK")

# routine_soon : une routine qui part dans 10 min retient la mise à jour, une dans 2 h non.
db.init()
with db.connect() as conn:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(agents)")]
    values = {c: ("agent-t" if c == "id" else None if c == "owner_id" else "x") for c in cols}  # owner_id : clé étrangère
    conn.execute(f"INSERT OR REPLACE INTO agents ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", list(values.values()))
soon = datetime.fromtimestamp(time.time() + 600, ZoneInfo("UTC")).isoformat()
late = datetime.fromtimestamp(time.time() + 7200, ZoneInfo("UTC")).isoformat()


async def fake_admin(agent_id, action, body, timeout):
    return {"routines": [{"name": "veille", "enabled": True, "state": "scheduled", "next_run_at": routines_at}]}
u.machine.admin = fake_admin
routines_at = soon
assert "veille" in asyncio.run(u.routine_soon())
routines_at = late
assert asyncio.run(u.routine_soon()) is None
print("routine_soon : routine dans 10 min retient la mise à jour, dans 2 h non : OK")

# Recul : un échec sans faute de la version n'est pas réessayé avant 6 h.
st = u._load()
assert u.due({**st, "disponible": {"version": "3.0.0"}, "ignoree": None, "majeure": False, "reessai_apres": time.time() + 3600,
              "reportee": 0, "auto": True}, time.time()).startswith("dernier essai raté")
print("recul de 6 h après un échec sans faute de la version : OK")

# tick() dans le créneau : tâche en cours, écran ouvert, routine proche -> pas d'installation, raison au journal.
applied = []
_old_handler = handler


def handler2(request: httpx.Request) -> httpx.Response:
    if str(request.url).endswith("/update/apply"):
        applied.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "en_cours": True})
    if str(request.url).endswith("/update/status"):
        return httpx.Response(200, json={"actuel": {"noah-server": [{"digests": [], "image_id": "old"}]}, "etat": {}})
    return _old_handler(request)


u.httpx.AsyncClient = lambda **kw: RealClient(transport=httpx.MockTransport(handler2), **{k: v for k, v in kw.items() if k != "transport"})
served["raw"], served["sig"] = signed({"version": "2.1.0", "images": {"noah-server": "ghcr.io/smfcoder17/noah-server@" + D}})
u._patch({"verifie": 0, "disponible": None, "ignoree": None, "reessai_apres": 0, "reportee": 0, "auto": True, "heure": 3,
          "fuseau": "America/Toronto", "reports": [], "max_vue": "", "installee": None})
asyncio.run(u.check())
u._patch({"majeure": False, "verifie": time.time()})
night = datetime(2026, 11, 3, 4, 0, tzinfo=ZoneInfo("America/Toronto")).timestamp()
routines_at = late
for setup, word in ((lambda: u._task_state.update(c1="work"), "tâche"), (lambda: setattr(u, "screens", 1), "écran"),
                    (lambda: None, "routine")):
    u._task_state.clear()
    u.screens = 0
    routines_at = soon if word == "routine" else late
    setup()
    reason = asyncio.run(u.tick(night))
    assert word in reason, (word, reason)
    assert word in u._load()["reports"][-1]["texte"]
assert not applied, "installé malgré une raison d'attendre"
u._task_state.clear()
u.screens = 0
print("tick() dans le créneau : tâche, écran, routine -> rien d'installé, raison écrite au journal des reports : OK")

# « Installer maintenant » : une majeure annoncée hier s'installe quand même d'un clic (délai de 7 jours sauté).
routines_at = late
u._patch({"majeure": True, "annoncee": time.time() - 86400, "reessai_apres": 0})
assert "7 jours" in u.due(u._load(), time.time())
result = asyncio.run(u.install(manual=True))
assert applied and applied[-1]["force"] is True and result.get("ok"), (result, applied)
u.maintenance = False
print("clic « Installer maintenant » : majeure de la veille installée, en réessayant une version bloquée : OK")
