# Image du navigateur de l'agent : Camofox, figé par empreinte, et un petit bureau (Openbox, tint2, PCManFM, Mousepad).
# Le bureau tourne sous le compte 1001 : voir bureau/index.js. Aucun terminal dans cette image.
FROM ghcr.io/jo-inc/camofox-browser@sha256:cff2c1432b609bde9c9d0b91e5b924dae0799d3c7bc9d468c0bc949325beaf2a
RUN apt-get update && apt-get install -y --no-install-recommends openbox tint2 pcmanfm adwaita-icon-theme mousepad && rm -rf /var/lib/apt/lists/*
# Le nettoyage de Camofox tue tout ce qui s'appelle /usr/bin/Xvfb (lib/process-ownership.js) : ce lien garde l'écran en vie.
RUN ln -s /usr/bin/Xvfb /usr/local/bin/Xvfb
COPY bureau/index.js /app/plugins/bureau/index.js
RUN useradd -u 1001 -m -d /home/bureau -s /usr/sbin/nologin bureau && mkdir -p /home/bureau/Documents /tmp/bureau-run && chmod 700 /tmp/bureau-run && chown 1001:1001 /tmp/bureau-run
COPY home/ /home/bureau/
RUN chown -R 1001:1001 /home/bureau
