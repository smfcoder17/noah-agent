"""Comment un fichier de l'espace de travail est remis au navigateur : ses en-têtes de protection, et la lecture par morceaux.

Ce qu'un agent écrit ne s'exécute jamais avec l'origine de Noah : une page ou un SVG injecté y volerait la session. Les pages et tout ce
qui peut porter un script restent donc dans un bac à sable (origine opaque). Un fichier qui ne s'exécute pas (image, vidéo, son, PDF, texte)
n'en a pas besoin, et le bac à sable le casserait : sa vidéo, ouverte seule dans un onglet, se recharge elle-même depuis une origine
« null » et le navigateur la refuse (CORS) ; son PDF n'ouvre pas le lecteur.
"""
import re

from fastapi import Request, Response

SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals"
# Aucun script, aucun cadre, rien d'extérieur : le fichier se lit, il ne fait rien d'autre.
INERT = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'"
_INERT_TYPE = re.compile(r"^(image/(png|jpeg|gif|webp|avif|bmp|x-icon)|video/[\w.+-]+|audio/[\w.+-]+|application/pdf|text/(plain|markdown|csv)|application/json)(;|$)", re.I)
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def is_inert(content_type: str) -> bool:
    """Vrai pour un type qui ne s'exécute pas. Tout le reste (HTML, SVG, XML, type inconnu) est traité comme actif."""
    return bool(_INERT_TYPE.match(content_type or ""))


def protection(content_type: str) -> str:
    return INERT if is_inert(content_type) else SANDBOX


def served(request: Request, content: bytes, content_type: str, headers: dict[str, str]) -> Response:
    """Le fichier entier, ou le morceau demandé (Range : une seule plage). Safari, iOS et Android ne lisent une vidéo que par morceaux,
    et sans cela aucun navigateur ne peut avancer dans une vidéo qui n'est pas encore tout entière arrivée."""
    out = {**headers, "Accept-Ranges": "bytes"}
    total = len(content)
    wanted = _RANGE.fullmatch((request.headers.get("range") or "").strip())
    if not wanted or not (wanted[1] or wanted[2]):
        return Response(content, media_type=content_type, headers=out)
    if wanted[1]:
        start = int(wanted[1])
        end = min(int(wanted[2]), total - 1) if wanted[2] else total - 1
    else:  # « les n derniers octets »
        start, end = max(total - int(wanted[2]), 0), total - 1
    if total == 0 or start >= total or start > end:
        return Response(status_code=416, headers={**out, "Content-Range": f"bytes */{total}"})
    return Response(content[start:end + 1], status_code=206, media_type=content_type, headers={**out, "Content-Range": f"bytes {start}-{end}/{total}"})
