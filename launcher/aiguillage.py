"""Aiguillage de la sortie réseau des navigateurs d'agents (conteneur `noah-sortie`).

Le navigateur de chaque agent a ce mandataire (HTTP, CONNECT) pour seule porte vers Internet, et ses outils (terminal, curl, web) aussi, par HTTP(S)_PROXY (env_proxy_agent). Il le fait sortir par la
meilleure sortie qui répond, dans l'ordre de la liste : maison (l'ordinateur de la personne, par le relais du serveur), puis VPN (Gluetun), puis, en
repli, le serveur lui-même (« direct »).

Règles (tests/sortie/aiguillage_test.py) :
- chaque sortie est sondée régulièrement (un CONNECT vers un site de contrôle) ; son adresse vue par les sites et son pays
  sont relus par ipinfo.io à travers elle, au retour d'une panne puis rarement (le quota gratuit ne suit pas une sonde par
  minute) ;
- la sortie choisie reste la même tant qu'elle répond : un site connecté voit toujours la même adresse ;
- elle tombe : tout de suite la suivante, et le repli direct si aucune ne répond ;
- une sortie meilleure revient : on n'y repasse qu'après plusieurs minutes sans aucune connexion qui ait bougé (entre deux
  tâches, jamais au milieu d'une session) ;
- tant qu'une sortie répond, rien ne part en direct : le direct n'est qu'un dernier recours.

Le mandataire refuse les destinations privées (adresses du réseau local, CGNAT, noms internes) : un navigateur
compromis ne s'en sert pas pour atteindre le PC de la personne par la sortie maison (l'app de bureau le refuse aussi, de son côté).

Rien de secret ici : le fichier WireGuard est dans le conteneur du VPN, jamais dans celui-ci. Seulement la
bibliothèque standard : l'image est celle du serveur Noah, déjà sur la machine.

    python aiguillage.py          sert (variables NOAH_SORTIE_*, voir plus bas)
    python aiguillage.py --etat   écrit l'état en JSON (lu par le lanceur, qui n'ouvre aucun port vers ce conteneur)
"""
import asyncio
import http.client
import ipaddress
import json
import os
import ssl
import sys
import time

DIRECT = "direct"
PORT = int(os.environ.get("NOAH_SORTIE_PORT", "3128"))
ETAT_PORT = int(os.environ.get("NOAH_SORTIE_ETAT_PORT", "3129"))  # 127.0.0.1 seulement
INACTIVITE = float(os.environ.get("NOAH_SORTIE_INACTIVITE", "300"))  # secondes sans connexion qui bouge avant de revenir à une meilleure sortie
SONDE = float(os.environ.get("NOAH_SORTIE_SONDE", "20"))  # secondes entre deux sondes
SONDE_DELAI = float(os.environ.get("NOAH_SORTIE_SONDE_DELAI", "10"))
INFO_VALIDE = float(os.environ.get("NOAH_SORTIE_INFO", "900"))  # l'adresse vue des sites est relue au plus toutes les 15 minutes
SEUIL = int(os.environ.get("NOAH_SORTIE_SEUIL", "2"))  # sondes ratées de suite avant de dire « injoignable »
SITE_SONDE = os.environ.get("NOAH_SORTIE_SITE", "api.ipify.org")
SITE_INFO = os.environ.get("NOAH_SORTIE_SITE_INFO", "ipinfo.io")
SITE_PORT = int(os.environ.get("NOAH_SORTIE_SITE_PORT", "443"))
MAX_ENTETE = 64 * 1024
CONNEXION_DELAI = 15.0
# Banc d'essai seulement (tests/sortie) : des faux sites vivent sur des adresses privées. Le lanceur ne pose jamais cette variable.
PRIVE_OK = os.environ.get("NOAH_SORTIE_PRIVE_OK") == "1"


class Sortie:
    def __init__(self, nom: str, hote: str = "", port: int = 0):
        self.nom, self.hote, self.port = nom, hote, port
        self.etat = "ok" if nom == DIRECT else "inconnu"  # ok | ko | inconnu ; le direct répond toujours
        self.echecs = 0
        self.info: dict = {}
        self.info_a = float("-inf")
        self.lecture = None  # lecture de l'adresse en cours
        self.depuis = 0.0  # heure (horloge murale) du dernier changement d'état


class Aiguillage:
    """Le choix de la sortie, sans réseau ni horloge propre : testé avec une horloge à la main."""

    def __init__(self, amont: list[Sortie], inactivite: float = INACTIVITE, seuil: int = SEUIL, horloge=time.monotonic, murale=time.time):
        self.sorties = {s.nom: s for s in [*amont, Sortie(DIRECT)]}
        self.ordre = [s.nom for s in amont] + [DIRECT]
        self.inactivite, self.seuil, self.horloge, self.murale = inactivite, seuil, horloge, murale
        self.courante: str | None = None
        self.connexions: dict[int, float] = {}  # connexion ouverte -> dernier octet passé
        self.derniere = float("-inf")  # dernière ouverture, fermeture ou octet
        self._n = 0
        self.bascules: list[dict] = []

    # --- sondes ---------------------------------------------------------------------------------------------------
    def sonde(self, nom: str, ok: bool, info: dict | None = None) -> None:
        s = self.sorties[nom]
        if ok:
            if s.etat != "ok":
                s.depuis = self.murale()
            s.etat, s.echecs = "ok", 0
            if info:
                s.info, s.info_a = info, self.horloge()
        else:
            s.echecs += 1
            if s.echecs >= self.seuil and s.etat != "ko":
                s.etat, s.depuis = "ko", self.murale()

    def echec_connexion(self, nom: str) -> None:
        """Une vraie connexion n'a pas pu passer par cette sortie : inutile d'attendre la deuxième sonde."""
        s = self.sorties[nom]
        s.echecs = max(s.echecs + 1, self.seuil)
        if s.etat != "ko":
            s.etat, s.depuis = "ko", self.murale()

    def saine(self, nom: str) -> bool:
        return self.sorties[nom].etat == "ok"

    def meilleure(self) -> str:
        return next((n for n in self.ordre if self.saine(n)), DIRECT)  # dernier recours, même si sa propre sonde vient d'échouer

    # --- connexions -----------------------------------------------------------------------------------------------
    def ouvrir(self) -> int:
        self._n += 1
        self.connexions[self._n] = self.derniere = self.horloge()
        return self._n

    def toucher(self, n: int) -> None:
        if n in self.connexions:
            self.connexions[n] = self.derniere = self.horloge()

    def fermer(self, n: int) -> None:
        if self.connexions.pop(n, None) is not None:
            self.derniere = self.horloge()

    def inactif(self) -> bool:
        """Aucune connexion n'a bougé depuis `inactivite` secondes. Une connexion ouverte mais muette depuis aussi longtemps
        (un tunnel gardé ouvert par le navigateur) ne compte plus comme une session en cours."""
        dernier = max([self.derniere, *self.connexions.values()])
        return self.horloge() - dernier >= self.inactivite

    # --- choix ----------------------------------------------------------------------------------------------------
    def choisir(self) -> str:
        meilleure = self.meilleure()
        if self.courante is None:
            self._passer(meilleure, "premier choix")
        elif not self.saine(self.courante):
            self._passer(meilleure, f"{self.courante} ne répond plus")
        elif self.ordre.index(meilleure) < self.ordre.index(self.courante) and self.inactif():
            self._passer(meilleure, f"{meilleure} répond de nouveau, aucune connexion en cours")
        return self.courante

    def _passer(self, vers: str, raison: str) -> None:
        if vers == self.courante:
            return
        self.bascules = [*self.bascules[-19:], {"quand": self.murale(), "de": self.courante, "vers": vers, "raison": raison}]
        print(f"[sortie] {self.courante or '-'} -> {vers} : {raison}", flush=True)
        self.courante = vers

    def etat(self) -> dict:
        actuelle = self.courante
        out = []
        for nom in self.ordre:
            s = self.sorties[nom]
            out.append({"nom": nom, "etat": "active" if nom == actuelle and s.etat == "ok" else {"ok": "prete", "ko": "injoignable"}.get(s.etat, "inconnue"),
                        "depuis": s.depuis or None, **{k: s.info.get(k) for k in ("ip", "city", "region", "country", "timezone")}})
        return {"active": actuelle, "sorties": out, "bascules": self.bascules, "inactif": self.inactif()}


# --- Destinations refusées ---------------------------------------------------------------------------------------

NOMS_INTERNES = (".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".ts.net", ".localhost")
PORTS_REFUSES = {25}  # courrier sortant : jamais pour un navigateur


def adresse_privee(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip.strip("[]"))
    except ValueError:
        return False
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified
            or a in ipaddress.ip_network("100.64.0.0/10"))  # CGNAT : is_private ne le couvre pas


def destination_interdite(hote: str, port: int) -> str:
    """La raison du refus, ou une chaîne vide."""
    h = hote.lower().rstrip(".")
    if not h or not 0 < port < 65536:
        return "destination invalide"
    if port in PORTS_REFUSES:
        return "port refusé"
    if PRIVE_OK:
        return ""
    if adresse_privee(h):
        return "adresse privée"
    if "." not in h and ":" not in h or h == "localhost" or h.endswith(NOMS_INTERNES):
        return "nom interne"
    return ""


# --- Réseau -----------------------------------------------------------------------------------------------------

class ErreurAmont(Exception):
    """La sortie elle-même ne répond pas (connexion refusée, délai, réponse incompréhensible)."""


class RefusAmont(Exception):
    """La sortie répond, mais refuse cette destination (le site est peut-être arrêté) : ce n'est pas une panne de la sortie."""

    def __init__(self, ligne: str):
        super().__init__(ligne)
        self.ligne = ligne


async def ouvrir_direct(hote: str, port: int):
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(loop.getaddrinfo(hote, port, type=1), CONNEXION_DELAI)
    except (OSError, asyncio.TimeoutError) as e:
        raise RefusAmont("résolution impossible") from e
    if not PRIVE_OK and any(adresse_privee(i[4][0]) for i in infos):
        raise RefusAmont("adresse privée")
    try:
        return await asyncio.wait_for(asyncio.open_connection(infos[0][4][0], port), CONNEXION_DELAI)
    except (OSError, asyncio.TimeoutError) as e:
        raise RefusAmont("connexion impossible") from e


async def ouvrir_par(s: Sortie, hote: str, port: int):
    """Un tunnel vers hote:port par cette sortie (CONNECT chez le mandataire amont)."""
    if s.nom == DIRECT:
        return await ouvrir_direct(hote, port)
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(s.hote, s.port), CONNEXION_DELAI)
    except (OSError, asyncio.TimeoutError) as e:
        raise ErreurAmont(str(e) or "délai") from e
    try:
        w.write(f"CONNECT {hote}:{port} HTTP/1.1\r\nHost: {hote}:{port}\r\n\r\n".encode())
        await w.drain()
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), CONNEXION_DELAI)
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as e:
        w.close()
        raise ErreurAmont(type(e).__name__) from e
    ligne = head.split(b"\r\n", 1)[0].decode("latin-1")
    parts = ligne.split(" ", 2)
    if len(parts) < 2 or not parts[0].startswith("HTTP/") or not parts[1].isdigit():
        w.close()
        raise ErreurAmont("réponse incompréhensible")
    if parts[1] == "503":  # « pas de service » : le relais de l'ordinateur n'est pas connecté (ordinateur éteint, app fermée). Une panne de la sortie.
        w.close()
        raise ErreurAmont(ligne)
    if parts[1] != "200":
        w.close()
        raise RefusAmont(ligne)
    return r, w


async def sonder(s: Sortie) -> tuple[bool, dict | None]:
    """La sortie répond-elle jusqu'à Internet ? Puis, si on en a besoin, quelle adresse les sites voient-ils ?"""
    try:
        r, w = await asyncio.wait_for(ouvrir_par(s, SITE_SONDE, SITE_PORT), SONDE_DELAI)
    except (ErreurAmont, RefusAmont, asyncio.TimeoutError):
        return False, None
    w.close()
    return True, None


async def lire_info(s: Sortie) -> dict | None:
    """L'adresse, la ville, la région, le pays et le fuseau que voient les sites, par ipinfo.io à travers cette sortie."""
    try:
        r, w = await asyncio.wait_for(ouvrir_par(s, SITE_INFO, SITE_PORT), SONDE_DELAI)
        await w.start_tls(ssl.create_default_context(), server_hostname=SITE_INFO)
        w.write(f"GET /json HTTP/1.0\r\nHost: {SITE_INFO}\r\nAccept: application/json\r\nUser-Agent: noah-sortie\r\n\r\n".encode())
        await w.drain()
        raw = await asyncio.wait_for(r.read(-1), SONDE_DELAI)  # HTTP/1.0 : la réponse finit à la fermeture
        w.close()
        body = raw.split(b"\r\n\r\n", 1)[1]
        data = json.loads(body)
        return {k: str(data.get(k) or "")[:80] for k in ("ip", "city", "region", "country", "timezone")}
    except (ErreurAmont, RefusAmont, asyncio.TimeoutError, OSError, ssl.SSLError, IndexError, ValueError):
        return None


INFO_ESSAI = 60.0  # une lecture ratée n'est pas refaite avant une minute


async def rafraichir_info(a: Aiguillage, s: Sortie) -> None:
    info = await lire_info(s)
    if info:
        s.info = info
    s.info_a = a.horloge()  # réussie ou non : la prochaine lecture attend


def info_due(a: Aiguillage, s: Sortie, etait_ok: bool) -> bool:
    age = a.horloge() - s.info_a
    return not etait_ok or age > (INFO_VALIDE if s.info else INFO_ESSAI)


async def tour(a: Aiguillage) -> None:
    """Une série de sondes, toutes en même temps. L'adresse vue des sites se lit à part, sans retarder les sondes."""
    async def une(nom: str) -> None:
        s = a.sorties[nom]
        etait_ok = s.etat == "ok"
        ok, _ = await sonder(s)
        a.sonde(nom, ok)
        if ok and info_due(a, s, etait_ok) and not s.lecture:
            s.lecture = asyncio.ensure_future(rafraichir_info(a, s))
            s.lecture.add_done_callback(lambda _f, s=s: setattr(s, "lecture", None))

    await asyncio.gather(*(une(n) for n in a.ordre))


async def boucle_sondes(a: Aiguillage) -> None:
    while True:
        await asyncio.sleep(SONDE)
        try:
            await tour(a)
        except Exception as e:  # noqa: BLE001 - une sonde ratée ne coupe pas l'aiguillage
            print(f"[sortie] sonde : {e}", flush=True)
        a.choisir()  # sans connexion non plus : la sortie affichée est celle qui servirait maintenant


async def relier(a_lire: asyncio.StreamReader, a_ecrire: asyncio.StreamWriter, a: Aiguillage, n: int) -> None:
    try:
        while data := await a_lire.read(65536):
            a_ecrire.write(data)
            await a_ecrire.drain()
            a.toucher(n)
    except (OSError, asyncio.CancelledError):
        pass
    finally:
        try:
            a_ecrire.close()
        except OSError:
            pass


def repondre(w: asyncio.StreamWriter, ligne: str) -> None:
    w.write(f"HTTP/1.1 {ligne}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode())


async def servir_client(a: Aiguillage, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    n = a.ouvrir()
    try:
        try:
            head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), CONNEXION_DELAI)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            return
        lignes = head.decode("latin-1").split("\r\n")
        try:
            methode, cible, version = lignes[0].split(" ", 2)
        except ValueError:
            repondre(w, "400 Bad Request")
            return
        if methode.upper() == "CONNECT":
            hote, _, port = cible.rpartition(":")
            hote = hote.strip("[]")
            reste = b""
        else:  # http://hote/chemin : repris en HTTP simple, une requête par connexion
            from urllib.parse import urlsplit
            u = urlsplit(cible)
            if u.scheme != "http" or not u.hostname:
                repondre(w, "400 Bad Request")
                return
            hote, port = u.hostname, str(u.port or 80)
            chemin = (u.path or "/") + (f"?{u.query}" if u.query else "")
            gardes = [l for l in lignes[1:] if l and l.split(":", 1)[0].lower() not in ("proxy-connection", "connection", "proxy-authorization")]
            reste = (f"{methode} {chemin} {version}\r\n" + "\r\n".join([*gardes, "Connection: close"]) + "\r\n\r\n").encode("latin-1")
        if not port.isdigit():
            repondre(w, "400 Bad Request")
            return
        port = int(port)
        refus = destination_interdite(hote, port)
        if refus:
            repondre(w, "403 Forbidden")
            return
        amont = None
        for _ in a.ordre:
            nom = a.choisir()
            try:
                amont = await ouvrir_par(a.sorties[nom], hote, port)
                break
            except ErreurAmont as e:
                print(f"[sortie] {nom} : connexion impossible ({e})", flush=True)
                a.echec_connexion(nom)
            except RefusAmont as e:
                repondre(w, "502 Bad Gateway")
                print(f"[sortie] {nom} : destination refusée ({getattr(e, 'ligne', e)})", flush=True)
                return
        if amont is None:
            repondre(w, "502 Bad Gateway")
            return
        ar, aw = amont
        if methode.upper() == "CONNECT":
            w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await w.drain()
        else:
            aw.write(reste)
        await asyncio.gather(relier(r, aw, a, n), relier(ar, w, a, n))
    finally:
        a.fermer(n)
        try:
            await w.drain()
        except (OSError, ConnectionError):
            pass
        w.close()


async def servir_etat(a: Aiguillage, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    try:
        await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
        a.choisir()
        body = json.dumps(a.etat()).encode()
        w.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%b" % (len(body), body))
        await w.drain()
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        pass
    finally:
        w.close()


def env_proxy_agent(hote: str, port: int, directs: list[str]) -> dict[str, str]:
    """Les variables qui mettent les outils d'un agent (curl, requests, httpx, aiohttp, Hermes) derrière cet aiguillage. Le lanceur
    les pose sur le conteneur de l'agent ; `directs` : les noms qui ne passent pas par lui (le serveur Noah, le navigateur de l'agent).
    Toujours directs : la boucle locale, le réseau Docker et le réseau local, que l'aiguillage refuserait de toute façon."""
    url = f"http://{hote}:{port}"
    direct = ",".join(["localhost", "127.0.0.1", "::1", hote, *directs, "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", ".local", ".internal"])
    return {**{k: url for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")}, "NO_PROXY": direct, "no_proxy": direct}


def depuis_environnement() -> Aiguillage:
    """NOAH_SORTIE_AMONT : [{"nom": "maison", "hote": "noah-server", "port": 3130}, …], dans l'ordre de préférence."""
    amont = [Sortie(str(s["nom"]), str(s["hote"]), int(s["port"])) for s in json.loads(os.environ.get("NOAH_SORTIE_AMONT", "[]"))]
    return Aiguillage(amont)


async def main() -> None:
    a = depuis_environnement()
    await tour(a)  # avant d'ouvrir : un navigateur qui arrive trop tôt est refusé, il n'est jamais envoyé en direct par défaut
    a.choisir()
    etat = await asyncio.start_server(lambda r, w: servir_etat(a, r, w), "127.0.0.1", ETAT_PORT)
    serveur = await asyncio.start_server(lambda r, w: servir_client(a, r, w), "0.0.0.0", PORT, limit=MAX_ENTETE)
    print(f"[sortie] prête sur le port {PORT} : {json.dumps([(s['nom'], s['etat']) for s in a.etat()['sorties']])}", flush=True)
    async with etat, serveur:
        await asyncio.gather(boucle_sondes(a), etat.serve_forever(), serveur.serve_forever())


if __name__ == "__main__":
    if "--etat" in sys.argv:
        conn = http.client.HTTPConnection("127.0.0.1", ETAT_PORT, timeout=5)
        conn.request("GET", "/")
        sys.stdout.write(conn.getresponse().read().decode())
    else:
        asyncio.run(main())
