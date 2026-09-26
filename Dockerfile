# syntax=docker/dockerfile:1

FROM node:24.15.0-bookworm-slim AS node-openssl
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

FROM node-openssl AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm -r run build
RUN pnpm --filter server deploy --prod --legacy /out/server \
 && pnpm --filter wallet-finder deploy --prod --legacy /out/wallet-finder \
 && pnpm --filter detection-cluster deploy --prod --legacy /out/collector \
 && pnpm --filter hyperliquid-sim deploy --prod --legacy /out/hyperliquid-sim

FROM node-openssl AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/server ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS wallet-finder
COPY --from=build /out/wallet-finder ./
EXPOSE 3020
CMD ["node", "dist/main.js"]

FROM runtime AS collector
COPY --from=build /out/collector ./
EXPOSE 3010
CMD ["node", "dist/main.js"]

FROM runtime AS hyperliquid-sim
COPY --from=build /out/hyperliquid-sim ./
EXPOSE 3030
CMD ["node", "dist/main.js"]

FROM caddy:2.11.3 AS web
ENV SITE_ADDRESS=:8080
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/dashboard/dist /srv/dashboard
