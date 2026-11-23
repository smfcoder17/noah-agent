"""Le relais de sortie réseau côté serveur : « Mes agents sortent par cet ordinateur » (desktop/relais.js est l'autre bout).

L'app de bureau de la personne ouvre une connexion WebSocket sortante vers `/api/sortie/relais` (jeton de l'appareil relié, jamais le
mot de passe). Le serveur y fait passer, une par une, les connexions TCP que le navigateur d'un agent ouvre : l'aiguillage
(launcher/aiguillage.py) les envoie ici comme à n'importe quel mandataire amont (HTTP CONNECT, sur le réseau interne), et le serveur
les multiplexe sur la connexion de l'app : ouvrir (hôte, port), octets, fermer, avec contre-pression par crédit.

- Réservé au propriétaire, sur un appareil relié de type « desktop » ; un jeton faux ou d'un autre compte est refusé avant l'ouverture.
- Un seul relais actif : le dernier connecté remplace l'ancien (fermé avec le code 4000, que l'app lit comme « un autre ordinateur
  a pris la place » et ne s'acharne pas).
- Aucune destination n'est jugée ici : l'app du propriétaire refuse elle-même tout ce qui est privé (desktop/relais.js), et
  l'aiguillage, devant ce mandataire, refuse déjà les adresses privées et les noms internes.
- Rien du contenu des connexions n'est gardé ni journalisé.
- « Mes agents sortent par cet ordinateur » est un choix de la personne, gardé ici (`sortie:relais:voulu`) : sans lui, aucun
  conteneur de plus et aucun port ouvert. Éteindre l'ordinateur ne le défait pas (l'aiguillage bascule seul sur le serveur) ;
  seul l'interrupteur de l'app (DELETE /api/sortie/relais) le défait.
"""
import asyncio
import json
import os
import struct
import time

from fastapi import APIRouter, Depends, HTTPException, WebSocket

from . import access, auth, db

router = APIRouter()

PORT = int(os.environ.get("NOAH_RELAIS_PORT", "3130"))  # le mandataire que l'aiguillage joint, sur le réseau des agents
BIND = os.environ.get("NOAH_RELAIS_BIND", "0.0.0.0")
FENETRE = 256 * 1024  # octets qu'on peut envoyer à l'app sans accusé, par connexion
CREDIT_PAR = 64 * 1024
OUVERTURE_DELAI = float(os.environ.get("NOAH_RELAIS_OUVERTURE", "25"))
PING = 20.0
MAX_CONNEXIONS = 256  # le plafond de l'app (64) est plus bas : celui-ci protège le serveur d'un aiguillage fou
REMPLACE = 4000
VOULU = "sortie:relais:voulu"
ENTETE_MAX = 16 * 1024

_actif: "Relais | None" = None
_proxy = None  # le serveur du mandataire interne, démarré au premier relais
_pousse: set = set()


# --- Ce que la personne a choisi -------------------------------------------------------------------------------------------

def voulu() -> bool:
    try:
        return db.get_setting(VOULU) == "1"
    except Exception:  # noqa: BLE001
        return False


def _vouloir(oui: bool) -> bool:
    """Garde le choix ; vrai si cela le change."""
    if voulu() == oui:
        return False
    if oui:
        db.set_setting(VOULU, "1")
    else:
        with db.connect() as c:
            c.execute("DELETE FROM settings WHERE key = ?", (VOULU,))
    return True


def etat() -> dict:
    r = _actif
    return {"voulu": voulu(), "connecte": r is not None, "nom": r.nom if r else "", "depuis": r.depuis if r else None}


# --- Un relais connecté ------------------------------------------------------------------------------------------------------

class Conn:
    """Une connexion d'un navigateur, côté mandataire interne."""

    def __init__(self, ident: int, ecriture: asyncio.StreamWriter):
        self.id = ident
        self.ecriture = ecriture
        self.reponse: asyncio.Future = asyncio.get_running_loop().create_future()  # ("ok",) | ("refus", raison) | ("erreur", raison)
        self.credit = FENETRE  # ce que le serveur peut encore envoyer à l'app
        self.credit_libre = asyncio.Event()
        self.credit_libre.set()
        self.arrivee: asyncio.Queue = asyncio.Queue()  # octets venus de l'app, vers le navigateur
        self.ferme = False


class Relais:
    def __init__(self, websocket: WebSocket, nom: str):
        self.ws = websocket
        self.nom = nom
        self.depuis = time.time()
        self.conns: dict[int, Conn] = {}
        self._n = 0
        self._envoi = asyncio.Lock()
        self.mort = False

    async def envoyer(self, donnees: bytes | dict) -> bool:
        if self.mort:
            return False
        try:
            async with self._envoi:
                if isinstance(donnees, dict):
                    await self.ws.send_text(json.dumps(donnees, ensure_ascii=False))
                else:
                    await self.ws.send_bytes(donnees)
            return True
        except Exception:  # noqa: BLE001 - la ligne est tombée : la boucle de réception le dira
            return False

    def nouvelle(self, ecriture: asyncio.StreamWriter) -> Conn | None:
        if self.mort or len(self.conns) >= MAX_CONNEXIONS:
            return None
        self._n = (self._n + 1) & 0xFFFFFFFF or 1
        c = Conn(self._n, ecriture)
        self.conns[c.id] = c
        return c

    def fin(self, c: Conn) -> None:
        self.conns.pop(c.id, None)
        c.ferme = True
        c.credit_libre.set()
        c.arrivee.put_nowait(None)
        if not c.reponse.done():
            c.reponse.set_result(("erreur", "relais coupé"))

    async def mourir(self, code: int = 1000) -> None:
        if self.mort:
            return
        self.mort = True
        for c in list(self.conns.values()):
            self.fin(c)
        try:
            await self.ws.close(code=code)
        except Exception:  # noqa: BLE001
            pass

    # Ce que dit l'app ------------------------------------------------------------------------------------------------------
    def recu(self, o: dict) -> None:
        t = o.get("t")
        c = self.conns.get(o.get("id")) if isinstance(o.get("id"), int) else None
        if t == "bonjour":
            nom = "".join(ch for ch in str(o.get("nom") or "") if ch.isprintable())[:80].strip()
            if nom:
                self.nom = nom
        elif c is None:
            return
        elif t in ("ok", "refus", "erreur") and not c.reponse.done():
            c.reponse.set_result((t, str(o.get("raison") or "")[:120]))
            if t != "ok":
                c.ferme = True  # l'app a déjà libéré cette connexion : inutile de lui dire de la fermer
        elif t == "credit" and isinstance(o.get("n"), int) and o["n"] > 0:
            c.credit = min(c.credit + o["n"], FENETRE)
            c.credit_libre.set()
        elif t == "close":
            self.fin(c)

    def donnees(self, brut: bytes) -> None:
        if len(brut) <= 4:
            return
        c = self.conns.get(struct.unpack(">I", brut[:4])[0])
        if c and not c.ferme and c.reponse.done():
            c.arrivee.put_nowait(brut[4:])  # borné par la fenêtre : l'app n'envoie rien sans crédit


# --- Le mandataire interne (HTTP CONNECT), que l'aiguillage joint ---------------------------------------------------------------

def _repondre(w: asyncio.StreamWriter, ligne: str) -> None:
    w.write(f"HTTP/1.1 {ligne}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode())


async def _vers_navigateur(r: Relais, c: Conn) -> None:
    """Ce que l'app envoie : écrit chez le navigateur, puis rend du crédit une fois les octets partis."""
    rendu = 0
    try:
        while (data := await c.arrivee.get()) is not None:
            c.ecriture.write(data)
            await c.ecriture.drain()
            rendu += len(data)
            if rendu >= CREDIT_PAR:
                await r.envoyer({"t": "credit", "id": c.id, "n": rendu})
                rendu = 0
    except (OSError, ConnectionError):
        pass
    finally:
        try:
            c.ecriture.close()
        except OSError:
            pass


async def _vers_app(r: Relais, c: Conn, lecture: asyncio.StreamReader) -> None:
    """Ce que le navigateur envoie : n'avance que tant que l'app a donné du crédit."""
    try:
        while not c.ferme:
            while c.credit <= 0 and not c.ferme:
                c.credit_libre.clear()
                await c.credit_libre.wait()
            data = await lecture.read(min(65536, max(c.credit, 1)))
            if not data:
                break
            c.credit -= len(data)
            if not await r.envoyer(struct.pack(">I", c.id) + data):
                break
    except (OSError, ConnectionError):
        pass
    if not c.ferme:
        c.ferme = True  # prévenu une fois : servir() ne le redit pas
        await r.envoyer({"t": "close", "id": c.id})


async def servir(lecture: asyncio.StreamReader, ecriture: asyncio.StreamWriter) -> None:
    c = None
    r = _actif
    try:
        try:
            tete = await asyncio.wait_for(lecture.readuntil(b"\r\n\r\n"), 15)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            return
        try:
            methode, cible, _ = tete.decode("latin-1").split("\r\n", 1)[0].split(" ", 2)
            hote, _, port = cible.rpartition(":")
            hote, port = hote.strip("[]"), int(port)
        except ValueError:
            return _repondre(ecriture, "400 Bad Request")
        if methode.upper() != "CONNECT" or not hote or not 0 < port < 65536:
            return _repondre(ecriture, "400 Bad Request")
        if r is None or r.mort or (c := r.nouvelle(ecriture)) is None:
            return _repondre(ecriture, "503 Service Unavailable")  # l'aiguillage en conclut que cette sortie ne répond plus
        if not await r.envoyer({"t": "open", "id": c.id, "hote": hote, "port": port}):
            return _repondre(ecriture, "503 Service Unavailable")
        try:
            reponse = await asyncio.wait_for(asyncio.shield(c.reponse), OUVERTURE_DELAI)
        except asyncio.TimeoutError:
            await r.envoyer({"t": "close", "id": c.id})
            return _repondre(ecriture, "504 Gateway Timeout")
        if reponse[0] == "ok":
            ecriture.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await ecriture.drain()
            # Tout s'arrête dès qu'un des deux sens finit : le navigateur a fermé (l'app en est prévenue, plus bas), ou l'app a fermé.
            taches = [asyncio.ensure_future(_vers_app(r, c, lecture)), asyncio.ensure_future(_vers_navigateur(r, c))]
            try:
                await asyncio.wait(taches, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for t in taches:
                    t.cancel()
        elif reponse[1] == "relais coupé":
            return _repondre(ecriture, "503 Service Unavailable")
        elif reponse[0] == "refus":
            return _repondre(ecriture, "403 Forbidden")  # l'app a refusé cette destination
        else:
            return _repondre(ecriture, "502 Bad Gateway")  # le site ne répond pas
    finally:
        if c is not None:
            if not c.ferme and r is not None:
                await r.envoyer({"t": "close", "id": c.id})
            if r is not None:
                r.fin(c)
        try:
            await ecriture.drain()
        except (OSError, ConnectionError):
            pass
        ecriture.close()


async def assurer_mandataire() -> None:
    """Le mandataire n'existe que si un relais a été voulu : sans relais, aucun port de plus."""
    global _proxy
    if _proxy is not None:
        return
    try:
        _proxy = await asyncio.start_server(servir, BIND, PORT, limit=ENTETE_MAX)
    except OSError as e:
        print(f"[sortie] mandataire du relais : {e}", flush=True)


async def demarrer() -> None:
    """Au démarrage du serveur : si la personne a voulu le relais, il attend déjà son ordinateur."""
    if voulu():
        await assurer_mandataire()


# --- La connexion de l'app -------------------------------------------------------------------------------------------------

def _page_etrangere(ws: WebSocket) -> bool:
    """Comme main._foreign_page : une page web d'un autre hôte n'agit pas avec la session. L'app de bureau envoie un en-tête."""
    h = ws.headers
    if auth.COOKIE not in ws.cookies or "authorization" in h:
        return False
    source = h.get("origin") or h.get("referer") or ""
    return not source or source.split("://", 1)[-1].split("/", 1)[0] != h.get("host", "")


def _appareil(token: str | None) -> tuple[str, str] | None:
    """(type, nom) de l'appareil de ce jeton, ou None s'il n'est plus relié."""
    with db.connect() as c:
        row = c.execute("SELECT platform, device FROM sessions WHERE token = ?", (auth.session_key(token),)).fetchone()
    return (row["platform"], row["device"] or "") if row else None


async def _pousser() -> None:
    """Dit au lanceur d'ajouter (ou de retirer) la maison à l'aiguillage. Jamais bloquant pour la connexion de l'app."""
    from . import sortie
    try:
        await sortie.push()
    except HTTPException as e:
        print(f"[sortie] relais : le lanceur n'a pas suivi ({e.detail})", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[sortie] relais : {type(e).__name__}", flush=True)


def _lancer(coro) -> None:
    t = asyncio.ensure_future(coro)
    _pousse.add(t)
    t.add_done_callback(_pousse.discard)


@router.websocket("/api/sortie/relais")
async def relais_ws(websocket: WebSocket):
    global _actif
    if _page_etrangere(websocket):
        await websocket.close(code=4403)
        return
    token = auth.request_token(websocket, websocket.cookies.get(auth.COOKIE))
    try:
        user = auth.current_user(websocket, websocket.cookies.get(auth.COOKIE))
    except HTTPException:
        await websocket.close(code=4401)
        return
    appareil = _appareil(token)
    if not access.is_owner(user) or appareil is None or appareil[0] != "desktop":
        await websocket.close(code=4403)  # le propriétaire, depuis son app de bureau reliée : personne d'autre
        return
    await websocket.accept()
    r = Relais(websocket, appareil[1])
    ancien, _actif = _actif, r
    if ancien is not None:
        await ancien.mourir(REMPLACE)
    await assurer_mandataire()
    if _vouloir(True):
        _lancer(_pousser())
    print(f"[sortie] relais : ouvert ({r.nom})", flush=True)

    async def surveiller():  # appareil révoqué : la ligne se ferme dans les secondes qui suivent ; ping pour les lignes mortes
        while not r.mort:
            await asyncio.sleep(auth.REVOKE_EVERY)
            if not await asyncio.to_thread(auth.still_valid, token or "") or not await asyncio.to_thread(access.is_owner, user):
                return await r.mourir(4401)

    async def battre():
        while not r.mort:
            await asyncio.sleep(PING)
            await r.envoyer({"t": "ping"})

    taches = [asyncio.create_task(surveiller()), asyncio.create_task(battre())]
    try:
        while not r.mort:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                r.donnees(msg["bytes"])
            elif msg.get("text"):
                try:
                    o = json.loads(msg["text"])
                except ValueError:
                    continue
                if isinstance(o, dict):
                    r.recu(o)
    except Exception:  # noqa: BLE001 - la ligne est tombée
        pass
    finally:
        for t in taches:
            t.cancel()
        await r.mourir()
        if _actif is r:
            _actif = None
        print("[sortie] relais : fermé", flush=True)


@router.delete("/api/sortie/relais")
async def relais_arreter(user: int = Depends(access.owner_only)):
    """L'interrupteur de l'app est éteint : l'ordinateur ne sert plus de sortie. L'aiguillage perd sa voie « maison »."""
    r = _actif
    if r is not None:
        await r.mourir(1000)
    if _vouloir(False):
        _lancer(_pousser())
    return etat()
