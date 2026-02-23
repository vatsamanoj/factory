# Stage 1: Build frontend
FROM node:22-alpine AS builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# Stage 2: Run API + Nginx (single container deployment friendly)
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache nginx git bash ripgrep curl ca-certificates \
  && update-ca-certificates \
  && CONFIGURE=false bash -lc "$(curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh)" \
  && ln -sf /root/.local/bin/goose /usr/local/bin/goose \
  && goose --version

# Frontend assets
COPY --from=builder /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/http.d/default.conf

# Backend app
COPY server/package*.json /app/server/
RUN npm --prefix /app/server install --omit=dev
COPY server/src /app/server/src
COPY server/schemas /app/server/schemas

COPY docker/start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /app/server/data /run/nginx

ENV PORT=8787
ENV DASHBOARD_DB_PATH=/app/server/data/dashboard.db
ENV GOOSE_CODE_INDEX_LANCEDB_DIR=/app/server/data/codeintel.lancedb
ENV GOOSE_ALLOW_MOCK_FALLBACK=0

EXPOSE 5173
CMD ["/start.sh"]
