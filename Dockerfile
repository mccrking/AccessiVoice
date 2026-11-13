FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY backend ./backend
COPY data ./data
COPY scripts ./scripts
RUN python -m scripts.train && useradd --create-home accessivoice && chown -R accessivoice:accessivoice /app
COPY --from=frontend /app/dist ./dist
USER accessivoice
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
