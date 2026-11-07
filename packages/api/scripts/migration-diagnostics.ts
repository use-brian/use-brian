import pg from 'pg'
import { performance } from 'node:perf_hooks'

/** [COMP:api/migration-diagnostics] Metadata-only observation, never migration authority. */
type MigrationPhase = 'migration_lock' | 'ledger' | 'recovery' | 'prepare' | 'apply'
type Phase = { phase: MigrationPhase; file?: string; started: number }
type Blocker = { pid: number; state: string | null; transactionAgeMs: number | null }
type Observation = {
  state: string | null
  waitEventType: string | null
  waitEvent: string | null
  blockerPids: number[]
  blockers: Blocker[] | null
}

function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' && /^[A-Z0-9_]{3,32}$/.test(code) ? code : 'unknown'
}

export class MigrationDiagnostics {
  private active?: Phase
  private observer?: pg.Client
  private inFlight?: Promise<void>
  private stopped = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly databaseUrl: string, private readonly backendPid: number,
    private readonly options: { intervalMs?: number; write?: (event: Record<string, unknown>) => void } = {}) {
    this.timer = setInterval(() => {
      if (this.active && !this.inFlight && !this.stopped) {
        this.inFlight = this.poll().finally(() => { this.inFlight = undefined })
      }
    }, options.intervalMs ?? 10_000)
    this.timer.unref()
  }

  private emit(event: Record<string, unknown>): void {
    // Logging cannot replace a successful SQL result or its original error.
    try { (this.options.write ?? (value => console.log(`[migration] ${JSON.stringify(value)}`)))(event) } catch { /* diagnostic only */ }
  }

  start(phase: MigrationPhase, file?: string): void {
    this.active = { phase, file, started: performance.now() }
    this.emit({ event: 'migration_phase', phase, file, status: 'started', backendPid: this.backendPid })
  }

  finish(status = 'completed'): number {
    const phase = this.active
    if (!phase) return 0
    this.active = undefined
    const elapsedMs = Math.round(performance.now() - phase.started)
    this.emit({ event: 'migration_phase', phase: phase.phase, file: phase.file, status, elapsedMs, backendPid: this.backendPid })
    return elapsedMs
  }

  fail(error: unknown): void {
    const phase = this.active
    this.active = undefined
    this.emit({ event: 'migration_phase', phase: phase?.phase ?? 'setup', file: phase?.file,
      status: 'failed', elapsedMs: phase ? Math.round(performance.now() - phase.started) : undefined,
      backendPid: this.backendPid, errorCode: errorCode(error) })
  }

  private async connection(): Promise<pg.Client> {
    if (this.observer) return this.observer
    const observer = new pg.Client({ connectionString: this.databaseUrl,
      application_name: 'use-brian-migration-diagnostics', connectionTimeoutMillis: 3_000,
      query_timeout: 2_000, statement_timeout: 2_000 })
    // pg emits idle connection errors separately. The next poll will report and
    // discard the failed connection; it must not terminate the migration process.
    observer.on('error', () => {})
    this.observer = observer
    await observer.connect()
    return observer
  }

  private async closeObserver(): Promise<void> {
    const observer = this.observer
    this.observer = undefined
    if (observer) await observer.end().catch(() => {})
  }

  private async poll(): Promise<void> {
    const phase = this.active
    if (!phase) return
    try {
      const observer = await this.connection()
      const { rows } = await observer.query<Observation>(`SELECT a.state,
        a.wait_event_type AS "waitEventType",a.wait_event AS "waitEvent",
        pg_blocking_pids(a.pid) AS "blockerPids",
        (SELECT jsonb_agg(jsonb_build_object('pid',b.pid,'state',b.state,
          'transactionAgeMs',CASE WHEN b.xact_start IS NULL THEN NULL ELSE
            greatest(0,floor(extract(epoch FROM (clock_timestamp()-b.xact_start))*1000)) END)
          ORDER BY b.pid) FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid))) AS blockers
        FROM pg_stat_activity a WHERE a.pid=$1 AND a.datname=current_database()`, [this.backendPid])
      if (this.stopped || this.active !== phase) return
      this.emit({ event: rows.length ? 'migration_progress' : 'migration_observation_unavailable',
        phase: phase.phase, file: phase.file, elapsedMs: Math.round(performance.now() - phase.started),
        backendPid: this.backendPid, ...(rows[0] ?? { reason: 'backend_not_found' }) })
    } catch (error) {
      if (!this.stopped && this.active === phase) {
        this.emit({ event: 'migration_observation_unavailable', phase: phase.phase, file: phase.file,
          elapsedMs: Math.round(performance.now() - phase.started), backendPid: this.backendPid,
          reason: 'observer_error', errorCode: errorCode(error) })
      }
      await this.closeObserver()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.active = undefined
    clearInterval(this.timer)
    await this.inFlight
    await this.closeObserver()
  }
}
