import type { Tool, ToolContext, ToolResult, ToolResultMeta } from '../tools/types.js'
import type { ContentBlock } from '../providers/types.js'
import type { LoopDetector, LoopAction } from './loop-detector.js'
import { FAIL_STREAK_LIMIT } from './loop-detector.js'
import type { AwaitingApprovalEvent, ConfirmationResolver, ToolConfirmationRequest } from '../mcp/types.js'
import type { PermissionGrantEvaluator } from '../workflow/permission-grants.js'
import { alreadyDeclinedToolResult, declinedToolResult, timedOutToolResult } from './decline-copy.js'
import { canRead, isSensitivity } from '../security/sensitivity.js'
import { subsetCompartments } from '../security/compartments.js'
import { capToolResultTokens } from '../providers/context-budget.js'

// ── Constants ──────────────────────────────────────────────────

/**
 * Every tool_result is capped to a global token budget after the per-tool
 * `maxResultSizeChars` char cap, protecting the model's context window from
 * any tool whose payload would otherwise blow past the provider's input-token
 * limit. The cap is `capToolResultTokens` — the single canonical write-time
 * enforcement point, applied here at BOTH finalization sites (the success path
 * capping `result.data`, and the catch path capping a thrown error message).
 * It lives in `providers/context-budget.ts` (with `MAX_TOOL_RESULT_TOKENS` +
 * `TOOL_RESULT_TRUNCATION_MARKER`) so the read-time twin (`fitMessagesToBudget`,
 * applied at the provider seam) clamps the same size on history assembled
 * before this cap shipped. CJK-safe via the compaction-shared
 * `estimateStringTokens` (1 char/token for CJK, ~4 chars/token otherwise).
 *
 * Provenance: 2026-05-28 Gemini 400 "input token count exceeds 1048576" —
 * `listScheduledJobs` returned 4,839 rows in a single tool_result. 2026-06-01
 * "AI Trading" doc session — a `patchPage` `ZodError` (`invalid_union`,
 * which recursively expands every branch) thrown from `execute()` dumped a
 * ~245k-char / ~60k-token error through the *uncapped* catch path; the fix
 * caps that path too and compacts ZodErrors via `formatToolError`. See
 * `docs/architecture/engine/tool-executor.md` §"Global token budget" and
 * `docs/architecture/engine/provider-abstraction.md` §"Context-budget wrapper".
 */

// ── Types ──────────────────────────────────────────────────────

type ToolStatus = 'queued' | 'pending_confirmation' | 'awaiting_slot' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  result?: ContentBlock
  /**
   * Inline images the tool produced (ToolResult.images) as `image` content
   * blocks, emitted right after `result` so they join the tool-results user
   * turn and a multimodal provider can see them.
   */
  resultImages?: ContentBlock[]
  /** Internal-only meta from the tool's ToolResult.meta. Surfaced via getCompletedResults. */
  meta?: ToolResultMeta
  error?: string
}

/** Completed results from one drain, paired with per-toolUseId meta. */
export type CompletedResults = {
  blocks: ContentBlock[]
  metaByToolUseId: Record<string, ToolResultMeta>
}

export type ToolExecutorOptions = {
  tools: Map<string, Tool>
  context: ToolContext
  loopDetector: LoopDetector
  onToolStart?: (id: string, name: string) => void
  onToolEnd?: (id: string, name: string, result: ToolResult) => void
  /** Resolver for tools that require user confirmation before execution. */
  confirmationResolver?: ConfirmationResolver
  /** Timeout for confirmation prompts (default 5 min). */
  confirmationTimeoutMs?: number
  /** Called when a tool enters pending_confirmation — the query loop yields this as an event. */
  onConfirmationRequired?: (request: ToolConfirmationRequest) => void
  /**
   * WU-6.3 — called when a suspended tool call persisted a
   * `pending_approvals` row (i.e. `context.createToolInvocationApproval`
   * was wired AND the insert succeeded). The query loop yields this as a
   * distinct `awaiting_approval` durability event so the route can
   * checkpoint the suspension into `session_resume_points`. Never fires
   * in Path A (in-memory-only) contexts.
   */
  onAwaitingApproval?: (event: AwaitingApprovalEvent) => void
  /** Tools denied or timed-out — shared across turns within one queryLoop call so the
   *  block persists for the user's message but resets on the next message. */
  deniedTools?: Set<string>
  /** WU-6.5 — workflow-scoped permission grants. No-op when undefined. */
  permissionGrantEvaluator?: PermissionGrantEvaluator
}

// ── Error formatting ───────────────────────────────────────────

/**
 * Render a thrown tool error as a compact, model-actionable string.
 *
 * `ZodError`s are the pathological case: `ZodError.message` is
 * `JSON.stringify(issues, null, 2)`, and an `invalid_union` issue recursively
 * carries every branch's errors under `unionErrors` — one such error (a
 * `patchPage` op-union failure) serialized to ~245k chars / ~60k tokens and,
 * via the previously-uncapped catch path, was re-sent on every loop iteration
 * of the turn (2026-06-01 "AI Trading"). The top-level `.issues` array is
 * flat, so collapse it to `path: message` lines — the project convention
 * (see `workflow/tools.ts`, `skills/manage-tool.ts`, `views/tools.ts`). This
 * is the single chokepoint for both `inputSchema.parse` failures and
 * ZodErrors thrown from inside a tool's own `execute()`.
 *
 * Duck-typed on `.issues` rather than `instanceof ZodError` so a tool that
 * bundles its own zod copy (a different class identity) still matches.
 */
export function formatToolError(err: unknown): string {
  if (err && typeof err === 'object' && Array.isArray((err as { issues?: unknown }).issues)) {
    const issues = (err as { issues: Array<{ path?: unknown[]; message?: string }> }).issues
    const lines = issues
      .slice(0, 20)
      .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
    const more = issues.length > 20 ? `\n…and ${issues.length - 20} more issue(s)` : ''
    return `Validation failed:\n${lines.join('\n')}${more}`
  }
  return err instanceof Error ? err.message : String(err)
}

// ── Streaming Tool Executor ────────────────────────────────────

export function createToolExecutor(options: ToolExecutorOptions) {
  const tracked: TrackedTool[] = []
  const deniedTools = options.deniedTools ?? new Set<string>()
  let siblingAbort = new AbortController()
  let hasErrored = false
  let nudgeDetected = false
  // Multi-waiter wake — every state change releases every waiter so each
  // can re-check its own condition. Single-slot waker (the prior
  // implementation) was inadequate once execution-slot waits started
  // running in parallel with the streaming-loop's waitForChange — only one
  // could resume per wake() call and the others stayed pinned. See the
  // multi-tool serial-confirmation note on `canExecute` below.
  let wakers: Array<() => void> = []

  function wake() {
    if (wakers.length === 0) return
    const toWake = wakers
    wakers = []
    for (const w of toWake) w()
  }

  function waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      wakers.push(resolve)
    })
  }

  // Concurrency gate for actually RUNNING a tool. `pending_confirmation`
  // and `awaiting_slot` deliberately don't count — the user can be
  // shown all pending prompts in parallel, but execution still
  // serializes per the isConcurrencySafe contract. Pre-2026-05-27 this
  // also blocked on `pending_confirmation`, which meant when the model
  // emitted two write-tool calls in one turn (e.g. two
  // googleCalendarCreateEvent), the second prompt couldn't even appear
  // until the first one finished executing — a 5-min hang in
  // production whenever the first tool's API call was slow and the
  // tool's timeoutMs didn't actually abort the fetch (Calendar client
  // doesn't honor the signal). Now both prompts appear, the user taps
  // each Allow, and the second tool waits at the post-confirmation
  // slot gate inside executeTool until the first finishes.
  function canExecute(isConcurrencySafe: boolean): boolean {
    const active = tracked.filter((t) => t.status === 'executing')
    if (active.length === 0) return true
    return isConcurrencySafe && active.every((t) => t.isConcurrencySafe)
  }

  async function executeTool(t: TrackedTool) {
    const toolDef = options.tools.get(t.name)
    if (!toolDef) {
      t.result = { type: 'tool_result', toolUseId: t.id, name: t.name, content: `Unknown tool: ${t.name}`, isError: true }
      t.status = 'completed'
      wake()
      return
    }

    // Capability gate — belt-and-braces with filterToolsByCapabilities.
    // A hallucinated call for a requiresCapability tool from an assistant
    // that lacks the grant lands here and is rejected before execute() runs.
    const needed = toolDef.requiresCapability
    if (needed && !options.context.activeCapabilities?.has(needed)) {
      t.result = {
        type: 'tool_result',
        toolUseId: t.id,
        name: t.name,
        content: `ERROR: "${t.name}" requires the '${needed}' capability, which is not granted to this assistant.`,
        isError: true,
      }
      t.status = 'completed'
      wake()
      return
    }

    // Loop detection. Differentiate the two block reasons — the model gets
    // a different next-action depending on whether this exact call was
    // hammered (block) or the per-turn tool budget is exhausted (hard_stop).
    // The earlier unified message ("repeated calls with identical input
    // exceeded the per-turn limit") read like an instruction to STOP and
    // produced meta-narration leaks like " Then, answer the user's
    // question." as the final text (Anson / GRI session 19e48b38,
    // 2026-05-27 10:40 — model emitted that single sentence as the whole
    // turn after seeing 2 of these errors back). Action-oriented copy
    // tells the model concretely what to do instead.
    const action: LoopAction = options.loopDetector.check(t.name, t.input, {
      repeatTolerant: toolDef.allowsRepeatCalls === true,
    })
    if (action === 'block') {
      t.result = {
        type: 'tool_result',
        toolUseId: t.id,
        name: t.name,
        content:
          `ERROR: "${t.name}" was called 5+ times with these exact arguments in this turn. ` +
          'Do NOT retry with the same input. Either change the input meaningfully, ' +
          'switch to a different tool, or write a direct reply to the user using what you already have.',
        isError: true,
      }
      t.status = 'completed'
      wake()
      return
    }
    if (action === 'hard_stop') {
      // Two ways the turn can be force-stopped: the absolute tool-call budget,
      // or a single tool failing FAIL_STREAK_LIMIT× in a row (the fuse). Quote
      // the culprit in the latter so the model's forced reply is specific.
      // The budget branch also pins the forced reply to gathered evidence:
      // without that clause, a research-shaped consult stopped mid-gather
      // filled its prompt's required output fields from parametric memory
      // (the 2026-07-13 fls.com.hk HKTVmall prospect runs fabricated emails,
      // IG handles, and LinkedIn URLs that a later step persisted as records).
      const failedTool = options.loopDetector.failureStopTool()
      const content = failedTool
        ? `ERROR: "${failedTool}" failed ${FAIL_STREAK_LIMIT} times in a row this turn, so no further tools will run. ` +
          `Stop retrying. Write a direct reply to the user now: summarize what you did accomplish, and state plainly what "${failedTool}" could not complete and why (quote its last error).`
        : 'ERROR: the tool-call budget for this turn is exhausted. ' +
          'No further tools will run this turn. Write a direct reply to the user now using what the prior tool results already gathered. ' +
          'State only what those results support: anything requested that you could not verify before the budget ran out, name it plainly as not verified. ' +
          'Never fill a gap with specific names, URLs, handles, emails, or numbers from memory.'
      t.result = {
        type: 'tool_result',
        toolUseId: t.id,
        name: t.name,
        content,
        isError: true,
      }
      t.status = 'completed'
      wake()
      return
    }

    if (action === 'nudge') {
      nudgeDetected = true
    }

    // ── Confirmation gate ───────────────────────────────────────
    // Tools with requiresConfirmation (or resolveConfirmation) pause
    // here and wait for the user's decision via the ConfirmationResolver.
    // If no resolver is provided, skip confirmation (backward compat).
    // Tools denied or timed-out earlier in this session are rejected
    // immediately — no repeated confirmation prompts.
    if (deniedTools.has(t.name)) {
      t.result = {
        type: 'tool_result',
        toolUseId: t.id,
        name: t.name,
        content: alreadyDeclinedToolResult(t.name),
        isError: true,
      }
      t.status = 'completed'
      wake()
      return
    }

    let needsConfirmation = toolDef.resolveConfirmation
      ? await toolDef.resolveConfirmation(options.context, t.input)
      : toolDef.requiresConfirmation

    // ── WU-6.5 INTEGRATION POINT — workflow-scoped permission grants ──
    // If the caller is driving an active workflow run whose definition
    // grants this action, short-circuit before the confirmation flow
    // that would otherwise create a pending_approvals row downstream.
    // Spec: docs/plans/company-brain/approvals.md → "Workflow-scoped permission grants".
    // Module: ../workflow/permission-grants.ts.
    if (needsConfirmation && options.permissionGrantEvaluator) {
      const decision = await options.permissionGrantEvaluator(t.name, options.context)
      if (decision.kind === 'allow') {
        needsConfirmation = false
      } else if (decision.kind === 'block') {
        deniedTools.add(t.name)
        t.result = {
          type: 'tool_result',
          toolUseId: t.id,
          name: t.name,
          content: `ERROR: "${t.name}" is blocked by an active workflow permission grant. The tool was NOT executed.`,
          isError: true,
        }
        t.status = 'completed'
        wake()
        return
      }
      // 'ask' or 'no_grant' → fall through to existing logic.
    }
    // ── END WU-6.5 INTEGRATION POINT ──

    if (needsConfirmation && !options.confirmationResolver) {
      // 'ask' tool on an autonomous path with no live confirmation
      // channel (scheduled jobs → workflow executor, workflow steps,
      // inter-assistant callees). Two sub-cases, both fail-closed (the
      // tool NEVER executes here — that's the Posture A invariant,
      // docs/architecture/engine/tool-executor.md §4):
      //
      //   (a) The dispatcher wired `createToolInvocationApproval`
      //       (WU-6.3 port). Park the call: persist a
      //       `pending_approvals kind='tool_invocation'` row the owner
      //       resolves out-of-band, and return an honest "parked for
      //       approval" result (isError so the model REPORTS it, never
      //       narrates success). The workflow/A2A run's Approvals queue
      //       surfaces the row — same lane a `tool_call` step already uses.
      //
      //   (b) No port either (smoke tests, bare worker contexts). Reject
      //       exactly as before — never silently bypass confirmation.
      if (options.context.createToolInvocationApproval) {
        // Enrich the parked row with the same human-readable lines the
        // interactive card shows (e.g. dedupeEntities' merge preview).
        let displayLines: string[] | undefined
        if (toolDef.describeConfirmation) {
          try {
            const lines = await toolDef.describeConfirmation(t.input, options.context)
            if (lines && lines.length > 0) displayLines = lines
          } catch (err) {
            console.debug(`[tool-executor] describeConfirmation failed for ${t.name}:`, err)
          }
        }
        const expiresAt = new Date(Date.now() + (options.confirmationTimeoutMs ?? 300_000))
        let approvalId: string | undefined
        try {
          approvalId = await options.context.createToolInvocationApproval({
            toolName: t.name,
            toolInput: t.input,
            description: toolDef.description,
            displayLines,
            allowPersistentApproval: toolDef.allowPersistentApproval ?? false,
            expiresAt,
          })
        } catch (err) {
          // Fail-CLOSED: a DB blip on the autonomous path must not run the
          // write. Fall through to the hard rejection below — unlike the
          // interactive path (which fails OPEN to the in-memory resolver),
          // there is no human here to catch a silent execution.
          console.warn(
            `[tool-executor] autonomous approval row creation failed for ${t.name}; rejecting fail-closed:`,
            err,
          )
        }

        if (approvalId) {
          // Durability checkpoint — same event the interactive branch
          // fires, so a Cloud Run restart mid-approval replays correctly.
          if (options.onAwaitingApproval) {
            options.onAwaitingApproval({
              approvalId,
              toolCallId: t.id,
              toolName: t.name,
              toolInput: t.input,
              describeText:
                displayLines && displayLines.length > 0
                  ? displayLines.join('\n')
                  : toolDef.description,
              expiresAt,
            })
          }
          const preview =
            displayLines && displayLines.length > 0 ? `\n${displayLines.join('\n')}` : ''
          t.result = {
            type: 'tool_result',
            toolUseId: t.id,
            name: t.name,
            content:
              `PARKED FOR APPROVAL: "${t.name}" makes a change that needs a human's OK, and this is an ` +
              `automated run with nobody to confirm in-line. It was NOT executed — it is waiting in the ` +
              `workspace Approvals queue (approval id ${approvalId}) for the owner to approve or reject. ` +
              `Do NOT retry it or claim it is done; tell the user it is pending their approval.${preview}`,
            isError: true,
          }
          t.status = 'completed'
          wake()
          return
        }
        // approvalId undefined → port threw → fall through to reject.
      }

      t.result = {
        type: 'tool_result',
        toolUseId: t.id,
        name: t.name,
        content: `ERROR: "${t.name}" requires user confirmation but no confirmation channel is available. The tool was NOT executed.`,
        isError: true,
      }
      t.status = 'completed'
      wake()
      return
    }

    if (needsConfirmation && options.confirmationResolver) {
      t.status = 'pending_confirmation'

      // Let the tool enrich the prompt with human-readable lines (e.g.
      // `deleteMemory` resolves ids → summaries). Failure here must not
      // block the confirmation — fall back to the generic renderer.
      let displayLines: string[] | undefined
      if (toolDef.describeConfirmation) {
        try {
          const lines = await toolDef.describeConfirmation(t.input, options.context)
          if (lines && lines.length > 0) displayLines = lines
        } catch (err) {
          console.debug(`[tool-executor] describeConfirmation failed for ${t.name}:`, err)
        }
      }

      // Q10 unification (WU-6.3) — persist a `kind='tool_invocation'` row
      // when the route has wired the port. The returned approvalId rides
      // on the request so the resolve endpoint can flip the row on click.
      // Fail-OPEN: a DB blip must not block the user — the in-memory
      // resolver still works without a row (Path A fallback).
      let approvalId: string | undefined
      if (options.context.createToolInvocationApproval) {
        const expiresAt = new Date(
          Date.now() + (options.confirmationTimeoutMs ?? 300_000),
        )
        try {
          approvalId = await options.context.createToolInvocationApproval({
            toolName: t.name,
            toolInput: t.input,
            description: toolDef.description,
            displayLines,
            allowPersistentApproval: toolDef.allowPersistentApproval ?? false,
            expiresAt,
          })
        } catch (err) {
          console.warn(
            `[tool-executor] approval row creation failed for ${t.name}; continuing with in-memory confirmation only:`,
            err,
          )
        }

        // WU-6.3 — durability event. Fires only when a row was actually
        // persisted: the consumer (chat route) writes a
        // `session_resume_points` checkpoint off this so the approval
        // survives a Cloud Run restart. Path A (no port, or DB blip) skips.
        if (approvalId && options.onAwaitingApproval) {
          options.onAwaitingApproval({
            approvalId,
            toolCallId: t.id,
            toolName: t.name,
            toolInput: t.input,
            describeText:
              displayLines && displayLines.length > 0
                ? displayLines.join('\n')
                : toolDef.description,
            expiresAt,
          })
        }
      }

      options.onConfirmationRequired?.({
        toolCallId: t.id,
        toolName: t.name,
        serverName: '',
        input: t.input,
        classification: null,
        description: toolDef.description,
        displayLines,
        allowPersistentApproval: toolDef.allowPersistentApproval ?? false,
        approvalId,
      })
      wake() // let the query loop yield the confirmation event

      try {
        const decision = await options.confirmationResolver.waitForDecision(
          t.id,
          options.confirmationTimeoutMs ?? 300_000,
        )

        if (decision === 'deny' || decision === 'always_deny') {
          deniedTools.add(t.name)
          t.result = {
            type: 'tool_result',
            toolUseId: t.id,
            name: t.name,
            content: declinedToolResult(t.name),
            isError: true,
          }
          t.status = 'completed'
          wake()
          return
        }
        // 'allow' or 'always_allow' — fall through to execution
      } catch {
        // Timeout — treat as deny for this session
        deniedTools.add(t.name)
        t.result = {
          type: 'tool_result',
          toolUseId: t.id,
          name: t.name,
          content: timedOutToolResult(t.name),
          isError: true,
        }
        t.status = 'completed'
        wake()
        return
      }
    }

    // ── Execution-slot gate ────────────────────────────────────
    // Confirmation has either passed or wasn't required. Now we wait
    // for an execution slot per the concurrency-safe contract:
    // non-concurrency-safe tools never run simultaneously with another
    // running tool (safe or unsafe). canExecute only counts `executing`
    // (not `pending_confirmation`/`awaiting_slot`) so a user can be
    // prompted for tool 2 while tool 1 is still mid-execute. The wait
    // itself happens here instead of in tryStartQueued so the
    // confirmation phase always runs in parallel.
    if (!canExecute(t.isConcurrencySafe)) {
      t.status = 'awaiting_slot'
      while (!canExecute(t.isConcurrencySafe)) {
        await waitForChange()
      }
    }

    t.status = 'executing'
    wake() // notify getRemainingResults that tool transitioned from 'queued'
    options.onToolStart?.(t.id, t.name)

    const toolTimeout = toolDef.timeoutMs ?? 30_000
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), toolTimeout)

    // Merge abort signals: parent context + sibling abort + per-tool timeout
    const mergedSignal = AbortSignal.any([
      options.context.abortSignal,
      siblingAbort.signal,
      timeoutController.signal,
    ])

    try {
      const validated = toolDef.inputSchema.parse(t.input)

      // WU-4.3 — write-time clearance gate (Q8 lock).
      // If the validated input declares a `sensitivity` tier, reject when it
      // exceeds the assistant's clearance — those writes would create rows
      // the same assistant cannot read back. System callers (clearance
      // undefined) pass through, per ToolContext docs.
      //
      // Gate on `assistantClearance` (the assistant's OWN tier), NOT the
      // read ceiling `clearance` (which a workspace turn lowers to
      // min(member, assistant) — incident 2026-06-01). This keeps writes
      // authorable at the assistant's clearance even when the acting member
      // reads at a lower tier. Falls back to `clearance` when unsplit.
      const requested = (validated as { sensitivity?: unknown } | null)?.sensitivity
      const clearance = options.context.assistantClearance ?? options.context.clearance
      if (clearance !== undefined && isSensitivity(requested) && !canRead(clearance, requested)) {
        clearTimeout(timer)
        t.result = {
          type: 'tool_result',
          toolUseId: t.id,
          name: t.name,
          content: `ERROR: sensitivity_exceeds_clearance — "${t.name}" requested sensitivity '${requested}' but the assistant's clearance is '${clearance}'. Lower the requested sensitivity to '${clearance}' or below.`,
          isError: true,
        }
        t.status = 'completed'
        wake()
        return
      }

      // Compartment write-gate (the MLS category axis). If the validated input
      // declares `compartments`, reject any key outside the assistant's grant —
      // you cannot author into a compartment you are not cleared for. Universe
      // grant (`assistantCompartments` null/undefined) → no gate, exactly like
      // the clearance gate's system-caller passthrough. See compartment-axis.md.
      const requestedCompartments = (validated as { compartments?: unknown } | null)?.compartments
      if (
        Array.isArray(requestedCompartments) &&
        requestedCompartments.every((c): c is string => typeof c === 'string') &&
        !subsetCompartments(options.context.assistantCompartments, requestedCompartments)
      ) {
        clearTimeout(timer)
        t.result = {
          type: 'tool_result',
          toolUseId: t.id,
          name: t.name,
          content: `ERROR: compartment_not_granted — "${t.name}" requested compartments [${requestedCompartments.join(', ')}] but the assistant is granted [${(options.context.assistantCompartments ?? []).join(', ')}]. Use a compartment within the assistant's grant.`,
          isError: true,
        }
        t.status = 'completed'
        wake()
        return
      }

      // Identifier-provenance write-gate (the mechanical half of the
      // workflow anti-fabrication guard). When the run's owner threaded an
      // EvidenceAccumulator and gated this tool, every identifier-shaped
      // value in the validated input (email / URL / handle / phone) must
      // have been observed this run — in a tool result (note()d below) or
      // in the caller-seeded instruction. A miss rejects the write with an
      // error the model can act on: re-verify with a tool, or drop the
      // field / write "not verified". This is what stops a budget-pressed
      // unattended callee from persisting invented contact identifiers as
      // records (the 2026-07-13 HKTVmall prospect fabrications). See
      // docs/architecture/engine/identifier-provenance-gate.md.
      const evidence = options.context.evidence
      if (evidence?.shouldGate(t.name)) {
        const unverified = evidence.findUnverified(JSON.stringify(validated))
        if (unverified.length > 0) {
          clearTimeout(timer)
          const listing = unverified
            .map((u) => `${u.value} (${u.kind})`)
            .join(', ')
          t.result = {
            type: 'tool_result',
            toolUseId: t.id,
            name: t.name,
            content:
              `ERROR: identifier_not_in_evidence: "${t.name}" was not executed. ` +
              `These values do not appear in any tool result or instruction from this run: ${listing}. ` +
              `A record write may only contain identifiers you actually observed this run. ` +
              `Either verify each value with a tool first, or retry the write without those fields and state "not verified" for them in your reply. Do not restate a rejected value as if it were confirmed.`,
            isError: true,
          }
          t.status = 'completed'
          options.loopDetector.recordOutcome(t.name, true)
          wake()
          return
        }
      }

      // Build a notifyConfirmationRequired callback that pushes the event
      // and wakes the executor — so getRemainingResults yields and the
      // query loop can flush the confirmation event to the user.
      const notifyConfirmationRequired = options.onConfirmationRequired
        ? (request: ToolConfirmationRequest) => {
            options.onConfirmationRequired!(request)
            wake()
          }
        : undefined

      const result = await toolDef.execute(validated, {
        ...options.context,
        abortSignal: mergedSignal,
        confirmationResolver: options.confirmationResolver,
        notifyConfirmationRequired,
        confirmationTimeoutMs: options.confirmationTimeoutMs,
      })

      clearTimeout(timer)
      options.onToolEnd?.(t.id, t.name, result)

      let content = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)

      // Layer 3: per-tool char cap — truncate oversized non-cacheable results
      if (toolDef.maxResultSizeChars && content.length > toolDef.maxResultSizeChars) {
        content = content.slice(0, toolDef.maxResultSizeChars) + '\n\n[Result truncated]'
      }

      // Layer 4: global token-budget cap — universal safety net so no tool
      // can silently blow the model's context window even when it didn't opt
      // into a per-tool char cap. `capToolResultTokens` is CJK-aware (a naive
      // `slice(0, BUDGET * 4)` would leak ~4× past budget on 1-char/token
      // CJK content) and a no-op under budget. `isError` stays as the tool
      // reported — this is a capacity guard, not a failure.
      content = capToolResultTokens(content)

      t.result = { type: 'tool_result', toolUseId: t.id, name: t.name, content, isError: result.isError }
      // Feed the identifier-evidence sets with exactly what the model will
      // see (post-cap content) — identifiers observed here become fair game
      // for gated record writes later in the run. Errors are never fed, and
      // noteToolResult excludes input-echoed identifiers (a search result
      // echoing its own query is not verification). The source attribution
      // feeds the grounding gate's claim ledger (which tool result backed
      // each figure) — see docs/architecture/engine/grounding-gate.md.
      if (result.isError !== true) {
        evidence?.noteToolResult(content, JSON.stringify(t.input), {
          toolUseId: t.id,
          toolName: t.name,
        })
      }
      // Inline images (e.g. an MCP tool returning sampled frames) become `image`
      // content blocks emitted right after the tool_result, so a multimodal
      // provider sees them. Capped + validated; a text-only provider drops them.
      if (Array.isArray(result.images) && result.images.length > 0) {
        t.resultImages = result.images
          .filter((im) => im && typeof im.data === 'string' && im.data.length > 0)
          .slice(0, 8)
          .map((im) => ({ type: 'image', mimeType: im.mimeType || 'image/jpeg', data: im.data }))
      }
      t.meta = result.meta
      t.status = 'completed'
      // Feed the consecutive-failure breaker with this real outcome (a tool may
      // signal a soft failure via result.isError without throwing).
      options.loopDetector.recordOutcome(t.name, result.isError === true)
    } catch (err) {
      clearTimeout(timer)
      // Same cap as the success path — a thrown error is tool-produced,
      // unbounded content too. The pathological case is a `ZodError` (from
      // the `inputSchema.parse` above or a tool's own internal validation):
      // `ZodError.message` is `JSON.stringify(issues)` and `invalid_union`
      // recursively expands every branch, so `formatToolError` collapses it
      // to a compact, actionable list before the token cap is even reached.
      const content = capToolResultTokens(`Error: ${formatToolError(err)}`)
      t.result = { type: 'tool_result', toolUseId: t.id, name: t.name, content, isError: true }
      t.status = 'completed'
      // A thrown error (incl. the `inputSchema.parse` ZodError behind
      // "Validation failed: …") is a real failure — feed the streak breaker.
      options.loopDetector.recordOutcome(t.name, true)

      // Abort siblings if this tool has abortSiblingsOnError
      if (toolDef.abortSiblingsOnError) {
        hasErrored = true
        siblingAbort.abort('sibling_error')
      }
    }

    wake()
  }

  function tryStartQueued() {
    for (const t of tracked) {
      if (t.status !== 'queued') continue
      if (t.promise) continue // already started — waiting for async setup (e.g. resolveConfirmation)
      if (!canExecute(t.isConcurrencySafe)) break // can't start until exclusive slot opens
      t.promise = executeTool(t)
    }
  }

  return {
    /**
     * Add a tool call from the model stream. Starts execution immediately if possible.
     */
    addTool(id: string, name: string, input: Record<string, unknown>) {
      const toolDef = options.tools.get(name)
      tracked.push({
        id,
        name,
        input,
        status: 'queued',
        isConcurrencySafe: toolDef?.isConcurrencySafe ?? false,
      })
      tryStartQueued()
    },

    /**
     * Get completed results in order. Stops at first non-completed tool.
     * Returns results that haven't been yielded yet, plus any per-toolUseId
     * meta attached by the tool's ToolResult.meta (side-channel for
     * observability — not serialized to the model).
     */
    getCompletedResults(): CompletedResults {
      const blocks: ContentBlock[] = []
      const metaByToolUseId: Record<string, ToolResultMeta> = {}
      for (const t of tracked) {
        if (t.status === 'yielded') continue
        if (
          t.status === 'pending_confirmation'
          || t.status === 'awaiting_slot'
          || t.status === 'queued'
          || t.status === 'executing'
        ) break // preserve order
        if (t.result) {
          blocks.push(t.result)
          // Emit tool-produced images right after their tool_result so they land
          // in the same tool-results user turn the model reads next.
          if (t.resultImages?.length) blocks.push(...t.resultImages)
          if (t.meta) metaByToolUseId[t.id] = t.meta
        }
        t.status = 'yielded'
      }
      // After yielding, try to start more queued tools
      tryStartQueued()
      return { blocks, metaByToolUseId }
    },

    /**
     * Wait for all remaining tools to complete and return their results.
     */
    /**
     * Wait for all remaining tools to complete and return their results.
     *
     * @param hasPendingEvents — optional callback; when it returns true,
     * the generator yields even with 0 results so the consumer (query
     * loop) can flush side-channel events like confirmations from inner
     * tools (e.g. mcp_call with 'ask' policy).
     */
    async *getRemainingResults(hasPendingEvents?: () => boolean): AsyncIterable<CompletedResults> {
      while (true) {
        tryStartQueued()

        const results = this.getCompletedResults()
        if (results.blocks.length > 0 || hasPendingEvents?.()) {
          yield results
        }

        // Check if all done
        const allDone = tracked.every((t) => t.status === 'yielded')
        if (allDone) break

        // Wait for any tool to finish (executing, pending confirmation,
        // awaiting an execution slot, or queued with a running promise).
        const active = tracked.filter((t) =>
          t.status === 'executing'
          || t.status === 'pending_confirmation'
          || t.status === 'awaiting_slot',
        )
        const startingUp = tracked.filter((t) => t.status === 'queued' && t.promise)
        if (active.length > 0 || startingUp.length > 0) {
          await waitForChange()
        } else {
          // Nothing executing and not all yielded — try starting more
          tryStartQueued()
          const stillQueued = tracked.some((t) => t.status === 'queued')
          if (!stillQueued) break
        }
      }
    },

    /**
     * Whether any tool in this turn triggered a nudge from the loop detector.
     * Set during execution — safe to read without side effects.
     */
    get hadNudge(): boolean {
      return nudgeDetected
    },

    get hasError(): boolean {
      return hasErrored
    },

    get pendingCount(): number {
      return tracked.filter((t) => t.status !== 'yielded').length
    },
  }
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>
