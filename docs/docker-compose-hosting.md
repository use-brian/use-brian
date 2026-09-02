# Docker Compose hosting

The same release tag must exist for all four application images. Each published
release supports both `linux/amd64` and `linux/arm64`; Docker pulls the matching
variant automatically.

### Next.js public URLs are build-time values

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_DOC_SYNC_URL` are compiled into the
app-web browser bundle. Setting them only in Compose cannot rewrite an already
built bundle. Before publishing the release used here, configure these GitHub
repository variables to match the deployment:

```text
NEXT_PUBLIC_API_URL=https://api.brian.example.com
NEXT_PUBLIC_DOC_SYNC_URL=wss://doc-sync.brian.example.com
```

The `API_HOST` and `DOC_SYNC_HOST` values in `.env.compose` must match them. If
one release image needs to support arbitrary domains, app-web will need a
runtime browser-configuration mechanism instead of `NEXT_PUBLIC_*` variables.

## Reverse proxy

You will need some sort of reverse proxy, like nginx with a conf file, or traefik.

```yaml
# Start with: docker compose --env-file .env.compose up -d
services:
  app-web:
    image: ghcr.io/use-brian/use-brian-app-web:${IMAGE_TAG:?Set IMAGE_TAG in .env.compose}
    restart: unless-stopped
    init: true
    environment:
      # Server-side requests stay on the private Compose network. Browser-side
      # URLs were compiled into this image when the release was published.
      INTERNAL_API_URL: http://api:4000
      API_URL: ${API_HOST:?Set API_HOST in .env.compose}
      APP_URL: ${APP_HOST:?Set APP_HOST in .env.compose}
      USEBRIAN_EDITION: oss
    depends_on:
      api:
        condition: service_healthy
      doc-sync:
        condition: service_healthy
    ports:
      - "127.0.0.1:${WEB_PORT:-3003}:3003"

  api:
    image: ghcr.io/use-brian/use-brian-api:${IMAGE_TAG:?Set IMAGE_TAG in .env.compose}
    restart: unless-stopped
    init: true
    env_file:
      # Put model-provider credentials and other optional settings here too.
      - .env.compose
    environment:
      DATABASE_URL: postgres://pglite:54329/postgres
      PG_SINGLE_CONNECTION: "1"
      JWT_SECRET: ${JWT_SECRET:?Set JWT_SECRET in .env.compose}
      DOC_SYNC_SECRET: ${DOC_SYNC_SECRET:?Set DOC_SYNC_SECRET in .env.compose}
      DOC_SYNC_URL: ws://doc-sync:8080
      API_URL: ${API_HOST:?Set API_HOST in .env.compose}
      APP_URL: ${APP_HOST:?Set APP_HOST in .env.compose}
      LOCAL_FILES_DIR: /data/files
      USEBRIAN_EDITION: oss
    depends_on:
      pglite:
        condition: service_healthy
    volumes:
      - app-files:/data/files
    ports:
      - "127.0.0.1:${API_PORT:-4000}:4000"

  pglite:
    image: ghcr.io/use-brian/use-brian-pglite:${IMAGE_TAG:?Set IMAGE_TAG in .env.compose}
    restart: unless-stopped
    init: true
    volumes:
      - pglite-data:/data/pglite
    expose:
      - "54329"

  doc-sync:
    image: ghcr.io/use-brian/doc-sync:${IMAGE_TAG:?Set IMAGE_TAG in .env.compose}
    restart: unless-stopped
    init: true
    environment:
      DATABASE_URL: postgres://pglite:54329/postgres
      PG_SINGLE_CONNECTION: "1"
      JWT_SECRET: ${JWT_SECRET:?Set JWT_SECRET in .env.compose}
      DOC_SYNC_SECRET: ${DOC_SYNC_SECRET:?Set DOC_SYNC_SECRET in .env.compose}
      API_INTERNAL_URL: http://api:4000
      PORT: "8080"
    depends_on:
      pglite:
        condition: service_healthy
      api:
        condition: service_healthy
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
    ports:
      - "127.0.0.1:${DOC_SYNC_PORT:-8080}:8080"

volumes:
  app-files:
  pglite-data:

```
