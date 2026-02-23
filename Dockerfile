# Stage 1: Build frontend
FROM node:22-alpine AS builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# Stage 2: Run API + Nginx (single container deployment friendly)
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    nginx git bash ripgrep ca-certificates curl bzip2 tar \
    libxcb1 libx11-6 libxkbcommon0 libxkbcommon-x11-0 libxrandr2 libxrender1 libxi6 libxtst6 libnss3 libasound2 \
  && CONFIGURE=false bash -lc "$(curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh)" \
  && ln -sf /root/.local/bin/goose /usr/local/bin/goose \
  && goose --version \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default \
  && mkdir -p /run/nginx

# Frontend assets
COPY --from=builder /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Backend app
COPY server/package*.json /app/server/
RUN npm --prefix /app/server install --omit=dev
COPY server/src /app/server/src
COPY server/schemas /app/server/schemas

COPY docker/start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /app/server/data

ENV PORT=8787
ENV DASHBOARD_DB_PATH=/app/server/data/dashboard.db
ENV GOOSE_CODE_INDEX_LANCEDB_DIR=/app/server/data/codeintel.lancedb
ENV GOOSE_ALLOW_MOCK_FALLBACK=0

EXPOSE 5173
CMD ["/start.sh"]
