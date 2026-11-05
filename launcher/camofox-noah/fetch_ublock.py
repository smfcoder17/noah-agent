"""À la construction de l'image du lanceur : uBlock Origin, figé par version et par empreinte.

Sans ce dossier, le premier lancement de Camoufox télécharge la dernière version sur addons.mozilla.org, et le
navigateur ne démarre pas si le site est injoignable (G0.5). Le lanceur le pose dans le conteneur avant de le démarrer.
"""
import hashlib
import io
import sys
import urllib.request
import zipfile

VERSION = "1.75.4"
URL = f"https://addons.mozilla.org/firefox/downloads/file/5203014/ublock_origin-{VERSION}.xpi"
SHA256 = "e2df503cce7cf5069130618c349695f62bdddb9eb8c189156d027269ae4ae267"

data = urllib.request.urlopen(URL, timeout=120).read()
seen = hashlib.sha256(data).hexdigest()
if seen != SHA256:
    sys.exit(f"uBlock Origin {VERSION} : empreinte inattendue ({seen})")
with zipfile.ZipFile(io.BytesIO(data)) as xpi:
    xpi.extractall(sys.argv[1])
print(f"uBlock Origin {VERSION} dans {sys.argv[1]}")
