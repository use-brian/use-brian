import pg from 'pg'

let systemPool: pg.Pool | null = null
let appPool: pg.Pool | null = null

/**
 * The nil UUID. Seeded as the SESSION value of `app.current_user_id` on every
 * new **app-pool** connection (see `getAppPool`). It matches no real row, so the
 * user-scoped RLS policies treat it like "no user context" — minus the throw.
 */
const CURRENT_USER_ID_SENTINEL = '00000000-0000-0000-0000-000000000000'

/**
 * Per-POOL connection cap. Every process opens TWO pools (system + app, below),
 * so a process can hold up to `2 × resolvePoolMax(...)` connections. Prod Cloud
 * SQL is a db-f1-micro with `max_connections = 25`, shared by four services
 * (api, api-workers, api-admin, doc-sync) — see
 * docs/architecture/platform/deployment.md → "fleet-wide connection budget".
 * The fallback must therefore be small: a service whose deploy script forgets
 * `PG_POOL_MAX` must not be able to eat the fleet's slots (the 2026-06-12
 * brain-500s incident: doc-sync + api-admin ran an unbounded 120-per-pool
 * default and starved sidanclaw-api). Exported for tests.
 */
export function resolvePoolMax(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 4
}

const POOL_MAX = resolvePoolMax(process.env.PG_POOL_MAX)
const POOL_OPTS = { max: POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 }

/**
 * The **system pool** — connects as the table OWNER (`DATABASE_URL`). With
 * `FORCE ROW LEVEL SECURITY` dropped (migration 269), the owner **bypasses RLS
 * entirely**, so this pool is the system-access path: bare `query()`, the
 * scheduler/workers, and the system manual-transaction stores. There is no
 * `app.system_bypass` GUC anymore — "system access" means "this pool / this
 * role", not a mutable connection setting (which was the pool-contamination bug
 * class; see docs/architecture/platform/database-schema.md → "RLS bypass +
 * connection state").
 *
 * Kept named `getPool()` so every existing `getPool().connect()` system
 * checkout keeps working unchanged.
 */
export function getPool(): pg.Pool {
  if (!systemPool) {
    systemPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...POOL_OPTS })
  }
  return systemPool
}

/**
 * The **app pool** — connects as the non-owner `app_user` role
 * (`DATABASE_URL_APP`), which is SUBJECT to RLS. Backs `queryWithRLS` and the
 * user manual-transaction stores; the `*_own` / `*_workspace_member` / clearance
 * policies confine it via `app.current_user_id`. No bypass GUC is ever set here —
 * enforcement comes from the role, so a forgotten/mis-set GUC can no longer
 * silently disable it.
 *
 * If `DATABASE_URL_APP` is unset it falls back to `DATABASE_URL` (the owner) with
 * a loud warning — RLS is then NOT enforced, because the owner bypasses it. Any
 * real deployment MUST set `DATABASE_URL_APP` (the `app_user` connection string);
 * the fallback exists only so local/dev without the role still boots. See
 * docs/architecture/platform/database-schema.md → "Two-role rollout".
 */
export function getAppPool(): pg.Pool {
  if (!appPool) {
    const appUrl = process.env.DATABASE_URL_APP
    if (!appUrl) {
      console.warn(
        '[db] DATABASE_URL_APP is not set — the app pool is falling back to the OWNER connection, so ' +
          'RLS is NOT enforced on user-scoped queries. Set DATABASE_URL_APP (the app_user role) in any real ' +
          'deployment. See docs/architecture/platform/database-schema.md → "Two-role rollout".',
      )
    }
    appPool = new pg.Pool({ connectionString: appUrl ?? process.env.DATABASE_URL, ...POOL_OPTS })
    // Seed the nil-UUID sentinel for app.current_user_id on every app-pool
    // connection. On this Postgres, `SET LOCAL` of a custom `app.*` GUC reverts
    // to '' (empty string), not NULL, when the connection has no session-level
    // default (verified on prod + local). Without the seed, every `queryWithRLS`
    // commit would leave the connection at `current_user_id=''`, and the next
    // policy cast `current_setting('app.current_user_id', true)::uuid` -> ''::uuid
    // throws 22P02. The seed gives `SET LOCAL` a valid value to revert to. The
    // system pool never evaluates these policies (the owner bypasses RLS), so it
    // needs no seed.
    appPool.on('connect', seedCurrentUserIdSentinel)
  }
  return appPool
}

/**
 * Wired as the app pool's `connect` handler (see `getAppPool`). Seeds
 * `app.current_user_id` to the nil-UUID sentinel on a freshly connected client so
 * `SET LOCAL` reverts to it instead of `''`. Exported for tests.
 */
export function seedCurrentUserIdSentinel(client: pg.PoolClient): void {
  void client
    .query(`SET app.current_user_id = '${CURRENT_USER_ID_SENTINEL}'`)
    .catch((err) =>
      console.error('[db] failed to seed app.current_user_id sentinel on connect:', err),
    )
}

/**
 * ROLLBACK any transaction left open on a checked-out **app-pool** client and
 * release it. Used in the `finally` of the user manual-transaction stores.
 *
 * In the two-role model there is no `system_bypass` to restore: `current_user_id`
 * is `SET LOCAL` (Postgres reverts it at COMMIT/ROLLBACK to the seeded sentinel),
 * so the only cleanup is to roll back a dangling transaction (clearing locks) and
 * release. If even the ROLLBACK fails, the client is destroyed via `release(err)`
 * rather than returned to the pool in an aborted-transaction state.
 */
export async function rollbackAndRelease(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
    client.release()
  } catch (err) {
    client.release(err as Error)
  }
}

/**
 * Execute a query as the RLS-enforced `app_user` role, scoped to `userId`.
 *
 * Runs on the **app pool** inside a transaction with `SET LOCAL
 * app.current_user_id`, so the `*_own` / `*_workspace_member` / clearance
 * policies match the acting user. Enforcement comes from the non-owner role, not
 * from a session flag — there is no bypass GUC to leak. `current_user_id` is
 * `SET LOCAL`, so it reverts at transaction end to the seeded sentinel; no stale
 * UUID survives onto the pooled connection.
 */
export async function queryWithRLS<T extends pg.QueryResultRow>(
  userId: string,
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
    const result = await client.query<T>(text, values)
    await client.query('COMMIT')
    return result
  } finally {
    await rollbackAndRelease(client)
  }
}

/**
 * Execute a query on the **system pool** (owner role, bypasses RLS). For system
 * operations only: user creation, auth-provider lookups before a session exists,
 * scheduler/worker reads + writes, analytics, and the system manual-transaction
 * stores. Anything acting on behalf of a specific user must use `queryWithRLS`.
 */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, values)
}

/**
 * Pick the read path from the access context's `systemRead` flag: bare `query()`
 * (owner pool, RLS-open) for trusted non-member reads that rely solely on the
 * WHERE-clause predicate, or `queryWithRLS` (app pool, RLS-enforced) for a normal
 * member read. Used by the binding store reads so the anonymous public-share
 * render path (`buildPublicAccessContext`, `systemRead: true`) can read workspace
 * rows at `clearance:'public'` without being a member.
 *
 * SAFETY: the caller MUST have applied `buildAccessPredicate(ctx)` to the SQL —
 * that clause (workspace + clearance + compartments) is the only gate on the
 * systemRead path.
 */
export async function queryGated<T extends pg.QueryResultRow>(
  ctx: { systemRead?: boolean; userId: string },
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return ctx.systemRead ? query<T>(text, values) : queryWithRLS<T>(ctx.userId, text, values)
}
