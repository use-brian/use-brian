import pg from 'pg'
import { currentAgentAccess,currentAgentClearance,currentAgentCompartments,currentAgentProjectIds } from './agent-access-context.js'
export { runWithAgentAccess,runWithAgentClearance,currentAgentAccess,currentAgentClearance,currentAgentCompartments,currentAgentProjectIds } from './agent-access-context.js'
export type { AgentClearance } from './agent-access-context.js'
import { AsyncResource } from 'node:async_hooks'
import { captureTurnSqlScope, recordTurnSqlStatement, type SqlPoolLabel } from './turn-sql-accounting.js'

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
 * default and starved brian-api). Exported for tests.
 */
export function resolvePoolMax(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 4
}

const POOL_MAX = resolvePoolMax(process.env.PG_POOL_MAX)

/**
 * Per-CONNECTION `statement_timeout`, in milliseconds. The server-side half of
 * backend-lifetime enforcement (B1a — docs/plans/corpus-substrate-hardening.md
 * §3): a `PG_POOL_MAX` cap governs what a *live process* opens and says nothing
 * about a backend whose client container died mid-query. PostgreSQL does not
 * notice, and the backend runs on — the 2026-07-28 incident included a 33-hour
 * `INSERT`, and the gap between the budgeted 20 backends and the observed 24
 * was orphans. Only the server can reap those.
 *
 * Two values, chosen per service by the deploy script:
 *   - interactive pools (`brian-api`, `brian-doc-sync`, `brian-api-admin`) —
 *     **15s**. A user-facing query that runs longer has already failed the user;
 *     failing it loudly beats pinning a slot the fleet has no spare of.
 *   - the background lane (`brian-api-workers`) — **120s**, set via
 *     `PG_STATEMENT_TIMEOUT_MS` in `scripts/deploy-api-workers.sh`. Background
 *     work legitimately runs longer than a request, but not for hours.
 *
 * Set on the connection, never on the ROLE (D3): the system pool connects as
 * the table OWNER, which is also the migration identity, so a role-level
 * `statement_timeout` would cap `pnpm migrate` and `CREATE INDEX` too. Applying
 * it from `POOL_OPTS` scopes it to pooled traffic and leaves `psql` and the
 * migrate script alone.
 *
 * Delivered as a libpq startup option (`options: '-c statement_timeout=…'`)
 * rather than a `SET` from a pool `connect` handler, because the handler is
 * fire-and-forget: it races the checkout's first query (that race is exactly
 * why `getPool()` carries no sentinel seed). The startup packet applies the
 * setting before the connection is ever handed out.
 *
 * `0` disables it — the escape hatch for a self-host whose background work
 * genuinely needs an unbounded statement, and the fallback if a Postgres-
 * compatible target rejects the startup option. Exported for tests.
 */
/** Interactive lane (the default): a user-facing query gets 15s. */
export const INTERACTIVE_STATEMENT_TIMEOUT_MS = 15_000
/** Background lane: `scripts/deploy-api-workers.sh` sets this explicitly. */
export const BACKGROUND_STATEMENT_TIMEOUT_MS = 120_000

export function resolveStatementTimeoutMs(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return INTERACTIVE_STATEMENT_TIMEOUT_MS
  // Whole-string digits only. `parseInt` would read `12s` as 12 and a typo'd
  // unit would silently become a 12ms timeout that fails every query; garbage
  // falls back to the interactive value rather than to "unbounded", because a
  // typo must not restore the orphan-backend class either.
  if (!/^\d+$/.test(trimmed)) return INTERACTIVE_STATEMENT_TIMEOUT_MS
  return Number(trimmed)
}

const STATEMENT_TIMEOUT_MS = resolveStatementTimeoutMs(process.env.PG_STATEMENT_TIMEOUT_MS)

// `connectionTimeoutMillis` is how long a checkout waits in the pool's queue
// when all `max` connections are busy before it throws `timeout exceeded when
// trying to connect`. Bumped 5s → 8s (2026-06-29) so a brief burst rides out as
// added latency instead of a dropped request — pg.Pool already queues waiters;
// this just extends their patience. Kept modest on purpose: this is a shared,
// fleet-wide knob (both pools, every service + code path), so a larger value
// would also slow failure detection during a real outage and stack onto
// synchronous HTTP request timeouts. See docs/architecture/platform/deployment.md
// → "fleet-wide connection budget".
const POOL_OPTS = {
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  // Rides the libpq startup packet (see resolveStatementTimeoutMs). Both pools
  // in a process share the lane, and PG_SINGLE_CONNECTION's one pool inherits
  // the interactive value along with everything else — there is no second lane
  // to give it.
  ...(STATEMENT_TIMEOUT_MS > 0
    ? { options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}` }
    : {}),
}

/**
 * Single-connection mode for the embedded PGLite brain (the OSS local default).
 *
 * PGLite is ONE in-process WASM instance with a single backend session shared
 * across every wire connection. node-postgres drives each parameterized query
 * through the session's UNNAMED prepared statement (Parse→Bind→Execute), so two
 * concurrent connections clobber that one slot — surfacing as 26000 "unnamed
 * prepared statement does not exist" and 08P01 "bind ... requires N". With the
 * default two pools at `max:4` the api opens up to 8 connections, and the home
 * dock / workers fan out enough concurrent reads to hit it constantly.
 *
 * When the launcher boots the embedded brain it sets `PG_SINGLE_CONNECTION=1`;
 * we then route BOTH pool getters at a single `max:1` pool so all DB access
 * serializes. PGLite already serializes every query on its one connection (see
 * oss-local-brain-wedge.md §12.4 "collapse client.ts to one connection" + §198
 * single-writer), so this costs no throughput — it only removes the clobber.
 *
 * Hosted (two-role, `DATABASE_URL_APP` set) and the local-Postgres-container
 * escape hatch leave this unset and keep the full two-pool / multi-connection
 * behavior — a real Postgres isolates the unnamed statement per connection and
 * has no such contention.
 */
const SINGLE_CONNECTION = process.env.PG_SINGLE_CONNECTION === '1'

/**
 * Attach a pool-level `error` listener. `pg.Pool` re-emits a connection-level
 * `error` (a backend that dies, or a protocol desync) on the Pool itself; with
 * NO listener, Node treats it as an unhandled `'error'` event and crashes the
 * process. This bit the embedded PGLite single-connection mode: a query against
 * a missing relation (e.g. the closed `connector_instance` table) makes the
 * PGLiteSocketServer send an unexpected `commandComplete`, which pg surfaces as
 * a fatal Client error and took the whole api down. Logging it keeps the pool
 * alive — the bad client is discarded and the next checkout reconnects.
 */
function attachPoolErrorHandler(pool: pg.Pool, label: string): void {
  pool.on('error', (err) => {
    console.error(`[db] idle client error on ${label} pool (recovered, not fatal):`, err.message)
  })
}

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
    const max = SINGLE_CONNECTION ? 1 : POOL_MAX
    systemPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...POOL_OPTS, max })
    attachPoolErrorHandler(systemPool, 'system')
    // Commit-outcome tracking + opt-in per-turn SQL accounting on every
    // connection (see instrumentPoolClient). Single-connection mode serves
    // both roles from this pool, so its statements are labelled `single`.
    attachClientInstrumentation(systemPool, SINGLE_CONNECTION ? 'single' : 'system')
    // No app.current_user_id sentinel seed here — this is the table OWNER
    // connection, and no table sets FORCE ROW LEVEL SECURITY, so the owner
    // bypasses RLS: the `current_setting('app.current_user_id')::uuid` casts in
    // the policies are never evaluated, so the `''` revert that the seed guards
    // against on the app_user pool cannot throw 22P02 here. (Seeding it via a
    // fire-and-forget connect handler also raced the first query on the single
    // connection, tripping pg's "already executing a query" deprecation.)
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
 * If `DATABASE_URL_APP` is unset: in a production environment (`NODE_ENV ===
 * 'production'` or Cloud Run's `K_SERVICE`) this THROWS — falling back to the
 * owner connection would silently disable RLS on user-scoped queries. Outside
 * production it falls back to `DATABASE_URL` (the owner) with a loud warning,
 * so local/dev without the `app_user` role still boots. See
 * docs/architecture/platform/database-schema.md → "Two-role rollout".
 */
export function getAppPool(): pg.Pool {
  // Single-connection mode (embedded PGLite): collapse onto the one system pool
  // so every query serializes through a single wire connection. RLS is retained
  // single-role (owner connection), satisfied by the auto-provisioned
  // workspace + membership — see oss-local-brain-wedge.md §12.4.
  if (SINGLE_CONNECTION) return getPool()
  if (!appPool) {
    const appUrl = process.env.DATABASE_URL_APP
    if (!appUrl) {
      // Fail closed in production: the owner connection bypasses RLS, so
      // running user-scoped queries on it silently disables tenant/member
      // isolation. `K_SERVICE` marks any Cloud Run service; `NODE_ENV`
      // covers other deployment targets. Local/dev keeps the loud warn +
      // fallback so a checkout without the app_user role still boots.
      if (process.env.NODE_ENV === 'production' || process.env.K_SERVICE) {
        throw new Error(
          '[db] DATABASE_URL_APP is not set in a production environment — refusing to fall back to ' +
            'the OWNER connection (RLS would be silently disabled on user-scoped queries). Set ' +
            'DATABASE_URL_APP to the app_user role connection string. See ' +
            'docs/architecture/platform/database-schema.md → "Two-role rollout".',
        )
      }
      console.warn(
        '[db] DATABASE_URL_APP is not set — the app pool is falling back to the OWNER connection, so ' +
          'RLS is NOT enforced on user-scoped queries. Set DATABASE_URL_APP (the app_user role) in any real ' +
          'deployment. See docs/architecture/platform/database-schema.md → "Two-role rollout".',
      )
    }
    appPool = new pg.Pool({ connectionString: appUrl ?? process.env.DATABASE_URL, ...POOL_OPTS })
    attachPoolErrorHandler(appPool, 'app')
    // Installed before the sentinel seed so the seed statement is observed too.
    attachClientInstrumentation(appPool, 'app')
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

type InstrumentableClient = pg.PoolClient & {
  getTransactionStatus?: () => string | null
  readyForQuery?: boolean
  _queryable?: boolean
  _ending?: boolean
}

const INSTRUMENTED = Symbol.for('use-brian.db.pool-client-instrumented')
/** Checkouts whose COMMIT was rejected: the outcome is uncertain, so the connection is destroyed. */
const uncertainCommits = new WeakMap<object, Error>()
const COMMIT_STATEMENT = /^\s*(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?\s*;?\s*$/i

function isCommitStatement(text: unknown): boolean {
  return typeof text === 'string' && text.length <= 40 && COMMIT_STATEMENT.test(text)
}

function markCommitUncertain(client: object, err: unknown): void {
  if (!uncertainCommits.has(client)) {
    uncertainCommits.set(client, err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Instrument every connection a pool opens, and clear a stale uncertain-commit
 * mark at each checkout (a caller that released without `rollbackAndRelease`
 * must not make the next, unrelated checkout destroy a healthy connection).
 */
function attachClientInstrumentation(pool: pg.Pool, label: SqlPoolLabel): void {
  pool.on('connect', (client) => instrumentPoolClient(client, label))
  pool.on('acquire', (client) => { uncertainCommits.delete(client) })
  bindPoolConnectContext(pool)
}

/**
 * Run a callback-form `pool.connect` callback in the requester's async
 * context. pg-pool hands a waiting checkout the client from inside the
 * releasing caller's `release()`, so `pool.query` (which uses the callback
 * form) would otherwise submit its statement in the releaser's context and
 * per-turn accounting would charge it to the wrong frame. The prototype's
 * `connect` is looked up per call so prototype spies keep working; a pool
 * whose `connect` is an own property (a test double) is left alone.
 * Exported for tests.
 */
export function bindPoolConnectContext(pool: pg.Pool): void {
  const target = pool as unknown as Record<PropertyKey, unknown>
  if (Object.prototype.hasOwnProperty.call(target, 'connect') || target[INSTRUMENTED]) return
  target[INSTRUMENTED] = true
  target.connect = function (this: pg.Pool, ...args: unknown[]): unknown {
    const original = Object.getPrototypeOf(pool).connect as (...a: unknown[]) => unknown
    if (typeof args[0] === 'function') args[0] = AsyncResource.bind(args[0] as (...a: unknown[]) => unknown)
    return Reflect.apply(original, this, args)
  }
}

/**
 * Wrap one pooled connection's `query` (installed from both pools' `connect`
 * handlers; idempotent). Every statement is forwarded unchanged to the
 * prototype's current `query`, so callback, promise and config overloads and
 * test spies on `pg.Client.prototype.query` keep working. It observes two
 * things: a rejected `COMMIT`/`END`, which marks the checkout's commit
 * outcome uncertain for `rollbackAndRelease`; and, only while per-turn SQL
 * accounting is enabled and a frame is active, each statement's completion
 * for `recordTurnSqlStatement` (no parameter values, no raw text retained).
 * Submittables (cursors, streams) pass straight through. Exported for tests.
 */
export function instrumentPoolClient(client: pg.PoolClient | pg.Client, pool: SqlPoolLabel): void {
  const target = client as unknown as Record<PropertyKey, unknown>
  if (target[INSTRUMENTED]) return
  target[INSTRUMENTED] = true
  // An instance-level `query` (a test double) is wrapped as-is; otherwise the
  // prototype's method is looked up per call so later prototype spies apply.
  const own = Object.prototype.hasOwnProperty.call(target, 'query') ? target.query as (...a: unknown[]) => unknown : undefined
  const instrumentedQuery = function (this: object, ...args: unknown[]): unknown {
    const original = own ?? (Object.getPrototypeOf(client).query as (...a: unknown[]) => unknown)
    const forward = () => Reflect.apply(original, this, args)
    const first = args[0] as { text?: unknown; values?: unknown; submit?: unknown; callback?: unknown } | string | undefined
    if (first !== null && typeof first === 'object' && typeof first.submit === 'function') return forward()
    const text = typeof first === 'string' ? first : first?.text
    const commit = isCommitStatement(text)
    // Attribution is fixed at submission: a callback completion arrives from
    // the connection's socket, in whatever async context opened it.
    const scope = typeof text === 'string' ? captureTurnSqlScope() : undefined
    const record = scope !== undefined
    if (!commit && !record) return forward()
    const paramCount = Array.isArray(args[1]) ? args[1].length
      : first !== null && typeof first === 'object' && Array.isArray(first.values) ? first.values.length : 0
    const startedAt = performance.now()
    let settled = false
    const settle = (err: unknown) => {
      if (settled) return
      settled = true
      if (commit && err) markCommitUncertain(client, err)
      if (record) {
        try {
          recordTurnSqlStatement({ text: text as string, paramCount, pool, elapsedMs: performance.now() - startedAt, ok: !err }, scope)
        } catch { /* accounting must never fail a statement */ }
      }
    }
    const last = args.length - 1
    if (last >= 0 && typeof args[last] === 'function') {
      const callback = args[last] as (this: unknown, ...values: unknown[]) => unknown
      args[last] = function (this: unknown, ...values: unknown[]) {
        settle(values[0])
        return Reflect.apply(callback, this, values)
      }
      return forward()
    }
    if (first !== null && typeof first === 'object' && typeof first.callback === 'function') {
      const callback = first.callback as (this: unknown, ...values: unknown[]) => unknown
      args[0] = {
        ...first,
        callback(this: unknown, ...values: unknown[]) {
          settle(values[0])
          return Reflect.apply(callback, this, values)
        },
      }
      return forward()
    }
    let result: unknown
    try {
      result = forward()
    } catch (err) {
      settle(err)
      throw err
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      // Observe without changing what the caller awaits; the derived promise
      // handles its own rejection, so no unhandled-rejection is introduced.
      ;(result as Promise<unknown>).then(() => settle(null), (err: unknown) => settle(err ?? new Error('query failed')))
    }
    return result
  }
  target.query = instrumentedQuery
}

/**
 * What releasing a checked-out client must do, from the connection's own
 * protocol state (spec: database-schema.md → "Transaction completion and
 * release"). `getTransactionStatus()` is the last ReadyForQuery status; it is
 * trusted only while `readyForQuery` is true, because an error callback fires
 * before its ReadyForQuery arrives. Exported for tests.
 */
export function transactionReleaseDecision(client: pg.PoolClient): 'release' | 'rollback' | 'destroy' {
  const c = client as InstrumentableClient
  if (uncertainCommits.has(c)) return 'destroy'
  if (c._queryable === false || c._ending === true) return 'destroy'
  const status = typeof c.getTransactionStatus === 'function' ? c.getTransactionStatus() : undefined
  if (status === 'I' && c.readyForQuery === true) return 'release'
  return 'rollback'
}

/**
 * Finish a checked-out client's transaction and release it. Used in the
 * `finally` of every manual-transaction store and of `queryWithRLS`; the name
 * predates the committed-state contract and is kept for its callers.
 *
 * - Idle (the transaction committed, rolled back, or never began): release
 *   directly — no ROLLBACK round trip, no `no transaction in progress` warning.
 * - Unfinished, failed, statement in flight, or status unknown: ROLLBACK, then
 *   release; if the ROLLBACK fails, destroy the client via `release(err)`.
 * - COMMIT rejected on this checkout (uncertain outcome) or connection broken:
 *   destroy via `release(err)`; never return it to the pool.
 *
 * `current_user_id` and the agent settings are transaction-local, so nothing
 * else needs restoring. Never throws: cleanup must not shadow a caller error.
 */
export async function rollbackAndRelease(client: pg.PoolClient): Promise<void> {
  const decision = transactionReleaseDecision(client)
  if (decision === 'release') {
    client.release()
    return
  }
  if (decision === 'destroy') {
    const reason = uncertainCommits.get(client) ?? new Error('[db] connection broken; destroying pooled client')
    uncertainCommits.delete(client)
    client.release(reason)
    return
  }
  try {
    await client.query('ROLLBACK')
    client.release()
  } catch (err) {
    client.release(err as Error)
  }
}

/**
 * COMMIT the client's open transaction. If COMMIT itself throws, the outcome
 * is uncertain: the checkout is marked so `rollbackAndRelease` destroys the
 * connection instead of pooling it, and the error is rethrown to the caller.
 */
export async function commitTransaction(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('COMMIT')
  } catch (err) {
    markCommitUncertain(client, err)
    throw err
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
 *
 * Exactly four round trips on success (BEGIN, set_config, the statement,
 * COMMIT); after a successful COMMIT the client is released directly.
 */
export async function queryWithRLS<T extends pg.QueryResultRow>(
  userId: string,
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return withRLSTransaction(userId, client => client.query<T>(text, values))
}

/** Keep data acquisition and source admission in the same ordinary app-role transaction. */
export async function withRLSTransaction<T>(
  userId: string,
  operation: (client: pg.PoolClient) => Promise<T>,
  verifiedAssistantId?: string,
): Promise<T> {
  const client = await getAppPool().connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId, verifiedAssistantId)
    const result = await operation(client)
    await commitTransaction(client)
    committed = true
    return result
  } finally {
    if (committed) client.release()
    else await rollbackAndRelease(client)
  }
}

/**
 * Set the RLS GUCs on an open transaction: `app.current_user_id` always, and
 * `app.agent_clearance` when the call runs inside an assistant execution wrap
 * (`runWithAgentClearance`). Stores that manage their own `BEGIN`/`COMMIT`
 * must call this instead of hand-writing the `SET LOCAL`, or the agent leg of
 * the `saved_views` policy silently never applies on their path. Both are
 * `SET LOCAL`, so they revert at transaction end.
 */
export async function applyRLSGucs(
  client: pg.PoolClient,
  userId: string,
  verifiedAssistantId?: string,
): Promise<void> {
  const settings = rlsGucSettings(userId, verifiedAssistantId)
  await client.query('SELECT set_config(setting.name, setting.value, true) FROM unnest($1::text[], $2::text[]) AS setting(name, value)',
    [settings.map(([name]) => name), settings.map(([, value]) => value)])
}

/** Verified host context for a transaction or a single implicit-transaction read. */
export function rlsGucSettings(userId: string, verifiedAssistantId?: string): ReadonlyArray<readonly [string, string]> {
  const settings: Array<[string, string]> = [['app.current_user_id', userId]]
  const clearance = currentAgentClearance()
  if (clearance) settings.push(['app.agent_clearance', clearance])
  // Preserve JSON null (universe) versus [] (General), and leave omitted
  // settings alone when a caller narrows an existing transaction context.
  const compartments = currentAgentCompartments(), projects = currentAgentProjectIds()
  if (compartments !== undefined) settings.push(['app.agent_compartments', JSON.stringify(compartments)])
  if (projects !== undefined) settings.push(['app.agent_project_ids', JSON.stringify(projects)])
  const access = currentAgentAccess()
  if (access?.sharedAudience) settings.push(['app.agent_shared_audience', 'true'])
  if (access?.mutationCompartments !== undefined) settings.push(['app.agent_mutation_compartments', JSON.stringify(access.mutationCompartments)])
  if (access?.workspaceId !== undefined) settings.push(['app.agent_workspace_id', access.workspaceId])
  if (access?.userId !== undefined) settings.push(['app.agent_actor_id', access.userId])
  if (access?.visibilityAssistantIds !== undefined) settings.push(['app.agent_visibility_assistants', JSON.stringify(access.visibilityAssistantIds)])
  const v2 = access?.departmentRead
  if (v2) {
    if (v2.userId !== userId) throw new Error('access_actor_mismatch')
    settings.push(['app.v2_active', 'true'], ['app.v2_assistant_id', v2.assistantId ?? ''],
      ['app.v2_context_department', v2.contextDepartment ?? ''],
      ['app.v2_binding', v2.binding === null ? '' : JSON.stringify(v2.binding)], ['app.v2_cap', v2.cap ?? ''])
  }
  if (verifiedAssistantId !== undefined) {
    if (v2?.assistantId && v2.assistantId !== verifiedAssistantId) throw new Error('access_assistant_mismatch')
    const setting = settings.find(([name]) => name === 'app.v2_assistant_id')
    if (setting) setting[1] = verifiedAssistantId
    else settings.push(['app.v2_assistant_id', verifiedAssistantId])
  }
  return settings
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
