# crosspoint-sync — no native deps (uses Node's built-in node:sqlite)
# The base is pinned by digest so builds are reproducible; Dependabot bumps it.
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# The CrossPoint Sync app's web build (the same React app the phone/desktop app
# ships), served at /app/. Only the web half: no Rust/Tauri build needed.
FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY app/package.json app/package-lock.json ./
RUN npm ci --ignore-scripts
COPY app/index.html app/vite.config.js ./
COPY app/public ./public
COPY app/src ./src
RUN npx vite build

FROM ${NODE_IMAGE}
# Patch the base's OS packages, and drop the package managers: the server never
# installs anything at runtime, and they carry most of the base image's CVEs.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data && chown node:node /data && chmod 700 /data
ENV NODE_ENV=production \
    DATABASE_PATH=/data/crosspoint.db \
    PORT=8080 \
    WEB_APP_DIR=/app/web
WORKDIR /app
# Code stays root-owned and read-only to the server user; only /data is writable.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
COPY migrations ./migrations
COPY assets ./assets
COPY extension ./extension
COPY package.json ./
# Numeric so orchestrators can verify runAsNonRoot.
USER 1000:1000
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "dist/index.js"]
