/**
 * Workflow executor — advances a `workflow_runs` row through its definition.
 *
 * Single entry point: `advanceWorkflowRun(deps, runId)`. Loads the run,
 * walks the steps, dispatches by `step.type`, persists per-step state, and
 * returns a terminal `RunOutcome` (or `paused` for Phase B `wait`).
 *
 * The DB / MCP / consult dependencies are injected by the API layer — core
 * does not import `pg`, `injectMcpTools`, or store implementations directly.
 *
 * See docs/architecture/features/workflow.md.
 *
 * [COMP:workflow/executor]
 */

import {
  INITIAL_BUDGET,
  type ConsultRequest,
  type ConsultTransport,
} from '../a2a/index.js'
import type { Tool, ToolContext } from '../tools/types.js'
import type {
  AssistantCallStep,
  BranchStep,
  ToolCallStep,
  WaitStep,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStep,
  WorkflowStore,
} from './types.js'
import { evaluateBoolean, JsonLogicEvalError } from './condition.js'
import { interpolateString, interpolateValue } from './interpolation.js'
import type { ResearchDepthConfig } from '../engine/research-depth.js'
import { sanitizeDeliveryText } from '@sidanclaw/shared'

/**
 * Build a `ResearchDepthConfig` from a step's per-step run-time settings
 * (step-level evolution of mig 196). Returns undefined when neither knob is
 * set so backward-compatible runs preserve the historical 5-turn / 30s
 * callee default.
 *
 *   researchMode=true → `tier: 'deep'` (raises turn / tool-call / wall-clock
 *                        caps to the deep preset).
 *   maxTurns set      → numeric override on top of tier preset (clamped at
 *                        the route layer; the resolver clamps again to
 *                        `RESEARCH_BUDGET_CEILING.maxTurns`).
 *
 * Legacy workflows authored before per-step settings have their step rows
 * backfilled from the workflow row's columns on read (see
 * `packages/api/src/db/workflow-store.ts` → `backfillStepRunSettings`),
 * so this function only ever consults step state.
 */
function buildStepDepth(step: AssistantCallStep): ResearchDepthConfig | undefined {
  const tier = step.researchMode ? 'deep' : undefined
  const maxTurns = step.maxTurns ?? undefined
  if (tier === undefined && maxTurns === undefined) return undefined
  return { tier, maxTurns }
}

/**
 * Canonical UUID shape. Used to validate a resolved `assistant_call` target
 * before the consult, so a non-UUID slug never reaches the assistant-by-id
 * lookup (where Postgres would throw "invalid input syntax for type uuid").
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Outcome ─────────────────────────────────────────────────────────────

export type RunOutcome =
  | { kind: 'completed'; runId: string; finalOutput?: unknown; stepCount: number }
  | { kind: 'failed'; runId: string; stepId: string; error: ExecutorError; stepCount: number }
  | { kind: 'paused'; runId: string; stepId: string; reason: 'wait' | 'approval' }

export type ExecutorError = {
  message: string
  reason?: string
  detail?: unknown
}

// ── Dependencies ────────────────────────────────────────────────────────

/**
 * Look up the `kind='primary'` assistant id for a workspace. Used to
 * resolve the `'primary'` sentinel in `assistant_call.target.assistantId`.
 */
export type ResolvePrimaryAssistant = (workspaceId: string) => Promise<string | null>

/**
 * Build the per-run merged tool registry: first-party + allow-policy MCP
 * tools, scoped to a workspace + acting assistant. Constructed once at the
 * start of every workflow run; held immutable for that run's duration.
 */
export type BuildToolRegistry = (params: {
  workspaceId: string
  /** The acting assistant — typically the workspace's primary. */
  assistantId: string
  userId: string | null
}) => Promise<Map<string, Tool>>

/**
 * Optional audit hook. Fire-and-forget at the call site (the executor never
 * lets an audit failure abort a run). Mirrors the workspaceAuditStore.append
 * shape so the API wiring can pass that directly.
 */
export type EmitAuditEvent = (event: WorkflowAuditEvent) => Promise<void> | void

/**
 * Outcome of a channel-delivery attempt. The executor records it on the step
 * run (under the reserved `__delivery` output key) and emits a
 * `workflow.step_delivered` audit event, so a delivery that silently went
 * nowhere is now visible instead of being swallowed to a `console.warn`. This
 * is what closes the "even if it runs, it fails to emit messages" failure
 * class: a `web` target, a missing channel integration, or a push error all
 * surface as a typed non-`delivered` status rather than looking like success.
 */
export type DeliveryOutcome =
  | { status: 'delivered'; channelType: string; channelId: string }
  | {
      status: 'skipped'
      channelType: string
      /**
       * `web_not_a_target` — web is a pull surface, never pushed to (the most
       * common author mistake). `no_integration` — the channel has no
       * connected bot/credentials. `no_recipient` — no resolvable WhatsApp
       * JID. `empty_text` — the step produced nothing to send. `not_wired` —
       * the executor has no `deliverToChannel` port (Phase A / tests).
       */
      reason: 'web_not_a_target' | 'no_integration' | 'no_recipient' | 'empty_text' | 'not_wired'
    }
  | { status: 'failed'; channelType: string; error: string }

/**
 * Push an `assistant_call` step's text output to a user channel. Injected
 * by the API layer (core has no channel-adapter surface). Best-effort — the
 * executor never fails the step on a delivery problem, but it now records the
 * returned `DeliveryOutcome` (audit + step-run output) so the problem is
 * observable. See docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
 */
export type DeliverToChannel = (params: {
  workspaceId: string
  /** The assistant whose channel integration sends the message. */
  assistantId: string
  /** Billing / delivery-session owner. */
  userId: string
  channelType: 'web' | 'telegram' | 'slack' | 'whatsapp'
  channelId: string
  text: string
}) => Promise<DeliveryOutcome>

export type WorkflowAuditEvent =
  | {
      type: 'workflow.run_started'
      workspaceId: string
      actorUserId: string | null
      runId: string
      workflowId: string
      workflowName: string
      trigger: WorkflowRunRecord['triggerKind']
    }
  | {
      type: 'workflow.run_completed'
      workspaceId: string
      actorUserId: string | null
      runId: string
      workflowId: string
      workflowName: string
      stepCount: number
      durationMs: number
    }
  | {
      type: 'workflow.run_failed'
      workspaceId: string
      actorUserId: string | null
      runId: string
      workflowId: string
      workflowName: string
      stepId: string
      error: ExecutorError
    }
  | {
      type: 'workflow.auto_disabled'
      workspaceId: string
      actorUserId: string | null
      runId: string
      workflowId: string
      workflowName: string
      /** The failure reason that tripped the breaker (page_anchor_not_found). */
      reason: string
      /** How many consecutive runs failed with that reason. */
      streak: number
    }
  | {
      /**
       * Emitted after an `assistant_call` step with a `deliver` target
       * attempts channel delivery. Makes a no-op / failed push observable
       * instead of swallowing it: `delivery.status` is `delivered` | `skipped`
       * | `failed`. A `skipped` with reason `web_not_a_target` /
       * `no_integration` is the "I configured deliver but nothing arrived"
       * signal.
       */
      type: 'workflow.step_delivered'
      workspaceId: string
      actorUserId: string | null
      runId: string
      workflowId: string
      stepId: string
      delivery: DeliveryOutcome
    }

export type ExecutorDeps = {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  consultTransport: ConsultTransport
  resolvePrimary: ResolvePrimaryAssistant
  buildToolRegistry: BuildToolRegistry
  emitAudit?: EmitAuditEvent
  /**
   * Optional channel delivery. When wired, an `assistant_call` step with a
   * `deliver` target pushes its text output to that channel after the
   * consult completes. Absent = `deliver` is parsed but inert.
   */
  deliverToChannel?: DeliverToChannel
  /** Test override; defaults to `Date.now`. */
  now?: () => number
  /**
   * Phase B activation: when present, `wait` steps pause the run via this
   * callback (which writes to `scheduled_jobs`). Absent = Phase A behavior
   * (wait fails immediately with a clear "requires Phase B" error).
   */
  pauseRunForWait?: (params: {
    runId: string
    stepRunId: string
    workspaceId: string
    triggeredBy: string | null
    dueAt: Date
  }) => Promise<void>
  /**
   * Phase C activation: when present, `tool_call` against an `ask`-policy
   * tool pauses the run via this callback (which writes a
   * `pending_approvals` row + dispatches the approval delivery). Absent =
   * Phase A behavior (ask fails immediately with `'tool_requires_approval'`).
   */
  requestApproval?: (params: {
    runId: string
    stepRunId: string
    workspaceId: string
    approverUserId: string
    toolName: string
    arguments: Record<string, unknown>
    deliveryChannel: 'web' | 'telegram' | 'slack' | 'whatsapp'
    expiresAt: Date | null
  }) => Promise<void>
  /**
   * Page-anchor creation port — backs `assistant_call.page.create`. The API
   * layer implements it over `savedViewStore` (createDraft + setState
   * 'saved': a configured deliverable must not auto-prune). Returns the new
   * page id, which the executor threads to the consult as
   * `ConsultRequest.pageAnchorId` and stores in run vars under
   * `__pageAnchor_<stepId>` for `fromStep` composition. Absent = `create`
   * anchors fail with `'page_anchor_unavailable'`.
   * See docs/architecture/features/workflow.md → "assistant_call page anchor".
   */
  createAnchorPage?: (params: {
    workspaceId: string
    /** Acting user — `run.triggeredBy ?? workflow.createdBy`. */
    userId: string
    title: string
    nestUnder?: string
    /**
     * Genesis provenance for the page History panel — the interpolated step
     * prompt that produces this page each run (the workflow analog of "the
     * chat message that created it").
     */
    originPrompt?: string
  }) => Promise<{ id: string }>
}

// ── advanceWorkflowRun ──────────────────────────────────────────────────

/**
 * Advance a run from its current step until it reaches a terminal state, a
 * `wait`, or a paused approval. Safe to call repeatedly — each call picks
 * up where the last one left off (Phase B's wait wake-up calls back here).
 */
export async function advanceWorkflowRun(
  deps: ExecutorDeps,
  runId: string,
): Promise<RunOutcome> {
  const now = deps.now ?? Date.now

  // Load the run and its workflow.
  const run = await deps.runStore.getRunSystem(runId)
  if (!run) {
    return failOutcome(runId, '<unknown>', { message: `Run ${runId} not found.`, reason: 'run_not_found' }, 0)
  }
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'timeout') {
    // Already terminal — return a no-op completed/failed outcome based on existing state.
    if (run.status === 'failed') {
      return failOutcome(runId, run.currentStepId ?? '<unknown>', toExecutorError(run.error) ?? { message: 'run already failed' }, 0)
    }
    return { kind: 'completed', runId, stepCount: 0 }
  }

  const workflow = await loadWorkflowForRun(deps, run)
  if (!workflow) {
    const err: ExecutorError = { message: `Workflow ${run.workflowId} not found.`, reason: 'workflow_not_found' }
    await markRunFailed(deps, run, '<unknown>', err)
    return failOutcome(runId, '<unknown>', err, 0)
  }

  // Build the per-run tool registry (first-party + allow-policy MCP).
  // Resolve the acting assistant first — needed for both `assistant_call`
  // chain construction and tool-registry scoping.
  const primaryAssistantId = await deps.resolvePrimary(run.workspaceId)
  if (!primaryAssistantId) {
    const err: ExecutorError = { message: 'Workspace has no primary assistant.', reason: 'no_primary_assistant' }
    await markRunFailed(deps, run, '<unknown>', err)
    return failOutcome(runId, '<unknown>', err, 0)
  }

  let toolRegistry: Map<string, Tool>
  try {
    toolRegistry = await deps.buildToolRegistry({
      workspaceId: run.workspaceId,
      assistantId: primaryAssistantId,
      // Scheduled / wait-wakeup runs have `run.triggeredBy === null`; fall
      // back to the workflow's creator so RLS-touching tool resolvers have
      // a real user (matches the pattern used by deliver/consult below).
      userId: run.triggeredBy ?? workflow.createdBy,
    })
  } catch (err) {
    const error: ExecutorError = {
      message: `Failed to build tool registry: ${err instanceof Error ? err.message : String(err)}`,
      reason: 'tool_registry_failed',
    }
    await markRunFailed(deps, run, '<unknown>', error)
    return failOutcome(runId, '<unknown>', error, 0)
  }

  // Was this the first call into the run? Emit the audit event + flip to running.
  const isFirstAdvance = run.status === 'pending'
  if (isFirstAdvance) {
    await deps.runStore.updateRun(runId, { status: 'running', currentStepId: workflow.definition.startStepId })
    fireAndForgetAudit(deps, {
      type: 'workflow.run_started',
      workspaceId: run.workspaceId,
      actorUserId: run.triggeredBy,
      runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      trigger: run.triggerKind,
    })
  } else {
    await deps.runStore.updateRun(runId, { status: 'running' })
  }

  // Step lookup map.
  const stepMap = new Map<string, WorkflowStep>(workflow.definition.steps.map((s) => [s.id, s]))
  const orderedIds = workflow.definition.steps.map((s) => s.id)

  // Variables — start from persisted state (re-entry from wait) or empty.
  let vars: Record<string, unknown> = { ...run.vars }
  const input = run.input

  let currentStepId: string | null = run.currentStepId ?? workflow.definition.startStepId
  let lastOutput: unknown = null
  let stepCount = 0

  while (currentStepId !== null) {
    const step = stepMap.get(currentStepId)
    if (!step) {
      const err: ExecutorError = {
        message: `Definition references unknown step "${currentStepId}".`,
        reason: 'unknown_step',
      }
      await markRunFailed(deps, run, currentStepId, err)
      return failOutcome(runId, currentStepId, err, stepCount)
    }

    const interp = { vars, input }

    // Pre-flight: wait step in Phase A errors here before we insert a step run
    // so we don't leave a stranded 'running' row. In Phase B, fall through to
    // the dispatch below.
    if (step.type === 'wait' && !deps.pauseRunForWait) {
      const err: ExecutorError = {
        message:
          'wait step requires the schedule extension (Phase B) to be deployed; not yet available.',
        reason: 'wait_requires_phase_b',
      }
      // Record the failed step too, so getWorkflowRun shows what blew up.
      const stepRun = await deps.runStore.createStepRun({
        runId,
        stepId: step.id,
        stepType: step.type,
        input: { wait: { until: step.until, at: step.at } },
      })
      await deps.runStore.updateStepRun(stepRun.id, {
        status: 'failed',
        error: err as unknown as Record<string, unknown>,
        finishedAt: new Date(now()),
      })
      await markRunFailed(deps, run, step.id, err)
      return failOutcome(runId, step.id, err, stepCount)
    }

    // Insert a step-run row in 'running' state.
    const stepRunInput = buildStepRunInput(step, interp)
    const stepRun = await deps.runStore.createStepRun({
      runId,
      stepId: step.id,
      stepType: step.type,
      input: stepRunInput,
    })

    let dispatchResult: StepDispatchResult
    try {
      dispatchResult = await dispatchStep(step, {
        run,
        workflow,
        primaryAssistantId,
        toolRegistry,
        consultTransport: deps.consultTransport,
        scope: interp,
        deps,
      })
    } catch (err) {
      // Hoist a typed reason when the throw site attached one (the callee
      // executor's page-anchor gate throws Errors carrying `reason:
      // 'page_anchor_not_found' | 'page_anchor_forbidden' | ...`, and a
      // wall-clock abort carries `reason: 'timeout'`). A bare throw stays the
      // honest generic 'dispatch_threw'.
      const thrownReason = (err as { reason?: unknown } | null)?.reason
      const isTimeout = thrownReason === 'timeout'
      const error: ExecutorError = {
        message: err instanceof Error ? err.message : String(err),
        reason: typeof thrownReason === 'string' ? thrownReason : 'dispatch_threw',
      }
      // Preserve any partial output the callee streamed before a timeout abort,
      // so a timed-out run isn't a total loss — the step-run record keeps what
      // was gathered. The step-run status stays `failed` (no `timeout` member
      // in WORKFLOW_STEP_RUN_STATUSES); the run-level status carries `timeout`.
      const partial = (err as { partialOutput?: unknown } | null)?.partialOutput
      await deps.runStore.updateStepRun(stepRun.id, {
        status: 'failed',
        error: error as unknown as Record<string, unknown>,
        ...(typeof partial === 'string' && partial.length > 0
          ? { output: { value: partial, __truncated: true } }
          : {}),
        finishedAt: new Date(now()),
      })
      await markRunFailed(deps, run, step.id, error, isTimeout ? 'timeout' : 'failed')
      await maybeDisableForDeadAnchor(deps, run, workflow, primaryAssistantId, error)
      return failOutcome(runId, step.id, error, stepCount)
    }

    // Pause-on-wait (Phase B). The dispatch result for `wait` is a paused
    // sentinel; the scheduled_jobs row is written by `pauseRunForWait`.
    if (dispatchResult.kind === 'paused_wait') {
      await deps.pauseRunForWait!({
        runId,
        stepRunId: stepRun.id,
        workspaceId: run.workspaceId,
        triggeredBy: run.triggeredBy,
        dueAt: dispatchResult.dueAt,
      })
      await deps.runStore.updateRun(runId, {
        status: 'awaiting_wait',
        currentStepId: step.id,
      })
      return { kind: 'paused', runId, stepId: step.id, reason: 'wait' }
    }

    // Pause-on-approval (Phase C).
    if (dispatchResult.kind === 'paused_approval') {
      // `requestApproval` is responsible for writing pending_approvals +
      // dispatching the delivery; we just flip the run state.
      const expiresAt = dispatchResult.expiresAt
      await deps.requestApproval!({
        runId,
        stepRunId: stepRun.id,
        workspaceId: run.workspaceId,
        approverUserId: dispatchResult.approverUserId,
        toolName: dispatchResult.toolName,
        arguments: dispatchResult.arguments,
        deliveryChannel: dispatchResult.deliveryChannel,
        expiresAt,
      })
      await deps.runStore.updateRun(runId, {
        status: 'awaiting_input',
        currentStepId: step.id,
      })
      return { kind: 'paused', runId, stepId: step.id, reason: 'approval' }
    }

    // Failure — terminal.
    if (dispatchResult.kind === 'failed') {
      await deps.runStore.updateStepRun(stepRun.id, {
        status: 'failed',
        error: dispatchResult.error as unknown as Record<string, unknown>,
        finishedAt: new Date(now()),
      })
      await markRunFailed(deps, run, step.id, dispatchResult.error)
      await maybeDisableForDeadAnchor(deps, run, workflow, primaryAssistantId, dispatchResult.error)
      return failOutcome(runId, step.id, dispatchResult.error, stepCount + 1)
    }

    // Success — capture output, advance vars + lastOutput, persist.
    stepCount++
    lastOutput = dispatchResult.output
    // Dispatch-produced vars first (page-anchor `__pageAnchor_<stepId>`
    // entries), then storeOutputAs — a user key can never be shadowed by a
    // reserved one because storeOutputAs forbids the `__` prefix shape.
    if (dispatchResult.varsPatch) {
      vars = { ...vars, ...dispatchResult.varsPatch }
    }
    if (step.storeOutputAs && step.type !== 'branch' && step.type !== 'wait') {
      vars = { ...vars, [step.storeOutputAs]: dispatchResult.output }
    }
    await deps.runStore.updateStepRun(stepRun.id, {
      status: 'completed',
      // Record delivery outcome alongside the logical output (reserved
      // `__delivery` key) so the run-detail surface shows whether the step's
      // `deliver` actually reached a channel. `vars`/`storeOutputAs` read
      // `dispatchResult.output` directly, so this never leaks into later steps.
      output: dispatchResult.delivery
        ? { ...wrapOutput(dispatchResult.output), __delivery: dispatchResult.delivery }
        : wrapOutput(dispatchResult.output),
      finishedAt: new Date(now()),
    })

    // Resolve next step.
    const nextId = nextStepIdFor(step, dispatchResult, orderedIds)
    currentStepId = nextId
    await deps.runStore.updateRun(runId, {
      currentStepId,
      vars,
    })
  }

  // Terminal completion.
  const finishedAt = new Date(now())
  await deps.runStore.updateRun(runId, {
    status: 'completed',
    finishedAt,
    currentStepId: null,
  })
  fireAndForgetAudit(deps, {
    type: 'workflow.run_completed',
    workspaceId: run.workspaceId,
    actorUserId: run.triggeredBy,
    runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepCount,
    durationMs: finishedAt.getTime() - run.startedAt.getTime(),
  })
  return { kind: 'completed', runId, stepCount, finalOutput: lastOutput }
}

// ── Dispatch ────────────────────────────────────────────────────────────

type StepDispatchResult =
  | {
      kind: 'success'
      output: unknown
      branchTaken?: 'true' | 'false'
      /**
       * Run-vars amendments produced by the dispatch itself — today only the
       * `__pageAnchor_<stepId>` entry a `page.create` anchor writes so later
       * `fromStep` anchors can resolve it. Merged into `vars` (and persisted)
       * by the run loop alongside `storeOutputAs`.
       */
      varsPatch?: Record<string, unknown>
      /**
       * Channel-delivery outcome for a `deliver`-carrying `assistant_call`
       * step. Recorded on the step run under the reserved `__delivery` output
       * key (not folded into `vars`, so it never pollutes downstream steps).
       */
      delivery?: DeliveryOutcome
    }
  | { kind: 'failed'; error: ExecutorError }
  | { kind: 'paused_wait'; dueAt: Date }
  | {
      kind: 'paused_approval'
      approverUserId: string
      toolName: string
      arguments: Record<string, unknown>
      deliveryChannel: 'web' | 'telegram' | 'slack' | 'whatsapp'
      expiresAt: Date | null
    }

type DispatchContext = {
  run: WorkflowRunRecord
  workflow: WorkflowRecord
  primaryAssistantId: string
  toolRegistry: Map<string, Tool>
  consultTransport: ConsultTransport
  scope: { vars: Record<string, unknown>; input: Record<string, unknown> }
  /** Phase C — when present, ask-policy tool_calls pause instead of failing. */
  deps: ExecutorDeps
}

async function dispatchStep(step: WorkflowStep, ctx: DispatchContext): Promise<StepDispatchResult> {
  switch (step.type) {
    case 'assistant_call':
      return dispatchAssistantCall(step, ctx)
    case 'tool_call':
      return dispatchToolCall(step, ctx)
    case 'branch':
      return dispatchBranch(step, ctx)
    case 'wait':
      return dispatchWait(step)
  }
}

async function dispatchAssistantCall(
  step: AssistantCallStep,
  ctx: DispatchContext,
): Promise<StepDispatchResult> {
  const targetAssistantId =
    step.target.assistantId === 'primary'
      ? ctx.primaryAssistantId
      : step.target.assistantId

  // Defend against definitions persisted before the schema enforced the
  // `uuid | 'primary'` contract (or written through any non-schema path): a
  // human-readable target like "product-assistant" would otherwise reach the
  // consult's assistant-by-id lookup and surface as an opaque Postgres
  // "invalid input syntax for type uuid" failure. Fail here with an
  // actionable message instead. See workflow.md → "Locked V1 decisions".
  if (!UUID_RE.test(targetAssistantId)) {
    return {
      kind: 'failed',
      error: {
        message:
          `assistant_call step "${step.id}" targets "${step.target.assistantId}", which is not a valid assistant. ` +
          `Set the target to 'primary' or a concrete assistant id (edit the workflow in the builder or via updateWorkflow).`,
        reason: 'invalid_assistant_target',
      },
    }
  }

  const prompt = interpolateString(step.prompt, ctx.scope)

  // Page anchor — resolve whichever variant to one concrete page uuid
  // before the consult (the wire carries only `pageAnchorId`). The callee
  // executor then gates access and runs the callee doc-anchored.
  // See docs/architecture/features/workflow.md → "assistant_call page anchor".
  let pageAnchorId: string | undefined
  let varsPatch: Record<string, unknown> | undefined
  if (step.page) {
    if ('id' in step.page) {
      // Edit an existing page. A static uuid passes through interpolation
      // unchanged; a whole-string `{{vars/input}}` token (Phase B) resolves
      // here and must yield a uuid — mirroring the assistant-target shape
      // check above, with its own typed reason.
      const resolved = interpolateString(step.page.id, ctx.scope)
      if (!UUID_RE.test(resolved)) {
        return {
          kind: 'failed',
          error: {
            message:
              `assistant_call step "${step.id}" page anchor "${step.page.id}" resolved to "${resolved}", which is not a page id. ` +
              `Ensure the variable holds a page UUID (or re-pick the page in the workflow builder).`,
            reason: 'invalid_page_anchor',
          },
        }
      }
      pageAnchorId = resolved
    } else if ('create' in step.page) {
      // Create a saved page this run, anchor the callee to it, and record
      // the id under the reserved vars key so later `fromStep` anchors (and
      // run-detail inspection) can reach it.
      if (!ctx.deps.createAnchorPage) {
        return {
          kind: 'failed',
          error: {
            message: `assistant_call step "${step.id}" has a create-page anchor but the executor has no page-creation port configured.`,
            reason: 'page_anchor_unavailable',
          },
        }
      }
      const titleRaw =
        step.page.title ??
        `${ctx.workflow.name} ${new Date(ctx.deps.now?.() ?? Date.now())
          .toISOString()
          .slice(0, 10)}`
      try {
        const created = await ctx.deps.createAnchorPage({
          workspaceId: ctx.run.workspaceId,
          userId: ctx.run.triggeredBy ?? ctx.workflow.createdBy,
          // Titles are display text — interpolation is allowed (unlike ids).
          title: interpolateString(titleRaw, ctx.scope).slice(0, 256),
          nestUnder: step.page.nestUnder,
          // Genesis provenance for the History panel.
          originPrompt: prompt.slice(0, 2000),
        })
        pageAnchorId = created.id
        varsPatch = { [`__pageAnchor_${step.id}`]: created.id }
      } catch (err) {
        return {
          kind: 'failed',
          error: {
            message: `assistant_call step "${step.id}" failed to create its anchor page: ${
              err instanceof Error ? err.message : String(err)
            }`,
            reason: 'page_anchor_create_failed',
          },
        }
      }
    } else {
      // Anchor to the page a prior create-step made THIS run.
      const fromVar = ctx.scope.vars[`__pageAnchor_${step.page.fromStep}`]
      if (typeof fromVar !== 'string' || !UUID_RE.test(fromVar)) {
        return {
          kind: 'failed',
          error: {
            message:
              `assistant_call step "${step.id}" anchors page.fromStep "${step.page.fromStep}", but that step has not created a page in this run. ` +
              `Ensure the create-step runs earlier on every path that reaches "${step.id}".`,
            reason: 'page_anchor_unresolved',
          },
        }
      }
      pageAnchorId = fromVar
    }
  }

  const request: ConsultRequest = {
    target: {
      workspaceId: ctx.run.workspaceId,
      assistantId: targetAssistantId,
      // V1: always free mode (no capabilityId).
    },
    message: {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      role: 'user',
      parts: [{ kind: 'text', text: prompt }],
    },
    // Session continuity: a `persistent` step pins a stable contextId so the
    // callee reuses one durable session across fires. `per_run` (default)
    // leaves it undefined — a fresh session each consult.
    contextId:
      step.session === 'persistent'
        ? `workflow:${ctx.workflow.id}:${step.id}`
        : undefined,
    // Per-step tool restriction: a `tools` allow-list rides through to the
    // callee executor, which filters the callee's tool surface to exactly
    // this set. Undefined = the callee's normal tool surface.
    allowedTools: step.tools,
    // Research depth: step-level `depth` always wins; otherwise derive from
    // the step-level `researchMode` + `maxTurns` knobs (step-level evolution
    // of mig 196). Legacy workflow-row columns are backfilled onto each
    // step by the workflow-store reader, so step-level always wins here.
    // Both absent → the callee's default budget.
    depth: step.depth ?? buildStepDepth(step),
    // Per-step model alias (step-level evolution of mig 196) — Standard /
    // Pro / Max pick for this specific assistant_call. Falls back to the
    // workflow row's column so old in-memory test fixtures that don't run
    // through the store backfill still resolve sanely. Absent on both →
    // the callee's historical default applies via the consult transport.
    modelAlias: step.modelAlias ?? ctx.workflow.modelAlias,
    // Delivery target: a `deliver`-carrying step (scheduled-job reminders)
    // rides its channel through so the callee can surface `ask`-policy tool
    // confirmations there. Undefined = ordinary A2A (confirmations stripped).
    deliver: step.deliver,
    // Page anchor — resolved above to a concrete saved_views id. The callee
    // executor gates access + injects doc tools + sets ToolContext.docViewId.
    pageAnchorId,
    caller: {
      workspaceId: ctx.run.workspaceId,
      assistantId: ctx.primaryAssistantId,
      // Scheduled / wait-wakeup runs have `triggeredBy === null`; fall back
      // to the workflow's creator so the callee has a real RLS user — same
      // fallback the deliver/approval paths below already use.
      userId: ctx.run.triggeredBy ?? ctx.workflow.createdBy,
      channelType: 'workflow',
    },
    chain: {
      path: [],
      depth: 0,
      budget: INITIAL_BUDGET.workflow_run,
    },
  }

  const response = await ctx.consultTransport.send(request)
  const task = response.task

  switch (task.status.state) {
    case 'completed': {
      const lastAgent = (task.history ?? [])
        .slice()
        .reverse()
        .find((m) => m.role === 'agent')
      const text =
        lastAgent?.parts
          .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
          .map((p) => p.text)
          .join('\n') ?? ''
      // Optional channel delivery — best-effort. A push failure must never
      // fail the step (mirrors the scheduled-job "persist-first, soft-fail"
      // contract). Delivers the sanitized text (scaffolding / meta stripped —
      // see sanitizeDeliveryText), not the parsed JSON; `text` itself is left
      // intact for the step's structured `output` below. The outcome is
      // captured + audited so a no-op / failed push is observable rather than
      // swallowed (the "fails to emit messages" failure class).
      let delivery: DeliveryOutcome | undefined
      if (step.deliver) {
        const channelType = step.deliver.channelType
        // Strip any planning scaffolding the model echoed (e.g. a cron-framed
        // turn's "Message body:" preamble) before it reaches the user channel.
        // The API-side deliverToChannel impl sanitizes again (idempotent
        // defense-in-depth across the multiple DeliverToChannel impls).
        const deliveredText = sanitizeDeliveryText(text)
        if (!ctx.deps.deliverToChannel) {
          delivery = { status: 'skipped', channelType, reason: 'not_wired' }
        } else if (!deliveredText.trim()) {
          delivery = { status: 'skipped', channelType, reason: 'empty_text' }
        } else {
          try {
            delivery = await ctx.deps.deliverToChannel({
              workspaceId: ctx.run.workspaceId,
              assistantId: targetAssistantId,
              userId: ctx.run.triggeredBy ?? ctx.workflow.createdBy,
              channelType,
              channelId: step.deliver.channelId,
              text: deliveredText,
            })
          } catch (err) {
            delivery = {
              status: 'failed',
              channelType,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }
        // The step run always carries `__delivery` (the run-detail surface).
        // Audit + log only the non-`delivered` outcomes so a recurring
        // reminder that delivers fine every fire doesn't spam the audit log,
        // while a silent no-op / failure becomes a first-class signal.
        if (delivery.status !== 'delivered') {
          console.warn(`[workflow] step "${step.id}" delivery ${delivery.status}:`, delivery)
          fireAndForgetAudit(ctx.deps, {
            type: 'workflow.step_delivered',
            workspaceId: ctx.run.workspaceId,
            actorUserId: ctx.run.triggeredBy,
            runId: ctx.run.id,
            workflowId: ctx.workflow.id,
            stepId: step.id,
            delivery,
          })
        }
      }
      // If the response parses as JSON, hand the parsed object to subsequent
      // steps so branch conditions can reference structured fields.
      const parsed = tryParseJson(text)
      return { kind: 'success', output: parsed ?? text, varsPatch, delivery }
    }
    case 'failed': {
      const errMsg =
        task.status.message?.parts
          ?.filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
          .map((p) => p.text)
          .join(' ') ?? 'consult failed'
      return {
        kind: 'failed',
        error: { message: `assistant_call failed: ${errMsg}`, reason: 'consult_failed' },
      }
    }
    case 'input_required':
      return {
        kind: 'failed',
        error: {
          message:
            'assistant_call returned input_required (require_approval mode). Workflow runs cannot wait on cross-assistant approvals in V1.',
          reason: 'consult_input_required',
        },
      }
    default:
      return {
        kind: 'failed',
        error: {
          message: `assistant_call ended in unexpected state '${task.status.state}'.`,
          reason: 'consult_unexpected_state',
        },
      }
  }
}

async function dispatchToolCall(
  step: ToolCallStep,
  ctx: DispatchContext,
): Promise<StepDispatchResult> {
  const tool = ctx.toolRegistry.get(step.toolName)
  if (!tool) {
    return {
      kind: 'failed',
      error: {
        message: `tool_call references unknown / disallowed tool "${step.toolName}".`,
        reason: 'tool_not_found',
      },
    }
  }

  const interpolatedArgs = interpolateValue(step.arguments, ctx.scope)

  // Policy gate. MCP-discovered tools have `resolveConfirmation` set to a
  // closure that reads the user's effective allow/ask policy from
  // mcp_tool_settings. `block`-policy tools never make it into the registry
  // (injectMcpTools skips them at build time). First-party tools default to
  // `requiresConfirmation === false` and have no `resolveConfirmation`.
  let needsConfirmation = !!tool.requiresConfirmation
  if (tool.resolveConfirmation) {
    try {
      // Run with a synthetic context — only the userId/assistantId fields
      // are read by the resolver. We don't have the workflow ToolContext
      // built yet (and don't need it for policy lookup).
      needsConfirmation = await tool.resolveConfirmation({
        userId: ctx.run.triggeredBy ?? ctx.workflow.createdBy,
        assistantId: ctx.primaryAssistantId,
        sessionId: `workflow_run_${ctx.run.id}`,
        appId: 'sidanclaw',
        channelType: 'workflow',
        channelId: ctx.run.id,
        workspaceId: ctx.run.workspaceId,
        abortSignal: new AbortController().signal,
      } satisfies ToolContext, interpolatedArgs)
    } catch {
      // Treat resolver failure as ask-policy (fail-closed).
      needsConfirmation = true
    }
  }
  if (needsConfirmation) {
    return askPolicyOutcome(step, ctx, interpolatedArgs)
  }
  // Phase C activation lives in `dispatchStep` (one level up): when
  // `deps.requestApproval` is set, the executor flips the dispatchResult
  // to `paused_approval` here. We surface that decision through a sentinel
  // shape captured by `dispatchStep`.

  // Validate arguments against the tool's input schema.
  let validatedInput: unknown
  try {
    validatedInput = tool.inputSchema.parse(interpolatedArgs)
  } catch (err) {
    return {
      kind: 'failed',
      error: {
        message: `tool_call input validation failed for "${step.toolName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        reason: 'tool_input_invalid',
      },
    }
  }

  // Build a workflow-scope ToolContext.
  const abortController = new AbortController()
  const toolContext: ToolContext = {
    userId: ctx.run.triggeredBy ?? ctx.workflow.createdBy,
    assistantId: ctx.primaryAssistantId,
    sessionId: `workflow_run_${ctx.run.id}`,
    appId: 'sidanclaw',
    channelType: 'workflow',
    channelId: ctx.run.id,
    workspaceId: ctx.run.workspaceId,
    assistantKind: 'primary',
    abortSignal: abortController.signal,
  }

  let result
  try {
    result = await tool.execute(validatedInput, toolContext)
  } catch (err) {
    return {
      kind: 'failed',
      error: {
        message: `tool_call "${step.toolName}" threw: ${err instanceof Error ? err.message : String(err)}`,
        reason: 'tool_threw',
      },
    }
  }

  if (result.isError) {
    return {
      kind: 'failed',
      error: {
        message: `tool_call "${step.toolName}" returned error: ${stringifyData(result.data)}`,
        reason: 'tool_returned_error',
        detail: result.data,
      },
    }
  }

  return { kind: 'success', output: result.data }
}

/**
 * Resolve the dispatch outcome for an `ask`-policy tool_call.
 *   - Phase A (no requestApproval dep): fail with `tool_requires_approval`.
 *   - Phase C (requestApproval wired): return paused_approval; the executor
 *     loop calls `requestApproval` to write the pending row + send the
 *     notification, then flips the run to `awaiting_input`.
 */
function askPolicyOutcome(
  step: ToolCallStep,
  ctx: DispatchContext,
  args: Record<string, unknown>,
): StepDispatchResult {
  if (ctx.deps.requestApproval) {
    // Resolve the approver: triggered_by user for manual runs, workflow
    // creator for scheduled runs (the author owns the connector cred).
    const approverUserId = ctx.run.triggeredBy ?? ctx.workflow.createdBy
    const deliveryChannel = step.approval?.deliveryChannel ?? 'web'
    const expiresAt = step.approval?.expiresAfterHours
      ? new Date(Date.now() + step.approval.expiresAfterHours * 60 * 60 * 1000)
      : null
    return {
      kind: 'paused_approval',
      approverUserId,
      toolName: step.toolName,
      arguments: args,
      deliveryChannel,
      expiresAt,
    }
  }
  // Phase A guard.
  return {
    kind: 'failed',
    error: {
      message:
        `tool_call "${step.toolName}" requires user approval (ask-policy). ` +
        `Workflow runs cannot pause for approvals in this deployment; either re-author the workflow with an allow-policy tool, ` +
        `or update the connector's policy in Settings ▸ Connectors. ` +
        `(The detached approval flow is Phase C.)`,
      reason: 'tool_requires_approval',
      detail: { toolName: step.toolName, arguments: args },
    },
  }
}

function dispatchBranch(step: BranchStep, ctx: DispatchContext): StepDispatchResult {
  // `prev` for branch = the most recent non-branch output. We pass vars
  // explicitly so conditions can reference variables set by storeOutputAs.
  const data = { vars: ctx.scope.vars, input: ctx.scope.input }
  let result: boolean
  try {
    result = evaluateBoolean(step.condition, data)
  } catch (err) {
    if (err instanceof JsonLogicEvalError) {
      return {
        kind: 'failed',
        error: { message: `branch condition error: ${err.message}`, reason: 'branch_eval_failed' },
      }
    }
    throw err
  }
  return {
    kind: 'success',
    output: { branchTaken: result ? 'true' : 'false' } as Record<string, unknown>,
    branchTaken: result ? 'true' : 'false',
  }
}

function dispatchWait(step: WaitStep): StepDispatchResult {
  // Compute the absolute due time. (Reached only when pauseRunForWait is wired in Phase B.)
  let dueAt: Date
  if (step.until) {
    const d = step.until.duration
    const ms =
      (d.minutes ?? 0) * 60_000 + (d.hours ?? 0) * 3_600_000 + (d.days ?? 0) * 86_400_000
    dueAt = new Date(Date.now() + ms)
  } else if (step.at) {
    // Naive UTC parse — Phase B will plug in proper IANA tz handling. The
    // schema's `timezone` field is preserved through to `pauseRunForWait`.
    const tz = step.at.timezone ?? 'UTC'
    if (tz === 'UTC') {
      dueAt = new Date(`${step.at.datetime}Z`)
    } else {
      // For non-UTC, rely on the JS engine's Intl support. Best-effort —
      // the same logic exists in scheduling/schedule.ts and gets shared in B.
      dueAt = new Date(step.at.datetime)
    }
    if (Number.isNaN(dueAt.getTime())) {
      return {
        kind: 'failed',
        error: { message: `wait.at.datetime is not a valid timestamp: "${step.at.datetime}"`, reason: 'wait_bad_datetime' },
      }
    }
  } else {
    // Schema guarantees one is set.
    return {
      kind: 'failed',
      error: { message: 'wait step has neither `until` nor `at`.', reason: 'wait_unspecified' },
    }
  }
  return { kind: 'paused_wait', dueAt }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function nextStepIdFor(
  step: WorkflowStep,
  dispatch: StepDispatchResult,
  orderedIds: string[],
): string | null {
  if (step.type === 'branch') {
    if (dispatch.kind !== 'success') return null
    return dispatch.branchTaken === 'true' ? step.nextStepIdIfTrue : step.nextStepIdIfFalse
  }
  if (step.nextStepId !== undefined) return step.nextStepId
  // Sequential fallthrough.
  const idx = orderedIds.indexOf(step.id)
  if (idx === -1 || idx === orderedIds.length - 1) return null
  return orderedIds[idx + 1]
}

function buildStepRunInput(
  step: WorkflowStep,
  scope: { vars: Record<string, unknown>; input: Record<string, unknown> },
): Record<string, unknown> {
  switch (step.type) {
    case 'assistant_call':
      return {
        target: step.target,
        prompt: interpolateString(step.prompt, scope),
        // Audit the authored anchor (the resolved page id for create /
        // fromStep variants lands in run vars as `__pageAnchor_<stepId>`).
        ...(step.page ? { page: step.page } : {}),
      }
    case 'tool_call':
      return {
        toolName: step.toolName,
        arguments: interpolateValue(step.arguments, scope),
      }
    case 'wait':
      return { until: step.until, at: step.at }
    case 'branch':
      return { condition: step.condition }
  }
}

function wrapOutput(output: unknown): Record<string, unknown> {
  if (output === null || output === undefined) return { value: null }
  if (typeof output === 'object' && !Array.isArray(output)) return output as Record<string, unknown>
  return { value: output }
}

async function loadWorkflowForRun(
  deps: ExecutorDeps,
  run: WorkflowRunRecord,
): Promise<WorkflowRecord | null> {
  // The executor runs in a system context (poll worker, webhook receiver) —
  // for scheduled-trigger and wait-wakeup runs `run.triggeredBy` is null by
  // spec, so the RLS-gated `getById` has no per-user context. We previously
  // fell back to a zero UUID here, which matched no `workspace_members` row
  // and silently failed every scheduled run with `workflow_not_found` (see
  // migration 159 cutover postmortem — 100% of enabled recurring reminders
  // were dead for 2 days before this was caught).
  //
  // Workspace membership was already enforced when the trigger row was
  // provisioned (the scheduled-jobs creator was a workspace member; the
  // webhook receiver validates HMAC against `workflow.createdBy`). The
  // run carries the workspace_id needed for downstream authorization.
  return deps.workflowStore.findByIdSystem(run.workflowId)
}

/**
 * Dead-anchor circuit breaker: how many CONSECUTIVE runs must fail with
 * `page_anchor_not_found` before the workflow is auto-disabled. A deleted
 * anchor page is a permanent failure — without the breaker a scheduled
 * workflow burns a run every fire until a human notices (the incident shape:
 * hourly triggers failing for days). Re-pointing the anchor and re-enabling
 * the workflow is the recovery path, both in the builder.
 */
const DEAD_ANCHOR_DISABLE_STREAK = 3

/**
 * Auto-disable a workflow whose page anchor is gone. Called after
 * `markRunFailed` (so the current run counts toward the streak). Best-effort
 * throughout — a breaker error must never mask the original step failure.
 * Emits `workflow.auto_disabled` and, when the definition carries a
 * `deliver`-equipped step, pushes a plain-text notification to that channel.
 */
async function maybeDisableForDeadAnchor(
  deps: ExecutorDeps,
  run: WorkflowRunRecord,
  workflow: WorkflowRecord,
  primaryAssistantId: string,
  error: ExecutorError,
): Promise<void> {
  if (error.reason !== 'page_anchor_not_found') return
  try {
    const userId = run.triggeredBy ?? workflow.createdBy
    const recent = await deps.runStore.listRunsForWorkflow(userId, workflow.id, {
      limit: DEAD_ANCHOR_DISABLE_STREAK,
    })
    if (recent.length < DEAD_ANCHOR_DISABLE_STREAK) return
    const allDead = recent.every(
      (r) =>
        r.status === 'failed' &&
        (r.error as { reason?: unknown } | null)?.reason === 'page_anchor_not_found',
    )
    if (!allDead) return

    const updated = await deps.workflowStore.update(userId, workflow.id, { enabled: false })
    if (!updated) return

    fireAndForgetAudit(deps, {
      type: 'workflow.auto_disabled',
      workspaceId: run.workspaceId,
      actorUserId: null,
      runId: run.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      reason: 'page_anchor_not_found',
      streak: DEAD_ANCHOR_DISABLE_STREAK,
    })

    // Best-effort notify on the first deliver-carrying step's channel — the
    // only user-reachable push surface a workflow declares. No deliver step
    // = audit + the builder's enabled toggle are the signal.
    if (deps.deliverToChannel) {
      const deliverStep = workflow.definition.steps.find(
        (s): s is AssistantCallStep => s.type === 'assistant_call' && !!s.deliver,
      )
      if (deliverStep?.deliver) {
        try {
          await deps.deliverToChannel({
            workspaceId: run.workspaceId,
            assistantId: primaryAssistantId,
            userId,
            channelType: deliverStep.deliver.channelType,
            channelId: deliverStep.deliver.channelId,
            text:
              `Workflow "${workflow.name}" was disabled after ${DEAD_ANCHOR_DISABLE_STREAK} runs in a row failed: ` +
              `its page anchor points to a page that no longer exists. ` +
              `Re-pick the page in the workflow builder, then re-enable the workflow.`,
          })
        } catch (err) {
          console.warn('[workflow] dead-anchor disable notification failed:', err)
        }
      }
    }
  } catch (err) {
    // Never mask the original failure with a breaker error.
    console.warn('[workflow] dead-anchor auto-disable check failed:', err)
  }
}

async function markRunFailed(
  deps: ExecutorDeps,
  run: WorkflowRunRecord,
  stepId: string,
  error: ExecutorError,
  // A wall-clock abort terminates the run as `timeout` rather than `failed`,
  // so observability can tell "ran out of time" apart from "errored". Both
  // are terminal and both fire the same `run_failed` audit (a timeout still
  // counts toward the failure streak).
  status: 'failed' | 'timeout' = 'failed',
): Promise<void> {
  const now = new Date()
  await deps.runStore.updateRun(run.id, {
    status,
    finishedAt: now,
    currentStepId: stepId,
    error: error as unknown as Record<string, unknown>,
  })
  fireAndForgetAudit(deps, {
    type: 'workflow.run_failed',
    workspaceId: run.workspaceId,
    actorUserId: run.triggeredBy,
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: '<workflow>',
    stepId,
    error,
  })
}

function failOutcome(
  runId: string,
  stepId: string,
  error: ExecutorError,
  stepCount: number,
): RunOutcome {
  return { kind: 'failed', runId, stepId, error, stepCount }
}

function toExecutorError(value: unknown): ExecutorError | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.message !== 'string') return null
  return {
    message: v.message,
    reason: typeof v.reason === 'string' ? v.reason : undefined,
    detail: v.detail,
  }
}

function fireAndForgetAudit(deps: ExecutorDeps, event: WorkflowAuditEvent): void {
  if (!deps.emitAudit) return
  try {
    Promise.resolve(deps.emitAudit(event)).catch((err) => {
      console.warn(`[workflow] audit emit failed for ${event.type}:`, err)
    })
  } catch (err) {
    console.warn(`[workflow] audit emit threw for ${event.type}:`, err)
  }
}

function tryParseJson(s: string): unknown {
  if (!s || s[0] !== '{' && s[0] !== '[') return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function stringifyData(data: unknown): string {
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}
