# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/brian-kb/package.json packages/brian-kb/tsconfig.json ./packages/brian-kb/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/channels/package.json packages/channels/tsconfig.json ./packages/channels/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/
COPY packages/doc-model/package.json packages/doc-model/tsconfig.json ./packages/doc-model/
COPY apps/doc-sync/package.json apps/doc-sync/tsconfig.json ./apps/doc-sync/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ─────────────────────────────────────────────
FROM deps AS build

COPY packages/shared/src ./packages/shared/src
COPY packages/brian-kb/src ./packages/brian-kb/src
COPY packages/core/src ./packages/core/src
COPY packages/channels/src ./packages/channels/src
COPY packages/api/src ./packages/api/src
COPY packages/doc-model/src ./packages/doc-model/src
COPY apps/doc-sync/src ./apps/doc-sync/src

# pnpm topological build, not turbo: emulated (`--platform linux/amd64` on
# arm64 / QEMU) turbo aborts on EINTR creating its `.turbo` log dir. `<pkg>...`
# = package + dependency closure, built deps-first (same as turbo's `^build`).
RUN pnpm --filter "@use-brian/doc-sync..." run build

# ── Stage 3: Production image ─────────────────────────────────
FROM node:22-slim AS runner

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/brian-kb/package.json ./packages/brian-kb/
COPY packages/core/package.json ./packages/core/
COPY packages/channels/package.json ./packages/channels/
COPY packages/api/package.json ./packages/api/
COPY packages/doc-model/package.json ./packages/doc-model/
COPY apps/doc-sync/package.json ./apps/doc-sync/

RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/brian-kb/dist ./packages/brian-kb/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/channels/dist ./packages/channels/dist
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/doc-model/dist ./packages/doc-model/dist
COPY --from=build /app/apps/doc-sync/dist ./apps/doc-sync/dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/doc-sync/dist/index.js"]
