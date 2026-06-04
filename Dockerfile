# Cloud Run JOB image — runs to completion, no HTTP server, no EXPOSE.
# node:22-slim (Debian bookworm, OpenSSL 3.0.x) matches the Prisma
# binaryTarget `debian-openssl-3.0.x` used across the GUB repos.

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
# scripts/ contains the backfill engine (runBackfill) imported by
# src/drive/backfill-queue.ts for the `backfill-pending` Job mode. The
# tsconfig.json's `include` covers both src/ and scripts/, so tsc emits
# both into dist/. The runtime image needs dist/scripts/backfill.js to
# resolve that import.
COPY scripts ./scripts
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Generated Prisma client (engine + types) from the builder.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist

USER node
# Cloud Run Job entrypoint: main.ts dispatches on argv[2] (poll | run-full-sync
# | continue | cron | notify | sweep-expired | backfill-pending). The mode
# is passed as a Job argument (Cloud Scheduler / gub-admin / self-trigger
# override `args`).
CMD ["node", "dist/src/main.js"]
