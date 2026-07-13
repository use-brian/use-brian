/**
 * Goal stall reaper — the external watchdog for the acting loop.
 *
 * The driver's in-loop guards (tick error re-arm, the loud give-up ceiling)
 * cannot cover a process crash mid-tick: the single-flight claim flips
 * `active`→`running`, and if the process dies before the tick re-arms, the
 * goal is wedged — `running` is unclaimable (no re-trigger can flip it back)
 * and the re-arm chain is dead (the poll worker never retries a once-job).
 * The same dead-chain shape also arises for an `active` goal whose next tick
 * failed before the claim (or was killed by a pre-resilience bug — the
 * 2026-07-13 executor stall left every armed goal exactly here).
 *
 * Two sweeps, both keyed on "stale `updated_at` AND no enabled goal-tick job"
 * (a live chain always has a next enabled job — including the `until:event`
 * safety-net tick, so parked goals are skipped; a tick that is EXECUTING right
 * now keeps its job row enabled until the poll worker marks it, so an
 * in-flight iteration is never reaped):
 *
 *   1. `running` wedge — flipped back to `active` atomically (the flip is the
 *      claim, so concurrent sweepers recover a goal once) and re-armed.
 *   2. `active` dead chain — confirmed acting goals (means.workflowId set)
 *      only; drafts and no-means monitors are never touched. Re-armed as-is.
 *
 * Recovered ticks restart from a fresh loop state — the in-flight counters
 * died with the chain. Accepted (v1): cumulative spend/iteration restart per
 * recovered leg; the goal budget still bounds each leg and the durable spend
 * truth remains `usage_tracking`.
 *
 * Started on the workers boot path (`runWorkers`-gated), like the
 * stuck-session sweeper. Doc: docs/architecture/features/goals.md →
 * "Stall recovery — the goal reaper".
 *
 * [COMP:goals/reaper]
 */
import { query } from '../db/client.js'

/** Sweep cadence. Recovery within one interval is the SLA; 5 min keeps the
 *  sweep negligible next to the 60s poll worker. */
export const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000

/** Staleness threshold. Far above any legitimate single iteration (a tick's
 *  workflow advance is bounded well below Cloud Run's request cap) and above
 *  the max tick-error backoff (15 min) minus nothing — an errored goal's next
 *  job exists while it waits, so backoff waits are never reaped anyway. */
export const DEFAULT_STALE_MINUTES = 15

export type StalledGoal = { id: string; sweep: 'running_wedge' | 'dead_chain' }

/** `NOT EXISTS` guard shared by both sweeps: an enabled goal-tick job for this
 *  goal means the chain is alive (or a tick is executing right now). */
const NO_ENABLED_TICK = `NOT EXISTS (
  SELECT 1 FROM scheduled_jobs j
   WHERE j.enabled = true
     AND j.channel_type = 'workflow'
     AND j.channel_id = g.id::text
     AND j.instructions LIKE '{"kind":"goal_tick"%'
)`

/** Sweep 1: atomically reclaim wedged `running` goals (the UPDATE is the
 *  claim). Returns the reclaimed ids. */
async function reclaimWedgedRunning(staleMinutes: number): Promise<string[]> {
  const res = await query<{ id: string }>(
    `UPDATE goals g SET status = 'active'
      WHERE g.status = 'running'
        AND g.updated_at < now() - make_interval(mins => $1)
        AND ${NO_ENABLED_TICK}
      RETURNING g.id`,
    [staleMinutes],
  )
  return res.rows.map((r) => r.id)
}

/** Sweep 2: find confirmed acting goals whose re-arm chain is dead. */
async function findDeadChains(staleMinutes: number): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT g.id FROM goals g
      WHERE g.status = 'active'
        AND g.confirmed_at IS NOT NULL
        AND g.means->>'workflowId' IS NOT NULL
        AND g.updated_at < now() - make_interval(mins => $1)
        AND ${NO_ENABLED_TICK}`,
    [staleMinutes],
  )
  return res.rows.map((r) => r.id)
}

export type GoalStallReaperOptions = {
  /** Arm an immediate fresh-state tick for a recovered goal. Boot wires the
   *  driver's `scheduleGoalTick` port over a system read of the goal. */
  rearm: (goalId: string) => Promise<void>
  /** Fired once per recovered goal — boot wires a `goal_stall_recovered`
   *  analytics event. Best-effort; errors are swallowed. */
  onRecovered?: (goal: StalledGoal) => void
  intervalMs?: number
  staleMinutes?: number
  /** Test seams: default to the real SQL sweeps. */
  reclaimRunning?: (staleMinutes: number) => Promise<string[]>
  findDead?: (staleMinutes: number) => Promise<string[]>
  /** Test-only error hook. Defaults to `console.error`. */
  onError?: (err: unknown) => void
}

export function createGoalStallReaper(options: GoalStallReaperOptions) {
  const intervalMs = options.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES
  const reclaim = options.reclaimRunning ?? reclaimWedgedRunning
  const findDead = options.findDead ?? findDeadChains
  const onError = options.onError ?? ((err: unknown) => console.error('[goal-reaper] sweep failed:', err))

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function recover(id: string, sweep: StalledGoal['sweep']): Promise<void> {
    await options.rearm(id)
    console.warn(`[goal-reaper] recovered stalled goal ${id} (${sweep})`)
    try {
      options.onRecovered?.({ id, sweep })
    } catch {
      /* observability must never block recovery */
    }
  }

  async function sweepOnce(): Promise<StalledGoal[]> {
    const recovered: StalledGoal[] = []
    for (const id of await reclaim(staleMinutes)) {
      await recover(id, 'running_wedge')
      recovered.push({ id, sweep: 'running_wedge' })
    }
    for (const id of await findDead(staleMinutes)) {
      await recover(id, 'dead_chain')
      recovered.push({ id, sweep: 'dead_chain' })
    }
    return recovered
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      await sweepOnce()
    } catch (err) {
      onError(err)
    } finally {
      running = false
    }
  }

  return {
    /** One synchronous sweep pass — the test entrypoint. */
    sweepOnce,
    start() {
      if (timer) return
      console.log(`[goal-reaper] started (interval: ${intervalMs}ms, stale: ${staleMinutes}m)`)
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}
