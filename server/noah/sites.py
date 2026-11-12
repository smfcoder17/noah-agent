"""Les sites où l'agent est connecté dans son navigateur, pour qu'ils se voient dans Connexions à côté des outils.

L'agent les note lui-même après s'être connecté (`noah.py site-connecte`), ou la fin d'un appel « connecte-toi » le fait pour lui.
Ce n'est qu'un registre à montrer : la session elle-même vit dans les cookies de son navigateur, et aucun secret ne passe ici.
Les sites dont la personne a retenu les identifiants (coffre.py) s'y ajoutent d'office.
"""
import re
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, coffre, db, relay

router = APIRouter()

MAX_SITES = 200
HOST = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
# Ce qui n'est pas un compte de la personne : le service de Noah lui-même, des adresses locales.
NOT_A_SITE = re.compile(r"(^|\.)(localhost|local|internal|sslip\.io|nip\.io)$")


def ensure() -> None:
    with db.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS sites_connectes (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                  "hote TEXT NOT NULL, nom TEXT NOT NULL, compte TEXT NOT NULL DEFAULT '', vu_a REAL NOT NULL, PRIMARY KEY (agent_id, hote))")


def host_of(address: str) -> str:
    """Le nom du site, sans www : « https://www.linkedin.com/feed » → linkedin.com. Vide si ce n'est pas un site public."""
    text = address.strip().lower()
    host = (urlsplit(text if "://" in text else f"https://{text}").hostname or "").removeprefix("www.")
    return host if HOST.match(host) and not NOT_A_SITE.search(host) else ""


def note(agent_id: str, address: str, name: str = "", account: str = "") -> str:
    host = host_of(address)
    if not host:
        return ""
    ensure()
    label = (name.strip() or coffre.site_of(f"https://{host}"))[:60]
    with db.connect() as c:
        if c.execute("SELECT COUNT(*) FROM sites_connectes WHERE agent_id = ?", (agent_id,)).fetchone()[0] >= MAX_SITES:
            c.execute("DELETE FROM sites_connectes WHERE agent_id = ? AND hote = (SELECT hote FROM sites_connectes WHERE agent_id = ? ORDER BY vu_a LIMIT 1)",
                      (agent_id, agent_id))
        c.execute("INSERT INTO sites_connectes (agent_id, hote, nom, compte, vu_a) VALUES (?, ?, ?, ?, ?) "
                  "ON CONFLICT(agent_id, hote) DO UPDATE SET nom = excluded.nom, compte = CASE WHEN excluded.compte != '' THEN excluded.compte ELSE compte END, vu_a = excluded.vu_a",
                  (agent_id, host, label, account.strip()[:120], time.time()))
    return host


def listed(agent_id: str) -> list[dict]:
    ensure()
    with db.connect() as c:
        rows = [dict(r) for r in c.execute("SELECT hote, nom, compte, vu_a FROM sites_connectes WHERE agent_id = ? ORDER BY vu_a DESC", (agent_id,))]
    by_host = {r["hote"]: r for r in rows}
    for saved in coffre._rows(agent_id):
        host = host_of(saved["origine"])
        if not host:
            continue
        if host in by_host:  # aussi retenu dans le coffre : il se retire là (Réglages), pas d'ici, sinon il reviendrait
            by_host[host]["retenu"] = True
            continue
        by_host[host] = {"hote": host, "nom": coffre.site_of(saved["origine"]), "compte": "", "vu_a": saved["used_at"] or saved["created_at"], "retenu": True}
        rows.append(by_host[host])
    return rows


async def live(agent_id: str, limit: int = 60) -> list[dict]:
    """Les sites où le navigateur de l'agent a vraiment une session : ses cookies, pas ce que l'agent a noté.

    Un agent se connecte à un site sans passer par `site-connecte` — un ancien agent, une connexion faite à la main dans
    l'écran partagé. Sans ce relevé, ces sites restaient invisibles dans Connexions. Un domaine ne compte que s'il a un
    cookie de session (expiration absente, ou au-delà de la journée) et s'il n'est pas connu comme pisteur.
    """
    from . import hermes

    try:
        state = await hermes.browser_call(agent_id, "GET", f"/sessions/{hermes.BROWSER_USER}/storage_state", timeout=20)
    except Exception:  # noqa: BLE001 - navigateur en veille ou absent : la liste enregistrée suffit
        return []
    cookies = state.get("cookies") if isinstance(state, dict) else None
    if not isinstance(cookies, list):
        return []
    now = time.time()
    found: dict[str, dict] = {}
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        domain = str(cookie.get("domain") or "").lstrip(".").lower()
        host = host_of(f"https://{domain}")
        if not host or TRACKERS.search(host):
            continue
        expires = cookie.get("expires")
        session = not isinstance(expires, (int, float)) or expires <= 0 or expires - now > DAY
        row = found.setdefault(host, {"hote": host, "nom": coffre.site_of(f"https://{host}"), "session": False, "dernier": 0.0})
        if session:
            row["session"] = True
        if isinstance(expires, (int, float)) and expires > 0:
            row["dernier"] = max(row["dernier"], expires)
    sites = [r for r in found.values() if r["session"]]
    for row in sites:
        row["vu_a"] = min(row.pop("dernier") or now, now)
    sites.sort(key=lambda r: (not r["hote"].split(".")[0] in PUBLIC_NAMES, r["hote"]))
    return sites[:limit]


# Des domaines de pistage et de CDN : ils posent des cookies sur presque tous les sites visités, ce ne sont pas des comptes.
TRACKERS = re.compile(r"(^|\.)(doubleclick|googlesyndication|google-analytics|googletagmanager|facebook\.net|hotjar|segment|mixpanel|"
                      r"amplitude|intercom|sentry|cloudflare|cloudfront|akamai|fastly|jsdelivr|bootstrapcdn|gstatic|googleapis|"
                      r"fonts\.google|cdnjs|unpkg|recaptcha|hcaptcha|stripe\.com|paypalobjects|newrelic|datadoghq|optimizely|"
                      r"criteo|taboola|outbrain|bing\.com|clarity\.ms|cookiebot|onetrust|usercentrics|hubspot|drift|zendesk|"
                      r"zopim|snapchat)\.", re.I)
DAY = 86400
PUBLIC_NAMES = {"github", "gitlab", "google", "youtube", "linkedin", "x", "twitter", "facebook", "instagram", "reddit",
                "notion", "figma", "slack", "discord", "dropbox", "openai", "anthropic", "claude", "amazon", "microsoft",
                "apple", "netflix", "spotify", "twitch", "stackoverflow", "medium", "substack", "cloudflare", "vercel"}


class Site(BaseModel):
    adresse: str = Field(min_length=3, max_length=500)
    nom: str = Field(default="", max_length=60)
    compte: str = Field(default="", max_length=120)


@router.post("/agent-api/sites")
def agent_note(body: Site, request: Request):
    host = note(relay._agent_from(request), body.adresse, body.nom, body.compte)
    if not host:
        raise HTTPException(400, "Donne l'adresse publique du site (ex. linkedin.com).")
    return {"ok": True, "site": host}


@router.delete("/agent-api/sites/{host}")
def agent_forget(host: str, request: Request):
    ensure()
    with db.connect() as c:
        c.execute("DELETE FROM sites_connectes WHERE agent_id = ? AND hote = ?", (relay._agent_from(request), host_of(host)))
    return {"ok": True}


@router.get("/api/agents/{agent_id}/sites")
async def sites(agent_id: str, user: int = Depends(auth.current_user)):
    """La liste enregistrée, plus les sites où la session du navigateur est réellement ouverte : tous les comptes de la
    personne, y compris ceux qu'un agent n'a jamais notés."""
    access.access(user, agent_id, "admin")
    saved = listed(agent_id)
    known = {r["hote"] for r in saved}
    for row in await live(agent_id):
        if row["hote"] not in known:
            saved.append(row)
    return saved


@router.delete("/api/agents/{agent_id}/sites/{host}")
def forget(agent_id: str, host: str, user: int = Depends(auth.current_user)):
    """Retire le site de la liste. La session reste dans le navigateur : « Se déconnecter » se fait sur le site, par l'agent."""
    access.access(user, agent_id, "admin")
    ensure()
    with db.connect() as c:
        c.execute("DELETE FROM sites_connectes WHERE agent_id = ? AND hote = ?", (agent_id, host_of(host)))
    return {"ok": True}
