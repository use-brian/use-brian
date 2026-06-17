/**
 * Cross-primitive evolution worker — closes the brain_verifications
 * feedback loop. Sibling of `memory-evolution-worker.ts`; that one
 * handles memory, this one handles entities / edges / tasks / CRM
 * rows / files via the `brain_verifications` event stream (mig 174).
 *
 * Headline signal per primitive: **delete rate** =
 *   deletes / (confirms + deletes)
 *
 * When the rate crosses `SIGNIFICANCE_THRESHOLD` AND the sample size
 * passes `MIN_SAMPLES_PER_PRIMITIVE`, a snippet bullet is emitted
 * telling the model to slow down on that primitive ("ask before
 * creating, the user deletes half of them").
 *
 * v1 is rule-based (no LLM). Determinism keeps the loop debuggable.
 *
 * Single-instance, in-process — same convention as the memory worker.
 *
 * [COMP:brain/brain-evolution-worker]
 */

import {
  countCorrectionsByPrimitive,
  listActiveWorkspaces,
  upsertBrainEvolution,
  type PrimitiveDeleteStat,
} from '../db/workspace-brain-evolution-store.js'

// ── Tunables (single CONST per spec) ──────────────────────────────

/** Per-primitive minimum (confirms + deletes) before a primitive's
 *  rate is considered significant. Below this the noise dominates. */
const MIN_SAMPLES_PER_PRIMITIVE = 5

/** Rate threshold for snippet emission. A primitive at or above this
 *  delete rate gets a bullet. 30% is meaningfully worse than baseline
 *  noise but not so strict that real signal gets suppressed. */
const SIGNIFICANCE_THRESHOLD = 0.3

/** Rolling aggregation window (days). */
const AGGREGATION_WINDOW_DAYS = 30

const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_FIRST_TICK_DELAY_MS = 30_000

// ── Public API ────────────────────────────────────────────────────

export type BrainEvolutionWorkerOptions = {
  tickIntervalMs?: number
  firstTickDelayMs?: number
  now?: () => Date
  onEvent?: (event: BrainEvolutionEvent) => void
}

export type BrainEvolutionEvent =
  | { type: 'tick_start'; workspaceCount: number }
  | {
      type: 'workspace_processed'
      workspaceId: string
      primitivesAboveThreshold: string[]
      snippetEmitted: boolean
    }
  | { type: 'workspace_skipped'; workspaceId: string; reason: string }
  | { type: 'error'; workspaceId: string | null; error: string }

export type BrainEvolutionWorker = {
  start: () => void
  stop: () => void
  /** Force-runs a tick — exposed for the boot tick + tests. */
  tick: () => Promise<void>
}

export function createBrainEvolutionWorker(
  opts: BrainEvolutionWorkerOptions = {},
): BrainEvolutionWorker {
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_INTERVAL_MS
  const firstTickDelayMs = opts.firstTickDelayMs ?? DEFAULT_FIRST_TICK_DELAY_MS

  let timer: NodeJS.Timeout | null = null
  let stopped = false

  async function runTick(): Promise<void> {
    if (stopped) return
    let workspaceIds: string[] = []
    try {
      workspaceIds = await listActiveWorkspaces(AGGREGATION_WINDOW_DAYS)
    } catch (err) {
      opts.onEvent?.({
        type: 'error',
        workspaceId: null,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    opts.onEvent?.({ type: 'tick_start', workspaceCount: workspaceIds.length })

    for (const workspaceId of workspaceIds) {
      try {
        await processWorkspace(workspaceId, opts.onEvent)
      } catch (err) {
        opts.onEvent?.({
          type: 'error',
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return {
    start() {
      stopped = false
      // First tick after a short delay to keep boot fast; subsequent
      // ticks at the configured interval.
      const firstTick = setTimeout(() => {
        void runTick().finally(() => {
          if (!stopped) {
            timer = setInterval(() => {
              void runTick()
            }, tickIntervalMs)
          }
        })
      }, firstTickDelayMs)
      timer = firstTick
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        clearInterval(timer)
        timer = null
      }
    },
    tick: runTick,
  }
}

// ── Per-workspace processing ──────────────────────────────────────

async function processWorkspace(
  workspaceId: string,
  onEvent: BrainEvolutionWorkerOptions['onEvent'],
): Promise<void> {
  const counts = await countCorrectionsByPrimitive(workspaceId, AGGREGATION_WINDOW_DAYS)
  if (counts.length === 0) {
    onEvent?.({ type: 'workspace_skipped', workspaceId, reason: 'no events in window' })
    return
  }

  // Compute per-primitive stats, keeping only primitives with enough
  // samples to be meaningful.
  const rates: Record<string, PrimitiveDeleteStat> = {}
  const aboveThreshold: string[] = []
  for (const c of counts) {
    const total = c.confirms + c.deletes
    if (total < MIN_SAMPLES_PER_PRIMITIVE) continue
    const deleteRate = c.deletes / total
    rates[c.primitive] = { deleteRate, sampleSize: total }
    if (deleteRate >= SIGNIFICANCE_THRESHOLD) {
      aboveThreshold.push(c.primitive)
    }
  }

  const snippet = aboveThreshold.length > 0 ? buildSnippet(rates, aboveThreshold) : null

  await upsertBrainEvolution({ workspaceId, rates, promptSnippet: snippet })

  onEvent?.({
    type: 'workspace_processed',
    workspaceId,
    primitivesAboveThreshold: aboveThreshold,
    snippetEmitted: snippet !== null,
  })
}

// ── Snippet builder (rule-based, v1) ──────────────────────────────

/**
 * Build the Layer 2 prompt snippet from primitives that crossed the
 * delete-rate threshold. Stable text — same inputs produce the same
 * output, so `prompt_snippet_version` stays at 0 until something
 * actually changes.
 */
function buildSnippet(
  rates: Record<string, PrimitiveDeleteStat>,
  primitives: string[],
): string {
  const lines = primitives
    .sort()
    .map((p) => {
      const stat = rates[p]
      const pct = Math.round(stat.deleteRate * 100)
      return `- ${humaniseSinglePrimitive(p)}: ${pct}% of model-created ${humanisePluralPrimitive(p)} (${stat.sampleSize} total) were deleted by the user. ${suggestionFor(p)}`
    })
  return `# Workspace correction patterns\nRecent feedback on rows you've created in this workspace:\n${lines.join('\n')}\nApply these biases on the next save in this workspace.`
}

function humaniseSinglePrimitive(p: string): string {
  switch (p) {
    case 'entity': return 'Entity'
    case 'entity_link': return 'Edge'
    case 'task': return 'Task'
    case 'contact': return 'Contact'
    case 'company': return 'Company'
    case 'deal': return 'Deal'
    case 'workspace_file': return 'File'
    default: return p.charAt(0).toUpperCase() + p.slice(1)
  }
}

function humanisePluralPrimitive(p: string): string {
  switch (p) {
    case 'entity': return 'entities'
    case 'entity_link': return 'edges'
    case 'task': return 'tasks'
    case 'contact': return 'contacts'
    case 'company': return 'companies'
    case 'deal': return 'deals'
    case 'workspace_file': return 'files'
    default: return p + 's'
  }
}

function suggestionFor(p: string): string {
  switch (p) {
    case 'entity':
    case 'contact':
    case 'company':
      return 'Ask before creating a new one; prefer attaching context to an existing entity.'
    case 'entity_link':
      return "Edges should be assertable; if you're not sure the relationship holds, ask first."
    case 'task':
      return 'Tasks should be commitments the user actually made; ask before creating speculative tasks.'
    case 'deal':
      return 'Confirm the deal exists and its stage before writing.'
    case 'workspace_file':
      return 'Save files only when the user explicitly asks or when content is the work product itself.'
    default:
      return 'Slow down on this kind of write; confirm with the user first.'
  }
}
