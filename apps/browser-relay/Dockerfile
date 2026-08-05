# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Workspace config + the package.json/tsconfig of every package in the build
# graph (browser-relay → @use-brian/api → @use-brian/core/channels/shared/…).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/channels/package.json packages/channels/tsconfig.json ./packages/channels/
COPY packages/doc-model/package.json packages/doc-model/tsconfig.json ./packages/doc-model/
COPY packages/office-model/package.json packages/office-model/tsconfig.json ./packages/office-model/
COPY packages/office-renderer/package.json packages/office-renderer/tsconfig.json ./packages/office-renderer/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/
COPY packages/brian-kb/package.json packages/brian-kb/tsconfig.json ./packages/brian-kb/
COPY packages/brian-app/package.json packages/brian-app/tsconfig.json ./packages/brian-app/
COPY apps/browser-relay/package.json apps/browser-relay/tsconfig.json ./apps/browser-relay/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ─────────────────────────────────────────────
FROM deps AS build

COPY packages/shared/src ./packages/shared/src
COPY packages/channels/src ./packages/channels/src
COPY packages/doc-model/src ./packages/doc-model/src
COPY packages/office-model/src ./packages/office-model/src
COPY packages/office-renderer/src ./packages/office-renderer/src
COPY packages/core/src ./packages/core/src
COPY packages/core/scripts ./packages/core/scripts
COPY packages/api/src ./packages/api/src
COPY packages/api/migrations ./packages/api/migrations
# Source only: copying the whole package dir would clobber the node_modules
# symlinks pnpm created in the deps stage, breaking a clean build.
COPY packages/brian-kb/src ./packages/brian-kb/src
COPY packages/brian-app/src ./packages/brian-app/src
COPY apps/browser-relay/src ./apps/browser-relay/src

# pnpm topological build (deps-first), not turbo — see discord-connector.
RUN pnpm --filter "@use-brian/browser-relay..." run build

# ── Stage 3: Production image ─────────────────────────────────
FROM node:22-slim AS runner

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/channels/package.json ./packages/channels/
COPY packages/doc-model/package.json ./packages/doc-model/
COPY packages/office-model/package.json ./packages/office-model/
COPY packages/office-renderer/package.json ./packages/office-renderer/
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
COPY packages/brian-kb/package.json ./packages/brian-kb/
COPY packages/brian-app/package.json ./packages/brian-app/
COPY packages/brian-app/bin ./packages/brian-app/bin
COPY apps/browser-relay/package.json ./apps/browser-relay/

RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/channels/dist ./packages/channels/dist
COPY --from=build /app/packages/doc-model/dist ./packages/doc-model/dist
COPY --from=build /app/packages/office-model/dist ./packages/office-model/dist
COPY --from=build /app/packages/office-renderer/dist ./packages/office-renderer/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/brian-kb/dist ./packages/brian-kb/dist
COPY --from=build /app/packages/brian-app/dist ./packages/brian-app/dist
COPY --from=build /app/apps/browser-relay/dist ./apps/browser-relay/dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/browser-relay/dist/index.js"]
