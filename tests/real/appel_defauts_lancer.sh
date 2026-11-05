#!/bin/sh
# Dans le conteneur d'essai : voir appel_defauts_serveur.py.
pip install -q -r /app/requirements.txt uvicorn && exec python /tests/real/appel_defauts_serveur.py
