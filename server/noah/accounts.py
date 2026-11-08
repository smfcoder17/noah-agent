"""Comptes : connecter Google en choisissant ce que l'agent peut faire, avec un seul accord.

Noah Agent est auto-hébergé : il se connecte à Google avec la propre « application » OAuth de l'utilisateur
(un projet Google Cloud à son nom). L'agent la crée lui-même dans son navigateur en suivant une recette et
n'appelle l'utilisateur que pour se connecter à son compte. Ces identifiants servent ensuite à tous ses agents.

L'accord se donne dans le navigateur de l'agent, où l'utilisateur est déjà connecté à Google. Noah Agent le valide
lui-même avec les accès cochés dans Détails (c'est ce choix qui fait foi) ; Google renvoie vers
une adresse locale qui ne répond pas, Noah Agent lit le code dans la barre d'adresse et l'échange lui-même. Aucune
adresse à recopier. Le jeton obtenu est posé dans la machine de l'agent pour sa compétence google-workspace.
"""
import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db, handoff, hermes, relay
from .machine import _check, admin

router = APIRouter()

G = "https://www.googleapis.com/auth/"
# Ce que l'utilisateur coche, et ce que ça demande à Google. « api » : à activer dans son projet Google Cloud.
GOOGLE_PERMISSIONS = [
    {"id": "gmail_lire", "service": "Gmail", "nom": "Lire mes courriels", "scopes": [G + "gmail.readonly"],
     "api": ["gmail.googleapis.com"]},
    {"id": "gmail_ecrire", "service": "Gmail", "nom": "Écrire, envoyer et ranger mes courriels",
     "scopes": [G + "gmail.modify", G + "gmail.send"], "api": ["gmail.googleapis.com"]},
    {"id": "agenda_lire", "service": "Agenda", "nom": "Voir mon agenda", "scopes": [G + "calendar.readonly"],
     "api": ["calendar-json.googleapis.com"]},
    {"id": "agenda_ecrire", "service": "Agenda", "nom": "Créer et modifier des événements", "scopes": [G + "calendar"],
     "api": ["calendar-json.googleapis.com"]},
    {"id": "drive_lire", "service": "Drive", "nom": "Lire mes fichiers Drive, Docs et Sheets", "scopes": [G + "drive.readonly"],
     "api": ["drive.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com"]},
    {"id": "drive_ecrire", "service": "Drive", "nom": "Créer et modifier mes fichiers Drive, Docs et Sheets",
     "scopes": [G + "drive", G + "documents", G + "spreadsheets"],
     "api": ["drive.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com"]},
    {"id": "contacts_lire", "service": "Contacts", "nom": "Voir mes contacts", "scopes": [G + "contacts.readonly"],
     "api": ["people.googleapis.com"]},
]
PERMS = {p["id"]: p for p in GOOGLE_PERMISSIONS}
# Toujours demandés, sans risque : savoir quel compte est connecté.
BASE_SCOPES = ["openid", G + "userinfo.email"]
# Un droit plus large couvre le plus étroit.
IMPLIES = {G + "gmail.modify": [G + "gmail.readonly"], G + "calendar": [G + "calendar.readonly"],
           G + "drive": [G + "drive.readonly"]}

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
# Application « de bureau » : Google accepte une adresse de bouclage sur n'importe quel port. Rien n'y répond ;
# le navigateur garde l'adresse, code compris, dans sa barre d'adresse.
REDIRECT = "http://127.0.0.1:1/"
CONSENT_MINUTES = 15

# Accord en cours, par agent : {etat, verifier, permissions, statut, message, depuis}.
_flows: dict[str, dict] = {}


def _client() -> dict | None:
    raw = db.get_setting("google_client")
    return json.loads(raw) if raw else None


def _account(agent_id: str) -> dict | None:
    raw = db.get_setting(f"google_{agent_id}")
    return json.loads(raw) if raw else None


# Comptes de plus (le travail, un deuxième Gmail) : chacun dans son dossier de la machine de l'agent.
def _others(agent_id: str) -> list[dict]:
    return json.loads(db.get_setting(f"google_autres_{agent_id}") or "[]")


def _save_others(agent_id: str, others: list[dict]) -> None:
    db.set_setting(f"google_autres_{agent_id}", json.dumps(others, ensure_ascii=False))


def folder_of(email: str) -> str:
    return (re.sub(r"[^a-z0-9.-]+", "-", email.lower()).strip("-.") or "compte")[:80]


GOOGLE_HOMES = "/opt/data/google-comptes"
DROITS = ("lire", "confirmer", "agir")


def _scopes(perms: list[str]) -> list[str]:
    return sorted(set(BASE_SCOPES + [s for p in perms for s in PERMS[p]["scopes"]]))


def _granted(scopes: list[str]) -> list[str]:
    have = set(scopes) | {i for s in scopes for i in IMPLIES.get(s, [])}
    return [p["id"] for p in GOOGLE_PERMISSIONS if all(s in have for s in p["scopes"])]


def apis_for(perms: list[str]) -> list[str]:
    return sorted({a for p in perms for a in PERMS[p]["api"]})


def _state(agent_id: str) -> dict:
    account = _account(agent_id)
    flow = _flows.get(agent_id)
    return {
        "identifiants": _client() is not None,
        "connecte": bool(account),
        "compte": (account or {}).get("compte", ""),
        "permissions": (account or {}).get("permissions", []),
        "catalogue": [{k: p[k] for k in ("id", "service", "nom")} for p in GOOGLE_PERMISSIONS],
        "etape": flow["statut"] if flow else None,
        "message": flow.get("message", "") if flow else "",
        "voulu": json.loads(db.get_setting(f"google_voulu_{agent_id}") or "[]"),
        "autres": [{"compte": o["compte"], "permissions": o.get("permissions", [])} for o in _others(agent_id)],
        "droit": db.get_setting(f"google_droit_{agent_id}") or "confirmer",
        "ajout": bool(flow and flow.get("ajout")),
    }


# --- Accord ---------------------------------------------------------------------------------------

async def _open_tab(agent_id: str, url: str) -> str:
    user = {"userId": hermes.BROWSER_USER}
    try:
        await hermes.browser_call(agent_id, "POST", "/start", timeout=60)
    except httpx.HTTPError:
        await hermes.ensure_browser(agent_id)
    r = await hermes.browser_call(agent_id, "POST", "/tabs", timeout=60, json={**user, "sessionKey": hermes.BROWSER_USER, "url": url})
    return r.get("tabId") or ""


# Les pages d'accord de Google, parcourues à la place de l'utilisateur : il a déjà choisi ses accès dans Noah Agent,
# c'est ce choix qui est demandé à Google. Le script marque l'élément à cliquer ; le clic part de Camoufox (vrai clic
# de souris). Ce qui doit rester le sien (mot de passe, code, choix entre plusieurs comptes) le fait appeler.
CONSENT_JS = """(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const mark = (e, quoi) => { document.querySelectorAll('[data-noah-next]').forEach((x) => x.removeAttribute('data-noah-next'));
    e.setAttribute('data-noah-next', '1'); return JSON.stringify({quoi, texte: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 60)}); };
  const say = (quoi) => JSON.stringify({quoi});
  if (location.pathname.includes('/oauth/error')) return JSON.stringify({quoi: 'refus', texte: document.body.innerText.slice(0, 600)});
  if (location.pathname.includes('/challenge/') || [...document.querySelectorAll('input[type=password]')].some(vis)) return say('utilisateur');
  const accounts = [...document.querySelectorAll('[data-identifier]')].filter(vis);
  if (accounts.length === 1) return mark(accounts[0], 'compte');
  if (accounts.length > 1) return say('choix_compte');
  const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter((b) => !b.checked && !b.disabled);
  const box = boxes.find((b) => vis(b) || (b.closest('label') && vis(b.closest('label'))));
  if (box) return mark(vis(box) ? box : box.closest('label'), 'case');
  const clickable = [...document.querySelectorAll('button, [role=button], a')].filter(vis);
  const find = (re) => clickable.find((e) => re.test((e.innerText || '').trim()));
  const go = find(/^(Continuer|Continue|Autoriser|Allow|Suivant|Next)$/i);
  if (go) return mark(go, 'bouton');
  const unsafe = find(/^(Accéder à|Go to) /i);
  if (unsafe) return mark(unsafe, 'non_validee');
  const advanced = find(/^(Paramètres avancés|Advanced)$/i);
  if (advanced) return mark(advanced, 'avance');
  return say('attente');
})()"""


async def _consent_step(agent_id: str, flow: dict) -> bool:
    """Un pas sur la page d'accord : choisir le compte, cocher les accès, « Continuer ». Vrai si Google a refusé."""
    tab, user = flow.get("onglet"), {"userId": hermes.BROWSER_USER}
    if not tab:
        return False
    r = await hermes.browser_call(agent_id, "POST", f"/tabs/{tab}/evaluate", timeout=10, json={**user, "expression": CONSENT_JS})
    try:
        step = json.loads(r.get("result") or "{}")
    except (TypeError, ValueError):
        return False
    what = step.get("quoi")
    if what == "refus":
        await _refused(agent_id, flow, step.get("texte", ""))
        return True
    if what in ("utilisateur", "choix_compte"):
        if not flow.get("appel"):
            flow["appel"] = handoff.open_call(agent_id, (
                "Google te demande de confirmer que c'est toi, dans l'écran de l'agent. Le reste se fait tout seul."
                if what == "utilisateur" else
                "Choisis dans l'écran de l'agent le compte Google à connecter. Le reste se fait tout seul."), origin="google")
        return False
    if flow.get("appel"):
        handoff.close_call(agent_id, flow.pop("appel")["id"], "fait")
    if what in (None, "attente"):
        return False
    key = f"{what}:{step.get('texte', '')}"
    flow["clics"][key] = flow["clics"].get(key, 0) + 1
    if flow["clics"][key] > 4:  # le même clic ne mène nulle part : la page a changé, l'utilisateur prend la main
        if not flow.get("appel"):
            flow["appel"] = handoff.open_call(agent_id, "La page d'accord de Google ne réagit pas comme prévu : termine-la "
                                              "dans l'écran de l'agent (« Continuer »).", origin="google")
        return False
    flow["message"] = "Noah valide ton accord chez Google…"
    await hermes.browser_call(agent_id, "POST", f"/tabs/{tab}/click", timeout=20, json={**user, "selector": "[data-noah-next]"})
    return False


async def _refused(agent_id: str, flow: dict, text: str) -> None:
    """Google bloque l'accès. Le cas courant : le compte n'est pas dans les testeurs de l'application (mode Test).
    L'agent l'y ajoute et relance l'accord ; l'utilisateur n'a rien à faire."""
    testing = "test" in text.lower()
    _finish(agent_id, flow, "configuration" if testing else "erreur",
            "L'agent t'ajoute comme testeur de ton application Google, puis l'accord reprend tout seul." if testing
            else "Google a bloqué l'accès : " + " ".join(text.split())[:200])
    if testing and _hooks.get("resume"):
        await _hooks["resume"](agent_id, (
            "Google bloque l'accord : le compte de l'utilisateur n'est pas dans les testeurs de l'application « Noah Agent » "
            "(mode Test, qu'on garde : ne publie pas). Ouvre https://console.cloud.google.com/auth/audience , « Add users » sous "
            "« Utilisateurs tests », son adresse Gmail, « Enregistrer », et vérifie qu'elle apparaît dans la liste. Puis lance `python3 /opt/data/noah.py google-accord` : Noah Agent refait l'accord "
            "tout seul. Ne m'appelle pas, sauf si Google te demande de te reconnecter."))


async def _returned(agent_id: str, state: str) -> dict | None:
    """Paramètres de la page de retour de Google pour cet accord (un ancien retour peut traîner dans un autre onglet)."""
    try:
        tabs = (await hermes.browser_call(agent_id, "GET", "/tabs", params={"userId": hermes.BROWSER_USER})).get("tabs") or []
    except httpx.HTTPError:
        return None
    for t in tabs:
        if str(t.get("url", "")).startswith(REDIRECT):
            q = {k: v[0] for k, v in parse_qs(urlparse(t["url"]).query).items()}
            if q.get("state") == state:
                return q
    return None


async def start_consent(agent_id: str, perms: list[str], compte: str = "", ajout: bool = False) -> None:
    """« ajout » : un autre compte Google que le premier (Google fait choisir le compte). « compte » : renouveler celui-là."""
    client = _client()
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = AUTH_URL + "?" + urlencode({
        "client_id": client["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
        "scope": " ".join(_scopes(perms)), "access_type": "offline", "prompt": "consent select_account" if ajout else "consent",
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        **({"login_hint": compte} if compte else {}),
    })
    old = _flows.get(agent_id)
    if old and old.get("tache"):
        old["tache"].cancel()
    flow = {"etat": state, "verifier": verifier, "permissions": perms, "statut": "accord", "depuis": time.time(),
            "message": "Noah donne ton accord à Google avec les accès que tu as cochés…", "clics": {}, "compte": compte, "ajout": ajout}
    _flows[agent_id] = flow
    flow["onglet"] = await _open_tab(agent_id, url)
    flow["tache"] = asyncio.create_task(_watch_consent(agent_id, flow))


def _finish(agent_id: str, flow: dict, status: str, message: str) -> None:
    flow.update(statut=status, message=message)
    flow.pop("tache", None)
    handoff.close_call(agent_id, None, "fait" if status == "fini" else "impossible")


async def _watch_consent(agent_id: str, flow: dict) -> None:
    deadline = time.time() + CONSENT_MINUTES * 60
    while time.time() < deadline:
        await asyncio.sleep(1.5)
        q = await _returned(agent_id, flow["etat"])
        if not q:
            try:
                if await _consent_step(agent_id, flow):
                    return
            except httpx.HTTPError:
                pass  # page en cours de chargement
            continue
        await _close_redirect_tabs(agent_id)
        if q.get("error"):
            _finish(agent_id, flow, "erreur", "Accès refusé dans Google." if q["error"] == "access_denied" else f"Google a répondu : {q['error']}")
            return
        try:
            await _exchange(agent_id, flow, q.get("code", ""))
        except Exception as e:  # noqa: BLE001 - l'erreur est montrée à l'utilisateur
            _finish(agent_id, flow, "erreur", str(e)[:300])
            return
        _finish(agent_id, flow, "fini", "Google est connecté.")
        return
    _finish(agent_id, flow, "erreur", "Pas d'accord dans les 15 minutes. Recommence quand tu veux.")


async def _close_redirect_tabs(agent_id: str) -> None:
    try:
        tabs = (await hermes.browser_call(agent_id, "GET", "/tabs", params={"userId": hermes.BROWSER_USER})).get("tabs") or []
        for t in tabs:
            if str(t.get("url", "")).startswith(REDIRECT) and t.get("tabId"):
                await hermes.browser_call(agent_id, "DELETE", f"/tabs/{t['tabId']}", params={"userId": hermes.BROWSER_USER})
    except httpx.HTTPError:
        pass


def _email(id_token: str) -> str:
    try:
        payload = id_token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("email", "")
    except (IndexError, ValueError):
        return ""


async def _exchange(agent_id: str, flow: dict, code: str) -> None:
    client = _client()
    r = await relay.upstream_client().post(TOKEN_URL, data={
        "code": code, "client_id": client["client_id"], "client_secret": client["client_secret"],
        "redirect_uri": REDIRECT, "grant_type": "authorization_code", "code_verifier": flow["verifier"],
    }, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Google a refusé l'échange : {r.text[:200]}")
    t = r.json()
    if not t.get("refresh_token"):
        raise RuntimeError("Google n'a pas donné d'accès durable : recommence la connexion.")
    scopes = (t.get("scope") or "").split()
    expiry = datetime.now(timezone.utc) + timedelta(seconds=int(t.get("expires_in", 3600)) - 60)
    # Format « authorized_user » de google-auth, celui qu'attend la compétence google-workspace d'Hermes.
    token = {"type": "authorized_user", "token": t["access_token"], "refresh_token": t["refresh_token"],
             "token_uri": TOKEN_URL, "client_id": client["client_id"], "client_secret": client["client_secret"],
             "scopes": scopes, "expiry": expiry.strftime("%Y-%m-%dT%H:%M:%SZ")}
    installed = {"installed": {"client_id": client["client_id"], "client_secret": client["client_secret"],
                               "auth_uri": AUTH_URL, "token_uri": TOKEN_URL, "redirect_uris": [REDIRECT]}}
    granted = _granted(scopes)
    email = _email(t.get("id_token", ""))
    account = {"compte": email, "permissions": granted, "depuis": int(time.time())}
    primary = _account(agent_id)
    # Un autre compte que le premier, si on en ajoute un ou si l'on renouvelle celui-là ; sinon le premier est remplacé.
    other = bool(primary and email and email != primary.get("compte") and (flow.get("ajout") or flow.get("compte") == email))
    if other:
        await admin(agent_id, "google_installer", {"client": installed, "token": token, "dossier": folder_of(email)})
        _save_others(agent_id, [o for o in _others(agent_id) if o["compte"] != email] + [account])
    else:
        await admin(agent_id, "google_installer", {"client": installed, "token": token})
        db.set_setting(f"google_{agent_id}", json.dumps(account, ensure_ascii=False))
    _forget_screen(agent_id)
    _tell_agent(agent_id, account)
    if other:
        return
    from . import connecteurs

    await connecteurs.google_renewed(agent_id)


_hooks: dict = {}

# L'application reste en mode Test (publier exigerait un site et des règles de confidentialité) : Google y coupe
# l'accès au bout de 7 jours. Noah Agent refait l'accord avant, dans le navigateur où l'utilisateur est connecté.
RENEW_AFTER = 6 * 24 * 3600


async def keep_google_fresh(every: float = 3600) -> None:
    from . import connecteurs

    while True:
        await asyncio.sleep(every)
        with db.connect() as c:
            ids = [r["id"] for r in c.execute("SELECT id FROM agents")]
        for agent_id in ids:
            account = _account(agent_id)
            flow = _flows.get(agent_id)
            if not account or not _client() or (flow and flow.get("tache")) or connecteurs.google_copy(agent_id):
                continue  # une copie suit l'accord de l'agent d'origine
            due = [a for a in [account, *_others(agent_id)] if time.time() - a.get("depuis", 0) > RENEW_AFTER]
            if due:  # un accord à la fois par agent : le suivant à l'heure d'après
                try:
                    await start_consent(agent_id, due[0]["permissions"], compte=due[0]["compte"] if due[0] is not account else "")
                except Exception:  # noqa: BLE001 - navigateur indisponible : on réessaie dans une heure
                    pass


def setup(save_message, main_conversation, resume=None) -> None:
    _hooks.update(save=save_message, main=main_conversation, resume=resume)


def _tell_agent(agent_id: str, account: dict) -> None:
    """L'agent l'apprend à son prochain message (sans réveiller la conversation)."""
    conv = _hooks.get("main") and _hooks["main"](agent_id)
    if not conv:
        return
    names = ", ".join(PERMS[p]["nom"].lower() for p in account["permissions"]) or "aucun accès"
    primary = _account(agent_id) or {}
    if account.get("compte") and account["compte"] != primary.get("compte"):
        note = (f"Un autre compte Google est connecté : {account['compte']} ({names}). Pour ce compte, lance la compétence "
                f"google-workspace avec HERMES_HOME={GOOGLE_HOMES}/{folder_of(account['compte'])} devant python3 ; sans rien, "
                f"elle utilise le premier compte ({primary.get('compte') or 'compte Google'}). Demande lequel si ce n'est pas clair.")
        pending = json.loads(db.get_setting(f"contexte_{conv}") or "[]")
        db.set_setting(f"contexte_{conv}", json.dumps((pending + [note])[-5:], ensure_ascii=False))
        return
    note = (f"Google est connecté ({account['compte'] or 'compte Google'}) : {names}. Utilise la compétence google-workspace ; "
            "pour un accès qui manque, l'utilisateur l'ajoute dans l'onglet Connexions de l'agent. L'application reste en mode Test, "
            "c'est voulu : Noah Agent renouvelle l'accord tout seul avant les 7 jours. Ne cherche pas à la publier.")
    pending = json.loads(db.get_setting(f"contexte_{conv}") or "[]")
    db.set_setting(f"contexte_{conv}", json.dumps((pending + [note])[-5:], ensure_ascii=False))


# --- Recette : l'agent crée l'application Google de l'utilisateur ----------------------------------

def recipe(perms: list[str]) -> str:
    apis = ",".join(apis_for(perms))
    return f"""# Recette : créer l'accès Google de l'utilisateur (une seule fois pour tous ses agents)

But : un projet Google Cloud à son nom, avec un « ID client OAuth » de type Application de bureau. Noah Agent s'en sert
ensuite pour obtenir l'accès. Travaille dans ton navigateur (l'utilisateur voit ton écran). L'interface de Google change
souvent : cherche le bouton équivalent plutôt que d'abandonner.

L'utilisateur t'a confié toute la mise en place en cliquant sur « Connecter » : accepte toi-même les conditions de Google
Cloud, coche toi-même les cases d'accord du règlement, publie et confirme. Il n'intervient que pour se connecter à son
compte (mot de passe, code de validation). Ne l'appelle pour rien d'autre.

Va vite : utilise les outils du navigateur (browser_navigate, browser_snapshot, browser_click, browser_type), pas curl,
et pas de `sleep` (browser_navigate attend déjà le chargement). Ouvre directement les adresses ci-dessous.

1. Ouvre https://console.cloud.google.com/ . Page de connexion Google → appelle-le avec
   `python3 /opt/data/noah.py appeler "Connecte-toi à ton compte Google dans mon écran." --quand-quitte accounts.google.com`
   L'appel se termine tout seul dès qu'il est connecté (relance `attendre <id>` tant que la réponse est « en_attente »).
   Conditions d'utilisation de Google Cloud (pays, case « J'accepte ») → coche et accepte.
2. Crée le projet : https://console.cloud.google.com/projectcreate , nom « Noah Agent », puis « Créer ». Attends qu'il
   existe et note son identifiant (ex. noah-agent-123456). S'il existe déjà un projet « Noah Agent », réutilise-le.
3. Active les API d'un coup : https://console.cloud.google.com/flows/enableapi?apiid={apis}&project=<identifiant>
   puis « Suivant » / « Activer ».
4. Écran d'accord : https://console.cloud.google.com/auth/overview?project=<identifiant> → « Commencer » (Get started).
   Nom de l'application « Noah Agent », adresse d'assistance = l'adresse de l'utilisateur, audience « Externe »,
   adresse de contact = la même. Coche la case d'accord du règlement sur les données et clique sur « Créer ».
5. Testeur : https://console.cloud.google.com/auth/audience?project=<identifiant> → laisse l'état « Test » (ne publie pas :
   Google exigerait un site et des règles de confidentialité). Sous « Utilisateurs tests », « Add users », saisis l'adresse
   Gmail de l'utilisateur, « Enregistrer », et vérifie qu'elle apparaît dans la liste. Noah Agent renouvelle lui-même
   l'accord avant l'expiration de 7 jours propre au mode Test.
6. Identifiant : https://console.cloud.google.com/auth/clients/create?project=<identifiant> → type « Application de
   bureau » (Desktop app), nom « Noah », « Créer ». La fenêtre affiche l'ID client et le code secret : lis-les
   (capture si besoin) avant de la fermer, puis lance
   `python3 /opt/data/noah.py google-identifiants <ID client> <code secret>`.
7. Noah Agent ouvre alors lui-même la page d'accord de Google et la valide avec les accès que l'utilisateur a cochés.
   N'y touche pas. Dis-lui en une phrase que l'accès est créé, puis arrête-toi : Noah Agent te préviendra quand Google
   sera connecté.
"""


_SOCIAL_RULES = """Travaille dans ton navigateur (l'utilisateur voit ton écran). Ces sites changent souvent : cherche le bouton équivalent
plutôt que d'abandonner. Utilise browser_navigate, browser_snapshot, browser_click, browser_type ; pas de curl, pas de `sleep`.
L'utilisateur t'a confié toute la mise en place : remplis toi-même les formulaires, accepte toi-même les conditions des
développeurs et coche les cases d'accord. Il n'intervient que pour se connecter (mot de passe, code) : appelle-le alors avec
`python3 /opt/data/noah.py appeler "Connecte-toi à ton compte <site> dans mon écran." --quand-quitte <page de connexion>`.
Ne l'appelle pour rien d'autre. Un jeton ne se lit ni ne se recopie : Noah le prend lui-même dans la page quand la recette le dit."""

SOCIAL_RECIPES = {
    "instagram": f"""# Recette : publier sur Instagram par l'API (une seule fois)

But : une application Meta à son nom, et un jeton pour son compte Instagram. Le compte doit être professionnel (créateur ou
entreprise) : si l'application Instagram dit qu'il est personnel, dis-lui en une phrase comment le passer en professionnel
(Paramètres > Type de compte et outils) et attends sa réponse.

{_SOCIAL_RULES}

1. Ouvre https://developers.facebook.com/apps . Page de connexion Facebook → appelle-le (--quand-quitte www.facebook.com).
   Première fois : « Commencer » pour créer son compte développeur (accepte les conditions, vérifie l'adresse si on te le demande).
2. « Créer une app » : nom « Noah Agent », cas d'usage « Gérer les messages et le contenu sur Instagram » (Instagram API),
   pas de portfolio d'entreprise, puis « Créer ».
3. Dans l'app : Instagram → « Configuration de l'API avec la connexion Instagram » (API setup with Instagram login) →
   « Générer des tokens d'accès » → « Ajouter un compte ». Connexion Instagram → appelle-le (--quand-quitte instagram.com).
   Accepte les autorisations demandées pour l'app.
4. « Générer un token » à côté du compte ajouté, coche l'accord si on te le demande, puis, la fenêtre du jeton encore ouverte,
   lance tout de suite `python3 /opt/data/noah.py reseau-instagram`. Noah lit le jeton lui-même dans la page : ne le lis pas,
   ne le recopie pas, ne prends pas d'instantané de cette fenêtre.
5. La commande dit « connecte » et le compte : dis-lui en une phrase qu'Instagram est branché. Une erreur : lis-la, corrige
   l'étape en cause, réessaie une fois, puis dis-lui ce qui bloque.
""",
    "x": f"""# Recette : publier sur X par l'API (une seule fois)

But : une application X à son nom (OAuth 2.0), puis son accord. Préviens-le d'abord en une phrase : X facture chaque post
à son compte développeur (crédits prépayés). S'il ne veut pas payer, arrête-toi : l'agent publiera avec le navigateur.

{_SOCIAL_RULES}

1. Ouvre https://console.x.com . Page de connexion X → appelle-le, sans --quand-quitte (la console est aussi sur x.com).
   Première fois : crée son compte développeur (usage : publier ses propres posts avec un assistant ; accepte les conditions).
2. Crée une application (Apps → « Create App »), nom « Noah Agent » suivi de 4 chiffres si le nom est pris.
3. Dans ses réglages d'authentification (User authentication settings) : OAuth 2.0 activé, permissions « Read and write »,
   type « Native App ». Adresse de retour (Callback URI) : lance `python3 /opt/data/noah.py publication-retour` et colle
   exactement l'adresse qu'il rend. Site web : la même adresse sans son chemin. Enregistre.
4. Copie le « Client ID » OAuth 2.0 (pas l'API Key), puis lance `python3 /opt/data/noah.py reseau-x <Client ID>`.
5. Ouvre l'adresse rendue dans ton navigateur et clique « Authorize app ». X revient sur une page de Noah qui demande
   « Donner X à … ? » : clique « Donner cet accès ». Puis vérifie avec `python3 /opt/data/noah.py publication-etat` que X
   figure parmi les connectés avant de lui dire en une phrase que c'est fait. Sinon, dis-lui ce qui bloque.
""",
}


def recipe_prompt(perms: list[str]) -> str:
    names = ", ".join(PERMS[p]["nom"].lower() for p in perms)
    return (f"Connecte mon compte Google ({names}). Il faut d'abord créer mon accès Google : "
            "lis la recette avec `python3 /opt/data/noah.py recette google` et suis-la. "
            "Appelle-moi seulement quand c'est à moi d'agir.")


# --- API de l'interface ---------------------------------------------------------------------------

class Connect(BaseModel):
    permissions: list[str] = Field(min_length=1, max_length=len(GOOGLE_PERMISSIONS))


def _valid(perms: list[str]) -> list[str]:
    bad = [p for p in perms if p not in PERMS]
    if bad:
        raise HTTPException(400, f"Accès inconnu : {', '.join(bad)}")
    return sorted(set(perms))


def _forget_screen(agent_id: str) -> None:
    from . import machine

    machine.forget_connections(agent_id)


@router.get("/api/agents/{agent_id}/google")
async def google_state(agent_id: str, user: int = Depends(auth.current_user)):
    return _state(_check(agent_id, user))


@router.post("/api/agents/{agent_id}/google/ajouter")
async def google_add(agent_id: str, body: Connect, user: int = Depends(auth.current_user)):
    """Un compte Google de plus, avec les mêmes identifiants : Google fait choisir le compte dans l'écran de l'agent."""
    agent_id = _check(agent_id, user)
    if not _client() or not _account(agent_id):
        raise HTTPException(409, "Connecte d'abord un premier compte Google.")
    _forget_screen(agent_id)
    await start_consent(agent_id, _valid(body.permissions), ajout=True)
    return _state(agent_id)


class GoogleRight(BaseModel):
    droit: str = Field(pattern="^(lire|agir|confirmer)$")


@router.put("/api/agents/{agent_id}/google/droit")
async def google_right(agent_id: str, body: GoogleRight, user: int = Depends(auth.current_user)):
    """Comme pour un outil MCP : lire passe toujours ; écrire (envoyer, créer, supprimer) suit ce droit."""
    from . import mcp

    agent_id = _check(agent_id, user)
    before = db.get_setting(f"google_droit_{agent_id}")
    db.set_setting(f"google_droit_{agent_id}", body.droit)
    try:
        await admin(agent_id, "outil_droits", {"droits": mcp._rights(agent_id)})
    except Exception:  # agent arrêté : le droit affiché reste celui que le plugin applique
        db.set_setting(f"google_droit_{agent_id}", before or "")
        raise
    return _state(agent_id)


@router.post("/api/agents/{agent_id}/google/connect")
async def google_connect(agent_id: str, body: Connect, user: int = Depends(auth.current_user)):
    """Avec les identifiants : ouvre l'accord dans l'écran de l'agent. Sans : rend la consigne à envoyer à l'agent
    pour qu'il les crée (l'accord suivra tout seul)."""
    agent_id = _check(agent_id, user)
    _forget_screen(agent_id)
    _own_client(agent_id)
    perms = _valid(body.permissions)
    db.set_setting(f"google_voulu_{agent_id}", json.dumps(perms))
    if not _client():
        _flows[agent_id] = {"statut": "configuration", "permissions": perms, "depuis": time.time(),
                            "message": "L'agent crée ton accès Google."}
        return _state(agent_id) | {"consigne": recipe_prompt(perms)}
    await start_consent(agent_id, perms)
    return _state(agent_id)


@router.post("/api/agents/{agent_id}/google/cancel")
async def google_cancel(agent_id: str, user: int = Depends(auth.current_user)):
    _forget_screen(agent_id)
    flow = _flows.pop(_check(agent_id, user), None)
    if flow and flow.get("tache"):
        flow["tache"].cancel()
    handoff.close_call(agent_id, None, "impossible")
    return _state(agent_id)


@router.post("/api/agents/{agent_id}/google/disconnect")
async def google_disconnect(agent_id: str, compte: str = "", user: int = Depends(auth.current_user)):
    """Efface le jeton de cet agent. Pas de révocation chez Google : elle retirerait l'accord de toute
    l'application, donc aussi aux autres agents. L'utilisateur peut tout retirer sur myaccount.google.com.
    « compte » : seulement ce compte de plus."""
    agent_id = _check(agent_id, user)
    _forget_screen(agent_id)
    if compte and compte != (_account(agent_id) or {}).get("compte"):
        if not any(o["compte"] == compte for o in _others(agent_id)):
            raise HTTPException(404, "Ce compte Google n'est pas connecté à cet agent.")
        await admin(agent_id, "google_revoquer", {"dossier": folder_of(compte)})
        _save_others(agent_id, [o for o in _others(agent_id) if o["compte"] != compte])
        return _state(agent_id)
    await admin(agent_id, "google_revoquer", {"local": True})
    db.set_setting(f"google_{agent_id}", "")
    from . import connecteurs

    await connecteurs.removed(agent_id, "google")
    return _state(agent_id)


class ClientIds(BaseModel):
    client_id: str = Field(min_length=10, max_length=300)
    client_secret: str = Field(min_length=6, max_length=300)


def _own_client(agent_id: str) -> None:
    """Les identifiants OAuth de Google sont ceux du propriétaire de l'installation, et l'accord les installe dans la
    machine de l'agent : ils n'entrent pas dans celle d'un autre profil, et son agent ne peut pas les remplacer."""
    if access.owner_of(agent_id) != db.owner_id():
        raise HTTPException(403, "Google passe par les identifiants du propriétaire de ce Noah Agent : pas encore possible "
                                 "sur l'agent d'un autre profil. Demande-lui de partager un agent connecté à Google.")


def _save_client(body: ClientIds) -> None:
    cid, secret = body.client_id.strip(), body.client_secret.strip()
    if not re.fullmatch(r"[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com", cid):
        raise HTTPException(400, "Ce n'est pas un ID client Google (il finit par .apps.googleusercontent.com).")
    db.set_setting("google_client", json.dumps({"client_id": cid, "client_secret": secret}))


class ClientFile(BaseModel):
    fichier: str = Field(min_length=10, max_length=20000)


@router.post("/api/google/client")
async def google_client_file(body: ClientFile, user: int = Depends(access.owner_only)):
    """Pour qui a déjà un fichier d'identifiants (« Application de bureau ») : le dépose à la place de la recette."""
    try:
        data = json.loads(body.fichier)
        ids = data.get("installed") or data.get("web") or {}
        _save_client(ClientIds(client_id=ids.get("client_id", ""), client_secret=ids.get("client_secret", "")))
    except (ValueError, AttributeError):
        raise HTTPException(400, "Ce fichier n'est pas un identifiant OAuth de Google.")
    return {"ok": True}


# --- API de l'agent -------------------------------------------------------------------------------

@router.get("/agent-api/recettes/{name}")
async def agent_recipe(name: str, request: Request):
    agent_id = relay._agent_from(request)
    if name in SOCIAL_RECIPES:
        return {"recette": SOCIAL_RECIPES[name]}
    if name != "google":
        raise HTTPException(404, "Recette inconnue (disponibles : google, instagram, x)")
    perms = json.loads(db.get_setting(f"google_voulu_{agent_id}") or "[]") or [p["id"] for p in GOOGLE_PERMISSIONS]
    if _client():
        return {"recette": "L'accès Google existe déjà. Rien à créer : dis à l'utilisateur de cliquer sur « Connecter » "
                           "dans l'onglet Connexions de l'agent → Google."}
    return {"recette": recipe(perms)}


@router.post("/agent-api/google/accord")
async def agent_consent(request: Request):
    """L'agent relance l'accord (après avoir publié l'application, par exemple) avec les accès choisis."""
    agent_id = relay._agent_from(request)
    _own_client(agent_id)
    perms = json.loads(db.get_setting(f"google_voulu_{agent_id}") or "[]")
    if not _client() or not perms:
        raise HTTPException(409, "Rien à relancer : l'utilisateur choisit ses accès dans l'onglet Connexions de l'agent → Google.")
    await start_consent(agent_id, perms)
    return {"ok": True, "suite": "Noah Agent refait l'accord de Google dans ton navigateur : n'y touche pas et arrête-toi."}


@router.post("/agent-api/google/identifiants")
async def agent_client_ids(body: ClientIds, request: Request):
    agent_id = relay._agent_from(request)
    _own_client(agent_id)
    _save_client(body)
    perms = json.loads(db.get_setting(f"google_voulu_{agent_id}") or "[]")
    if not perms:
        return {"ok": True, "suite": "Identifiants enregistrés. L'utilisateur choisit ses accès dans l'onglet Connexions de l'agent → Google."}
    try:
        await start_consent(agent_id, perms)
    except (httpx.HTTPError, HTTPException) as e:
        return {"ok": True, "suite": f"Identifiants enregistrés, mais la page d'accord n'a pas pu s'ouvrir ({e}). "
                                     "Dis à l'utilisateur de cliquer sur « Connecter » dans l'onglet Connexions de l'agent → Google."}
    return {"ok": True, "suite": "Identifiants enregistrés. Noah Agent valide maintenant l'accord de Google dans ton navigateur "
                                 "(onglet de la page d'accord) : n'y touche pas. Dis à l'utilisateur que l'accès est créé et arrête-toi."}
