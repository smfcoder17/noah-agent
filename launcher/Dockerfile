FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.6 uvicorn==0.34.0 docker==7.1.0
COPY launcher.py agent_admin.py ./
COPY camofox-noah ./camofox-noah

EXPOSE 9000
CMD ["uvicorn", "launcher:app", "--host", "0.0.0.0", "--port", "9000"]
