FROM node:22-bookworm-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/brian-kb/package.json packages/brian-kb/tsconfig.json ./packages/brian-kb/
COPY packages/office-model/package.json packages/office-model/tsconfig.json ./packages/office-model/
COPY packages/office-renderer/package.json packages/office-renderer/tsconfig.json ./packages/office-renderer/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/channels/package.json packages/channels/tsconfig.json ./packages/channels/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/
COPY packages/brian-app/package.json packages/brian-app/tsconfig.json ./packages/brian-app/
COPY packages/doc-model/package.json packages/doc-model/tsconfig.json ./packages/doc-model/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY packages/shared/src ./packages/shared/src
COPY packages/brian-kb/src ./packages/brian-kb/src
COPY packages/office-model/src ./packages/office-model/src
COPY packages/office-renderer/src ./packages/office-renderer/src
COPY packages/core/src ./packages/core/src
COPY packages/channels/src ./packages/channels/src
COPY packages/api/src ./packages/api/src
COPY packages/brian-app/src ./packages/brian-app/src
COPY packages/doc-model/src ./packages/doc-model/src
COPY apps/api/src ./apps/api/src

RUN pnpm --filter "@use-brian/api-open..." run build

FROM node:22-bookworm-slim AS runtime

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libreoffice-calc-nogui \
    libreoffice-impress-nogui \
    libreoffice-writer-nogui \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/brian-kb/package.json ./packages/brian-kb/
COPY packages/brian-kb/bin ./packages/brian-kb/bin
COPY packages/office-model/package.json ./packages/office-model/
COPY packages/office-renderer/package.json ./packages/office-renderer/
COPY packages/core/package.json ./packages/core/
COPY packages/channels/package.json ./packages/channels/
COPY packages/api/package.json ./packages/api/
COPY packages/brian-app/package.json ./packages/brian-app/
COPY packages/brian-app/bin ./packages/brian-app/bin
COPY packages/doc-model/package.json ./packages/doc-model/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/brian-kb/dist ./packages/brian-kb/dist
COPY --from=build /app/packages/office-model/dist ./packages/office-model/dist
COPY --from=build /app/packages/office-renderer/dist ./packages/office-renderer/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/channels/dist ./packages/channels/dist
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/brian-app/dist ./packages/brian-app/dist
COPY --from=build /app/packages/doc-model/dist ./packages/doc-model/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY packages/api/migrations ./packages/api/migrations

ENV NODE_ENV=production \
    PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
