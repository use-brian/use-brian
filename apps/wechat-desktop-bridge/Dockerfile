# ── Stage 1: Build ─────────────────────────────────────────────
# The bridge is standalone (no workspace package imports), so it builds from
# its own package.json with npm: no pnpm workspace, no monorepo lockfile. The
# build runs from this directory (`docker compose build` / `docker build .`).
FROM node:22-slim AS build

ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

WORKDIR /app
COPY package.json tsconfig.build.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.build.json \
 && printf '{"gitSha":"%s","buildTime":"%s"}\n' "$GIT_SHA" "$BUILD_TIME" > dist/build-info.json

# ── Stage 2: Production image ─────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV BRIDGE_PORT=8086
EXPOSE 8086
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
