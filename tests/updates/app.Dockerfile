# Petite application de test : écrit une base SQLite en continu et répond sur /health. La v2 migre le schéma, puis
# renvoie 500 sur l'agent « b » (le canari « a » passe : le retour arrière doit tout ramener).
FROM python:3.12-slim
ARG APPV
ENV APPV=$APPV
COPY app.py /app.py
CMD ["python", "/app.py"]
