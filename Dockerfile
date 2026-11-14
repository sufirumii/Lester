# Lester — production image (Bun runtime, digest-pinned bases, non-root).
# Build: docker build -t lester:1.0.4 .

# oven/bun:1.3.14-slim, pinned by digest (S7)
ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Dependencies AND Prisma engine binaries are fetched here, at BUILD time —
# the running container never contacts binaries.prisma.sh (B7).
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Explicit build inputs only (S7, hardened in v1.0.4): nothing from the build
# context enters the image unless listed here — a stray .env, local databases,
# docs or release artifacts cannot leak in even with no .dockerignore present.
COPY package.json bun.lock ./
COPY src ./src
COPY prisma ./prisma
COPY public ./public
COPY scripts ./scripts
COPY next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs eslint.config.mjs ./
COPY LICENSE ./
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/tmp/build.db
RUN bunx prisma generate \
 && bun run build \
 && rm -f /tmp/build.db*

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
# non-root (S7): the oven/bun image ships a uid-1000 `bun` user
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    LESTER_DATA_DIR=/app/data \
    DATABASE_URL=file:/app/data/lester.db?connection_limit=1 \
    LESTER_BIND=0.0.0.0 \
    LESTER_PORT=8090 \
    LESTER_ENGINE=auto
COPY --from=build --chown=bun:bun /app ./
USER bun
RUN mkdir -p /app/data && chown bun:bun /app/data
VOLUME /app/data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8090/api/health-live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1
# start:prod = migrate (with automatic pre-upgrade backup; never destructive) + serve
CMD ["bun", "run", "start:prod"]
