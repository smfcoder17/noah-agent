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
def sites(agent_id: str, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    return listed(agent_id)


@router.delete("/api/agents/{agent_id}/sites/{host}")
def forget(agent_id: str, host: str, user: int = Depends(auth.current_user)):
    """Retire le site de la liste. La session reste dans le navigateur : « Se déconnecter » se fait sur le site, par l'agent."""
    access.access(user, agent_id, "admin")
    ensure()
    with db.connect() as c:
        c.execute("DELETE FROM sites_connectes WHERE agent_id = ? AND hote = ?", (agent_id, host_of(host)))
    return {"ok": True}
