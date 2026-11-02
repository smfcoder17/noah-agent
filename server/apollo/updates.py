"""Mises à jour automatiques de Noah Agent : quoi, et surtout quand.

Chaque version publiée a un manifeste signé (Ed25519) qui donne, pour chaque composant, l'image exacte par empreinte :
Noah (serveur, lanceur) mais aussi ce qu'on embarque (Hermes, le navigateur, Caddy). On ne suit jamais une étiquette
qui bouge : une dépendance n'arrive chez l'utilisateur que dans une version de Noah, testée avec le reste.

Toutes les heures, le serveur lit le manifeste. Une nouvelle version est préchargée tout de suite (le téléchargement
ne dérange personne), puis installée pendant le créneau calme de l'utilisateur, dans son fuseau : par défaut de 3 h à
6 h, ou les heures où il utilise le moins Noah quand on en sait assez. Jamais pendant une tâche en cours, une
validation en attente ou un écran ouvert : on attend la fin. Une version majeure est annoncée et attend 7 jours (le
temps de lire ce qui change, de l'installer tout de suite d'un clic ou de l'ignorer) avant de passer elle aussi dans
le créneau ; une version qui transforme les données (« migration » dans le manifeste) attend toujours un clic.
L'exécution (sauvegarde, recréation, contrôle de santé, retour arrière) est faite par le lanceur : updater.py.
Même partage des rôles que Watchtower / What's Up Docker, avec le créneau et le report de Home Assistant et de
Synology DSM.
"""
import asyncio
import base64
import json
import os
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from . import desktop
from .config import BROWSER_TIMEZONE, DATA_DIR, LAUNCHER_KEY, LAUNCHER_URL

VERSION = os.environ.get("NOAH_VERSION", "dev")
MANIFEST_URL = os.environ.get("NOAH_UPDATE_MANIFEST",
                              "https://github.com/SmfCoder/noah-agent/releases/latest/download/manifest.json")
# Clé publique des versions (base64, 32 octets). Sans elle, aucune mise à jour n'est installée : un manifeste non
# signé pourrait faire tourner n'importe quelle image avec l'accès à Docker.
PUBLIC_KEY = os.environ.get("NOAH_UPDATE_KEY", "")
STATE = DATA_DIR / "updates.json"
CHECK_EVERY = 3600
WINDOW_HOURS = 3
MAJOR_WAIT = 7 * 86400
LAUNCHER = {"Authorization": f"Bearer {LAUNCHER_KEY}"}

# Ce que le reste du serveur signale : écrans ouverts (main.py), et l'état des tâches (main.task_state).
screens = 0
_task_state: dict[str, str] = {}
_running = asyncio.Lock()
_last_zone = ""


def _load() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (FileNotFoundError, ValueError):
        return {"auto": True, "heure": "auto", "fuseau": "", "activite": [0] * 24}


def _save(state: dict) -> None:
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False))
    os.replace(tmp, STATE)


def _semver(v: str) -> tuple[int, int, int] | None:
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)$", v or "")
    return tuple(int(x) for x in m.groups()) if m else None


# --- Fuseau et heures calmes ------------------------------------------------------------------------------

def _zone(state: dict) -> ZoneInfo:
    for name in (state.get("fuseau"), BROWSER_TIMEZONE):
        if not name:
            continue
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            continue
    return ZoneInfo("UTC")


def saw_client(timezone: str | None) -> None:
    """Fuseau envoyé par l'application (en-tête X-Noah-Timezone) : le créneau calme suit l'utilisateur, pas le VPS."""
    global _last_zone
    if not timezone or len(timezone) > 64 or timezone == _last_zone:
        return
    _last_zone = timezone
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return
    state = _load()
    if state.get("fuseau") != timezone:
        state["fuseau"] = timezone
        _save(state)


def activity() -> None:
    """Un message de l'utilisateur, compté par heure locale : on apprend quand il n'utilise pas Noah."""
    state = _load()
    hours = state.get("activite") or [0] * 24
    hours[datetime.now(_zone(state)).hour] += 1
    if sum(hours) > 2000:  # vieillissement : les habitudes changent
        hours = [h // 2 for h in hours]
    state["activite"] = hours
    _save(state)


def quiet_hour(state: dict) -> int:
    if state.get("heure") != "auto":
        return int(state["heure"])
    hours = state.get("activite") or [0] * 24
    if sum(hours) < 50:
        return 3
    # Début du bloc de 3 h le moins utilisé ; à égalité, le plus proche de 3 h du matin.
    return min(range(24), key=lambda h: (sum(hours[(h + i) % 24] for i in range(WINDOW_HOURS)), abs(h - 3)))


def _in_window(state: dict, now: float) -> bool:
    hour = datetime.fromtimestamp(now, _zone(state)).hour
    return (hour - quiet_hour(state)) % 24 < WINDOW_HOURS


def busy() -> str | None:
    """Pourquoi ce n'est pas le moment, ou None."""
    if any(s == "approve" for s in _task_state.values()):
        return "une validation attend l'utilisateur"
    if any(s == "work" for s in _task_state.values()):
        return "une tâche est en cours"
    if screens > 0:
        return "un écran d'agent est ouvert"
    return None


# --- Manifeste signé -------------------------------------------------------------------------------------

def verify(raw: bytes, signature: str) -> dict:
    if not PUBLIC_KEY:
        raise ValueError("clé de signature des versions absente (NOAH_UPDATE_KEY)")
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY)).verify(base64.b64decode(signature.strip()), raw)
    except (InvalidSignature, ValueError) as e:
        raise ValueError("signature du manifeste invalide") from e
    manifest = json.loads(raw)
    if not isinstance(manifest.get("images"), dict) or not _semver(manifest.get("version", "")):
        raise ValueError("manifeste incomplet")
    for comp, ref in manifest["images"].items():
        if not re.fullmatch(r"[a-z0-9./_-]+@sha256:[0-9a-f]{64}", ref):
            raise ValueError(f"image sans empreinte pour {comp}")
    return manifest


async def _launcher(method: str, path: str, **kw) -> dict:
    async with httpx.AsyncClient(timeout=kw.pop("timeout", 30)) as c:
        r = await c.request(method, f"{LAUNCHER_URL}{path}", headers=LAUNCHER, **kw)
        r.raise_for_status()
        return r.json()


def pending(manifest: dict, running: dict) -> dict[str, str]:
    """Composants dont l'image en service n'est pas celle du manifeste."""
    out = {}
    for comp, ref in manifest.get("images", {}).items():
        now = running.get(comp)
        if now is None:
            continue  # pas installé ici (aucun agent encore, par exemple) : il prendra la bonne image à sa création
        if ref not in now.get("digests", []) and ref.split("@")[-1] != now.get("image_id"):
            out[comp] = ref
    return out


async def check(state: dict | None = None) -> dict:
    state = state or _load()
    state["verifie"] = int(time.time())
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
            raw = (await c.get(MANIFEST_URL)).raise_for_status().content
            sig = (await c.get(MANIFEST_URL + ".sig")).raise_for_status().text
        manifest = verify(raw, sig)
        current = _semver(VERSION)
        new = _semver(manifest["version"])
        if current and new <= current and VERSION != "dev":
            manifest = None  # déjà à jour (ou manifeste plus ancien : jamais de retour en arrière par là)
        state["erreur"] = None
    except (httpx.HTTPError, ValueError) as e:
        state["erreur"] = str(e)[:200]
        _save(state)
        return state
    previous = (state.get("disponible") or {}).get("version")
    state["disponible"] = manifest
    if manifest and manifest["version"] != previous:
        state["annoncee"] = int(time.time())
        state["reportee"] = 0
        major = bool(current) and new[0] > current[0]
        state["majeure"] = major
        desktop.notify("Nouvelle version de Noah", f"Noah {manifest['version']} sera installée pendant ta nuit"
                       + (" (version majeure : dans 7 jours, ou dès maintenant d'un clic)." if major else "."))
        try:  # préchargement : à l'heure de l'installation, la coupure ne dure que le redémarrage
            status = await _launcher("GET", "/update/status")
            todo = pending(manifest, status["actuel"])
            if todo:
                await _launcher("POST", "/update/pull", json={"images": list(todo.values())}, timeout=1800)
        except httpx.HTTPError:
            pass
    _save(state)
    return state


async def install(state: dict) -> dict:
    manifest = state.get("disponible")
    if not manifest:
        return {"ok": False, "erreur": "Aucune nouvelle version"}
    async with _running:
        status = await _launcher("GET", "/update/status")
        todo = pending(manifest, status["actuel"])
        if not todo:
            state["disponible"] = None
            _save(state)
            return {"ok": True, "rien": True}
        await _launcher("POST", "/update/pull", json={"images": list(todo.values())}, timeout=1800)
        state["installee"] = {"version": manifest["version"], "depuis": int(time.time())}
        _save(state)
        # Le lanceur fait le reste ; s'il recrée ce serveur, cette tâche s'arrête là et le nouveau relit l'état.
        return await _launcher("POST", "/update/apply", json={"cibles": todo})


def due(state: dict, now: float) -> str | None:
    """Raison de ne pas installer maintenant, ou None si c'est le moment."""
    if not state.get("disponible"):
        return "à jour"
    if state.get("ignoree") == state["disponible"]["version"]:
        return "version ignorée"
    if state["disponible"].get("migration"):
        return "elle change tes données : elle attend ton accord"
    if not state.get("auto", True):
        return "installation automatique coupée"
    if state.get("reportee", 0) > now:
        return "reportée par l'utilisateur"
    if state.get("majeure") and now - state.get("annoncee", now) < MAJOR_WAIT:
        return "version majeure : délai de 7 jours"
    if not _in_window(state, now):
        return "en dehors du créneau calme"
    return busy()


async def run(task_state: dict[str, str]) -> None:
    global _task_state
    _task_state = task_state
    await asyncio.sleep(60)
    while True:
        try:
            state = _load()
            if time.time() - state.get("verifie", 0) > CHECK_EVERY:
                state = await check(state)
            if PUBLIC_KEY and due(state, time.time()) is None:
                await install(state)
            await _report(state)
        except Exception as e:  # noqa: BLE001 - la boucle ne doit jamais s'arrêter
            print(f"[mises à jour] {e}", flush=True)
        await asyncio.sleep(300)


async def _report(state: dict) -> None:
    """Prévient l'utilisateur de l'issue d'une mise à jour (faite par le lanceur, parfois après le redémarrage de ce
    serveur) : une seule fois par rapport."""
    try:
        report = (await _launcher("GET", "/update/status", timeout=10)).get("etat", {}).get("dernier_rapport") or {}
    except httpx.HTTPError:
        return
    if not report.get("fin") or report["fin"] <= state.get("rapport_vu", 0):
        return
    state["rapport_vu"] = report["fin"]
    _save(state)
    if report.get("ok"):
        desktop.notify("Noah est à jour", f"Version {VERSION} installée.")
    elif report.get("composants"):
        desktop.notify("Mise à jour annulée", "Un composant ne répondait plus après la mise à jour : Noah est revenu "
                       "à la version d'avant, avec ses données. Rien n'est perdu.")


async def summary() -> dict:
    state = _load()
    now = time.time()
    try:
        launcher = await _launcher("GET", "/update/status", timeout=10)
    except httpx.HTTPError:
        launcher = {"actuel": {}, "etat": {}}
    etat = launcher.get("etat", {})
    manifest = state.get("disponible")
    hour = quiet_hour(state)
    return {
        "version": VERSION,
        "disponible": {"version": manifest["version"], "notes": manifest.get("notes", ""),
                       "majeure": bool(state.get("majeure")), "migration": bool(manifest.get("migration")),
                       "ignoree": state.get("ignoree") == manifest["version"],
                       "composants": sorted(pending(manifest, launcher.get("actuel", {})))} if manifest else None,
        "attente": due(state, now),
        "occupe": busy(),
        "auto": state.get("auto", True),
        "heure": state.get("heure", "auto"),
        "creneau": f"{hour} h – {(hour + WINDOW_HOURS) % 24} h",
        "fuseau": str(_zone(state)),
        "verifie": state.get("verifie"),
        "erreur": state.get("erreur") or (None if PUBLIC_KEY else "Les versions ne sont pas encore signées : "
                                          "les mises à jour automatiques sont désactivées."),
        "en_cours": bool(etat.get("en_cours")),
        "dernier_rapport": etat.get("dernier_rapport"),
        "historique": list(reversed(etat.get("historique", [])))[:20],
    }


def settings(auto: bool | None, heure: str | int | None) -> None:
    state = _load()
    if auto is not None:
        state["auto"] = bool(auto)
    if heure is not None:
        state["heure"] = "auto" if heure == "auto" else max(0, min(23, int(heure)))
    _save(state)


def skip() -> None:
    """« Ignorer » : cette version ne s'installe pas seule ; la suivante, si."""
    state = _load()
    if state.get("disponible"):
        state["ignoree"] = state["disponible"]["version"]
        _save(state)


def postpone(days: int = 1) -> None:
    state = _load()
    state["reportee"] = int(time.time()) + days * 86400
    _save(state)
