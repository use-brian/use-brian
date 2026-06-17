/**
 * Workspace-level prompt evolution worker — closes the staged-memory
 * feedback loop (LOCKED #2, Agent #2B).
 *
 * Reads `memory_verifications` (mig 165) per workspace over a rolling
 * 30-day window, computes correction-rate signals, and emits a
 * deterministic Layer 2 prompt snippet that the prompt builder
 * injects on every future chat turn for that workspace. The model
 * that mis-classified scope/sensitivity yesterday reads the rule
 * against itself tomorrow.
 *
 * **v1 is rule-based.** No LLM call. The snippet templates are
 * static; only the substituted top-categories list is data-driven.
 * Determinism keeps the loop debuggable and avoids paying an LLM
 * bill on a worker tick.
 *
 * Single-instance, in-process — same convention as
 * `commitment-lifecycle-worker`, `consolidation-worker`,
 * `engagement-digest-worker`. Multi-replica is not on the roadmap;
 * the optional `lockId` plumbing lets us flip to advisory-lock
 * coordination later without a code change.
 *
 * Spec: `docs/architecture/brain/corrections.md` →
 *   "Workspace-level prompt evolution".
 * Lease semantics: `docs/architecture/engine/scheduled-jobs.md` →
 *   "Worker lease semantics".
 *
 * [COMP:brain/memory-evolution-worker]
 */

import { query } from '../db/client.js'
import { upsertEvolution } from '../db/workspace-memory-evolution-store.js'

// ── Tunables ──────────────────────────────────────────────────────

/** Per-workspace minimum verifications in the 30d window before a
 *  workspace is even considered. Below this we treat the rate as too
 *  noisy to emit anything. */
const MIN_VERIFICATIONS_FOR_AGGREGATION = 10

/** Rate threshold for snippet emission. Any single dimension at or
 *  above this triggers a corresponding rule. A single CONST per the
 *  spec — keep this as the only knob. */
const SIGNIFICANCE_THRESHOLD = 0.15

/** Rolling aggregation window (days). Verifications older than this
 *  are excluded from the rate calculation. */
const AGGREGATION_WINDOW_DAYS = 30

/** Default tick cadence — weekly. Aligned to roughly once per Sunday
 *  in production by scheduling the boot time accordingly; the worker
 *  itself fires N * intervalMs after start. */
const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** Delay before the first tick after `.start()`. Keeps boot fast. */
const DEFAULT_FIRST_TICK_DELAY_MS = 30_000

// ── Public API ────────────────────────────────────────────────────

export type MemoryEvolutionWorkerOptions = {
  /** Default 7 days. */
  tickIntervalMs?: number
  /** Override `now` for tests. */
  now?: () => Date
  /** First-tick delay; default 30s. Set to 0 in tests. */
  firstTickDelayMs?: number
  onEvent?: (event: MemoryEvolutionEvent) => void
}

export type MemoryEvolutionEvent =
  | { type: 'tick_start'; workspaceCount: number }
  | {
      type: 'workspace_processed'
      workspaceId: string
      totalSaves: number
      totalVerifications: number
      snippetEmitted: boolean
    }
  | { type: 'workspace_skipped'; workspaceId: string; reason: string }
  | { type: 'error'; workspaceId: string | null; error: string }
  | {
      type: 'tick_complete'
      processedCount: number
      emittedCount: number
      skippedCount: number
      errorCount: number
    }

export type MemoryEvolutionWorkerHandle = {
  /** Run one tick immediately. Exposed for tests + explicit triggers. */
  tick(): Promise<void>
  start(): void
  stop(): void
  readonly isRunning: boolean
}

/**
 * Build a worker. Returns `{ start, stop, tick }` — single-instance
 * pattern matching the other in-process workers.
 */
export function createMemoryEvolutionWorker(
  options: MemoryEvolutionWorkerOptions = {},
): MemoryEvolutionWorkerHandle {
  const intervalMs = options.tickIntervalMs ?? DEFAULT_INTERVAL_MS
  const firstTickDelayMs = options.firstTickDelayMs ?? DEFAULT_FIRST_TICK_DELAY_MS
  const now = options.now ?? (() => new Date())
  const onEvent = options.onEvent

  let intervalTimer: ReturnType<typeof setInterval> | undefined
  let initialTimer: ReturnType<typeof setTimeout> | undefined
  let running = false

  async function tickInner(): Promise<void> {
    const windowEnd = now()
    const windowStart = new Date(
      windowEnd.getTime() - AGGREGATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    )

    // Workspaces that have at least one verification in the window.
    // Anyone with zero verifications has nothing to learn from — skip
    // entirely (we do not write a zeroed row, since an empty workspace
    // shouldn't pollute the table).
    const candidateResult = await query<{ workspaceId: string }>(
      `SELECT DISTINCT workspace_id AS "workspaceId"
       FROM memory_verifications
       WHERE created_at >= $1`,
      [windowStart],
    )
    const workspaces = candidateResult.rows
    onEvent?.({ type: 'tick_start', workspaceCount: workspaces.length })

    let processed = 0
    let emitted = 0
    let skipped = 0
    let errored = 0
    for (const { workspaceId } of workspaces) {
      try {
        const outcome = await processWorkspace(workspaceId, windowStart)
        if (outcome.outcome === 'processed') {
          processed += 1
          if (outcome.snippetEmitted) emitted += 1
          onEvent?.({
            type: 'workspace_processed',
            workspaceId,
            totalSaves: outcome.totalSaves,
            totalVerifications: outcome.totalVerifications,
            snippetEmitted: outcome.snippetEmitted,
          })
        } else {
          skipped += 1
          onEvent?.({
            type: 'workspace_skipped',
            workspaceId,
            reason: outcome.reason,
          })
        }
      } catch (err) {
        errored += 1
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[memory-evolution] workspace ${workspaceId} failed:`,
          err,
        )
        onEvent?.({ type: 'error', workspaceId, error: message })
      }
    }

    onEvent?.({
      type: 'tick_complete',
      processedCount: processed,
      emittedCount: emitted,
      skippedCount: skipped,
      errorCount: errored,
    })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      await tickInner()
    } catch (err) {
      console.error('[memory-evolution] tick failed:', err)
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (intervalTimer || initialTimer) return // idempotent
      console.log(
        `[memory-evolution] worker started (interval: ${intervalMs}ms, window: ${AGGREGATION_WINDOW_DAYS}d, threshold: ${SIGNIFICANCE_THRESHOLD})`,
      )
      initialTimer = setTimeout(() => {
        initialTimer = undefined
        void tick().catch((err) =>
          console.error('[memory-evolution] initial tick failed:', err),
        )
      }, firstTickDelayMs)
      intervalTimer = setInterval(() => {
        void tick().catch((err) =>
          console.error('[memory-evolution] tick failed:', err),
        )
      }, intervalMs)
    },
    stop() {
      if (initialTimer) {
        clearTimeout(initialTimer)
        initialTimer = undefined
      }
      if (intervalTimer) {
        clearInterval(intervalTimer)
        intervalTimer = undefined
      }
    },
    get isRunning() {
      return intervalTimer !== undefined || initialTimer !== undefined
    },
  }
}

// ── Workspace processing (exported for tests) ─────────────────────

export type WorkspaceProcessOutcome =
  | {
      outcome: 'processed'
      totalSaves: number
      totalVerifications: number
      snippetEmitted: boolean
    }
  | { outcome: 'skipped'; reason: string }

/**
 * Compute aggregated rates for one workspace, emit a snippet if any
 * rate is significant, and upsert into `workspace_memory_evolution`.
 * Exposed for unit tests + explicit replays.
 */
export async function processWorkspace(
  workspaceId: string,
  windowStart: Date,
): Promise<WorkspaceProcessOutcome> {
  // Total model-authored saves in the window for this workspace.
  // Used as the denominator's denominator: "of all saves, how many
  // got user-touched?" is a downstream UI signal; the snippet logic
  // uses `total_verifications` as its denominator (because rates
  // measure "of the corrections, what direction did they go?").
  const savesResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM memories
     WHERE workspace_id = $1
       AND source = 'model'
       AND created_at >= $2`,
    [workspaceId, windowStart],
  )
  const totalSaves = parseInt(savesResult.rows[0]?.count ?? '0', 10)

  // All verifications in the window + the joined-in memory tags
  // (mig 177 folded `category` into `tags`) so we can populate the
  // top-categories tally on the scope-narrow snippet bullet.
  const verificationsResult = await query<{
    action: string
    modelValue: unknown
    userValue: unknown
    tags: string[] | null
  }>(
    `SELECT v.action,
            v.model_value AS "modelValue",
            v.user_value  AS "userValue",
            m.tags        AS "tags"
     FROM memory_verifications v
     LEFT JOIN memories m ON m.id = v.memory_id
     WHERE v.workspace_id = $1
       AND v.created_at >= $2`,
    [workspaceId, windowStart],
  )
  const verifications = verificationsResult.rows
  const totalVerifications = verifications.length

  if (totalVerifications < MIN_VERIFICATIONS_FOR_AGGREGATION) {
    return { outcome: 'skipped', reason: 'below_min_verifications' }
  }

  // Tally directional buckets. Denominator is `totalVerifications` —
  // each rate answers "what fraction of all corrections fell into
  // this bucket?", not "what fraction of *scope* corrections were
  // narrow?". This ties the threshold to the workspace's *overall*
  // correction tempo.
  let scopeNarrowCount = 0
  let scopeWideCount = 0
  let sensitivityOverCount = 0
  let sensitivityUnderCount = 0

  // Top-3 tags among scope-narrow corrections — used to fill the
  // corresponding snippet template. (Mig 177 folded the old `category`
  // column into `tags`; each tag is counted independently.)
  const scopeNarrowTags = new Map<string, number>()

  for (const row of verifications) {
    if (row.action === 'adjust_scope') {
      const dir = classifyScopeDirection(row.modelValue, row.userValue)
      if (dir === 'narrow_to_wide') {
        scopeNarrowCount += 1
        if (row.tags) {
          for (const tag of row.tags) {
            scopeNarrowTags.set(tag, (scopeNarrowTags.get(tag) ?? 0) + 1)
          }
        }
      } else if (dir === 'wide_to_narrow') {
        scopeWideCount += 1
      }
    } else if (row.action === 'adjust_sensitivity') {
      const dir = classifySensitivityDirection(row.modelValue, row.userValue)
      if (dir === 'over_to_under') {
        sensitivityOverCount += 1
      } else if (dir === 'under_to_over') {
        sensitivityUnderCount += 1
      }
    }
  }

  const scopeNarrowRate = scopeNarrowCount / totalVerifications
  const scopeWideRate = scopeWideCount / totalVerifications
  const sensitivityOverRate = sensitivityOverCount / totalVerifications
  const sensitivityUnderRate = sensitivityUnderCount / totalVerifications

  const topCategories = Array.from(scopeNarrowTags.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]) => tag)

  const snippet = buildPromptSnippet({
    scopeNarrowRate,
    scopeWideRate,
    sensitivityOverRate,
    sensitivityUnderRate,
    topScopeNarrowCategories: topCategories,
  })

  await upsertEvolution({
    workspaceId,
    totalSaves30d: totalSaves,
    totalVerifications30d: totalVerifications,
    scopeNarrowRate: round3(scopeNarrowRate),
    scopeWideRate: round3(scopeWideRate),
    sensitivityOverRate: round3(sensitivityOverRate),
    sensitivityUnderRate: round3(sensitivityUnderRate),
    promptSnippet: snippet,
  })

  return {
    outcome: 'processed',
    totalSaves,
    totalVerifications,
    snippetEmitted: snippet !== null,
  }
}

// ── Direction classifiers (exported for tests) ────────────────────

export type ScopeDirection = 'narrow_to_wide' | 'wide_to_narrow' | 'neutral'

/**
 * "Narrow" = `personal` (no workspace). "Wide" = anything carrying a
 * workspace dimension (`workspace_shared` or `workspace`). The verify
 * route serialises these three strings into `model_value` /
 * `user_value` directly (see `routes/memories.ts` adjust_scope arm).
 */
export function classifyScopeDirection(
  modelValue: unknown,
  userValue: unknown,
): ScopeDirection {
  const m = typeof modelValue === 'string' ? modelValue : null
  const u = typeof userValue === 'string' ? userValue : null
  if (!m || !u || m === u) return 'neutral'
  const modelWide = m === 'workspace' || m === 'workspace_shared'
  const userWide = u === 'workspace' || u === 'workspace_shared'
  if (!modelWide && userWide) return 'narrow_to_wide'
  if (modelWide && !userWide) return 'wide_to_narrow'
  return 'neutral'
}

export type SensitivityDirection = 'over_to_under' | 'under_to_over' | 'neutral'

/**
 * Order: `public` < `internal` < `confidential`. "Over-classified" =
 * the model picked a higher tier than the user kept (the user
 * lowered sensitivity); "under-classified" = the user raised it.
 */
const SENSITIVITY_RANK: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
}
export function classifySensitivityDirection(
  modelValue: unknown,
  userValue: unknown,
): SensitivityDirection {
  const m = typeof modelValue === 'string' ? modelValue : null
  const u = typeof userValue === 'string' ? userValue : null
  if (!m || !u || m === u) return 'neutral'
  const mr = SENSITIVITY_RANK[m]
  const ur = SENSITIVITY_RANK[u]
  if (mr === undefined || ur === undefined) return 'neutral'
  if (mr > ur) return 'over_to_under'
  if (mr < ur) return 'under_to_over'
  return 'neutral'
}

// ── Snippet templates (exported for tests) ────────────────────────

export type PromptSnippetInputs = {
  scopeNarrowRate: number
  scopeWideRate: number
  sensitivityOverRate: number
  sensitivityUnderRate: number
  topScopeNarrowCategories?: string[]
}

/**
 * Build the Layer 2 prompt snippet from rate signals. Pure function —
 * the worker calls this after the database read; tests assert on it
 * directly. Returns `null` when no rate crossed the significance
 * threshold (the prompt builder treats this as "inject nothing").
 *
 * Rules are stacked: every dimension that crosses the threshold
 * contributes one bullet. The snippet is wrapped in a stable
 * `# Workspace memory conventions` header so the prompt builder can
 * place it once and the model can refer back to it as a unit.
 */
export function buildPromptSnippet(inputs: PromptSnippetInputs): string | null {
  const bullets: string[] = []

  if (inputs.scopeNarrowRate >= SIGNIFICANCE_THRESHOLD) {
    const cats = inputs.topScopeNarrowCategories ?? []
    const example = cats.length > 0
      ? ` Examples we've observed: ${cats.map((c) => `"${c}"`).join(', ')}.`
      : ''
    bullets.push(
      `In this workspace, lean toward 'workspace_shared' scope for user preferences and team-relevant facts — recent corrections consistently widen scope.${example}`,
    )
  }
  if (inputs.scopeWideRate >= SIGNIFICANCE_THRESHOLD) {
    bullets.push(
      `In this workspace, prefer narrower 'personal' scope for assistant-specific behavioral inferences — recent corrections consistently narrow scope.`,
    )
  }
  if (inputs.sensitivityOverRate >= SIGNIFICANCE_THRESHOLD) {
    bullets.push(
      `In this workspace, default sensitivity to 'internal' unless content explicitly involves compensation, performance reviews, or health — recent corrections consistently lower sensitivity.`,
    )
  }
  if (inputs.sensitivityUnderRate >= SIGNIFICANCE_THRESHOLD) {
    bullets.push(
      `In this workspace, escalate sensitivity to 'confidential' for any content involving teammates' compensation, performance, or personal circumstances — recent corrections consistently raise sensitivity.`,
    )
  }

  if (bullets.length === 0) return null

  return [
    '# Workspace memory conventions',
    'Recent corrections in this workspace suggest the following biases for future memory saves:',
    ...bullets.map((b) => `- ${b}`),
  ].join('\n')
}

// ── Internals ────────────────────────────────────────────────────

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
