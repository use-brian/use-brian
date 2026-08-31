FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile

RUN pnpm --filter "@use-brian/api-open..." run build

FROM node:22-slim AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/brian-kb/package.json ./packages/brian-kb/
COPY --from=build /app/packages/office-model/package.json ./packages/office-model/
COPY --from=build /app/packages/office-renderer/package.json ./packages/office-renderer/
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/channels/package.json ./packages/channels/
COPY --from=build /app/packages/api/package.json ./packages/api/
COPY --from=build /app/packages/brian-app/package.json ./packages/brian-app/
COPY --from=build /app/packages/brian-app/bin ./packages/brian-app/bin
COPY --from=build /app/packages/doc-model/package.json ./packages/doc-model/
COPY --from=build /app/apps/api/package.json ./apps/api/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile --prod

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

RUN mkdir -p /data/files /home/node/.usebrian && chown -R node:node /data/files /home/node/.usebrian

ENV NODE_ENV=production
ENV PORT=4000
ENV LOCAL_FILES_DIR=/data/files

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
