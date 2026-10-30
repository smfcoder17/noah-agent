"""Petit outil d'administration exécuté DANS la machine d'un agent, au nom de l'utilisateur hermes.

Le lanceur le passe à l'interpréteur d'Hermes : `python -c <ce fichier> <action> <json>`. Il lit et
écrit avec les modules d'Hermes eux-mêmes (routines) ou ses fichiers (mémoire), pour que l'agent et
l'interface voient toujours la même chose. Réponse : une ligne JSON sur la sortie standard.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/opt/hermes")
DATA = Path("/opt/data")
NOAH = DATA / ".noah"
GOOGLE = DATA / "skills/productivity/google-workspace/scripts/setup.py"
MEMORY_SEP = "\n§\n"


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=str))
    sys.exit(0)


def fail(message):
    print(json.dumps({"erreur": message}, ensure_ascii=False))
    sys.exit(2)


# --- Ordinateur ----------------------------------------------------------------------

def computer(_):
    disk = shutil.disk_usage(DATA)
    try:
        used = int(subprocess.run(["du", "-sb", str(DATA / "workspace")], capture_output=True, text=True,
                                  timeout=8).stdout.split()[0])
    except (subprocess.SubprocessError, IndexError, ValueError):
        used = None
    pkgs = NOAH / "packages.txt"
    return {
        "disque": {"total": disk.total, "libre": disk.free, "utilise": disk.used},
        "espace_de_travail": used,
        "paquets": pkgs.read_text().split() if pkgs.exists() else [],
    }


# --- Mémoire --------------------------------------------------------------------------

def _limits():
    try:
        import yaml
        cfg = (yaml.safe_load((DATA / "config.yaml").read_text()) or {}).get("memory", {})
    except Exception:
        cfg = {}
    return {"memory": cfg.get("memory_char_limit", 2200), "user": cfg.get("user_char_limit", 1375)}


def _memory_file(target):
    return DATA / "memories" / ("USER.md" if target == "user" else "MEMORY.md")


def _entries(target):
    f = _memory_file(target)
    if not f.exists():
        return []
    return [e.strip() for e in f.read_text(encoding="utf-8").split(MEMORY_SEP) if e.strip()]


def memory(_):
    return {"memory": _entries("memory"), "user": _entries("user"), "limites": _limits()}


def memory_write(body):
    target = body.get("cible")
    if target not in ("memory", "user"):
        fail("Cible inconnue")
    entries = [str(e).strip() for e in body.get("entrees", []) if str(e).strip()]
    if any("§" in e for e in entries):
        fail("Le caractère § est réservé")
    text = MEMORY_SEP.join(entries)
    limit = _limits()[target]
    if len(text) > limit:
        fail(f"Trop long : {len(text)} caractères pour {limit} autorisés")
    f = _memory_file(target)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(f)
    return memory(None)


# --- Routines (cron d'Hermes) --------------------------------------------------------------

ROUTINE_FIELDS = ("id", "name", "prompt", "schedule_display", "enabled", "state", "next_run_at", "last_run_at",
                  "last_status", "last_error", "created_at", "paused_reason", "deliver")


def _routine(job):
    return {k: job.get(k) for k in ROUTINE_FIELDS}


def routines(_):
    from cron import jobs
    return {"routines": [_routine(j) for j in jobs.list_jobs(include_disabled=True)]}


def routine_create(body):
    from cron import jobs
    prompt = (body.get("consigne") or "").strip()
    schedule = (body.get("quand") or "").strip()
    if not prompt or not schedule:
        fail("Il faut une consigne et un moment")
    try:
        job = jobs.create_job(prompt, schedule, name=(body.get("nom") or None), deliver="local",
                              paused=bool(body.get("en_pause")))
    except ValueError as e:
        fail(f"Moment non compris : {e}")
    return _routine(job)


def routine_action(body):
    from cron import jobs
    job_id, action = body.get("id", ""), body.get("action")
    if action == "pause":
        job = jobs.pause_job(job_id, reason="Mise en pause depuis Noah Agent")
    elif action == "reprendre":
        job = jobs.resume_job(job_id)
    elif action == "lancer":
        job = jobs.trigger_job(job_id)
    elif action == "supprimer":
        return {"ok": jobs.remove_job(job_id)}
    elif action == "modifier":
        updates = {k: v for k, v in (("name", body.get("nom")), ("prompt", body.get("consigne"))) if v}
        job = jobs.update_job(job_id, updates)
    else:
        fail("Action inconnue")
    if not job:
        fail("Routine introuvable")
    return _routine(job)


def routine_outputs(body):
    """Résultats des routines plus récents que `depuis` (nom de fichier horodaté), pour la conversation."""
    since = body.get("depuis", "")
    root = DATA / "cron" / "output"
    found = []
    if root.exists():
        names = {}
        try:
            from cron import jobs
            names = {j["id"]: j.get("name") or j.get("prompt", "")[:40] for j in jobs.list_jobs(include_disabled=True)}
        except Exception:
            pass
        for d in root.iterdir():
            if not d.is_dir():
                continue
            for f in d.glob("*.md"):
                if f.stem <= since:
                    continue
                # Le fichier reprend la consigne et des métadonnées ; seule la réponse va dans la conversation.
                text = f.read_text(encoding="utf-8", errors="replace")
                text = text.split("\n## Response\n", 1)[-1].strip()
                if text and text != "[SILENT]":
                    found.append({"routine": d.name, "nom": names.get(d.name, d.name), "quand": f.stem,
                                  "texte": text[:20000]})
    found.sort(key=lambda r: r["quand"])
    return {"sorties": found[-20:]}


# --- Google (Gmail, Agenda, Drive) via la compétence google-workspace d'Hermes --------------------

def _gsetup(*args):
    """Lance le script de connexion de la compétence ; rend (réussi, lignes de sortie)."""
    r = subprocess.run([sys.executable, str(GOOGLE), *args], capture_output=True, text=True, timeout=60,
                       cwd=str(DATA), env={**os.environ, "HOME": str(DATA)})
    lines = [l.strip() for l in (r.stdout or "").splitlines() if l.strip()]
    errors = [l for l in lines if l.startswith("ERROR")]
    if r.returncode or errors:
        fail((errors[0].removeprefix("ERROR:").strip() if errors else (r.stderr or "").strip()[-300:]) or "Échec")
    return lines


def google(_):
    if not GOOGLE.exists():
        return {"disponible": False}
    r = subprocess.run([sys.executable, str(GOOGLE), "--check"], capture_output=True, text=True, timeout=30,
                       cwd=str(DATA), env={**os.environ, "HOME": str(DATA)})
    return {"disponible": True, "connecte": (r.stdout or "").lstrip().startswith("AUTHENTICATED"),
            "identifiants": (DATA / "google_client_secret.json").exists()}


def google_install(body):
    """Pose les identifiants et le jeton obtenus par Noah Agent (accord donné dans le navigateur de l'agent)."""
    if "installed" not in (body.get("client") or {}) or not (body.get("token") or {}).get("refresh_token"):
        fail("Identifiants ou jeton manquants")
    for name, data in (("google_client_secret.json", body["client"]), ("google_token.json", body["token"])):
        f = DATA / name
        f.write_text(json.dumps(data, indent=2), encoding="utf-8")
        f.chmod(0o600)
    (DATA / "google_oauth_pending.json").unlink(missing_ok=True)
    return {"ok": True}


def google_revoke(body):
    # « local » : Noah Agent gère l'accord ; révoquer chez Google le retirerait aussi aux autres agents.
    if not (body or {}).get("local"):
        try:
            _gsetup("--revoke")
        except SystemExit:
            pass
    for name in ("google_token.json", "google_client_secret.json"):
        (DATA / name).unlink(missing_ok=True)
    return google(None)


# --- Applications (catalogue MCP d'Hermes : Notion, Todoist, Linear…) ------------------------------

# Connexion OAuth lancée en arrière-plan : Hermes publie l'adresse d'autorisation puis attend le retour
# du fournisseur sur un port local de cette machine. L'utilisateur colle l'adresse de retour dans Noah
# Agent, qui la rejoue sur ce port.
MCP_LOGIN = r"""
import sys
sys.path.insert(0, "/opt/hermes")
from hermes_cli.mcp_config import _get_mcp_servers, _reauth_oauth_server
from tools.mcp_oauth import force_interactive_oauth
name = sys.argv[1]
with force_interactive_oauth():
    ok = _reauth_oauth_server(name, _get_mcp_servers()[name])
print("NOAH_RESULT", "ok" if ok else "echec", flush=True)
"""


def _mcp_log(name):
    return NOAH / f"mcp-{name}.log"


def _mcp_connected(name, cfg):
    if cfg.get("auth") != "oauth":
        return True
    from tools.mcp_oauth import HermesTokenStorage
    return HermesTokenStorage(name).has_cached_tokens()


def apps(_):
    from hermes_cli import mcp_catalog
    installed = mcp_catalog.installed_servers()
    out = []
    for e in mcp_catalog.list_catalog():
        cfg = installed.get(e.name)
        out.append({"nom": e.name, "description": (e.description or "").strip(), "source": e.source,
                    "oauth": e.auth.type == "oauth", "hote": (e.suggest.hosts[0] if e.suggest and e.suggest.hosts else None),
                    "installe": cfg is not None, "connecte": bool(cfg) and _mcp_connected(e.name, cfg)})
    return {"applications": out}


def _check_name(name):
    from hermes_cli import mcp_catalog
    entry = mcp_catalog.get_entry(name or "")
    if not entry:
        fail("Application inconnue")
    return entry


def app_connect(body):
    import re
    import time
    from hermes_cli import mcp_catalog
    from hermes_cli.mcp_config import _save_mcp_server
    entry = _check_name(body.get("nom"))
    if entry.auth.type != "oauth" and entry.auth.env:
        fail("Cette application demande des clés : pas encore prise en charge ici")
    if not _save_mcp_server(entry.name, mcp_catalog.card_install_config(entry)):
        fail("Configuration refusée par Hermes")
    if entry.auth.type != "oauth":
        return {"connecte": True}
    log = _mcp_log(entry.name)
    log.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pkill", "-f", f"NOAH_MCP_LOGIN {entry.name}$"], capture_output=True)
    with open(log, "w") as f:
        subprocess.Popen([sys.executable, "-c", MCP_LOGIN, entry.name, "NOAH_MCP_LOGIN", entry.name],
                         stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, start_new_session=True,
                         cwd=str(DATA), env={**os.environ, "HOME": str(DATA)})
    for _ in range(60):
        time.sleep(0.5)
        m = re.search(r"https://\S+redirect_uri=\S+", log.read_text(errors="replace"))
        if m:
            return {"adresse": m.group(0)}
    fail("Le fournisseur n'a pas rendu d'adresse d'autorisation : " + log.read_text(errors="replace")[-300:])


def app_finish(body):
    import re
    import time
    import urllib.parse
    import urllib.request
    entry = _check_name(body.get("nom"))
    pasted = (body.get("adresse") or "").strip()
    query = pasted.split("?", 1)[1] if "?" in pasted else pasted
    if "code=" not in query and "error=" not in query:
        fail("Colle l'adresse complète de la page de retour (elle contient « code= »)")
    log = _mcp_log(entry.name)
    text = log.read_text(errors="replace") if log.exists() else ""
    m = re.search(r"redirect_uri=([^&\s]+)", text)
    if not m:
        fail("Aucune connexion en cours : relance « Connecter »")
    callback = urllib.parse.unquote(m.group(1))
    try:
        urllib.request.urlopen(f"{callback}?{query.split('#')[0]}", timeout=10).read()
    except OSError as e:
        fail(f"La connexion en attente a expiré ({e}) : relance « Connecter »")
    for _ in range(60):
        text = log.read_text(errors="replace")
        if "NOAH_RESULT" in text:
            break
        time.sleep(0.5)
    if "NOAH_RESULT ok" not in text:
        why = re.search(r"Authentication failed: ([^\n]+)", text)
        fail("Connexion refusée : " + (why.group(1)[:200] if why else "relance « Connecter » et réessaie"))
    return {"connecte": True}


def app_remove(body):
    from hermes_cli import mcp_catalog
    from tools.mcp_oauth import HermesTokenStorage
    entry = _check_name(body.get("nom"))
    mcp_catalog.uninstall_entry(entry.name)
    HermesTokenStorage(entry.name).remove()
    return {"connecte": False}


ACTIONS = {
    "applications": apps, "application_connecter": app_connect, "application_finir": app_finish,
    "application_retirer": app_remove,
    "ordinateur": computer,
    "memoire": memory, "memoire_ecrire": memory_write,
    "routines": routines, "routine_creer": routine_create, "routine_action": routine_action,
    "routines_sorties": routine_outputs,
    "google": google, "google_revoquer": google_revoke,
    "google_installer": google_install,
}

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action not in ACTIONS:
        fail("Action inconnue")
    out(ACTIONS[action](json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}))
