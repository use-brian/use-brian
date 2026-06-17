# @sidanclaw/api — library

HTTP-layer library. Owns the database client, auth primitives, the `pg` pool, route builders, and the MCP/knowledge/registry/scheduling glue. **Does not boot a server** — that's the job of `apps/api` (user traffic) and `apps/api-admin` (admin analytics). Both apps import route factories and stores from this package.

**Read this first when entering this package.** Project-wide rules in the root `CLAUDE.md`.

## Consumers

| App | Imports | Purpose |
|---|---|---|
| `apps/api` | all non-admin route builders, all stores, `requireAuth`/`optionalAuth`, workers | User traffic Cloud Run service (`sidanclaw-api`) |
| `apps/api-admin` | `admin-*` route builders, relevant stores, `requireAdminKey` | Admin analytics Cloud Run service (`sidanclaw-api-admin`) |

## Layout

```
packages/api/src/
├── auth/                # jwt.ts (HS256, no external lib), middleware.ts (requireAuth, optionalAuth)
├── billing/             # stripe-client.ts — getStripe() singleton + Price ID lookup
├── db/                  # client.ts (pg pool + queryWithRLS), per-table store modules
├── scheduling/          # executor.ts — JobExecutor factory for createPollWorker
└── routes/              # auth, chat, sessions, telegram, slack, integrations, mcp, files,
                         # usage, feedback, analytics, account
packages/api/migrations/ # 001_initial_schema.sql ... 009_stripe_subscriptions.sql
```

## Architecture docs

| Area | Doc |
|---|---|
| Auth (Google OAuth, JWT, Telegram auto-create) | `docs/architecture/platform/auth.md` |
| Telegram Mini App onramp (`/start` → WebApp → Google OAuth) | `docs/architecture/channels/telegram-mini-app.md` |
| Database schema (18 tables, RLS, all migrations) | `docs/architecture/platform/database-schema.md` |
| Sessions (route + db helpers) | `docs/architecture/context-engine/session-messages.md` |
| Chat route (caller of `queryLoop`) | `docs/architecture/engine/query-loop.md` |
| MCP route | `docs/architecture/integrations/mcp.md` |
| Files route | `docs/architecture/engine/file-handling.md` |
| Usage / billing | `docs/architecture/platform/cost-and-pricing.md` |
| Analytics | `docs/architecture/platform/analytics.md` |

## DB / RLS rule

RLS is **role-based** (migration `269_two_role_rls.sql`). Two pools in `packages/api/src/db/client.ts`, both singletons — don't construct your own:

- **`getAppPool()` / `queryWithRLS(userId, sql, values)`** — the non-owner `app_user` role, **subject to RLS**. Use for any access *on behalf of a specific user*. It runs `BEGIN` / `SET LOCAL app.current_user_id = <userId>` / `COMMIT` so the `*_own` / `*_workspace_member` / clearance policies confine it.
- **`getPool()` / `query()`** — the table **owner** role, **bypasses RLS** (`FORCE` is dropped). Use for system operations: user creation, auth lookups before a session exists, scheduler/workers, analytics, **and admin / cross-member operations** where the per-user policy would hide the rows the admin must touch (the route does the authz).

**Classification is the rule.** Acting as one user → app pool. Trusted system, or touching *another* user's rows (admin grants, member management) → system pool. There is **no `app.system_bypass` GUC** — "system access" is the role, not a mutable connection setting. If you reach for `query()` from a user-facing route handler that should be scoped to the caller, you're skipping RLS — use `queryWithRLS`.

### Manual-transaction stores

When a user-scoped helper needs a multi-statement transaction (so `queryWithRLS` isn't enough): check out from the **app pool**, `BEGIN`, `SET LOCAL app.current_user_id` (the connect-seed gives it a valid sentinel to revert to), do the work, `COMMIT`, and `rollbackAndRelease` in `finally`:

```ts
const client = await getAppPool().connect()
try {
  await client.query('BEGIN')
  await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
  // ... work ...
  await client.query('COMMIT')
} finally {
  await rollbackAndRelease(client)   // ROLLBACK any dangling tx + release
}
```

System manual-tx stores (cross-workspace drains, audit writes, admin grants) check out from `getPool()` (owner, bypasses RLS) instead — no GUC at all.

**Validation triggers + self-referential policies must be `SECURITY DEFINER`.** A trigger that validates a cross-row invariant (e.g. `*_workspace_match` checking an FK target's workspace), or a policy that references its own table, cannot run RLS-confined — it won't see the rows it needs and either silently passes (open guard) or recurses (`42P17`). Own such a function as the table owner with `SECURITY DEFINER SET search_path = public, pg_temp` so it bypasses RLS (migrations `270` / `271`; helper `app_is_assistant_member`).

> **History — why role-based replaced the GUC.** The old model forced RLS on the owner and flipped enforcement with an `app.system_bypass` GUC. Because that's mutable state on a pooled connection, a connection returned at `system_bypass = ''` silently broke the next caller — bare reads filtered to zero rows (2026-06 scheduler stall), bare writes threw `new row violates row-level security policy` (2026-04-26, and the 2026-06-11 `session_messages` failures on workflow consults). Iterative fixes (`restoreBypassAndRelease`, `SET LOCAL` scoping, a `seedSessionRlsGucs` connect-seed for the Cloud-SQL `SET LOCAL`-reverts-to-`''` quirk) hardened it but never removed the hazard. The two-role model deletes the GUC: enforcement is the role, so it can't leak across a pooled connection. Full spec + rollout runbook: `docs/architecture/platform/database-schema.md` → "RLS bypass + connection state".

## Stores

Each table has a small store module in `db/`:

| Store | Table |
|---|---|
| `users.ts` | `users`, `assistants`, `assistant_members` |
| `sessions.ts` | `sessions`, `session_messages` |
| `memories.ts`, `memory-store.ts` | `memories` |
| `tasks.ts`, `tasks-store.ts` | `tasks` (Q1 company-brain primitive — see `docs/architecture/features/tasks.md`) |
| `crm.ts`, `crm-store.ts` | `companies`, `contacts`, `deals` (Q2 company-brain primitive — see `docs/architecture/features/crm.md`) |
| `workflow-store.ts` | `workflows`, `workflow_runs`, `workflow_step_runs` (Q4 Phase A company-brain primitive — see `docs/architecture/features/workflow.md`). Two factories: `createDbWorkflowStore()` (RLS-gated definitions, plus the system-bypass reads `findByWebhookSlugSystem` for the public webhook receiver and `findByIdSystem` for the workflow executor on scheduled-trigger / wait-wakeup runs — `triggered_by` is null by spec, so the RLS-gated `getById` has no per-user context) and `createDbWorkflowRunStore()` (system-level run/step run mutations + RLS-gated reads). |
| `session-state-queries.ts`, `session-state-store.ts` | `session_state` (see `docs/architecture/context-engine/session-state.md`) |
| `cache-store.ts` | `tool_result_cache` |
| `file-store.ts` | `file_cache` |
| `job-store.ts` | `scheduled_jobs` |
| `usage-store.ts` | `usage_tracking`, `daily_usage`, `usage_sessions`, `credit_balances` |
| `analytics-store.ts` | `analytics_events` |
| `mcp-settings-store.ts` | `mcp_tool_settings` |
| `channel-integrations.ts` | `channel_integrations` — **owns AES-256-GCM encryption** of the stored bot credentials. Call `loadChannelCredentialKey(env.CHANNEL_CREDENTIAL_KEY)` at boot and pass the resulting Buffer into `createDbChannelIntegrationStore(key)`. |
| `feed-store.ts` | `distribution_profiles` (table name retained from earlier schema) — one row per `kind='app'` assistant with an active connection. Enforces the eligibility triple (`kind='app'` ∧ `workspace_id` ∧ `clearance='public'`) in `createProfile` / `upsert`. See `docs/architecture/feed/README.md`. |
| `feed-events-store.ts` | `distribution_events` (table name retained) — append-only audit log for the feed defense pipeline. Writers are system-level (pipeline layers, tool executions); readers are workspace-scoped via RLS. `countRecentSystem` backs the Threads 250/day rate-limit pre-check. |

These implement the interfaces declared in `@sidanclaw/core` (e.g. `MemoryStore`, `CacheStore`, `JobStore`, `FileStore`, `UsageStore`, `McpSettingsStore`). The core never imports `pg` — that boundary is load-bearing for testability.

## Routes

Route builders live under `packages/api/src/routes/` and are mounted by the consuming app. User routes are mounted in `apps/api/src/index.ts`; admin routes (`admin-*`) are mounted in `apps/api-admin/src/index.ts`. Pattern:

```typescript
// apps/api
app.use('/api/sessions', requireAuth(jwtSecret), sessionsRouter)
app.use('/api/chat',     optionalAuth(jwtSecret), chatRouter)        // accepts guests
app.use('/api/auth',     authRouter)                                  // unauthenticated
app.use('/api/telegram', telegramWebhookRouter)                       // verified by header

// apps/api-admin
app.use('/api/analytics/admin', requireAdminKey(adminKey), adminAnalyticsRouter)
```

`requireAuth` rejects with 401 on missing/invalid token. `optionalAuth` extracts `req.userId` if present but doesn't reject — use this for routes that should serve both authenticated and guest traffic. `requireAdminKey` validates `X-Admin-Key` header.

**Rule:** never mount an `admin-*` route in `apps/api`, and never mount a user route in `apps/api-admin`. If you're unsure, the route's auth middleware tells you: `requireAdminKey` → admin app, `requireAuth`/`optionalAuth` → user app.

## Feed (distribution)

Workspace-owned `kind='app'` assistants that publish to external platforms (Threads + X today). User-facing brand is **feed**; the underlying architecture pattern is "distribution" (the function category — same pattern reuses for any-platform publishing). The integration spans these surfaces under `packages/api/src/feed/`:

| File | Purpose |
|---|---|
| `routes/threads-oauth.ts` | `/api/threads-oauth/authorize` + `/callback`. HMAC-signed state, short→long-lived token exchange, upserts `distribution_profiles` + `channel_integrations` with encrypted `ThreadsCredentials`. |
| `routes/feed.ts` | `/api/distribution/:assistantId` CRUD — GET profile, PATCH `autoReplyMode` / `replyPolicy` / `enabled`, DELETE disconnect, `GET :id/events` for the audit log, **plus the approval queue: `GET /:id/approvals` lists pending drafts, `POST /:id/approvals/:eventId/approve` mints a `source='human'` approval token and posts via `buildFeedSendApi` (Threads + X), `POST /:id/approvals/:eventId/reject` appends a `blocked/draft-rejected` event to hide the draft from the queue**, plus the **published-content controls: `DELETE /:id/posts/:mediaId` takes a live post/reply down via `buildFeedSendApi` (Threads + X; platform resolved from the audit row, ownership-checked against this assistant's `post-created`/`posted-reply` audit rows), `POST /:id/saved-drafts/:eventId/remove` appends a `blocked/draft-removed` linker so a saved-draft row drops off the review surfaces without touching the platform**. Approve/reject/delete/remove are draft-permission gated; profile mutations are workspace-admin gated. The mount path stays `/api/distribution` for now to avoid breaking `apps/web` consumers; rename to `/api/feed` is a follow-up task. See `docs/architecture/feed/draft-sessions.md` → "Deleting published content". |
| `routes/threads-webhook.ts` | `/webhook/threads` — Meta receiver. GET handles the `hub.mode=subscribe` verification challenge; POST verifies `X-Hub-Signature-256` against `THREADS_CLIENT_SECRET` using the raw body captured by the global `express.json` verify hook, parses the event (both the legacy `entry[]` and production `values[]` envelopes) with a permissive Zod schema, resolves the target assistant by `platform_user_id`, upserts `external_entities`, and appends an event to `distribution_events` whose type is derived from `field` via `resolveEventType` (`replies`→`reply-received`, `mention*`→`mention-received`, `delete`→`post-deleted`, else `classified`). Actionable types (`reply-received`/`mention-received`) then run the shared `processReply` defense pipeline; the rest are audit-only. Acks in 200ms; processing runs in the background. **Threads webhooks don't carry `mentions`** — those come from `feed/threads-mention-poller.ts`. |
| `db/external-entity-store.ts` | `external_entities` — per-commenter identity. `upsertFromWebhook` is system-level (webhook has no userId), bumps `interaction_count` + `last_seen_at` each call. Reads (`getByPlatformUser`, `listForAssistant`) are workspace-scoped via RLS. Trust-tier writes are workspace-admin gated. |
| `feed/threads-api.ts` | `createThreadsApi()` — adapter that implements the `ThreadsApi` interface from `@sidanclaw/core`. Reads credentials from `channel_integrations`, calls the core Threads client, and appends to `distribution_events` on every tool invocation. |
| `feed/inject.ts` | `injectFeedTools()` — per-turn injector called from `chat.ts`. No-ops unless `assistant.kind='app'` and `assistant.appType='distribution'` and an active profile exists; then merges `threadsCreatePost` / `threadsDelete` / `threadsGetInsights` into the tool map. |
| `feed/token-refresh.ts` | Daily background worker. Decrypts each threads integration, refreshes tokens within 7 days of expiry, re-encrypts. Invalid-token errors log a warning and skip (user must re-connect). |
| `feed/twitter-reply-poller.ts` | X (Twitter) inbound-reply poller — X has no webhook on the Basic tier, so replies + @-mentions are pulled on a 5-min interval and pushed through the **same** `processReply` defense pipeline the Threads webhook uses. Carries the `PipelineReplyPoster`/`PipelineHider` adapters (wrappers over `createTwitterApi`). Per-profile cursor stored as a `poll-cursor` event on `distribution_events`. Started from `apps/api/src/index.ts` gated on `TWITTER_CLIENT_ID`/`TWITTER_CLIENT_SECRET`. See `docs/architecture/feed/twitter.md` → "Reply / mention ingestion — the poller". |
| `feed/threads-mention-poller.ts` | Threads @-mention poller — Meta's Threads webhooks deliver `replies` (and lifecycle) but **not** mentions, so `GET /me/mentions` is polled on a 5-min interval and each new mention pushed through the same `processReply` pipeline. Dedup via `hasRecentInboundSystem` (24h window — no persisted cursor; `/mentions` has no server-side `since`). Started from `apps/api/src/index.ts` inside the Threads-env-gated block. See `docs/architecture/feed/threads.md` → "Mentions — the poller". |
| `routes/feed-insights.ts` | `GET /:assistantId/threads/insights` + `GET /:assistantId/twitter/insights` — the engagement dashboard. Threads pulls Graph insights; X derives metrics from `public_metrics` on the account's own recent tweets (no followers time-series). SWR-cached. |

Mounting lives in `apps/api/src/index.ts`, gated on `CHANNEL_CREDENTIAL_KEY` + `THREADS_CLIENT_ID` + `THREADS_CLIENT_SECRET` (Threads routes + token-refresh worker + mention poller) and `TWITTER_CLIENT_ID` + `TWITTER_CLIENT_SECRET` (X OAuth route + token-refresh worker + reply poller) — if the relevant vars are absent, that platform's routes and workers are silently un-mounted. The L1 soul branch is in `routes/_prompt-builder.ts`'s `resolveLayer1Prompt()`; see `docs/architecture/feed/`.

## Adding a new migration

1. Create `packages/api/migrations/00N_<description>.sql` with `BEGIN; ... COMMIT;`.
2. **Don't edit `001_initial_schema.sql`** after the fact. Schema changes always go in a new file.
3. Update `docs/architecture/platform/database-schema.md` — add a row to the migration history table and amend the affected table's column list.
4. Touch the relevant `db/*.ts` store if a column the engine reads/writes changed.
5. Run the migration locally and verify `pnpm test` still passes.
6. Commit all of it together.

## Common gotchas

- **The `pg` types use snake_case columns**, but the store modules return camelCase via `column AS "camelName"` aliases. Stay consistent — TypeScript won't catch a mismatch because the result type is unknown until you cast it.
- **Don't put RLS-bypassing logic in routes.** Bypass should be confined to `db/users.ts` or other system-bootstrap stores.
- **Pool size is budgeted, not generous.** `PG_POOL_MAX` caps each pool (default `4` via `resolvePoolMax` — and every process runs TWO pools, system + app). Prod Cloud SQL is a `db-f1-micro` with `max_connections = 25` shared by four services; each deploy script sets its own `PG_POOL_MAX` per the fleet budget in `docs/architecture/platform/deployment.md`. Long-lived integration tests that don't release connections will deadlock fast at this size. Always `try { ... } finally { client.release() }`.
- **Migrations are not tracked.** There's no migration runner shipped — `packages/api/scripts/run-migrations.ts` (if you create one) is the place to add ordering. Today migrations are run manually.
