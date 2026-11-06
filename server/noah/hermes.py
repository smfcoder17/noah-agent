"""Client des agents : le lanceur (cycle de vie, fichiers) et la gateway Hermes de chaque agent."""
import hashlib
import hmac
import json
import re
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

import httpx
import yaml

from .config import LAUNCHER_KEY, LAUNCHER_URL

LAUNCHER = {"Authorization": f"Bearer {LAUNCHER_KEY}"}


@dataclass
class Agent:
    id: str
    api_key: str
    profile: str | None = None  # profil Hermes d'une personne avec qui l'agent est partagé (voir access.separated)

    @property
    def url(self) -> str:
        return f"http://noah-agent-{self.id}:8642" + (f"/p/{self.profile}" if self.profile else "")

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}


# --- Client HTTP partagé -----------------------------------------------------------
# Créer un client httpx coûte ~15 ms (contexte TLS), en bloquant la boucle : un seul client garde ses connexions
# ouvertes vers le lanceur, les agents et les navigateurs. Chaque appel donne son propre délai.
_shared: httpx.AsyncClient | None = None


def http() -> httpx.AsyncClient:
    global _shared
    if _shared is None or _shared.is_closed:
        _shared = httpx.AsyncClient(timeout=30, limits=httpx.Limits(max_connections=200, max_keepalive_connections=40, keepalive_expiry=60))
    return _shared


# --- Lanceur ---------------------------------------------------------------------

async def _launcher(method: str, path: str, **kw) -> dict:
    r = await http().request(method, f"{LAUNCHER_URL}{path}", headers=LAUNCHER, timeout=kw.pop("timeout", 120), **kw)
    r.raise_for_status()
    return r.json()


async def statuses() -> dict[str, str] | None:
    """État de chaque conteneur d'agent ; None si le lanceur ne répond pas (à distinguer d'« aucun conteneur »)."""
    try:
        return {a["id"]: a["status"] for a in await _launcher("GET", "/agents")}
    except httpx.HTTPError:
        return None


async def create_container(agent_id: str) -> str:
    api_key = secrets.token_hex(32)
    await _launcher("POST", f"/agents/{agent_id}", json={"api_key": api_key})
    return api_key


def shared_folders(agent_id: str) -> list[dict]:
    """Dossiers de l'ordinateur partagés avec l'agent : [{nom, chemin, ecriture, travail}]."""
    from . import db

    return json.loads(db.get_setting(f"dossiers_{agent_id}") or "[]")


async def recreate_container(agent_id: str, api_key: str) -> None:
    """Conteneur d'un agent existant (son volume garde mémoire, fichiers et config), avec ses dossiers partagés."""
    folders = [{k: f[k] for k in ("nom", "chemin", "ecriture")} for f in shared_folders(agent_id)]
    await _launcher("POST", f"/agents/{agent_id}", json={"api_key": api_key, "dossiers": folders})


async def delete_container(agent_id: str) -> None:
    await _launcher("DELETE", f"/agents/{agent_id}")


async def restart(agent_id: str) -> None:
    await _launcher("POST", f"/agents/{agent_id}/restart")


async def prepare_guest(agent_id: str, profile: str) -> None:
    """Crée ou met à jour le profil Hermes d'une personne : même modèle et même rôle que l'agent, rien de sa mémoire ni de ses comptes."""
    garde = {name: (AGENT_PLUGIN / name).read_text(encoding="utf-8") for name in ("plugin.yaml", "__init__.py")}
    await _launcher("POST", f"/agents/{agent_id}/admin/invite_preparer", json={"profil": profile, "garde": garde}, timeout=120)


async def remove_guest(agent_id: str, profile: str) -> None:
    await _launcher("POST", f"/agents/{agent_id}/admin/invite_effacer", json={"profil": profile}, timeout=60)


def browser_secrets(agent_id: str) -> tuple[str, str]:
    """Clé d'API Camoufox et mot de passe VNC propres à l'agent (dérivés, rien à stocker)."""
    from .config import SECRET_KEY

    base = hmac.new(SECRET_KEY.encode(), f"browser:{agent_id}".encode(), hashlib.sha256).hexdigest()
    return base[:48], base[48:56]  # x11vnc ne lit que 8 caractères de mot de passe


def private_key(agent_id: str) -> str:
    """Clé du mode privé du navigateur (aucune capture pendant une prise en main). Distincte de la clé d'API que
    l'agent reçoit : l'agent ne peut pas couper lui-même la protection (G7.7)."""
    from .config import SECRET_KEY

    return hmac.new(SECRET_KEY.encode(), f"browser-prive:{agent_id}".encode(), hashlib.sha256).hexdigest()[:48]


def browser_host(agent_id: str) -> str:
    return f"noah-browser-{agent_id}"


async def stop_browser(agent_id: str) -> None:
    await _launcher("POST", f"/agents/{agent_id}/browser/stop", timeout=60)


async def restart_browser(agent_id: str) -> None:
    await _launcher("POST", f"/agents/{agent_id}/browser/restart")


# Identité Camoufox partagée par l'agent et l'écran : l'onglet que l'utilisateur voit est celui de l'agent.
BROWSER_USER = "noah"


async def browser_call(agent_id: str, method: str, path: str, timeout: float = 5, key: str | None = None, **kw) -> dict:
    """Appel direct à l'API Camoufox de l'agent. Lève httpx.HTTPError si le conteneur ne répond pas."""
    api_key = key or browser_secrets(agent_id)[0]
    r = await http().request(method, f"http://{browser_host(agent_id)}:9377{path}", headers={"Authorization": f"Bearer {api_key}"},
                             timeout=timeout, **kw)
    try:
        return r.json() | {"http_status": r.status_code}
    except ValueError:
        return {"http_status": r.status_code}


# Langue par pays (et région pour le Canada) quand on déduit l'identité du navigateur de l'IP.
LOCALES = {"FR": "fr-FR", "BE": "fr-BE", "CH": "fr-CH", "LU": "fr-LU", "MA": "fr-MA", "SN": "fr-SN", "CI": "fr-CI",
           "CM": "fr-CM", "US": "en-US", "GB": "en-GB", "AU": "en-AU", "DE": "de-DE", "ES": "es-ES", "IT": "it-IT",
           "PT": "pt-PT", "BR": "pt-BR", "MX": "es-MX", "NL": "nl-NL", "JP": "ja-JP"}


async def browser_identity() -> dict:
    """Langue et fuseau du navigateur : ceux de .env (NOAH_LOCALE / NOAH_TIMEZONE), sinon déduits
    une fois de l'adresse IP publique du serveur (la même que voient les sites)."""
    from . import db
    from .config import BROWSER_LOCALE, BROWSER_TIMEZONE

    if BROWSER_LOCALE and BROWSER_TIMEZONE:
        return {"locale": BROWSER_LOCALE, "timezone": BROWSER_TIMEZONE}
    saved = db.get_setting("browser_identity")
    if saved:
        return json.loads(saved)
    try:
        # Une seule fois, en HTTPS (ipinfo.io, sans compte) : pays, région et fuseau de l'adresse du serveur, pour
        # que le navigateur de l'agent ressemble à un visiteur de cet endroit. Fixer NOAH_LOCALE et
        # NOAH_TIMEZONE évite cet appel.
        async with httpx.AsyncClient(timeout=5) as c:
            geo = (await c.get("https://ipinfo.io/json")).json()
    except (httpx.HTTPError, ValueError):
        return {"locale": "", "timezone": ""}
    country = geo.get("country", "")
    quebec = geo.get("region") in ("Quebec", "Québec", "QC")
    locale = "fr-CA" if country == "CA" and quebec else ("en-CA" if country == "CA" else LOCALES.get(country, "en-US"))
    identity = {"locale": locale, "timezone": geo.get("timezone", "")}
    if identity["timezone"]:
        db.set_setting("browser_identity", json.dumps(identity))
    return identity


async def ensure_browser(agent_id: str) -> None:
    api_key, vnc_password = browser_secrets(agent_id)
    await _launcher("POST", f"/agents/{agent_id}/browser",
                    json={"api_key": api_key, "vnc_password": vnc_password, "private_key": private_key(agent_id),
                          **await browser_identity()}, timeout=900)  # le premier usage télécharge l'image


async def list_files(agent_id: str) -> list[dict]:
    return await _launcher("GET", f"/agents/{agent_id}/files")


async def read_file(agent_id: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=120) as c:
        return await c.get(f"{LAUNCHER_URL}/agents/{agent_id}/file", params={"path": path}, headers=LAUNCHER)


async def upload(agent_id: str, name: str, data: bytes, folder: str = "uploads") -> str:
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.put(f"{LAUNCHER_URL}/agents/{agent_id}/upload", params={"name": name, "folder": folder}, content=data, headers=LAUNCHER)
    r.raise_for_status()
    return r.json()["path"]


async def media(agent_id: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as c:
        return await c.get(f"{LAUNCHER_URL}/agents/{agent_id}/media", params={"path": path}, headers=LAUNCHER)


async def _read(agent_id: str, name: str) -> str:
    return (await _launcher("GET", f"/agents/{agent_id}/files/{name}"))["content"]


# --- Configuration du modèle et du rôle ------------------------------------------

# "env" ne sert plus qu'à nettoyer d'anciennes clés dans les agents et à savoir si une clé est requise.
PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "env": "OPENROUTER_API_KEY", "model": "anthropic/claude-sonnet-4.5"},
    "anthropic": {"label": "Anthropic (Claude)", "env": "ANTHROPIC_API_KEY", "model": "claude-sonnet-4-5"},
    "openai": {"label": "OpenAI", "env": "OPENAI_API_KEY", "model": "gpt-5"},
    "gemini": {"label": "Google Gemini", "env": "GEMINI_API_KEY", "model": "gemini-2.5-pro"},
    "ollama": {"label": "Ollama (cette machine ou une adresse)", "env": None, "model": "gpt-oss:20b"},
    "ollama-cloud": {"label": "Ollama Cloud", "env": "OLLAMA_API_KEY", "model": "gpt-oss:120b"},
    # Tout service qui parle l'API OpenAI : LM Studio, vLLM, LiteLLM, llama.cpp… La clé est facultative.
    "custom": {"label": "Autre service compatible OpenAI", "env": None, "model": ""},
}


def _agent_env(text: str, agent_id: str) -> str:
    """Retire toute clé de fournisseur du .env de l'agent (elles restent dans le serveur)
    et le branche sur son navigateur Camoufox."""
    api_key, _ = browser_secrets(agent_id)
    managed = {"CAMOFOX_URL": f"http://{browser_host(agent_id)}:9377", "CAMOFOX_API_KEY": api_key}
    drop = {p["env"] for p in PROVIDERS.values() if p["env"]} | set(managed)
    lines = [l for l in text.splitlines() if l.split("=", 1)[0].strip() not in drop]
    lines += [f"{k}={v}" for k, v in managed.items()]
    return "\n".join(lines) + "\n"


# Familles qui ont besoin de marqueurs de cache explicites (style Anthropic) ; les autres
# fournisseurs mettent en cache tout seuls tant que le début du prompt ne change pas.
CACHE_MARKER_MODELS = re.compile(r"claude|kimi|moonshot|qwen", re.I)
CONTEXT_LIMIT = 64000  # jetons envoyés au modèle : au-delà, le début de la conversation se résume (voir configure)


async def configure(agent_id: str, model: dict, role: str | None = None, restart_after: bool = True) -> None:
    """Branche l'agent sur le relais du serveur avec le modèle choisi (et son rôle), puis le redémarre.
    Sans `restart_after` : les fichiers seulement, pour un simple changement de modèle, que le relais applique déjà.

    L'agent ne reçoit jamais la clé du fournisseur : seulement l'adresse du relais et son jeton.
    """
    from .relay import RELAY_URL, token_for

    p = PROVIDERS[model["provider"]]
    model_id = model.get("model") or p["model"]
    files: dict[str, str] = {".env": _agent_env(await _read(agent_id, ".env"), agent_id)}

    cfg = yaml.safe_load(await _read(agent_id, "config.yaml") or "{}") or {}
    cfg["model"] = {
        "provider": "custom",
        "default": model_id,
        "base_url": RELAY_URL,
        "api_key": token_for(agent_id),
        "api_mode": "chat_completions",
    }
    # Déclare le relais comme route connue pour activer le cache de prompt quand le modèle en a besoin.
    cfg["custom_providers"] = [{
        "name": "noah",
        "base_url": RELAY_URL,
        "api_key": token_for(agent_id),
        "models": {model_id: {"prompt_caching": bool(CACHE_MARKER_MODELS.search(model_id))}},
    }]
    # Navigateur Camoufox (anti-détection), profil et cookies gardés entre les sessions.
    browser = cfg.setdefault("browser", {})
    browser["cloud_provider"] = "camofox"
    camofox = browser.setdefault("camofox", {})
    camofox["managed_persistence"] = True
    # Un seul onglet nommé, partagé avec l'écran de Noah Agent (qui peut le rouvrir quand l'écran est vide).
    camofox["user_id"] = BROWSER_USER
    camofox["session_key"] = BROWSER_USER
    camofox["adopt_existing_tab"] = True
    # Les commandes de l'agent démarrent dans son espace de travail, pas au milieu de sa config.
    cfg.setdefault("terminal", {})["cwd"] = "/opt/data/workspace"
    # Contexte : Hermes garde l'historique de chaque conversation et ne reçoit que le nouveau message, et il le renvoie
    # entier à chaque tour. Le premier mot d'un simple « bonjour » suit sa taille, cache froid : 1,4 s à 16 000 jetons,
    # 6 s à 78 000, 17 s à 262 000 (Kimi K3, docs/perf.md). Au-delà de 64 000 jetons (~17 000 de consignes et d'outils
    # compris), le début devient un résumé et la fin reste mot pour mot, un peu plus large que par défaut (30 % du seuil) ;
    # l'agent retrouve le détail avec session_search. Après une pause, sans message, Hermes résumerait au message
    # suivant, avant de répondre (plusieurs secondes d'attente) : désactivé.
    compression = cfg.setdefault("compression", {})
    compression["enabled"] = True
    compression["threshold_tokens"] = CONTEXT_LIMIT
    compression["target_ratio"] = 0.3
    compression["idle_compact_after_seconds"] = 0
    # Hermes propose par défaut des connexions hébergées par son éditeur (Nous Portal), et se crée pour cela un compte
    # anonyme chez lui : les comptes de la personne passeraient par un tiers. Chez Noah, tout passe par Détails > Connexions.
    tools_cfg = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    cfg["tools"] = {**tools_cfg, "connectors": {"enabled": False}}
    cfg["nous"] = {**(cfg.get("nous") if isinstance(cfg.get("nous"), dict) else {}), "guest": False}
    # Les routines (« chaque matin à 8 h ») et « aujourd'hui » suivent l'heure de la personne, vue par ses apps. Le fuseau du
    # navigateur, lui, suit l'adresse du serveur : un site comparerait les deux. Il ne sert que tant qu'aucune app n'a parlé.
    from .updates import client_zone  # ici : updates importe machine, qui importe ce module
    tz = client_zone() or (await browser_identity()).get("timezone")
    if tz:
        cfg["timezone"] = tz
    _set_helpers(cfg, agent_id, model_id)
    # Garde de Noah (G7.6) : skills tiers seulement depuis les dépôts vérifiés, aucun script téléchargé exécuté d'un
    # trait, et jamais de commandes shell dans le texte d'un skill.
    plugins = cfg.setdefault("plugins", {})
    plugins["enabled"] = sorted(set(plugins.get("enabled") or []) | {"noah-garde"})
    plugins["hook_callback_timeout"] = 600  # réveiller le navigateur dépasse les 30 s d'Hermes, qui bloquerait l'outil
    cfg.setdefault("skills", {})["inline_shell"] = False
    # Une routine n'a personne pour dire oui : un outil en « confirmer » y est refusé, jamais accepté tout seul (G13.2).
    cfg.setdefault("approvals", {})["cron_mode"] = "deny"
    # Une personne avec qui l'agent est partagé parle à son propre profil Hermes, /p/<profil>/… sur la même adresse (G12.5).
    cfg["gateway"] = {**(cfg.get("gateway") or {}), "multiplex_profiles": True}  # une config neuve peut dire « gateway: » sans rien
    for name in ("plugin.yaml", "__init__.py"):
        files[f"plugins/noah-garde/{name}"] = (AGENT_PLUGIN / name).read_text(encoding="utf-8")
    files["config.yaml"] = yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True)

    if role is not None:
        files["SOUL.md"] = role.strip() + "\n"
    files["noah.py"] = AGENT_TOOL.replace("__TOKEN__", token_for(agent_id))

    await _launcher("PUT", f"/agents/{agent_id}/files", json={"files": files})
    if role is not None:  # nouvelles consignes : les conversations en cours doivent les voir
        await _launcher("POST", f"/agents/{agent_id}/refresh-prompts")
    if restart_after:
        await restart(agent_id)


def _set_helpers(cfg: dict, agent_id: str, brain: str) -> None:
    """Les petits travaux qu'Hermes fait seul passent par le modèle de décision, toujours à travers le relais (comptés, plafonnés) :
    la relecture de mémoire après un tour (sinon ~30 000 jetons du cerveau toutes les 10 passes) et le titre des conversations.
    Le résumé d'une longue conversation reste au cerveau : il décide de ce que l'agent saura ensuite."""
    from . import decision
    from .relay import RELAY_URL, token_for

    helper = decision.model()
    aux = cfg.get("auxiliary") if isinstance(cfg.get("auxiliary"), dict) else {}
    for task in ("background_review", "title_generation"):
        aux.pop(task, None)
        if helper and helper != brain:
            aux[task] = {"provider": "custom", "model": helper, "base_url": RELAY_URL, "api_key": token_for(agent_id)}
    if "background_review" in aux:
        aux["background_review"]["max_input_tokens"] = 30000  # une relecture ne doit jamais coûter plus que le tour qu'elle relit
    cfg["auxiliary"] = aux


async def set_helpers(agent_id: str) -> None:
    """Hermes relit ces réglages à chaque relecture : un nouveau modèle de décision ne redémarre pas l'agent ni ne coupe un tour."""
    cfg = yaml.safe_load(await _read(agent_id, "config.yaml") or "{}") or {}
    brain = ((cfg.get("model") or {}).get("default") or "") if isinstance(cfg.get("model"), dict) else ""
    _set_helpers(cfg, agent_id, brain)
    await _launcher("PUT", f"/agents/{agent_id}/files", json={"files": {"config.yaml": yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True)}})


AGENT_PLUGIN = Path(__file__).parent / "agent_plugin"

# Outil en ligne de commande (noah.py) posé dans la machine de l'agent : il parle au serveur avec le jeton de relais.
AGENT_TOOL = r'''#!/usr/bin/env python3
"""Outil de l'agent pour parler à Noah Agent : diagnostic, navigateur, fils, médias."""
import hashlib
import http.client
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

URL = "http://noah-server:8080/agent-api"
TOKEN = "__TOKEN__"
MAX_SEND = 300 * 2**20
AIDE = """Utilisation : python3 /opt/data/noah.py <commande>
  etat                         diagnostic (navigateur, écran, budget) avec un conseil
  reglages [type]              réglages non sensibles ; avec un type (image, video, musique, voix-modele, dictee, voix) : les choix possibles
  regler <type> <valeur>       change un réglage (type ci-dessus, ou gouts) ; auto revient au choix automatique
  navigateur reveiller         rallume le navigateur et son écran
  navigateur redemarrer        redémarre le navigateur (écran noir, figé, injoignable) ; profil et cookies gardés
  navigateur telecharger 'https://…' nom.jpg   range un fichier en ligne dans /opt/data/workspace/uploads/ ; rend son chemin
  navigateur envoyer <fichier> [fichier…] [--selecteur "css"] [--ref e12] [--onglet <id>]
                               joint des fichiers de /opt/data/workspace/ à la page ouverte ; regarde ensuite l'écran
  fil "Titre" "consigne"       ouvre un fil de travail parallèle, visible par l'utilisateur dans Détails
  fil-etat <id>                état et dernière réponse d'un fil
  image "description" [--format 16:9] [--contexte "goûts connus"] [--generer]
                                                    crée une image (ou conseille SVG/code si plus adapté)
  video "description" [--duree 5] [--format 16:9]   crée une vidéo (quelques minutes)
  musique "description"                             crée un morceau de musique
  voix "texte à dire"                               lit un texte à voix haute (MP3)
  installer paquet [paquet…]   installe des logiciels système (paquets Debian : ffmpeg, imagemagick, poppler-utils…)
  veille "Nom" <source> "ce qui compte" [--minutes 60]   surveille sans modèle et prévient seulement si c'est pertinent
  routine-si "Nom" <source> "condition" "ce que tu feras alors" [--minutes 30]
                               relève sans modèle, un petit modèle juge la condition, et tu n'es réveillé que si elle est remplie
                               <source> : https://… (page ou flux), gmail ou gmail:<recherche Gmail> (gmail:from:paul@exemple.fr),
                               agenda ou agenda:<heures à venir>, outil:<serveur>/<outil> (outil connecté, en lecture)
  routine "Nom" "horaire" --fichier consigne.txt   un travail à chaque passage, sans condition ; la consigne, complète et autonome, est dans ce fichier
                               horaire : "every day at 8am", "every monday 9am", "0 9 * * 1", "every 2h"
  routines                                      liste les routines ; routine-action <id> pause|reprendre|lancer|supprimer
  veilles                                       liste les veilles et les routines à condition
  veille-action <id> pause|reprendre|verifier|supprimer
  appeler "ce qu'il doit faire" [--quand-quitte accounts.google.com]
                                         appelle l'utilisateur (connexion, code) et attend sa réponse ; avec
                                         --quand-quitte, l'appel se termine seul quand il a quitté ce site
  attendre <id>                          continue d'attendre la réponse à un appel « en_attente »
  rappeler "compte rendu"                seulement s'il l'a demandé : fait sonner l'utilisateur et lui lit ce compte rendu ; il reste écrit
                                         dans ta conversation, même s'il ne répond pas (6 par heure au plus)
  agents                                 liste les autres agents (id, nom, rôle)
  demander <agent> "consigne" [--rappeler]   confie une tâche à un autre agent (id ou nom) ; le résultat revient dans ta
                                         conversation principale ; avec --rappeler, l'utilisateur est aussi rappelé
  demande-etat <id>                      état et dernière réponse d'une demande
  demandes                               tes demandes envoyées et reçues
  recette <service>                      étapes pour connecter un service à sa place (google)
  google-identifiants <ID client> <code secret>   enregistre l'accès Google créé avec la recette
  google-accord                          relance l'accord Google (après avoir publié l'application)
Sur l'ordinateur de l'utilisateur (application de bureau ouverte ; il confirme les actions sensibles) :
  ordinateur ouvrir <chemin|adresse>     ouvre un fichier ou dossier partagé (/opt/data/dossiers/…) ou une page web
  ordinateur notifier "titre" "texte"    notification sur son écran (fin d'une tâche, rappel, résultat de routine)
  ordinateur copier "texte"              met un texte dans son presse-papiers
  ordinateur lancer "application"        ouvre une application (ex. « Calculatrice », « Visual Studio Code »)
  ordinateur commande "commande"         exécute une commande (PowerShell sous Windows) dans son dossier de travail ou --dossier <dossier>
  ordinateur lister <dossier> [chemin]   liste un dossier qu'il t'a confié
  ordinateur lire <dossier> <chemin>     copie ce fichier dans /opt/data/workspace/ordinateur/ ; rend le chemin de la copie
  ordinateur ecrire <dossier> <chemin> <fichier> [--remplacer]   y dépose ton fichier ; ordinateur éteint : il attend sa reconnexion
  (chaque ordre d'ordinateur accepte --appareil <id ou nom>)
  appareils                              ses appareils : en ligne ou non, dossiers confiés, notifications possibles
  notifier "titre" "texte" [--appareil <id ou nom>]   notification sur cet appareil seulement, ou sur tous sans --appareil
Les fichiers créés vont dans /opt/data/workspace/outputs/ ; la réponse donne le widget à montrer."""


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"erreur": e.read().decode(errors="replace")[:500]}
    except OSError as e:
        return {"erreur": "Noah Agent injoignable : %s" % e}


def routine_text(words):
    """La consigne d'une routine : dans un fichier écrit à part (ni apostrophe ni guillemet n'y coupe rien), ou en toutes lettres."""
    if words[:1] != ["--fichier"]:
        return {"consigne": " ".join(words)}
    root = os.path.realpath(os.path.join(os.environ.get("HERMES_HOME") or "/opt/data", "workspace"))
    try:
        real = os.path.realpath(words[1])
        if not real.startswith(root + os.sep):  # un texte lu en ligne ne doit pas faire partir la configuration dans une consigne
            return {"erreur": "La consigne doit être un fichier de %s." % root}
        with open(real, encoding="utf-8") as f:
            text = f.read().strip()
    except (IndexError, OSError, ValueError) as e:
        return {"erreur": "Consigne illisible : %s" % e}
    return {"consigne": text} if text else {"erreur": "Le fichier de la consigne est vide."}


def option(words, name, valued=True):
    """Retire « --nom valeur » (ou « --nom ») de la liste ; rend sa valeur."""
    if name not in words:
        return "" if valued else False
    i = words.index(name)
    if not valued:
        del words[i]
        return True
    if i + 1 >= len(words) or words[i + 1].startswith("--"):
        print(json.dumps({"erreur": "%s attend une valeur." % name}, ensure_ascii=False))
        sys.exit(1)
    value = words[i + 1]
    del words[i : i + 2]
    return value


def save_download(response, path, expected):
    """Enregistre et vérifie : un serveur qui redémarre en route donne un fichier tronqué, sans autre signe."""
    base = os.path.basename(path.replace("\\", "/"))[:120] or "fichier"
    os.makedirs("/opt/data/workspace/ordinateur", exist_ok=True)
    stem, ext = os.path.splitext(base)
    target, n = "/opt/data/workspace/ordinateur/" + base, 2
    while os.path.exists(target):
        target, n = "/opt/data/workspace/ordinateur/%s (%d)%s" % (stem, n, ext), n + 1
    digest = hashlib.sha256()
    try:
        with open(target, "wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                out.write(chunk)
    except http.client.HTTPException as e:
        digest = None
    if digest is None or digest.hexdigest() != expected:
        if os.path.exists(target):
            os.unlink(target)
        return {"erreur": "Le fichier n'est pas arrivé entier : réessaie."}
    return {"ok": True, "fichier": target, "taille": os.path.getsize(target)}


def computer_read(device, folder, path):
    data = json.dumps({"appareil": device, "dossier": folder, "chemin": path}).encode()
    req = urllib.request.Request(URL + "/ordinateur/lire", data=data, method="POST",
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            if not r.headers.get("Content-Type", "").startswith("application/octet-stream"):
                return json.load(r)
            try:
                return save_download(r, path, r.headers.get("X-Noah-Empreinte", ""))
            except OSError as e:
                return {"erreur": "Impossible d'enregistrer ce fichier dans ta machine : %s" % e.strerror}
    except urllib.error.HTTPError as e:
        return {"erreur": e.read().decode(errors="replace")[:500]}
    except OSError as e:
        return {"erreur": "Noah Agent injoignable : %s" % e}


def computer_write(device, folder, path, local, replace):
    if not os.path.isfile(local):
        return {"erreur": "Ce fichier n'existe pas dans ta machine : %s" % local}
    query = urllib.parse.urlencode({"dossier": folder, "chemin": path, "appareil": device, "remplacer": "true" if replace else "false"})
    with open(local, "rb") as f:
        req = urllib.request.Request(URL + "/ordinateur/ecrire?" + query, data=f, method="POST",
                                     headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/octet-stream",
                                              "Content-Length": str(os.path.getsize(local))})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            return {"erreur": e.read().decode(errors="replace")[:500]}
        except OSError as e:
            return {"erreur": "Noah Agent injoignable : %s. Le fichier a peut-être été déposé quand même : regarde avec « ordinateur lister » avant de réessayer." % e}


def browser_access():
    """L'adresse et la clé du navigateur de ce profil, et son identité (un invité a la sienne)."""
    home = os.environ.get("HERMES_HOME") or "/opt/data"
    env = {}
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8") as f:
            for line in f:
                key, _, value = line.strip().partition("=")
                env[key] = value.strip().strip("\"'")
    except OSError:
        pass
    user = "noah"
    try:
        with open(os.path.join(home, "config.yaml"), encoding="utf-8") as f:
            found = re.search(r"camofox:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+user_id:\s*[\"']?([\w-]+)", f.read())
            user = found.group(1) if found else user
    except OSError:
        pass
    return home, env.get("CAMOFOX_URL") or os.environ.get("CAMOFOX_URL"), env.get("CAMOFOX_API_KEY") or os.environ.get("CAMOFOX_API_KEY"), user


def browser_post(base, key, path, query, data=None, size=0, timeout=60):
    req = urllib.request.Request(base + path + "?" + urllib.parse.urlencode(query), data=data if data is not None else b"", method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/octet-stream", "Content-Length": str(size)})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404 and path == "/noah/fichier":
            return {"erreur": "Ce navigateur ne sait pas encore recevoir de fichier : lance « noah.py navigateur redemarrer », puis réessaie."}
        text = e.read().decode(errors="replace")[:2000]
        try:
            body = json.loads(text)
        except ValueError:
            return {"erreur": text[:500]}
        return {"erreur": body.get("error", text[:500]), **({"champs": body["champs"]} if "champs" in body else {})}
    except OSError as e:
        return {"erreur": "Navigateur injoignable : %s. Lance « noah.py navigateur reveiller »." % e}


class HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise urllib.error.URLError("redirection hors de https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def browser_download(words):
    """Sans passer par le terminal : une adresse venue d'un outil ou d'une page reste une adresse, jamais une commande."""
    home = os.environ.get("HERMES_HOME") or "/opt/data"
    if "/profiles/" in home:
        return {"erreur": "Réservé au propriétaire de l'agent."}
    if len(words) != 2 or not words[0].lower().startswith("https://"):
        return {"erreur": "Il faut une adresse en https:// et un nom de fichier."}
    url, name = words
    # Le nom exact : la garde de l'agent retient ce fichier comme « téléchargé, pas encore lu » avant de le laisser lancer.
    if not re.fullmatch(r"[^\W_][\w .()-]{0,119}", name):
        return {"erreur": "Nom de fichier invalide : lettres, chiffres, espaces, . ( ) - et _ seulement, sans dossier."}
    folder = os.path.join(home, "workspace", "uploads")
    final = os.path.join(folder, name)
    os.makedirs(folder, exist_ok=True)
    temporary = os.path.join(folder, ".telechargement-%d.tmp" % os.getpid())
    size = 0
    try:
        opener = urllib.request.build_opener(HttpsOnly)
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "Noah"}), timeout=120) as r, open(temporary, "wb") as f:
            expected = r.headers.get("Content-Length")
            while chunk := r.read(1 << 20):
                size += len(chunk)
                if size > MAX_SEND:
                    return {"erreur": "Fichier trop lourd (300 Mo au plus)."}
                f.write(chunk)
        if not size:
            return {"erreur": "Fichier vide : l'adresse a peut-être expiré. Redemande-la à l'outil."}
        if expected and expected.isdigit() and int(expected) != size:
            return {"erreur": "Téléchargement coupé en route : recommence."}
        os.link(temporary, final)  # échoue si le nom existe : rien n'est écrasé
        return {"chemin": final, "octets": size}
    except FileExistsError:
        return {"erreur": "Ce nom existe déjà dans uploads/ : choisis-en un autre."}
    except urllib.error.HTTPError as e:
        return {"erreur": "Téléchargement refusé (%s) : l'adresse a peut-être expiré. Redemande-la à l'outil." % e.code}
    except (OSError, ValueError) as e:
        return {"erreur": "Téléchargement impossible : %s" % e}
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def browser_send(words):
    selector, ref, tab = option(words, "--selecteur"), option(words, "--ref"), option(words, "--onglet")
    if not words:
        return {"erreur": "Quel fichier joindre ?"}
    home, base, key, user = browser_access()
    if "/profiles/" in home:
        return {"erreur": "Réservé au propriétaire de l'agent."}
    if not base or not key:
        return {"erreur": "Navigateur non configuré sur cette machine."}
    # Seulement les fichiers de travail : un texte lu en ligne ne doit pas pouvoir faire déposer la configuration sur un site.
    root = os.path.realpath(os.path.join(home, "workspace"))
    ids = []
    for local in words:
        real = os.path.realpath(local)
        if not real.startswith(root + os.sep):
            return {"erreur": "Seuls les fichiers de %s se joignent à une page : %s" % (root, local)}
        if not os.path.isfile(real):
            return {"erreur": "Ce fichier n'existe pas dans ta machine : %s" % local}
        with open(real, "rb") as f:
            sent = browser_post(base, key, "/noah/fichier", {"nom": os.path.basename(real)}, f, os.path.getsize(real), 600)
        if "id" not in sent:
            return sent
        ids.append(sent["id"])
    query = {"userId": user, "fichiers": ",".join(ids)}
    for name, value in (("selecteur", selector), ("ref", ref), ("onglet", tab)):
        if value:
            query[name] = value
    return browser_post(base, key, "/noah/joindre", query, timeout=90)


def media(kind, args):
    opts, words, i = {}, [], 0
    while i < len(args):
        if args[i] in ("--format", "--duree", "--contexte", "--modele") and i + 1 < len(args):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        elif args[i] == "--generer":
            opts["generer"] = True
            i += 1
        else:
            words.append(args[i])
            i += 1
    return call("POST", "/media", {"type": kind, "description": " ".join(words), **opts})


a = sys.argv[1:]
if a[:1] in (["image"], ["video"], ["musique"], ["voix"]) and len(a) >= 2:
    out = media(a[0], a[1:])
elif a[:1] == ["etat"]:
    out = call("GET", "/etat")
elif a[:1] == ["reglages"]:
    out = call("GET", "/reglages" + ("?type=" + a[1] if len(a) > 1 else ""))
elif a[:1] == ["regler"] and len(a) >= 3:
    out = call("POST", "/reglages", {"type": a[1], "valeur": " ".join(a[2:])})
elif a[:2] == ["navigateur", "reveiller"]:
    out = call("POST", "/navigateur/reveiller")
elif a[:2] == ["navigateur", "redemarrer"]:
    out = call("POST", "/navigateur/redemarrer")
elif a[:2] == ["navigateur", "envoyer"]:
    out = browser_send(a[2:])
elif a[:2] == ["navigateur", "telecharger"]:
    out = browser_download(a[2:])
elif a[:1] == ["fil"] and len(a) >= 3:
    out = call("POST", "/fils", {"titre": a[1], "consigne": " ".join(a[2:])})
elif a[:1] == ["installer"] and len(a) >= 2:
    out = call("POST", "/installer", {"paquets": a[1:]})
elif a[:1] == ["appareils"]:
    out = call("GET", "/appareils")
elif a[:1] == ["notifier"] and len(a) >= 2:
    rest = a[1:]
    device = option(rest, "--appareil")
    out = call("POST", "/notifier", {"titre": rest[0], "texte": " ".join(rest[1:]), "appareil": device}) if rest else {"erreur": "Donne un titre."}
elif a[:1] == ["ordinateur"] and (len(a) < 3 or (a[1] not in ("lister", "lire", "ecrire", "ouvrir", "notifier", "copier", "lancer", "commande"))):
    out = {"erreur": "Usage : ordinateur lister|lire|ecrire|ouvrir|notifier|copier|lancer|commande … (voir l'aide de noah.py)"}
elif a[:1] == ["ordinateur"] and a[1] in ("lister", "lire", "ecrire"):
    rest = a[2:]
    device = option(rest, "--appareil")
    replace = option(rest, "--remplacer", False)
    if a[1] == "lister" and rest:
        out = call("POST", "/ordinateur", {"action": "lister", "appareil": device, "dossier": rest[0], "chemin": " ".join(rest[1:])})
    elif a[1] == "lire" and len(rest) >= 2:
        out = computer_read(device, rest[0], " ".join(rest[1:]))
    elif a[1] == "ecrire" and len(rest) == 3:
        out = computer_write(device, rest[0], rest[1], rest[2], replace)
    else:
        out = {"erreur": "Usage : ordinateur lister <dossier> [chemin] | lire <dossier> <chemin> | ecrire <dossier> <chemin> <fichier>"}
elif a[:1] == ["ordinateur"] and len(a) >= 3 and a[1] in ("ouvrir", "notifier", "copier", "lancer", "commande"):
    rest = a[2:]
    device = option(rest, "--appareil")
    folder = option(rest, "--dossier")
    action = {"copier": "presse_papiers"}.get(a[1], a[1])
    if a[1] == "notifier":
        body = {"action": action, "titre": rest[0] if rest else "", "texte": " ".join(rest[1:])}
    elif a[1] == "copier":
        body = {"action": action, "texte": " ".join(rest)}
    else:
        body = {"action": action, "cible": " ".join(rest)}
    out = call("POST", "/ordinateur", {**body, "appareil": device, "dossier": folder})
elif a[:1] == ["veille"] and len(a) >= 3:
    rest, minutes = a[1:], 60
    if "--minutes" in rest:
        i = rest.index("--minutes")
        minutes = int(rest[i + 1]) if i + 1 < len(rest) else 60
        rest = rest[:i] + rest[i + 2:]
    out = call("POST", "/veilles", {"nom": rest[0], "url": rest[1], "critere": " ".join(rest[2:]), "minutes": minutes})
elif a[:1] == ["routine"] and len(a) >= 4:
    out = routine_text(a[3:])
    if "consigne" in out:
        out = call("POST", "/routines", {"nom": a[1], "quand": a[2], "consigne": out["consigne"]})
elif a[:1] == ["routines"]:
    out = call("GET", "/routines")
elif a[:1] == ["routine-action"] and len(a) == 3:
    out = call("POST", "/routines/action", {"id": a[1], "action": a[2]})
elif a[:1] == ["routine-si"] and len(a) >= 5:
    rest, minutes = a[1:], 30
    if "--minutes" in rest:
        i = rest.index("--minutes")
        minutes = int(rest[i + 1]) if i + 1 < len(rest) else 30
        rest = rest[:i] + rest[i + 2:]
    out = routine_text(rest[3:])
    if "consigne" in out:
        out = call("POST", "/veilles", {"nom": rest[0], "url": rest[1], "critere": rest[2], "consigne": out["consigne"], "minutes": minutes})
elif a[:1] == ["memoire-juger"] and len(a) == 2:  # la garde de l'agent, avant qu'une note n'entre en mémoire
    out = call("POST", "/memoire/juger", json.loads(a[1]))
elif a[:1] == ["veilles"]:
    out = call("GET", "/veilles")
elif a[:1] == ["veille-action"] and len(a) == 3:
    out = call("POST", "/veilles/action", {"id": a[1], "action": a[2]})
elif a[:1] == ["appeler"] and len(a) >= 2:
    rest, leave = a[1:], ""
    if "--quand-quitte" in rest:
        i = rest.index("--quand-quitte")
        leave = rest[i + 1] if i + 1 < len(rest) else ""
        rest = rest[:i] + rest[i + 2:]
    out = call("POST", "/appel", {"message": " ".join(rest), "quand_quitte": leave})
elif a[:1] == ["attendre"] and len(a) == 2:
    out = call("GET", "/appel/" + a[1])
elif a[:1] == ["rappeler"] and len(a) >= 2:
    out = call("POST", "/rappel", {"texte": " ".join(a[1:])})
elif a[:1] == ["agents"]:
    out = call("GET", "/agents")
elif a[:1] == ["demander"] and len(a) >= 3:
    rest = [w for w in a[1:] if w != "--rappeler"]
    out = call("POST", "/demander", {"agent": rest[0], "consigne": " ".join(rest[1:]), "rappeler": "--rappeler" in a})
elif a[:1] == ["demande-etat"] and len(a) == 2:
    out = call("GET", "/demander/" + a[1])
elif a[:1] == ["demandes"]:
    out = call("GET", "/demandes")
elif a[:1] == ["recette"] and len(a) == 2:
    out = call("GET", "/recettes/" + a[1])
    if "recette" in out:
        print(out["recette"])
        sys.exit(0)
elif a[:1] == ["google-accord"]:
    out = call("POST", "/google/accord", {})
elif a[:1] == ["google-identifiants"] and len(a) == 3:
    out = call("POST", "/google/identifiants", {"client_id": a[1], "client_secret": a[2]})
elif a[:1] == ["fil-etat"] and len(a) == 2:
    out = call("GET", "/fils/" + a[1])
else:
    print(AIDE)
    sys.exit(0)
print(json.dumps(out, ensure_ascii=False, indent=2))
'''


# --- Gateway Hermes ---------------------------------------------------------------

async def health(agent: Agent) -> bool:
    try:
        # Court : la liste des agents attend la réponse de chacun, un agent arrêté ne doit pas la ralentir.
        r = await http().get(f"{agent.url}/health", timeout=1)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


async def start_run(agent: Agent, text: str, session_id: str) -> str:
    r = await http().post(f"{agent.url}/v1/runs", headers=agent.headers, json={"input": text, "session_id": session_id}, timeout=30)
    r.raise_for_status()
    return r.json()["run_id"]


LOST_TURN = "unknown_execution"  # refus d'Hermes : un redémarrage a coupé un tour, et la session attend qu'on en prenne acte


async def discard_lost_turn(agent_id: str, session_id: str, profile: str | None = None) -> None:
    await _launcher("POST", f"/agents/{agent_id}/sessions/{session_id}/discard", params={"profil": profile} if profile else None, timeout=60)


RUN_SILENCE = 120  # secondes sans aucun octet : conteneur figé. Hermes envoie un signe de vie toutes les 10 s, même pendant une attente


async def run_events(agent: Agent, run_id: str) -> AsyncIterator[tuple[str, dict]]:
    """Lit le flux SSE d'un run et rend des paires (type d'événement, données).

    Hermes envoie des trames `data: {"event": "tool.started", "run_id": …, …}` ;
    le type est dans le champ "event" du JSON.
    """
    async with http().stream("GET", f"{agent.url}/v1/runs/{run_id}/events", headers=agent.headers, timeout=httpx.Timeout(None, read=RUN_SILENCE)) as r:
        r.raise_for_status()
        data: list[str] = []
        async for line in r.aiter_lines():
            if line.startswith("data:"):
                data.append(line[5:].strip())
            elif line == "" and data:
                try:
                    payload = json.loads("\n".join(data))
                except json.JSONDecodeError:
                    payload = {}
                data = []
                if payload.get("event"):
                    yield payload["event"], payload


async def answer_approval(agent: Agent, run_id: str, request_id: str, generation: int, approve: bool) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{agent.url}/v1/runs/{run_id}/approval",
            headers=agent.headers,
            json={
                "request_id": request_id,
                "execution_generation": generation,
                "choice": "once" if approve else "deny",
            },
        )
    r.raise_for_status()


async def steer_run(agent: Agent, run_id: str, text: str) -> None:
    """Glisse un message dans un run en cours, sans l'interrompre : Hermes le lui donne après le lot d'outils en cours."""
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{agent.url}/v1/runs/{run_id}/steer", headers=agent.headers, json={"input": text})
    r.raise_for_status()


async def stop_run(agent: Agent, run_id: str) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        await c.post(f"{agent.url}/v1/runs/{run_id}/stop", headers=agent.headers)
