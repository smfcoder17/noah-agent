# Banc anti-robot : trois moteurs dans une image, avec écran virtuel. Rien de Noah dedans.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb xauth ca-certificates curl fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir playwright patchright "camoufox[geoip]"
# Témoin : Chromium de Playwright, et les bibliothèques de Firefox pour Camoufox.
RUN playwright install --with-deps chromium && playwright install-deps firefox
# Patchright avec le vrai Chrome (n'existe pas pour ARM : Chromium à la place).
RUN if [ "$(uname -m)" = "x86_64" ]; then patchright install --with-deps chrome; else patchright install --with-deps chromium; fi
RUN python -m camoufox fetch
COPY banc.py /banc/banc.py
WORKDIR /banc
# Écran virtuel lancé à la main : xvfb-run attend un signal qu'il ne reçoit pas quand il est le processus 1 du conteneur.
ENV DISPLAY=:99
ENTRYPOINT ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 & sleep 1; exec python banc.py \"$@\"", "banc"]
