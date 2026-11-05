"""Ce que chaque réponse dit au navigateur et aux robots, posé par le serveur lui-même : quel que soit le mandataire devant
(Caddy, Traefik, rien), et sur toutes les réponses, 404 et statiques compris."""
import re

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

ROBOTS_TAG = "noindex, nofollow, noarchive"
ROBOTS_TXT = "User-agent: *\nDisallow: /\n"
HSTS = "max-age=31536000"

# L'application : scripts et feuilles de styles de Vite seulement. Les attributs style de React restent permis. Une image
# externe citée dans une réponse d'agent ne se charge pas : elle pourrait faire sortir la conversation dans son adresse.
APP_CSP = "; ".join((
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
))
# noVNC (écran du navigateur de l'agent, dans un cadre de l'application) : sa page contient des scripts en ligne, et son
# WebSocket revient sur cette adresse.
SCREEN_CSP = "; ".join((
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'self'",
))
_SCREEN = re.compile(r"^/api/agents/[^/]+/screen/")
# Une page d'aperçu a une origine opaque et peut contenir ses propres cadres : leur parent n'est alors « même origine » pour
# personne. Son lien signé et son bac à sable la protègent, pas X-Frame-Options.
_PREVIEW = "/api/apercu/"

COMMON = {
    "X-Robots-Tag": ROBOTS_TAG,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), display-capture=()",
}


def headers_for(scope: Scope) -> dict[str, str]:
    path = scope.get("path", "")
    out = {**COMMON, "Content-Security-Policy": SCREEN_CSP if _SCREEN.match(path) else APP_CSP}
    if not path.startswith(_PREVIEW):
        out["X-Frame-Options"] = "SAMEORIGIN"
    if scope.get("scheme") == "https":
        out["Strict-Transport-Security"] = HSTS
    return out


class SecurityHeaders:
    """Intergiciel ASGI brut : il ne met aucun flux en tampon. Une route qui pose son propre en-tête (bac à sable des fichiers,
    Referrer-Policy de l'aperçu) le garde."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in headers_for(scope).items():
                    if name not in headers:
                        headers[name] = value
            await send(message)

        await self.app(scope, receive, with_headers)
