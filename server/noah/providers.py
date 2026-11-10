"""Fournisseurs branchés : clés chiffrées, icônes publiques sans session."""
import asyncio
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from . import access, auth, catalog, db, hermes, relay

router = APIRouter()


def key_of(provider: str) -> str | None:
    if provider == db.get_setting("provider"):
        return db.get_setting("api_key", secret=True) if db.get_setting("api_key") else None
    if db.get_setting(f"provider_key:{provider}"):
        return db.get_setting(f"provider_key:{provider}", secret=True)
    if provider == "openrouter" and db.get_setting("media_api_key"):
        return db.get_setting("media_api_key", secret=True)
    return None


def base_of(provider: str) -> str | None:
    return (db.get_setting("base_url") if provider == db.get_setting("provider") else db.get_setting(f"provider_base:{provider}")) or None


def remember(provider: str, key: str | None, base: str | None) -> None:
    db.set_setting(f"provider_key:{provider}", key or "", secret=bool(key))
    db.set_setting(f"provider_base:{provider}", base or "")
    db.set_setting(f"provider_connected:{provider}", "1")


def connected(provider: str) -> bool:
    return provider == db.get_setting("provider") or bool(db.get_setting(f"provider_connected:{provider}")) or bool(key_of(provider))


@router.get("/api/fournisseurs")
def list_providers(_user: int = Depends(access.owner_only)):
    return [{"id": p, "label": v["label"], "needs_key": v["env"] is not None, "own_url": p in relay.OWN_URL,
             "connected": connected(p), "models": int(db.get_setting(f"provider_count:{p}") or 0),
             "base_url": base_of(p) or ""} for p, v in hermes.PROVIDERS.items()]


class Choice(BaseModel):
    api_key: str | None = Field(default=None, max_length=8192)
    base_url: str | None = Field(default=None, max_length=500)


@router.put("/api/fournisseurs/{provider}")
async def connect(provider: str, body: Choice, _user: int = Depends(access.owner_only)):
    if provider not in hermes.PROVIDERS:
        raise HTTPException(404, "Fournisseur inconnu.")
    base = (body.base_url or "").strip().rstrip("/") or None
    if provider not in relay.OWN_URL:
        base = None
    if base:
        u = urlsplit(base)
        if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.query or u.fragment:
            raise HTTPException(400, "Adresse HTTP ou HTTPS sans identifiants requise.")
    if provider == "custom" and not base:
        raise HTTPException(400, "Indique l'adresse de ton fournisseur.")
    key = body.api_key or (key_of(provider) if base == base_of(provider) else None)
    if hermes.PROVIDERS[provider]["env"] and not key:
        raise HTTPException(400, "Colle ta clé dans ce champ.")
    try:
        if key:
            await catalog.check_key(provider, key)
        models = await catalog.models_for(provider, key, base)
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(400, "Connexion impossible. Vérifie l'adresse et la clé, puis réessaie.") from None
    if not models:
        raise HTTPException(400, "Ce fournisseur ne propose aucun modèle utilisable.")
    remember(provider, key, base)
    db.set_setting(f"provider_count:{provider}", str(len(models)))
    if provider == db.get_setting("provider"):
        db.set_setting("api_key", key or "", secret=bool(key))
        db.set_setting("base_url", base or "")
    return {"connected": True, "models": len(models)}


@router.get("/api/fournisseurs/{provider}/icone")
async def icon(provider: str, _user: int = Depends(auth.current_user)):
    if provider not in hermes.PROVIDERS:
        raise HTTPException(404, "Fournisseur inconnu.")
    base = base_of(provider)
    found = await asyncio.to_thread(catalog.provider_icon, base) if base else None
    if not found:
        return Response(status_code=204, headers={"Cache-Control": "private, max-age=3600"})
    return Response(found[0], media_type=found[1], headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"})
