/**
 * Chat tools for the workflow primitive.
 *
 * Seven tools:
 *   - proposeWorkflow   — validate a draft definition; return summary +
 *                         warnings. No DB writes. Confirmation step for
 *                         both create and edit.
 *   - createWorkflow    — persist a validated definition (new workflow).
 *   - updateWorkflow    — patch an existing workflow's definition / name /
 *                         description / enabled. Re-validates the definition.
 *   - getWorkflow       — full detail read (definition + metadata). The read
 *                         the model needs to edit a workflow; `listWorkflows`
 *                         is summary-only.
 *   - runWorkflow       — manual trigger. Returns terminal outcome (or
 *                         awaiting_wait when Phase B activates).
 *   - listWorkflows     — workspace-scoped list.
 *   - getWorkflowRun    — step trail + status for a run.
 *
 * Phase B adds `scheduleWorkflow`. Authoring stays the same; the scheduling
 * tool is registered alongside this set in `apps/api/src/index.ts` so the
 * model sees a coherent surface.
 *
 * [COMP:workflow/tools]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import {
  WorkflowDefinitionSchema,
  WorkflowTriggerSchema,
  STEP_TYPE_VALUES,
} from './schemas.js'
import type {
  AssistantCallStep,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
  WorkflowTrigger,
  WorkflowTriggerKind,
} from './types.js'
import {
  advanceWorkflowRun,
  type DeliverToChannel,
  type ExecutorDeps,
  type RunOutcome,
} from './executor.js'
import {
  clearWorkflowScheduleTriggers,
  syncWorkflowScheduleTrigger,
} from './scheduled-trigger.js'
import type { JobStore } from '../scheduling/types.js'
import { computeNextRun, type StructuredSchedule } from '../scheduling/schedule.js'
import { CRON_TURN_FRAMING } from './one-step.js'
import {
  coerceDeliverChannel,
  describeDelivery,
  formatRelativeTime,
  resolveDeliveryChannel,
  resolveTargetView,
  sendDeliveryConfirmation,
  type DeliveryTargetResolver,
  type ViewWorkspaceResolver,
} from '../scheduling/delivery-resolution.js'

/** Per-user cap on enabled recurring schedules — mirrors createScheduledJob. */
const MAX_ENABLED_RECURRING = 100

export type WorkflowToolEvent =
  | { type: 'workflow_created'; workflowId: string; name: string; userId: string; workspaceId: string }
  | { type: 'workflow_updated'; workflowId: string; name: string; userId: string; workspaceId: string }
  | { type: 'workflow_run_started'; runId: string; workflowId: string; trigger: WorkflowTriggerKind }

export type WorkflowToolDeps = {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  /** Executor-scoped deps; `runStore` and `workflowStore` are shared. */
  executorDeps: ExecutorDeps
  onEvent?: (event: WorkflowToolEvent) => void
  /**
   * Page-anchor authoring lookup — backs the `assistant_call.page`
   * existence + workspace checks in proposeWorkflow / createWorkflow /
   * updateWorkflow. Implemented over `savedViewStore.getById` (RLS-scoped
   * to the AUTHORING user). Absent (tests, minimal boots) = store-backed
   * checks are skipped; the runtime gate in the callee executor stays
   * authoritative.
   */
  resolvePageAnchor?: (
    userId: string,
    pageId: string,
  ) => Promise<{ workspaceId: string; state: 'draft' | 'saved'; name: string } | null>
  /**
   * The workflow's ACTUAL scheduled-trigger rows (any creator) — backs the
   * `triggerJobs` field on `getWorkflow` so drift between the
   * `workflows.trigger` column and reality is visible (the 2026-06-10
   * incident: trigger said "manual" while two hourly cron jobs fired).
   * Wired from `jobStore.listTriggerJobsForWorkflowSystem`; the tool
   * authorizes via the workspace-scoped workflow read before calling.
   * Absent (tests, minimal boots) → `triggerJobs` is omitted.
   */
  listTriggerJobs?: (workflowId: string) => Promise<
    Array<{
      id: string
      schedule: unknown
      timezone: string
      enabled: boolean
      nextRunAt: Date
      lastStatus: string | null
      userId: string
    }>
  >
  /**
   * Authoring-time tool-name check — `true` iff a name is a registered
   * built-in tool. Backs the `tool_call` warning that catches a hallucinated
   * tool name (e.g. `search`) before it fails the run with `tool_not_found`.
   * Wired from the live tool registry (`allTools.has`) so it also sees the
   * MCP gateway tools. A connector action is not in this set and surfaces a
   * (still-accurate) "ensure the connector is connected" hint. Absent (tests,
   * minimal boots) → the check is skipped.
   */
  isKnownTool?: (toolName: string) => boolean
  /**
   * Scheduling substrate — lets the authoring tools attach a schedule trigger
   * in one call (scheduling-authoring-unification). `jobStore` + `resolvePrimary`
   * back the workflow-trigger row; the delivery resolvers port the reminder
   * ergonomics (topic capture, confirmation ping, target label) onto the
   * workflow path. All optional: absent → a `schedule` trigger is rejected with
   * a clear message and the tools behave exactly as before.
   * See docs/plans/scheduling-authoring-unification.md.
   */
  jobStore?: JobStore
  resolvePrimary?: (workspaceId: string) => Promise<string | null>
  resolveDeliveryTarget?: DeliveryTargetResolver
  deliverToChannel?: DeliverToChannel
  resolveViewWorkspace?: ViewWorkspaceResolver
}

const idShape = z.string().uuid()

/**
 * Zod surface for an inline trigger on the authoring tools. Loosened to a
 * passthrough object so the tool accepts the discriminated union without
 * duplicating it; `WorkflowTriggerSchema` is the real validator applied in
 * `execute`. Optional — omit to leave the workflow `manual`.
 */
const triggerInputSchema = z
  .object({ kind: z.enum(['manual', 'schedule', 'webhook', 'event']) })
  .passthrough()
  .describe(
    'Optional trigger. `{ kind: "manual" }` (default) runs only on demand. ' +
      '`{ kind: "schedule", schedule: {type,...}, timezone?, mode?, delivery?: { channel }, policy?: { silentUntilFire?, nagIntervalMins?, nagUntilKeyword? } }` ' +
      'fires the workflow on a cadence in ONE call — scheduling is a workflow trigger, so no separate scheduling step or tool is needed. ' +
      'Set `delivery.channel` (telegram/slack/whatsapp) to push the result to the user; for a recurring reminder the exact chat + Telegram topic is captured automatically from the session. ' +
      'Use `policy` for "remind every N min until <keyword>" (nag) or silent-until-fire. ' +
      '`webhook` / `event` are configured in the web builder, not here.',
  )

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'Workflows require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to manage workflows.',
      isError: true,
    }
  }
  return null
}

/** Anchor suffix for step summaries — shows the bounded page intent. */
function pageAnchorSummary(page: NonNullable<Extract<WorkflowDefinition['steps'][number], { type: 'assistant_call' }>['page']>): string {
  if ('id' in page) return ` (edits page ${page.id})`
  if ('create' in page) return ` (creates page${page.title ? ` "${page.title}"` : ''})`
  return ` (edits page from step "${page.fromStep}")`
}

function summarize(def: WorkflowDefinition): string {
  const lines: string[] = []
  lines.push(`Start at "${def.startStepId}". ${def.steps.length} step${def.steps.length === 1 ? '' : 's'}.`)
  for (const step of def.steps) {
    let detail = ''
    switch (step.type) {
      case 'assistant_call':
        detail = `assistant_call → ${step.target.assistantId}${step.page ? pageAnchorSummary(step.page) : ''}`
        break
      case 'tool_call':
        detail = `tool_call → ${step.toolName}`
        break
      case 'wait':
        detail = step.until
          ? `wait ${JSON.stringify(step.until.duration)}`
          : `wait until ${step.at?.datetime}`
        break
      case 'branch':
        detail = `branch (true → ${step.nextStepIdIfTrue ?? '∅'}, false → ${step.nextStepIdIfFalse ?? '∅'})`
        break
    }
    lines.push(`  • ${step.id}: ${detail}`)
  }
  return lines.join('\n')
}

function warningsFor(
  def: WorkflowDefinition,
  opts: { phaseBActive: boolean; isKnownTool?: (name: string) => boolean },
): string[] {
  const warnings: string[] = []
  for (const step of def.steps) {
    // tool_call against a name that is not a registered built-in tool — the
    // `tool_not_found` / hallucinated-tool failure class (prod: `search`).
    // Skipped when the registry check is unavailable. A connector action is
    // not a built-in, so the message stays accurate for that case too.
    if (step.type === 'tool_call' && opts.isKnownTool && !opts.isKnownTool(step.toolName)) {
      warnings.push(
        `Step "${step.id}" calls tool "${step.toolName}", which is not a built-in tool. The run fails with \`tool_not_found\` unless it is a connector action whose connector is connected in this workspace. Built-in brain search is \`searchBrain\`; web search / fetch is \`mcp_search\`. Double-check the tool name.`,
      )
    }
    if (step.type === 'wait' && !opts.phaseBActive) {
      warnings.push(
        `Step "${step.id}" uses \`wait\`, which requires the schedule extension (Phase B). Authoring is allowed; runtime will fail until Phase B ships.`,
      )
    }
    if (step.type === 'assistant_call' && step.target.capabilityId) {
      warnings.push(
        `Step "${step.id}" sets \`capabilityId\` (restricted-mode A2A). Restricted mode is deferred — V1 supports free-mode only.`,
      )
    }
    // `web` is a pull surface, never a push target: the executor drops a
    // `web` delivery (typed `web_not_a_target`), so the step would silently
    // emit nothing. Steer the author to a messaging channel or a page anchor.
    if (step.type === 'assistant_call' && step.deliver?.channelType === 'web') {
      warnings.push(
        `Step "${step.id}" delivers to the \`web\` channel, which is not a push target — the message will not be sent anywhere. To surface output to the user, deliver to a messaging channel (telegram / slack / whatsapp), or write to a page via a \`page\` anchor.`,
      )
    }
    // Doc-work-without-anchor — the incident class behind "the workflow runs
    // but never updates the doc". Doc tools (`patchPage`, `createSubPage`, …)
    // are injected ONLY on a page-anchored step. A prompt that tells the
    // callee to edit a page in prose (naming a doc tool, or a page id buried
    // in the text) but carries no `page` anchor gives the callee no page tools
    // at all — every run silently no-ops. Flag it at authoring time.
    if (step.type === 'assistant_call' && !step.page) {
      const mentionsDocTool = DOC_AUTHORING_SIGNAL.test(step.prompt)
      const mentionsPageInProse = UUID_ANYWHERE.test(step.prompt) && /\bpage\b/i.test(step.prompt)
      if (mentionsDocTool || mentionsPageInProse) {
        warnings.push(
          `Step "${step.id}" asks the assistant to edit a doc page (it ${
            mentionsDocTool ? 'names a doc tool' : 'references a page id in the prompt'
          }) but the step has no \`page\` anchor. Doc tools are injected only on a page-anchored step, so the callee will have no page tools and the edit will silently do nothing on every run. Add a \`page\` anchor: \`{ id: "<page uuid>" }\` to edit an existing page, \`{ create: true }\` to make a fresh page each run, or \`{ fromStep: "<earlier step id>" }\` to reuse a page an earlier step created.`,
        )
      }
    }
  }
  return warnings
}

/** Doc-authoring tool names — naming one in a prompt with no `page` anchor is the no-op signal. */
const DOC_AUTHORING_SIGNAL =
  /\b(patchPage|createSubPage|renderPage|getCurrentPage|appendToPage|appendBlocks|createPage)\b/i

/** A UUID anywhere in free text (page id buried in prompt prose). */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * The doc-authoring tools `injectDocTools` gives an anchored callee. Used
 * only for the allow-list authoring warning below — if a step pins `tools`
 * without naming any of these while also carrying a page anchor, the
 * allow-list (applied AFTER doc injection) strips every doc tool and the
 * callee cannot edit its page.
 */
const DOC_TOOL_NAMES = ['getCurrentPage', 'patchPage', 'renderPage', 'createSubPage'] as const

/** Canonical UUID shape — distinguishes static page anchors from `{{...}}` template anchors. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Store-backed page-anchor checks (existence, workspace match, draft
 * warning, allow-list warning). Returns `path: message`-formatted errors
 * matching the zod-issue format the tools already emit. Skipped entirely
 * when the `resolvePageAnchor` dep is absent — the runtime gate in the
 * callee executor stays authoritative either way; this is the fail-at-
 * authoring-time layer (the incident class: page references that fail on
 * every run).
 */
async function pageAnchorIssues(
  def: WorkflowDefinition,
  ctx: { userId: string; workspaceId: string },
  resolve: WorkflowToolDeps['resolvePageAnchor'],
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [i, step] of def.steps.entries()) {
    if (step.type !== 'assistant_call' || !step.page) continue

    // Allow-list composition warning — pure, runs even without the resolver.
    if (step.tools && !step.tools.some((t) => (DOC_TOOL_NAMES as readonly string[]).includes(t))) {
      warnings.push(
        `Step "${step.id}" has a page anchor but its \`tools\` allow-list names no doc tool (${DOC_TOOL_NAMES.join(', ')}). The allow-list is applied after doc-tool injection, so the callee will not be able to edit the page. Add the doc tools you want or drop the allow-list.`,
      )
    }

    // A whole-string `{{vars/input}}` anchor (Phase B) resolves at run time —
    // existence cannot be checked at authoring. Surface a heads-up instead.
    const templateAnchor =
      'id' in step.page && !UUID_SHAPE.test(step.page.id) ? step.page.id : null
    if (templateAnchor) {
      warnings.push(
        `Step "${step.id}" anchors page ${templateAnchor}, resolved at run time. The run fails with invalid_page_anchor if the variable does not hold a page UUID.`,
      )
    }

    if (!resolve) continue
    const checks: Array<{ pathTail: string; id: string; role: 'anchor' | 'parent' }> = []
    if ('id' in step.page && !templateAnchor) {
      checks.push({ pathTail: 'id', id: step.page.id, role: 'anchor' })
    }
    if ('create' in step.page && step.page.nestUnder) {
      checks.push({ pathTail: 'nestUnder', id: step.page.nestUnder, role: 'parent' })
    }
    for (const check of checks) {
      const page = await resolve(ctx.userId, check.id)
      if (!page || page.workspaceId !== ctx.workspaceId) {
        errors.push(
          `steps.${i}.page.${check.pathTail}: page not found in this workspace. Pick an existing page (the id must be a page in the same workspace as the workflow).`,
        )
      } else if (check.role === 'anchor' && page.state === 'draft') {
        warnings.push(
          `Step "${step.id}" anchors the draft page "${page.name}". Drafts auto-prune in 30 days unless saved — save the page to keep this step stable.`,
        )
      }
    }
  }
  return { errors, warnings }
}

function compactStepRun(row: WorkflowStepRunRecord): {
  stepId: string
  type: string
  status: string
  durationMs: number | null
  error: Record<string, unknown> | null
} {
  return {
    stepId: row.stepId,
    type: row.stepType,
    status: row.status,
    durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    error: row.error,
  }
}

function summarizeRun(workflow: WorkflowRecord, outcome: RunOutcome): string {
  if (outcome.kind === 'completed') {
    return `Run completed: "${workflow.name}" — ${outcome.stepCount} step${outcome.stepCount === 1 ? '' : 's'}.`
  }
  if (outcome.kind === 'failed') {
    return `Run failed at step "${outcome.stepId}": ${outcome.error.message}`
  }
  return `Run paused at step "${outcome.stepId}" (${outcome.reason}).`
}

// ── Schedule-trigger helpers (scheduling-authoring-unification) ───────────

type ScheduleTrigger = Extract<WorkflowTrigger, { kind: 'schedule' }>

/**
 * The first static `{ id }` page anchor in the definition — the page a
 * doc-maintaining scheduled workflow keeps. Used to derive the `view_id`
 * badge link when the author didn't pass one explicitly. Template `{{...}}`
 * anchors resolve at run time and are skipped here.
 */
function staticPageAnchorId(def: WorkflowDefinition): string | null {
  for (const s of def.steps) {
    if (s.type === 'assistant_call' && s.page && 'id' in s.page && UUID_SHAPE.test(s.page.id)) {
      return s.page.id
    }
  }
  return null
}

/**
 * Stamp a resolved delivery target onto the workflow's terminal (last-by-order,
 * or sole) `assistant_call` step — the step whose output the user receives.
 * Turns the schedule trigger's type-only `delivery` sugar into the concrete
 * `assistant_call.deliver` the executor reads. Returns a NEW definition (no
 * mutation); `null` when there is no assistant_call step to deliver from.
 */
function stampTerminalDeliver(
  def: WorkflowDefinition,
  deliver: { channelType: 'telegram' | 'slack' | 'whatsapp'; channelId: string },
): WorkflowDefinition | null {
  let idx = -1
  for (let i = def.steps.length - 1; i >= 0; i--) {
    if (def.steps[i].type === 'assistant_call') {
      idx = i
      break
    }
  }
  if (idx === -1) return null
  const steps = def.steps.map((s, i) => (i === idx ? { ...(s as AssistantCallStep), deliver } : s))
  return { ...def, steps }
}

/**
 * The terminal `assistant_call`'s prompt is the closest analogue to a
 * reminder's free-text instructions (informational + search-matchable on the
 * trigger row). The CRON framing prefix is stripped so search text stays clean.
 */
function deriveReminderInstructions(def: WorkflowDefinition): string {
  for (let i = def.steps.length - 1; i >= 0; i--) {
    const s = def.steps[i]
    if (s.type === 'assistant_call') {
      return s.prompt.startsWith(CRON_TURN_FRAMING)
        ? s.prompt.slice(CRON_TURN_FRAMING.length).trim()
        : s.prompt
    }
  }
  return ''
}

/** Authoring warnings specific to a schedule trigger's delivery sugar. */
function triggerWarnings(def: WorkflowDefinition, trigger?: WorkflowTrigger): string[] {
  const warnings: string[] = []
  if (trigger?.kind !== 'schedule' || !trigger.delivery) return warnings
  const calls = def.steps.filter((s): s is AssistantCallStep => s.type === 'assistant_call')
  if (calls.length === 0) {
    warnings.push(
      `The schedule trigger delivers to "${trigger.delivery.channel}", but the workflow has no assistant_call step to deliver from. Add one, or drop trigger.delivery.`,
    )
  } else if (calls.length > 1) {
    warnings.push(
      `The schedule trigger's delivery ("${trigger.delivery.channel}") will be applied to the LAST assistant_call step ("${calls[calls.length - 1].id}"). For a multi-step workflow, prefer setting \`deliver\` on the specific step you want to push from.`,
    )
  }
  return warnings
}

type ScheduleApplyResult = {
  nextRun: string
  relativeTime?: string
  deliveryChannel?: string
  deliveryTarget?: { channelType: string; label: string; topicId?: number }
  confirmationSent?: boolean
  targetViewId: string | null
  timezone: string
}

/**
 * Create the firing `scheduled_jobs` row for a workflow's schedule trigger.
 * Three shapes, by delivery intent:
 *   - `trigger.delivery` set → a private REMINDER row (channelType=messaging);
 *     the deliver was already stamped onto the terminal step before persist.
 *   - else a resolvable doc page → a private doc-maintaining reminder row
 *     (channelType='doc'); the page is the surface, no channel push.
 *   - else → a workspace-visible WORKFLOW-TRIGGER row via the shared lockstep
 *     helper (the team-automation path).
 * The reminder rows reuse the exact delivery-resolution module createScheduledJob
 * uses, so the deprecated alias's behavior is preserved byte-for-byte.
 * See docs/plans/scheduling-authoring-unification.md §3, §5.
 */
async function applyScheduleTrigger(
  deps: WorkflowToolDeps,
  context: ToolContext,
  workflowId: string,
  definition: WorkflowDefinition,
  trigger: ScheduleTrigger,
  targetViewId: string | null | undefined,
): Promise<ScheduleApplyResult | { error: string }> {
  if (!deps.jobStore) return { error: 'Scheduling is not available in this context.' }
  const timezone = trigger.timezone ?? context.userTimezone ?? 'UTC'
  const schedule = trigger.schedule as StructuredSchedule
  const nextRunAt = computeNextRun(schedule, timezone)
  const policy = trigger.policy

  const viewId = await resolveTargetView(
    deps.resolveViewWorkspace,
    targetViewId ?? context.docViewId ?? staticPageAnchorId(definition),
    context,
  )

  const explicit = trigger.delivery?.channel
  if (explicit) {
    // REMINDER row (private) — deliver to a messaging channel.
    const { channelType, channelId } = resolveDeliveryChannel(context, explicit)
    await deps.jobStore.create({
      assistantId: context.assistantId,
      userId: context.userId,
      schedule,
      timezone,
      mode: trigger.mode ?? 'local',
      instructions: deriveReminderInstructions(definition),
      channelType,
      channelId,
      nextRunAt,
      silentUntilFire: policy?.silentUntilFire,
      nagIntervalMins: policy?.nagIntervalMins ?? null,
      nagUntilKeyword: policy?.nagUntilKeyword ?? null,
      workflowId,
      viewId,
    })
    const delivery = await describeDelivery(deps.resolveDeliveryTarget, {
      assistantId: context.assistantId,
      channelType,
      channelId,
    })
    const confirmationSent = await sendDeliveryConfirmation(deps.deliverToChannel, {
      workspaceId: context.workspaceId,
      assistantId: context.assistantId,
      userId: context.userId,
      channelType,
      channelId,
      nextRunAt,
      label: delivery.deliveryTarget?.label,
    })
    return {
      nextRun: nextRunAt.toISOString(),
      ...formatRelativeTime(nextRunAt),
      ...delivery,
      confirmationSent,
      targetViewId: viewId,
      timezone,
    }
  }

  if (viewId) {
    // Doc-maintaining reminder row (private; the page is the output surface).
    await deps.jobStore.create({
      assistantId: context.assistantId,
      userId: context.userId,
      schedule,
      timezone,
      mode: trigger.mode ?? 'local',
      instructions: deriveReminderInstructions(definition),
      channelType: 'doc',
      channelId: viewId,
      nextRunAt,
      silentUntilFire: policy?.silentUntilFire,
      nagIntervalMins: policy?.nagIntervalMins ?? null,
      nagUntilKeyword: policy?.nagUntilKeyword ?? null,
      workflowId,
      viewId,
    })
    return { nextRun: nextRunAt.toISOString(), ...formatRelativeTime(nextRunAt), targetViewId: viewId, timezone }
  }

  // WORKFLOW-TRIGGER row (workspace-visible) — the team-automation path.
  if (!deps.resolvePrimary) return { error: 'Scheduling is not available in this context.' }
  const synced = await syncWorkflowScheduleTrigger(
    { jobStore: deps.jobStore, resolvePrimary: deps.resolvePrimary },
    {
      workflowId,
      workspaceId: context.workspaceId!,
      userId: context.userId,
      schedule,
      timezone,
      mode: trigger.mode,
      silentUntilFire: policy?.silentUntilFire,
      nagIntervalMins: policy?.nagIntervalMins ?? null,
      nagUntilKeyword: policy?.nagUntilKeyword ?? null,
      viewId,
    },
  )
  if ('error' in synced) return { error: synced.error }
  return { nextRun: synced.nextRunAt.toISOString(), ...formatRelativeTime(synced.nextRunAt), targetViewId: viewId, timezone }
}

/**
 * Enforce the per-user enabled-recurring cap before a recurring schedule
 * trigger creates a row — mirrors createScheduledJob. Returns an error string
 * when over cap (checked before workflow persist so a capped user never orphans
 * a workflow row).
 */
async function recurringCapError(deps: WorkflowToolDeps, userId: string, trigger?: WorkflowTrigger): Promise<string | null> {
  if (trigger?.kind !== 'schedule' || trigger.schedule.type === 'once' || !deps.jobStore) return null
  const enabled = await deps.jobStore.countEnabledRecurring(userId)
  if (enabled >= MAX_ENABLED_RECURRING) {
    return `You have reached the cap of ${MAX_ENABLED_RECURRING} active recurring schedules. Use listWorkflows to find scheduled workflows and disable or delete unused ones first (updateWorkflow with { enabled: false }).`
  }
  return null
}

export function createWorkflowTools(deps: WorkflowToolDeps): {
  proposeWorkflow: Tool
  createWorkflow: Tool
  updateWorkflow: Tool
  getWorkflow: Tool
  runWorkflow: Tool
  listWorkflows: Tool
  getWorkflowRun: Tool
} {
  const phaseBActive = deps.executorDeps.pauseRunForWait !== undefined

  const proposeWorkflow = buildTool({
    name: 'proposeWorkflow',
    description:
      `Propose a workflow definition for the user to approve. Validates the draft against the schema and returns a summary the user can read. ` +
      `No database writes. After this returns, present the proposal to the user verbatim and ask for explicit confirmation ("yes / create it / go ahead") before calling \`createWorkflow\`. ` +
      `Step types (V1): assistant_call (free-mode A2A), tool_call (first-party + MCP allow-policy), wait (Phase B only), branch (JSONLogic condition). ` +
      `Use \`storeOutputAs\` on a step to make its output available as \`{{vars.<name>}}\` in later steps. Use \`{{input.<name>}}\` to reference the trigger payload. ` +
      `\n\nPage editing: when a step should edit or produce a doc page, set the step's \`page\` field — NEVER just mention a page id in the prompt (the callee gets no page tools that way and the step fails on every run). ` +
      `Variants: \`page: {"id": "<page uuid>"}\` edits an existing page; \`page: {"create": true, "title": "...", "nestUnder": "<page uuid>"}\` creates a saved page each run and anchors the step to it (title may use {{vars}}/{{input}}); \`page: {"fromStep": "<stepId>"}\` edits the page an earlier create-step made this run. ` +
      `The callee then runs with the doc tools (getCurrentPage / patchPage / renderPage) against that page.`,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe('Human-readable name. Shown in audit, listings, and approval prompts.'),
      description: z.string().max(2000).optional(),
      definition: z
        .object({
          startStepId: z.string(),
          steps: z.array(z.unknown()),
        })
        .passthrough()
        .describe('Workflow DAG. See proposeWorkflow tool docs for the schema.'),
      trigger: triggerInputSchema.optional(),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const parsed = WorkflowDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) {
        return {
          data: {
            ok: false,
            errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            stepTypes: STEP_TYPE_VALUES,
          },
          isError: true,
        }
      }

      const definition = parsed.data

      // Validate the optional inline trigger against the canonical schema.
      let trigger: WorkflowTrigger | undefined
      if (input.trigger) {
        const t = WorkflowTriggerSchema.safeParse(input.trigger)
        if (!t.success) {
          return {
            data: {
              ok: false,
              errors: t.error.issues.map((i) => `trigger.${i.path.join('.')}: ${i.message}`),
              stepTypes: STEP_TYPE_VALUES,
            },
            isError: true,
          }
        }
        trigger = t.data
      }

      // Store-backed page-anchor checks — fail the proposal on a dangling
      // anchor instead of authoring a workflow that fails 100% of its runs.
      const anchorIssues = await pageAnchorIssues(
        definition,
        { userId: context.userId, workspaceId: context.workspaceId! },
        deps.resolvePageAnchor,
      )
      if (anchorIssues.errors.length > 0) {
        return {
          data: { ok: false, errors: anchorIssues.errors, stepTypes: STEP_TYPE_VALUES },
          isError: true,
        }
      }

      return {
        data: {
          ok: true,
          proposedName: input.name,
          proposedDescription: input.description ?? null,
          proposedTrigger: trigger ?? null,
          summary: summarize(definition),
          warnings: [
            ...warningsFor(definition, { phaseBActive, isKnownTool: deps.isKnownTool }),
            ...anchorIssues.warnings,
            ...triggerWarnings(definition, trigger),
          ],
          definition,
          confirmationHint:
            'Show the user this proposal (and the trigger / schedule) and the warnings. Ask for explicit confirmation. Only call createWorkflow after they agree.',
        },
      }
    },
  })

  const createWorkflow = buildTool({
    name: 'createWorkflow',
    description:
      `Persist a workflow definition that the user has explicitly approved. ` +
      `You MUST first call \`proposeWorkflow\`, present the proposal verbatim, get the user's explicit OK ("yes", "create it", "go ahead"), and only then call \`createWorkflow\`. Never call this tool from a fresh user description without proposing first. ` +
      `\n\nScheduling is built in: pass \`trigger: { kind: "schedule", schedule, ... }\` to create AND schedule in one call — there is no separate scheduling step. A one-step assistant_call workflow with \`trigger.delivery\` IS a reminder ("remind me at 2pm"); a multi-step workflow is an automation. Confirm the schedule with the user first (mention the returned relativeTime / deliveryTarget so timezone or destination mistakes are caught).`,
    inputSchema: z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).optional(),
      definition: z
        .object({
          startStepId: z.string(),
          steps: z.array(z.unknown()),
        })
        .passthrough(),
      trigger: triggerInputSchema.optional(),
      targetViewId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Doc page (saved-view UUID) a scheduled workflow maintains, so that page shows a "scheduled" badge. Usually omit — when scheduling from inside a page it is captured automatically, or derived from a step\'s page anchor.',
        ),
    }),
    requiresConfirmation: false,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const parsed = WorkflowDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) {
        return {
          data: {
            ok: false,
            errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          },
          isError: true,
        }
      }

      // Validate the optional inline trigger.
      let trigger: WorkflowTrigger | undefined
      if (input.trigger) {
        const t = WorkflowTriggerSchema.safeParse(input.trigger)
        if (!t.success) {
          return {
            data: { ok: false, errors: t.error.issues.map((i) => `trigger.${i.path.join('.')}: ${i.message}`) },
            isError: true,
          }
        }
        trigger = t.data
        if (trigger.kind === 'schedule' && !deps.jobStore) {
          return { data: 'Scheduling is not available in this context.', isError: true }
        }
      }

      // Same anchor checks as proposeWorkflow — createWorkflow can be called
      // with an edited definition, so it cannot rely on the propose pass.
      const anchorIssues = await pageAnchorIssues(
        parsed.data,
        { userId: context.userId, workspaceId: context.workspaceId! },
        deps.resolvePageAnchor,
      )
      if (anchorIssues.errors.length > 0) {
        return { data: { ok: false, errors: anchorIssues.errors }, isError: true }
      }

      // Cap check BEFORE persist so a capped user never orphans a workflow row.
      const capError = await recurringCapError(deps, context.userId, trigger)
      if (capError) return { data: capError, isError: true }

      // Schedule trigger with messaging delivery → stamp the resolved chat /
      // topic onto the terminal assistant_call step before persist (the
      // executor reads `assistant_call.deliver`, not the trigger).
      let definition: WorkflowDefinition = parsed.data
      if (trigger?.kind === 'schedule' && trigger.delivery) {
        const { channelId } = resolveDeliveryChannel(context, trigger.delivery.channel)
        const stamped = stampTerminalDeliver(definition, { channelType: trigger.delivery.channel, channelId })
        if (!stamped) {
          return {
            data: {
              ok: false,
              errors: [
                'trigger.delivery is set but the workflow has no assistant_call step to deliver from. Add one, or remove trigger.delivery.',
              ],
            },
            isError: true,
          }
        }
        definition = stamped
      }

      const record = await deps.workflowStore.create({
        userId: context.userId,
        workspaceId: context.workspaceId!,
        name: input.name,
        description: input.description ?? null,
        definition,
        trigger,
      })

      deps.onEvent?.({
        type: 'workflow_created',
        workflowId: record.id,
        name: record.name,
        userId: context.userId,
        workspaceId: context.workspaceId!,
      })

      // Attach the firing schedule row (+ delivery / policy / doc link).
      let schedule: ScheduleApplyResult | undefined
      let scheduleError: string | undefined
      if (trigger?.kind === 'schedule') {
        const res = await applyScheduleTrigger(deps, context, record.id, definition, trigger, input.targetViewId)
        if ('error' in res) scheduleError = res.error
        else schedule = res
      }

      return {
        data: {
          id: record.id,
          name: record.name,
          stepCount: record.definition.steps.length,
          createdAt: record.createdAt.toISOString(),
          triggerKind: record.trigger.kind,
          ...(schedule ?? {}),
          ...(scheduleError ? { scheduleError } : {}),
        },
      }
    },
  })

  const updateWorkflow = buildTool({
    name: 'updateWorkflow',
    description:
      `Edit an existing workflow — add a step, remove a step, reorder steps, rewrite a step's fields, OR change its trigger / schedule. Patches any subset of name / description / definition / enabled / trigger. ` +
      `Pass \`trigger: { kind: "schedule", schedule, ... }\` to (re)schedule the workflow, or \`{ kind: "manual" }\` to unschedule it. (Webhook secret lifecycle + event sources are still edited in the web builder.) ` +
      `Workflow: first call \`getWorkflow\` to read the current definition, construct the edited definition, then call \`proposeWorkflow\` to validate + preview it, present the change to the user, get explicit confirmation ("yes", "go ahead"), and only then call \`updateWorkflow\`. Never edit a definition you have not read with \`getWorkflow\` first. ` +
      `Editing does not affect runs already in flight — the change applies to the next run.`,
    inputSchema: z.object({
      workflowId: idShape,
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).nullable().optional(),
      definition: z
        .object({
          startStepId: z.string(),
          steps: z.array(z.unknown()),
        })
        .passthrough()
        .optional()
        .describe('Full replacement DAG. Omit to leave the steps unchanged. See proposeWorkflow tool docs for the schema.'),
      enabled: z.boolean().optional().describe('Disable (false) or re-enable (true) the workflow.'),
      trigger: triggerInputSchema.optional(),
      targetViewId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe('Repoint (UUID) or clear (null) the doc page a scheduled workflow maintains. Omit to leave unchanged.'),
    }),
    requiresConfirmation: false,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const existing = await deps.workflowStore.getById(context.userId, input.workflowId)
      if (!existing || existing.workspaceId !== context.workspaceId) {
        return { data: `Workflow ${input.workflowId} not found in workspace.`, isError: true }
      }

      // Validate the optional trigger up front (before any write).
      let trigger: WorkflowTrigger | undefined
      if (input.trigger) {
        const t = WorkflowTriggerSchema.safeParse(input.trigger)
        if (!t.success) {
          return { data: { ok: false, errors: t.error.issues.map((i) => `trigger.${i.path.join('.')}: ${i.message}`) }, isError: true }
        }
        trigger = t.data
        if (!deps.jobStore) {
          return { data: 'Scheduling is not available in this context.', isError: true }
        }
      }

      const fields: Parameters<WorkflowStore['update']>[2] = {}
      if (input.name !== undefined) {
        fields.name = input.name
        // A user-initiated rename pins the title so the auto-titler stops
        // touching it — mirrors the REST PATCH path (mig 202).
        fields.nameManuallySet = true
      }
      if (input.description !== undefined) fields.description = input.description
      if (input.enabled !== undefined) fields.enabled = input.enabled

      if (input.definition !== undefined) {
        const parsed = WorkflowDefinitionSchema.safeParse(input.definition)
        if (!parsed.success) {
          return {
            data: {
              ok: false,
              errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            },
            isError: true,
          }
        }
        const anchorIssues = await pageAnchorIssues(
          parsed.data,
          { userId: context.userId, workspaceId: context.workspaceId! },
          deps.resolvePageAnchor,
        )
        if (anchorIssues.errors.length > 0) {
          return { data: { ok: false, errors: anchorIssues.errors }, isError: true }
        }
        fields.definition = parsed.data
      }

      // Schedule trigger with messaging delivery → stamp the resolved chat /
      // topic onto the terminal assistant_call step (the executor reads
      // `assistant_call.deliver`). Operates on the new definition if one is
      // being set, else the existing one.
      if (trigger?.kind === 'schedule' && trigger.delivery) {
        const base = fields.definition ?? existing.definition
        const { channelId } = resolveDeliveryChannel(context, trigger.delivery.channel)
        const stamped = stampTerminalDeliver(base, { channelType: trigger.delivery.channel, channelId })
        if (!stamped) {
          return {
            data: { ok: false, errors: ['trigger.delivery is set but the workflow has no assistant_call step to deliver from.'] },
            isError: true,
          }
        }
        fields.definition = stamped
      }

      // Mirror the trigger column so the builder renders reality.
      if (trigger !== undefined) fields.trigger = trigger

      if (Object.keys(fields).length === 0) {
        return { data: 'Nothing to update — pass at least one of name / description / definition / enabled / trigger.', isError: true }
      }

      const updated = await deps.workflowStore.update(context.userId, input.workflowId, fields)
      if (!updated) {
        return { data: `Workflow ${input.workflowId} not found in workspace.`, isError: true }
      }

      // Reconcile the firing scheduled_jobs row with the new trigger.
      let schedule: { nextRun: string; relativeTime?: string } | undefined
      let scheduleError: string | undefined
      if (trigger !== undefined && deps.jobStore) {
        if (trigger.kind === 'schedule') {
          if (!deps.resolvePrimary) {
            scheduleError = 'Scheduling is not available in this context.'
          } else if (
            // A reminder fires from a messaging/doc-channel row the sync helper
            // does not own (it manages only `channel_type='workflow'` rows). It
            // counts as a reminder if the new trigger delivers, or the existing
            // workflow already did. Reconcile by clearing EVERY firing row for
            // this workflow, then re-applying via applyScheduleTrigger — the
            // same proven create path (delivery resolution + ping + label) that
            // builds the correct row shape. This converges to exactly one firing
            // row with no double delivery. (scheduling-authoring-unification §3.)
            !!trigger.delivery ||
            (existing.trigger.kind === 'schedule' && !!existing.trigger.delivery)
          ) {
            const firing = await deps.jobStore.listFiringJobsForWorkflowSystem(updated.id)
            for (const row of firing) await deps.jobStore.delete(row.id).catch(() => {})
            const applied = await applyScheduleTrigger(
              deps,
              context,
              updated.id,
              fields.definition ?? existing.definition,
              trigger,
              input.targetViewId,
            )
            if ('error' in applied) scheduleError = applied.error
            else schedule = { nextRun: applied.nextRun, relativeTime: applied.relativeTime }
          } else {
            const timezone = trigger.timezone ?? context.userTimezone ?? 'UTC'
            const viewIdToSet =
              input.targetViewId !== undefined
                ? await resolveTargetView(deps.resolveViewWorkspace, input.targetViewId, context)
                : undefined
            const synced = await syncWorkflowScheduleTrigger(
              { jobStore: deps.jobStore, resolvePrimary: deps.resolvePrimary },
              {
                workflowId: updated.id,
                workspaceId: context.workspaceId!,
                userId: context.userId,
                schedule: trigger.schedule as StructuredSchedule,
                timezone,
                mode: trigger.mode,
                silentUntilFire: trigger.policy?.silentUntilFire,
                nagIntervalMins: trigger.policy?.nagIntervalMins ?? null,
                nagUntilKeyword: trigger.policy?.nagUntilKeyword ?? null,
                viewId: viewIdToSet,
              },
            )
            if ('error' in synced) scheduleError = synced.error
            else schedule = { nextRun: synced.nextRunAt.toISOString(), ...formatRelativeTime(synced.nextRunAt) }
          }
        } else {
          // Trigger left `schedule` (manual / webhook / event) → stop firing.
          await clearWorkflowScheduleTriggers({ jobStore: deps.jobStore }, updated.id)
        }
      }

      deps.onEvent?.({
        type: 'workflow_updated',
        workflowId: updated.id,
        name: updated.name,
        userId: context.userId,
        workspaceId: context.workspaceId!,
      })

      return {
        data: {
          id: updated.id,
          name: updated.name,
          enabled: updated.enabled,
          triggerKind: updated.trigger.kind,
          stepCount: updated.definition.steps.length,
          summary: summarize(updated.definition),
          updatedAt: updated.updatedAt.toISOString(),
          ...(schedule ?? {}),
          ...(scheduleError ? { scheduleError } : {}),
        },
      }
    },
  })

  const getWorkflow = buildTool({
    name: 'getWorkflow',
    description:
      'Read one workflow in full — its name, description, enabled state, trigger kind, the complete definition (every step + startStepId), and `triggerJobs`: the ACTUAL scheduled-trigger rows firing it (any member\'s, with ownedByMe). If triggerJobs disagrees with triggerKind (e.g. kind "manual" but enabled cron rows listed), the firing rows are the truth — fix the mismatch with `updateWorkflow` (set the correct `trigger`, or `{ enabled: false }` to stop). Use this before editing a workflow with `updateWorkflow`; `listWorkflows` returns summaries (with each trigger). Webhook secrets are never returned.',
    inputSchema: z.object({
      workflowId: idShape,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const workflow = await deps.workflowStore.getById(context.userId, input.workflowId)
      if (!workflow || workflow.workspaceId !== context.workspaceId) {
        return { data: `Workflow ${input.workflowId} not found in workspace.`, isError: true }
      }

      // The ACTUAL scheduled-trigger rows, any creator — `workflows.trigger`
      // is a display column and can drift from reality (the 2026-06-10
      // incident: "manual" while two hourly cron jobs fired). The
      // workspace-scoped getById above is the membership proof for the
      // system-level job read.
      const triggerJobs = deps.listTriggerJobs
        ? (await deps.listTriggerJobs(workflow.id)).map((j) => ({
            id: j.id,
            schedule: j.schedule,
            timezone: j.timezone,
            enabled: j.enabled,
            nextRun: j.nextRunAt.toISOString(),
            lastStatus: j.lastStatus,
            ownedByMe: j.userId === context.userId,
          }))
        : undefined

      return {
        data: {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          enabled: workflow.enabled,
          triggerKind: workflow.trigger.kind,
          // Reality check: manage these with updateScheduledJob /
          // deleteScheduledJob; a mismatch with triggerKind means the
          // display trigger drifted from the firing rows.
          ...(triggerJobs ? { triggerJobs } : {}),
          stepCount: workflow.definition.steps.length,
          summary: summarize(workflow.definition),
          definition: workflow.definition,
          createdAt: workflow.createdAt.toISOString(),
          updatedAt: workflow.updatedAt.toISOString(),
        },
      }
    },
  })

  const runWorkflow = buildTool({
    name: 'runWorkflow',
    description:
      `Manually run a workflow. Returns the terminal outcome (completed / failed / paused) along with step trail summary. ` +
      `Use this when the user says "run my X workflow now". For recurring runs, pass a schedule \`trigger\` to \`createWorkflow\` / \`updateWorkflow\` instead.`,
    inputSchema: z.object({
      workflowId: idShape,
      input: z.record(z.unknown()).optional().describe('Optional trigger payload, accessible to steps as `{{input.X}}`.'),
    }),
    timeoutMs: 90_000,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const workflow = await deps.workflowStore.getById(context.userId, input.workflowId)
      if (!workflow || workflow.workspaceId !== context.workspaceId) {
        return { data: `Workflow ${input.workflowId} not found in workspace.`, isError: true }
      }
      if (!workflow.enabled) {
        return { data: `Workflow "${workflow.name}" is disabled.`, isError: true }
      }

      const run = await deps.runStore.createRun({
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        triggeredBy: context.userId,
        triggerKind: 'manual',
        input: input.input,
      })

      deps.onEvent?.({
        type: 'workflow_run_started',
        runId: run.id,
        workflowId: workflow.id,
        trigger: 'manual',
      })

      const outcome = await advanceWorkflowRun(deps.executorDeps, run.id)

      // Surface step trail for transparency.
      const steps = await deps.runStore.listStepRuns(context.userId, run.id)

      return {
        data: {
          runId: outcome.runId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: outcomeStatus(outcome),
          summary: summarizeRun(workflow, outcome),
          stepCount: outcome.kind === 'completed' || outcome.kind === 'failed' ? outcome.stepCount : steps.length,
          finalOutput: outcome.kind === 'completed' ? outcome.finalOutput ?? null : null,
          error: outcome.kind === 'failed' ? outcome.error : null,
          paused: outcome.kind === 'paused' ? { stepId: outcome.stepId, reason: outcome.reason } : null,
          steps: steps.map(compactStepRun),
        },
        isError: outcome.kind === 'failed',
      }
    },
  })

  const listWorkflows = buildTool({
    name: 'listWorkflows',
    description:
      'List workflows in the current workspace with each one\'s trigger and enabled state. Scheduling is a workflow trigger - there is no separate "scheduled job" - so this is also how you find scheduled/recurring work: a `schedule`-kind trigger shows its cadence (so a runaway or mis-scheduled workflow is identifiable here). To reschedule, change cadence/policy, or STOP a schedule, call `updateWorkflow` (set `trigger`, or `{ enabled: false }`); to see the actual firing-trigger rows for one workflow, call `getWorkflow`.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(_input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rows = await deps.workflowStore.list(context.userId, context.workspaceId!)
      if (rows.length === 0) return { data: 'No workflows in this workspace yet.' }

      return {
        data: rows.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          enabled: w.enabled,
          stepCount: w.definition.steps.length,
          // Trigger summary so this list doubles as the scheduled-workflow
          // finder (scheduling is a trigger, not a separate concept). A
          // `schedule` trigger surfaces its cadence so the model can spot /
          // manage recurring work without a separate scheduled-job reader.
          triggerKind: w.trigger.kind,
          ...(w.trigger.kind === 'schedule'
            ? { schedule: w.trigger.schedule, timezone: w.trigger.timezone ?? null }
            : {}),
          createdAt: w.createdAt.toISOString(),
        })),
      }
    },
  })

  const getWorkflowRun = buildTool({
    name: 'getWorkflowRun',
    description:
      'Inspect a workflow run — current status, step trail, and any error. Use when the user asks "what happened with my X workflow?".',
    inputSchema: z.object({
      runId: idShape,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const run = await deps.runStore.getRunById(context.userId, input.runId)
      if (!run || run.workspaceId !== context.workspaceId) {
        return { data: `Run ${input.runId} not found in workspace.`, isError: true }
      }
      const workflow = await deps.workflowStore.getById(context.userId, run.workflowId)
      const steps = await deps.runStore.listStepRuns(context.userId, run.id)

      return {
        data: {
          id: run.id,
          workflowId: run.workflowId,
          workflowName: workflow?.name ?? null,
          status: run.status,
          triggerKind: run.triggerKind,
          currentStepId: run.currentStepId,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          error: run.error,
          steps: steps.map(compactStepRun),
        },
      }
    },
  })

  return { proposeWorkflow, createWorkflow, updateWorkflow, getWorkflow, runWorkflow, listWorkflows, getWorkflowRun }
}

function outcomeStatus(o: RunOutcome): string {
  if (o.kind === 'completed') return 'completed'
  if (o.kind === 'failed') return 'failed'
  return o.reason === 'wait' ? 'awaiting_wait' : 'awaiting_input'
}
