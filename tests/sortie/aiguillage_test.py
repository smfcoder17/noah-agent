"""Sortie réseau (lot sortie-reseau) : l'aiguillage des navigateurs, sans Docker.

    docker run --rm -v "$PWD/launcher:/launcher:ro" -v "$PWD/tests:/tests:ro" python:3.12-slim sh -c \
      "pip install -q cryptography && python /tests/sortie/aiguillage_test.py"

Partie 1 : la logique du choix, avec une horloge à la main (ordre de préférence, bascule immédiate, retour différé, repli).
Partie 2 : le vrai mandataire, avec deux faux amonts « maison » et « VPN » qu'on coupe et qu'on rallume, et un faux site.
Partie 3 : l'adresse vue des sites, lue par TLS à travers une sortie ; les destinations privées refusées.
"""
import asyncio
import datetime
import json
import os
import ssl
import sys
import tempfile

os.environ.update(NOAH_SORTIE_PRIVE_OK="1", NOAH_SORTIE_SONDE="0.2", NOAH_SORTIE_SONDE_DELAI="2", NOAH_SORTIE_INACTIVITE="1.5",
                  NOAH_SORTIE_SITE="site.essai.test", NOAH_SORTIE_SITE_INFO="info.essai.test", NOAH_SORTIE_SEUIL="2")
sys.path.insert(0, "/launcher")
import aiguillage as A  # noqa: E402


# --- 1. La logique du choix ---------------------------------------------------------------------------------------

class Horloge:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def neuf(inactivite=300.0, noms=("maison", "vpn")):
    h = Horloge()
    a = A.Aiguillage([A.Sortie(n, n, 1) for n in noms], inactivite=inactivite, seuil=2, horloge=h, murale=h)
    return a, h


def tout_ok(a):
    for n in a.ordre:
        a.sonde(n, True)


a, h = neuf()
tout_ok(a)
assert a.choisir() == "maison", "toutes répondent : la maison d'abord"
a.sonde("maison", False)
assert a.choisir() == "maison", "une seule sonde ratée ne suffit pas (seuil de 2) : pas de bascule pour un hoquet"
a.sonde("maison", False)
assert a.choisir() == "vpn", "la maison ne répond plus : le VPN, tout de suite, sans attendre aucun délai"
a.sonde("vpn", False)
a.sonde("vpn", False)
assert a.choisir() == "direct", "plus aucune sortie : repli direct"
print("1a. ordre de préférence maison > VPN > direct, bascule immédiate vers le bas")

a, h = neuf()
tout_ok(a)
a.choisir()
a.echec_connexion("maison")  # une vraie connexion a échoué : pas besoin d'une deuxième sonde
assert a.choisir() == "vpn" and not a.saine("maison")
print("1b. une connexion qui échoue fait basculer tout de suite")

# Le retour vers une meilleure sortie : seulement après le délai sans connexion qui bouge.
a, h = neuf(inactivite=300)
tout_ok(a)
a.choisir()
a.echec_connexion("maison")
assert a.choisir() == "vpn"
n = a.ouvrir()  # une session est en cours
a.sonde("maison", True)
assert a.choisir() == "vpn", "la maison revient mais une connexion est ouverte : on reste sur le VPN"
h.t += 299
a.toucher(n)
h.t += 299
assert a.choisir() == "vpn", "un octet est passé il y a 299 s : la session n'est pas finie"
a.fermer(n)
h.t += 299
assert a.choisir() == "vpn", "299 s depuis la fermeture : encore trop tôt"
h.t += 2
assert a.choisir() == "maison", "plus de 300 s sans connexion : retour à la maison"
assert [b["vers"] for b in a.bascules] == ["maison", "vpn", "maison"], a.bascules
print("1c. retour vers une meilleure sortie seulement après le délai d'inactivité, jamais en pleine session")

# Un tunnel ouvert mais muet depuis plus que le délai n'est plus une session.
a, h = neuf(inactivite=300)
tout_ok(a)
a.choisir()
a.echec_connexion("maison")
a.choisir()
a.ouvrir()
a.sonde("maison", True)
h.t += 301
assert a.choisir() == "maison", "une connexion muette depuis 301 s ne retient plus le retour"
print("1d. un tunnel gardé ouvert sans un octet ne bloque pas le retour")

# Tant qu'une sortie répond, jamais de direct ; la sortie courante est gardée.
a, h = neuf(inactivite=60)
tout_ok(a)
seen = set()
import random  # noqa: E402

random.seed(7)
for _ in range(3000):
    h.t += random.choice([0.1, 5, 70])
    n = random.choice(a.ordre[:-1])
    (a.sonde if random.random() < .5 else lambda *x: None)(n, random.random() < .6)
    if random.random() < .3:
        a.echec_connexion(random.choice(a.ordre[:-1]))
    if random.random() < .5:
        a.ouvrir()
    sain = [x for x in a.ordre[:-1] if a.saine(x)]
    avant = a.courante
    choisie = a.choisir()
    if sain and choisie == "direct":
        # Seul cas permis : le direct servait déjà (tout était tombé) et une session bouge ; il ne se choisit jamais de lui-même.
        assert avant == "direct" and not a.inactif(), f"fuite directe alors que {sain} répond : {a.etat()}"
    elif sain:
        assert choisie in sain, "la sortie choisie est toujours une sortie saine"
    else:
        assert choisie == "direct"
    seen.add(choisie)
assert seen == {"maison", "vpn", "direct"}, f"le hasard n'a pas exercé tous les cas : {seen}"
print("1e. 3000 événements au hasard : le direct ne se choisit jamais tant qu'une sortie répond (il ne se garde que pendant une session commencée en repli)")

# Une seule sortie configurée (VPN seul), et aucune (le direct seul, mais l'aiguillage n'est alors pas lancé).
a, h = neuf(noms=("vpn",))
a.sonde("vpn", True)
assert a.choisir() == "vpn"
a.echec_connexion("vpn")
assert a.choisir() == "direct"
print("1f. un VPN seul retombe sur le direct")

# --- 2. Le vrai mandataire ---------------------------------------------------------------------------------------

async def faux_site(compte: dict):
    async def un(r, w):
        try:
            await r.readuntil(b"\r\n\r\n")
        except asyncio.IncompleteReadError:  # une sonde qui se contente de se connecter
            w.close()
            return
        compte["site"] = compte.get("site", 0) + 1
        w.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        await w.drain()
        w.close()
    return await asyncio.start_server(un, "127.0.0.1", 0)


class Amont:
    """Un faux mandataire amont (maison, VPN) : CONNECT vers le faux site, avec un compteur du trafic d'un navigateur (pas des sondes). On le coupe et on le rallume."""

    def __init__(self, nom, site_port, compte):
        self.nom, self.site_port, self.compte, self.server, self.port = nom, site_port, compte, None, 0
        self.ouvertes: set = set()

    async def demarrer(self):
        async def un(r, w):
            try:
                head = await r.readuntil(b"\r\n\r\n")
            except asyncio.IncompleteReadError:
                return
            if b"www.exemple.test" in head:  # le trafic d'un navigateur ; les sondes visent d'autres noms
                self.compte[self.nom] = self.compte.get(self.nom, 0) + 1
            ar, aw = await asyncio.open_connection("127.0.0.1", self.site_port)  # tous les noms mènent au faux site
            self.ouvertes |= {w, aw}
            w.write(b"HTTP/1.1 200 OK\r\n\r\n")
            await w.drain()
            await asyncio.gather(A.relier(r, aw, B, 0), A.relier(ar, w, B, 0))
            self.ouvertes -= {w, aw}
        self.server = await asyncio.start_server(un, "127.0.0.1", self.port)
        self.port = self.server.sockets[0].getsockname()[1]

    async def couper(self):
        self.server.close()
        for w in list(self.ouvertes):  # un PC qu'on éteint coupe aussi ce qui était en cours
            w.close()


B = A.Aiguillage([])  # relier() demande un aiguillage pour compter les octets : un autre, sans effet ici


async def via(proxy_port, hote="www.exemple.test", port=80):
    """Un client : CONNECT puis une requête HTTP dans le tunnel. Rend le code reçu du mandataire, puis le corps."""
    r, w = await asyncio.open_connection("127.0.0.1", proxy_port)
    w.write(f"CONNECT {hote}:{port} HTTP/1.1\r\nHost: {hote}:{port}\r\n\r\n".encode())
    head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
    code = int(head.split(b" ")[1])
    body = b""
    if code == 200:
        w.write(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        body = (await asyncio.wait_for(r.read(-1), 5)).split(b"\r\n\r\n")[-1]
    w.close()
    return code, body


async def partie2():
    compte: dict = {}
    site = await faux_site(compte)
    site_port = site.sockets[0].getsockname()[1]
    A.SITE_PORT = site_port  # les sondes (et celle du direct) visent le faux site
    maison, vpn = Amont("maison", site_port, compte), Amont("vpn", site_port, compte)
    await maison.demarrer()
    await vpn.demarrer()
    # Le « direct » du mandataire résout les noms : le faux site est sur 127.0.0.1, on nomme les deux noms de sonde sur lui.
    loop = asyncio.get_running_loop()
    vrai = loop.getaddrinfo

    async def getaddrinfo(host, port, **k):
        return await vrai("127.0.0.1", site_port, **k)
    loop.getaddrinfo = getaddrinfo  # noqa: B010 - banc d'essai : tout nom mène au faux site

    a = A.Aiguillage([A.Sortie("maison", "127.0.0.1", maison.port), A.Sortie("vpn", "127.0.0.1", vpn.port)], inactivite=1.5, seuil=2)
    await A.tour(a)
    assert a.choisir() == "maison"
    serveur = await asyncio.start_server(lambda r, w: A.servir_client(a, r, w), "127.0.0.1", 0, limit=A.MAX_ENTETE)
    port = serveur.sockets[0].getsockname()[1]
    sondes = asyncio.create_task(A.boucle_sondes(a))

    async def passe(attendu_dans):
        avant = dict(compte)
        code, corps = await via(port, "www.exemple.test", site_port)
        assert (code, corps) == (200, b"ok"), (code, corps)
        quoi = [k for k in ("maison", "vpn") if compte.get(k, 0) > avant.get(k, 0)] or ["direct"]
        assert quoi == [attendu_dans], f"attendu {attendu_dans}, passé par {quoi} ({compte}, {a.etat()['sorties']})"

    await passe("maison")
    await passe("maison")
    print("2a. avec les deux sorties, tout passe par la maison")

    avant_vpn = compte.get("vpn", 0)
    await maison.couper()
    await passe("vpn")  # la bascule se fait sur la connexion même qui échoue : le client ne voit rien
    assert a.courante == "vpn"
    print("2b. la maison coupée : la connexion suivante passe par le VPN, sans erreur côté navigateur")

    # Rallumer la maison sur le même port : la sonde la voit revenir, mais une connexion récente retient le VPN.
    await maison.demarrer()
    await asyncio.sleep(0.8)  # plusieurs sondes passent
    assert a.saine("maison"), f"la maison revenue est vue par les sondes : {a.etat()} {a.sorties[chr(109)+chr(97)+chr(105)+chr(115)+chr(111)+chr(110)].echecs}"
    await passe("vpn")
    assert a.courante == "vpn", "la maison est revenue mais le dernier échange date de moins de 1,5 s : on reste sur le VPN"
    print("2c. la maison rallumée : le navigateur reste sur le VPN tant que la session bouge")
    await asyncio.sleep(2.2)  # plus de 1,5 s sans connexion
    assert a.courante == "maison", f"après le délai d'inactivité, retour à la maison : {a.etat()}"
    await passe("maison")
    print("2d. après le délai sans connexion, retour à la maison")

    await maison.couper()
    await vpn.couper()
    code, corps = await via(port, "www.exemple.test", site_port)
    assert (code, corps) == (200, b"ok") and a.courante == "direct", f"repli direct attendu : {code} {a.etat()}"
    print("2e. plus aucune sortie : repli direct")

    sondes.cancel()
    serveur.close()
    site.close()


asyncio.run(partie2())

# --- 3. L'adresse vue des sites (TLS à travers une sortie), destinations privées ---------------------------------------

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "info.essai.test")])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(1)
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("info.essai.test")]), critical=False).sign(key, hashes.SHA256()))
tmp = tempfile.mkdtemp()
open(f"{tmp}/c.pem", "wb").write(cert.public_bytes(serialization.Encoding.PEM))
open(f"{tmp}/k.pem", "wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))


async def partie3():
    srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    srv_ctx.load_cert_chain(f"{tmp}/c.pem", f"{tmp}/k.pem")

    async def ipinfo(r, w):
        await r.readuntil(b"\r\n\r\n")
        body = json.dumps({"ip": "203.0.113.7", "city": "Montréal", "region": "Quebec", "country": "CA", "timezone": "America/Toronto", "org": "ne pas garder"}).encode()
        w.write(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%b" % (len(body), body))
        await w.drain()
        w.close()
    site = await asyncio.start_server(ipinfo, "127.0.0.1", 0, ssl=srv_ctx)
    site_port = site.sockets[0].getsockname()[1]
    A.SITE_PORT = site_port
    loop = asyncio.get_running_loop()
    vrai = loop.getaddrinfo

    async def getaddrinfo(host, port, **k):
        return await vrai("127.0.0.1", site_port, **k)
    loop.getaddrinfo = getaddrinfo  # noqa: B010
    faite = ssl.create_default_context
    ssl.create_default_context = lambda *a, **k: faite(cafile=f"{tmp}/c.pem")  # noqa: B010
    try:
        info = await A.lire_info(A.Sortie(A.DIRECT))
    finally:
        ssl.create_default_context = faite
    assert info == {"ip": "203.0.113.7", "city": "Montréal", "region": "Quebec", "country": "CA", "timezone": "America/Toronto"}, info
    print("3a. l'adresse, la ville, la région, le pays et le fuseau sont lus par TLS à travers la sortie (rien d'autre n'est gardé)")
    site.close()

asyncio.run(partie3())

A.PRIVE_OK = False
for hote, port, refus in [("192.168.1.10", 445, True), ("100.101.102.103", 3389, True), ("10.0.0.5", 80, True), ("127.0.0.1", 8080, True),
                          ("169.254.169.254", 80, True), ("[::1]", 80, True), ("::ffff:10.0.0.1", 80, True), ("mon-pc.tailnet.ts.net", 443, True),
                          ("imprimante.local", 80, True), ("localhost", 80, True), ("noah-server", 8080, True), ("exemple.org", 25, True),
                          ("exemple.org", 443, False), ("1.1.1.1", 443, False), ("www.facebook.com", 443, False)]:
    got = bool(A.destination_interdite(hote, port))
    assert got == refus, f"{hote}:{port} refus attendu {refus}, obtenu {got}"
print("3b. adresses du réseau local, de Tailscale, noms internes et courrier : refusés ; les sites publics passent")


async def partie3c():
    a = A.Aiguillage([])
    serveur = await asyncio.start_server(lambda r, w: A.servir_client(a, r, w), "127.0.0.1", 0, limit=A.MAX_ENTETE)
    code, _ = await via(serveur.sockets[0].getsockname()[1], "192.168.1.10", 445)
    assert code == 403, code
    serveur.close()
asyncio.run(partie3c())
print("3c. le mandataire répond 403 à une destination privée")
print("OK : aiguillage")
