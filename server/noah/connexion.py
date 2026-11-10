"""Retour d'une connexion OAuth (Notion, Linear…) : la personne accepte dans son propre navigateur, où elle est déjà
connectée, puis le fournisseur revient ici et Noah termine seul, sans adresse à copier.

Hermes garde le travail délicat (découverte, enregistrement, PKCE, échange du code, vérification de `state`) et attend sur
un port de la machine de l'agent : cette page lui transmet seulement ce que le fournisseur a renvoyé.

Cette adresse ne demande pas de session : le fournisseur peut ramener la personne dans un navigateur sans compte Noah (le
navigateur du système depuis l'application de bureau ou le téléphone). Ce qui la protège : `state`, tiré au hasard par
Hermes pour cette connexion, valable une fois et 10 minutes. Sans lui, rien n'atteint l'agent.

Un lien d'accord peut aussi être envoyé à quelqu'un d'autre, pour lui faire donner son propre compte à l'agent d'un tiers. Donc
une session d'un autre compte est refusée, et sans session la page nomme l'agent et demande de confirmer.
"""
import html
import time
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from fastapi import APIRouter, Cookie, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from . import auth, db, public

router = APIRouter()

PATH = "/api/connexion/retour"
SECONDS = 600
FORWARDED = ("code", "state", "iss", "error", "error_description")  # rien d'autre n'entre dans l'adresse de l'agent
_pending: dict[str, dict] = {}  # state -> connexion attendue


def callback_url(request: Request) -> str:
    """Adresse de retour à déclarer au fournisseur, ou "" s'il n'y en a pas qu'il accepte (la personne copiera alors).
    Le nom public en HTTPS sur un serveur ; sur un ordinateur, localhost, que les fournisseurs tolèrent en clair."""
    base = public.main_url()
    if not base and (request.url.hostname or "") in ("localhost", "127.0.0.1"):
        base = str(request.base_url).rstrip("/")
    return f"{base}{PATH}" if base else ""


def from_app(request: Request) -> bool:
    """La demande vient de l'application de bureau ou du téléphone, pas d'un onglet : le retour se fait vers elle."""
    return bool(request.headers.get("x-noah-version"))


def expect(out: dict, agent_id: str, name: str, finish, app: bool = False, user: int | None = None) -> None:
    """Note la connexion que vient d'ouvrir Hermes. `finish(query)` la termine et rend ce qu'il faut savoir ensuite."""
    now = time.time()
    for key in [k for k, v in _pending.items() if v["expire"] < now]:
        _pending.pop(key, None)
    if not out.get("retour") or not out.get("adresse"):
        return
    state = (parse_qs(urlsplit(out["adresse"]).query).get("state") or [""])[0]
    if state:
        _pending[state] = {"agent": agent_id, "nom": name, "finish": finish, "app": app, "user": user, "expire": now + SECONDS}


def _page(title: str, text: str, status: int = 200, app_link: bool = False, extra: str = "", form_action: str = "'none'") -> HTMLResponse:
    # Le navigateur propose d'ouvrir l'application ; s'il ne le fait pas, le lien reste.
    back = '<meta http-equiv="refresh" content="0;url=noah://connexion">' if app_link else ""
    button = '<p><a href="noah://connexion">Retourner dans Noah</a></p>' if app_link else ""
    body = (
        f'<!doctype html><html lang="fr"><meta charset="utf-8">{back}<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title><style>body{{font:16px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;"
        "place-items:center;background:#f6f6f4;color:#222}main{max-width:26rem;padding:2rem;text-align:center}"
        "h1{font-size:1.25rem;font-weight:600}p{color:#555}@media(prefers-color-scheme:dark){body{background:#181818;color:#eee}"
        f"p{{color:#aaa}}}}</style><main><h1>{html.escape(title)}</h1><p>{html.escape(text)}</p>{button}{extra}</main></html>")
    return HTMLResponse(body, status_code=status, headers={
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex",
        "Content-Security-Policy": f"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action {form_action}; frame-ancestors 'none'"})


def _session_user(request: Request, cookie: str | None) -> int | None:
    """Le compte connecté dans ce navigateur, s'il y en a un."""
    token = auth.request_token(request, cookie)
    if not token:
        return None
    key = auth.session_key(token)
    return auth.user_of_session(key) if auth.session_alive(key) else None


def _whose(login: dict) -> tuple[str, str]:
    with db.connect() as c:
        agent = c.execute("SELECT name FROM agents WHERE id = ?", (login["agent"],)).fetchone()
        owner = c.execute("SELECT username FROM users WHERE id = ?", (login.get("user"),)).fetchone()
    return (agent["name"] if agent else "un agent"), (owner["username"] if owner else "un autre compte")


@router.get(PATH)
async def back_from_provider(request: Request, noah_session: str | None = Cookie(None)):
    params = request.query_params
    state = params.get("state", "")
    login = _pending.get(state)
    if not login or login["expire"] < time.time():
        _pending.pop(state, None)
        return _page("Ce lien de connexion n'est plus valable", "Relance « Connecter » dans Noah.", 400)
    label = login["nom"].replace("-", " ").capitalize()
    here = _session_user(request, noah_session)
    if login.get("user") is not None and here is not None and here != login["user"]:
        _pending.pop(state, None)  # le code du fournisseur ne part pas vers l'agent d'un autre compte
        return _page(f"{label} n'est pas connecté", "Cet accord a été lancé depuis un autre compte Noah : il est annulé. Si tu ne l'as pas demandé, retire l'accès chez le fournisseur.", 403)
    if login.get("user") is not None and here is None and not params.get("error"):
        # Sans session (navigateur du système, depuis l'application) : la personne voit à qui elle donne l'accès.
        login["montre"] = True
        agent, owner = _whose(login)
        fields = "".join(f'<input type="hidden" name="{k}" value="{html.escape(params[k], quote=True)}">' for k in FORWARDED if k in params)
        form = (f'<form method="post" action="{PATH}">{fields}<p><button type="submit">Donner cet accès</button></p></form>'
                "<p>Si tu n'as pas lancé cette connexion, ferme simplement cette page.</p>")
        return _page(f"Donner {label} à {agent} ?", f"L'agent {agent} du compte Noah « {owner} » pourra agir sur ton compte {label}.", extra=form, form_action="'self'")
    return await _finish(state, login, params)


@router.post(PATH)
async def confirmed(request: Request, noah_session: str | None = Cookie(None)):
    raw = await request.body()
    form = {k: v[0] for k, v in parse_qs(raw[:8192].decode("utf-8", "replace")).items()}
    state, code, iss = form.get("state", ""), form.get("code", ""), form.get("iss", "")
    login = _pending.get(state)
    # Seulement pour une page réellement montrée : personne ne saute la question en postant directement.
    if not login or login["expire"] < time.time() or not login.get("montre"):
        _pending.pop(state, None)
        return _page("Ce lien de connexion n'est plus valable", "Relance « Connecter » dans Noah.", 400)
    here = _session_user(request, noah_session)
    if here is not None and here != login.get("user"):
        _pending.pop(state, None)
        return _page("Connexion annulée", "Cet accord a été lancé depuis un autre compte Noah : il est annulé.", 403)
    return await _finish(state, login, {k: v for k, v in (("code", code), ("state", state), ("iss", iss)) if v})


async def _finish(state: str, login: dict, params):
    _pending.pop(state, None)  # une seule fois, même si la suite échoue
    label = login["nom"].replace("-", " ").capitalize()
    if params.get("error"):
        await _quietly(login, params)
        return _page(f"{label} n'est pas connecté", "L'accès n'a pas été accordé. Tu peux relancer « Connecter » dans Noah.")
    if not await _quietly(login, params):
        return _page(f"{label} n'est pas connecté", "La connexion n'a pas abouti. Relance « Connecter » dans Noah.", 502)
    if login["app"]:
        return _page(f"{label} est connecté", "Tu peux fermer cet onglet et retourner dans l'application.", app_link=True)
    # Comme les autres services : on revient sur Noah, à l'adresse de ce serveur.
    return RedirectResponse(f"/#connexion={quote(login['nom'])}", status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


async def _quietly(login: dict, params) -> bool:
    try:
        await login["finish"]("?" + urlencode({k: params[k] for k in FORWARDED if k in params}))
        from . import bus
        bus.invalidate_all()
        return True
    except Exception as e:  # noqa: BLE001 - la page dit que ça n'a pas abouti ; le détail ne part pas dans le navigateur
        print(f"[connexion] {login['agent']}/{login['nom']} : {str(e)[:200]}", flush=True)
        return False
