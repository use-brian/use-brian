```yaml
services:
  pglite:
    image: ghcr.io/xes-software/use-brian-pglite:${IMAGE_TAG}
    restart: unless-stopped
    volumes:
      - pglite-data:/data/pglite
    expose:
      - "54329"

  api:
    image: ghcr.io/xes-software/use-brian-api:${IMAGE_TAG}
    environment:
      DATABASE_URL: postgres://pglite:54329/postgres
      PG_SINGLE_CONNECTION: "1"
    depends_on:
      pglite:
        condition: service_healthy

volumes:
  pglite-data:
```
