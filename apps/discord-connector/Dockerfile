# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Workspace config + the package.json/tsconfig of every package in the build
# graph (discord-connector → @use-brian/channels). `packages/shared` carries no
# runtime import here, but `packages/channels/tsconfig.json` declares it as a
# composite project `reference`, and tsc fails with TS6053 if the referenced
# directory is absent — so its manifest + sources must be present to compile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/channels/package.json packages/channels/tsconfig.json ./packages/channels/
COPY apps/discord-connector/package.json apps/discord-connector/tsconfig.json ./apps/discord-connector/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ─────────────────────────────────────────────
FROM deps AS build

COPY packages/shared/src ./packages/shared/src
COPY packages/channels/src ./packages/channels/src
COPY apps/discord-connector/src ./apps/discord-connector/src

# pnpm topological build, not turbo: emulated (`--platform linux/amd64` on
# arm64 / QEMU) turbo aborts on EINTR creating its `.turbo` log dir. `<pkg>...`
# = package + dependency closure, built deps-first (builds @use-brian/shared
# then @use-brian/channels first) — same ordering as turbo's `^build`.
RUN pnpm --filter "@use-brian/discord-connector..." run build

# ── Stage 3: Production image ─────────────────────────────────
FROM node:22-slim AS runner

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/channels/package.json ./packages/channels/
COPY apps/discord-connector/package.json ./apps/discord-connector/

# Production deps only; workspace packages are symlinked, their built JS copied below.
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/channels/dist ./packages/channels/dist
COPY --from=build /app/apps/discord-connector/dist ./apps/discord-connector/dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/discord-connector/dist/index.js"]
