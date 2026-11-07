"""Vrais logos des applications de Connexions. Le serveur les va chercher une fois, sur le site de l'application, et les
garde : le navigateur de la personne ne parle à aucun tiers. Mêmes protections réseau que les veilles (adresse jugée après
résolution, à chaque redirection). Rien de disponible : l'interface garde la lettre."""
import asyncio
import html
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Response

from . import auth, config, watch

router = APIRouter()

HOST = re.compile(r"(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
MAX_IMAGE = 512_000
MAX_PAGE = 400_000
FORGET_ABSENT = 86_400
MAX_HOSTS = 500
MAX_ABSENT = 2000
FIND_SECONDS = 30
RENEW_AFTER = 30 * 86_400  # un site change parfois de logo
_LINK = re.compile(r"<link\b[^>]*>", re.I)
_MAGIC = ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF8", "image/gif"), (b"\x00\x00\x01\x00", "image/x-icon"))
_gate = asyncio.Semaphore(6)
_running: dict[str, asyncio.Lock] = {}


def _folder() -> Path:
    path = Path(config.DATA_DIR) / "logos"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _kind(data: bytes) -> str | None:
    """Le type vient du contenu, jamais de ce que dit le site."""
    for magic, kind in _MAGIC:
        if data.startswith(magic):
            return kind
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    # Sans répétition imbriquée : une expression qui revient en arrière figerait tout le serveur sur une icône piégée.
    head = re.sub(rb"<!--.*?-->", b"", re.sub(rb"<\?xml[^>]*>", b"", data[:2000], count=1), flags=re.S).lstrip()
    if re.match(rb"<svg\b", head, re.I):
        return "image/svg+xml"
    return None


def _size(tag: str) -> int:
    sizes = re.search(r'sizes=["\']?(\d+)x', tag, re.I)
    if sizes:
        return int(sizes.group(1))
    return 180 if "apple-touch-icon" in tag.lower() else 16


def _candidates(page: str, base: str) -> list[str]:
    """Les icônes que la page déclare, la plus nette d'abord : un SVG, puis la plus grande."""
    found = []
    for tag in _LINK.findall(page):
        rel = re.search(r'rel=["\']?([^"\'>]+)', tag, re.I)
        href = re.search(r'href=["\']?([^"\'\s>]+)', tag, re.I)
        if not rel or not href or "icon" not in rel.group(1).lower() or "mask" in rel.group(1).lower():
            continue
        link = html.unescape(href.group(1))
        if link.lower().startswith("data:"):
            continue
        found.append((1000 if ".svg" in link.lower() else _size(tag), urljoin(base, link)))
    return [link for _, link in sorted(found, key=lambda f: -f[0])][:4]


async def _find(host: str) -> tuple[bytes, str] | None:
    home = f"https://{host}/"
    try:
        raw, final = await watch.read_bytes(home, MAX_PAGE)
        links = _candidates(raw.decode("utf-8", "replace"), final)
    except Exception:  # noqa: BLE001 - un site qui refuse ou se trompe : on essaie encore l'adresse habituelle
        links = []
    for link in [*links, urljoin(home, "/favicon.ico")]:
        try:
            data, _ = await watch.read_bytes(link, MAX_IMAGE + 1)
        except Exception:  # noqa: BLE001 - lien mort : le suivant
            continue
        kind = _kind(data)
        if kind and 32 < len(data) <= MAX_IMAGE:
            return data, kind
    return None


async def _timed_find(host: str) -> tuple[bytes, str] | None:
    """Une limite sur le tout : un site qui envoie goutte à goutte ne retient rien."""
    try:
        return await asyncio.wait_for(_find(host), FIND_SECONDS)
    except asyncio.TimeoutError:
        return None


def _make_room(folder: Path) -> None:
    """Le plus ancien cède sa place : un compte ne bloque pas les logos des autres. Vérifié juste avant d'écrire, sans attente
    entre les deux : des demandes simultanées ne dépassent pas le plafond."""
    images = sorted(folder.glob("*.bin"), key=lambda p: p.stat().st_mtime)
    for old in images[: max(0, len(images) - MAX_HOSTS + 1)]:
        old.unlink(missing_ok=True)
        old.with_suffix(".type").unlink(missing_ok=True)


def _note_absent(folder: Path, absent: Path) -> None:
    marks = sorted(folder.glob("*.absent"), key=lambda p: p.stat().st_mtime)
    for old in marks[: max(0, len(marks) - MAX_ABSENT + 1)]:
        old.unlink(missing_ok=True)
    absent.touch()


async def _logo(host: str) -> tuple[bytes, str] | None:
    folder = _folder()
    image, type_file, absent = folder / f"{host}.bin", folder / f"{host}.type", folder / f"{host}.absent"
    if image.exists() and type_file.exists():
        return image.read_bytes(), type_file.read_text()
    if absent.exists() and time.time() - absent.stat().st_mtime < FORGET_ABSENT:
        return None
    lock = _running.setdefault(host, asyncio.Lock())
    async with lock, _gate:
        if image.exists() and type_file.exists():
            return image.read_bytes(), type_file.read_text()
        found = await _timed_find(host)
        if found:
            _make_room(folder)
            image.write_bytes(found[0])
            type_file.write_text(found[1])
            absent.unlink(missing_ok=True)
        else:
            _note_absent(folder, absent)
    _running.pop(host, None)
    return found


def _host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower() if url else ""


async def prepare(connections: dict) -> None:
    """Va chercher d'avance les logos de cet écran, sans faire attendre personne, et renouvelle ceux qui ont vieilli."""
    # Ce qui est branché, pas tout le catalogue : le reste se charge quand on le regarde.
    hosts = {a.get("hote") or _host_of(a.get("source") or "") for a in connections.get("applications") or [] if a.get("installe")}
    hosts |= {_host_of(t.get("url") or "") for t in connections.get("outils") or []}
    for host in sorted(h.lower() for h in hosts if h):
        if not HOST.fullmatch(host):
            continue
        folder = _folder()
        image = folder / f"{host}.bin"
        if image.exists() and time.time() - image.stat().st_mtime > RENEW_AFTER:
            found = await _timed_find(host)
            if found:
                image.write_bytes(found[0])
                (folder / f"{host}.type").write_text(found[1])
            else:
                image.touch()  # site muet : le logo connu reste bon
        elif not image.exists():
            await _logo(host)


@router.get("/api/logos/{host}")
async def logo(host: str, _user: int = Depends(auth.current_user)):
    host = host.lower()
    if not HOST.fullmatch(host):
        raise HTTPException(400, "Nom refusé")
    found = await _logo(host)
    if not found:  # une réponse normale : la lettre reste, sans erreur dans la console
        return Response(status_code=204, headers={"Cache-Control": "private, max-age=86400"})
    return Response(found[0], media_type=found[1], headers={
        "Cache-Control": "private, max-age=604800, stale-while-revalidate=2592000", "X-Content-Type-Options": "nosniff",
        # Un SVG vient d'un site tiers : ouvert seul, il ne doit rien pouvoir exécuter ici.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})
