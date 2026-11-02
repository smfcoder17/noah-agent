"""Adresse publique d'un Noah installé sans rien configurer (VPS) : son nom et son certificat HTTPS.

Avec NOAH_DOMAIN=auto, le nom est <ip-publique-en-tirets>.sslip.io : le service sslip.io renvoie l'adresse contenue
dans le nom, et Caddy y obtient un vrai certificat Let's Encrypt. Caddy demande ses certificats « à la demande » et
interroge d'abord /api/tls-ask : seul le nom de ce serveur est accepté, jamais un nom quelconque qui pointerait ici.
"""
import asyncio
import logging

import httpx
from fastapi import APIRouter, HTTPException

from . import auth
from .config import PUBLIC_DOMAIN, SETUP_CODE

router = APIRouter()
log = logging.getLogger("uvicorn.error")
_state: dict = {"ip": "", "domaines": set()}


def domains() -> set[str]:
    return _state["domaines"]


def main_url() -> str:
    names = sorted(domains(), key=lambda d: not d.endswith("sslip.io"))
    if PUBLIC_DOMAIN and PUBLIC_DOMAIN != "auto":
        names = [PUBLIC_DOMAIN]
    return f"https://{names[0]}" if names else ""


async def _public_ip() -> str:
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                ip = (await c.get(url)).text.strip()
            if ip.count(".") == 3 and all(p.isdigit() for p in ip.split(".")):
                return ip
        except httpx.HTTPError:
            continue
    return ""


async def setup() -> None:
    """Au démarrage : trouve l'adresse publique, puis écrit dans les journaux le lien de création du compte."""
    if not PUBLIC_DOMAIN:
        return
    if PUBLIC_DOMAIN != "auto":
        domains().add(PUBLIC_DOMAIN.lower())
    for _ in range(30):
        ip = await _public_ip()
        if ip:
            dashed = ip.replace(".", "-")
            _state["ip"] = ip
            # nip.io en secours si sslip.io a épuisé son quota de certificats chez Let's Encrypt.
            domains().update({f"{dashed}.sslip.io", f"{dashed}.nip.io"})
            break
        await asyncio.sleep(10)
    url = main_url()
    if not url:
        log.warning("Noah : adresse publique introuvable. Indique ton domaine avec NOAH_DOMAIN=noah.exemple.com.")
        return
    if SETUP_CODE and not auth.has_users():
        log.warning("\n\n  Noah est prêt. Ouvre ce lien pour créer ton compte :\n\n    %s/?installation=%s\n\n"
                    "  Code d'installation : %s\n", url, SETUP_CODE, SETUP_CODE)
    else:
        log.warning("Noah est prêt : %s", url)


@router.get("/api/tls-ask")
def tls_ask(domain: str = ""):
    """Caddy (on_demand_tls) : un certificat seulement pour les noms de ce serveur."""
    if domain.lower() in domains():
        return {"ok": True}
    raise HTTPException(403, "Nom inconnu")


@router.get("/api/public")
def public_address():
    """L'adresse à afficher ou à mettre dans un QR code (le nom sslip.io plutôt que http://IP:port)."""
    return {"adresse": main_url()}
