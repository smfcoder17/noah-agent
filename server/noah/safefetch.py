"""Lecture publique bornée, sans cookie ni proxy, avec connexion à l'IP vérifiée.

Chaque redirection est résolue à nouveau. Le DNS ne peut pas changer entre le
contrôle et la connexion : le socket utilise l'IP validée, TLS garde le nom SNI.
"""
import http.client
import ipaddress
import socket
import ssl
import time
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit


class UnsafeURL(ValueError):
    pass


@dataclass(frozen=True)
class Result:
    url: str
    content_type: str
    body: bytes


def resolve(url: str) -> tuple[str, str, int, str, str]:
    try:
        u = urlsplit(url)
        if u.scheme not in ("https", "http") or not u.hostname or u.username or u.password or u.fragment:
            raise UnsafeURL("Adresse publique HTTP ou HTTPS requise.")
        host = u.hostname.encode("idna").decode("ascii")
        port = u.port or (443 if u.scheme == "https" else 80)
        if port not in (80, 443) or any(c in url for c in "\r\n\x00\\"):
            raise UnsafeURL("Adresse refusée.")
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        ips = [ipaddress.ip_address(a[4][0]) for a in addresses]
        if not ips or any(not ip.is_global or getattr(ip, "ipv4_mapped", None) is not None
                          or (isinstance(ip, ipaddress.IPv6Address) and (ip in ipaddress.ip_network("64:ff9b::/96")
                              or ip in ipaddress.ip_network("64:ff9b:1::/48") or ip.sixtofour is not None or ip.teredo is not None))
                          for ip in ips):
            raise UnsafeURL("Adresse privée ou réservée refusée.")
        return u.scheme, host, port, str(ips[0]), (u.path or "/") + ("?" + u.query if u.query else "")
    except (ValueError, UnicodeError, OSError) as e:
        raise UnsafeURL("Adresse inaccessible ou refusée.") from e


def fetch(url: str, *, limit: int = 512_000, timeout: float = 8, redirects: int = 3) -> Result:
    deadline = time.monotonic() + timeout
    for _ in range(redirects + 1):
        scheme, host, port, ip, path = resolve(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UnsafeURL("Lecture trop longue.")
        conn = http.client.HTTPConnection(host, port, timeout=remaining)
        # Aucun second DNS : même face à un rebinding, la destination reste l'IP publique contrôlée.
        sock = socket.create_connection((ip, port), timeout=remaining)
        try:
            if scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            conn.sock = sock
            conn.request("GET", path, headers={"Host": host, "User-Agent": "Noah-LinkPreview/1", "Accept-Encoding": "identity"})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise UnsafeURL("Redirection sans adresse.")
                url = urljoin(url, location)
                continue
            if response.status != 200 or response.getheader("Content-Encoding", "identity") != "identity":
                raise UnsafeURL("Réponse non lisible.")
            body = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise UnsafeURL("Lecture trop longue.")
                conn.sock.settimeout(remaining) if conn.sock else sock.settimeout(remaining)
                chunk = response.read1(min(65536, limit + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > limit:
                    raise UnsafeURL("Fichier trop lourd.")
            return Result(url, response.getheader("Content-Type", "").split(";", 1)[0].lower(), bytes(body))
        finally:
            conn.close()
            sock.close()
    raise UnsafeURL("Trop de redirections.")
