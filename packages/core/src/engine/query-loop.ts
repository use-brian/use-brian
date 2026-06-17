import { getHeapStatistics } from 'node:v8'
import type { LLMProvider, Message, ContentBlock, TokenUsage, AssistantResponse, SendOptions, ThinkingLevel, ToolDefinition, ToolParameter, ProviderSession } from '../providers/types.js'
import type { Tool, ToolContext, ToolResultMeta } from '../tools/types.js'
import type { AwaitingApprovalEvent, ConfirmationResolver, ToolConfirmationRequest } from '../mcp/types.js'
import { createAccumulator } from '../providers/accumulator.js'
import { createToolExecutor } from './tool-executor.js'
import { createLoopDetector, DEFAULT_HARD_LIMIT } from './loop-detector.js'
import { compactConversation } from '../compaction/compact.js'
import { isContextOverflowError } from '../providers/context-budget.js'

/**
 * Heap-pressure threshold for graceful loop abort. When the V8 heap exceeds
 * this fraction of its configured limit, the queryLoop bails out cleanly at
 * the next turn boundary — emits a status event, attempts to surface
 * whatever partial response exists, then yields turn_complete and returns.
 *
 * Without this, a long research turn (multi-wave workers + Gemini 3 Pro
 * high-thinking retries + accumulating session rawHistory) can drive the
 * api process to a hard FATAL ERROR OOM. The 5/26 traces showed memory
 * spike from ~200MB to the 4GB heap limit in ~60s, then crash. Soft-bailing
 * at 85% gives the user a partial answer instead of a server crash and
 * keeps subsequent requests working.
 *
 * 85% leaves enough headroom for V8's GC + the small allocations needed to
 * actually emit the turn_complete events and return.
 */
const HEAP_PRESSURE_ABORT_RATIO = 0.70

function isUnderHeapPressure(): boolean {
  try {
    const stats = getHeapStatistics()
    if (stats.heap_size_limit <= 0) return false
    return stats.used_heap_size / stats.heap_size_limit > HEAP_PRESSURE_ABORT_RATIO
  } catch {
    return false
  }
}

// One-shot boot-time confirmation that the OOM-defense build is loaded. If
// you see "Reached heap limit Allocation failed" without this banner having
// been logged at api startup, your dev server is running stale code (tsx
// watch didn't restart) and you should kill + restart the dev process.
console.log(
  `[query-loop] OOM defenses active: heap-pressure-ratio=${HEAP_PRESSURE_ABORT_RATIO}, ` +
  `per-turn check + mid-stream check + Gemini thought-part dropping + ` +
  `Gemini SSE 8MB per-event cap`,
)

// ── Query events (yielded to consumers) ────────────────────────

export type QueryEvent =
  | { type: 'text_delta'; text: string }
  /**
   * Verbatim model reasoning, streamed live as the model produces it.
   * Display-only — never accumulated into the persisted turn (the chat
   * route forwards it over SSE as `reasoning`; it is not a `user-visible
   * output` for the empty-turn fallback). See
   * docs/architecture/engine/live-streaming.md.
   */
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input'; id: string; name: string; input: Record<string, unknown> }
  /**
   * `metaByToolUseId` carries optional per-tool-call observability data
   * (e.g. which web search provider served a `webSearch` call). It is a
   * side channel — never serialized to the model, never persisted to
   * session_messages. Consumers can merge it into analytics event metadata.
   */
  | { type: 'tool_result'; id: string; results: ContentBlock[]; metaByToolUseId?: Record<string, ToolResultMeta> }
  /**
   * Retraction of a tool call the engine already streamed `tool_start`
   * (and possibly `tool_result`) for, but then dropped from the persisted
   * turn. Today it fires only for an `askQuestion` that gets stripped as a
   * no-op (mixed with other tools, or sole-tool while workers are still
   * running — see the strip branch below). The live SSE consumer renders a
   * tool-timeline step the moment `tool_start` arrives; without this event
   * a stripped `askQuestion` leaves a phantom "Asking a question" step that
   * never resolves into a question and contradicts the persisted turn. The
   * client removes the step keyed by `id`. See
   * docs/architecture/engine/askquestion-suspend-resume.md → "Retracting a
   * stripped call (tool_dropped)".
   */
  | { type: 'tool_dropped'; id: string; reason: 'askquestion_misuse' }
  | { type: 'tool_confirmation_required'; request: ToolConfirmationRequest }
  /**
   * Path B durability marker (WU-6.3). Fires once per suspended tool call,
   * immediately after `tool_confirmation_required`, but ONLY when the
   * executor persisted a `pending_approvals` row (i.e. the route wired
   * `ToolContext.createToolInvocationApproval`). It is distinct from
   * `tool_confirmation_required`: that event drives the channel UI; this
   * event is the durability signal a consumer uses to checkpoint the
   * suspension (write a `session_resume_points` row) so the approval
   * survives a process restart. Consumers without durable resume can
   * ignore it.
   *
   * See docs/plans/company-brain/approvals.md → "Chat resume — Path B".
   */
  | {
      type: 'awaiting_approval'
      approvalId: string
      toolCallId: string
      toolName: string
      toolInput: Record<string, unknown>
      describeText: string
      expiresAt: Date | null
      /** Position in this turn's tool-call sequence — mirrors
       *  `session_resume_points.loop_step_index`. */
      loopStepIndex: number
    }
  /**
   * Fires once per turn after all tool_results for that turn are drained.
   * `response.content` is the assistant's finalised blocks (text + tool_use)
   * and `toolResults` is the paired result blocks for the tool_use blocks
   * in that same turn. Consumers that persist a transcript MUST buffer on
   * this event rather than `turn_complete` — `turn_complete` only fires
   * when the loop exits, so intermediate tool-use turns never surface via
   * `turn_complete`.
   */
  | { type: 'assistant_turn'; response: AssistantResponse; toolResults: ContentBlock[] }
  /**
   * Citation sources surfaced during a turn. Fires from two paths:
   * (1) the `grounding_metadata` provider chunk (no-tool worker turns where
   *     Gemini's passive grounding is still active), and
   * (2) a successful `webSearch` tool result, synthesized from the returned
   *     result list.
   * Consumers can render these as footnotes / source cards. See
   * docs/architecture/integrations/search-and-fetch.md.
   */
  | { type: 'citation'; sources: Array<{ url: string; title: string }> }
  | { type: 'turn_complete'; response: AssistantResponse; totalUsage: TokenUsage }
  | { type: 'status'; message: string }
  | { type: 'error'; error: Error }

// ── Query loop options ─────────────────────────────────────────

export type QueryLoopOptions = {
  provider: LLMProvider
  model: string
  systemPrompt: string
  messages: Message[]
  tools: Map<string, Tool>
  context: ToolContext
  maxTurns?: number
  /**
   * Absolute tool-call cap for this invocation — the loop-detector hard stop.
   * Defaults to `DEFAULT_HARD_LIMIT` (10). Raised for deep-research runs;
   * see `packages/core/src/engine/research-depth.ts`.
   */
  maxToolCalls?: number
  onTurnStart?: (turn: number) => void
  /**
   * Fires after each turn finishes — after the assistant_turn event is
   * yielded and Phase 5 builds the next-turn message payload. Receives
   * the turn index and a snapshot of the full stateless history (only
   * populated when `options.stateless` is true; an empty array otherwise).
   *
   * Used by the WorkerManager (Phase 3 of askQuestion suspend-resume) to
   * persist per-turn-boundary history into `worker_runs.history_json` so
   * a Cloud Run rotation mid-research can rehydrate workers from the
   * last completed turn instead of restarting from scratch. Non-throwing
   * by contract — the loop ignores the callback's promise so a slow DB
   * write doesn't block streaming.
   *
   * See docs/architecture/engine/askquestion-suspend-resume.md.
   */
  onTurnEnd?: (turn: number, history: Message[]) => void | Promise<void>
  /** Channel type — controls max_tokens recovery behavior (web auto-continues, messaging stops). */
  channelType?: string
  /**
   * Completeness gate over the execution-plan tier. When set, a tool-less
   * turn whose session has an `active` plan with open steps continues (with a
   * nudge) instead of ending — until every step is done/blocked or budget
   * runs out, at which point one model-generated resumable handoff turn fires.
   * `status` returns `null` when there is no active plan (the common path,
   * one cheap read per terminal-exit attempt). See
   * `docs/architecture/context-engine/execution-plan.md`.
   */
  planGate?: {
    status(sessionId: string): Promise<
      | { open: number; total: number; openSteps: { key: string; description: string }[] }
      | null
    >
  }
  /** Max plan continuation nudges per attempt (tier-scaled). Default 3. */
  planNudgeCap?: number
  /** Compact model for reactive compaction on context overflow errors. */
  compactModel?: string
  /** Resolver for tools that require user confirmation. If not provided, confirmation is skipped. */
  confirmationResolver?: ConfirmationResolver
  /** Timeout for confirmation prompts in ms (default: 5 min for messaging, 24h for web). */
  confirmationTimeoutMs?: number
  /**
   * Use stateless streaming instead of a stateful session. When true, each turn
   * rebuilds the full message history and calls `provider.stream()` — no in-memory
   * rawHistory accumulation (no thought signature retention). Use for short-lived
   * loops like workers where session persistence is unnecessary and memory matters.
   */
  stateless?: boolean
  /**
   * Suppress intermediate text by default. When true, no `text_delta` is
   * yielded (and the underlying text is dropped from the persisted turn) until
   * Phase 4b drains worker results and un-suppresses for the synthesis turn.
   *
   * Use this in coordinator mode and any other context where the caller knows
   * the first turn(s) are tool-orchestration only and the model is told not to
   * write text. Without it, leading thinking-style preambles ("Be concise…",
   * "Let me check the brand voice…") emitted *before* the first `spawnWorker`
   * tool_use_start chunk leak to the SSE stream — the existing reactive
   * `suppressText` flip happens too late to catch them.
   *
   * See docs/architecture/engine/query-loop.md → "Intermediate text
   * suppression".
   */
  suppressIntermediateText?: boolean
  /**
   * Path B durable chat resume marker (Q22 RESOLVED). When set, this
   * invocation is being driven by the session-resume worker after a Cloud
   * Run restart-loss: the caller has already loaded session history,
   * invoked (or synthesized) the suspended tool result, and assembled
   * `messages` to include it as the trailing user-role tool_result block.
   * queryLoop itself runs normally — the model sees the tool result and
   * produces the next assistant turn. The field exists so the loop can
   * emit a single `status` event at start, giving downstream persistence
   * and analytics a clear marker that this turn is a resumed continuation
   * rather than a fresh user message. No behavioural change otherwise.
   *
   * See docs/plans/company-brain/approvals.md → "Chat resume — Path B".
   */
  resumeContext?: {
    approvalId: string
    suspendedToolName: string
    /** Mirrors `session_resume_points.loop_step_index`. Informational. */
    loopStepIndex: number
  }
  /**
   * Optional callback that builds the user-role message injected by Phase
   * 4b when background workers complete and need synthesis. Receives the
   * formatted `<worker-result>` notification text AND the raw
   * `WorkerResult[]` array so the caller can branch on worker status
   * (e.g. force a respawn turn when any worker returned `status='failed'`
   * rather than running synthesis with bad data).
   *
   * If absent, falls back to the default template which pushes brain
   * ingestion + a single synthesis reply — appropriate for the
   * splitter-triggered coordinator path. Research-mode chats override
   * this with a status-aware template that forces respawn for failed
   * workers (e.g. protocol-violation skips of urlReader) before allowing
   * any synthesis.
   */
  workerDrainPrompt?: (
    notificationText: string,
    results: import('../workers/worker.js').WorkerResult[],
  ) => string
  /**
   * Opt-in: turn `askQuestion` into a suspending tool. When the model
   * calls `askQuestion` as the sole tool this turn AND no background
   * workers are pending, the engine persists a `kind='question'` row via
   * `context.createPendingQuestion`, emits `tool_confirmation_required` +
   * `awaiting_approval`, and exits the generator WITHOUT firing
   * `turn_complete` — the session is suspended waiting for the user's
   * answer.
   *
   * Disabled by default. Workers / scheduled-job / smoke-test contexts
   * keep the legacy terminal-exit behavior; the chat route opts in so
   * users get mid-research clarification without losing in-flight state.
   * Also requires `context.createPendingQuestion` to be set — without it
   * the engine falls back to terminal exit.
   *
   * See docs/architecture/engine/askquestion-suspend-resume.md.
   */
  questionResumeEnabled?: boolean
}

// ── Query loop ─────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 15

/**
 * Empty-response recovery plans. Gemini 3 Pro can exit a turn with
 * `stopReason: STOP` and no visible content when HIGH thinking converges on
 * "nothing to say." Each step is tried in order when the prior turn produced
 * no text and no tool_use. Step 1 keeps reasoning quality (same thinking
 * level, pushy nudge); step 2 downshifts to LOW to force a commit. Total
 * attempts are also bounded by `EMPTY_RETRY_WALL_MS` from loop start — if
 * the overall wall-clock budget is gone, we exit immediately so the user
 * doesn't wait forever.
 *
 * Two variants are needed because the right recovery depends on whether the
 * loop has already produced tool results:
 *
 * - `AFTER_TOOLS`: prior turns called tools and gathered context, then the
 *   model went silent during synthesis. Forbid further tool calls so the
 *   model commits to a text reply using what it has.
 *
 * - `BEFORE_TOOLS`: the model went silent on turn 0 (or after only no-op
 *   turns). Forbidding tools here defeats prompts that explicitly need them
 *   ("research X and save to brain") — the model gives up rather than
 *   acting. Permit tool use so the model can still make progress.
 *
 * See docs/architecture/engine/query-loop.md → "Empty-response recovery"
 * and the investigation notes referencing the 9.1% silent-failure rate on
 * `gemini-3.1-pro-preview` turns with large inputs.
 */
type EmptyRetryStep = {
  nudge: string
  thinkingLevel: ThinkingLevel | undefined
}

const EMPTY_RETRY_PLAN_AFTER_TOOLS: ReadonlyArray<EmptyRetryStep> = [
  {
    nudge:
      'Your previous response was empty. Based on the information already gathered, write the response to the user now. Do not call any more tools.',
    thinkingLevel: undefined,
  },
  {
    nudge:
      'You must reply with text right now. Write at least one complete sentence using the information you already have. Do not think further. Do not call any tools.',
    thinkingLevel: 'low',
  },
]

const EMPTY_RETRY_PLAN_BEFORE_TOOLS: ReadonlyArray<EmptyRetryStep> = [
  {
    nudge:
      'Your previous response was empty. Take action now — either call a tool to make progress on the user\'s request, or write a direct response. Do not stay silent.',
    thinkingLevel: undefined,
  },
  {
    nudge:
      'You must respond now. Either call exactly one tool to make progress, or write at least one complete sentence acknowledging the request. Do not think further.',
    thinkingLevel: 'low',
  },
]

const EMPTY_RETRY_PLAN_LENGTH = EMPTY_RETRY_PLAN_AFTER_TOOLS.length
const EMPTY_RETRY_WALL_MS = 90_000

/**
 * Transient stream errors are retried once with a short backoff. Covers the
 * provider-side stalls our `wrapIdleTimeout` aborts (Gemini fetch hangs for
 * 30s with no chunks) plus common network blips (ECONNRESET, 503/504 from
 * upstream). The retry is gated on `hasYieldedUserVisibleOutput` — a stall
 * after a chunk has already streamed to the consumer cannot be retried
 * without duplicating UI output, so it propagates as an error event.
 *
 * Single retry, not exponential. The class of errors we cover is overwhelmingly
 * single-shot transient (idle Gemini fetch, blip on the upstream gateway); a
 * second failure on the same turn means the upstream is genuinely down and
 * looping costs the user another wall-clock budget without changing the
 * outcome.
 *
 * See docs/architecture/engine/query-loop.md → "Transient stream retry".
 */
const MAX_TRANSIENT_RETRIES = 1
const TRANSIENT_RETRY_BACKOFF_MS = 2_000

/**
 * Default Phase 4b worker-drain message — appropriate for
 * splitter-triggered coordinator chats where there's no per-mode
 * addendum in the system prompt.
 *
 * Data-only by design. Previous versions inlined paragraphs of
 * ingestion rules ("Facts about the USER → updateSelfProfile…")
 * into this synthetic user message; the model occasionally echoed
 * those rules back as its reply. The rules already live in the
 * base system prompt + the relevant tool descriptions, so we just
 * deliver the worker outcomes here. If a callsite needs richer
 * protocol guidance, it sits in the system prompt addendum (where
 * it's cached and less echo-prone), not in this per-turn message.
 */
function defaultWorkerDrainPrompt(notificationText: string): string {
  return `Worker results:\n\n${notificationText}\n\nIngest findings into the brain via the appropriate save tool, then reply to the user.`
}

export async function* queryLoop(options: QueryLoopOptions): AsyncGenerator<QueryEvent> {
  const {
    provider,
    model,
    systemPrompt,
    tools,
    context,
    maxTurns = DEFAULT_MAX_TURNS,
    maxToolCalls = DEFAULT_HARD_LIMIT,
  } = options

  const loopDetector = createLoopDetector({ hardLimit: maxToolCalls })
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  // WU-6.3 — monotonic position in this loop's tool-call sequence. Stamped
  // onto each `awaiting_approval` event so the resume worker can re-enter
  // the loop at the right step. Bumped each time a tool_use_end is seen.
  let loopStepIndex = 0
  let hasAttemptedReactiveCompact = false
  let maxTokensContinuations = 0
  let emptyResponseRetries = 0
  let transientRetries = 0
  const loopStartTime = Date.now()
  // Thinking-level override for the next turn. Undefined = provider default.
  // Set on empty-response retries per EMPTY_RETRY_PLAN.
  let nextThinkingLevel: ThinkingLevel | undefined
  // Suppress text streaming while workers are pending (coordinator intermediate chatter).
  // Only stream text on the final synthesis turn after Phase 4b drains all results.
  //
  // When `suppressIntermediateText` is set, start suppressed so leading
  // thinking-style preambles ("Be concise…", "Let me draft…") emitted BEFORE
  // the first spawnWorker tool_use_start chunk are caught. Without this,
  // Gemini's part order `[text, functionCall]` leaks the text portion before
  // the reactive flip in the spawnWorker branch can fire.
  let suppressText = options.suppressIntermediateText === true

  // Build tool definitions for the LLM
  const toolDefinitions: ToolDefinition[] = Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema._def
      ? jsonSchemaFromZod(t.inputSchema)
      : { type: 'object' as const, properties: {} as Record<string, ToolParameter> },
  }))

  // In stateless mode, use provider.stream() each turn (no rawHistory accumulation).
  // In stateful mode, use a persistent session that preserves thought signatures.
  // `context.abortSignal` rides through to the provider's underlying `fetch`
  // so a client disconnect actually cancels in-flight HTTP, instead of being
  // a no-op while we wait for Cloud Run's 300s cap.
  const session = options.stateless ? null : provider.createSession({
    model,
    systemPrompt,
    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    signal: context.abortSignal,
  })

  // Messages to send on each turn. In stateless mode, this accumulates the
  // full conversation history. In stateful mode, only the new turn is sent.
  let nextMessages: Message[] = [...options.messages]
  // Full history for stateless mode — rebuilt each turn with assistant + tool results
  let statelessHistory: Message[] = options.stateless ? [...options.messages] : []
  let lastToolResults: ContentBlock[] = []
  let lastResponse: AssistantResponse | undefined

  // Completeness gate state (execution-plan tier). `planNudges` caps the
  // "keep working" continuations per attempt; `planHandoffDone` guards the
  // single resumable-handoff turn so the loop can't re-nudge after it.
  let planNudges = 0
  let planHandoffDone = false

  // Shared across turns: tools denied or timed-out are blocked for the rest
  // of this queryLoop call (one user message) but reset on the next message.
  const deniedTools = new Set<string>()

  if (options.resumeContext) {
    const rc = options.resumeContext
    yield {
      type: 'status',
      message: `Resuming session from approval ${rc.approvalId} (tool=${rc.suspendedToolName}, step=${rc.loopStepIndex})`,
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    options.onTurnStart?.(turn)

    // ── Heap-pressure abort ────────────────────────────────────
    // Bail out cleanly before V8 OOMs. Multi-wave research turns with
    // Gemini 3 Pro high-thinking retries can spike heap from ~200MB to
    // the configured limit in seconds (5/26 4GB OOM). At 85% we emit a
    // graceful partial response instead of crashing the api process.
    if (isUnderHeapPressure()) {
      console.warn(
        `[query-loop] Heap pressure at turn ${turn} — aborting cleanly to avoid OOM`,
      )
      yield {
        type: 'status',
        message: 'System under load — wrapping up with what I have so far.',
      }
      const partial: AssistantResponse = lastResponse ?? {
        content: [{
          type: 'text',
          text: 'I had to stop early because the server is under heavy load. Please try this again in a moment, or break the request into smaller pieces.',
        }],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
      }
      yield { type: 'assistant_turn', response: partial, toolResults: [] }
      yield { type: 'turn_complete', response: partial, totalUsage }
      return
    }

    // ── Phase 2: API call ──────────────────────────────────────
    const accumulator = createAccumulator()
    const allToolResults: ContentBlock[] = []
    const toolNames = new Map<string, string>()

    const pendingConfirmations: ToolConfirmationRequest[] = []
    // WU-6.3 — durability events queued by the executor when a suspended
    // tool persisted a `pending_approvals` row. Drained alongside
    // `pendingConfirmations` at the same flush sites, enriched with the
    // loop step index. Stays empty in Path A (in-memory-only) contexts.
    const pendingAwaitingApprovals: Array<QueryEvent & { type: 'awaiting_approval' }> = []

    const toolExecutor = createToolExecutor({
      tools,
      context,
      loopDetector,
      deniedTools,
      confirmationResolver: options.confirmationResolver,
      confirmationTimeoutMs: options.confirmationTimeoutMs,
      onConfirmationRequired: (request) => {
        pendingConfirmations.push(request)
      },
      onAwaitingApproval: (event: AwaitingApprovalEvent) => {
        pendingAwaitingApprovals.push({
          type: 'awaiting_approval',
          ...event,
          loopStepIndex,
        })
      },
    })

    const toolInputBuffers = new Map<string, string>()

    // Tracks whether anything user-visible has been yielded for this turn.
    // Gates the transient-error retry below: once a chunk has streamed to
    // the consumer, retrying the upstream call would duplicate that output.
    let hasYieldedUserVisibleOutput = false

    try {
      // Stateless: send full history via provider.stream() (no rawHistory accumulation).
      // Stateful: send only new messages via session.send() (preserves thought signatures).
      const sendOpts: SendOptions | undefined = nextThinkingLevel
        ? { thinkingLevel: nextThinkingLevel }
        : undefined
      const modelStream = session
        ? session.send(nextMessages, sendOpts)
        : provider.stream({
            model,
            systemPrompt,
            messages: statelessHistory,
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
            ...(nextThinkingLevel ? { thinkingLevel: nextThinkingLevel } : {}),
            signal: context.abortSignal,
          })
      // Consumed — clear so non-retry turns revert to the provider default.
      nextThinkingLevel = undefined

      // Suppress intermediate text only while workers haven't delivered any results yet.
      // Once Phase 4b sets suppressText=false (after first drain), it stays off permanently.

      // Mid-stream heap-pressure tracking. The per-turn pressure check at
      // the top of the loop only catches OOM-imminent state at turn
      // boundaries; production 5/26 4GB OOM happened DURING a stream
      // (heap went from 78MB to 4GB while consuming chunks). We sample
      // heap every N chunks and bail mid-stream if pressure spikes.
      //
      // N=25 is aggressive — the 5/26 trace showed individual streams
      // emitting 5-15 chunks, meaning a 200-chunk interval was too coarse
      // to fire before OOM. getHeapStatistics() is a microsecond-cost
      // syscall; calling it every chunk would be fine, every 25 is more
      // than safe.
      const HEAP_CHECK_EVERY = 25
      let chunksSinceHeapCheck = 0

      for await (const chunk of modelStream) {
        chunksSinceHeapCheck++
        if (chunksSinceHeapCheck >= HEAP_CHECK_EVERY) {
          chunksSinceHeapCheck = 0
          if (isUnderHeapPressure()) {
            console.warn(
              `[query-loop] Heap pressure mid-stream on turn ${turn} — aborting stream to avoid OOM`,
            )
            // Throwing aborts the for-await loop and propagates up to the
            // outer try/catch where it's handled like any provider error.
            // The accumulator's partial state is discarded.
            throw new Error('queryLoop aborted: heap-pressure threshold exceeded mid-stream')
          }
        }
        // Drop suppressed text from the accumulator too — otherwise the
        // suppressed preamble still lands in the persisted assistant_turn
        // and surfaces on session reload, defeating the live suppression.
        if (chunk.type === 'text_delta' && suppressText) {
          // intentionally skip both yield and accumulator.push for this chunk
        } else {
          accumulator.push(chunk)
        }

        if (chunk.type === 'text_delta' && !suppressText) {
          yield { type: 'text_delta', text: chunk.text }
          hasYieldedUserVisibleOutput = true
        }

        // Verbatim reasoning — re-emit live for the chat route to forward as
        // SSE `reasoning`. Deliberately NOT gated on `suppressText` (reasoning
        // is a separate channel from the visible reply) and deliberately does
        // NOT set `hasYieldedUserVisibleOutput` — a turn of pure thinking with
        // no text/tool output must still trip the empty-turn fallback.
        if (chunk.type === 'thinking_delta') {
          yield { type: 'thinking_delta', text: chunk.text }
        }

        if (chunk.type === 'tool_use_start') {
          toolNames.set(chunk.id, chunk.name)
          toolInputBuffers.set(chunk.id, '')
          yield { type: 'tool_start', id: chunk.id, name: chunk.name }
          hasYieldedUserVisibleOutput = true
          // askQuestion needs its accompanying text visible to the user
          // Suppress text while coordinator is spawning workers — user shouldn't
          // see intermediate chatter like "I'm sending workers..."
          if (chunk.name === 'spawnWorker') suppressText = true
          // But askQuestion needs its text visible
          if (chunk.name === 'askQuestion') suppressText = false
        }

        if (chunk.type === 'tool_use_delta') {
          const prev = toolInputBuffers.get(chunk.id) ?? ''
          toolInputBuffers.set(chunk.id, prev + chunk.input)
        }

        if (chunk.type === 'tool_use_end') {
          const inputJson = toolInputBuffers.get(chunk.id) ?? '{}'
          let input: Record<string, unknown> = {}
          try { input = JSON.parse(inputJson) } catch { /* empty */ }
          const name = toolNames.get(chunk.id) ?? 'unknown'
          yield { type: 'tool_input', id: chunk.id, name, input }
          toolExecutor.addTool(chunk.id, name, input)
          toolInputBuffers.delete(chunk.id)
          // WU-6.3 — advance the loop step cursor. The awaiting_approval
          // event stamped after this tool suspends carries this index.
          loopStepIndex++
        }

        // Forward Gemini passive grounding citations (no-tool worker turns).
        // When explicit tools are passed to the provider, grounding is gated
        // off and this path is inert — citation events instead come from the
        // webSearch tool result drain path below.
        if (chunk.type === 'grounding_metadata' && chunk.sources.length > 0) {
          yield { type: 'citation', sources: chunk.sources }
          hasYieldedUserVisibleOutput = true
        }

        // Flush confirmation requests that arrived during streaming.
        // The durability `awaiting_approval` event follows immediately
        // after — same drain order keeps "UI event, then checkpoint".
        while (pendingConfirmations.length > 0) {
          yield { type: 'tool_confirmation_required', request: pendingConfirmations.shift()! }
        }
        while (pendingAwaitingApprovals.length > 0) {
          yield pendingAwaitingApprovals.shift()!
        }

        // Drain completed tool results during streaming
        const completed = toolExecutor.getCompletedResults()
        if (completed.blocks.length > 0) {
          allToolResults.push(...completed.blocks)
          yield { type: 'tool_result', id: '', results: completed.blocks, metaByToolUseId: completed.metaByToolUseId }
          const citations = extractCitationsFromToolResults(completed.blocks)
          if (citations.length > 0) {
            yield { type: 'citation', sources: citations }
          }
        }
      }
    } catch (err) {
      // Layer 4: reactive compact on context overflow — compact and retry once
      if (isContextOverflowError(err) && !hasAttemptedReactiveCompact && options.compactModel) {
        hasAttemptedReactiveCompact = true
        yield { type: 'status', message: 'Context too large, compacting...' }
        try {
          const compactResult = await compactConversation({
            provider,
            model: options.compactModel,
            messages: nextMessages,
            systemPrompt,
          })
          nextMessages = [compactResult.boundaryMessage]
          if (options.stateless) statelessHistory = [compactResult.boundaryMessage]
          continue // retry the API call with compacted messages
        } catch {
          // Compaction itself failed — fall through to error
        }
      }

      // Transient stream retry: provider stalled or upstream blipped before
      // any chunk reached the consumer. Retry once with a short backoff so a
      // single Gemini fetch hang doesn't surface as "I couldn't generate a
      // response" to the user. Skipped if a chunk has already streamed
      // (would duplicate output) or the caller aborted (user cancelled).
      // Session state is unaffected by a mid-fetch failure on Gemini —
      // `rawHistory` only updates after a successful response — so resending
      // the same `nextMessages` is safe. See docs/architecture/engine/
      // query-loop.md → "Transient stream retry".
      if (
        isTransientStreamError(err)
        && !hasYieldedUserVisibleOutput
        && transientRetries < MAX_TRANSIENT_RETRIES
        && !context.abortSignal?.aborted
      ) {
        transientRetries++
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[query-loop] Transient stream error on turn ${turn}: ${errMsg} — retry ${transientRetries}/${MAX_TRANSIENT_RETRIES} after ${TRANSIENT_RETRY_BACKOFF_MS}ms`,
        )
        yield { type: 'status', message: 'Connection stalled, retrying...' }
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_BACKOFF_MS))
        continue
      }

      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
      return
    }

    // Reaching here means the stream completed without throwing — no stall
    // this turn. Refund the transient-retry budget so a *later* turn that
    // hits an independent stall still gets its one retry. The budget is
    // meant to be per-stall (one warm-cache retry after a cold-prefill idle —
    // see MAX_TRANSIENT_RETRIES), but `transientRetries` was declared at loop
    // scope and never reset, so the FIRST idle anywhere in the loop
    // permanently denied every later turn its retry. Prod 2026-06-10 (session
    // ab96e27e, user 99c7fb99): a .docx dropped into a long doc-editor session
    // idled turn 0 (>30s prefill TTFT on the oversized prompt) → warm-cache
    // retry recovered → getCurrentPage returned the full page → the next turn
    // re-prefilled the now-larger prompt, idled the same way with no budget
    // left, and surfaced as query_loop_error with no reply. The same-step
    // double-stall guard still holds: two consecutive stalls on one logical
    // step never reach this line between them (the second throws first).
    transientRetries = 0

    const response = accumulator.finish()
    totalUsage.inputTokens += response.usage.inputTokens
    totalUsage.outputTokens += response.usage.outputTokens
    totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0)
    totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0)

    // ── Turn-boundary instruction-leak sanitiser ────────────────
    // When the WHOLE assistant text is a plan-tail meta-narration
    // ("Then, answer the user's question.", "Now I'll reply to the
    // user.", etc.) we strip the text from response.content. The empty
    // turn that remains then triggers EMPTY_RETRY_PLAN below, which
    // re-prompts the model to produce a real reply. The original leak
    // was streamed live (we can't unstream it), but the retry's reply
    // streams in after and the persisted assistant message stays
    // clean, so future-turn context isn't poisoned. Surfaced
    // 2026-05-27 on Anson / GRI (session 19e48b38) where Flash 3.5
    // emitted exactly " Then, answer the user's question." as the
    // whole final turn after the loop-detector blocked duplicate tool
    // calls. Previously this detector only ran inside
    // `forceTextResponse` (hard-limit path) and missed normal turns.
    {
      // First strip a leading scaffold-primer line ("Your reply to the user
      // MUST start here:\n…") in place, keeping the real reply that follows —
      // these slip past the whole-text detector below when a full reply
      // trails the marker (2026-06-02, session b0903ea6: 209 chars > the ≤200
      // plan-tail gate). Then fall back to full-text suppression when the
      // entire turn still reads as a leak.
      let strippedPrimer = false
      response.content = response.content.map((b) => {
        if (b.type === 'text' && 'text' in b) {
          const stripped = stripInstructionLeakPrefix(b.text)
          if (stripped !== b.text) strippedPrimer = true
          return { ...b, text: stripped }
        }
        return b
      })
      if (strippedPrimer) {
        console.warn(`[query-loop] turn ${turn} scaffold-primer prefix stripped`)
      }
      const textBlocks = response.content.filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b,
      )
      const combinedText = textBlocks.map((b) => b.text).join('').trim()
      if (combinedText.length > 0 && looksLikeInstructionLeak(combinedText)) {
        console.warn(
          `[query-loop] turn ${turn} text suppressed (instruction leak): "${combinedText.slice(0, 200)}"`,
        )
        response.content = response.content.filter((b) => b.type !== 'text')
      }
    }

    // ── Phase 3: Drain remaining tool results ──────────────────
    // Pass hasPendingEvents so the executor yields even with 0 results
    // when inner-tool confirmations (e.g. mcp_call ask policy) are waiting.
    for await (const results of toolExecutor.getRemainingResults(
      () => pendingConfirmations.length > 0 || pendingAwaitingApprovals.length > 0,
    )) {
      // Flush any confirmation requests that arrived while waiting
      while (pendingConfirmations.length > 0) {
        yield { type: 'tool_confirmation_required', request: pendingConfirmations.shift()! }
      }
      while (pendingAwaitingApprovals.length > 0) {
        yield pendingAwaitingApprovals.shift()!
      }
      if (results.blocks.length > 0) {
        allToolResults.push(...results.blocks)
        yield { type: 'tool_result', id: '', results: results.blocks, metaByToolUseId: results.metaByToolUseId }
        const citations = extractCitationsFromToolResults(results.blocks)
        if (citations.length > 0) {
          yield { type: 'citation', sources: citations }
        }
      }
    }

    // Final flush of any remaining confirmations + durability events.
    while (pendingConfirmations.length > 0) {
      yield { type: 'tool_confirmation_required', request: pendingConfirmations.shift()! }
    }
    while (pendingAwaitingApprovals.length > 0) {
      yield pendingAwaitingApprovals.shift()!
    }

    // askQuestion question-surfacing — runs BEFORE the assistant_turn yield
    // below so the persisted turn carries the question as a real text block.
    // The model frequently calls askQuestion without emitting accompanying
    // user-facing text (coordinator mode even suppresses text); the question
    // sits only in the tool_use's `input.question` field. Without this
    // injection, the persisted assistant message has tool_use blocks but no
    // text — frontend shows "I couldn't generate a response." Production
    // trace 5/26 22:49: coordinator emitted spawnWorker × 4 + askQuestion in
    // one turn, question never surfaced. The actual loop-termination check
    // for askQuestion lives further down (before Phase 4b); this block only
    // injects the question into the turn record.
    // askQuestion is structurally terminal ONLY when it was the sole tool
    // called this turn. The model has been observed (5/27 trace) using
    // askQuestion as a "wait..." status narration channel alongside
    // spawnWorker — in that pathological case, treating it as terminal
    // would kill an in-progress research run AND surface a useless
    // "Wait..." question to the user. So: if askQuestion was mixed with
    // other tool calls, drop it as a no-op and let the loop continue
    // normally; the workers will run, Phase 4b will drain, synthesis will
    // happen. Only when askQuestion is the sole call do we surface the
    // question text and exit.
    const toolResultBlocks = allToolResults.filter(
      (r): r is ContentBlock & { type: 'tool_result'; name: string } =>
        r.type === 'tool_result',
    )
    // Three askQuestion outcomes — see docs/architecture/engine/
    // askquestion-suspend-resume.md → "When askQuestion suspends vs.
    // terminates vs. strips":
    //   1. sole tool + no workers pending     → terminal OR suspend (decided below)
    //   2. sole tool + workers pending        → strip (model misuse as status)
    //   3. mixed with other tool calls        → strip (model misuse as status)
    const askQuestionIsSoleTool =
      toolResultBlocks.length > 0
      && toolResultBlocks.every((r) => r.name === 'askQuestion')
    const workersStillActive = context.workerManager
      ? (context.workerManager.pendingCountFor(context.sessionId) > 0 || context.workerManager.hasNotificationsFor(context.sessionId))
      : false
    const askQuestionCalledThisTurn = askQuestionIsSoleTool && !workersStillActive
    const askQuestionMisusedAsStatus =
      (askQuestionIsSoleTool && workersStillActive)
      || (
        toolResultBlocks.some((r) => r.name === 'askQuestion')
        && toolResultBlocks.some((r) => r.name !== 'askQuestion')
      )

    if (askQuestionCalledThisTurn) {
      const askQuestionToolUse = response.content.find(
        (b): b is ContentBlock & { type: 'tool_use' } =>
          b.type === 'tool_use' && b.name === 'askQuestion',
      )
      const question = askQuestionToolUse
        ? (askQuestionToolUse.input as { question?: unknown }).question
        : undefined
      const hasUserVisibleText = response.content.some(
        (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text.trim().length > 0,
      )
      if (typeof question === 'string' && question.length > 0 && !hasUserVisibleText) {
        // Live-stream the question for the SSE consumer (frontend renders
        // it immediately) and prepend it to response.content so the persisted
        // turn carries it through reloads. unshift so the question appears
        // ahead of the tool_use blocks in the rendered message.
        yield { type: 'text_delta', text: question }
        response.content.unshift({ type: 'text', text: question })
      }
    } else if (askQuestionMisusedAsStatus) {
      // Strip the askQuestion tool_use + its tool_result so the pairing
      // invariant holds and the user doesn't see meaningless "Please
      // wait..." artifacts surfaced as if they were real questions. The
      // loop continues:
      //   - sole-tool misuse + pending workers → Phase 4b drains workers
      //   - mixed-tools misuse → other tool results feed the next turn
      const reason = askQuestionIsSoleTool
        ? `workers still running (pendingCount=${context.workerManager?.pendingCountFor(context.sessionId) ?? 0}, hasNotifications=${context.workerManager?.hasNotificationsFor(context.sessionId) ?? false})`
        : 'called alongside other tools'
      console.warn(
        `[query-loop] askQuestion on turn ${turn} — stripping as no-op (model misuse: ${reason}).`,
      )
      const askQuestionToolUseIds = new Set<string>()
      response.content = response.content.filter((b) => {
        if (b.type === 'tool_use' && b.name === 'askQuestion') {
          askQuestionToolUseIds.add(b.id)
          return false
        }
        return true
      })
      // Mutate allToolResults in place to drop the orphaned tool_results.
      for (let i = allToolResults.length - 1; i >= 0; i--) {
        const r = allToolResults[i]
        if (r.type === 'tool_result' && askQuestionToolUseIds.has(r.toolUseId)) {
          allToolResults.splice(i, 1)
        }
      }
      // Retract the already-streamed tool step. `tool_start` (and
      // `tool_result`, since askQuestion executes) fired live during this
      // turn, BEFORE this end-of-turn strip — so the client's tool timeline
      // is showing a phantom "Asking a question" step. Tell it to drop the
      // entry so the live UI matches the persisted (stripped) turn.
      for (const droppedId of askQuestionToolUseIds) {
        yield { type: 'tool_dropped', id: droppedId, reason: 'askquestion_misuse' }
      }
    }

    // ── Phase 3b: Per-turn assistant record ────────────────────
    // Emit the completed turn (assistant content + its matched tool_results)
    // for consumers that persist transcripts. This fires for EVERY turn
    // including intermediate tool-use turns — unlike `turn_complete` which
    // is reserved as the terminal "loop exited" marker.
    yield { type: 'assistant_turn', response, toolResults: [...allToolResults] }

    // Phase 3 of askQuestion suspend-resume — fire onTurnEnd here, BEFORE
    // the Phase 4 done-check that early-returns on a no-more-tools turn.
    // The snapshot includes statelessHistory PLUS this turn's assistant
    // response, since the later statelessHistory.push happens in Phase 5
    // which doesn't run on terminal turns.
    try {
      const snapshot: Message[] = options.stateless
        ? [...statelessHistory, { role: 'assistant', content: response.content }]
        : []
      const ret = options.onTurnEnd?.(turn, snapshot)
      if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
        ;(ret as Promise<unknown>).catch((err) => {
          console.warn(`[query-loop] onTurnEnd hook rejected: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } catch (err) {
      console.warn(`[query-loop] onTurnEnd hook threw: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Save for maxTurns fallback
    lastToolResults = [...allToolResults]
    lastResponse = response

    // ── Phase 4: Check if done ─────────────────────────────────
    const hasToolUse = response.content.some((b) => b.type === 'tool_use')
    const hasText = response.content.some(
      (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text.trim().length > 0,
    )

    // Empty-response recovery: model produced only thinking tokens with no
    // visible output (no text, no tool calls). This happens on Gemini 3 Pro
    // *and* Flash (thinking-mode) when HIGH-level thinking converges on
    // "nothing to say" — the API exits cleanly with stopReason=STOP and
    // empty content. Triggers on any turn including turn 0: a fresh user
    // question that the model thought-burnt into silence is exactly the
    // case we need to recover from (observed via the public-API channel
    // for cgov, where a single-turn loop with 2302 thinking tokens stored
    // an empty `[]` assistant message and the embedded chat UI hung). We
    // escalate through `EMPTY_RETRY_PLAN`: first a pushy nudge at the
    // model's default thinking level, then again with `thinkingLevel:
    // 'low'` to force a text commit. Bounded by `EMPTY_RETRY_WALL_MS` of
    // total loop wall-clock so users on messaging channels don't wait
    // forever for a recovery that isn't coming.
    if (!hasToolUse && !hasText && emptyResponseRetries < EMPTY_RETRY_PLAN_LENGTH) {
      const elapsed = Date.now() - loopStartTime
      if (elapsed > EMPTY_RETRY_WALL_MS) {
        console.warn(
          `[query-loop] Empty response on turn ${turn} after ${elapsed}ms — wall-clock budget (${EMPTY_RETRY_WALL_MS}ms) exhausted; exiting without further retry.`,
        )
      } else {
        // Pick the plan based on whether prior turns gathered any tool
        // results. Pre-tool empties need to allow tools (the user often
        // explicitly asked for them); post-tool empties need to forbid
        // tools so the model finally commits to a text synthesis.
        const plan = loopDetector.totalToolCalls > 0
          ? EMPTY_RETRY_PLAN_AFTER_TOOLS
          : EMPTY_RETRY_PLAN_BEFORE_TOOLS
        const step = plan[emptyResponseRetries]
        emptyResponseRetries++
        console.warn(
          `[query-loop] Empty response on turn ${turn} (retry ${emptyResponseRetries}/${EMPTY_RETRY_PLAN_LENGTH}, plan=${loopDetector.totalToolCalls > 0 ? 'after-tools' : 'before-tools'}, thinkingLevel=${step.thinkingLevel ?? 'default'}).`,
        )
        nextThinkingLevel = step.thinkingLevel
        nextMessages = [{ role: 'user', content: step.nudge }]
        if (options.stateless) {
          statelessHistory.push({ role: 'assistant', content: response.content })
          statelessHistory.push(...nextMessages)
        }
        continue
      }
    }

    // Layer 5: max_tokens recovery — auto-continue once for web channel
    if (response.stopReason === 'max_tokens' && !hasToolUse
        && options.channelType === 'web' && maxTokensContinuations < 1) {
      maxTokensContinuations++
      nextMessages = [{ role: 'user', content: 'Continue from where you left off.' }]
      if (options.stateless) {
        statelessHistory.push({ role: 'assistant', content: response.content })
        statelessHistory.push(...nextMessages)
      }
      continue
    }

    // askQuestion is structurally terminal — when the model calls it, the
    // loop exits this turn so the user can actually respond. Without this,
    // the model could chain askQuestion + more tools (workers, ingestion,
    // etc.) in one turn and the user never gets a chance to interject:
    // observed 5/26 22:24 when the coordinator emitted 3× askQuestion
    // calls mid-research while continuing to spawn workers. Phase 4b is
    // also skipped here — any pending worker results are dropped because
    // the user's answer will fundamentally reshape what comes next;
    // running synthesis with stale gaps wastes compute. The question text
    // has already been surfaced + persisted by the question-injection
    // block above (Phase 3b prelude); this is just the loop exit.
    if (askQuestionCalledThisTurn) {
      // SUSPEND path (Phase 1 of mid-research askQuestion). When the caller
      // opts in (chat route) AND wires the persistence callback, the engine
      // hands the question off to `pending_approvals` and exits WITHOUT
      // `turn_complete`. The chat route's SSE handler closes cleanly,
      // the UI renders an inline answer input on the suspended turn, and
      // the Path B resume worker picks up the session when the user
      // submits via POST /answer. See
      // docs/architecture/engine/askquestion-suspend-resume.md.
      const canSuspend =
        options.questionResumeEnabled === true
        && typeof context.createPendingQuestion === 'function'
      if (canSuspend) {
        const askQuestionToolUse = response.content.find(
          (b): b is ContentBlock & { type: 'tool_use' } =>
            b.type === 'tool_use' && b.name === 'askQuestion',
        )
        const question = askQuestionToolUse
          ? (askQuestionToolUse.input as { question?: unknown }).question
          : undefined
        if (
          askQuestionToolUse
          && typeof question === 'string'
          && question.length > 0
        ) {
          // 24h TTL — see askquestion-suspend-resume.md → TTL.
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
          try {
            const approvalId = await context.createPendingQuestion!({
              question,
              toolUseId: askQuestionToolUse.id,
              expiresAt,
            })
            console.log(
              `[query-loop] askQuestion suspended on turn ${turn} — approvalId=${approvalId}, awaiting user answer.`,
            )
            // Surface to the channel UI for prompt rendering. The
            // confirmation-required event carries the same shape used by
            // tool_invocation approvals so the SSE consumer's existing
            // approval flow handles it.
            yield {
              type: 'tool_confirmation_required',
              request: {
                approvalId,
                toolCallId: askQuestionToolUse.id,
                toolName: 'askQuestion',
                serverName: 'builtin',
                input: { question },
                classification: null,
                description: question,
              },
            }
            // Durability marker — the SSE consumer uses this to checkpoint.
            yield {
              type: 'awaiting_approval',
              approvalId,
              toolCallId: askQuestionToolUse.id,
              toolName: 'askQuestion',
              toolInput: { question },
              describeText: question,
              expiresAt,
              loopStepIndex,
            }
            // Exit WITHOUT turn_complete — session is suspended.
            return
          } catch (err) {
            // If the persistence layer fails, fall through to the legacy
            // terminal path rather than dropping the user. Logged so the
            // failure is debuggable.
            console.warn(
              `[query-loop] askQuestion suspend failed (${err instanceof Error ? err.message : String(err)}) — falling back to terminal exit.`,
            )
          }
        }
      }

      // TERMINAL path — legacy behavior. Used when:
      //   - questionResumeEnabled is off (workers, scheduled jobs, smoke), OR
      //   - createPendingQuestion hook is absent, OR
      //   - the suspend persistence failed (logged above).
      console.log('[query-loop] askQuestion called — terminating turn so user can respond')
      yield { type: 'turn_complete', response, totalUsage }
      return
    }

    if (!hasToolUse || response.stopReason !== 'tool_use') {
      // ── Phase 4b: Worker notification drain ────────────────
      // If background workers are still running, wait for them and
      // inject their results as a user message for a synthesis turn.
      const wm = context.workerManager
      // Scope every worker check + drain to THIS turn's session. The manager
      // is a process-wide singleton shared across all users/channels; without
      // this scope a background worker spawned by another user, completing
      // during this turn, would be swept into this turn's synthesis prompt
      // (cross-tenant leak, incident 2026-06-02). See worker.ts → WorkerResult.ownerSessionId.
      const wmSid = context.sessionId
      if (wm) {
        console.log(`[query-loop] Phase 4b check: pendingCount=${wm.pendingCountFor(wmSid)}, hasNotifications=${wm.hasNotificationsFor(wmSid)}`)
      }
      if (wm && (wm.pendingCountFor(wmSid) > 0 || wm.hasNotificationsFor(wmSid))) {
        const accumulatedNotifications: import('../workers/worker.js').WorkerResult[] = []
        if (wm.pendingCountFor(wmSid) > 0) {
          yield { type: 'status', message: 'Waiting for background workers...' }
          // Wait for ALL workers with a 60s timeout to prevent hanging forever.
          //
          // Two memory defenses (5/27 OOM root cause):
          //
          // 1. DRAIN INSIDE THE LOOP. `waitForNext()` returns immediately
          //    when `notifications.length > 0`. If we don't drain, every
          //    iteration's race resolves instantly (notifications still
          //    present) and the loop spins, allocating two new Promises
          //    + a setTimeout closure per iteration. Production 5/27 OOM
          //    stack trace was exactly: PromiseRace → NewPromiseCapability
          //    → AsyncGeneratorAwaitResolveClosure inside this loop.
          //    Draining after each race resets `notifications.length` to
          //    0 so the next `waitForNext()` actually waits.
          //
          // 2. CLEAR THE TIMER. The polling setTimeout was never cleared
          //    after the race resolved. Each leaked timer pinned its
          //    Promise + closure for the full 5s. Cumulative leaked
          //    timers under a tight-loop scenario were the
          //    multi-GB allocation source.
          const workerDeadline = Date.now() + 60_000
          while (wm.pendingCountFor(wmSid) > 0 && Date.now() < workerDeadline) {
            let pollTimer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                wm.waitForNext(wmSid),
                new Promise<void>((resolve) => {
                  pollTimer = setTimeout(resolve, 5_000)
                }),
              ])
            } finally {
              if (pollTimer) clearTimeout(pollTimer)
            }
            // Drain accumulated notifications inside the loop so the next
            // waitForNext() doesn't return instantly on the same data.
            if (wm.hasNotificationsFor(wmSid)) {
              const partial = wm.drainNotifications(wmSid)
              accumulatedNotifications.push(...partial)
            }
          }
          if (wm.pendingCountFor(wmSid) > 0) {
            console.warn(`[query-loop] Phase 4b: timed out waiting for ${wm.pendingCountFor(wmSid)} worker(s)`)
          }
        }
        // Tail drain — anything that arrived between the last wait and now.
        const tail = wm.drainNotifications(wmSid)
        const workerResults = [...accumulatedNotifications, ...tail]
        accumulatedNotifications.length = 0
        console.log(`[query-loop] Phase 4b: drained ${workerResults.length} worker results`)
        if (workerResults.length > 0) {
          const notificationText = workerResults
            .map((n) => wm.formatNotification(n))
            .join('\n\n')
          // Un-suppress text for the synthesis turn — this is the final response
          suppressText = false
          const drainPrompt = options.workerDrainPrompt
            ? options.workerDrainPrompt(notificationText, workerResults)
            : defaultWorkerDrainPrompt(notificationText)
          nextMessages = [{
            role: 'user',
            content: drainPrompt,
          }]
          if (options.stateless) {
            statelessHistory.push({ role: 'assistant', content: response.content })
            statelessHistory.push(...nextMessages)
          }
          continue // new turn to synthesize worker results
        }
      }

      // ── Completeness gate (execution-plan tier) ────────────────
      // A tool-less message would normally end the turn. If the session has
      // an active plan with open steps and budget remains, keep working it
      // instead of stalling half-done; when budget is short, fire one
      // model-generated resumable handoff. Deterministic — one cheap read,
      // no LLM call. Workers take priority (handled above). See
      // docs/architecture/context-engine/execution-plan.md.
      if (options.planGate) {
        const planSt = await options.planGate
          .status(context.sessionId)
          .catch(() => null)
        if (planSt && planSt.open > 0) {
          const cap = options.planNudgeCap ?? 3
          const toolsLeft = loopDetector.totalToolCalls < maxToolCalls
          const list = planSt.openSteps
            .slice(0, 10)
            .map((s) => (s.description ? `${s.key} (${s.description})` : s.key))
            .join('; ')
          if (!planHandoffDone && planNudges < cap && turn + 2 < maxTurns && toolsLeft) {
            planNudges++
            suppressText = false
            nextMessages = [{
              role: 'user',
              content:
                `${planSt.open} plan step(s) still open: ${list}. Work the next one now ` +
                `(call updatePlanStep as you finish each), or mark it blocked with a reason ` +
                `if it truly cannot be done. Do not end your turn while steps are pending or in_progress.`,
            }]
            if (options.stateless) {
              statelessHistory.push({ role: 'assistant', content: response.content })
              statelessHistory.push(...nextMessages)
            }
            continue
          }
          if (!planHandoffDone && turn + 1 < maxTurns) {
            planHandoffDone = true
            suppressText = false
            nextMessages = [{
              role: 'user',
              content:
                `Budget for this task is nearly spent and ${planSt.open} step(s) remain (${list}). ` +
                `Stop working now and tell the user, in their language: what you finished, what is ` +
                `still open, and that they can reply "continue" to finish the rest. Keep it brief.`,
            }]
            if (options.stateless) {
              statelessHistory.push({ role: 'assistant', content: response.content })
              statelessHistory.push(...nextMessages)
            }
            continue
          }
        }
      }

      yield { type: 'turn_complete', response, totalUsage }
      return
    }

    // ── Phase 5: Build next turn ───────────────────────────────
    // Only send tool results for the next turn — the session maintains history.
    // If the loop detector flagged a nudge (same tool+input called 3+ times),
    // append a course-correction hint so the model tries a different approach
    // before hitting the block threshold at 5.
    const nudgeBlock: ContentBlock | null = toolExecutor.hadNudge
      ? { type: 'text', text: 'You have called the same tool multiple times with the same input. Try a different approach or different parameters.' }
      : null
    if (allToolResults.length > 0) {
      nextMessages = [{ role: 'user', content: nudgeBlock ? [...allToolResults, nudgeBlock] : allToolResults }]
    } else {
      nextMessages = nudgeBlock ? [{ role: 'user', content: [nudgeBlock] }] : []
    }

    // Stateless mode: accumulate full history for next provider.stream() call.
    // Preserve providerSignature on tool_use blocks — Gemini 3 family models
    // (3 Pro, 3.1 Pro, 3 Flash) REQUIRE thoughtSignature when re-sending a
    // prior functionCall part. Stripping it produces:
    //   "Function call is missing a thought_signature in functionCall parts"
    // 400 errors on the second turn, which broke every research worker that
    // chained webSearch → urlReader (production 5/27 trace). The earlier
    // "save memory" comment was a false economy — signatures are ~50-200
    // bytes per turn, three orders of magnitude smaller than the thought-
    // text bodies that the stateful Gemini session strips from rawHistory.
    if (options.stateless) {
      statelessHistory.push({ role: 'assistant', content: response.content })
      if (nextMessages.length > 0) {
        statelessHistory.push(...nextMessages)
      }
    }

    if (loopDetector.totalToolCalls >= maxToolCalls) {
      yield { type: 'status', message: 'Reached tool execution limit' }

      // If the last turn was only tool calls (all blocked), the user would
      // see nothing. Do one final no-tools LLM call so the model can
      // synthesize a text response from whatever it gathered.
      const hasText = response.content.some(
        (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text.trim().length > 0,
      )
      if (!hasText && allToolResults.length > 0 && session) {
        const fallbackResponse = yield* forceTextResponse(
          session, allToolResults, totalUsage,
        )
        if (fallbackResponse) {
          yield { type: 'assistant_turn', response: fallbackResponse, toolResults: [] }
          yield { type: 'turn_complete', response: fallbackResponse, totalUsage }
          return
        }
      }

      yield { type: 'turn_complete', response, totalUsage }
      return
    }
  }

  // Hit max turns — if the last turn was all tool_use with no text, do one
  // final no-tools call so the model synthesizes from what it gathered.
  {
    const hasText = lastResponse?.content.some(
      (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text.trim().length > 0,
    )
    if (!hasText && lastToolResults.length > 0 && session) {
      const fallbackResponse = yield* forceTextResponse(
        session, lastToolResults, totalUsage,
      )
      if (fallbackResponse) {
        yield { type: 'assistant_turn', response: fallbackResponse, toolResults: [] }
        yield { type: 'turn_complete', response: fallbackResponse, totalUsage }
        return
      }
    }
  }

  yield { type: 'status', message: 'Reached maximum conversation turns' }
  yield {
    type: 'turn_complete',
    response: { content: [], stopReason: 'max_tokens', usage: { inputTokens: 0, outputTokens: 0 }, model },
    totalUsage,
  }
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Detect transient stream errors worth retrying once. Covers:
 *  - Our own `wrapIdleTimeout` abort ("Stream idle for Nms") when the
 *    upstream provider goes silent for too long.
 *  - Common Node socket errors on a dropped connection (ECONNRESET,
 *    ETIMEDOUT, EPIPE, ENETUNREACH, ENOTFOUND, "socket hang up", "fetch
 *    failed").
 *  - Upstream gateway 5xx (502/503/504) — provider load-balancer hiccups.
 *
 * Returns false for `AbortError` so a user-cancelled request isn't
 * silently retried under the user's nose.
 */
function isTransientStreamError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /Stream idle for \d+ms/i.test(msg)
    || /\b(ECONNRESET|ETIMEDOUT|EPIPE|ENETUNREACH|ENOTFOUND)\b/.test(msg)
    || /(socket hang up|fetch failed|network (?:error|request failed))/i.test(msg)
    || /\b(502|503|504)\b/.test(msg)
  )
}

/**
 * Last-resort reply, used ONLY when the dedicated `explainFailure` escalation
 * call itself throws or still yields nothing usable. It is intentionally
 * generic; the preferred terminal message is the model's own contextual
 * explanation (see {@link explainFailure}). Exported for tests asserting the
 * last-resort path.
 */
export const FALLBACK_REPLY =
  "Sorry — I couldn't complete that. I hit the tool-call limit before finishing. " +
  'Could you try again with a more specific request?'

/**
 * Escalation nudge for {@link explainFailure}. Deliberately phrased as a plain
 * request for a user-facing status line (no meta-instruction to paraphrase),
 * so a faithful response does NOT trip {@link looksLikeInstructionLeak}. The
 * point is honoured per the 2026-06-01 directive: a run that hits a terminal
 * limit must never fail silently with a canned line — it must say what
 * happened, in the user's own context (which matters most for autonomous
 * scheduled / workflow runs, where "try again with a more specific request"
 * is nonsensical and reads as a failed reply to the user's last message).
 */
const FAILURE_EXPLANATION_NUDGE =
  'The task could not be completed — you ran out of tool-call budget or a step failed before you finished. ' +
  'Write a short, honest message to me in plain second person: what you managed to find from the work above, ' +
  'and the specific thing that stopped you from finishing (for example, a connector or service that did not respond). ' +
  'Do not restate this instruction, do not output a generic apology, and do not promise to retry automatically. Two or three sentences.'

/**
 * Structural + substring leak detector. The structural check catches
 * the failure mode where the model paraphrases instructional voice
 * ("No X.", "Do not Y.", "Just Z.") instead of producing recap
 * content (which starts with subject+verb: "I tried…", "The search…").
 * The substring layer catches known phrases from L1 / addendum / this
 * file's own nudge as a belt-and-suspenders pass.
 *
 * Tuned for the first ~120 chars of the reply — by then the model has
 * committed to a tone. Real recaps don't open with imperative voice.
 *
 * Also catches the "plan-tail" failure mode where the model produces a
 * short third-person meta-narration about the user instead of replying
 * to them ("Then, answer the user's question.", "Now I'll respond to
 * the user.", "Reply to the user with the findings."). Surfaced
 * 2026-05-27 on Anson / GRI (session 19e48b38), where Flash 3.5 produced
 * exactly " Then, answer the user's question." as the whole final turn
 * after the loop-detector blocked duplicate tool calls. Real replies
 * are addressed TO the user (second person) — anything that talks ABOUT
 * "the user" in third person is the model thinking out loud.
 */
export function looksLikeInstructionLeak(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  const SUBSTRINGS = [
    'sycophancy',
    'pre-announc',
    'do not mention',
    'no further tool calls',
    'tool blocking',
    'tool budget',
    'natural reply',
    'system prompt',
  ]
  if (SUBSTRINGS.some((p) => lower.includes(p))) return true
  // First-sentence structural check: imperatives + meta-talk openers.
  // Real summaries don't start with "No X." / "Don't Y." / "Just Z."
  const firstSentence = text.trim().slice(0, 120).split(/[.!?\n]/)[0]?.trim() ?? ''
  if (/^(no\b|do not\b|don't\b|never\b|just a\b|always\b|reply with\b|tell them\b|produce a\b|write a\b)/i.test(firstSentence)) {
    return true
  }
  // Plan-tail meta-narration: short text that talks ABOUT the user in
  // third person ("answer the user", "reply to the user", "respond to
  // the user", "the user's question", etc.) instead of TO them. Bounded
  // by length so a genuinely long reply that happens to mention "the
  // user" in passing isn't sanitised away.
  const trimmed = text.trim()
  if (trimmed.length <= 200 && /\b(answer|reply to|respond to|address|get back to)\s+the\s+user\b|\bthe\s+user'?s\s+(question|request|message)\b/i.test(trimmed)) {
    return true
  }
  return false
}

/**
 * Leading scaffold-primer a reasoning model sometimes emits before its real
 * answer — e.g. `Your reply to the user MUST start here:\n<reply>`. The marker
 * is NOT from any sidanclaw prompt (it is absent from the tree); the model
 * narrates its own output structure, typically right after a control-signal
 * tool_result (tool-budget exhaustion, loop block). {@link looksLikeInstructionLeak}
 * misses it because the marker PLUS a complete reply runs past that detector's
 * ≤200-char plan-tail gate — the 2026-06-02 leak (session b0903ea6) measured
 * 209 chars and reached the user verbatim.
 *
 * We strip just the primer line and KEEP the real reply that follows, rather
 * than suppressing the whole turn and retrying — there is no tool budget left
 * to retry after a cap, and the reply after the marker is genuine. The pattern
 * only matches a leading `reply|response|answer|message` line that ALSO carries
 * a scaffold verb (`must|should|start|begin|go|here`) and ends in `:` + newline,
 * so a genuine reply opening "Reply to your question:\n…" is left intact.
 */
const INSTRUCTION_LEAK_PREFIX =
  /^\s*(your |the )?(final |user[- ]facing )?(reply|response|answer|message)\b[^\n:]*\b(here|must|should|begins?|goes?|starts?)\b[^\n:]*:[ \t]*\n+/i

export function stripInstructionLeakPrefix(text: string): string {
  return text.replace(INSTRUCTION_LEAK_PREFIX, '')
}

/**
 * Force the model to produce a text response after the tool budget
 * was exhausted. Streams text only (any further tool_use chunks are
 * dropped). Returns the response or null on error.
 *
 * Defense layers, in order of preference:
 *
 *   1. **Natural-question nudge.** Phrased as a casual user check-in
 *      ("Quick recap — what did you find?") so the model has no
 *      instruction to paraphrase. Earlier versions used a verbose
 *      meta-instruction ("Produce a natural reply, do not mention
 *      this…") which the model literally repeated back to the user
 *      — the exact failure this layer prevents.
 *   2. **Early-window leak detection.** First ~120 chars (or the
 *      first sentence boundary) are buffered before any text is
 *      streamed to the client. If the early window matches the leak
 *      detector, the whole reply is replaced with the canned
 *      fallback. Once cleared, the rest streams live — no all-or-
 *      nothing buffering of the entire response.
 *   3. **Persisted-message sanitization.** When a leak is caught,
 *      the AssistantResponse's text block is rewritten in place so
 *      downstream session persistence stores the fallback, not the
 *      leak. The user never sees the leak in chat history either.
 */
async function* forceTextResponse(
  session: ProviderSession,
  toolResults: ContentBlock[],
  totalUsage: TokenUsage,
): AsyncGenerator<QueryEvent, AssistantResponse | null> {
  const nudge: ContentBlock = {
    type: 'text',
    text: 'Quick recap — what did the calls above turn up, and what (if anything) blocked you from finishing? One or two sentences is enough.',
  }
  const messages: Message[] = [
    { role: 'user', content: [...toolResults, nudge] },
  ]

  // Fold one finished response's usage into the shared totalUsage.
  const accumulateUsage = (u: TokenUsage): void => {
    totalUsage.inputTokens += u.inputTokens
    totalUsage.outputTokens += u.outputTokens
    totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0)
    totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  }

  try {
    const acc = createAccumulator()
    let earlyBuffer = ''
    let phase: 'buffering' | 'streaming' | 'suppressed' = 'buffering'
    let leakedExcerpt = ''
    const EARLY_WINDOW = 120
    for await (const chunk of session.send(messages)) {
      acc.push(chunk)
      if (chunk.type !== 'text_delta') continue
      if (phase === 'streaming') {
        yield { type: 'text_delta', text: chunk.text }
        continue
      }
      if (phase === 'suppressed') {
        // Drain remaining text into the accumulator for accurate token
        // usage, but emit nothing — the leaked recap is discarded and the
        // escalation call below produces the real message.
        continue
      }
      // phase === 'buffering' — gather signal then decide once.
      earlyBuffer += chunk.text
      const atBoundary = /[.!?\n]/.test(earlyBuffer)
      if (earlyBuffer.length >= EARLY_WINDOW || atBoundary) {
        if (looksLikeInstructionLeak(earlyBuffer)) {
          // Stream NOTHING — don't flash the canned line. We escalate to a
          // dedicated explanation call after draining this leaked recap.
          phase = 'suppressed'
          leakedExcerpt = earlyBuffer
        } else {
          phase = 'streaming'
          yield { type: 'text_delta', text: earlyBuffer }
        }
      }
    }
    // Stream ended before we cleared the early window — short reply.
    if (phase === 'buffering' && earlyBuffer.length > 0) {
      if (looksLikeInstructionLeak(earlyBuffer)) {
        phase = 'suppressed'
        leakedExcerpt = earlyBuffer
      } else {
        yield { type: 'text_delta', text: earlyBuffer }
      }
    }

    // Recap leaked instructions → don't ship it (and don't ship the canned
    // line). Spend one more call whose only job is to say what happened.
    if (phase === 'suppressed') {
      accumulateUsage(acc.finish().usage)
      console.warn(
        `[query-loop] forceTextResponse: recap leaked instructions, escalating to explanation. Excerpt: ${leakedExcerpt.slice(0, 200)}`,
      )
      return yield* explainFailure(session, totalUsage)
    }

    const resp = acc.finish()
    accumulateUsage(resp.usage)

    // Anti-empty guarantee. When the recap returns no text (typically because
    // the model tried to chain more tool_use, which we drop) we don't ship an
    // empty turn or a canned line — we escalate to a dedicated "explain what
    // happened" call so the user gets a real, contextual message about what
    // was gathered and what blocked completion.
    const respHasText = resp.content.some(
      (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text.trim().length > 0,
    )
    if (!respHasText) {
      console.warn(
        '[query-loop] forceTextResponse: recap produced no text; escalating to explanation.',
      )
      return yield* explainFailure(session, totalUsage)
    }
    return resp
  } catch (err) {
    // Even on session.send() throw, give the user something real: try the
    // explanation call (a fresh send). If that also throws, it falls through
    // to the canned last-resort reply inside explainFailure.
    console.error('[query-loop] forceTextResponse threw — escalating to explanation:', err)
    return yield* explainFailure(session, totalUsage)
  }
}

/**
 * Terminal escalation: tell the user what happened.
 *
 * Reached when {@link forceTextResponse}'s recap call produced no usable text
 * — it either tripped the instruction-leak suppressor or came back empty.
 * Rather than ship the canned {@link FALLBACK_REPLY} (which reads as "you try
 * again with a more specific request" — nonsensical for an autonomous
 * scheduled / workflow run, and indistinguishable from a failed reply to the
 * user's *last* message), spend ONE more no-tools call whose only job is to
 * state, in the user's own context, what was accomplished and what blocked
 * completion.
 *
 * The session is stateful, so the prior tool results and the discarded recap
 * attempt are already in context; this call adds only an explicit, leak-
 * resistant nudge ({@link FAILURE_EXPLANATION_NUDGE}) and forces a low-thinking
 * commit. The canned reply survives strictly as a last resort — only if this
 * call throws or still yields nothing usable (empty, or another leak).
 *
 * See docs/architecture/engine/query-loop.md → "Forced text fallback".
 */
async function* explainFailure(
  session: ProviderSession,
  totalUsage: TokenUsage,
): AsyncGenerator<QueryEvent, AssistantResponse> {
  try {
    const acc = createAccumulator()
    let buffer = ''
    for await (const chunk of session.send(
      [{ role: 'user', content: [{ type: 'text', text: FAILURE_EXPLANATION_NUDGE }] }],
      { thinkingLevel: 'low' },
    )) {
      acc.push(chunk)
      if (chunk.type === 'text_delta') buffer += chunk.text
    }
    const resp = acc.finish()
    totalUsage.inputTokens += resp.usage.inputTokens
    totalUsage.outputTokens += resp.usage.outputTokens
    totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + (resp.usage.cacheReadTokens ?? 0)
    totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + (resp.usage.cacheWriteTokens ?? 0)

    const text = buffer.trim()
    if (text.length > 0 && !looksLikeInstructionLeak(text)) {
      yield { type: 'text_delta', text }
      return { ...resp, content: [{ type: 'text', text }], stopReason: 'end_turn' }
    }
    console.warn(
      '[query-loop] explainFailure: no usable explanation text; using canned last-resort reply.',
    )
  } catch (err) {
    console.error('[query-loop] explainFailure threw; using canned last-resort reply:', err)
  }

  // True last resort — the explanation call could not produce a clean message.
  yield { type: 'text_delta', text: FALLBACK_REPLY }
  return {
    content: [{ type: 'text', text: FALLBACK_REPLY }],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'fallback',
  }
}

/**
 * Extract citation sources from `webSearch` tool results. The tool returns
 * `{ query, results: [{ title, url, snippet }] }` serialized as JSON in the
 * tool_result content; parse it back and pull the URLs/titles so consumers
 * can render them as footnotes.
 *
 * Silently returns [] on any parse failure or non-webSearch result — the
 * goal is surfacing citations when available, not validating tool output.
 */
function extractCitationsFromToolResults(
  results: ContentBlock[],
): Array<{ url: string; title: string }> {
  const sources: Array<{ url: string; title: string }> = []
  for (const block of results) {
    if (block.type !== 'tool_result' || block.name !== 'webSearch' || block.isError) continue
    if (typeof block.content !== 'string') continue
    try {
      const parsed = JSON.parse(block.content) as {
        results?: Array<{ title?: string; url?: string }>
      }
      for (const r of parsed.results ?? []) {
        if (r.url && r.title) sources.push({ url: r.url, title: r.title })
      }
    } catch {
      // Non-JSON content (e.g. "No results found.") — nothing to cite.
    }
  }
  return sources
}

/**
 * Convert a Zod schema to the JSON-Schema shape Gemini's tool definitions
 * (and `mcp_search` result formatter) expect. Exported because the tool-search
 * index needs the same shape for local-source tools — see
 * `packages/core/src/mcp/tool-search.ts` → "Local source schema derivation".
 */
export function jsonSchemaFromZod(schema: { _def: unknown }): {
  type: 'object'
  properties: Record<string, ToolParameter>
  required?: string[]
} {
  type TP = ToolParameter
  const def = schema._def as Record<string, unknown>

  if (def.typeName === 'ZodObject') {
    const shape = (def as { shape: () => Record<string, { _def: Record<string, unknown> }> }).shape()
    const properties: Record<string, TP> = {}
    const required: string[] = []

    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodFieldToJsonSchema(fieldSchema) as TP
      if (fieldSchema._def.typeName !== 'ZodOptional') {
        required.push(key)
      }
    }

    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
  }

  return { type: 'object', properties: {} as Record<string, TP> }
}

function zodFieldToJsonSchema(field: { _def: Record<string, unknown> }): Record<string, unknown> {
  const def = field._def
  const typeName = def.typeName as string

  switch (typeName) {
    case 'ZodString':
      return { type: 'string', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodNumber':
      return { type: 'number', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodBoolean':
      return { type: 'boolean', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodOptional': {
      const inner = zodFieldToJsonSchema({ _def: (def.innerType as { _def: Record<string, unknown> })._def })
      // Preserve description from the optional wrapper if the inner type doesn't have one
      if (def.description && !inner.description) {
        inner.description = def.description as string
      }
      return inner
    }
    case 'ZodEffects': {
      // z.preprocess / z.transform — expose the inner schema's shape to the
      // model. Otherwise Gemini would see `type: 'string'` (the default
      // fallback) and be encouraged to send the very stringified payload
      // the preprocess exists to recover from.
      const inner = zodFieldToJsonSchema({ _def: (def.schema as { _def: Record<string, unknown> })._def })
      if (def.description && !inner.description) {
        inner.description = def.description as string
      }
      return inner
    }
    case 'ZodRecord':
      // z.record(...) — an open-shape object. Gemini's tool schema doesn't
      // need `additionalProperties` to allow extra keys, so a bare object
      // type is enough. Without this branch the default fallback would
      // advertise `type: 'string'` and *encourage* the model to stringify
      // its payload (the original `mcp_call` `args` bug).
      return { type: 'object', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[], ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodArray':
      return { type: 'array', items: zodFieldToJsonSchema({ _def: (def.type as { _def: Record<string, unknown> })._def }) }
    case 'ZodLiteral':
      return { type: 'string', enum: [String(def.value)] }
    case 'ZodObject':
      return jsonSchemaFromZod(field)
    case 'ZodDiscriminatedUnion': {
      // Gemini doesn't support oneOf/anyOf — flatten all variants into one object.
      // The discriminator key gets an enum of all valid values, and a description
      // explains which fields go with which variant.
      const discriminator = def.discriminator as string
      const options = def.options as Array<{ _def: Record<string, unknown> }>
      const mergedProps: Record<string, Record<string, unknown>> = {}
      const variantDescriptions: string[] = []

      for (const option of options) {
        const converted = jsonSchemaFromZod(option)
        for (const [key, prop] of Object.entries(converted.properties)) {
          if (!mergedProps[key]) mergedProps[key] = prop as Record<string, unknown>
        }
        // Build a human-readable variant description
        const variantKeys = Object.keys(converted.properties).filter((k) => k !== discriminator)
        const discValue = (converted.properties[discriminator] as Record<string, unknown>)?.enum
        if (discValue && Array.isArray(discValue) && discValue[0]) {
          variantDescriptions.push(`${discriminator}="${discValue[0]}": requires ${variantKeys.join(', ') || 'no extra fields'}`)
        }
      }

      // Discriminator field becomes an enum of all variant values
      const allDiscValues = options.map((opt) => {
        const shape = (opt._def as Record<string, unknown>).shape as undefined | (() => Record<string, { _def: Record<string, unknown> }>)
        if (!shape) return undefined
        const discField = shape()[discriminator]
        return discField?._def?.value as string | undefined
      }).filter(Boolean) as string[]

      if (allDiscValues.length > 0) {
        mergedProps[discriminator] = { type: 'string', enum: allDiscValues }
      }

      const desc = def.description as string | undefined
      const variantHint = variantDescriptions.length > 0
        ? `Variants: ${variantDescriptions.join('. ')}.`
        : undefined

      return {
        type: 'object',
        properties: mergedProps,
        required: [discriminator],
        ...(desc || variantHint ? { description: desc ?? variantHint } : {}),
      }
    }
    default:
      return { type: 'string' }
  }
}
