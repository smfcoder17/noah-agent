"""Petit outil d'administration exécuté DANS la machine d'un agent, au nom de l'utilisateur hermes.

Le lanceur le passe à l'interpréteur d'Hermes : `python -c <ce fichier> <action> <json>`. Il lit et
écrit avec les modules d'Hermes eux-mêmes (routines) ou ses fichiers (mémoire), pour que l'agent et
l'interface voient toujours la même chose. Réponse : une ligne JSON sur la sortie standard.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/opt/hermes")
DATA = Path("/opt/data")
NOAH = DATA / ".noah"
GOOGLE = DATA / "skills/productivity/google-workspace/scripts/setup.py"
MEMORY_SEP = "\n§\n"

# Les applications que Noah connaît en plus du catalogue d'Hermes (brollss…), par nom. Un fichier du volume de l'agent :
# le lanceur le dépose avec le garde, et une version publiée peut en ajouter d'autres sans reconstruire l'image.
sys.path.insert(0, str(DATA))
try:
    from applications_extra import CATALOG as _EXTRA
except Exception:  # noqa: BLE001 - une installation sans ce fichier garde le catalogue d'Hermes seul
    _EXTRA = []
EXTRA_APPS = {a["nom"]: a for a in _EXTRA}


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
                  "last_status", "last_error", "created_at", "paused_reason", "deliver", "model", "enabled_toolsets")


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
        # Le modèle est un jeton du relais, et les outils un sous-ensemble vérifié par le serveur (noah/modes.py).
        job = jobs.create_job(prompt, schedule, name=(body.get("nom") or None), deliver="local",
                              paused=bool(body.get("en_pause")), model=body.get("model") or None,
                              enabled_toolsets=body.get("enabled_toolsets"))
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
        for field in ("model", "enabled_toolsets"):  # absent : on n'y touche pas ; None : retour au réglage de l'agent
            if field in body:
                updates[field] = body[field]
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

def _google_deps() -> bool:
    """Les bibliothèques Python de Google, déclarées par Hermes : absentes de l'image, et perdues quand la machine de
    l'agent est recréée. Noah les pose lui-même, sans que l'agent doive demander d'installer quoi que ce soit."""
    try:
        r = subprocess.run([sys.executable, str(GOOGLE), "--install-deps"], capture_output=True, text=True, timeout=600,
                           cwd=str(DATA), env={**os.environ, "HOME": str(DATA)})
        return r.returncode == 0 and "ERROR" not in (r.stdout or "")
    except (OSError, subprocess.TimeoutExpired):
        return False


def google(_):
    if not GOOGLE.exists():
        return {"disponible": False}
    token_file = DATA / "google_token.json"
    try:
        token = json.loads(token_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        token = {}
    base = _google_validate(*[token.get(k) for k in ("token", "refresh_token", "client_id", "client_secret")])
    if base:  # Le --check d'Hermes ne connaît pas la base locale du banc.
        return {"disponible": True, "connecte": bool(token.get("token")),
                "identifiants": (DATA / "google_client_secret.json").exists()}
    r = subprocess.run([sys.executable, str(GOOGLE), "--check"], capture_output=True, text=True, timeout=30,
                       cwd=str(DATA), env={**os.environ, "HOME": str(DATA)})
    if "dependencies unavailable" in (r.stdout or ""):  # machine recréée : réparée en arrière-plan, sans bloquer l'écran
        subprocess.Popen([sys.executable, str(GOOGLE), "--install-deps"], cwd=str(DATA), env={**os.environ, "HOME": str(DATA)},
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"disponible": True, "connecte": (r.stdout or "").lstrip().startswith("AUTHENTICATED"),
            "identifiants": (DATA / "google_client_secret.json").exists()}


def _google_dir(body) -> Path:
    """Le compte principal vit à la racine (là où la compétence le cherche) ; un autre compte, dans son dossier, que
    l'agent désigne avec HERMES_HOME=/opt/data/google-comptes/<dossier>."""
    folder = str((body or {}).get("dossier") or "")
    if not folder:
        return DATA
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,80}", folder):
        fail("Dossier de compte invalide")
    d = DATA / "google-comptes" / folder
    d.mkdir(parents=True, exist_ok=True)
    d.chmod(0o700)
    return d


def google_install(body):
    """Pose les identifiants et le jeton obtenus par Noah Agent (accord donné dans le navigateur de l'agent)."""
    if "installed" not in (body.get("client") or {}) or not (body.get("token") or {}).get("refresh_token"):
        fail("Identifiants ou jeton manquants")
    home = _google_dir(body)
    for name, data in (("google_client_secret.json", body["client"]), ("google_token.json", body["token"])):
        f = home / name
        f.write_text(json.dumps(data, indent=2), encoding="utf-8")
        f.chmod(0o600)
    (DATA / "google_oauth_pending.json").unlink(missing_ok=True)
    if GOOGLE.exists():
        _google_deps()  # sans elles, la première lecture de l'agenda demandait d'installer, donc ton accord
    return {"ok": True}


def google_read(_):
    """Pour un connecteur global (server/noah/connecteurs.py) : Google ne fait pas tourner ses jetons, cette copie ne casse rien."""
    try:
        return {"client": json.loads((DATA / "google_client_secret.json").read_text(encoding="utf-8")),
                "token": json.loads((DATA / "google_token.json").read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        fail("Google n'est pas connecté à cet agent.")


def google_revoke(body):
    # « local » : Noah Agent gère l'accord ; révoquer chez Google le retirerait aussi aux autres agents.
    if (body or {}).get("dossier"):  # un compte de plus : seulement son dossier
        home = _google_dir(body)
        for name in ("google_token.json", "google_client_secret.json"):
            (home / name).unlink(missing_ok=True)
        home.rmdir()
        return {"ok": True}
    if not (body or {}).get("local"):
        import urllib.parse
        f = DATA / "google_token.json"
        try:
            token = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            token = {}
        credential = token.get("refresh_token") or token.get("token")
        if credential:
            url = _google_url("https://oauth2.googleapis.com/revoke", token.get("token"), credential)
            try:
                with _google_open(url, data=urllib.parse.urlencode({"token": credential}).encode(), timeout=20) as r:
                    r.read()
            except OSError:
                pass  # Comme auparavant, retirer la copie locale même si Google ne répond pas.
    for name in ("google_token.json", "google_client_secret.json"):
        (DATA / name).unlink(missing_ok=True)
    return google(None)


# --- Relevé de Gmail et de l'Agenda, sans modèle (veilles et routines à condition) ---------------------------------------
# Le jeton reste ici, dans la machine de l'agent. Le serveur reçoit les nouveautés, jamais le jeton.

def _google_validate(*credentials):
    """Les jetons factices noah-banc-* ne quittent jamais le faux Google.

    La base locale ne remplace les hôtes Google qu'avec NOAH_BANC=1.
    Sans ce drapeau, la variable est ignorée et les faux jetons sont refusés.
    """
    import ipaddress
    from urllib.parse import urlsplit
    base = os.environ.get("NOAH_GOOGLE_BASE", "") if os.environ.get("NOAH_BANC") == "1" else ""
    if base:
        parts = urlsplit(base)
        host = parts.hostname or ""
        try:
            ip = ipaddress.ip_address(host)
            local = ip.is_loopback or any(ip in ipaddress.ip_network(n) for n in
                                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16") if ip.version == 4)
        except ValueError:
            local = host in ("localhost", "faux-google")
        if (parts.scheme != "http" or not local or parts.username is not None or parts.password is not None
                or parts.query or parts.fragment or parts.path not in ("", "/")):
            fail("Le faux Google du banc doit être une base HTTP locale, sans chemin ni identifiants.")
        return base
    if any(str(value or "").startswith("noah-banc-") for value in credentials):
        fail("Un jeton du banc ne peut pas être envoyé hors du faux Google : active NOAH_BANC=1 et NOAH_GOOGLE_BASE.")
    return ""


def _google_url(url, *credentials):
    """Adresse Google redirigée après validation de la base et des identifiants."""
    from urllib.parse import urlsplit, urlunsplit
    base = _google_validate(*credentials)
    if not base:
        return url
    parts, source = urlsplit(base), urlsplit(url)
    if source.hostname not in ("gmail.googleapis.com", "www.googleapis.com", "oauth2.googleapis.com"):
        fail("Le banc refuse un hôte Google inconnu.")
    return urlunsplit((parts.scheme, parts.netloc, source.path, source.query, ""))


def _google_open(request, **kwargs):
    import urllib.request
    if os.environ.get("NOAH_BANC") == "1" and os.environ.get("NOAH_GOOGLE_BASE"):
        class SansRedirection(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        # Pas de proxy ni de redirection qui emporterait le faux jeton ailleurs.
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), SansRedirection()).open(request, **kwargs)
    return urllib.request.urlopen(request, **kwargs)


def _google_token():
    import datetime
    import urllib.parse
    import urllib.request
    f = DATA / "google_token.json"
    if not f.exists():
        fail("Google n'est pas connecté à cet agent : Détails → Connexions.")
    t = json.loads(f.read_text(encoding="utf-8"))
    expiry = str(t.get("expiry") or "").replace("Z", "+00:00")
    try:
        fresh = datetime.datetime.fromisoformat(expiry) > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=60)
    except ValueError:
        fresh = False
    if t.get("token") and fresh:
        _google_validate(*[t.get(k) for k in ("token", "refresh_token", "client_id", "client_secret")])
        return t["token"]
    data = urllib.parse.urlencode({"client_id": t.get("client_id"), "client_secret": t.get("client_secret"),
                                   "refresh_token": t.get("refresh_token"), "grant_type": "refresh_token"}).encode()
    url = _google_url(t.get("token_uri") or "https://oauth2.googleapis.com/token",
                      t.get("token"), t.get("refresh_token"), t.get("client_id"), t.get("client_secret"))
    try:
        with _google_open(url, data=data, timeout=20) as r:
            answer = json.load(r)
    except OSError:
        fail("Google n'a pas renouvelé l'accès : refais l'accord dans Détails → Connexions.")
    t["token"] = answer["access_token"]
    t["expiry"] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=int(answer.get("expires_in", 3600)) - 60)).strftime("%Y-%m-%dT%H:%M:%SZ")
    tmp = f.with_suffix(".tmp")  # le fichier que lit aussi la compétence google-workspace : jamais à moitié écrit
    tmp.write_text(json.dumps(t, indent=2), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(f)
    return t["token"]


def _google_get(url, token):
    import urllib.error
    import urllib.request
    req = urllib.request.Request(_google_url(url, token), headers={"Authorization": f"Bearer {token}"})
    try:
        with _google_open(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        e.close()
        if e.code in (401, 403):
            fail("Google refuse cette lecture : l'accès n'est pas coché dans Détails → Connexions.")
        fail(f"Google répond {e.code}.")
    except OSError:
        fail("Google est injoignable.")


def _gmail(token, query, known):
    import urllib.parse
    base = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
    q = query or "in:inbox newer_than:2d"
    listed = _google_get(f"{base}?{urllib.parse.urlencode({'q': q, 'maxResults': 25})}", token).get("messages") or []
    keys = [m["id"] for m in listed]
    items = []
    for key in keys:
        if key in known:
            continue  # déjà vu : pas de seconde requête, et rien ne ressort de la boîte
        msg = _google_get(f"{base}/{key}?format=metadata&metadataHeaders=From&metadataHeaders=Subject", token)
        heads = {h["name"].lower(): h["value"] for h in (msg.get("payload") or {}).get("headers") or []}
        items.append({"cle": key, "titre": f"De {heads.get('from', '?')} : {heads.get('subject', '(sans objet)')}"[:300],
                      "lien": f"https://mail.google.com/mail/u/0/#inbox/{key}", "texte": str(msg.get("snippet") or "")[:500]})
    return keys, items


def _agenda(token, hours):
    import datetime
    import urllib.parse
    now = datetime.datetime.now(datetime.timezone.utc)
    window = {"timeMin": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "timeMax": (now + datetime.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "singleEvents": "true", "orderBy": "startTime", "maxResults": 25}
    found = _google_get("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + urllib.parse.urlencode(window), token)
    keys, items = [], []
    for e in found.get("items") or []:
        key = f"{e.get('id')}:{e.get('updated', '')}"  # un événement déplacé est une nouveauté
        start = (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date") or ""
        keys.append(key)
        items.append({"cle": key, "titre": str(e.get("summary") or "(sans titre)")[:300], "lien": str(e.get("htmlLink") or ""),
                      "texte": " — ".join(x for x in (start, str(e.get("location") or ""), str(e.get("description") or "")[:300]) if x)})
    return keys, items


def source_google(body):
    token, service, query = _google_token(), body.get("service"), str(body.get("requete") or "").strip()
    if service == "gmail":
        keys, items = _gmail(token, query, set(body.get("connus") or []))
    elif service == "agenda":
        keys, items = _agenda(token, int(query) if query.isdigit() else 24)
    else:
        fail("Source inconnue")
    return {"cles": keys, "elements": items}


# --- Applications (catalogue MCP d'Hermes : Notion, Todoist, Linear…) ------------------------------

# Connexion OAuth lancée en arrière-plan : Hermes publie l'adresse d'autorisation puis attend le retour
# du fournisseur sur un port local de cette machine. Le fournisseur revient sur l'adresse publique de Noah,
# qui rejoue son retour sur ce port (voir connexion.py). S'il refuse cette adresse, retour classique en
# 127.0.0.1 : l'utilisateur colle alors l'adresse affichée dans Noah Agent, rejouée de la même façon.
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
    from hermes_cli.mcp_config import _get_mcp_servers
    installed = mcp_catalog.installed_servers()
    out = []
    for e in mcp_catalog.list_catalog():
        cfg = installed.get(e.name)
        out.append({"nom": e.name, "description": (e.description or "").strip(), "source": e.source,
                    "oauth": e.auth.type == "oauth", "hote": (e.suggest.hosts[0] if e.suggest and e.suggest.hosts else None),
                    "installe": cfg is not None, "connecte": bool(cfg) and _mcp_connected(e.name, cfg),
                    "url": (cfg or {}).get("url")})
    catalog = {a["nom"] for a in out}
    # Les applications que Noah connaît en plus du catalogue d'Hermes (brollss…) : même carte, même parcours.
    for extra in _EXTRA:
        cfg = installed.get(extra["nom"])
        out.append({**{k: extra[k] for k in ("nom", "description", "source", "hote")},
                    "oauth": bool(extra["oauth"]), "installe": cfg is not None,
                    "connecte": bool(cfg) and _mcp_connected(extra["nom"], cfg), "url": (cfg or {}).get("url") or extra["url"]})
        catalog.add(extra["nom"])
    # Les outils ajoutés par adresse : seul Hermes sait si leur connexion OAuth a abouti.
    personal = {name: {"connecte": _mcp_connected(name, cfg)} for name, cfg in _get_mcp_servers().items() if name not in catalog}
    return {"applications": out, "personnels": personal}


def _check_name(name):
    from hermes_cli import mcp_catalog
    entry = mcp_catalog.get_entry(name or "")
    if not entry:
        fail("Application inconnue")
    return entry


def app_connect(body):
    from hermes_cli import mcp_catalog
    from hermes_cli.mcp_config import _save_mcp_server
    name = str(body.get("nom") or "")
    extra = EXTRA_APPS.get(name)
    if extra:  # une application ajoutée par Noah, absente du catalogue d'Hermes
        if not _save_mcp_server(name, {"url": extra["url"], "auth": "oauth" if extra["oauth"] else "none", "enabled": True}):
            fail("Configuration refusée par Hermes")
        return _start_login(name, body.get("retour") or "") if extra["oauth"] else {"connecte": True}
    entry = _check_name(name)
    if entry.auth.type != "oauth" and entry.auth.env:
        fail("Cette application demande des clés : pas encore prise en charge ici")
    if not _save_mcp_server(entry.name, mcp_catalog.card_install_config(entry)):
        fail("Configuration refusée par Hermes")
    if entry.auth.type != "oauth":
        return {"connecte": True}
    return _start_login(entry.name, body.get("retour") or "")


def _set_callback(name, retour):
    """Où le fournisseur doit revenir. Le port reste celui où Hermes attend dans cette machine."""
    import socket
    from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server
    cfg = dict(_get_mcp_servers()[name])
    oauth = {k: v for k, v in (cfg.get("oauth") or {}).items() if k not in ("redirect_uri", "redirect_port", "timeout")}
    if oauth.get("client_name") == "Noah Agent":
        del oauth["client_name"]
    if retour:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        oauth.update(redirect_uri=retour, redirect_port=port, timeout=600)
        if "figma" not in name:  # Figma n'accepte que les noms de sa liste : Hermes en pose un lui-même
            oauth["client_name"] = "Noah Agent"
    if oauth:
        cfg["oauth"] = oauth
    else:
        cfg.pop("oauth", None)
    if not _save_mcp_server(name, cfg):
        fail("Configuration refusée par Hermes")


def _start_login(name, retour=""):
    """L'adresse d'autorisation. Avec `retour` : sans copier-coller. Un fournisseur qui refuse cette adresse de retour
    (la sienne doit être en 127.0.0.1) garde la voie classique : la personne colle l'adresse."""
    if retour:
        _set_callback(name, retour)
        found = _run_login(name)
        if found:
            return {"adresse": found, "retour": True}
    _set_callback(name, "")
    found = _run_login(name)
    if not found:
        fail("Le fournisseur n'a pas rendu d'adresse d'autorisation : " + _mcp_log(name).read_text(errors="replace")[-300:])
    return {"adresse": found, "retour": False}


def _run_login(name):
    import re
    import time
    log = _mcp_log(name)
    log.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pkill", "-f", f"NOAH_MCP_LOGIN {name}$"], capture_output=True)
    with open(log, "w") as f:
        login = subprocess.Popen([sys.executable, "-c", MCP_LOGIN, name, "NOAH_MCP_LOGIN", name],
                                 stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, start_new_session=True,
                                 cwd=str(DATA), env={**os.environ, "HOME": str(DATA)})
    for _ in range(60):
        time.sleep(0.5)
        m = re.search(r"https?://\S+redirect_uri=\S+", log.read_text(errors="replace"))
        if m:
            return m.group(0)
        if login.poll() is not None:
            return None
    return None


def app_finish(body):
    return _finish_login(_check_name(body.get("nom")).name, body)


def _finish_login(name, body):
    import re
    import time
    import urllib.parse
    import urllib.request
    pasted = (body.get("adresse") or "").strip()
    query = pasted.split("?", 1)[1] if "?" in pasted else pasted
    if "code=" not in query and "error=" not in query:
        fail("Colle l'adresse complète de la page de retour (elle contient « code= »)")
    from hermes_cli.mcp_config import _get_mcp_servers
    log = _mcp_log(name)
    text = log.read_text(errors="replace") if log.exists() else ""
    m = re.search(r"redirect_uri=([^&\s]+)", text)
    if not m:
        fail("Aucune connexion en cours : relance « Connecter »")
    port = ((_get_mcp_servers().get(name) or {}).get("oauth") or {}).get("redirect_port")
    callback = urllib.parse.urlunsplit(("http", f"127.0.0.1:{port}", "/callback", "", "")) if port else urllib.parse.unquote(m.group(1))
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


# --- Outils ajoutés par adresse (G13) : le serveur de Noah a déjà vérifié l'adresse et testé la connexion ---------------

def _tool_name(body):
    import re
    name = body.get("nom") or ""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", name):
        fail("Nom d'outil refusé")
    return name


def tool_set(body):
    from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server
    name, cfg = _tool_name(body), body.get("config") or {}
    # Une commande locale (stdio) reviendrait à exécuter du code téléchargé (G7.6) : seule une adresse entre ici.
    if "command" in cfg or not str(cfg.get("url", "")).startswith(("http://", "https://")):
        fail("Seule une adresse est acceptée : pas de commande locale")
    if name in _get_mcp_servers():
        fail(f"Un outil s'appelle déjà « {name} »")
    if not _save_mcp_server(name, cfg):
        fail("Configuration refusée par Hermes")
    return _start_login(name, body.get("retour") or "") if cfg.get("auth") == "oauth" else {"connecte": True}


def tool_connect(body):
    return _start_login(_tool_name(body), body.get("retour") or "")


def tool_finish(body):
    from hermes_cli.mcp_config import _get_mcp_servers, _probe_single_server
    name = _tool_name(body)
    result = _finish_login(name, body)
    try:  # la liste des outils, maintenant que le serveur accepte Hermes
        found = _probe_single_server(name, _get_mcp_servers()[name])
        result["outils"] = [{"name": n, "description": d} for n, d in found]
    except Exception:  # connecté quand même : l'état dans Connexions dira si le serveur tombe
        result["outils"] = []
    return result


def tool_rights(body):
    return {"ok": True}


def tool_remove(body):
    from hermes_cli.mcp_config import _remove_mcp_server
    from tools.mcp_oauth import HermesTokenStorage
    name = _tool_name(body)
    _remove_mcp_server(name)
    HermesTokenStorage(name).remove()
    return {"connecte": False}


# --- Compétences : ce que la personne a enseigné. Des skills d'Hermes, dans une catégorie à nous ------------------------------
# Les seuls skills que l'écran voit et touche : ceux que l'agent apprend seul restent hors de portée de ces actions.
# Épinglés : le tri automatique d'Hermes ne les archive ni ne les fusionne.

COMPETENCES = "competences"
COMPETENCE_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
COMPETENCE_DESC_MAX = 60  # au-delà, Hermes refuse à la création : la description sert à choisir le skill


def _competences_dir():
    from tools.skill_manager_tool import _skills_dir
    return _skills_dir() / COMPETENCES


def _competence_slug(titre):
    import unicodedata
    text = unicodedata.normalize("NFKD", titre).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:50].strip("-") or "competence"


def _competence_md(name, titre, texte):
    desc = ("Façon de faire voulue : " + titre)[:COMPETENCE_DESC_MAX - 1].rstrip(" .") + "."
    return (f"---\nname: {name}\ndescription: {json.dumps(desc, ensure_ascii=False)}\ntitre: {json.dumps(titre, ensure_ascii=False)}\n---\n\n"
            f"# {titre}\n\n{texte.strip()}\n")


def _competence_read(folder):
    raw = (folder / "SKILL.md").read_text(encoding="utf-8")
    _, _, rest = raw.lstrip("\ufeff").partition("---")
    head, _, body = rest.partition("\n---")
    found = re.search(r"^titre:\s*(.+)$", head, re.M)
    try:
        titre = str(json.loads(found.group(1))) if found else folder.name
    except ValueError:
        titre = found.group(1).strip().strip("'\"")
    body = body.strip()
    if body.startswith(f"# {titre}"):
        body = body[len(titre) + 2:].strip()
    return {"nom": folder.name, "titre": titre, "texte": body}


def _competence_folder(name):
    if not COMPETENCE_NAME.fullmatch(str(name or "")):
        fail("Cette compétence n'existe pas")
    folder = _competences_dir() / name
    if not (folder / "SKILL.md").is_file():  # ni un skill que l'agent a appris seul, ni un chemin ailleurs
        fail("Cette compétence n'existe pas")
    return folder


def _skill_call(action, name, content=None, category=None):
    from tools.skill_manager_tool import skill_manage
    answer = json.loads(skill_manage(action=action, name=name, content=content, category=category))
    return answer if isinstance(answer, dict) else {}


def _pin(name, pinned):
    try:
        from tools import skill_usage
        skill_usage.set_pinned(name, pinned)
    except Exception:  # le tri automatique peut seulement le voir comme un autre : la compétence reste
        pass


def competence_list(_):
    root = _competences_dir()
    if not root.is_dir():
        return {"competences": []}
    found = [_competence_read(f) for f in sorted(root.iterdir()) if f.is_dir() and (f / "SKILL.md").is_file()]
    return {"competences": sorted(found, key=lambda c: c["titre"].lower())}


def _competence_text(body):
    titre, texte = " ".join(str(body.get("titre") or "").split()), str(body.get("texte") or "").strip()
    if not titre or not texte:
        fail("Il faut un titre et un texte")
    return titre, texte


def competence_add(body):
    titre, texte = _competence_text(body)
    base = _competence_slug(titre)
    for i in range(1, 30):  # un skill appris par l'agent peut déjà porter ce nom : on ne le touche pas
        name = base if i == 1 else f"{base[:46]}-{i}"
        answer = _skill_call("create", name, _competence_md(name, titre, texte), COMPETENCES)
        if answer.get("success"):
            _pin(name, True)
            return _competence_read(_competences_dir() / name)
        if "already exists" not in str(answer.get("error") or ""):
            fail(f"Compétence refusée : {str(answer.get('error') or answer)[:300]}")
    fail("Trop de compétences portent ce nom")


def competence_edit(body):
    folder = _competence_folder(body.get("nom"))
    titre, texte = _competence_text(body)
    _pin(folder.name, False)
    answer = _skill_call("edit", folder.name, _competence_md(folder.name, titre, texte))
    _pin(folder.name, True)
    if not answer.get("success"):
        fail(f"Compétence refusée : {str(answer.get('error') or answer)[:300]}")
    return _competence_read(folder)


def competence_remove(body):
    folder = _competence_folder(body.get("nom"))
    _pin(folder.name, False)
    answer = _skill_call("delete", folder.name)
    if not answer.get("success"):
        _pin(folder.name, True)
        fail(f"Compétence non retirée : {str(answer.get('error') or answer)[:300]}")
    return {"ok": True}


# --- Skills vus par la personne : tout ce que l'agent sait faire, d'où qu'il vienne -------------------------------------
# L'agent crée ses skills avec l'outil d'Hermes, qui les range à la racine de son dossier de skills, sans catégorie. Ils
# n'apparaissaient donc nulle part : l'écran ne lisait que `competences/`. Ici : tout skill présent, avec son origine
# (fourni avec Noah, enseigné, ou appris par l'agent), et les mêmes gestes qu'une compétence — lire, modifier, supprimer.
# Le manifeste `.bundled_manifest` (nom:empreinte) dit ce qui est fourni : le reste est à la personne ou à l'agent.

SKILL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def _skills_root():
    from tools.skill_manager_tool import _skills_dir
    return _skills_dir()


def _bundled() -> set[str]:
    try:
        text = (_skills_root() / ".bundled_manifest").read_text(encoding="utf-8")
    except OSError:
        return set()
    names = set()
    for line in text.splitlines():
        name = line.split(":", 1)[0].strip()
        if name:
            names.add(name)
    return names


def _skill_dirs():
    """Tous les SKILL.md sous le dossier de skills, un par skill. Les noms de dossier imbriqués (catégorie/skill)
    restent acceptés : Hermes les cherche ainsi."""
    root = _skills_root()
    if not root.is_dir():
        return []
    found = []
    for path in root.rglob("SKILL.md"):
        if any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        found.append(path.parent)
    return sorted(found)


def _front(text: str) -> tuple[dict, str]:
    """Le frontmatter YAML minimal (clé: valeur) et le corps. On ne charge pas YAML ici : deux champs suffisent, et un
    frontmatter exotique ne doit pas faire échouer la liste."""
    raw = text.lstrip("\ufeff")
    if not raw.startswith("---"):
        return {}, raw.strip()
    _, _, rest = raw.partition("---")
    head, sep, body = rest.partition("\n---")
    if not sep:
        return {}, raw.strip()
    fields: dict[str, str] = {}
    for line in head.splitlines():
        key, colon, value = line.partition(":")
        if colon and key.strip() and not value.startswith((" ", "\t")):
            fields[key.strip()] = value.strip().strip("'\"")
        elif colon and key.strip() in fields:  # une valeur repliée sur plusieurs lignes
            fields[key.strip()] += " " + value.strip().strip("'\"")
    return fields, body.strip()


def _skill_shown(folder, bundled: set[str]) -> dict:
    try:
        raw = (folder / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    fields, body = _front(raw)
    name = fields.get("name") or folder.name
    root = _skills_root()
    try:
        rel = folder.relative_to(root).as_posix()
    except ValueError:
        rel = folder.name
    category = rel.rsplit("/", 1)[0] if "/" in rel else ""
    taught = category.split("/")[0] == COMPETENCES or rel.startswith(COMPETENCES + "/")
    origin = "fourni avec Noah" if name in bundled or folder.name in bundled else ("enseigné par toi" if taught else "appris par ton agent")
    # Le titre se lit avant de retirer la ligne « # Titre » du corps : l'écran l'affiche déjà comme titre.
    title = _title_of(body, fields.get("description") or folder.name)
    body = re.sub(r"^#\s+[^\n]{1,200}\n+", "", body.lstrip(), count=1)
    return {"nom": rel, "titre": title,
            "resume": (fields.get("description") or "")[:300], "texte": body[:200_000], "origine": origin,
            "categorie": category, "fourni": origin == "fourni avec Noah", "modifiable": origin != "fourni avec Noah"}


def _title_of(body: str, fallback: str) -> str:
    found = re.search(r"^#\s+(.{1,120})$", body, re.M)
    return found.group(1).strip() if found else fallback


def skill_list(_):
    bundled = _bundled()
    out = [shown for shown in (_skill_shown(f, bundled) for f in _skill_dirs()) if shown]
    order = {"enseigné par toi": 0, "appris par ton agent": 1, "fourni avec Noah": 2}
    return {"skills": sorted(out, key=lambda s: (order.get(s["origine"], 3), s["titre"].lower()))}


def _skill_folder(name):
    """Le dossier d'un skill par son nom relatif (`categorie/skill`) ou son nom simple, s'il est unique."""
    wanted = str(name or "").strip().strip("/")
    if not wanted or ".." in wanted.split("/") or not all(SKILL_NAME.fullmatch(p) for p in wanted.split("/")):
        fail("Ce skill n'existe pas")
    root = _skills_root()
    for folder in _skill_dirs():
        try:
            rel = folder.relative_to(root).as_posix()
        except ValueError:
            continue
        if rel == wanted or folder.name == wanted:
            return folder
    fail("Ce skill n'existe pas")


def _skill_writable(folder):
    if folder.name in _bundled() or _skill_shown(folder, _bundled()).get("fourni"):
        fail("Ce skill vient avec Noah : il revient à chaque mise à jour, le modifier ici ne servirait à rien. "
             "Enseigne plutôt une compétence, qui reste et prime sur lui.")
    return folder


def skill_read(body):
    return _skill_shown(_skill_folder(body.get("nom")), _bundled())


def skill_write(body):
    """Modifier le texte libre d'un skill. Le frontmatter est conservé tel quel : seul le corps change."""
    folder = _skill_folder(body.get("nom"))
    _skill_writable(folder)
    title, text = " ".join(str(body.get("titre") or "").split()), str(body.get("texte") or "").strip()
    if not title or not text:
        fail("Il faut un titre et un texte")
    try:
        raw = (folder / "SKILL.md").read_text(encoding="utf-8")
    except OSError:
        fail("Ce skill n'existe pas")
    fields, _ = _front(raw)
    head, sep, _ = raw.lstrip("\ufeff").partition("\n---")
    front = (head + "\n---\n\n") if sep else f"---\nname: {folder.name}\ndescription: {json.dumps(title[:60], ensure_ascii=False)}\n---\n\n"
    (folder / "SKILL.md").write_text(f"{front}# {title}\n\n{text}\n", encoding="utf-8")
    return _skill_shown(folder, _bundled())


def skill_remove(body):
    folder = _skill_folder(body.get("nom"))
    _skill_writable(folder)
    rel = str(folder.relative_to(_skills_root()).as_posix())
    # Hermes refuse de supprimer un skill épinglé. Épingler n'est utile qu'aux compétences enseignées (le tri d'Hermes ne
    # les archive ni ne les fusionne) ; ici, la personne a demandé la suppression, elle passe avant.
    _pin(folder.name, False)
    answer = _skill_call("delete", rel)
    if not answer.get("success"):
        _pin(folder.name, True)
        fail(f"Skill non retiré : {str(answer.get('error') or answer)[:300]}")
    return {"ok": True}


# --- Profil d'une personne avec qui l'agent est partagé (G12.5) ----------------------------------------------------------
# Un vrai profil Hermes dans la même machine : sa mémoire, ses sessions, ses compétences et son identité de navigateur à lui.
# Il reçoit le modèle et le rôle de l'agent, jamais ses comptes : ni serveurs MCP, ni jetons Google, ni le .env en entier.
GUEST_ENV = ("API_SERVER_KEY", "CAMOFOX_URL", "CAMOFOX_API_KEY")


def _guest_home(body):
    name = str(body.get("profil", ""))
    if not re.fullmatch(r"u\d+[0-9a-f]{8}", name):
        fail("Profil invalide")
    return name, DATA / "profiles" / name


def guest_prepare(body):
    from ruamel.yaml import YAML  # le YAML d'Hermes : son environnement n'a pas PyYAML

    yaml = YAML(typ="safe")
    yaml.default_flow_style = False
    name, home = _guest_home(body)
    if not home.exists():
        made = subprocess.run([sys.executable, "-m", "hermes_cli.main", "profile", "create", name, "--no-alias"],
                              capture_output=True, text=True, timeout=110, cwd=DATA)
        if made.returncode != 0:
            fail(f"Profil non créé : {made.stdout[-300:]}{made.stderr[-300:]}")
    cfg = yaml.load((DATA / "config.yaml").read_text(encoding="utf-8")) or {}
    cfg.pop("mcp_servers", None)
    camofox = cfg.setdefault("browser", {}).setdefault("camofox", {})
    camofox["user_id"] = camofox["session_key"] = name  # un contexte Firefox à lui : d'autres cookies
    with open(home / "config.yaml", "w", encoding="utf-8") as f:
        yaml.dump(cfg, f)
    env = [line for line in (DATA / ".env").read_text(encoding="utf-8").splitlines() if line.split("=", 1)[0].strip() in GUEST_ENV]
    (home / ".env").write_text("\n".join(env) + "\n", encoding="utf-8")
    os.chmod(home / ".env", 0o600)
    soul = DATA / "SOUL.md"
    if soul.exists():
        shutil.copyfile(soul, home / "SOUL.md")
    garde = home / "plugins" / "noah-garde"
    garde.mkdir(parents=True, exist_ok=True)
    for file, text in (body.get("garde") or {}).items():
        if file in ("plugin.yaml", "__init__.py"):
            (garde / file).write_text(text, encoding="utf-8")
    _guard_loaded(name, home)
    return {"ok": True}


RELOAD = ("import json; from hermes_cli.plugins_activation import reload_running_gateway; "
          "print(json.dumps(reload_running_gateway() or {}))")


def _guard_loaded(name, home):
    """Hermes charge les extensions d'un profil une fois, à sa création : avant que la garde y soit. Sans elle, le terminal de
    ce profil lirait toute la machine : on la fait charger par la passerelle en service, et sa réponse fait foi."""
    answer = {}
    for attempt in range(12):  # la passerelle prend le nouveau profil en charge en quelques secondes
        done = subprocess.run([sys.executable, "-c", RELOAD], capture_output=True, text=True, timeout=30, cwd=DATA,
                              env={**os.environ, "HERMES_HOME": str(home)})
        try:
            answer = json.loads(done.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            answer = {}
        if answer.get("reloaded") and "noah-garde" in answer.get("plugins", []):
            return
        time.sleep(1)
    fail(f"Garde non chargée dans le profil {name} : {str(answer)[:200]}")


def guest_remove(body):
    name, home = _guest_home(body)
    if home.exists():
        done = subprocess.run([sys.executable, "-m", "hermes_cli.main", "profile", "delete", name, "--yes"],
                              capture_output=True, text=True, timeout=50, cwd=DATA)
        if done.returncode != 0:
            shutil.rmtree(home, ignore_errors=True)
    return {"ok": True}


ACTIONS = {
    "invite_preparer": guest_prepare, "invite_effacer": guest_remove,
    "applications": apps, "application_connecter": app_connect, "application_finir": app_finish,
    "application_retirer": app_remove,
    "outil_poser": tool_set, "outil_connecter": tool_connect, "outil_finir": tool_finish, "outil_droits": tool_rights,
    "outil_retirer": tool_remove,
    "ordinateur": computer,
    "memoire": memory, "memoire_ecrire": memory_write,
    "routines": routines, "routine_creer": routine_create, "routine_action": routine_action,
    "routines_sorties": routine_outputs,
    "google": google, "google_revoquer": google_revoke,
    "google_installer": google_install, "google_lire": google_read, "source_google": source_google,
    "competences": competence_list, "competence_ajouter": competence_add, "competence_modifier": competence_edit,
    "competence_retirer": competence_remove,
    "skills": skill_list, "skill_lire": skill_read, "skill_ecrire": skill_write, "skill_retirer": skill_remove,
}

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action not in ACTIONS:
        fail("Action inconnue")
    out(ACTIONS[action](json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}))
