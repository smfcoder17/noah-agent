FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.6 uvicorn==0.34.0 docker==7.1.0 cryptography==44.0.0
# Clé publique des versions : le lanceur revérifie lui-même chaque manifeste avant de toucher à Docker.
ARG NOAH_UPDATE_KEY=
ARG NOAH_VERSION=
ENV NOAH_UPDATE_KEY=$NOAH_UPDATE_KEY NOAH_VERSION=$NOAH_VERSION
COPY launcher.py agent_admin.py updater.py restore.py ./
COPY camofox-noah ./camofox-noah
# L'extension que Camoufox irait sinon chercher sur Internet à son premier lancement (voir fetch_ublock.py).
RUN python camofox-noah/fetch_ublock.py camofox-noah/addons/UBO

EXPOSE 9000
CMD ["uvicorn", "launcher:app", "--host", "0.0.0.0", "--port", "9000"]
