/** Read-only observer for an already verified disposable fixture bootstrap client.
 * Never pass an ambient/personal database connection. No query parameters or
 * application payloads are returned; statement shapes have literals removed. */
import { setTimeout as delay } from 'node:timers/promises'

const prefix = '/* m6-observer */ '
const shape = (sql) => sql.replace(/'(?:[^']|'')*'/g, '?').replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim()
const counters = ['calls', 'rows', 'execMs', 'sharedHits', 'sharedReads', 'tempReads', 'tempWrites']

export async function snapshotStatements(client) {
  const state = (await client.query(prefix + `SELECT current_setting('pg_stat_statements.track') AS track,
    dealloc::text, stats_reset::text AS reset,current_user::regrole::oid::text AS "observerUserId",
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS "observerSuperuser" FROM pg_stat_statements_info`)).rows[0]
  if (state?.track !== 'all') throw new Error('Observer requires complete nested-statement tracking')
  if (state.observerSuperuser !== true) throw new Error('Use the verified disposable bootstrap observer, separate from all product roles')
  const rows = (await client.query(prefix + `SELECT userid||':'||dbid||':'||queryid||':'||toplevel AS key,
    toplevel AS "topLevel", query AS shape, calls::float8, rows::float8, total_exec_time AS "execMs",
    shared_blks_hit::float8 AS "sharedHits", shared_blks_read::float8 AS "sharedReads",
    temp_blks_read::float8 AS "tempReads", temp_blks_written::float8 AS "tempWrites"
    FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND userid <> current_user::regrole::oid`)).rows
  return { recordedAt: new Date().toISOString(), ...state, statements: rows.map((r) => ({ ...r, shape: shape(r.shape) })) }
}

export function statementDelta(before, after) {
  if (before.dealloc !== after.dealloc || before.reset !== after.reset || before.observerUserId !== after.observerUserId) throw new Error('Statement inventory reset, evicted entries or observer identity changed')
  const prior = new Map(before.statements.map((r) => [r.key, r]))
  const statements = after.statements.map((r) => ({ ...r, ...Object.fromEntries(counters.map((k) => [k, r[k] - (prior.get(r.key)?.[k] ?? 0)])) })).filter((r) => r.calls > 0)
  if (statements.some((r) => counters.some((k) => r[k] < 0))) throw new Error('Statement counter decreased')
  const total = (topLevel) => Object.fromEntries(counters.map((k) => [k, statements.filter((r) => r.topLevel === topLevel).reduce((n, r) => n + r[k], 0)]))
  return { topLevel: total(true), nested: total(false), statements, excludedObserverUserId: before.observerUserId,
    limitation: 'Nested SQL statement executions only; inclusive execution times overlap. Inlining and policy primitive work require separate calibrated physical coverage.' }
}

export async function sampleLockWaits(client) {
  return (await client.query(prefix + `SELECT a.pid, a.backend_start::text AS "backendStartedAt",
    a.wait_event_type AS "waitType", a.wait_event AS "waitEvent",
    EXTRACT(epoch FROM clock_timestamp()-a.query_start)*1000 AS "queryAgeMs",
    (SELECT count(*)::int FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) AS "ungrantedLocks"
    FROM pg_stat_activity a WHERE a.datid=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND a.pid<>pg_backend_pid() AND a.state='active' AND a.wait_event_type='Lock'
    ORDER BY a.pid`)).rows
}

export async function measureSqlWindow({ client, action, idleMs, lockSampleMs = 20, workload }) {
  if (!workload || (!action && (!Number.isInteger(idleMs) || idleMs < 1 || idleMs > 60_000))) throw new Error('Named action or bounded idle interval required')
  if (!Number.isInteger(lockSampleMs) || lockSampleMs < 5 || lockSampleMs > 1000) throw new Error('Lock sampling interval must be 5–1000ms')
  const before = await snapshotStatements(client), samples = []
  let stopped = false, observerError
  const sampler = (async () => {
    while (!stopped) {
      try { samples.push({ at: new Date().toISOString(), waits: await sampleLockWaits(client) }) }
      catch (error) { observerError = error; break }
      await delay(lockSampleMs)
    }
  })()
  const startedAt = new Date().toISOString(), start = performance.now()
  let result, failure
  try { result = action ? await action() : await delay(idleMs) } catch (error) { failure = error }
  const finishedAt = new Date().toISOString(), elapsedMs = performance.now() - start
  stopped = true; await sampler
  if (observerError) throw observerError
  const after = await snapshotStatements(client)
  return { workload, startedAt, finishedAt, elapsedMs, requestedIdleMs: idleMs ?? null,
    sql: statementDelta(before, after), lockWaits: { intervalMs: lockSampleMs, samples,
      samplesWithWaits: samples.filter((s) => s.waits.length).length,
      limitation: 'Sampled lock waits, not exact lock-hold duration; waits shorter than the interval may be missed. Observer runs outside the measured application connection.' },
    result, ...(failure ? { failure: { name: failure.name, code: failure.code } } : {}) }
}
