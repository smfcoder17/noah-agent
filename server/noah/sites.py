"""Les sessions de l'agent dans son navigateur, pour qu'elles se voient dans Connexions à côté des outils.

Un registre vérifié (0.3.0, leçons de Nod : docs/epics/0.3.0/nod-comparaison.md, 4.2) :
- un site n'est « connecté » qu'après un contrôle du serveur : la vraie page est sur ce site, et elle n'a plus de champ de mot de
  passe. L'agent peut le demander (`noah.py site-connecte`), une connexion par le coffre le fait d'elle-même ; dire ne suffit pas ;
- une page de connexion qui revient sur un site noté connecté le fait passer « à reconnecter » ;
- rien ne vient plus des cookies : un site seulement lu n'apparaît pas, et « Retirer » tient ;
- les identifiants retenus (coffre.py) ne s'y mêlent pas : ils ont leur liste à eux.
Aucun secret ne passe ici.
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
STATES = ("connecte", "a_reconnecter", "non_verifie")


def ensure() -> None:
    with db.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS sites_connectes (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                  "hote TEXT NOT NULL, nom TEXT NOT NULL, compte TEXT NOT NULL DEFAULT '', vu_a REAL NOT NULL, PRIMARY KEY (agent_id, hote))")
        # Les lignes d'avant 0.3.0 n'ont été que déclarées par l'agent : elles restent, marquées non vérifiées.
        if "etat" not in {r["name"] for r in c.execute("PRAGMA table_info(sites_connectes)")}:
            c.execute("ALTER TABLE sites_connectes ADD COLUMN etat TEXT NOT NULL DEFAULT 'non_verifie'")


def host_of(address: str) -> str:
    """Le nom du site, sans www : « https://www.linkedin.com/feed » → linkedin.com. Vide si ce n'est pas un site public."""
    text = address.strip().lower()
    host = (urlsplit(text if "://" in text else f"https://{text}").hostname or "").removeprefix("www.")
    return host if HOST.match(host) and not NOT_A_SITE.search(host) else ""


def _site(host: str) -> str:
    return coffre.site_of(f"https://{host}")


def note(agent_id: str, address: str, name: str = "", account: str = "", state: str = "connecte") -> str:
    """Écrit une ligne du registre. Seuls `verify` et la connexion par le coffre l'appellent : ils ont vu la page."""
    host = host_of(address)
    if not host:
        return ""
    ensure()
    label = (name.strip() or _site(host))[:60]
    with db.connect() as c:
        if c.execute("SELECT COUNT(*) FROM sites_connectes WHERE agent_id = ? AND hote != ?", (agent_id, host)).fetchone()[0] >= MAX_SITES:
            c.execute("DELETE FROM sites_connectes WHERE agent_id = ? AND hote = (SELECT hote FROM sites_connectes WHERE agent_id = ? ORDER BY vu_a LIMIT 1)",
                      (agent_id, agent_id))
        c.execute("INSERT INTO sites_connectes (agent_id, hote, nom, compte, vu_a, etat) VALUES (?, ?, ?, ?, ?, ?) "
                  "ON CONFLICT(agent_id, hote) DO UPDATE SET nom = CASE WHEN ? != '' THEN excluded.nom ELSE nom END, "
                  "compte = CASE WHEN excluded.compte != '' THEN excluded.compte ELSE compte END, vu_a = excluded.vu_a, etat = excluded.etat",
                  (agent_id, host, label, account.strip()[:120], time.time(), state, name.strip()))
    return host


def signed_in(page: dict, address: str = "") -> str:
    """La raison pour laquelle cette page ne prouve pas une session sur ce site, ou "" si elle la prouve."""
    origin = page.get("origine") or ""
    if not host_of(origin):
        return "Ouvre une page du site lui-même dans le navigateur."
    if address and _site(host_of(address) or "-") != _site(host_of(origin)):
        return f"La page ouverte est sur {coffre.site_of(origin)}, pas sur ce site : ouvre une page du site une fois connecté."
    if (page.get("champs") or {}).get("motDePasse"):
        return "La page demande encore un mot de passe : la connexion n'est pas faite."
    return ""


async def verify(agent_id: str, address: str = "", name: str = "", account: str = "", proven: bool = False) -> str:
    """Lit la vraie page et note le site s'il y est resté. Rend la raison d'un refus, ou "".

    « Connecté » seulement si `proven` : le serveur vient lui-même d'envoyer un formulaire de connexion (coffre.py) et la page
    l'a quitté. Une page sans champ de mot de passe ne prouve rien de plus : un accueil public, déconnecté, en est une. Sur la
    seule parole de l'agent, le site est noté « non vérifié » ; une ligne déjà connectée le reste (relecture 0.3.0, partie 5 n°4)."""
    page = await coffre._page(agent_id)
    if page.get("error"):
        return page["error"]
    why = signed_in(page, address)
    if why:
        return why
    # Le nom du site qu'on a vérifié : l'adresse donnée par l'agent ne sert qu'à vérifier, la page fait foi.
    host = host_of(page["origine"])
    if address and host_of(address) and _site(host_of(address)) == _site(host):
        host = host_of(address)
    state = "connecte" if proven or _state(agent_id, host_of(host) or host) == "connecte" else "non_verifie"
    return "" if note(agent_id, host, name, account, state) else "Ouvre une page du site lui-même dans le navigateur."


def _state(agent_id: str, host: str) -> str:
    ensure()
    with db.connect() as c:
        row = c.execute("SELECT etat FROM sites_connectes WHERE agent_id = ? AND hote = ?", (agent_id, host)).fetchone()
    return row["etat"] if row else ""


def needs_sign_in(agent_id: str, origin: str) -> None:
    """Une page de connexion sur un site noté connecté : sa session n'est plus là. Sur l'hôte exact seulement ; les autres hôtes
    du même site (accounts.google.com ↔ mail.google.com) ne sont plus sûrs, sans être perdus : « non vérifié » (partie 5 n°7)."""
    host = host_of(origin)
    if not host:
        return
    ensure()
    with db.connect() as c:
        for row in c.execute("SELECT hote FROM sites_connectes WHERE agent_id = ? AND etat = 'connecte'", (agent_id,)).fetchall():
            if row["hote"] == host:
                c.execute("UPDATE sites_connectes SET etat = 'a_reconnecter' WHERE agent_id = ? AND hote = ?", (agent_id, row["hote"]))
            elif _site(row["hote"]) == _site(host):
                c.execute("UPDATE sites_connectes SET etat = 'non_verifie' WHERE agent_id = ? AND hote = ?", (agent_id, row["hote"]))


def listed(agent_id: str) -> list[dict]:
    ensure()
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT hote, nom, compte, vu_a, etat FROM sites_connectes WHERE agent_id = ? ORDER BY vu_a DESC", (agent_id,))]


class Site(BaseModel):
    adresse: str = Field(min_length=3, max_length=500)
    nom: str = Field(default="", max_length=60)
    compte: str = Field(default="", max_length=120)


@router.post("/agent-api/sites")
async def agent_note(body: Site, request: Request):
    agent_id = relay._agent_from(request)
    if not host_of(body.adresse):
        raise HTTPException(400, "Donne l'adresse publique du site (ex. linkedin.com).")
    why = await verify(agent_id, body.adresse, body.nom, body.compte)
    if why:
        raise HTTPException(409, f"Pas noté connecté : {why}")
    return {"ok": True, "site": host_of(body.adresse), "etat": _state(agent_id, host_of(body.adresse))}


@router.delete("/agent-api/sites/{host}")
def agent_forget(host: str, request: Request):
    ensure()
    with db.connect() as c:
        c.execute("DELETE FROM sites_connectes WHERE agent_id = ? AND hote = ?", (relay._agent_from(request), host_of(host)))
    return {"ok": True}


@router.get("/api/agents/{agent_id}/sites")
def sites(agent_id: str, user: int = Depends(auth.current_user)):
    """Le registre seul : ce que le serveur a vérifié, avec son état. Ni cookies, ni coffre."""
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
