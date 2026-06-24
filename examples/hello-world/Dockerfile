# Multi-stage Dockerfile for the Sovereign ID hello-world demo on fly.io.
#
# Stage 1 (deps): install npm dependencies into a clean layer. Using
# `npm ci` so the lockfile-pinned versions are what land in the image
# (no "works on dev's machine" drift between local and prod).
#
# Stage 2 (runtime): minimal alpine image with just the installed
# node_modules + source + public assets. No build tools, no cache.

# ─── Stage 1: dependencies ────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only the manifest first so this layer caches when source changes
# but package.json doesn't. `--omit=dev` because the demo's only dev
# dep would be node:test which is built into Node 20.
COPY package.json package-lock.json* ./

# If a lockfile exists, use `npm ci` (deterministic, fast). Otherwise
# fall back to `npm install` so first-time deploys work even before
# a lockfile is committed.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ─── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Pull the pre-installed deps from stage 1.
COPY --from=deps /app/node_modules ./node_modules

# Application source + static assets. .dockerignore keeps node_modules,
# .git, tarballs, etc. out of the build context.
COPY package.json ./
COPY src ./src
COPY public ./public

# Run as a non-root user. Node 20-alpine ships with a `node` user
# at uid 1000.
USER node

# fly.io routes the public port to whatever the app listens on
# internally. Match the [http_service] internal_port in fly.toml (3000)
# and expose it so Docker layer scanners surface it.
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "src/server.js"]
