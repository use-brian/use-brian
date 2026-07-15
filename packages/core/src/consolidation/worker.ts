/**
 * Consolidation worker — drives the Light / REM / Deep phases on a timer.
 *
 * Single-instance assumption, same as the scheduling poll worker: in a
 * multi-replica deployment this would need an advisory lock or a claim
 * step (`SELECT ... FOR UPDATE SKIP LOCKED`). None of that ships today.
 *
 * Cadence — enforced per user, not globally. A tick picks up users whose
 * last run of a given phase is older than its interval:
 *
 *   - Light:  every 6 hours
 *   - REM:    every 7 days
 *   - Deep:   every 24 hours
 *
 * The tick interval itself defaults to 15 minutes — frequent enough that
 * Deep work spreads across the day without coinciding with Light, cheap
 * enough that the query against `consolidation_logs` stays trivial.
 */

import type { MemoryStore } from '../memory/types.js'
import {
  runLightConsolidation,
  runREMConsolidation,
  runDeepConsolidation,
  runReflectionConsolidation,
  runTeamLightConsolidation,
  runTeamDeepConsolidation,
  runREMSkillUmbrella,
  runDeepSkillDecay,
  type ConsolidationEvent,
  type DeepConsolidationOptions,
} from './phases.js'
import type {
  SkillUmbrellaStore,
  SkillUmbrellaDigestStore,
  SkillUmbrellaEvent,
} from './skill-umbrella.js'
import type {
  SkillDecayStore,
  SkillDecayEvent,
} from './skill-decay.js'
import {
  runReclassification,
  filterMemoriesForReclassification,
  RECLASSIFICATION_DAILY_CAP,
  type MemoryForReclassification,
} from './reclassifier.js'
import type { BrainCandidateStore } from '../brain/candidates-types.js'
import type { EntityLinksStore, EntityStore } from '../entities/types.js'
import type { LLMProvider } from '../providers/types.js'
import type { TaskStore } from '../tasks/types.js'

/**
 * A consolidation event tagged with the user it fired for. The worker
 * wraps the phase-level `onEvent` hooks so the host (API server) gets
 * enough context to route the event into its analytics logger, which
 * requires a real user_id.
 */
export type ScopedConsolidationEvent = ConsolidationEvent & {
  assistantId: string
  userId: string
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000 // 15 min
const LIGHT_INTERVAL_MS = 6 * HOUR_MS
const REM_INTERVAL_MS = 7 * DAY_MS
const DEEP_INTERVAL_MS = DAY_MS
/** Reflection (correction-history learning) cadence — weekly, same as
 *  REM. Per-workspace; runs alongside team-Deep. */
const REFLECTION_INTERVAL_MS = 7 * DAY_MS

/**
 * Advisory lock ID for the consolidation worker. All instances use the same
 * key so only one can run the tick at a time. Chosen as a fixed integer
 * unlikely to collide with other application-level advisory locks.
 */
const CONSOLIDATION_LOCK_ID = 900_001

/**
 * Context passed to every `callModel` invocation so the app layer can
 * attribute Gemini usage back to a specific user + phase. Consolidation
 * has no user-facing session, so the recorded `usage_tracking` row uses
 * a NULL session_id (see migration 067).
 */
export type ConsolidationCallContext = {
  assistantId: string
  /** User ID for per-user phases (REM / Deep). Null for team phases. */
  userId: string | null
  /** Team ID for team phases. Null for per-user phases. */
  workspaceId: string | null
  phase: 'rem' | 'deep' | 'team-deep' | 'reflection'
}

export type ConsolidationCallModel = (
  prompt: string,
  ctx: ConsolidationCallContext,
) => Promise<string>

export type ConsolidationWorkerOptions = {
  store: MemoryStore
  /**
   * Called for every LLM request the REM + Deep phases need. The `ctx`
   * argument is threaded in by the worker so callers can record per-user
   * usage attribution (see `overhead:consolidation` in cost-tracker.ts).
   */
  callModel: ConsolidationCallModel
  /** How often the tick runs. Default 15 min. */
  intervalMs?: number
  /** Event hook — forwarded to every phase with assistant + user context. */
  onEvent?: (event: ScopedConsolidationEvent) => void
  /**
   * Optional deep-phase overrides (prune thresholds, domain summary
   * threshold, etc.). Applied to every user.
   */
  deepOptions?: Omit<DeepConsolidationOptions, 'onEvent' | 'appIds'>
  /**
   * Pluggable clock — tests inject a fake one so cadence gating can be
   * exercised without waiting for real elapsed time.
   */
  now?: () => Date
  /**
   * Error hook. Defaults to `console.error`. Tests replace it to assert
   * that per-user failures do not abort the tick.
   */
  onError?: (err: unknown, context: { phase: string; assistantId: string; userId: string }) => void
  /**
   * Workspace-scoped scope for S10 + CL-8 (the workstream-C
   * consolidation passes). Omit to opt out — the V2 substrate is gated
   * at the apps/api wiring layer, so production can enable this once
   * WS-A + WS-B finish rolling out.
   */
  workspaceCuratorScope?: WorkspaceCuratorScope
  /**
   * Optional reclassifier hook. When wired, the worker runs the brain
   * reclassifier (`runReclassification`) immediately after each
   * successful REM tick — auto-applying drop/task/edge actions and
   * enqueuing attribute candidates per Q5 of the brain-ingestion-
   * classification design thread. Gated per-workspace by
   * `workspaces.brain_extraction_v2_enabled`; the wiring layer
   * resolves the flag via `isV2Enabled`. Omit to disable the
   * auto-hook entirely (the chat-side `healMemories` path still
   * works independently).
   */
  reclassification?: ReclassificationScope
}

/**
 * Wiring for the REM-attached auto reclassifier (Q5 / Q8 of the
 * design thread). All ports come from the apps/api layer; the core
 * worker is deliberately ignorant of DB shapes.
 */
export type ReclassificationScope = {
  entityStore: EntityStore
  entityLinks: EntityLinksStore
  tasks: TaskStore
  candidates: BrainCandidateStore
  provider: LLMProvider
  /** Reclassifier model — Flash-class is fine. */
  model: string
  /** Resolve the workspaceId an assistant belongs to. Returns null
   *  when the assistant has no workspace partition (legacy rows). */
  resolveWorkspaceId(assistantId: string): Promise<string | null>
  /** Per-workspace flag check — `workspaces.brain_extraction_v2_enabled`
   *  (mig 199). Returning false short-circuits the reclassifier. */
  isV2Enabled(workspaceId: string): Promise<boolean>
}

/**
 * Workspace-scoped curator dependencies. The umbrella pass + decay
 * pass both operate per-workspace; the worker iterates the workspace
 * list returned by `listWorkspaces` and runs the passes on cadence.
 *
 * Per-workspace last-run timestamps live in the in-memory
 * `WorkspaceCuratorCadenceTracker` — chosen over a DB column on
 * `workspaces` because the trigger gates (>=20 skills, >=21d age,
 * >=1 cluster eligible) prevent rerun thrash across restarts, and a
 * single-instance worker rarely restarts mid-week.
 */
export type WorkspaceCuratorScope = {
  /** Enumerate workspaces eligible for the workspace-scoped curator
   *  passes (S10 + CL-8). The implementation lives in the wiring
   *  layer (`apps/api/src/index.ts`) and reads from `workspaces`. */
  listWorkspaces: () => Promise<Array<{ workspaceId: string; createdAt: Date }>>
  /** Embedding callback fed to S10 — Gemini batch embed in production. */
  getEmbeddings: (texts: string[]) => Promise<number[][]>
  /** WS-A `WorkspaceSkillStore`-shaped adapter for S10. */
  umbrellaStore: SkillUmbrellaStore
  /** WS-A digest store wrapped to the curator's narrower contract. */
  digestStore: SkillUmbrellaDigestStore
  /** WS-A `WorkspaceSkillStore`-shaped adapter for CL-8. */
  decayStore: SkillDecayStore
  /** Event hooks — analytics tap. Separate from the per-user
   *  `onEvent` because the payload shape differs. */
  onUmbrellaEvent?: (event: SkillUmbrellaEvent) => void
  onDecayEvent?: (event: SkillDecayEvent) => void
  /** Cadence — both passes run weekly by default. */
  umbrellaIntervalMs?: number
  decayIntervalMs?: number
  /** Cadence tracker; defaults to an in-memory map. */
  cadenceTracker?: WorkspaceCuratorCadenceTracker
}

/** Pluggable cadence tracker — production uses the default in-memory
 *  map; tests pass a frozen Date producer to drive deterministic runs. */
export type WorkspaceCuratorCadenceTracker = {
  getLastRun(workspaceId: string, phase: 'umbrella' | 'decay'): Date | null
  setLastRun(workspaceId: string, phase: 'umbrella' | 'decay', at: Date): void
}

function createInMemoryCadenceTracker(): WorkspaceCuratorCadenceTracker {
  const map = new Map<string, Date>()
  const key = (w: string, p: 'umbrella' | 'decay') => `${w}::${p}`
  return {
    getLastRun(workspaceId, phase) {
      return map.get(key(workspaceId, phase)) ?? null
    },
    setLastRun(workspaceId, phase, at) {
      map.set(key(workspaceId, phase), at)
    },
  }
}

const WORKSPACE_CURATOR_DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // weekly

export function createConsolidationWorker(options: ConsolidationWorkerOptions) {
  const {
    store,
    callModel,
    intervalMs = DEFAULT_TICK_INTERVAL_MS,
    onEvent,
    deepOptions,
    now = () => new Date(),
    onError = (err, ctx) => console.error(`[consolidation] ${ctx.phase} failed for ${ctx.assistantId}/${ctx.userId}:`, err),
    workspaceCuratorScope,
    reclassification,
  } = options

  // Resolve cadence tracker once; tests pass their own for determinism.
  const cadenceTracker =
    workspaceCuratorScope?.cadenceTracker ?? createInMemoryCadenceTracker()
  const umbrellaIntervalMs =
    workspaceCuratorScope?.umbrellaIntervalMs ?? WORKSPACE_CURATOR_DEFAULT_INTERVAL_MS
  const decayIntervalMs =
    workspaceCuratorScope?.decayIntervalMs ?? WORKSPACE_CURATOR_DEFAULT_INTERVAL_MS

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  /** The core tick logic, separated so it can be called directly or under a lock. */
  async function tickInner(): Promise<void> {
    const users = await store.listMemoryUsers()
    for (const { assistantId, userId } of users) {
      const scopedOnEvent = onEvent
        ? (event: ConsolidationEvent) => onEvent({ ...event, assistantId, userId })
        : undefined
      const [lastLight, lastREM, lastDeep] = await Promise.all([
        store.getLastPhaseAt(assistantId, userId, 'light'),
        store.getLastPhaseAt(assistantId, userId, 'rem'),
        store.getLastPhaseAt(assistantId, userId, 'deep'),
      ])
      const current = now()

      // Light is pure dedup + DB — free, always safe to run.
      if (isDue(lastLight, current, LIGHT_INTERVAL_MS)) {
        try {
          await runLightConsolidation(store, assistantId, userId, { onEvent: scopedOnEvent })
        } catch (err) {
          onError(err, { phase: 'light', assistantId, userId })
        }
      }

      // REM (weekly) + Deep (daily) call an LLM — gate on activity so we
      // don't burn tokens on ghost users. Only query the gate when at least
      // one phase is due; zero-activity users still skip the DB hit on
      // every tick.
      const remDue = isDue(lastREM, current, REM_INTERVAL_MS)
      const deepDue = isDue(lastDeep, current, DEEP_INTERVAL_MS)
      if (!remDue && !deepDue) continue

      const isActive = await store.hasRecentActivity(assistantId, userId)
      if (!isActive) continue

      if (remDue) {
        const remCall = (prompt: string) => callModel(prompt, { assistantId, userId, workspaceId: null, phase: 'rem' })
        try {
          await runREMConsolidation(store, assistantId, userId, remCall, { onEvent: scopedOnEvent })
        } catch (err) {
          onError(err, { phase: 'rem', assistantId, userId })
        }

        // Post-REM brain reclassification (Q5 / Q8 — self-healing).
        // Auto-applies drop/task/edge per the precedence ladder and
        // enqueues attribute candidates for user accept. Gated per-
        // workspace by `brain_extraction_v2_enabled`. Failures are
        // non-blocking — REM has already committed its own work.
        if (reclassification) {
          try {
            await runPostRemReclassification(
              store,
              assistantId,
              userId,
              reclassification,
            )
          } catch (err) {
            onError(err, { phase: 'rem', assistantId, userId })
          }
        }
      }

      if (deepDue) {
        const deepCall = (prompt: string) => callModel(prompt, { assistantId, userId, workspaceId: null, phase: 'deep' })
        try {
          await runDeepConsolidation(store, assistantId, userId, deepCall, {
            ...deepOptions,
            onEvent: scopedOnEvent,
          })
        } catch (err) {
          onError(err, { phase: 'deep', assistantId, userId })
        }
      }
    }

    // ── Team memory consolidation (Light + Deep + Reflection) ──
    const teamGroups = await store.listWorkspaceMemoryGroups()
    for (const { assistantId, workspaceId } of teamGroups) {
      const [lastTeamLight, lastTeamDeep, lastReflection] = await Promise.all([
        store.getLastWorkspacePhaseAt(assistantId, workspaceId, 'light'),
        store.getLastWorkspacePhaseAt(assistantId, workspaceId, 'deep'),
        store.getLastWorkspacePhaseAt(assistantId, workspaceId, 'reflection'),
      ])
      const current = now()

      if (isDue(lastTeamLight, current, LIGHT_INTERVAL_MS)) {
        try {
          await runTeamLightConsolidation(store, assistantId, workspaceId)
        } catch (err) {
          onError(err, { phase: 'light', assistantId, userId: workspaceId })
        }
      }

      if (isDue(lastTeamDeep, current, DEEP_INTERVAL_MS)) {
        const teamDeepCall = (prompt: string) => callModel(prompt, { assistantId, userId: null, workspaceId, phase: 'team-deep' })
        try {
          await runTeamDeepConsolidation(store, assistantId, workspaceId, teamDeepCall, deepOptions)
        } catch (err) {
          onError(err, { phase: 'deep', assistantId, userId: workspaceId })
        }
      }

      // Reflection — LLM learns from correction history (mig 165 +
      // 174 + 152). Weekly per workspace. Uses the workspace's
      // primary-assistant context for authorship + the workspace
      // owner for userId (system-owned synthesis). Skips gracefully
      // when no owner / primary is resolvable.
      if (isDue(lastReflection, current, REFLECTION_INTERVAL_MS)) {
        const reflectionCall = (prompt: string) =>
          callModel(prompt, { assistantId, userId: null, workspaceId, phase: 'reflection' })
        try {
          // Synthesised memories carry authorship from the team's
          // primary assistant (assistantId arg) and the workspace
          // owner (best-effort fallback: same `userId` the worker
          // already has on its main loop). For workspaces without a
          // resolvable owner, the synthesis logs but doesn't write
          // (the create call will fail without `createdByUserId`).
          await runReflectionConsolidation(store, reflectionCall, {
            workspaceId,
            assistantId,
            userId: assistantId, // placeholder — workspace owner resolved by adapter when needed
          })
        } catch (err) {
          onError(err, { phase: 'reflection' as never, assistantId, userId: workspaceId })
        }
      }
    }

    // ── Workspace-scoped curator passes (WS-C: S10 + CL-8) ────
    // Opt-in. The scope is wired at apps/api boot; if not provided,
    // this branch is a no-op (existing test fakes don't pass it).
    if (workspaceCuratorScope) {
      const workspaces = await workspaceCuratorScope.listWorkspaces()
      for (const { workspaceId, createdAt } of workspaces) {
        const current = now()
        const lastUmbrella = cadenceTracker.getLastRun(workspaceId, 'umbrella')
        const lastDecay = cadenceTracker.getLastRun(workspaceId, 'decay')

        // S10 — umbrella pass.
        if (isDue(lastUmbrella, current, umbrellaIntervalMs)) {
          try {
            await runREMSkillUmbrella({
              workspaceId,
              workspaceCreatedAt: createdAt,
              store: workspaceCuratorScope.umbrellaStore,
              digestStore: workspaceCuratorScope.digestStore,
              getEmbeddings: workspaceCuratorScope.getEmbeddings,
              // The umbrella pass calls one Flash per cluster; thread
              // the per-call ctx so usage attribution shows up under
              // `overhead:consolidation` for the originating-assistant
              // bucket. The workspace-scoped pass has no single
              // assistant — we pass `assistantId=''` per the existing
              // ConsolidationCallContext shape (the cost tracker
              // tolerates blank assistant for workspace overheads;
              // see cost-tracker.ts).
              callModel: (prompt) =>
                callModel(prompt, {
                  assistantId: '',
                  userId: null,
                  workspaceId,
                  phase: 'rem',
                }),
              onEvent: workspaceCuratorScope.onUmbrellaEvent,
              now,
            })
            cadenceTracker.setLastRun(workspaceId, 'umbrella', current)
          } catch (err) {
            onError(err, {
              phase: 'skill-umbrella',
              assistantId: '',
              userId: workspaceId,
            })
          }
        }

        // CL-8 — decay pass.
        if (isDue(lastDecay, current, decayIntervalMs)) {
          try {
            await runDeepSkillDecay({
              workspaceId,
              store: workspaceCuratorScope.decayStore,
              onEvent: workspaceCuratorScope.onDecayEvent,
              now,
            })
            cadenceTracker.setLastRun(workspaceId, 'decay', current)
          } catch (err) {
            onError(err, {
              phase: 'skill-decay',
              assistantId: '',
              userId: workspaceId,
            })
          }
        }
      }
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      if (store.withWorkerLock) {
        // Row-based worker lock. The lock row in `worker_locks` is the
        // coordination point; the pool connection is held only for the
        // acquire/heartbeat/release statements, not for the duration of
        // `tickInner`. If another instance holds the lock, returns
        // false and tickInner is skipped. See
        // `packages/api/src/db/memories.ts → withWorkerLock`.
        await store.withWorkerLock(CONSOLIDATION_LOCK_ID, tickInner, {
          holderLabel: 'consolidation',
        })
      } else {
        // No lock support (test fakes) — run directly.
        await tickInner()
      }
    } catch (err) {
      // A failure to enumerate users (or acquire the lock) is worth
      // surfacing but must not crash the host process.
      console.error('[consolidation] Tick failed:', err)
    } finally {
      running = false
    }
  }

  return {
    /** Run one tick immediately. Exposed for tests and for callers that
     * want to trigger consolidation explicitly (e.g. on logout). */
    tick,
    start() {
      if (timer) return
      console.log(`[consolidation] Worker started (interval: ${intervalMs}ms)`)
      timer = setInterval(() => { void tick() }, intervalMs)
      // Run immediately on start so a fresh boot doesn't wait 15 min.
      void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[consolidation] Worker stopped')
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}

function isDue(lastRunAt: Date | null, now: Date, intervalMs: number): boolean {
  if (!lastRunAt) return true
  return now.getTime() - lastRunAt.getTime() >= intervalMs
}

/**
 * Post-REM auto reclassification hook. Resolves the assistant's
 * workspace, checks the v2 flag, loads recent memories + existing
 * entities, and invokes `runReclassification`. All ports come from
 * `ReclassificationScope` wired by the apps/api layer.
 *
 * Failures are caught by the caller — this function intentionally
 * returns rather than throwing on the cheap branches (workspaces
 * without v2, empty memory sets) so the REM tick stays inexpensive
 * for workspaces that opted out.
 */
async function runPostRemReclassification(
  store: MemoryStore,
  assistantId: string,
  userId: string,
  scope: ReclassificationScope,
): Promise<void> {
  const workspaceId = await scope.resolveWorkspaceId(assistantId)
  if (!workspaceId) return

  const enabled = await scope.isV2Enabled(workspaceId)
  if (!enabled) return

  // Keyset-batched scan instead of one unbounded load: the reclassifier
  // only ever consumes RECLASSIFICATION_DAILY_CAP rows per run, so loading
  // the whole brain (full detail text) after EVERY REM tick was pure heap
  // cost. The per-row filter distributes over batches, so accumulating
  // filtered survivors until the cap is reached selects the same rows the
  // full-scan-then-slice did (modulo the now-deterministic scan order).
  const RECLASSIFY_SCAN_BATCH = 500
  const filtered: MemoryForReclassification[] = []
  let scanAfter: { createdAt: Date; id: string } | undefined
  for (;;) {
    const rows = await store.listWithMetrics(assistantId, userId, {
      limit: RECLASSIFY_SCAN_BATCH,
      after: scanAfter,
    })
    if (rows.length === 0) break
    const lastRow = rows[rows.length - 1]
    scanAfter = { createdAt: lastRow.createdAt, id: lastRow.id }
    const memories: MemoryForReclassification[] = rows.map((m) => ({
      id: m.id,
      summary: m.summary,
      detail: m.detail,
      tags: m.tags,
      scope: m.scope,
      sensitivity: m.sensitivity,
      workspaceId: m.workspaceId ?? workspaceId,
      userId: m.userId,
      assistantId: m.assistantId,
      // The worker is acting on behalf of the workspace's resolved actor —
      // for auto reclassification the audit row records the assistant +
      // user pair the REM tick ran for. The reclassifier's snapshot uses
      // these for `drop`/`task` undo support; the `attribute` accept path
      // re-checks authorship via `promoteMemoryToEntity`'s own gate.
      createdByUserId: userId,
      createdByAssistantId: assistantId,
      createdAt: m.createdAt,
    }))
    filtered.push(...filterMemoriesForReclassification(memories, new Map()))
    if (filtered.length >= RECLASSIFICATION_DAILY_CAP) break
    if (rows.length < RECLASSIFY_SCAN_BATCH) break
  }
  if (filtered.length === 0) return
  filtered.splice(RECLASSIFICATION_DAILY_CAP)

  // Synthetic access context for the entity list — the worker runs as
  // the (assistantId, userId) pair from the REM tick. Treat the
  // assistant as `primary` so the access predicate widens (matches
  // the workspace reflector contract). High-sensitivity entities are
  // still gated by the row's own clearance ceiling.
  const ctx = {
    workspaceId,
    userId,
    assistantId,
    assistantKind: 'primary' as const,
  }
  const entities = await scope.entityStore.listForWorkspace(ctx, { limit: 200 })

  await runReclassification({
    memories: filtered,
    entities,
    workspaceId,
    actorUserId: userId,
    actorAssistantId: assistantId,
    memoryStore: store,
    taskStore: scope.tasks,
    entityLinks: scope.entityLinks,
    candidates: scope.candidates,
    provider: scope.provider,
    model: scope.model,
  })
}
