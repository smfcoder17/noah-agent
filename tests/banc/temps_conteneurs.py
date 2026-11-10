"""Sonde C5, à lancer dans un conteneur sous libfaketime.

Affiche l'heure murale, le fuseau et la durée réelle d'un asyncio.sleep.
Deux conteneurs lisant temps.rc doivent afficher la même heure murale ;
avancer le fichier doit changer cette heure sans accélérer leur monotonic.
"""
import asyncio
import json
import os
import time
from datetime import datetime


async def sonder():
    assert os.environ.get("LD_PRELOAD"), "libfaketime n'est pas préchargée"
    assert os.environ.get("FAKETIME_DONT_FAKE_MONOTONIC") == "1"
    debut = time.monotonic()
    await asyncio.sleep(0.2)
    ecoule = time.monotonic() - debut
    assert 0.15 <= ecoule < 2, f"Délai réseau altéré : {ecoule}"
    print(json.dumps({"epoch": time.time(), "local": datetime.now().isoformat(), "fuseau": time.tzname,
                      "delai_reel": ecoule, "fichier": os.environ["FAKETIME_TIMESTAMP_FILE"]}))


if __name__ == "__main__":
    asyncio.run(sonder())
