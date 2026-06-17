# apps/doc-sync

The doc **realtime-collaboration sync service** — a dedicated, single-instance
Hocuspocus (Yjs) WebSocket server. It is the one authoritative in-memory holder
per live page document. Deployed to Cloud Run with `--min-instances=1
--max-instances=1 --no-cpu-throttling` (Yjs needs a single authoritative holder;
horizontal scale is a later `y-redis` backplane). **Read this first when entering
this package.** Project-wide rules in the root `CLAUDE.md`; the feature spec is
`docs/architecture/features/doc.md` → "Real-time collaboration".

## What it does

- **Authenticates** each WS connection (`auth-hook.ts` → `resolveAuth`): a valid
  end-user JWT (verified with the same `verifyAccessToken` as `apps/api`), or the
  privileged `DOC_SYNC_SECRET` for the server-side AI Yjs client.
- **Clearance-gates** end users (`clearance-gate.ts` → `assertPageAccess`): one
  RLS-scoped query compares the page's `saved_views.clearance` against the
  viewer's `workspace_members.clearance` via `canRead`. Below clearance, or not a
  member → the connection is refused (Lock #5).
- **Lazily persists** (`persistence.ts`): `onLoadDocument` reads
  `documents.ydoc` (or encodes an initial Y.Doc from the legacy
  `saved_views.page` for an unmigrated row); `onStoreDocument` (debounced ~2s /
  10s max) writes the binary + a derived `snapshot_json` block list + bumps `seq`,
  and mirrors the title to `saved_views.name`.

`index.ts` is the wiring (a plain `http` server for the `/health` probe + a `ws`
upgrade into `hocuspocus.handleConnection`, plus a SIGTERM flush of pending
stores). The three helper modules are pure + injectable, so they unit-test
without Hocuspocus or a DB (`[COMP:doc-sync/{auth,clearance-gate,persistence}]`).

## Boundaries

- Reuses `@sidanclaw/api` (`auth/jwt.js`, `db/client.js`) and `@sidanclaw/doc-model`
  (shared schema + encode). Does **not** boot the user API — it only serves the
  Yjs protocol + a health route.
- Reads `process.env` directly (`PORT`, `JWT_SECRET`, `DOC_SYNC_SECRET`,
  `DATABASE_URL`) rather than `getEnv()` — it has no need for the GEMINI/etc. vars
  `getEnv()` requires.
- Persistence runs as a **system** operation (bare `query()`, bypass) because the
  per-user authorization already happened at connect.

## Local dev

```
DATABASE_URL=postgresql://localhost:5432/sidanclaw JWT_SECRET=<dev> \
  pnpm --filter @sidanclaw/doc-sync dev
```

Point `apps/app-web` + `apps/api` at it via `DOC_SYNC_URL=ws://localhost:8080`.

## Deploy

`scripts/deploy-doc-sync.sh` (single-instance, secrets via Secret Manager).
Deploy the API side (migration 212 + the `apps/api` P2 changes) before flipping
`apps/app-web` to the Yjs client.
