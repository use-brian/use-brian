/**
 * Pre-flight orchestrator for automatic parallel worker delegation.
 *
 * Runs before the main query loop. If the user's message qualifies for
 * parallel research (determined by the classifier), spawns workers for
 * each sub-task, waits for all to complete, and returns formatted results
 * for injection into the system prompt.
 *
 * Worker events (tool_start, tool_result, etc.) are streamed to the caller
 * via onEvent so the frontend shows live tool activity during pre-flight.
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { Tool, ToolContext } from '../tools/types.js'
import type { QueryEvent } from '../engine/query-loop.js'
import { createWorkerManager, type WorkerRunsStore } from './worker.js'
import { classifySplit } from './splitter.js'

/**
 * Classifier LLM usage from the initial `classifySplit` call. Exposed so the
 * caller can attribute it as `overhead:splitter`. Absent when the message
 * was too short to trigger classification.
 */
type PreflightClassifierUsage = {
  usage: TokenUsage | null
  model: string | null
}

export type PreflightResult =
  | ({ type: 'passthrough' } & PreflightClassifierUsage)
  | ({ type: 'researched'; context: string } & PreflightClassifierUsage)

export type PreflightOptions = {
  provider: LLMProvider
  /** Model for workers — same as main conversation model. */
  model: string
  /** The user's message text. */
  message: string
  /** Full tool set for the current request (workers get read-only subset). */
  tools: Map<string, Tool>
  /** Tool context for workers (userId, assistantId, etc.). */
  context: ToolContext
  /** Callback for status updates (e.g. SSE events, typing indicators). */
  onStatus?: (msg: string) => void
  /** Forward worker query loop events to the caller for live streaming. Includes workerId and description for grouping. */
  onEvent?: (event: QueryEvent, workerId: string, description?: string) => void
  /** Max turns per worker. Default 3, extended thinking uses 10. */
  maxWorkerTurns?: number
  /**
   * Persist each spawned worker as a `worker_runs` row (spawn/turn/completion).
   * Set by a workflow research step so its fan-out is observable in the
   * run-detail surface + admin dashboard. Absent (chat standard-tier preflight)
   * → workers run unpersisted, exactly as before. `sessionId`/`workspaceId`
   * must match the `context` passed to the workers for `recordSpawn` to fire.
   */
  persistence?: { store: WorkerRunsStore; sessionId: string; workspaceId: string }
  /**
   * Give workers the research-mode discipline (chain `webSearch` → `urlReader`,
   * multi-angle queries, triangulate ≥2 sources) and the deeper turn budget.
   * Set by a workflow research step. Absent → the historical short worker
   * prompt. The research-tier model is passed via `model`.
   */
  researchMode?: boolean
  /** Cap concurrent workers (memory pressure). Absent → manager default. */
  maxConcurrent?: number
  /**
   * When the splitter declines to split (one focused ask, or a short prompt),
   * still run a single worker on the whole `message` so a research step always
   * actually researches. Set by a workflow research step. Absent → a
   * non-splittable message is a `passthrough` (chat's historical behavior).
   */
  forceResearch?: boolean
}

/**
 * Run pre-flight parallel research if the user's message qualifies.
 *
 * Returns `{ type: 'passthrough' }` if no parallel research is needed,
 * or `{ type: 'researched', context }` with formatted worker results
 * to inject into the system prompt.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const { provider, model, message, tools, context, onStatus, onEvent } = options

  // Step 1: Classify — does this message need splitting? Classifier usage is
  // returned on the result so the caller can record it as `overhead:splitter`.
  const { tasks, usage, model: classifierModel } = await classifySplit({ provider, message })
  const classifierUsage: PreflightClassifierUsage = { usage, model: classifierModel }
  // A workflow research step always researches: if the splitter declines to
  // split, fall back to a single worker on the whole prompt. Chat preflight
  // (forceResearch absent) keeps the historical passthrough.
  const tasksToRun = tasks ?? (options.forceResearch ? [message] : null)
  if (!tasksToRun) return { type: 'passthrough', ...classifierUsage }

  // Step 2: Spawn parallel workers
  onStatus?.('Researching in parallel...')

  const manager = createWorkerManager({
    provider,
    model,
    tools: new Map([...tools].filter(([_, t]) => t.isReadOnly)),
    maxTurns: options.maxWorkerTurns ?? 2, // 1 search + 1 URL read = 2 turns max
  })
  // Workflow research steps persist each worker (worker_runs rows) and run the
  // research-mode discipline on the research-tier model. Chat preflight leaves
  // all of these unset → unpersisted, short-prompt workers, unchanged.
  if (options.persistence) manager.setPersistence(options.persistence)
  if (options.researchMode) manager.setResearchMode(true)
  if (options.maxConcurrent != null) manager.setMaxConcurrent(options.maxConcurrent)
  if (onEvent) {
    manager.setOnEvent((workerId, event) => onEvent(event, workerId, manager.getDescription(workerId) ?? undefined))
  }

  for (const taskPrompt of tasksToRun) {
    manager.spawn(taskPrompt, context, tools)
  }

  // Step 3: Wait for all workers to complete
  await manager.waitAll()

  // Step 4: Collect and format results
  const notifications = manager.drainNotifications()
  if (notifications.length === 0) return { type: 'passthrough', ...classifierUsage }

  const context_text = notifications
    .map((n) => manager.formatNotification(n))
    .join('\n\n')

  return { type: 'researched', context: context_text, ...classifierUsage }
}

/**
 * Build the system prompt with pre-researched context injected.
 * If no preflight context, returns the base prompt unchanged.
 */
export function buildPreflightPrompt(basePrompt: string, preflightContext: string): string {
  if (!preflightContext) return basePrompt
  return `${basePrompt}

# Pre-Researched Context

The following research was already gathered for the user's request. Compose your response directly from these findings.

You do not have direct access to web search or URL reader tools for this turn — they were already used during research. If you genuinely need additional information not covered below, use spawnWorker to delegate the lookup.

${preflightContext}`
}
