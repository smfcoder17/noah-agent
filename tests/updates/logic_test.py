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


m = {"version": "1.3.0", "images": {"noah-server": "ghcr.io/smfcoder/noah-server@" + D, "caddy": "caddy@" + D,
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
running = {"noah-server": [{"digests": ["ghcr.io/smfcoder/noah-server@" + D], "image_id": "x"}],
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
