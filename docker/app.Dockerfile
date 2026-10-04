# WireHub — a self-contained image: the standalone Node server
# (apps/studio/server/serve.ts) serving the built UI and /api/*, plus the
# compose stack's one-shots (apps/studio/stack/: bootstrap, garage-init,
# backup-init). Built from the repository root by the release workflow, or
# locally: docker build -f docker/app.Dockerfile -t wirehub:dev .
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter studio bundle

FROM node:24-bookworm-slim
ARG WIREHUB_VERSION=dev
ARG WIREHUB_REVISION=unknown
LABEL org.opencontainers.image.title="WireHub" \
      org.opencontainers.image.description="Cable assemblies as canonical definitions: schematics, build sheets, BOMs and continuity specs from one model." \
      org.opencontainers.image.source="https://github.com/formless63/wirehub" \
      org.opencontainers.image.url="https://github.com/formless63/wirehub" \
      org.opencontainers.image.documentation="https://github.com/formless63/wirehub#readme" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${WIREHUB_VERSION}" \
      org.opencontainers.image.revision="${WIREHUB_REVISION}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/auth /data/blobs /data/cache /data/packs /run/wirehub \
 && chown -R node:node /data /run/wirehub
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
# a fresh hub opens on first-run setup (/setup) until domain modules are chosen;
# the packs it installs live in /data/packs, never in the starter catalog
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5183 WIREHUB_VERSION=${WIREHUB_VERSION} WIREHUB_SETUP_PROMPT=1 WIREHUB_PACKS_DIR=/data/packs
WORKDIR /app/apps/studio
EXPOSE 5183
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:5183/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--experimental-strip-types", "--no-warnings", "server/serve.ts"]
