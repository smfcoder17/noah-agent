# Petite application de test : écrit une base SQLite en continu et répond sur /health. La v2 migre le schéma, puis
# renvoie 500 sur l'agent « b » (le canari « a » passe : le retour arrière doit tout ramener).
FROM python:3.12-slim
ARG APPV
ENV APPV=$APPV
COPY app.py /app.py
# En PID 1, Python ignore SIGTERM : Docker attendrait tout son délai d'arrêt avant de tuer. Le kill arrive donc tout de suite,
# avec le même effet : rien n'est fermé, le WAL reste sur le disque.
STOPSIGNAL SIGKILL
CMD ["python", "/app.py"]
