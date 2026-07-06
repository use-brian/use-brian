/**
 * Event run queue — the bounded drain behind event-triggered workflow runs.
 *
 * Event dispatch ENQUEUES (creates a `workflow_runs` row, status `pending` —
 * the row IS the queue entry) and never executes inline; this worker drains
 * pending runs at a bounded rate. Before it existed, dispatch awaited the
 * full multi-step executor inside the producer's write path, so a bulk event
 * burst (a 1000-task import, a connector backfill) spawned that many
 * concurrent LLM pipelines against the shared DB pool.
 *
 * Claiming is delegated to the injected `RunQueueStore` (concrete impl:
 * `packages/api/src/db/workflow-store.ts` → `claimNextPendingRunSystem`,
 * `FOR UPDATE SKIP LOCKED`), which encodes the fairness rules — per-workflow
 * serialization, per-workspace in-flight cap, lease reclaim, attempts cap.
 * The worker owns pacing only: a poll interval as the durable fallback, a
 * `nudge()` fast path producers call right after enqueueing (near-inline
 * latency in a quiet system), a bounded number of concurrently-advancing
 * runs per replica, and the stale-`running` reaper (re-queue crashed runs —
 * `advanceWorkflowRun` is re-entrant over persisted step state).
 *
 * Manual / webhook / scheduled / wait-wakeup paths still advance inline —
 * the queue governs the machine-paced event path only.
 *
 * Spec: docs/architecture/features/workflow.md → "Event run queue".
 *
 * [COMP:workflow/run-queue]
 */

/** A claimed pending run, ready to advance. */
export type ClaimedRun = {
  runId: string
  workflowId: string
  workspaceId: string
}

/**
 * The queue's persistence port (concrete impl in
 * `packages/api/src/db/workflow-store.ts`). All methods are system-level —
 * the queue has no acting user.
 */
export type RunQueueStore = {
  /**
   * Claim the oldest eligible `pending` run: stamp `claimed_at`, increment
   * `claim_attempts`, return it — or null when nothing is claimable.
   * Eligibility (evaluated in the claim query, `FOR UPDATE SKIP LOCKED`):
   * unclaimed or lease-expired; attempts below the cap; no sibling run of
   * the same workflow running or freshly claimed (per-workflow
   * serialization); workspace active-run count below `workspaceCap`.
   */
  claimNextPendingRunSystem(params: {
    leaseSeconds: number
    maxClaimAttempts: number
    workspaceCap: number
  }): Promise<ClaimedRun | null>
  /**
   * Fail `pending` runs whose lease expired with no attempts remaining —
   * nothing will ever claim them again, so fail them visibly
   * (`reason: 'run_queue_exhausted'`) instead of leaving invisible rows.
   * Returns the number failed.
   */
  failExhaustedPendingRunsSystem(params: {
    leaseSeconds: number
    maxClaimAttempts: number
  }): Promise<number>
  /**
   * Re-queue `running` runs whose `last_active_at` is older than the
   * staleness window (the executor bumps it on every step write — a stale
   * one lost its process). Attempts remaining → back to `pending` for a
   * fresh claim; exhausted → failed (`reason: 'run_queue_stale'`). Returns
   * the number touched. Also heals pre-queue crash-orphaned `running` runs.
   */
  requeueStaleRunningRunsSystem(params: {
    staleSeconds: number
    maxClaimAttempts: number
  }): Promise<number>
}

export type RunQueueWorkerDeps = {
  store: RunQueueStore
  /** Advance one run — `advanceWorkflowRun` bound to the executor deps. */
  advance: (runId: string) => Promise<unknown>
  /** Failure sink; the worker never throws out of a tick. */
  onError?: (err: unknown, ctx: { runId?: string }) => void
  /** Poll interval — the durable fallback behind `nudge()`. */
  intervalMs?: number
  /** Max runs this replica advances concurrently. */
  maxConcurrent?: number
  leaseSeconds?: number
  staleSeconds?: number
  maxClaimAttempts?: number
  workspaceCap?: number
}

export type RunQueueWorker = {
  start(): void
  stop(): void
  /** Fire-and-forget drain — producers call this right after enqueueing. */
  nudge(): void
  /** One drain pass: reap, then claim-and-advance up to capacity. */
  tick(): Promise<void>
}

export const RUN_QUEUE_DEFAULTS = {
  intervalMs: 15_000,
  /** Each run is a multi-step LLM pipeline; the bound protects the DB pool
   *  and provider rate limits, not CPU. */
  maxConcurrent: 5,
  /** Covers the claim→advance gap only (advance flips the run to `running`
   *  within its first store write). */
  leaseSeconds: 120,
  /** Must exceed the longest legal single step (the 300 s deep-tier
   *  consult) with a wide margin — every step write bumps
   *  `last_active_at`. */
  staleSeconds: 1_800,
  maxClaimAttempts: 3,
  workspaceCap: 3,
} as const

export function createRunQueueWorker(deps: RunQueueWorkerDeps): RunQueueWorker {
  const intervalMs = deps.intervalMs ?? RUN_QUEUE_DEFAULTS.intervalMs
  const maxConcurrent = deps.maxConcurrent ?? RUN_QUEUE_DEFAULTS.maxConcurrent
  const leaseSeconds = deps.leaseSeconds ?? RUN_QUEUE_DEFAULTS.leaseSeconds
  const staleSeconds = deps.staleSeconds ?? RUN_QUEUE_DEFAULTS.staleSeconds
  const maxClaimAttempts = deps.maxClaimAttempts ?? RUN_QUEUE_DEFAULTS.maxClaimAttempts
  const workspaceCap = deps.workspaceCap ?? RUN_QUEUE_DEFAULTS.workspaceCap
  const onError = deps.onError ?? (() => {})

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight = 0
  /** Serialize claim loops — concurrent nudges collapse into one pass plus
   *  one queued re-pass (so a nudge landing mid-pass is never lost). */
  let draining = false
  let repass = false

  async function reap(): Promise<void> {
    try {
      await deps.store.failExhaustedPendingRunsSystem({ leaseSeconds, maxClaimAttempts })
      await deps.store.requeueStaleRunningRunsSystem({ staleSeconds, maxClaimAttempts })
    } catch (err) {
      onError(err, {})
    }
  }

  async function drainOnce(): Promise<void> {
    while (inFlight < maxConcurrent) {
      let claimed: ClaimedRun | null
      try {
        claimed = await deps.store.claimNextPendingRunSystem({
          leaseSeconds,
          maxClaimAttempts,
          workspaceCap,
        })
      } catch (err) {
        onError(err, {})
        return
      }
      if (!claimed) return
      inFlight++
      const { runId } = claimed
      void deps
        .advance(runId)
        .catch((err) => onError(err, { runId }))
        .finally(() => {
          inFlight--
          // A finished run may unblock its workflow's next queued run
          // (per-workflow serialization) — pull it without waiting a tick.
          nudge()
        })
    }
  }

  async function tick(): Promise<void> {
    if (draining) {
      repass = true
      return
    }
    draining = true
    try {
      await reap()
      do {
        repass = false
        await drainOnce()
      } while (repass)
    } finally {
      draining = false
    }
  }

  function nudge(): void {
    void tick().catch((err) => onError(err, {}))
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(nudge, intervalMs)
      // unref so a lingering interval never holds a shutting-down process
      if (typeof timer.unref === 'function') timer.unref()
      nudge()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    nudge,
    tick,
  }
}
