"""Mises à jour automatiques de Noah Agent : quoi, et surtout quand.

Chaque version publiée a un manifeste signé (Ed25519) qui donne, pour chaque composant, l'image exacte par empreinte :
Noah (serveur, lanceur) mais aussi ce qu'on embarque (Hermes, le navigateur, Caddy). On ne suit jamais une étiquette
qui bouge : une dépendance n'arrive chez l'utilisateur que dans une version de Noah, testée avec le reste.

Toutes les heures, le serveur lit le manifeste. Une nouvelle version est préchargée tout de suite (le téléchargement
ne dérange personne), puis installée pendant le créneau calme de l'utilisateur, dans son fuseau : par défaut de 3 h à
6 h, ou les heures où il utilise le moins Noah quand on en sait assez. Jamais pendant une tâche en cours, une
validation en attente, un écran ouvert ou juste avant une routine : on attend, et le journal dit pourquoi. Pendant
l'installation, Noah refuse les nouvelles tâches (quelques minutes). Une version majeure est annoncée et attend
7 jours (le temps de lire ce qui change, de l'installer tout de suite d'un clic ou de l'ignorer) avant de passer elle
aussi dans le créneau ; une version qui transforme les données (« migration » dans le manifeste) attend toujours un
clic. L'exécution (sauvegarde, recréation, contrôle de santé, retour arrière) est faite par le lanceur, qui revérifie
la signature : updater.py. Même partage des rôles que Watchtower / What's Up Docker, avec le créneau et le report de
Home Assistant et de Synology DSM.
"""
import asyncio
import base64
import json
import os
import re
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from . import db, desktop, machine
from .config import BROWSER_TIMEZONE, DATA_DIR, LAUNCHER_KEY, LAUNCHER_URL

VERSION = os.environ.get("NOAH_VERSION", "dev")
MANIFEST_URL = os.environ.get("NOAH_UPDATE_MANIFEST",
                              "https://github.com/smfcoder17/noah-agent/releases/latest/download/manifest.json")
# Clé publique des versions (base64, 32 octets). Sans elle, aucune mise à jour n'est installée : un manifeste non
# signé pourrait faire tourner n'importe quelle image avec l'accès à Docker.
PUBLIC_KEY = os.environ.get("NOAH_UPDATE_KEY", "")
STATE = DATA_DIR / "updates.json"
CHECK_EVERY = 3600
WINDOW_HOURS = 3
MAJOR_WAIT = 7 * 86400
RETRY_AFTER = 6 * 3600  # un essai raté sans faute de la version (disque plein, registre…) : nouvel essai bien plus tard
LAUNCHER = {"Authorization": f"Bearer {LAUNCHER_KEY}"}

# Ce que le reste du serveur signale : écrans ouverts (main.py), état des tâches (main.task_state), et comment
# prévenir l'utilisateur d'une façon qu'il verra (message dans sa conversation, posé par main.py).
screens = 0
maintenance = False  # installation en cours : les nouvelles tâches attendent
announce = None
_task_state: dict[str, str] = {}
_running = asyncio.Lock()
_state_lock = threading.Lock()
_last_zone = ""


# --- État (lu et écrit par morceaux, sous verrou : une vérification longue n'écrase pas un réglage) ----------

def _load() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (FileNotFoundError, ValueError):
        return {"auto": True, "heure": "auto", "fuseau": "", "activite": [0] * 24}


def _patch(change) -> dict:
    with _state_lock:
        state = _load()
        if callable(change):
            change(state)
        else:
            state.update(change)
        tmp = STATE.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False))
        os.replace(tmp, STATE)
        return state


def _semver(v: str) -> tuple[int, int, int] | None:
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)$", v or "")
    return tuple(int(x) for x in m.groups()) if m else None


def android_app() -> dict | None:
    """L'APK publiée dans la même Release que ce serveur (même numéro) : l'app Android la propose si elle est plus ancienne.
    Rien pour une construction locale (« dev ») ou une préversion, qui n'ont pas d'APK signée."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", VERSION) or "/releases/" not in MANIFEST_URL:
        return None
    base = MANIFEST_URL.split("/releases/", 1)[0]
    return {"version": VERSION, "url": f"{base}/releases/download/v{VERSION}/noah-agent-android.apk"}


def shown_version() -> str:
    """Le numéro que voit la personne (version-affichee.txt). VERSION est le numéro technique, unique pour chaque publication
    signée : une correction en change, sans rien annoncer. Le numéro affiché ne monte que lorsqu'on le décide."""
    return os.environ.get("NOAH_DISPLAY_VERSION") or VERSION


def _shown(manifest: dict) -> str:
    return manifest.get("affichee") or manifest["version"]


def _tell(title: str, text: str) -> None:
    """Notification de l'app de bureau si elle est là, et toujours un message dans la conversation : sur un VPS
    utilisé depuis le web ou le téléphone, c'est ce que l'utilisateur verra."""
    desktop.notify(title, text)
    if announce:
        try:
            announce(f"**{title}**\n\n{text}")
        except Exception:  # noqa: BLE001 - pas encore d'agent : la carte de Réglages > Serveur > Mises à jour reste
            pass


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


def local_zone() -> ZoneInfo:
    """Fuseau de l'utilisateur (vu par ses apps), pour ce qui se compte « par jour » chez lui."""
    return _zone(_load())


def client_zone() -> str:
    """Le fuseau vu par les apps, tel quel ; vide si aucune n'a encore parlé."""
    return str(_load().get("fuseau") or "")


def saw_client(timezone: str | None) -> None:
    """Fuseau envoyé par l'application d'un utilisateur connecté (en-tête X-Noah-Timezone) : le créneau calme suit
    l'utilisateur, pas le VPS."""
    global _last_zone
    if not timezone or len(timezone) > 64 or timezone == _last_zone:
        return
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return
    _last_zone = timezone
    _patch({"fuseau": timezone})


def activity() -> None:
    """Un message de l'utilisateur, compté par heure locale : on apprend quand il n'utilise pas Noah."""
    def add(state):
        hours = state.get("activite") or [0] * 24
        hours[datetime.now(_zone(state)).hour] += 1
        state["activite"] = [h // 2 for h in hours] if sum(hours) > 2000 else hours  # les habitudes changent
    _patch(add)


def quiet_hour(state: dict) -> int:
    if state.get("heure", "auto") != "auto":
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


async def routine_soon(minutes: int = 45) -> str | None:
    """Une routine (cron d'Hermes) qui part avant la fin probable de l'installation (sauvegardes, santé de chaque
    conteneur, 5 min d'observation : 45 min de marge) ou tourne déjà : on ne coupe pas son agent."""
    with db.connect() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM agents")]
    limit = time.time() + minutes * 60
    for agent_id in ids:
        try:
            jobs = (await machine.admin(agent_id, "routines", {}, 15))["routines"]
        except Exception:  # noqa: BLE001 - agent arrêté : rien ne tournera
            continue
        for job in jobs:
            if not job.get("enabled") or job.get("state") == "paused":
                continue
            if job.get("state") == "running":
                return f"la routine « {job.get('name')} » tourne"
            try:
                at = datetime.fromisoformat(str(job.get("next_run_at"))).timestamp()
            except ValueError:
                continue
            if time.time() - 60 <= at <= limit:
                return f"la routine « {job.get('name')} » part dans moins de {minutes} min"
    return None


async def blocked() -> str | None:
    return busy() or await routine_soon()


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
        if not isinstance(ref, str) or not re.fullmatch(r"[a-z0-9./_:-]+@sha256:[0-9a-f]{64}", ref):
            raise ValueError(f"image sans empreinte pour {comp}")
    return manifest


async def _launcher(method: str, path: str, **kw) -> dict:
    async with httpx.AsyncClient(timeout=kw.pop("timeout", 30)) as c:
        r = await c.request(method, f"{LAUNCHER_URL}{path}", headers=LAUNCHER, **kw)
        r.raise_for_status()
        return r.json()


def _signed(state: dict, composants: list[str] | None = None, force: bool = False) -> dict:
    return {"manifeste": state["brut"], "signature": state["signature"], "composants": composants, "force": force}


def pending(manifest: dict, running: dict, pins: dict | None = None) -> dict[str, str]:
    """Composants dont au moins une instance n'est pas sur l'image du manifeste. Pour les agents et navigateurs
    encore absents, on regarde l'image épinglée par le lanceur pour les prochains."""
    out = {}
    for comp, ref in manifest.get("images", {}).items():
        instances = running.get(comp)
        if not instances:
            if comp in ("hermes", "navigateur") and (pins or {}).get(comp) != ref:
                out[comp] = ref
            continue
        if any(ref not in i.get("digests", []) and ref.split("@")[-1] != i.get("image_id") for i in instances):
            out[comp] = ref
    return out


def _failed_here(manifest: dict, launcher_state: dict) -> list[str]:
    """Composants de cette version qui ont déjà échoué sur cette machine (le lanceur les a bloqués)."""
    return [b.get("composant", "?") for b in launcher_state.get("bloquees", [])
            if b.get("version") == manifest.get("version") and b.get("image") in manifest.get("images", {}).values()]


async def check() -> dict:
    """Lit le manifeste, le vérifie, et garde ce qui reste à installer. Ne réécrit que ses propres champs. Jamais en
    même temps qu'une installation (elle travaille sur sa copie figée)."""
    async with _running:
        return await _check()


async def _check() -> dict:
    _patch({"verifie": int(time.time())})
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
            raw = (await c.get(MANIFEST_URL)).raise_for_status().content
            sig = (await c.get(MANIFEST_URL + ".sig")).raise_for_status().text
        manifest = verify(raw, sig)
    except (httpx.HTTPError, ValueError) as e:
        # Messages lisibles dans Réglages > Serveur > Mises à jour (pas l'erreur brute de la bibliothèque HTTP).
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code == 404:
            text = "Aucune version publiée pour l'instant"
        elif isinstance(e, httpx.HTTPStatusError):
            text = f"Le serveur des versions a répondu {e.response.status_code}, nouvel essai plus tard"
        elif isinstance(e, httpx.HTTPError):
            text = "Serveur des versions injoignable, nouvel essai plus tard"
        else:
            text = str(e)[:200]
        state = _load()
        if "signature" in text or "empreinte" in text or "incomplet" in text:
            print(f"[mises à jour] manifeste refusé : {text}", flush=True)
            _patch(lambda s: s.update(erreur=text, refus=(s.get("refus", []) + [{"quand": int(time.time()), "texte": text}])[-20:]))
        else:
            _patch({"erreur": text})
        return state
    state = _load()
    new, current = _semver(manifest["version"]), _semver(VERSION)
    seen = _semver(state.get("max_vue", "")) or (0, 0, 0)
    if new < seen or (current and new < current):
        # Jamais en arrière : un ancien manifeste (rejoué, ou « latest » qui pointe sur un correctif plus ancien).
        return _patch({"erreur": None})
    try:
        status = await _launcher("GET", "/update/status")
        todo = pending(manifest, status["actuel"], status["etat"].get("images"))
    except httpx.HTTPError:
        return _patch({"erreur": "lanceur injoignable"})
    if not todo:
        return _patch({"erreur": None, "disponible": None, "max_vue": manifest["version"]})
    previous = (state.get("disponible") or {}).get("version")
    fresh = manifest["version"] != previous
    major = bool(current) and new[0] > current[0]

    def keep(s):
        s.update(erreur=None, disponible=manifest, brut=base64.b64encode(raw).decode(), signature=sig,
                 max_vue=manifest["version"])
        if fresh:
            s.update(annoncee=int(time.time()), reportee=0, majeure=major)
    state = _patch(keep)
    if fresh:
        same_number = _shown(manifest) == shown_version() and not manifest.get("migration")
        if manifest.get("migration"):
            when = " attend ton accord : elle transforme tes données. Installe-la depuis Réglages > Serveur > Mises à jour quand tu veux."
        elif major:
            when = " est une version majeure : elle s'installera seule dans 7 jours, pendant ta nuit (ou dès maintenant d'un clic dans Réglages > Serveur > Mises à jour)."
        else:
            when = " s'installera seule pendant ta nuit."
        if not same_number:
            _tell("Nouvelle version de Noah", f"Noah {_shown(manifest)}{when}")
        try:  # préchargement : à l'heure de l'installation, la coupure ne dure que le redémarrage
            await _launcher("POST", "/update/pull", json=_signed(state, list(todo)), timeout=1800)
        except httpx.HTTPError:
            pass
    return state


async def install(manual: bool = False, ignore_busy: bool = False) -> dict:
    """Précharge, revérifie tout juste avant de couper (le téléchargement a pu durer : l'utilisateur a pu couper
    l'automatique, reporter, lancer une tâche), puis confie la transaction au lanceur. `manual` : clic de
    l'utilisateur (réessaie aussi une version bloquée) ; `ignore_busy` : il a confirmé malgré une tâche en cours."""
    global maintenance
    async with _running:
        state = _load()  # instantané figé : version, octets signés et signature restent ensemble jusqu'au bout
        manifest = state.get("disponible")
        if not manifest:
            return {"ok": False, "erreur": "Aucune nouvelle version"}
        frozen = (manifest["version"], state["brut"], state["signature"])
        status = await _launcher("GET", "/update/status")
        todo = pending(manifest, status["actuel"], status["etat"].get("images"))
        if not todo:
            _patch({"disponible": None})
            return {"ok": True, "rien": True}
        pulled = await _launcher("POST", "/update/pull", json=_signed(state, list(todo)), timeout=1800)
        if pulled.get("echecs"):
            return {"ok": False, "erreur": "Téléchargement impossible pour l'instant, nouvel essai plus tard"}
        now_state = _load()
        if ((now_state.get("disponible") or {}).get("version"), now_state.get("brut"), now_state.get("signature")) != frozen:
            return {"ok": False, "erreur": "La version disponible a changé pendant le téléchargement : nouvel essai"}
        reason = None if manual else due(now_state, time.time())
        if not ignore_busy:
            reason = reason or await blocked()
        if reason:
            return {"ok": False, "erreur": f"Pas maintenant : {reason}"}
        maintenance = True  # à partir d'ici, les nouvelles tâches attendent
        reason = None if ignore_busy else busy()  # une tâche admise pendant la dernière vérification
        if reason:
            maintenance = False
            return {"ok": False, "erreur": f"Pas maintenant : {reason}"}
        _patch({"installee": {"version": manifest["version"], "depuis": int(time.time())}})
        # Le lanceur fait le reste ; s'il recrée ce serveur, cette tâche s'arrête là et le nouveau relit l'état.
        try:
            return await _launcher("POST", "/update/apply", json=_signed(state, list(todo), manual))
        except httpx.HTTPError:
            maintenance = False
            raise


def due(state: dict, now: float) -> str | None:
    """Raison de ne pas installer maintenant, ou None si c'est le moment."""
    if not state.get("disponible"):
        return "à jour"
    if not _semver(VERSION):
        return "version de développement : installation à la main"
    if state.get("ignoree") == state["disponible"]["version"]:
        return "version ignorée"
    if state["disponible"].get("migration"):
        return "elle change tes données : elle attend ton accord"
    if not state.get("auto", True):
        return "installation automatique coupée"
    if state.get("reportee", 0) > now:
        return "reportée par l'utilisateur"
    if state.get("reessai_apres", 0) > now:
        return "dernier essai raté (sans faute de la version) : nouvel essai plus tard"
    if state.get("majeure") and now - state.get("annoncee", now) < MAJOR_WAIT:
        return "version majeure : délai de 7 jours"
    if not _in_window(state, now):
        return "en dehors du créneau calme"
    return busy()


async def _follow() -> None:
    """Fin de l'installation (rapport du lanceur) : la maintenance s'arrête et l'utilisateur sait comment ça s'est
    passé, une seule fois par rapport."""
    global maintenance
    try:
        etat = (await _launcher("GET", "/update/status", timeout=10)).get("etat", {})
    except httpx.HTTPError:
        return
    tx = etat.get("en_cours")
    if report_failed_softly(etat):
        _patch({"reessai_apres": int(time.time()) + RETRY_AFTER})
    report = etat.get("dernier_rapport") or {}
    state = _load()
    # Le journal du lanceur fait foi, y compris pour un serveur qui vient d'être recréé au milieu de la transaction.
    # Entre la demande et l'ouverture du journal (téléchargement, place disque…), le lanceur prépare : on attend son
    # rapport, 30 min au plus.
    asked = (state.get("installee") or {}).get("depuis", 0)
    preparing = maintenance and not tx and report.get("fin", 0) < asked and time.time() - asked < 1800
    maintenance = (bool(tx) and tx.get("phase") != "intervention") or preparing
    if not report.get("fin") or report["fin"] <= state.get("rapport_vu", 0):
        return
    _patch({"rapport_vu": report["fin"]})
    if report.get("ok"):
        if report.get("composants") and "en_cours" not in report["composants"].values() and not report.get("validation"):
            told = state.get("affichee_vue")
            _patch({"affichee_vue": shown_version()})
            if not os.environ.get("NOAH_DISPLAY_VERSION") or (told and told != shown_version()):
                _tell("Noah est à jour", f"Version {shown_version()} installée.")
    elif report.get("non_restaures"):
        _tell("Mise à jour : à vérifier", f"{report.get('erreur')}. Le retour à la version d'avant n'a pas pu se "
              f"faire pour : {', '.join(report['non_restaures'])}. Ils restent arrêtés pour protéger leurs "
              "données ; les sauvegardes sont gardées. Les autres fonctionnent sur la version d'avant.")
    elif report.get("composants") or "interrompue" in (report.get("erreur") or ""):
        _tell("Mise à jour annulée", f"{report.get('erreur', 'Un composant ne répondait plus')}. Noah est revenu à "
              "la version d'avant, avec ses données.")
    elif report.get("erreur"):
        key = f"{report.get('version')}:{report['erreur'][:60]}"
        if key not in state.get("deja_dit", []):  # refus, place disque, essais épuisés… : dit une fois
            _patch(lambda s: s.update(deja_dit=(s.get("deja_dit", []) + [key])[-30:]))
            _tell("Mise à jour en attente", f"Noah {report.get('version', '')} n'a pas été installée : {report['erreur']}.")


def report_failed_softly(etat: dict) -> bool:
    """Le dernier rapport est un échec sans faute de l'image (rien de bloqué) et pas encore vu."""
    report = etat.get("dernier_rapport") or {}
    return bool(report.get("fin")) and not report.get("ok") and report["fin"] > _load().get("rapport_vu", 0) and \
        "bloquee" not in (report.get("composants") or {}).values() and "plus ancienne" not in (report.get("erreur") or "")


_unreachable_since = 0.0


async def transaction_open() -> bool:
    """Un lanceur injoignable veut souvent dire qu'il est en train d'être remplacé : on attend (10 min au plus)."""
    global _unreachable_since
    try:
        tx = (await _launcher("GET", "/update/status", timeout=10)).get("etat", {}).get("en_cours")
    except httpx.HTTPError:
        _unreachable_since = _unreachable_since or time.time()
        return time.time() - _unreachable_since < 600
    _unreachable_since = 0.0
    return bool(tx) and tx.get("phase") != "intervention"


async def resolve(action: str) -> dict:
    result = await _launcher("POST", "/update/resolve", json={"action": action}, timeout=1800)
    await _follow()
    return result


async def run(task_state: dict[str, str]) -> None:
    global _task_state
    _task_state = task_state
    try:
        await _follow()  # dès le démarrage : un serveur recréé en pleine transaction reprend la maintenance
    except Exception:  # noqa: BLE001
        pass
    await asyncio.sleep(60)
    while True:
        try:
            await tick()
        except Exception as e:  # noqa: BLE001 - la boucle ne doit jamais s'arrêter
            print(f"[mises à jour] {e}", flush=True)
        await _until_next_tick()


async def _until_next_tick() -> None:
    """Pendant une installation, on suit le journal de près : Noah accepte à nouveau les écritures dès la fin, pas au
    prochain tour, jusqu'à 5 minutes plus tard."""
    for _ in range(30):
        await asyncio.sleep(10)
        if maintenance:
            try:
                await _follow()
            except Exception as e:  # noqa: BLE001 - lanceur en cours de remplacement : on réessaie au passage suivant
                print(f"[mises à jour] suivi : {e}", flush=True)


async def tick(now: float | None = None) -> str | None:
    """Un tour de la boucle : suivi, vérification, et installation si c'est le moment. Rend la raison d'attendre."""
    await _follow()
    state = _load()
    if time.time() - state.get("verifie", 0) > CHECK_EVERY:
        state = await check()
    if PUBLIC_KEY and state.get("disponible"):
        now = now or time.time()
        reason = due(state, now)
        if reason is None:
            etat = (await _launcher("GET", "/update/status", timeout=10)).get("etat", {})
            failed = _failed_here(state["disponible"], etat)
            reason = f"elle a déjà échoué ici ({', '.join(failed)}) : elle attend la suivante ou un clic" if failed else None
        reason = reason or await routine_soon()
        if reason is None:
            result = await install()
            if not result.get("ok", True) or result.get("erreur"):
                print(f"[mises à jour] {state['disponible']['version']} : {result.get('erreur')}", flush=True)
                if not str(result.get("erreur", "")).startswith("Pas maintenant"):
                    _patch({"reessai_apres": int(time.time()) + RETRY_AFTER})
                return result.get("erreur")
        elif _in_window(state, now) and reason != "à jour":
            # Le journal prouve chaque report : quand, et pourquoi (tâche, validation, écran, routine…).
            print(f"[mises à jour] {state['disponible']['version']} reportée : {reason}", flush=True)
            _patch(lambda s: s.update(reports=(s.get("reports", []) + [{"quand": int(now), "texte": reason}])[-50:]))
        return reason
    return "à jour"


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
    failed = _failed_here(manifest, etat) if manifest else []
    attente = due(state, now)
    if attente is None and failed:
        attente = f"elle a déjà échoué ici ({', '.join(failed)})"
    return {
        "version": shown_version(),
        "disponible": {"version": _shown(manifest), "correction": _shown(manifest) == shown_version(), "notes": manifest.get("notes", ""),
                       "majeure": bool(state.get("majeure")), "migration": bool(manifest.get("migration")),
                       "ignoree": state.get("ignoree") == manifest["version"],
                       "composants": sorted(pending(manifest, launcher.get("actuel", {}), etat.get("images")))} if manifest else None,
        "attente": attente,
        "occupe": busy(),
        "auto": state.get("auto", True),
        "heure": state.get("heure", "auto"),
        "creneau": f"{hour} h – {(hour + WINDOW_HOURS) % 24} h",
        "fuseau": str(_zone(state)),
        "verifie": state.get("verifie"),
        "erreur": state.get("erreur") or (None if PUBLIC_KEY else "Les versions ne sont pas encore signées : "
                                          "les mises à jour automatiques sont désactivées."),
        "en_cours": bool(etat.get("en_cours")) and etat["en_cours"].get("phase") != "intervention",
        "intervention": (etat.get("en_cours") or {}).get("non_restaures") if (etat.get("en_cours") or {}).get("phase") == "intervention" else None,
        "gardes": etat.get("gardes") or [],
        "dernier_rapport": etat.get("dernier_rapport"),
        "historique": list(reversed(etat.get("historique", [])))[:20],
    }


def settings(auto: bool | None, heure: str | int | None) -> None:
    def change(state):
        if auto is not None:
            state["auto"] = bool(auto)
        if heure is not None:
            state["heure"] = "auto" if heure == "auto" else max(0, min(23, int(heure)))
    _patch(change)


def skip() -> None:
    """« Ignorer » : cette version ne s'installe pas seule et sa carte disparaît ; la suivante, si."""
    _patch(lambda s: s.update(ignoree=s["disponible"]["version"]) if s.get("disponible") else None)


def postpone(days: int = 1) -> None:
    _patch({"reportee": int(time.time()) + days * 86400})
