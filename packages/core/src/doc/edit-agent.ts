/**
 * Context-clean Doc edit runner.
 *
 * The conversational loop can submit one self-contained brief through the
 * gateway tool below. The child starts from a new stateless context containing
 * only that brief, a freshly loaded page map, and the exact Doc tool map the
 * server captured. Parent history, persona, memories, connectors, request
 * tools, and worker lifecycle never cross this boundary.
 *
 * Spec: docs/architecture/features/doc.md -> "Context-clean edit delegation".
 *
 * [COMP:doc/edit-agent]
 */

import { z } from 'zod'
import { NOOP_TURN_LEDGER } from '../engine/turn-ledger.js'
import { queryLoop, type TerminalStopReason } from '../engine/query-loop.js'
import { DEFAULT_STALL_IDLE_MS, isStalledError } from '../engine/stall-watchdog.js'
import { NO_TOOL_TIMEOUT } from '../engine/tool-executor.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'

export const DOC_EDIT_GATEWAY_TOOL = 'delegateDocEdit'

/** Tools whose successful result proves the child changed durable Doc state. */
export const DOC_MUTATION_TOOLS = new Set([
  'renderPage',
  'patchPage',
  'createSubPage',
  'importToPage',
  'createEntityType',
  'addProperty',
  'removeProperty',
  'renameProperty',
  'createEntity',
  'updateEntity',
  'deleteEntity',
  'postComment',
  'resolveComment',
])

const delegateDocEditInputSchema = z
  .object({
    intent: z.enum(['create', 'edit']).describe(
      'Use edit only for an existing page id validated by runtime context. Use create only when the user explicitly asked for a new page.',
    ),
    pageId: z.string().min(1).optional().describe(
      'Required for edit: one exact page id supplied as an allowed target by runtime context. Omit for create.',
    ),
    instruction: z.string().trim().min(1).max(20_000).describe(
      'Self-contained description of the finished page change. Include relevant facts, citations, and placement constraints. The editor cannot see this conversation.',
    ),
  })
  .superRefine((input, ctx) => {
    if (input.intent === 'edit' && !input.pageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pageId'],
        message: 'pageId is required for an existing-page edit.',
      })
    }
    if (input.intent === 'create' && input.pageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pageId'],
        message: 'pageId must be omitted for a new-page create.',
      })
    }
  })

export type DocEditAttemptUsage = {
  model: string
  usage: TokenUsage
  attempt: 'background' | 'standard_fallback'
}

export type DocEditReceipt = {
  /**
   * `completed` = the child finished on its own with at least one mutation
   * applied. `partial` = mutations landed but the child was CUT OFF before it
   * finished (its turn / tool budget, an abort, or a provider error): the page
   * is in a half-done state and the parent must say so - never relay a partial
   * as done. `failed` = no mutation was applied.
   */
  status: 'completed' | 'partial' | 'failed'
  summary: string
  mutationTools: string[]
  pageIds: string[]
  fallbackUsed: boolean
  /**
   * For `partial`: why the child stopped early - a `TerminalStopReason` code
   * (`max_turns`, `tool_budget_exhausted`, `tool_failure_limit`) or the error /
   * abort message. For `failed`: the failure.
   */
  error?: string
}

export type RunDocEditAgentOptions = {
  provider: LLMProvider
  model: string
  fallbackModel?: string
  systemPrompt: string
  instruction: string
  tools: Map<string, Tool>
  context: ToolContext
  /** Reloaded before every attempt so a fallback never inherits stale state. */
  loadPageContext: (instruction: string) => Promise<string>
  onUsage?: (event: DocEditAttemptUsage) => void | Promise<void>
  /** Child result side channel for live UI events. It is never copied into the
   * parent transcript; the server may project selected result metadata to SSE. */
  onToolResult?: (result: {
    toolUseId: string
    name: string
    content: string
    isError?: boolean
  }) => void | Promise<void>
  maxTurns?: number
  maxToolCalls?: number
  /** Stall watchdog idle window for the child loop. Default: `DEFAULT_STALL_IDLE_MS`. */
  stallIdleMs?: number
}

type AttemptResult = {
  summary: string
  mutationTools: string[]
  pageIds: string[]
  error?: string
  /** Set when the child's loop ended on a budget limit rather than by itself. */
  cutoff?: TerminalStopReason
  /** Set when the child's stall watchdog fired (no progress for the idle window). */
  stalled?: boolean
}

/**
 * Child COST budgets. Each child turn is one model round trip, and a model
 * that authors section by section spends one turn per section, so the old
 * `maxTurns: 8` was exhausted by a five-section page (skeleton + one section
 * per turn) - the 2026-08-18 "page build always stops in the middle" report:
 * the loop hit `max_turns`, the isolated finalizer wrote "The page is now
 * completed", and the receipt said `completed` because one mutation had
 * landed. The prompt tells the editor to batch (see `EDIT_AGENT_HEADER`) and
 * a cutoff is reported as `partial` rather than swallowed. Widened again
 * 2026-08-19 (16/24 -> 24/40) with the wall-clock gone: cost is bounded by
 * these two numbers, liveness by the stall watchdog, and a slow-but-honest
 * provider that iterates per section gets the room. A page that outgrows
 * them ends `partial` and continues in the next turn - the budget is a cost
 * cap, not a knob.
 */
export const DOC_EDIT_MAX_TURNS = 24
export const DOC_EDIT_MAX_TOOL_CALLS = 40
/**
 * There is NO wall-clock bound on a delegated edit (2026-08-19). The old
 * `DOC_EDIT_TIMEOUT_MS = 300s` assumed a Flash-Lite-speed child; on a
 * self-host whose background model ran 10-77s per call it bought 4-8 round
 * trips and clipped every multi-section page ("stopped prior to completing")
 * while catching nothing a progress clock would not have caught. The gateway
 * declares `NO_TOOL_TIMEOUT` and the child loop runs under the stall
 * watchdog (`DEFAULT_STALL_IDLE_MS`, derived from the provider idle windows):
 * no provider chunk, tool activity or loop event for the idle window =
 * stalled, reported as `partial` / `failed` with the reason. Cost stays
 * bounded by the two budgets above.
 */
/**
 * Children one gateway instance may start per parent turn. The second is
 * admitted only after a `failed` (no-mutation) receipt - see
 * `createDelegateDocEditTool`.
 */
export const DOC_EDIT_MAX_DELEGATIONS_PER_TURN = 2

/** Budget cutoffs - the codes that mean "the editor did not get to finish". */
export function isBudgetCutoff(stop: TerminalStopReason | undefined): boolean {
  return (
    stop?.code === 'max_turns'
    || stop?.code === 'tool_budget_exhausted'
    || stop?.code === 'tool_failure_limit'
  )
}

/**
 * Construct the child ToolContext by allow-list, not by spreading the parent.
 * This makes the absence of requestTools/workerManager/confirmation callbacks
 * structural and reviewable.
 */
export function isolateDocEditToolContext(parent: ToolContext): ToolContext {
  return {
    userId: parent.userId,
    assistantId: parent.assistantId,
    sessionId: parent.sessionId,
    appId: parent.appId,
    channelType: parent.channelType,
    channelId: parent.channelId,
    workspaceId: parent.workspaceId,
    assistantKind: parent.assistantKind,
    activeCapabilities: parent.activeCapabilities,
    docViewId: parent.docViewId,
    userMessageText: parent.userMessageText,
    userTimezone: parent.userTimezone,
    abortSignal: parent.abortSignal,
    // The parent loop's liveness clock: the child's watchdog reports into it,
    // so a slow-but-alive edit keeps the parent turn alive too.
    progress: parent.progress,
    sensitivity: parent.sensitivity,
    compartmentAccumulator: parent.compartmentAccumulator,
    evidence: parent.evidence,
    researchMode: parent.researchMode,
    clearance: parent.clearance,
    compartments: parent.compartments,
    assistantClearance: parent.assistantClearance,
    assistantCompartments: parent.assistantCompartments,
    assistantDefaultCompartments: parent.assistantDefaultCompartments,
  }
}

function textFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      block.type === 'text' && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function compactSummary(text: string, mutationTools: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean) return clean.slice(0, 1_000)
  return mutationTools.length > 0
    ? `Applied Doc changes with ${mutationTools.join(', ')}.`
    : 'The editor finished without applying a Doc mutation.'
}

async function runAttempt(
  options: RunDocEditAgentOptions,
  model: string,
  attempt: DocEditAttemptUsage['attempt'],
): Promise<AttemptResult> {
  const pageContext = await options.loadPageContext(options.instruction)
  const mutationTools = new Set<string>()
  const pageIds = new Set<string>()
  let latestText = ''
  let lastError: string | undefined
  let cutoff: TerminalStopReason | undefined
  let stalled = false

  try {
    for await (const event of queryLoop({
      ledger: options.context.turnLedger ?? NOOP_TURN_LEDGER,
      provider: options.provider,
      model,
      systemPrompt: options.systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<doc_edit_brief>',
              options.instruction,
              '</doc_edit_brief>',
              '',
              '<fresh_page_context>',
              pageContext,
              '</fresh_page_context>',
            ].join('\n'),
          },
        ],
      }],
      tools: new Map(options.tools),
      context: isolateDocEditToolContext(options.context),
      stateless: true,
      maxTurns: options.maxTurns ?? DOC_EDIT_MAX_TURNS,
      maxToolCalls: options.maxToolCalls ?? DOC_EDIT_MAX_TOOL_CALLS,
      // Liveness, not wall-clock: see DEFAULT_STALL_IDLE_MS.
      stallIdleMs: options.stallIdleMs ?? DEFAULT_STALL_IDLE_MS,
      channelType: 'web',
    })) {
      if (event.type === 'assistant_turn') {
        const hasToolUse = event.response.content.some((block) => block.type === 'tool_use')
        if (!hasToolUse) {
          const text = textFromContent(event.response.content)
          if (text) latestText = text
        }
        for (const result of event.toolResults) {
          if (result.type === 'tool_result') {
            await options.onToolResult?.({
              toolUseId: result.toolUseId,
              name: result.name,
              content: result.content,
              isError: result.isError,
            })
          }
          if (
            result.type === 'tool_result'
            && DOC_MUTATION_TOOLS.has(result.name)
            && result.isError !== true
          ) {
            mutationTools.add(result.name)
            try {
              const parsed = JSON.parse(result.content) as {
                pageId?: unknown
                childPageId?: unknown
              }
              if (typeof parsed.pageId === 'string') pageIds.add(parsed.pageId)
              if (typeof parsed.childPageId === 'string') pageIds.add(parsed.childPageId)
            } catch {
              // Some tools return plain text. Mutation success is still valid;
              // the compact receipt simply has no page id for that result.
            }
          }
        }
      } else if (event.type === 'turn_complete') {
        const text = textFromContent(event.response.content)
        if (text) latestText = text
        // A budget exit is structural: the finalizer's text above may read
        // like a finished summary ("the page is now completed"), and it must
        // not be allowed to mean that.
        if (isBudgetCutoff(event.terminalStop)) cutoff = event.terminalStop
        await options.onUsage?.({ model: event.response.model, usage: event.totalUsage, attempt })
      } else if (event.type === 'error') {
        lastError = event.error.message
        if (isStalledError(event.error)) stalled = true
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    if (isStalledError(error)) stalled = true
  }

  const successful = [...mutationTools]
  return {
    summary: compactSummary(latestText, successful),
    mutationTools: successful,
    pageIds: [...pageIds],
    error: lastError,
    cutoff,
    stalled,
  }
}

/**
 * The receipt for an attempt that applied at least one mutation. Complete only
 * when the child finished by itself; a budget cutoff, an abort, or a provider
 * error after the first mutation is `partial`, and the summary says so in the
 * first sentence so the parent cannot relay it as done.
 */
function receiptForAppliedAttempt(
  attempt: AttemptResult,
  fallbackUsed: boolean,
): DocEditReceipt {
  const stopped = attempt.cutoff ? attempt.cutoff.code : attempt.error
  if (!stopped) {
    return {
      status: 'completed',
      summary: attempt.summary,
      mutationTools: attempt.mutationTools,
      pageIds: attempt.pageIds,
      fallbackUsed,
    }
  }
  const cutoff = attempt.cutoff
  const why = !cutoff
    ? attempt.stalled
      ? `it stalled - ${attempt.error} - so the editor was stopped; the page is left as it was at that point`
      : `it was interrupted (${attempt.error})`
    : cutoff.code === 'max_turns'
      ? 'it ran out of editing turns'
      : cutoff.code === 'tool_budget_exhausted'
        ? 'it ran out of tool calls'
        : cutoff.code === 'tool_failure_limit'
          ? `it stopped after repeated ${cutoff.tool} failures`
          : `it stopped early (${cutoff.code})`
  return {
    status: 'partial',
    summary:
      `STOPPED EARLY - the page is NOT finished: the editor applied ${attempt.mutationTools.length} ` +
      `mutation(s) (${attempt.mutationTools.join(', ')}) and then ${why}. Some sections may be ` +
      `empty or unfinished. Tell the user exactly that, describe what did land, and offer to ` +
      `continue in the next turn. Editor's last words: ${attempt.summary}`,
    mutationTools: attempt.mutationTools,
    pageIds: attempt.pageIds,
    fallbackUsed,
    error: stopped,
  }
}

export async function runDocEditAgent(
  options: RunDocEditAgentOptions,
): Promise<DocEditReceipt> {
  const first = await runAttempt(options, options.model, 'background')
  if (first.mutationTools.length > 0) return receiptForAppliedAttempt(first, false)

  const canFallback = Boolean(
    options.fallbackModel && options.fallbackModel !== options.model,
  )
  if (canFallback) {
    const fallback = await runAttempt(
      options,
      options.fallbackModel!,
      'standard_fallback',
    )
    if (fallback.mutationTools.length > 0) return receiptForAppliedAttempt(fallback, true)
    return {
      status: 'failed',
      summary: fallback.summary,
      mutationTools: [],
      pageIds: [],
      fallbackUsed: true,
      error: fallback.error ?? first.error ?? 'No Doc mutation was applied.',
    }
  }

  return {
    status: 'failed',
    summary: first.summary,
    mutationTools: [],
    pageIds: [],
    fallbackUsed: false,
    error: first.error ?? 'No Doc mutation was applied.',
  }
}

export function toolsForDocEditIntent(
  tools: Map<string, Tool>,
  intent: 'create' | 'edit',
): Map<string, Tool> {
  if (intent === 'create') return tools
  return new Map(
    [...tools].filter(
      ([name]) => !['renderPage', 'createSubPage', 'importToPage'].includes(name),
    ),
  )
}

export type CreateDelegateDocEditToolOptions = Omit<
  RunDocEditAgentOptions,
  'instruction' | 'context' | 'loadPageContext'
> & {
  /** Existing open page validated and loaded by the route for this turn. */
  targetPageId?: string | null
  /** Every exact existing Page id validated for this turn. Full Chat supplies
   * freshly resolved readable room pins; Doc supplies its open page. */
  targetPageIds?: readonly string[]
  /** Rebuild the isolated tool map with mutations anchored to the selected
   * target. Create receives `null`; edit receives the validated input id. */
  toolsForTarget?: (targetPageId: string | null) => Map<string, Tool>
  /** Load fresh context for the selected target. The optional second argument
   * is absent only for create. */
  loadPageContext: (
    instruction: string,
    targetPageId?: string | null,
  ) => Promise<string>
}

export function createDelegateDocEditTool(
  options: CreateDelegateDocEditToolOptions,
): Tool<typeof delegateDocEditInputSchema> {
  const allowedPageIds = new Set(
    [options.targetPageId, ...(options.targetPageIds ?? [])]
      .filter((pageId): pageId is string => Boolean(pageId)),
  )
  // One gateway instance is minted per parent turn. It runs at most
  // DOC_EDIT_MAX_DELEGATIONS_PER_TURN children, and a second child is admitted
  // ONLY after a `failed` receipt (no mutation landed): the common cause is a
  // brief that pointed at evidence the isolated editor cannot fetch (a meeting
  // note, a transcript), so the supervisor must be able to gather it and
  // re-brief in the same turn. A `completed` or `partial` receipt closes the
  // gateway - a looping supervisor must not spawn further child transcripts,
  // and a half-edited page must not be re-run from the top.
  let delegations = 0
  let lastStatus: DocEditReceipt['status'] | null = null
  return buildTool<typeof delegateDocEditInputSchema>({
    name: DOC_EDIT_GATEWAY_TOOL,
    description:
      'Apply a requested Doc page, entity, or comment change through a fresh isolated editor. Choose edit only when runtime context supplies an exact allowed existing page id (the open Page, or a readable Page pinned in the current full-Chat room); an edit can never create a page. When several pinned Pages are allowed and the user did not clearly select one, ask which Page instead of guessing. Choose create only when the user explicitly asks for a new page. Submit one self-contained brief after gathering needed evidence. The editor has no search, brain, memory, recording, connector, or web tools and cannot see this conversation: every fact it needs must be pasted into the brief (the text itself, plus source page ids or URLs), never referenced. Questions that do not require a Doc mutation should be answered directly. The receipt status is completed, partial, or failed: partial means the editor applied some changes and was cut off before finishing - relay that honestly (what landed, what did not) and offer to continue in the next turn; never describe a partial result as done. A failed receipt whose summary starts with missing_evidence: names what the brief lacked; gather exactly that and call this tool once more with it pasted in (one retry is allowed after a no-change failure).',
    inputSchema: delegateDocEditInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    // No wall-clock: the child is progress-bounded (stall watchdog) and
    // cost-bounded (turns / tool calls). See DEFAULT_STALL_IDLE_MS.
    timeoutMs: NO_TOOL_TIMEOUT,
    maxResultSizeChars: 4_000,
    async execute(input, context) {
      const retryOpen = lastStatus === 'failed' && delegations < DOC_EDIT_MAX_DELEGATIONS_PER_TURN
      if (delegations > 0 && !retryOpen) {
        return {
          data: {
            status: 'failed',
            summary: lastStatus === 'failed'
              ? 'This turn already retried the Doc edit once and it still applied no change. Tell the user what evidence was missing and continue in a new user turn.'
              : 'This turn already delegated one Doc edit. Continue in a new user turn if another edit is needed.',
            mutationTools: [],
            pageIds: [],
            fallbackUsed: false,
            error: 'doc_edit_already_delegated',
          } satisfies DocEditReceipt,
          isError: true,
        }
      }
      if (input.intent === 'edit') {
        if (allowedPageIds.size === 0) {
          return {
            data: {
              status: 'failed',
              summary: 'No existing Doc Page is validated for this edit. Open the Page or pin it in this Chat room first; no new Page was created.',
              mutationTools: [],
              pageIds: [],
              fallbackUsed: false,
              error: 'missing_page_target',
            } satisfies DocEditReceipt,
            isError: true,
          }
        }
        if (!input.pageId || !allowedPageIds.has(input.pageId)) {
          return {
            data: {
              status: 'failed',
              summary: 'The requested page does not match the page validated for this turn.',
              mutationTools: [],
              pageIds: [],
              fallbackUsed: false,
              error: 'page_target_mismatch',
            } satisfies DocEditReceipt,
            isError: true,
          }
        }
      }
      delegations += 1
      const selectedPageId = input.intent === 'edit' ? input.pageId! : null
      const tools = toolsForDocEditIntent(
        options.toolsForTarget?.(selectedPageId) ?? options.tools,
        input.intent,
      )
      const receipt = await runDocEditAgent({
        provider: options.provider,
        model: options.model,
        fallbackModel: options.fallbackModel,
        systemPrompt: options.systemPrompt,
        instruction: input.instruction,
        tools,
        context,
        loadPageContext: (instruction) => options.loadPageContext(instruction, selectedPageId),
        onUsage: options.onUsage,
        onToolResult: options.onToolResult,
        maxTurns: options.maxTurns,
        maxToolCalls: options.maxToolCalls,
        stallIdleMs: options.stallIdleMs,
      })
      lastStatus = receipt.status
      const canRetry = receipt.status === 'failed' && delegations < DOC_EDIT_MAX_DELEGATIONS_PER_TURN
      return {
        data: canRetry
          ? {
              ...receipt,
              summary:
                `${receipt.summary} ` +
                'One retry is available this turn: gather the missing evidence with the tools in this conversation, paste it into the brief, and call delegateDocEdit again. Do not re-send the same brief.',
            }
          : receipt,
        isError: receipt.status === 'failed',
      }
    },
  })
}
