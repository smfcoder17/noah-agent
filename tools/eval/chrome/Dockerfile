# Candidat du lot 5 (banc seulement, pas une image de Noah) : Chromium avec écran (Xvfb + Openbox), vu par noVNC comme
# Camoufox, piloté par CDP. Paquets Debian uniquement.
#     docker build -t noah-banc-chrome tools/eval/chrome
#     docker run -d --name noahbanc-chrome -p 127.0.0.1:19222:9223 -p 127.0.0.1:16083:6080 --shm-size 1g --memory 4g --cpus 4 noah-banc-chrome
#     node tools/eval/navigateur.mjs cdp http://127.0.0.1:19222 - noahbanc-chrome 3
# Limites connues pour un vrai remplacement : --no-sandbox (root dans le conteneur), aucun mot de passe VNC, aucun profil
# persistant ni plugin Noah (connexion, mode privé, envoi de fichiers) : à reprendre avant toute bascule.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc websockify openbox socat fonts-noto-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
EXPOSE 9223 6080
CMD ["sh", "/start.sh"]
