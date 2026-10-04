# Cable Studio — a self-contained image of the current (file-backed) studio:
# the standalone Node server (apps/studio/server/serve.ts) serving the built
# bundle and /api/*. Built from the repository root (see docker-compose.yml).
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter studio bundle

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5183
WORKDIR /app/apps/studio
EXPOSE 5183
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:5183/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--experimental-strip-types", "--no-warnings", "server/serve.ts"]
