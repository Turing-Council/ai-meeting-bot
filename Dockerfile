# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# --- Dependencies (all, for building and testing) ---
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Build TypeScript ---
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Tests, including the ffmpeg integration tests: docker build --target test . ---
FROM deps AS test
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npx tsc --noEmit && npx vitest run

# --- Production runtime ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Recordings and manifests live here: mount a persistent volume on /app/data.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
USER node

# tini forwards SIGTERM so the bot can close audio files cleanly on redeploy.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
