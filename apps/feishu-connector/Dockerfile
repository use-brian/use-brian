# syntax=docker/dockerfile:1

FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/channels/package.json packages/channels/tsconfig.json ./packages/channels/
COPY apps/feishu-connector/package.json apps/feishu-connector/tsconfig.json ./apps/feishu-connector/
RUN pnpm install --frozen-lockfile

COPY packages/channels/src ./packages/channels/src
COPY apps/feishu-connector/src ./apps/feishu-connector/src
RUN pnpm --filter "@use-brian/feishu-connector..." run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/channels/package.json ./packages/channels/
COPY apps/feishu-connector/package.json ./apps/feishu-connector/
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/packages/channels/dist ./packages/channels/dist
COPY --from=build /app/apps/feishu-connector/dist ./apps/feishu-connector/dist

EXPOSE 8080
CMD ["node", "apps/feishu-connector/dist/index.js"]
