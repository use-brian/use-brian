FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
ARG OSS_GIT_COMMIT_SHA
ENV OSS_GIT_COMMIT_SHA=${OSS_GIT_COMMIT_SHA}
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm turbo run build --filter=app-web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3003
COPY --from=build /src/apps/app-web/.next/standalone/ ./
COPY --from=build /src/apps/app-web/.next/static/ ./apps/app-web/.next/static/
COPY --from=build /src/apps/app-web/public/ ./apps/app-web/public/
RUN chown -R node:node /app/apps/app-web/.next
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/api/desktop-config').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/app-web/server.js"]
