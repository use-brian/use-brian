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

FROM node:22-slim AS runtime-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY --from=build /app/ ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --offline --frozen-lockfile --prod

RUN mkdir -p /data/files /data/pglite /home/node/.usebrian \
    && chown -R node:node /data/files /data/pglite /home/node/.usebrian

ENV NODE_ENV=production

USER node

FROM runtime-base AS pglite

ENV PGLITE_HOST=0.0.0.0
ENV PGLITE_PORT=54329
ENV PGLITE_DATA_DIR=/data/pglite

VOLUME ["/data/pglite"]

EXPOSE 54329

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 CMD node -e "const p=Number(process.env.PGLITE_PORT||54329);const s=require('node:net').connect(p,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"

CMD ["node", "apps/api/dist/pglite-server.js"]

FROM runtime-base AS runtime

ENV PORT=4000
ENV LOCAL_FILES_DIR=/data/files

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
