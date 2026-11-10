"""Aperçus publics : toutes les lectures sont côté serveur, bornées et sans session."""
import asyncio
import hashlib
import json
import time
import threading
from collections import OrderedDict
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from . import auth, safefetch

router = APIRouter()
_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_images: OrderedDict[str, tuple[bytes, str]] = OrderedDict()
_gate = asyncio.Semaphore(4)
TTL = 3600
MAX_IMAGES = 64
MAX_PREVIEWS = MAX_IMAGES // 2  # une miniature et une icône par aperçu
_lock = threading.RLock()


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.title, self.icons, self.oembed = {}, "", [], None
        self.in_title, self.skip = False, 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if tag == "meta" and not self.skip:
            self.meta[a.get("property", a.get("name", "")).lower()] = a.get("content", "")
        if tag == "link" and not self.skip:
            if "icon" in a.get("rel", "").lower().split():
                self.icons.append(a.get("href", ""))
            if a.get("type") == "application/json+oembed":
                self.oembed = a.get("href")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title and not self.skip:
            self.title += data


def text(value: object, limit: int = 300) -> str:
    class Clean(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts, self.skip = [], 0
        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style"):
                self.skip += 1
        def handle_endtag(self, tag):
            if tag in ("script", "style"):
                self.skip = max(0, self.skip - 1)
        def handle_data(self, data):
            if not self.skip:
                self.parts.append(data)
    clean = Clean()
    clean.feed(str(value or "")[:10_000])
    return " ".join(" ".join(clean.parts).split())[:limit]


def image(url: str) -> str | None:
    try:
        raw = safefetch.fetch(url, limit=512_000, timeout=4)
        body = raw.body
        kind = ("image/png" if body.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg" if body.startswith(b"\xff\xd8\xff") else
                "image/gif" if body.startswith(b"GIF8") else "image/webp" if body[:4] == b"RIFF" and body[8:12] == b"WEBP" else
                "image/x-icon" if body.startswith(b"\x00\x00\x01\x00") else None)
        if not kind:
            return None
        key = hashlib.sha256(body).hexdigest()
        with _lock:
            _images[key] = (body, kind)
            _images.move_to_end(key)
            while len(_images) > MAX_IMAGES:
                evicted, _ = _images.popitem(last=False)
                path = f"/api/liens/image/{evicted}"
                for address, (_, cached) in list(_cache.items()):
                    if path in (cached.get("image"), cached.get("icon")):
                        del _cache[address]
        return f"/api/liens/image/{key}"
    except (safefetch.UnsafeURL, OSError, ValueError):
        return None


def preview(url: str) -> dict:
    with _lock:
        hit = _cache.get(url)
        if hit and time.monotonic() - hit[0] < TTL:
            paths = [hit[1].get(k) for k in ("image", "icon") if hit[1].get(k)]
            if all(path.rsplit("/", 1)[-1] in _images for path in paths):
                _cache.move_to_end(url)
                for path in paths:
                    _images.move_to_end(path.rsplit("/", 1)[-1])
                return hit[1]
    raw = safefetch.fetch(url, limit=512_000, timeout=6)
    page = Page()
    if raw.content_type not in ("text/html", "application/xhtml+xml"):
        raise safefetch.UnsafeURL("Cette adresse n'est pas une page.")
    page.feed(raw.body.decode("utf8", "replace"))
    meta, embed = page.meta, {}
    if page.oembed:
        try:
            found = safefetch.fetch(urljoin(raw.url, page.oembed), limit=128_000, timeout=3)
            data = json.loads(found.body)
            if isinstance(data, dict):
                embed = data
        except (safefetch.UnsafeURL, OSError, ValueError):
            pass
    # Jamais le HTML oEmbed : seulement texte et images contrôlées.
    thumbnail = meta.get("og:image") or embed.get("thumbnail_url")
    duration = meta.get("video:duration") or embed.get("duration")
    out = {"url": raw.url, "title": text(meta.get("og:title") or embed.get("title") or page.title) or urlsplit(raw.url).hostname,
           "site": text(meta.get("og:site_name") or embed.get("provider_name") or urlsplit(raw.url).hostname),
           "description": text(meta.get("og:description") or meta.get("description")),
           "duration": int(duration) if str(duration).isdigit() and int(duration) < 86400 else None,
           "image": image(urljoin(raw.url, str(thumbnail))) if thumbnail else None,
           "icon": image(urljoin(raw.url, page.icons[0] if page.icons else "/favicon.ico"))}
    with _lock:
        # Une autre lecture a pu expulser une image pendant la lecture de l'icône.
        for field in ("image", "icon"):
            if out[field] and out[field].rsplit("/", 1)[-1] not in _images:
                out[field] = None
        _cache[url] = (time.monotonic(), out)
        while len(_cache) > MAX_PREVIEWS:
            _cache.popitem(last=False)
    return out


class Link(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


@router.post("/api/liens/apercu")
async def get_preview(body: Link, _user: int = Depends(auth.current_user)):
    async with _gate:
        try:
            return await asyncio.to_thread(preview, body.url)
        except (safefetch.UnsafeURL, OSError, ValueError):
            raise HTTPException(400, "Aperçu indisponible pour ce lien.") from None


@router.post("/api/liens/media")
async def get_media(body: Link, _user: int = Depends(auth.current_user)):
    async with _gate:
        path = await asyncio.to_thread(image, body.url)
        if not path:
            raise HTTPException(400, "Image indisponible.")
        return {"url": path}


@router.get("/api/liens/image/{key}")
def get_image(key: str, _user: int = Depends(auth.current_user)):
    with _lock:
        found = _images.get(key)
        if found:
            _images.move_to_end(key)
    if not found:
        raise HTTPException(404, "Image expirée. Rouvre le lien.")
    return Response(found[0], media_type=found[1], headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"})
