"""Crée un navigateur avec le vrai code du lanceur (launcher._ensure_browser), dans l'image du lanceur. Lancé par
hors_ligne_test.mjs. Rien d'autre du lanceur ne tourne : ni service, ni reprise des conteneurs existants."""
import shutil
import sys

import launcher

agent_id, api_key, vnc, private = sys.argv[1:5]
if "--sans-extension" in sys.argv:  # sabotage : le lanceur d'avant, qui laisse Camoufox chercher son extension en ligne
    shutil.rmtree(launcher.Path(launcher.__file__).parent / "camofox-noah" / "addons")
launcher.container = lambda _: None  # l'agent lui-même n'a pas à exister pour ce test
keys = launcher.BrowserKeys(api_key=api_key, vnc_password=vnc, private_key=private, locale="fr-FR", timezone="Europe/Paris")
print(launcher._ensure_browser(agent_id, keys))
