# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Build context is the standalone OSS repository root.
# Copy workspace config + wa-connector package.json for install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/wa-connector/package.json apps/wa-connector/tsconfig.json ./apps/wa-connector/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ─────────────────────────────────────────────
FROM deps AS build

COPY apps/wa-connector/src ./apps/wa-connector/src

# pnpm topological build, not turbo: emulated (`--platform linux/amd64` on
# arm64 / QEMU) turbo aborts on EINTR creating its `.turbo` log dir. `<pkg>...`
# = package + dependency closure, built deps-first (same as turbo's `^build`).
RUN pnpm --filter "@use-brian/wa-connector..." run build

# ── Stage 3: Production image ─────────────────────────────────
FROM node:22-slim AS runner

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/wa-connector/package.json ./apps/wa-connector/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output from build stage
COPY --from=build /app/apps/wa-connector/dist ./apps/wa-connector/dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/wa-connector/dist/index.js"]
