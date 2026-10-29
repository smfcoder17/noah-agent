# 1) Interface web : React + assistant-ui, compilée en fichiers statiques.
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2) Serveur Apollo (FastAPI), qui sert aussi l'interface.
FROM python:3.12-slim

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/apollo ./apollo
COPY --from=web /web/dist ./web

ENV APOLLO_DATA_DIR=/data APOLLO_WEB_DIR=/app/web
EXPOSE 8080
CMD ["uvicorn", "apollo.main:app", "--host", "0.0.0.0", "--port", "8080"]
