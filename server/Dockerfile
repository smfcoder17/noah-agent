FROM python:3.12-slim

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/apollo ./apollo
COPY web ./web

ENV APOLLO_DATA_DIR=/data APOLLO_WEB_DIR=/app/web
EXPOSE 8080
CMD ["uvicorn", "apollo.main:app", "--host", "0.0.0.0", "--port", "8080"]
