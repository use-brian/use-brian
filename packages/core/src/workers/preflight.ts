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
import { createWorkerManager } from './worker.js'
import { classifySplit } from './splitter.js'

/**
 * Classifier LLM usage from the initial `classifySplit` call. Exposed so the
 * caller can attribute it as `overhead:splitter`. Absent when the message
 * was too short to trigger classification.
 */
export type PreflightClassifierUsage = {
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
  if (!tasks) return { type: 'passthrough', ...classifierUsage }

  // Step 2: Spawn parallel workers
  onStatus?.('Researching in parallel...')

  const manager = createWorkerManager({
    provider,
    model,
    tools: new Map([...tools].filter(([_, t]) => t.isReadOnly)),
    maxTurns: options.maxWorkerTurns ?? 2, // 1 search + 1 URL read = 2 turns max
  })
  if (onEvent) {
    manager.setOnEvent((workerId, event) => onEvent(event, workerId, manager.getDescription(workerId) ?? undefined))
  }

  for (const taskPrompt of tasks) {
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
