FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DOC_SYNC_URL
ARG NEXT_PUBLIC_USEBRIAN_EDITION=oss
ARG OSS_GIT_COMMIT_SHA

RUN test -n "$NEXT_PUBLIC_API_URL" \
    && test -n "$NEXT_PUBLIC_DOC_SYNC_URL" \
    && pnpm --filter "app-web..." run build

FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3003

COPY --from=build --chown=node:node /app/apps/app-web/.next/standalone/ ./
COPY --from=build --chown=node:node /app/apps/app-web/.next/static/ ./apps/app-web/.next/static/
COPY --from=build --chown=node:node /app/apps/app-web/public/ ./apps/app-web/public/

USER node

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const s=require('node:net').connect(3003,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"

CMD ["node", "apps/app-web/server.js"]
