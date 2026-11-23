"""Le relais de sortie réseau côté serveur (server/noah/sortie_relais.py) : la route WebSocket que l'app de bureau ouvre, et le
mandataire interne que l'aiguillage joint.

Vrais : la route, l'authentification par jeton d'appareil, le mandataire HTTP CONNECT (une vraie prise TCP), le multiplexage et la
contre-pression. Simulé : l'app de bureau (le test parle sur le WebSocket à sa place) et le lanceur.
Garde à l'œil : réservé au propriétaire sur un appareil de bureau relié ; jeton faux refusé ; un seul relais actif ; aucun secret
dans une réponse, un message ou un journal ; sans relais, l'aiguillage reçoit « 503 » et bascule.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/sortie/relais_serveur_test.py"
"""
import json
import os
import socket
import struct
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ["NOAH_RELAIS_PORT"] = "31301"
os.environ["NOAH_RELAIS_BIND"] = "127.0.0.1"
os.environ["NOAH_RELAIS_OUVERTURE"] = "2"
sys.path.insert(0, "/app")

import logging  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from noah import auth, db, hermes, sortie, sortie_relais  # noqa: E402

LOGS: list[str] = []


class Capture(logging.Handler):
    def emit(self, record):
        LOGS.append(record.getMessage())


logging.getLogger().addHandler(Capture())
db.init()
OWNER = auth.create_user("franck", "motdepasse-a")
GUEST = auth.create_user("invite", "motdepasse-b")
TOKENS = {
    "pc": auth.new_session(OWNER, "Noah Agent sur PC-DE-FRANCK", "desktop"),
    "pc2": auth.new_session(OWNER, "Noah Agent sur PORTABLE", "desktop"),
    "web": auth.new_session(OWNER, "Chrome", "web"),
    "telephone": auth.new_session(OWNER, "Pixel", "android"),
    "invite": auth.new_session(GUEST, "Noah Agent sur PC-INVITE", "desktop"),
}
CALLS: list[tuple] = []


async def fake_launcher(method, path, **kw):
    CALLS.append((method, path, kw.get("json")))
    return {"conteneurs": {}, "aiguillage": None}


hermes._launcher = fake_launcher
sortie.hermes = hermes

app = FastAPI()
app.include_router(sortie_relais.router)
app.include_router(sortie.router)
PORT = sortie_relais.PORT


def ok(name):
    print(f"ok  {name}")


def entetes(token):
    return {"Authorization": f"Bearer {token}"}


def refuse(c, url, token=None, **kw):
    try:
        with c.websocket_connect(url, headers=entetes(token) if token else {}, **kw):
            pass
    except WebSocketDisconnect as e:
        return e.code
    except Exception as e:  # noqa: BLE001 - une poignée de main refusée en HTTP (403) selon la version de Starlette
        return getattr(e, "status_code", None) or type(e).__name__
    return None


def attendre(cond, quoi, delai=8.0):
    fin = time.time() + delai
    while time.time() < fin:
        if cond():
            return
        time.sleep(0.02)
    raise AssertionError(f"attendu : {quoi}")


def prise(hote="127.0.0.1"):
    s = socket.create_connection((hote, PORT), timeout=5)
    s.settimeout(5)
    return s


def connect_tete(s, cible):
    s.sendall(f"CONNECT {cible} HTTP/1.1\r\nHost: {cible}\r\n\r\n".encode())


def prochain_open(ws):
    """Le prochain ordre d'ouverture : les « close » d'une connexion déjà finie ne comptent pas."""
    while True:
        o = ws.receive_json()
        if o["t"] == "open":
            return o


def lire_tete(s):
    tete = b""
    while b"\r\n\r\n" not in tete:
        morceau = s.recv(4096)
        if not morceau:
            break
        tete += morceau
    return tete.split(b"\r\n", 1)[0].decode()


with TestClient(app) as c:
    # 1. Sans relais : le mandataire n'existe pas, l'aiguillage verrait une connexion refusée ----------------------------------
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=1)
        raise AssertionError("un port est ouvert sans relais voulu")
    except OSError:
        pass
    assert not sortie_relais.voulu() and not CALLS
    ok("sans relais voulu : aucun port ouvert, aucun appel au lanceur")

    # 2. Qui peut ouvrir la route -----------------------------------------------------------------------------------------------
    assert refuse(c, "/api/sortie/relais") is not None, "sans jeton"
    assert refuse(c, "/api/sortie/relais", "jeton-faux-0000000000000000000000000000000000") is not None, "jeton faux"
    assert refuse(c, "/api/sortie/relais", TOKENS["invite"]) is not None, "un invité, même sur un appareil de bureau"
    assert refuse(c, "/api/sortie/relais", TOKENS["web"]) is not None, "le propriétaire depuis un navigateur : pas un appareil de bureau"
    assert refuse(c, "/api/sortie/relais", TOKENS["telephone"]) is not None, "le propriétaire depuis un téléphone"
    # Une page web d'un autre site qui porte le cookie : refusée aussi (cookie sans en-tête d'autorisation, Origin étranger).
    assert refuse(c, "/api/sortie/relais", None, headers={"Cookie": f"{auth.COOKIE}={TOKENS['pc']}", "Origin": "https://evil.example"}) is not None
    assert not sortie_relais.voulu() and sortie_relais._actif is None and not CALLS, "aucun refus n'allume quoi que ce soit"
    ok("route : jeton absent ou faux, invité, navigateur, téléphone et page étrangère refusés ; rien n'est allumé")

    # 3. Le propriétaire, depuis son app de bureau reliée -----------------------------------------------------------------------
    with c.websocket_connect("/api/sortie/relais", headers=entetes(TOKENS["pc"])) as ws:
        ws.send_json({"t": "bonjour", "nom": "PC-DE-FRANCK"})
        attendre(lambda: sortie_relais.etat()["connecte"] and sortie_relais.etat()["nom"] == "PC-DE-FRANCK", "relais connecté")
        etat = sortie_relais.etat()
        assert etat["voulu"] is True
        attendre(lambda: [x for x in CALLS if x[0] == "PUT"], "le lanceur reçoit la maison")
        assert [x for x in CALLS if x[0] == "PUT"][0][2] == {"maison": {"actif": True}, "vpn": None}, CALLS
        ok("l'app de bureau du propriétaire est acceptée ; le relais est voulu ; le lanceur ajoute la maison sans aucun secret")

        # 4. Une connexion du navigateur passe par le relais, dans les deux sens -----------------------------------------------
        s = prise()
        connect_tete(s, "exemple.com:443")
        ordre = prochain_open(ws)
        assert ordre["t"] == "open" and ordre["hote"] == "exemple.com" and ordre["port"] == 443, ordre
        ident = ordre["id"]
        ws.send_json({"t": "ok", "id": ident})
        assert lire_tete(s) == "HTTP/1.1 200 Connection established"
        s.sendall(b"GET / HTTP/1.1\r\n\r\n")
        paquet = ws.receive_bytes()
        assert struct.unpack(">I", paquet[:4])[0] == ident and paquet[4:] == b"GET / HTTP/1.1\r\n\r\n"
        ws.send_bytes(struct.pack(">I", ident) + b"HTTP/1.1 200 OK\r\n\r\nbonjour")
        assert s.recv(4096) == b"HTTP/1.1 200 OK\r\n\r\nbonjour"
        ok("CONNECT : ouvrir, octets du navigateur vers l'app, octets de l'app vers le navigateur")

        # 5. Fermeture des deux côtés ---------------------------------------------------------------------------------------------
        ws.send_json({"t": "close", "id": ident})
        attendre(lambda: s.recv(4096) == b"", "le navigateur voit la fermeture")
        s.close()
        s = prise()
        connect_tete(s, "exemple.com:80")
        ident = prochain_open(ws)["id"]
        ws.send_json({"t": "ok", "id": ident})
        lire_tete(s)
        s.close()
        attendre(lambda: ws.receive_json() == {"t": "close", "id": ident}, "le navigateur ferme : l'app est prévenue")
        ok("fermeture : de l'app vers le navigateur, et du navigateur vers l'app")

        # 6. Refus et erreurs de l'app ---------------------------------------------------------------------------------------------
        for reponse, attendu in [({"t": "refus", "raison": "adresse privée"}, "403"), ({"t": "erreur", "raison": "connexion impossible"}, "502")]:
            s = prise()
            connect_tete(s, "10.0.0.1:443")
            ident = prochain_open(ws)["id"]
            ws.send_json({**reponse, "id": ident})
            tete = lire_tete(s)
            assert tete.split(" ")[1] == attendu, (reponse, tete)
            s.close()
        s = prise()
        connect_tete(s, "lent.exemple.com:443")
        ident = prochain_open(ws)["id"]
        assert lire_tete(s).split(" ")[1] == "504", "l'app ne répond pas à temps"
        assert ws.receive_json() == {"t": "close", "id": ident}
        s.close()
        s = prise()
        s.sendall(b"GET http://exemple.com/ HTTP/1.1\r\n\r\n")
        assert lire_tete(s).split(" ")[1] == "400", "seul CONNECT est servi"
        s.close()
        ok("refus de l'app → 403, erreur → 502, silence → 504, autre chose que CONNECT → 400")

        # 7. Contre-pression : le serveur n'envoie pas plus que la fenêtre sans crédit ----------------------------------------------
        s = prise()
        connect_tete(s, "gros.exemple.com:443")
        ident = prochain_open(ws)["id"]
        ws.send_json({"t": "ok", "id": ident})
        lire_tete(s)
        total = sortie_relais.FENETRE * 3
        envoye = 0
        s.settimeout(0.2)
        try:
            while envoye < total:
                envoye += s.send(b"x" * 65536)
        except (socket.timeout, BlockingIOError):
            pass
        recu = 0
        ws_paquets = 0
        # On lit ce que le serveur a transmis à l'app : jamais plus que la fenêtre tant qu'aucun crédit n'est rendu.
        fin = time.time() + 1.5
        import threading
        lus: list[bytes] = []
        stop = threading.Event()

        def lire():
            while not stop.is_set():
                try:
                    m = ws.receive_bytes()
                except Exception:  # noqa: BLE001
                    return
                lus.append(m)

        t = threading.Thread(target=lire, daemon=True)
        t.start()
        time.sleep(1.5)
        recu = sum(len(m) - 4 for m in lus)
        assert recu <= sortie_relais.FENETRE, f"{recu} octets partis sans crédit (fenêtre {sortie_relais.FENETRE})"
        assert recu >= sortie_relais.FENETRE // 2, f"la fenêtre n'a pas été utilisée : {recu}"
        ws.send_json({"t": "credit", "id": ident, "n": 128 * 1024})
        time.sleep(1.0)
        recu2 = sum(len(m) - 4 for m in lus)
        assert recu < recu2 <= recu + 128 * 1024 + 65536, (recu, recu2)
        stop.set()
        s.close()
        ok("contre-pression : au plus la fenêtre sans crédit, puis seulement ce que l'app autorise")

    # La lecture en tâche de fond a pu consommer la fermeture : on rouvre une session propre pour la suite.
    attendre(lambda: sortie_relais._actif is None, "le relais est fermé avec la connexion")
    ok("fermer la connexion de l'app libère le relais (voulu reste voulu : l'ordinateur éteint ne défait rien)")
    assert sortie_relais.etat() == {"voulu": True, "connecte": False, "nom": "", "depuis": None}

    # 8. Sans relais connecté (ordinateur éteint) : 503, ce que l'aiguillage lit comme « cette sortie est tombée » -----------------
    s = prise()
    connect_tete(s, "exemple.com:443")
    assert lire_tete(s).split(" ")[1] == "503"
    s.close()
    ok("ordinateur éteint : le mandataire répond 503, l'aiguillage bascule")

    # 9. Un seul relais : le dernier connecté remplace l'ancien --------------------------------------------------------------------
    with c.websocket_connect("/api/sortie/relais", headers=entetes(TOKENS["pc"])) as premier:
        attendre(lambda: sortie_relais._actif is not None, "premier relais")
        first = sortie_relais._actif
        with c.websocket_connect("/api/sortie/relais", headers=entetes(TOKENS["pc2"])) as second:
            second.send_json({"t": "bonjour", "nom": "PORTABLE"})
            attendre(lambda: sortie_relais._actif is not first and sortie_relais.etat()["nom"] == "PORTABLE", "le second remplace le premier")
            try:
                premier.receive_json()
                raise AssertionError("l'ancien relais n'a pas été fermé")
            except WebSocketDisconnect as e:
                assert e.code == sortie_relais.REMPLACE == 4000, e.code
            s = prise()
            connect_tete(s, "exemple.com:443")
            ordre = prochain_open(second)
            assert ordre["t"] == "open", "les connexions vont au nouveau relais"
            second.send_json({"t": "refus", "id": ordre["id"], "raison": "adresse privée"})
            lire_tete(s)
            s.close()
    attendre(lambda: sortie_relais._actif is None, "plus de relais")
    ok("un seul relais actif : le dernier connecté remplace l'ancien (fermé avec 4000), les connexions suivent le nouveau")

    # 10. Une session révoquée coupe la ligne -----------------------------------------------------------------------------------------
    with c.websocket_connect("/api/sortie/relais", headers=entetes(TOKENS["pc"])) as ws:
        attendre(lambda: sortie_relais._actif is not None, "relais")
        with db.connect() as d:
            d.execute("DELETE FROM sessions WHERE token = ?", (auth.digest(TOKENS["pc"]),))
        try:
            ws.receive_json()
            raise AssertionError("la ligne d'un appareil révoqué reste ouverte")
        except WebSocketDisconnect as e:
            assert e.code == 4401, e.code
    TOKENS["pc"] = auth.new_session(OWNER, "Noah Agent sur PC-DE-FRANCK", "desktop")
    ok("appareil révoqué : la ligne se ferme dans les secondes qui suivent")

    # 11. L'interrupteur éteint : le propriétaire seul, le relais se ferme, la maison quitte l'aiguillage --------------------------------
    owner = TestClient(app, headers=entetes(TOKENS["pc2"]))
    guest = TestClient(app, headers=entetes(TOKENS["invite"]))
    with c.websocket_connect("/api/sortie/relais", headers=entetes(TOKENS["pc2"])) as ws:
        attendre(lambda: sortie_relais._actif is not None, "relais")
        assert guest.delete("/api/sortie/relais").status_code == 403
        assert TestClient(app).delete("/api/sortie/relais").status_code == 401
        assert sortie_relais.voulu(), "un refus n'éteint rien"
        del CALLS[:]
        r = owner.delete("/api/sortie/relais")
        assert r.status_code == 200 and r.json()["voulu"] is False, r.text
        try:
            ws.receive_json()
            raise AssertionError("le relais est resté ouvert")
        except WebSocketDisconnect as e:
            assert e.code == 1000, e.code
    attendre(lambda: any(x[0] == "PUT" for x in CALLS), "le lanceur retire la maison")
    assert [x for x in CALLS if x[0] == "PUT"][-1][2] == {"maison": None, "vpn": None}, CALLS
    assert not sortie_relais.voulu()
    ok("interrupteur éteint : réservé au propriétaire, relais fermé, le lanceur retire la maison")

    # 12. Aucun secret nulle part --------------------------------------------------------------------------------------------------------
    for nom, jeton in TOKENS.items():
        assert jeton not in "\n".join(LOGS), f"le jeton {nom} est dans un journal"
    resume = TestClient(app, headers=entetes(TOKENS["pc2"])).get("/api/sortie")
    assert resume.status_code == 200 and not any(j in resume.text for j in TOKENS.values()), "un jeton revient dans le résumé"
    assert not any(j in json.dumps(CALLS) for j in TOKENS.values()), "un jeton est allé au lanceur"
    ok("aucun jeton dans les journaux, le résumé ni les appels au lanceur")

print("OK : relais de sortie réseau, serveur")
