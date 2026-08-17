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
import { createHash, timingSafeEqual } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import {
  WorkflowDefinitionSchema,
  WorkflowTriggerSchema,
  STEP_TYPE_VALUES,
  WORKFLOW_TRIGGER_KINDS,
  WORKFLOW_EVENT_SOURCE_TYPES,
} from './schemas.js'
import { TASK_LIFECYCLE_ACTIONS } from './task-event-trigger.js'
import { KNOWLEDGE_LIFECYCLE_ACTIONS } from './knowledge-event-trigger.js'
import { parallelRegionSteps } from './graph.js'
import { stepAdvisories } from './advisories.js'
import { RESERVED_OUTCOME_VAR_NAMES } from './types.js'
import type {
  AssistantCallStep,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
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
import { loadBuiltinSkills } from '../skills/loader.js'

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
   * Workspace-skill listing for the `assistant_call` skill-attachment checks
   * in proposeWorkflow / createWorkflow / updateWorkflow (`skillAttachmentIssues`):
   * a dangling attached slug is an error; a workspace skill named in prompt
   * prose but not attached is a warning. Implemented over
   * `skillStore.listForWorkspace` (RLS-scoped to the AUTHORING user). Absent
   * (tests, minimal boots) = store-backed checks are skipped; the callee's
   * runtime governance gate stays authoritative. See
   * docs/architecture/features/workflow.md → "assistant_call skills".
   */
  listAuthorableSkills?: (
    userId: string,
    workspaceId: string,
  ) => Promise<Array<{ slug: string; name: string }>>
  /**
   * The workflow's ACTUAL firing rows (any creator, any channel) — backs the
   * `triggerJobs` field on `getWorkflow` so drift between the
   * `workflows.trigger` column and reality is visible (the 2026-06-10
   * incident: trigger said "manual" while two hourly cron jobs fired).
   * Wired from `jobStore.listFiringJobsForWorkflowSystem`; the tool
   * authorizes via the workspace-scoped workflow read before calling.
   * Absent (tests, minimal boots) → `triggerJobs` is omitted.
   *
   * Channel-blind on purpose: a delivery-backed reminder fires from a row
   * carrying its messaging channel, and surfacing only `channel_type='workflow'`
   * rows here hid a duplicate 09:00 row on the one screen opened to find it
   * (2026-08-08).
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
   * Authoring-time exact lookup against the scoped runtime registry. Unlike
   * `isKnownTool`, this resolves connected custom HTTP/CLI tools for the
   * workflow's workspace and acting assistant.
   */
  resolveKnownWorkflowTools?: (args: {
    userId: string
    workspaceId: string
    assistantId: string
    toolNames: string[]
  }) => Promise<string[]>
  /**
   * Scheduling substrate — lets the authoring tools attach a schedule trigger
   * in one call (scheduling-authoring-unification). `jobStore` + `resolvePrimary`
   * back the workflow-trigger row; the delivery resolvers port the reminder
   * ergonomics (topic capture, confirmation ping, target label) onto the
   * workflow path. All optional: absent → a `schedule` trigger is rejected with
   * a clear message and the tools behave exactly as before.
   * See docs/architecture/features/workflow.md.
   */
  jobStore?: JobStore
  resolvePrimary?: (workspaceId: string) => Promise<string | null>
  resolveDeliveryTarget?: DeliveryTargetResolver
  deliverToChannel?: DeliverToChannel
  resolveViewWorkspace?: ViewWorkspaceResolver
  /**
   * Authoring-time delivery-target reachability check (the `channel_not_found`
   * incident). For a step's resolved `(channelType, channelId)` it confirms the
   * target is actually postable — Slack: the BYO bot's token is valid AND the
   * channel resolves via `conversations.info` (a non-Slack session stamping a
   * web/Telegram session id as the Slack channel is the exact failure mode).
   * Returns `{ ok:false, reason }` so the authoring tools block create/update
   * instead of persisting a workflow whose every fire silently fails delivery.
   * Absent (tests, minimal boots) → the check is skipped and the executor's
   * best-effort soft-fail stays the only guard. See
   * docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
   */
  validateDeliveryTarget?: (args: {
    workspaceId?: string
    assistantId: string
    channelType: 'telegram' | 'slack' | 'whatsapp'
    channelId: string
    channelIntegrationId?: string
  }) => Promise<{ ok: boolean; reason?: string }>
  /**
   * Authoring-time connector preflight (the GitHub `Bad credentials` incident).
   * Given a tool name a step references (`tool_call.toolName` or an
   * `assistant_call.tools[]` entry), resolves the owning built-in connector and
   * probes its credentials with one cheap authenticated call. Returns `null`
   * when the name is NOT a built-in connector tool (a first-party / brain tool —
   * nothing to preflight), else `{ ok, provider, reason, policy }`. `ok:false`
   * blocks authoring so a workflow can't be created against a connector that is
   * disconnected or whose token is revoked/expired. `policy` is the tool's
   * effective allow/ask/block policy (registry default tightened by the user's
   * L1/L2 rows, resolved against `assistantId` when given): an `ask`/`block`
   * tool pinned on an `assistant_call` step blocks authoring too — the callee
   * surface drops non-`allow` tools at run time, so the step as authored can
   * never execute it (a `tool_call` step, which pauses in the unified
   * Approvals queue, is the approved path). Absent → skipped. See
   * docs/architecture/features/workflow.md → "Authoring validation".
   */
  preflightConnectorTool?: (args: {
    userId: string
    toolName: string
    assistantId?: string
    /**
     * The workspace/team id the workflow is authored in, so the credential
     * probe resolves team-native + team-grant sources the same way the runtime
     * does (not just the per-user store). Absent → per-user only.
     */
    workspaceId?: string | null
  }) => Promise<{
    ok: boolean
    provider: string
    reason?: string
    policy?: 'allow' | 'ask' | 'block'
  } | null>
  /**
   * Authoring-time Slack channel discovery — backs the `listSlackChannels`
   * tool so the model can target a real Slack channel id (`C…`/`G…`) from any
   * session (including web/Telegram) instead of guessing, then set it on the
   * step's `deliver.channelId`. With no `channelId`, enumerates the BYO bot's
   * channels via Slack `conversations.list`; with a concrete id, performs the
   * authoritative `conversations.info` lookup so browse-list absence is never
   * confused with lack of access. Absent (tests, minimal boots) → the tool
   * reports that discovery is unavailable. See docs/architecture/features/workflow.md.
   */
  listSlackChannels?: (args: { assistantId: string; channelId?: string }) => Promise<
    | { ok: true; channels: Array<{ id: string; name: string; isMember: boolean }> }
    | { ok: false; reason: string }
  >
  /**
   * Authoring-time Slack member discovery — backs the `listSlackMembers`
   * tool so the model can embed real `<@U…>` mention ids in step prompts /
   * message text. Slack only notifies on real member ids; without a
   * directory the model improvises broken forms (`<@handle>`, plain
   * `@name`) that render as text and ping nobody (the mis-tagged standup
   * incident). Enumerates via Slack `users.list` (BYO token, `users:read`).
   * Absent (tests, minimal boots) → the tool reports discovery unavailable.
   */
  listSlackMembers?: (args: { assistantId: string }) => Promise<
    | { ok: true; members: Array<{ id: string; handle: string; displayName: string; realName: string }> }
    | { ok: false; reason: string }
  >
  /** Internal/test escape hatch. Production authoring must consume a proposal receipt. */
  allowLegacyDirectWrites?: boolean
}

const idShape = z.string().uuid()

/**
 * `getWorkflowRun`'s `runId` — DELIBERATELY not `idShape`. The interface
 * (`run-history.tsx`, the run-detail header) only ever shows an 8-character
 * prefix, never a full UUID, so a strict-UUID schema made the id the user
 * can actually see structurally invalid input. use-brian#278: the model
 * worked around that by zero-padding a short id into a fake UUID
 * (`090aa843` → `090aa843-0000-0000-0000-000000000000`), which the store
 * then correctly failed to find — silently turning "I cannot resolve this"
 * into "this run does not exist", a false claim about the user's own data.
 *
 * No `.min()` here: the "too short to resolve" rejection is a friendly,
 * explicit tool error from `resolveRunId` (see below), not a raw zod
 * validation failure — mirrors how `getMemory` / `saveMemory` accept a bare
 * `z.string()` id/prefix and resolve it in `execute()`.
 */
const runIdShape = z
  .string()
  .describe(
    'The run identifier: the full UUID, OR an identifier prefix of at least 8 characters — exactly what the interface shows under each run. ' +
      'Pass it VERBATIM, exactly as the interface displayed it or the user typed it. NEVER pad, truncate-then-extend, or invent characters to force it into a full UUID shape: a fabricated id resolves to nothing, and this tool cannot tell "you made this up" apart from "the run does not exist" — so a made-up id becomes a false claim about the user\'s data. ' +
      'If the id is too short, ambiguous, or does not resolve, this tool says so explicitly in its own words; trust that message over guessing the rest of the id yourself.',
  )

/** Minimum characters to attempt prefix resolution — matches exactly what
 *  the interface renders (`run.id.slice(0, 8)`). Shorter input is rejected
 *  outright rather than attempted, so a stray one- or two-character token
 *  can never scan the run table (use-brian#278). */
const RUN_ID_PREFIX_MIN_LEN = 8

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The only characters a UUID prefix can contain. Guards the store's
 *  `LIKE $1 || '%'` from wildcard injection — `%` and `_` are LIKE
 *  metacharacters, so an unvalidated prefix is a pattern rather than a
 *  prefix. See the rejection branch in `resolveRunId`. */
const RUN_ID_PREFIX_RE = /^[0-9a-f-]+$/i

/** Default bound on `getWorkflow`'s `recentRuns` — enough to answer "how did
 *  the last few runs go?" without flooding context with full history (the
 *  step trail stays behind `getWorkflowRun`, which has no such cap). */
const RECENT_RUNS_DEFAULT_LIMIT = 10

/**
 * Zod surface for an inline trigger on the authoring tools. Loosened to a
 * passthrough object so the tool accepts the discriminated union without
 * duplicating it (the query-loop converter would flatten the union's variants
 * into one merged object for Gemini anyway); `WorkflowTriggerSchema` is the
 * real validator applied in `execute`. Optional — omit to leave the workflow
 * `manual`.
 *
 * The description is the model's ALWAYS-ON knowledge of the trigger surface,
 * so it must be complete, closed-world, and true to what `execute` accepts —
 * the 2026-07 "Task Created event must be configured in the web builder"
 * hallucination was this text asserting event triggers were web-only while
 * the server accepted them here. Kind and source-type lists interpolate the
 * compile-time-checked constants from `schemas.ts`; never hand-write them.
 */
export const TRIGGER_INPUT_DESCRIPTION =
  `Optional trigger. The ONLY trigger kinds that exist: ${WORKFLOW_TRIGGER_KINDS.join(' | ')}. ` +
  `If the user asks to trigger on anything outside these kinds (and, for events, outside the source types below), that capability does not exist — say so plainly instead of improvising. Omit for manual (run on demand). ` +
  `\n- \`{ kind: "schedule", schedule: {type: "daily"|"weekly"|"monthly"|"once"|"cron", ...}, timezone?, mode?, delivery?: { channel: "telegram"|"slack"|"whatsapp" }, policy?: { silentUntilFire?, nagIntervalMins?, nagUntilKeyword? } }\` ` +
  `fires on a cadence in ONE call — scheduling is a workflow trigger, so no separate scheduling step or tool is needed. \`delivery.channel\` pushes the result to the user (for a recurring reminder the exact chat + Telegram topic are captured automatically from this session); \`policy\` covers "remind every N min until <keyword>" and silent-until-fire. ` +
  `\n- \`{ kind: "event", event: { sources: [{ source, match? }, ...] } }\` fires from a workspace signal and IS fully authorable here. The ONLY source types: ${WORKFLOW_EVENT_SOURCE_TYPES.join(' | ')}. ` +
  `Shapes: \`{ type: "connector", connectorInstanceId, provider }\` (a CONNECTED connector instance), \`{ type: "channel", channelIntegrationId, channel }\` (a connected chat integration; get channelIntegrationId from listChannels.integrationId, never listChannels.id), \`{ type: "page", pageId }\` (a doc page + its direct children), \`{ type: "task" }\` (the workspace's tasks — id-less), \`{ type: "knowledge" }\` (the workspace's knowledge base — id-less). ` +
  `\`match\` narrows firing: keywords / fromActors / inChannels / mentions / tags (task and knowledge events only) / fromBots (default false — bot- or assistant-authored events only fire with \`fromBots: true\`). ` +
  `Task lifecycle actions are matched via \`match.inChannels\`: ${TASK_LIFECYCLE_ACTIONS.join(' / ')}. Knowledge lifecycle actions, same axis: ${KNOWLEDGE_LIFECYCLE_ACTIONS.join(' / ')} — for knowledge, \`keywords\` matches the entry TITLE and \`tags\` its frontmatter tags; there is no path filter, so scope by path with a \`branch\` step on \`{{input.event.path}}\`. A connector/channel source id that does not reference a live connected source never fires — verify it is connected first. ` +
  `Each entry nests the source under a \`source\` key — e.g. a task tagged 'triage' is \`{ source: { type: "task" }, match: { inChannels: ["tagged"], tags: ["triage"] } }\` (do NOT flatten \`type\` to the entry top level). ` +
  `\n- \`{ kind: "webhook", match?: { condition } }\` fires from an external signed POST. The kind can be set here, but the webhook URL slug + signing secret are provisioned in the web builder — tell the user the workflow cannot receive deliveries until they complete that step there.`

const triggerInputSchema = z
  .object({ kind: z.enum(WORKFLOW_TRIGGER_KINDS) })
  .passthrough()
  .describe(TRIGGER_INPUT_DESCRIPTION)

/**
 * Pointer variant for `createWorkflow` / `updateWorkflow` — same accepted
 * shape, but the full contract text lives once, on `proposeWorkflow` (the
 * mandated first call), mirroring how `definition` docs work ("See
 * proposeWorkflow tool docs for the schema"). Embedding the full text on all
 * three tools tripled its per-turn token cost for no information gain
 * (`prompt-token-cost.test.ts` is the budget).
 */
const triggerInputSchemaRef = z
  .object({ kind: z.enum(WORKFLOW_TRIGGER_KINDS) })
  .passthrough()
  .describe(
    `Optional trigger — same contract as proposeWorkflow's \`trigger\` parameter (see it for the full shapes, event sources, and task actions). ` +
      `The ONLY kinds: ${WORKFLOW_TRIGGER_KINDS.join(' | ')}; anything else does not exist. All kinds are authorable here; only webhook slug/secret provisioning happens in the web builder.`,
  )

const PROPOSAL_RECEIPT_PREFIX = 'wf1'
const PROPOSAL_RECEIPT_MAX_CHARS = 500_000
const PROPOSAL_RECEIPT_MAX_JSON_BYTES = 1_000_000
const workflowTriggerReceiptSchema = WorkflowTriggerSchema as z.ZodType<WorkflowTrigger>

const createProposalInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  definition: WorkflowDefinitionSchema,
  trigger: workflowTriggerReceiptSchema.optional(),
  targetViewId: z.string().uuid().optional(),
})

const updateProposalInputSchema = z.object({
  workflowId: idShape,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  definition: WorkflowDefinitionSchema.optional(),
  enabled: z.boolean().optional(),
  trigger: workflowTriggerReceiptSchema.optional(),
  targetViewId: z.string().uuid().nullable().optional(),
})

const workflowProposalReceiptSchema = z.discriminatedUnion('action', [
  z.object({ version: z.literal(1), action: z.literal('create'), input: createProposalInputSchema }),
  z.object({ version: z.literal(1), action: z.literal('update'), input: updateProposalInputSchema }),
])

type WorkflowProposalReceipt = z.infer<typeof workflowProposalReceiptSchema>

/** Recover the latest proposal unless a later successful workflow write consumed it. */
export function latestWorkflowProposalReceipt(messages: readonly { content: unknown }[]): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const content = messages[messageIndex]?.content
    if (!Array.isArray(content)) continue
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = content[blockIndex]
      if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result') continue
      const result = block as { name?: unknown; content?: unknown; isError?: unknown }
      if (result.isError === true) continue
      if (result.name === 'createWorkflow' || result.name === 'updateWorkflow') return undefined
      if (result.name !== 'proposeWorkflow' || typeof result.content !== 'string') continue
      try {
        const parsed = JSON.parse(result.content) as { proposalReceipt?: unknown }
        return typeof parsed.proposalReceipt === 'string' ? parsed.proposalReceipt : undefined
      } catch {
        // Oversized tool results may be capped after the receipt field, leaving
        // invalid trailing JSON. The receipt alphabet needs no JSON escapes, so
        // recover that first field without accepting arbitrary prose.
        const match = result.content.match(/"proposalReceipt":"(wf1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/)
        return match?.[1]
      }
    }
  }
  return undefined
}

function encodeProposalReceipt(receipt: WorkflowProposalReceipt): string {
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(receipt), 'utf8'))
  const body = compressed.toString('base64url')
  const checksum = createHash('sha256').update(compressed).digest('base64url')
  return `${PROPOSAL_RECEIPT_PREFIX}.${body}.${checksum}`
}

function decodeProposalReceipt(value: string):
  | { ok: true; receipt: WorkflowProposalReceipt }
  | { ok: false; error: string } {
  if (value.length > PROPOSAL_RECEIPT_MAX_CHARS) {
    return { ok: false, error: 'The workflow proposal receipt is too large. Re-propose the workflow.' }
  }
  const [prefix, body, checksum, extra] = value.split('.')
  if (prefix !== PROPOSAL_RECEIPT_PREFIX || !body || !checksum || extra !== undefined) {
    return { ok: false, error: 'The workflow proposal receipt is malformed. Re-propose the workflow.' }
  }
  try {
    const compressed = Buffer.from(body, 'base64url')
    const expected = Buffer.from(createHash('sha256').update(compressed).digest('base64url'))
    const received = Buffer.from(checksum)
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return { ok: false, error: 'The workflow proposal receipt changed after validation. Re-propose the workflow.' }
    }
    const json = inflateRawSync(compressed, { maxOutputLength: PROPOSAL_RECEIPT_MAX_JSON_BYTES }).toString('utf8')
    const parsed = workflowProposalReceiptSchema.safeParse(JSON.parse(json))
    if (!parsed.success) {
      return { ok: false, error: 'The workflow proposal receipt is invalid. Re-propose the workflow.' }
    }
    return { ok: true, receipt: parsed.data }
  } catch {
    return { ok: false, error: 'The workflow proposal receipt could not be read. Re-propose the workflow.' }
  }
}

const proposalReceiptInput = z
  .string()
  .max(PROPOSAL_RECEIPT_MAX_CHARS)
  .describe('Opaque receipt returned by the successful proposeWorkflow call. Copy it exactly; do not reconstruct workflow fields.')

const receiptWriteInputSchema = z.object({ proposalReceipt: proposalReceiptInput })

const legacyCreateWorkflowInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  definition: z
    .object({
      startStepId: z.union([z.string(), z.array(z.string())]),
      steps: z.array(z.unknown()),
    })
    .passthrough(),
  trigger: triggerInputSchemaRef.optional(),
  targetViewId: z.string().uuid().optional(),
})

const legacyUpdateWorkflowInputSchema = z.object({
  workflowId: idShape,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  definition: z
    .object({
      startStepId: z.union([z.string(), z.array(z.string())]),
      steps: z.array(z.unknown()),
    })
    .passthrough()
    .optional(),
  enabled: z.boolean().optional(),
  trigger: triggerInputSchemaRef.optional(),
  targetViewId: z.string().uuid().nullable().optional(),
})

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
  // A trigger fan-out's parallelism is the summary's most important fact —
  // the user must see that several entry steps start at once.
  const starts = Array.isArray(def.startStepId) ? def.startStepId : [def.startStepId]
  const startLine =
    starts.length > 1
      ? `Start IN PARALLEL at ${starts.map((s) => `"${s}"`).join(', ')}`
      : `Start at "${starts[0]}"`
  lines.push(`${startLine}. ${def.steps.length} step${def.steps.length === 1 ? '' : 's'}.`)
  for (const step of def.steps) {
    let detail = ''
    switch (step.type) {
      case 'assistant_call':
        detail = `assistant_call → ${step.target.assistantId}${step.page ? pageAnchorSummary(step.page) : ''}`
        if (step.deliver && 'replyToTrigger' in step.deliver) {
          detail += ' (replies to the originating WhatsApp conversation)'
        }
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
    // A fan-out step's parallelism is the summary's most important fact —
    // the user must see that these branches run at the same time.
    if (step.type !== 'branch' && Array.isArray(step.nextStepId) && step.nextStepId.length > 1) {
      detail += ` (then IN PARALLEL: ${step.nextStepId.join(', ')})`
    }
    lines.push(`  • ${step.id}: ${detail}`)
  }
  return lines.join('\n')
}

function warningsFor(
  def: WorkflowDefinition,
  opts: {
    phaseBActive: boolean
    isKnownTool?: (name: string) => boolean
    runtimeKnownToolNames?: ReadonlySet<string>
  },
): string[] {
  const warnings: string[] = []
  for (const step of def.steps) {
    // tool_call against a name that is not a registered built-in tool — the
    // `tool_not_found` / hallucinated-tool failure class (prod: `search`).
    // Skipped when the registry check is unavailable. A connector action is
    // not a built-in, so the message stays accurate for that case too.
    if (
      step.type === 'tool_call'
      && opts.isKnownTool
      && !opts.isKnownTool(step.toolName)
      && !opts.runtimeKnownToolNames?.has(step.toolName)
    ) {
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
    // Blueprint binding vs `tools` allow-list — the allow-list is applied
    // AFTER the record tools are injected, so a list that omits
    // `saveBlueprintRecord` strips the very tool the binding directs the
    // callee to use. The runtime enforcement then cannot demand the save
    // (it never fails a step for a tool the callee didn't have), so the
    // binding silently degrades to unbound output. Flag it at authoring time.
    if (
      step.type === 'assistant_call' &&
      step.blueprintId &&
      step.tools &&
      !step.tools.includes('saveBlueprintRecord')
    ) {
      warnings.push(
        `Step "${step.id}" binds blueprint "${step.blueprintId}" but its \`tools\` allow-list omits \`saveBlueprintRecord\`. The allow-list is applied after the record tools are injected, so the callee cannot save the blueprint record and the binding silently produces no typed output. Add "saveBlueprintRecord" to the list or drop the allow-list.`,
      )
    }
    // Slack mentions without member ids — the mis-tagged standup incident.
    // Slack only notifies via `<@MEMBER_ID>`; a prompt that asks the callee
    // to tag/mention people without providing real ids makes the model
    // improvise (`<@handle>`, plain `@name`) and nobody gets pinged. The
    // send-time resolver rewrites what it can, but ids in the prompt are the
    // reliable path — steer the author to `listSlackMembers`.
    if (
      step.type === 'assistant_call' &&
      step.deliver?.channelType === 'slack' &&
      (SLACK_MENTION_ASK.test(step.prompt) || PLAIN_AT_NAME.test(step.prompt)) &&
      !SLACK_MENTION_ID.test(step.prompt)
    ) {
      warnings.push(
        `Step "${step.id}" delivers to Slack and asks to mention people, but the prompt contains no real member id. Slack only notifies via \`<@MEMBER_ID>\` syntax — call \`listSlackMembers\`, then embed the exact ids in the step prompt (e.g. \`<@U0123ABCD>\`); plain \`@name\` renders as text and pings nobody.`,
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

async function runtimeKnownToolNames(
  def: WorkflowDefinition,
  context: ToolContext,
  deps: Pick<WorkflowToolDeps, 'isKnownTool' | 'resolveKnownWorkflowTools' | 'resolvePrimary'>,
): Promise<Set<string>> {
  if (!context.workspaceId || !deps.resolveKnownWorkflowTools || !deps.resolvePrimary) {
    return new Set()
  }
  const toolNames = [...new Set(def.steps.flatMap((step) => (
    step.type === 'tool_call'
    && (!deps.isKnownTool || !deps.isKnownTool(step.toolName))
      ? [step.toolName]
      : []
  )))]
  if (toolNames.length === 0) return new Set()

  try {
    const assistantId = await deps.resolvePrimary(context.workspaceId)
    if (!assistantId) return new Set()
    return new Set(await deps.resolveKnownWorkflowTools({
      userId: context.userId,
      workspaceId: context.workspaceId,
      assistantId,
      toolNames,
    }))
  } catch (err) {
    console.warn('[workflow/tools] runtime tool-name lookup threw:', err)
    return new Set()
  }
}

/** "Tag/mention someone" intent in a Slack-delivering step's prompt. */
const SLACK_MENTION_ASK = /\b(mention|tag(?:ging)?|ping|notify)\b/i

/** A plain `@name` token (whitespace-preceded, so emails don't match). */
const PLAIN_AT_NAME = /(^|\s)@[A-Za-z0-9][A-Za-z0-9._-]*/

/** A real Slack member-id mention already present in the prompt. */
const SLACK_MENTION_ID = /<@[UW][A-Z0-9]{2,}>/

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

/** A saved-skill reference in prompt prose — the bare-word fallback signal. */
const SKILL_PROSE_SIGNAL = /\bskill\b/i

/**
 * `assistant_call` skill-attachment checks. A workflow callee has NO skill
 * surface unless the step attaches one (`skills` = offered via `useSkill`,
 * `enforcedSkills` = injected as mandatory instructions), so a skill named
 * only in prompt prose silently degrades on every run — the 2026-07-07
 * fls.com.hk Middle Mile incident, and the exact skills-shaped analog of the
 * doc-work-without-anchor class. Mirrors `pageAnchorIssues`:
 *
 *  - **error** — an attached slug that is neither a workspace skill slug nor
 *    a built-in skill id (it can never load; the callee would skip it).
 *    Needs the `listAuthorableSkills` dep; skipped without it.
 *  - **warning** — a workspace skill whose slug or (multi-word) name appears
 *    in the prompt while the step attaches nothing matching it. Dep-backed.
 *  - **warning** — the prompt says "skill" but both lists are empty and the
 *    store-backed match found nothing (paraphrased / nonexistent skill, or
 *    minimal boots with no dep). Pure fallback.
 *
 * See docs/architecture/features/workflow.md → "assistant_call skills".
 */
async function skillAttachmentIssues(
  def: WorkflowDefinition,
  ctx: { userId: string; workspaceId: string },
  list: WorkflowToolDeps['listAuthorableSkills'],
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []
  const steps = def.steps
    .map((step, i) => ({ step, i }))
    .filter((s): s is { step: AssistantCallStep; i: number } => s.step.type === 'assistant_call')
  if (steps.length === 0) return { errors, warnings }

  let workspaceSkills: Array<{ slug: string; name: string }> | null = null
  if (list) {
    try {
      workspaceSkills = await list(ctx.userId, ctx.workspaceId)
    } catch (err) {
      // A store blip never blocks authoring — the runtime gate stays authoritative.
      console.warn('[workflow/skillAttachmentIssues] skill listing threw:', err)
    }
  }
  const knownSlugs = new Set<string>()
  if (workspaceSkills) {
    for (const s of workspaceSkills) knownSlugs.add(s.slug.toLowerCase())
    for (const s of loadBuiltinSkills()) knownSlugs.add(s.id.toLowerCase())
  }

  for (const { step, i } of steps) {
    const attached = [...(step.skills ?? []), ...(step.enforcedSkills ?? [])]
    const attachedLower = new Set(attached.map((s) => s.toLowerCase()))

    // Dangling attached slug — can never load; reject at authoring time.
    if (workspaceSkills) {
      for (const [field, slugs] of [
        ['skills', step.skills],
        ['enforcedSkills', step.enforcedSkills],
      ] as const) {
        for (const slug of slugs ?? []) {
          if (!knownSlugs.has(slug.toLowerCase())) {
            errors.push(
              `steps.${i}.${field}: skill "${slug}" not found — it is neither a workspace skill slug nor a built-in skill id, so the callee would skip it on every run. Use the exact slug of an existing skill.`,
            )
          }
        }
      }
    }

    // Workspace skill referenced in prose but not attached. Slugs match on a
    // word boundary; names only when multi-word (single common words would
    // false-positive ordinary prose).
    let proseMatched = false
    if (workspaceSkills) {
      const prompt = step.prompt.toLowerCase()
      for (const s of workspaceSkills) {
        if (attachedLower.has(s.slug.toLowerCase())) continue
        const slugHit = new RegExp(`\\b${escapeRegExp(s.slug)}\\b`, 'i').test(step.prompt)
        const nameHit = s.name.trim().includes(' ') && prompt.includes(s.name.trim().toLowerCase())
        if (slugHit || nameHit) {
          proseMatched = true
          warnings.push(
            `Step "${step.id}" mentions the skill "${s.name}" in its prompt but does not attach it. A workflow callee has no skill surface unless the step attaches one, so the reference silently does nothing at run time. Add "${s.slug}" to the step's \`enforcedSkills\` (always applied — the usual choice for workflows) or \`skills\` (offered via useSkill, the callee chooses); if the mention is incidental, reword the prompt.`,
          )
        }
      }
    }

    // Bare "skill" mention with nothing attached — the pure fallback.
    if (!proseMatched && attached.length === 0 && SKILL_PROSE_SIGNAL.test(step.prompt)) {
      const available = workspaceSkills?.slice(0, 8).map((s) => s.slug)
      warnings.push(
        `Step "${step.id}" tells the callee to use a skill but attaches none (\`skills\` / \`enforcedSkills\` are empty) — skills named only in prompt prose are invisible to the callee. Attach the skill's slug to \`enforcedSkills\` (always applied) or \`skills\` (offered), or reword the prompt if no saved skill is meant.${
          available?.length ? ` Workspace skills: ${available.join(', ')}.` : ''
        }`,
      )
    }
  }
  return { errors, warnings }
}

/** Escape a literal for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Connector names that, when a step pulls data from them without a pinned
 * tool, are the fix-D footgun: an `assistant_call` that fetches connector data
 * but lets the model choose tools on the fly will, when the connector errors,
 * fabricate a result from memory/training instead of failing (the GitHub
 * `Bad credentials` → hallucinated summary incident). Paired with a fetch verb
 * to keep the heuristic tight.
 */
const CONNECTOR_DATA_KEYWORD =
  /\b(github|gmail|notion|fathom|(google\s*)?(calendar|drive|docs|sheets|slides)|gcal|gdrive)\b/i
const FETCH_VERB = /\b(summari[sz]|fetch|pull|retriev|gather|list|report on|review|digest|recap|scan)\b/i

/** The terminal (last-by-order, or sole) `assistant_call` step id — where a
 *  schedule trigger's `delivery` sugar gets stamped. `null` when none. */
function terminalAssistantCallId(def: WorkflowDefinition): string | null {
  for (let i = def.steps.length - 1; i >= 0; i--) {
    if (def.steps[i].type === 'assistant_call') return def.steps[i].id
  }
  return null
}

/**
 * External-dependency authoring checks: delivery-target reachability (fix A)
 * and connector preflight (fix B), plus the fix-D "connector data fetched on
 * the fly" warning. Mirrors `pageAnchorIssues` — errors block create/update;
 * warnings surface for the author to resolve. Network validators are injected
 * (ports) and skipped when absent, so tests / minimal boots are unaffected and
 * the runtime guards stay authoritative.
 */
async function dependencyIssues(
  def: WorkflowDefinition,
  trigger: WorkflowTrigger | undefined,
  context: ToolContext,
  deps: Pick<WorkflowToolDeps, 'validateDeliveryTarget' | 'preflightConnectorTool' | 'resolvePageAnchor' | 'resolvePrimary'>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []

  const triggerReplySteps = def.steps.filter(
    (step): step is AssistantCallStep =>
      step.type === 'assistant_call'
      && !!step.deliver
      && 'replyToTrigger' in step.deliver,
  )
  if (triggerReplySteps.length > 0) {
    const sources = trigger?.kind === 'event' ? trigger.event.sources : []
    const allSourcesAreWhatsApp = sources.length > 0 && sources.every(
      (subscription) =>
        subscription.source.type === 'channel'
        && subscription.source.channel === 'whatsapp',
    )
    if (!allSourcesAreWhatsApp) {
      for (const step of triggerReplySteps) {
        errors.push(
          `Step "${step.id}" uses replyToTrigger, which requires an event trigger containing only WhatsApp channel sources. Use the selected channel's integrationId as source.channelIntegrationId; do not author a recipient phone number.`,
        )
      }
    }
  }

  // ── A. Delivery-target reachability ──────────────────────────────────────
  if (deps.validateDeliveryTarget) {
    const targets: Array<{
      stepId: string
      assistantTarget: AssistantCallStep['target']['assistantId']
      channelType: 'telegram' | 'slack' | 'whatsapp'
      channelId: string
      channelIntegrationId?: string
    }> = []
    for (const step of def.steps) {
      if (
        step.type === 'assistant_call' &&
        step.deliver &&
        'channelId' in step.deliver &&
        step.deliver.channelType !== 'web' &&
        // Teams targets have no channel-enumeration API to preflight against
        // (the listTeamsChannels equivalent is a P5 follow-up), so they skip
        // reachability validation — the send simply attempts at run time.
        step.deliver.channelType !== 'msteams'
      ) {
        targets.push({
          stepId: step.id,
          assistantTarget: step.target.assistantId,
          channelType: step.deliver.channelType,
          channelId: step.deliver.channelId,
          channelIntegrationId: step.deliver.channelIntegrationId,
        })
      }
    }
    // The schedule trigger's `delivery` sugar is stamped onto the terminal
    // assistant_call step at persist time. An explicit `deliver.channelId` on
    // that step WINS (already collected + validated by the step loop above);
    // otherwise resolve it from the session NOW so a cross-type request can't
    // persist a bogus channel id that fails `channel_not_found` on every fire.
    if (trigger?.kind === 'schedule' && trigger.delivery) {
      const channel = trigger.delivery.channel
      const termId = terminalAssistantCallId(def)
      const termStep = termId ? def.steps.find((step) => step.id === termId) : undefined
      if (termStep?.type === 'assistant_call' && !terminalExplicitDeliverId(def, channel)) {
        const resolved = resolveDeliveryChannel(context, channel)
        if (!resolved.channelId) {
          errors.push(unresolvedDeliveryError(channel))
        } else if (resolved.channelType !== 'web') {
          targets.push({
            stepId: termStep.id,
            assistantTarget: termStep.target.assistantId,
            channelType: resolved.channelType as 'telegram' | 'slack' | 'whatsapp',
            channelId: resolved.channelId,
          })
        }
      }
    }
    let primaryAssistantId: string | null | undefined
    for (const t of targets) {
      try {
        // Channel credentials belong to the assistant that will execute and
        // deliver this step, not the assistant hosting the authoring chat.
        // Resolve the durable `primary` sentinel the same way the executor and
        // REST authoring path do. If the resolver is unwired, skip the probe:
        // substituting the chat assistant would recreate the Product → Brian
        // false rejection from production.
        if (t.assistantTarget === 'primary' && primaryAssistantId === undefined) {
          primaryAssistantId = context.workspaceId && deps.resolvePrimary
            ? await deps.resolvePrimary(context.workspaceId)
            : null
        }
        const assistantId = t.assistantTarget === 'primary' ? primaryAssistantId : t.assistantTarget
        if (!assistantId) continue
        const res = await deps.validateDeliveryTarget({
          workspaceId: context.workspaceId ?? undefined,
          assistantId,
          channelType: t.channelType,
          channelId: t.channelId,
          channelIntegrationId: t.channelIntegrationId,
        })
        if (!res.ok) {
          const guidance = t.channelType === 'slack'
            ? ' Call `listSlackChannels` to get a real channel id and set it on the terminal step\'s `deliver` as `{ "channelType": "slack", "channelId": "<id>" }` (the internal id from `listChannels` is not a Slack channel id). Or author the workflow from inside the Slack channel you want the result posted to.'
            : t.channelType === 'telegram'
              ? /chat not found/i.test(res.reason ?? '')
                ? ' Author from inside the Telegram chat you want the result delivered to so the correct destination is captured.'
                : ''
              : ' Author from inside the chat you want the result delivered to so the correct channel is captured.'
          errors.push(
            `Step "${t.stepId}" delivers to the ${t.channelType} channel "${t.channelId}", which is not reachable: ${
              res.reason ?? 'channel check failed'
            }.${guidance}`,
          )
        }
      } catch (err) {
        // A validator throw is treated as not-blocking (the runtime soft-fail
        // remains) — never let a flaky reachability probe block authoring.
        console.warn('[workflow/dependencyIssues] delivery validator threw:', err)
      }
    }
  }

  // ── B. Connector preflight ───────────────────────────────────────────────
  if (deps.preflightConnectorTool) {
    // Steps in a parallel region (reachable from one fan-out edge but not a
    // sibling edge) can never pause the run — an ask-policy tool_call there
    // is upgraded from warning to hard error below.
    const parallelUnsafe = parallelRegionSteps(def)
    const refs: Array<{
      stepId: string
      toolName: string
      stepType: 'tool_call' | 'assistant_call'
      assistantId?: string
    }> = []
    for (const step of def.steps) {
      if (step.type === 'tool_call') {
        refs.push({ stepId: step.id, toolName: step.toolName, stepType: 'tool_call' })
      }
      if (step.type === 'assistant_call' && step.tools) {
        for (const tn of step.tools) {
          refs.push({
            stepId: step.id,
            toolName: tn,
            stepType: 'assistant_call',
            assistantId: step.target.assistantId,
          })
        }
      }
    }
    // Policy is L2-scoped (per target assistant), so the dedupe key carries
    // the assistant — the same tool on two steps targeting different
    // assistants can legitimately resolve to different policies.
    const probed = new Set<string>()
    for (const ref of refs) {
      const key = `${ref.toolName}\x00${ref.stepType}\x00${ref.assistantId ?? ''}`
      if (probed.has(key)) continue
      probed.add(key)
      try {
        const res = await deps.preflightConnectorTool({
          userId: context.userId,
          toolName: ref.toolName,
          assistantId: ref.assistantId,
          workspaceId: context.workspaceId,
        })
        if (!res) continue
        if (!res.ok) {
          errors.push(
            `Step "${ref.stepId}" uses the ${res.provider} tool "${ref.toolName}", but ${res.provider} is not usable right now: ${
              res.reason ?? 'connection check failed'
            }. Reconnect ${res.provider} (or refresh its token) before creating this workflow — otherwise every run fails here.`,
          )
          continue
        }
        // Policy gate. An `assistant_call` callee's tool surface DROPS
        // non-`allow` policy tools at run time (no interactive approver exists
        // mid-consult — the 2026-07-07 send-step incident: the callee refused /
        // produced nothing, the step "completed", and the send silently never
        // happened). Authoring must therefore reject the pin outright and
        // steer to the step type whose approval semantics exist.
        if (ref.stepType === 'assistant_call' && res.policy === 'ask') {
          errors.push(
            `Step "${ref.stepId}" pins "${ref.toolName}" in its \`tools\` allow-list, but that tool is ask-policy (requires per-use user approval) and an assistant_call step can never execute it — ask-policy tools are removed from the callee's surface at run time. Use a dedicated \`tool_call\` step with \`toolName: "${ref.toolName}"\` instead: it pauses the run in the Approvals queue and executes on the user's approval. (Alternatively the user can set the tool's policy to allow in connector settings.)`,
          )
        } else if (res.policy === 'block') {
          errors.push(
            `Step "${ref.stepId}" references "${ref.toolName}", but that tool is blocked by policy for this ${
              ref.stepType === 'assistant_call' ? 'assistant' : 'user'
            } — every run would fail here. Unblock it in connector settings or drop the step.`,
          )
        } else if (ref.stepType === 'tool_call' && res.policy === 'ask') {
          // Inside a parallel region the pause can never be honoured — the
          // executor fails it typed `pause_in_parallel` (a pause must hold
          // the only live cursor). Outside one it is the designed contract.
          if (parallelUnsafe.has(ref.stepId)) {
            errors.push(
              `Step "${ref.stepId}" invokes the ask-policy tool "${ref.toolName}" on a parallel branch that a sibling branch never rejoins. An approval pauses the WHOLE run, which is impossible while sibling steps are still executing — every run would fail here (\`pause_in_parallel\`). Move this step before the fan-out or after the join, or set the tool's policy to allow.`,
            )
          } else {
            warnings.push(
              `Step "${ref.stepId}" invokes the ask-policy tool "${ref.toolName}": each run will pause in the Approvals queue until the user approves that call. That is the designed contract for approval-gated actions — just make sure the user knows runs are not fully hands-free.`,
            )
          }
        }
      } catch (err) {
        console.warn('[workflow/dependencyIssues] connector preflight threw:', err)
      }
    }
  }

  // ── D. Connector data fetched inside a free-choice assistant_call ─────────
  // No network needed — a pure authoring heuristic. If a step pulls connector
  // data but pins no tool, the model picks tools on the fly and, on a connector
  // error, fabricates rather than failing. Steer to a dedicated tool_call.
  const hasToolCall = def.steps.some((s) => s.type === 'tool_call')
  for (const step of def.steps) {
    if (step.type !== 'assistant_call') continue
    if (step.tools && step.tools.length > 0) continue // already pinned
    if (hasToolCall) continue // a tool_call already fetches deterministically
    if (CONNECTOR_DATA_KEYWORD.test(step.prompt) && FETCH_VERB.test(step.prompt)) {
      warnings.push(
        `Step "${step.id}" asks the assistant to pull data from a connector but pins no tool, so the assistant chooses tools on the fly — and if the connector errors (bad token, not connected) it may fabricate a result from memory instead of failing. Prefer a dedicated \`tool_call\` step that fetches the data (it HALTS the run if the connector errors), storing it via \`storeOutputAs\`, feeding an \`assistant_call\` that summarizes \`{{vars.<name>}}\`. If you keep it as one step, add a \`tools\` allow-list naming the exact connector tool.`,
      )
    }
  }

  // ── E. Trigger-side truth checks ─────────────────────────────────────────
  // A webhook trigger is authorable here, but its URL slug + signing secret
  // are provisioned only in the web builder — without them the receiver can
  // never match a delivery, so the workflow is created dead. Surface that at
  // propose time instead of letting the user discover it from silence.
  if (trigger?.kind === 'webhook') {
    warnings.push(
      'This webhook trigger is saved, but the webhook URL slug + signing secret are provisioned in the web builder (open the workflow there to finish setup). Until then the workflow cannot receive deliveries. Tell the user this explicitly.',
    )
  }
  // An event trigger watching a doc page that does not exist (or is not
  // visible to the author) never fires — same dead-workflow class as a
  // dangling page anchor, so hold it to the same authoring standard.
  if (trigger?.kind === 'event' && deps.resolvePageAnchor) {
    for (const [i, sub] of trigger.event.sources.entries()) {
      if (sub.source.type !== 'page') continue
      try {
        const page = await deps.resolvePageAnchor(context.userId, sub.source.pageId)
        if (!page || page.workspaceId !== context.workspaceId) {
          errors.push(
            `trigger.event.sources[${i}].source.pageId: page not found in this workspace — an event trigger on a missing page never fires. Pick an existing page (or drop this source).`,
          )
        }
      } catch (err) {
        console.warn('[workflow/dependencyIssues] page-source resolver threw:', err)
      }
    }
  }

  return { errors, warnings }
}

/**
 * Per-step output cap in the compact trail. Enough to see what a step
 * actually said/did (a refusal, an error apology, a delivery outcome)
 * without flooding the caller's context with a full research deliverable.
 */
const STEP_OUTPUT_PREVIEW_CHARS = 600

/**
 * One-line, length-capped preview of a step run's persisted output.
 * Unwraps the executor's `{ value }` scalar wrapper for readability and
 * keeps the reserved `__delivery` outcome visible (it is the record of
 * whether a `deliver` step actually reached a channel).
 */
function stepOutputPreview(output: Record<string, unknown> | null): string | null {
  if (output === null) return null
  const keys = Object.keys(output)
  const unwrapped = keys.length === 1 && keys[0] === 'value' ? output.value : output
  if (unwrapped === null || unwrapped === undefined) return null
  let s: string
  if (typeof unwrapped === 'string') s = unwrapped
  else {
    try {
      s = JSON.stringify(unwrapped)
    } catch {
      s = String(unwrapped)
    }
  }
  return s.length > STEP_OUTPUT_PREVIEW_CHARS
    ? `${s.slice(0, STEP_OUTPUT_PREVIEW_CHARS - 3)}...`
    : s
}

function compactStepRun(row: WorkflowStepRunRecord): {
  stepId: string
  type: string
  status: string
  durationMs: number | null
  output: string | null
  error: Record<string, unknown> | null
} {
  return {
    stepId: row.stepId,
    type: row.stepType,
    status: row.status,
    durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    // Truncated output preview — without it a step's honest refusal / apology
    // text was structurally unreachable from chat, so the calling assistant
    // could only GUESS what a "completed" step actually did (the 2026-07-07
    // send-step incident: the refusal sat in workflow_step_runs.output while
    // chat asserted the email was sent).
    output: stepOutputPreview(row.output),
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
 * An explicit `deliver.channelId` the model set on the terminal `assistant_call`
 * step, when it matches the schedule trigger's `delivery.channel` type — the
 * model named a specific channel (e.g. a Slack `C…` id from `listSlackChannels`).
 * This WINS over the `trigger.delivery` sugar's context resolution, so a
 * channel picked from another session survives the stamp. `null` when the
 * terminal step carries no matching explicit target.
 */
function terminalExplicitDeliverId(
  def: WorkflowDefinition,
  channel: 'telegram' | 'slack' | 'whatsapp',
): string | null {
  const termId = terminalAssistantCallId(def)
  const termStep = termId ? def.steps.find((s) => s.id === termId) : undefined
  if (termStep?.type !== 'assistant_call') return null
  const d = termStep.deliver
  return d && 'channelId' in d && d.channelType === channel && d.channelId ? d.channelId : null
}

/**
 * Guidance when a schedule trigger's `delivery` sugar cannot be resolved to a
 * concrete channel id from the authoring session (a cross-type request with no
 * matching session/preferred channel). Points at `listSlackChannels` for Slack;
 * for Telegram/WhatsApp the sanctioned path is authoring from inside the chat.
 */
function unresolvedDeliveryError(channel: 'telegram' | 'slack' | 'whatsapp'): string {
  if (channel === 'slack') {
    return (
      'Cannot resolve which Slack channel to deliver to from this session. Call `listSlackChannels` to get the target channel\'s id, ' +
      'then set it on the terminal step\'s `deliver` as `{ "channelType": "slack", "channelId": "<id>" }` (or drop `trigger.delivery` and author from inside the Slack channel).'
    )
  }
  return (
    `Cannot resolve which ${channel} chat to deliver to from this session. Author the workflow from inside the ${channel} chat you want ` +
    `the result delivered to (the channel is captured there), or set the terminal step's \`deliver\` explicitly.`
  )
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

/**
 * Reserved-name footgun guard (mig 279). The cross-run hand-off captures vars
 * named `summary` / `state` / `todo` / `blockers` (`RESERVED_OUTCOME_VAR_NAMES`)
 * into the run outcome and surfaces them to the NEXT run as `{{lastRun.<name>}}`.
 * That is only meaningful for a workflow that runs more than once — so on a
 * one-shot (manual / schedule-once, the default), `storeOutputAs` into one of
 * these names is almost always an unintended collision with a private scratch
 * var. Warn so the author renames it (or adds a recurring trigger if they did
 * mean cross-run state). Stays quiet on recurring workflows, where the capture
 * is the intended use. Only `assistant_call` / `tool_call` apply `storeOutputAs`.
 */
/** A trigger that fires more than once (event / webhook / non-once schedule). */
function isRecurringTrigger(trigger?: WorkflowTrigger): boolean {
  if (!trigger) return false
  if (trigger.kind === 'event' || trigger.kind === 'webhook') return true
  if (trigger.kind === 'schedule') return trigger.schedule.type !== 'once'
  return false
}

function reservedOutcomeVarWarnings(def: WorkflowDefinition, trigger?: WorkflowTrigger): string[] {
  if (isRecurringTrigger(trigger)) return []
  const reserved = RESERVED_OUTCOME_VAR_NAMES as readonly string[]
  const warnings: string[] = []
  for (const step of def.steps) {
    if (step.type !== 'assistant_call' && step.type !== 'tool_call') continue
    if (step.storeOutputAs && reserved.includes(step.storeOutputAs)) {
      warnings.push(
        `Step "${step.id}" stores its output as \`${step.storeOutputAs}\`, a reserved cross-run hand-off name: its value is captured into the run outcome and surfaced to the NEXT run as \`{{lastRun.${step.storeOutputAs}}}\`. This workflow isn't recurring, so there is no next run to read it — if \`${step.storeOutputAs}\` is just an intra-run scratch var, rename it (e.g. \`${step.storeOutputAs}_tmp\`); if you meant cross-run state, give the workflow a recurring schedule trigger.`,
      )
    }
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
 * See docs/architecture/features/workflow.md §3, §5.
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
  listSlackChannels: Tool
  listSlackMembers: Tool
} {
  const phaseBActive = deps.executorDeps.pauseRunForWait !== undefined

  const proposeWorkflow = buildTool({
    name: 'proposeWorkflow',
    description:
      `Propose a workflow definition for the user to approve. Validates the draft against the schema and returns a summary the user can read. ` +
      `No database writes. For an edit, pass the workflowId previously returned by getWorkflow. After this returns, present the proposal and ask for explicit confirmation ("yes / create it / go ahead"). On approval, copy only the returned proposalReceipt into createWorkflow or updateWorkflow; never reconstruct name, definition, target, trigger, or assistant ids. Do not repeat workflow/assistant reads, tool searches, connector discovery, or this proposal unless the user changes it or receipt validation fails. ` +
      `Step types (V1): assistant_call (free-mode A2A), tool_call (first-party + MCP allow-policy), wait (not yet available), branch (JSONLogic condition). ` +
      `There is no loop / for-each step: to process each item in a list, propose a recurring schedule trigger that handles one batch per run and carries a cursor across runs via storeOutputAs + {{lastRun.<var>}}, or a research fan-out step for a read-only gather; name these routes when you decline a loop request. ` +
      `Parallel fan-out: set a step's nextStepId to an ARRAY of step ids (max 5, distinct) to start those steps IN PARALLEL when it completes. A downstream step that several branches point at is the implicit JOIN — it runs once, after every branch that can still reach it settles, and can read every branch's {{vars.<name>}}. The graph must stay acyclic, and a wait step may not sit on a parallel branch that some sibling branch never rejoins (pausing needs the only live cursor — put waits before the fan-out or after the join). startStepId accepts the same shape: an ARRAY of step ids (max 5, distinct) starts every listed step IN PARALLEL the moment the trigger fires — a trigger-level fan-out with the same join and wait rules. ` +
      `Use \`storeOutputAs\` on a step to make its output available as \`{{vars.<name>}}\` in later steps. Use \`{{input.<name>}}\` to reference the trigger payload. ` +
      `A later step's prompt must NEVER assert what an earlier step supposedly did (e.g. "...which was emailed to the reviewer") — the earlier step may have failed or refused, and the assertion would be recorded as fact. Thread the earlier step's REAL output via storeOutputAs + {{vars.<name>}} and phrase the prompt conditionally on it. ` +
      `\n\nPage editing: when a step should edit or produce a doc page, set the step's \`page\` field — NEVER just mention a page id in the prompt (the callee gets no page tools that way and the step fails on every run). ` +
      `Variants: \`page: {"id": "<page uuid>"}\` edits an existing page; \`page: {"create": true, "title": "...", "nestUnder": "<page uuid>"}\` creates a saved page each run and anchors the step to it (title may use {{vars}}/{{input}}); \`page: {"fromStep": "<stepId>"}\` edits the page an earlier create-step made this run. ` +
      `The callee then runs with the doc tools (getCurrentPage / patchPage / renderPage) against that page.` +
      `\n\nSkills: when a step should follow a saved brain skill, ATTACH it on the step — NEVER just name the skill in the prompt (a workflow callee has no skill surface unless the step attaches one, so a prose-only reference silently does nothing on every run). \`enforcedSkills: ["<slug>"]\` force-loads the skill's instructions every run (the usual choice for workflows); \`skills: ["<slug>"]\` offers it via useSkill and the callee chooses. Use exact skill slugs; an attached slug that matches no workspace skill or built-in id is rejected. ` +
      `For structured output, an assistant_call research step may also set \`blueprintId: "<workspace skill slug | page-template id>"\` together with a \`page\` anchor to fill that blueprint instead of free-form authoring — blueprints themselves are created in the web app (Brain → Blueprints) or minted from a skill's extraction spec; they cannot be created from chat, so never claim otherwise.` +
      `\n\nChannel delivery: a step's \`deliver: { channelType, channelId }\` pushes that step's output to a static messaging destination (Slack channelId from listSlackChannels). For a WhatsApp channel-event workflow that must answer the customer who triggered this run, use exactly \`deliver: { channelType: "whatsapp", replyToTrigger: true }\`; never add a channelId or phone number. This variant is valid only when every event source is a WhatsApp channel integration. To post a THREAD — one parent message with replies under it — use one deliver-step per message and give each follow-up step \`deliver: { ..., thread: { fromStep: "<parent step id>" } }\`: it replies under the message that earlier step posted this run (same channel required; slack + telegram only). Do NOT concatenate multiple messages into one step's output and expect threading. ` +
      `To MENTION people in a Slack delivery, first call \`listSlackMembers\` and embed the literal \`<@MEMBER_ID>\` ids in the step prompt — plain @name renders as text and notifies nobody.`,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe('Human-readable name. Shown in audit, listings, and approval prompts.'),
      description: z.string().max(2000).nullable().optional(),
      definition: z
        .object({
          startStepId: z.union([z.string(), z.array(z.string())]),
          steps: z.array(z.unknown()),
        })
        .passthrough()
        .describe('Workflow DAG. See proposeWorkflow tool docs for the schema.'),
      trigger: triggerInputSchema.optional(),
      workflowId: idShape.optional().describe('Existing workflow id from getWorkflow. Include for an edit; omit for a new workflow.'),
      enabled: z.boolean().optional().describe('Edited enabled state. Only meaningful with workflowId.'),
      targetViewId: z.string().uuid().nullable().optional().describe('Scheduled doc target. Pass null only when clearing it on an edit.'),
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

      if (!input.workflowId && input.description === null) {
        return { data: { ok: false, errors: ['description: null is only valid when editing an existing workflow.'] }, isError: true }
      }
      if (!input.workflowId && input.enabled !== undefined) {
        return { data: { ok: false, errors: ['enabled is only valid when editing an existing workflow.'] }, isError: true }
      }
      if (input.workflowId) {
        const existing = await deps.workflowStore.getById(context.userId, input.workflowId)
        if (!existing || existing.workspaceId !== context.workspaceId) {
          return { data: `Workflow ${input.workflowId} not found in workspace.`, isError: true }
        }
      }

      // Store-backed page-anchor checks — fail the proposal on a dangling
      // anchor instead of authoring a workflow that fails 100% of its runs.
      const anchorIssues = await pageAnchorIssues(
        definition,
        { userId: context.userId, workspaceId: context.workspaceId! },
        deps.resolvePageAnchor,
      )
      // External-dependency checks: delivery-target reachability + connector
      // preflight (fix A / B); the fix-D fabrication-risk warning rides along.
      const depIssues = await dependencyIssues(definition, trigger, context, deps)
      // Skill-attachment checks — a skill named in prose but not attached is
      // the skills-shaped doc-anchor footgun; a dangling attached slug blocks.
      const skillIssues = await skillAttachmentIssues(
        definition,
        { userId: context.userId, workspaceId: context.workspaceId! },
        deps.listAuthorableSkills,
      )
      if (anchorIssues.errors.length > 0 || depIssues.errors.length > 0 || skillIssues.errors.length > 0) {
        return {
          data: {
            ok: false,
            errors: [...anchorIssues.errors, ...depIssues.errors, ...skillIssues.errors],
            stepTypes: STEP_TYPE_VALUES,
          },
          isError: true,
        }
      }

      const knownRuntimeTools = await runtimeKnownToolNames(definition, context, deps)

      const proposalReceipt = input.workflowId
        ? encodeProposalReceipt({
            version: 1,
            action: 'update',
            input: {
              workflowId: input.workflowId,
              name: input.name,
              description: input.description,
              definition,
              enabled: input.enabled,
              trigger,
              targetViewId: input.targetViewId,
            },
          })
        : encodeProposalReceipt({
            version: 1,
            action: 'create',
            input: {
              name: input.name,
              description: input.description ?? undefined,
              definition,
              trigger,
              targetViewId: input.targetViewId ?? undefined,
            },
          })

      context.workflowProposalReceipt = proposalReceipt

      return {
        data: {
          ok: true,
          proposalReceipt,
          proposedAction: input.workflowId ? 'update' : 'create',
          proposedName: input.name,
          proposedDescription: input.description ?? null,
          proposedTrigger: trigger ?? null,
          summary: summarize(definition),
          warnings: [
            ...warningsFor(definition, {
              phaseBActive,
              isKnownTool: deps.isKnownTool,
              runtimeKnownToolNames: knownRuntimeTools,
            }),
            ...anchorIssues.warnings,
            ...depIssues.warnings,
            ...skillIssues.warnings,
            ...triggerWarnings(definition, trigger),
            ...reservedOutcomeVarWarnings(definition, trigger),
            // Same non-blocking advisories the REST/web-builder path returns
            // (researchMode fan-out trap; contact research on the default
            // budget) — the chat path used to ship these steps unwarned.
            ...stepAdvisories(definition).map((a) => a.message),
          ],
          definition,
          confirmationHint:
            'Show the user this proposal (and the trigger / schedule) and the warnings. Ask for explicit confirmation. On approval, immediately call createWorkflow with {} when proposedAction is create, or updateWorkflow with {} when proposedAction is update. The runtime recovers the receipt from session history. Do not repeat discovery, listAssistants, or proposeWorkflow unless the user changes the proposal or the write reports no valid pending proposal.',
        },
      }
    },
  })

  const pendingWriteInputSchema = z.object({}).strict().describe('No arguments. Applies the latest approved proposal in this session.')
  const createWorkflowInputSchema = deps.allowLegacyDirectWrites
    ? z.union([receiptWriteInputSchema, legacyCreateWorkflowInputSchema])
    : pendingWriteInputSchema

  const createWorkflow = buildTool({
    name: 'createWorkflow',
    description:
      `Persist the latest new-workflow proposal that the user explicitly approved. This tool takes NO arguments: the runtime recovers the exact validated receipt from this session's persisted history. After approval call it immediately with {}. Never re-run proposeWorkflow, reconstruct or resend workflow fields, or run discovery/listAssistants. A call with no pending create proposal is rejected. ` +
      `\n\nTriggering is built into the receipt: proposeWorkflow freezes \`trigger: { kind: "schedule", schedule, ... }\` to schedule it, or \`{ kind: "event", event: { sources } }\` to subscribe to workspace signals. A one-step assistant_call workflow with \`trigger.delivery\` is a reminder; a multi-step workflow is an automation. Confirm the schedule with the user before applying the receipt.`,
    inputSchema: createWorkflowInputSchema,
    requiresConfirmation: false,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      let createInput: z.infer<typeof createProposalInputSchema>
      const pendingReceipt = 'proposalReceipt' in input
        ? input.proposalReceipt
        : context.workflowProposalReceipt
      if (pendingReceipt) {
        const decoded = decodeProposalReceipt(pendingReceipt)
        if (!decoded.ok) return { data: decoded.error, isError: true }
        if (decoded.receipt.action !== 'create') {
          return { data: 'This receipt is for an existing workflow edit. Apply it with updateWorkflow.', isError: true }
        }
        createInput = decoded.receipt.input
      } else {
        if (!deps.allowLegacyDirectWrites) {
          return {
            data: 'A validated proposalReceipt is required. Do not reconstruct workflow fields or search for assistants; call proposeWorkflow, show its proposal, then pass its receipt unchanged after approval.',
            isError: true,
          }
        }
        const legacy = createProposalInputSchema.safeParse(input)
        if (!legacy.success) {
          return { data: { ok: false, errors: legacy.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, isError: true }
        }
        createInput = legacy.data
      }

      const parsed = WorkflowDefinitionSchema.safeParse(createInput.definition)
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
      if (createInput.trigger) {
        const t = WorkflowTriggerSchema.safeParse(createInput.trigger)
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
      // Delivery-target reachability + connector preflight (fix A / B). Block
      // here too — createWorkflow can be reached with an edited definition.
      const depIssues = await dependencyIssues(parsed.data, trigger, context, deps)
      // Dangling attached skill slugs block here too (same reasoning).
      const skillIssues = await skillAttachmentIssues(
        parsed.data,
        { userId: context.userId, workspaceId: context.workspaceId! },
        deps.listAuthorableSkills,
      )
      if (anchorIssues.errors.length > 0 || depIssues.errors.length > 0 || skillIssues.errors.length > 0) {
        return {
          data: { ok: false, errors: [...anchorIssues.errors, ...depIssues.errors, ...skillIssues.errors] },
          isError: true,
        }
      }

      // Cap check BEFORE persist so a capped user never orphans a workflow row.
      const capError = await recurringCapError(deps, context.userId, trigger)
      if (capError) return { data: capError, isError: true }

      // Schedule trigger with messaging delivery → stamp the resolved chat /
      // topic onto the terminal assistant_call step before persist (the
      // executor reads `assistant_call.deliver`, not the trigger).
      let definition: WorkflowDefinition = parsed.data
      if (trigger?.kind === 'schedule' && trigger.delivery) {
        const channel = trigger.delivery.channel
        // Explicit `deliver.channelId` on the terminal step wins over the sugar
        // (a channel the model picked from another session, e.g. via
        // listSlackChannels) — keep it as-is; dependencyIssues validated it.
        if (!terminalExplicitDeliverId(definition, channel)) {
          const { channelId } = resolveDeliveryChannel(context, channel)
          if (!channelId) {
            return { data: { ok: false, errors: [unresolvedDeliveryError(channel)] }, isError: true }
          }
          const stamped = stampTerminalDeliver(definition, { channelType: channel, channelId })
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
      }

      const record = await deps.workflowStore.create({
        userId: context.userId,
        workspaceId: context.workspaceId!,
        name: createInput.name,
        description: createInput.description ?? null,
        definition,
        trigger,
      })
      context.workflowProposalReceipt = undefined

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
        const res = await applyScheduleTrigger(deps, context, record.id, definition, trigger, createInput.targetViewId)
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
          ...(trigger?.kind === 'webhook'
            ? {
                webhookNote:
                  'Created, but the webhook URL slug + signing secret are provisioned in the web builder — the workflow cannot receive deliveries until the user finishes setup there. Relay this to the user.',
              }
            : {}),
        },
      }
    },
  })

  const updateWorkflowInputSchema = deps.allowLegacyDirectWrites
    ? z.union([receiptWriteInputSchema, legacyUpdateWorkflowInputSchema])
    : pendingWriteInputSchema

  const updateWorkflow = buildTool({
    name: 'updateWorkflow',
    description:
      `Edit an existing workflow — add a step, remove a step, reorder steps, rewrite a step's fields, OR change its trigger / schedule. Patches any subset of name / description / definition / enabled / trigger. ` +
      `First call \`getWorkflow\`, then \`proposeWorkflow\` with that workflowId and the complete edited values. After explicit confirmation call this tool immediately with {}. It takes NO arguments: the runtime recovers the exact validated receipt from persisted session history. Never re-run proposal/discovery/listAssistants or reconstruct workflow fields. A call with no pending update proposal is rejected. Never use \`createWorkflow\` for an edit. ` +
      `Editing does not affect runs already in flight — the change applies to the next run.`,
    inputSchema: updateWorkflowInputSchema,
    requiresConfirmation: false,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      let updateInput: z.infer<typeof updateProposalInputSchema>
      const pendingReceipt = 'proposalReceipt' in input
        ? input.proposalReceipt
        : context.workflowProposalReceipt
      if (pendingReceipt) {
        const decoded = decodeProposalReceipt(pendingReceipt)
        if (!decoded.ok) return { data: decoded.error, isError: true }
        if (decoded.receipt.action !== 'update') {
          return { data: 'This receipt is for a new workflow. Apply it with createWorkflow.', isError: true }
        }
        updateInput = decoded.receipt.input
      } else {
        if (!deps.allowLegacyDirectWrites) {
          return {
            data: 'A validated update proposalReceipt is required. Do not reconstruct workflow fields or search for assistants; call getWorkflow, then proposeWorkflow with its workflowId, and pass the returned receipt unchanged after approval.',
            isError: true,
          }
        }
        const legacy = updateProposalInputSchema.safeParse(input)
        if (!legacy.success) {
          return { data: { ok: false, errors: legacy.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, isError: true }
        }
        updateInput = legacy.data
      }

      const existing = await deps.workflowStore.getById(context.userId, updateInput.workflowId)
      if (!existing || existing.workspaceId !== context.workspaceId) {
        return { data: `Workflow ${updateInput.workflowId} not found in workspace.`, isError: true }
      }

      // Validate the optional trigger up front (before any write).
      let trigger: WorkflowTrigger | undefined
      if (updateInput.trigger) {
        const t = WorkflowTriggerSchema.safeParse(updateInput.trigger)
        if (!t.success) {
          return { data: { ok: false, errors: t.error.issues.map((i) => `trigger.${i.path.join('.')}: ${i.message}`) }, isError: true }
        }
        trigger = t.data
        if (!deps.jobStore) {
          return { data: 'Scheduling is not available in this context.', isError: true }
        }
      }

      const fields: Parameters<WorkflowStore['update']>[2] = {}
      if (updateInput.name !== undefined) {
        fields.name = updateInput.name
        // A user-initiated rename pins the title so the auto-titler stops
        // touching it — mirrors the REST PATCH path (mig 202).
        fields.nameManuallySet = true
      }
      if (updateInput.description !== undefined) fields.description = updateInput.description
      if (updateInput.enabled !== undefined) fields.enabled = updateInput.enabled

      if (updateInput.definition !== undefined) {
        const parsed = WorkflowDefinitionSchema.safeParse(updateInput.definition)
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
        const skillIssues = await skillAttachmentIssues(
          parsed.data,
          { userId: context.userId, workspaceId: context.workspaceId! },
          deps.listAuthorableSkills,
        )
        if (anchorIssues.errors.length > 0 || skillIssues.errors.length > 0) {
          return { data: { ok: false, errors: [...anchorIssues.errors, ...skillIssues.errors] }, isError: true }
        }
        fields.definition = parsed.data
      }

      // Schedule trigger with messaging delivery → stamp the resolved chat /
      // topic onto the terminal assistant_call step (the executor reads
      // `assistant_call.deliver`). Operates on the new definition if one is
      // being set, else the existing one.
      if (trigger?.kind === 'schedule' && trigger.delivery) {
        const base = fields.definition ?? existing.definition
        const channel = trigger.delivery.channel
        // Explicit terminal `deliver.channelId` wins over the sugar (see createWorkflow).
        if (!terminalExplicitDeliverId(base, channel)) {
          const { channelId } = resolveDeliveryChannel(context, channel)
          if (!channelId) {
            return { data: { ok: false, errors: [unresolvedDeliveryError(channel)] }, isError: true }
          }
          const stamped = stampTerminalDeliver(base, { channelType: channel, channelId })
          if (!stamped) {
            return {
              data: { ok: false, errors: ['trigger.delivery is set but the workflow has no assistant_call step to deliver from.'] },
              isError: true,
            }
          }
          fields.definition = stamped
        }
        // Explicit target kept: the definition (new or existing) already carries
        // the terminal `deliver`, so nothing to stamp.
      }

      // Mirror the trigger column so the builder renders reality.
      if (trigger !== undefined) fields.trigger = trigger

      // Delivery-target reachability + connector preflight (fix A / B) — only
      // when the definition or trigger is actually changing. A bare
      // `{ enabled: false }` (or rename) must never be blocked by a connector
      // token that has since expired; the runtime guards cover live runs.
      if (updateInput.definition !== undefined || trigger !== undefined) {
        const effectiveDef = fields.definition ?? existing.definition
        const effectiveTrigger = trigger ?? existing.trigger
        const depIssues = await dependencyIssues(effectiveDef, effectiveTrigger, context, deps)
        if (depIssues.errors.length > 0) {
          return { data: { ok: false, errors: depIssues.errors }, isError: true }
        }
      }

      if (Object.keys(fields).length === 0) {
        return { data: 'Nothing to update — pass at least one of name / description / definition / enabled / trigger.', isError: true }
      }

      const updated = await deps.workflowStore.update(context.userId, updateInput.workflowId, fields)
      if (!updated) {
        return { data: `Workflow ${updateInput.workflowId} not found in workspace.`, isError: true }
      }
      context.workflowProposalReceipt = undefined

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
              updateInput.targetViewId,
            )
            if ('error' in applied) scheduleError = applied.error
            else schedule = { nextRun: applied.nextRun, relativeTime: applied.relativeTime }
          } else {
            const timezone = trigger.timezone ?? context.userTimezone ?? 'UTC'
            const viewIdToSet =
              updateInput.targetViewId !== undefined
                ? await resolveTargetView(deps.resolveViewWorkspace, updateInput.targetViewId, context)
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
      'Read one workflow in full — its name, description, enabled state, trigger kind, the complete definition (every step + startStepId), `triggerJobs`: the ACTUAL scheduled-trigger rows firing it (any member\'s, with ownedByMe), and `recentRuns`: its most recent runs (bounded, newest first) with each one\'s id, status, trigger kind, start/finish time, and error. If triggerJobs disagrees with triggerKind (e.g. kind "manual" but enabled cron rows listed), the firing rows are the truth — fix the mismatch with `updateWorkflow` (set the correct `trigger`, or `{ enabled: false }` to stop). Use `recentRuns` to answer "how did the last few runs go?" without a separate call, and to resolve a vague reference ("the 6am one") to a run id before calling `getWorkflowRun` for its full step trail. Use this before editing a workflow with `updateWorkflow`; `listWorkflows` returns summaries (with each trigger). Webhook secrets are never returned.',
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

      // Bounded, newest-first — wraps the same `listRunsForWorkflow` the
      // REST run-history endpoint already uses (only the tool layer was
      // missing it, use-brian#278). Deliberately NOT the step trail; that
      // stays behind getWorkflowRun so this read doesn't balloon. Always
      // present (never omitted) so an empty history reads as "[]", never
      // as a missing field the model might mistake for "not fetched".
      const recentRuns = (
        await deps.runStore.listRunsForWorkflow(context.userId, workflow.id, {
          limit: RECENT_RUNS_DEFAULT_LIMIT,
        })
      ).map((r) => ({
        id: r.id,
        status: r.status,
        triggerKind: r.triggerKind,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        error: r.error,
      }))

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
          recentRuns,
          createdAt: workflow.createdAt.toISOString(),
          updatedAt: workflow.updatedAt.toISOString(),
        },
      }
    },
  })

  const runWorkflow = buildTool({
    name: 'runWorkflow',
    description:
      `Manually run a workflow. Returns the terminal outcome (completed / failed / paused) along with the step trail, including each step's truncated output. ` +
      `A step status of "completed" means the step's turn finished — it does NOT by itself prove any side-effect (a send, a save) happened. Before telling the user an action occurred, read that step's \`output\` (and \`__delivery\` when present) for evidence; if the output shows a refusal or an error, report that honestly. ` +
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

  /**
   * Resolve `getWorkflowRun`'s `runId` input to exactly one run in the
   * caller's workspace. use-brian#278 — three distinct outcomes, three
   * distinct messages; never collapse an unresolved id into "does not
   * exist" (that conflation was the original incident).
   *
   * A full UUID keeps the pre-existing exact-match path unchanged: same
   * `getRunById` query, same cost, no behaviour change for callers that
   * already pass one.
   *
   * Workspace filtering happens BEFORE the ambiguity check. RLS scopes
   * `resolveRunsByIdPrefix` to every workspace the calling user belongs
   * to — broader than this conversation's `context.workspaceId` for a
   * multi-workspace user. Filtering after counting would both fake
   * ambiguity from another workspace's run and leak that run's metadata
   * (name, timing, status) into the ambiguity message.
   */
  async function resolveRunId(
    context: ToolContext,
    rawId: string,
  ): Promise<
    | { ok: true; run: WorkflowRunRecord }
    | { ok: false; result: { data: unknown; isError: true } }
  > {
    if (UUID_RE.test(rawId)) {
      const run = await deps.runStore.getRunById(context.userId, rawId)
      if (!run || run.workspaceId !== context.workspaceId) {
        return { ok: false, result: { data: `Run ${rawId} not found in workspace.`, isError: true } }
      }
      return { ok: true, run }
    }

    if (rawId.length < RUN_ID_PREFIX_MIN_LEN) {
      return {
        ok: false,
        result: {
          data:
            `"${rawId}" is too short to resolve — a run id prefix needs at least ${RUN_ID_PREFIX_MIN_LEN} characters (the length the interface shows). ` +
            'Copy the id shown under the run, or call getWorkflow to see its recentRuns.',
          isError: true,
        },
      }
    }

    // A run id is a UUID, so a legitimate prefix is hex + dashes and nothing
    // else. Enforcing that here is not cosmetic: the store resolves with
    // `id::text LIKE $1 || '%'`, where `%` and `_` are LIKE METACHARACTERS.
    // An unvalidated prefix is therefore a pattern, not a prefix — eight
    // underscores match every run the caller can see, turning a lookup into
    // an enumeration whose ambiguity list hands back ids, workflow names and
    // timings the caller never named. Parameterisation stops SQL injection;
    // it does not stop wildcard injection. Reject at the edge so the store's
    // "anchored prefix" contract is true rather than merely intended.
    if (!RUN_ID_PREFIX_RE.test(rawId)) {
      return {
        ok: false,
        result: {
          data:
            `"${rawId}" is not a run identifier — run ids are UUIDs, so an id or prefix contains only hex digits (0-9, a-f) and dashes. ` +
            'Pass the id exactly as the interface showed it, or call getWorkflow to see that workflow\'s recentRuns.',
          isError: true,
        },
      }
    }

    // RLS-scoped: may include runs from ANY workspace the user belongs to.
    // Filter to this conversation's workspace BEFORE counting — see the
    // doc comment above.
    const rawCandidates = await deps.runStore.resolveRunsByIdPrefix(context.userId, rawId.toLowerCase())
    const inWorkspace = rawCandidates.filter((r) => r.workspaceId === context.workspaceId)

    if (inWorkspace.length === 0) {
      return {
        ok: false,
        result: {
          // "Could not resolve" ≠ a claim that the run is missing — only the
          // first is warranted from a failed lookup. This wording (and the
          // absence of any "not found" / non-existence phrasing) is the
          // regression guard for the original false answer.
          data:
            `Could not resolve run identifier "${rawId}" in this workspace — the identifier could not be matched against any run. This is NOT a report on whether the run is present; it only means this identifier didn't resolve. ` +
            'Call getWorkflow on the relevant workflow to see its recentRuns, or ask the user for the id shown in the interface.',
          isError: true,
        },
      }
    }

    if (inWorkspace.length > 1) {
      const candidates = await Promise.all(
        inWorkspace.map(async (r) => {
          const wf = await deps.workflowStore.getById(context.userId, r.workflowId)
          return {
            id: r.id,
            workflowName: wf?.name ?? null,
            startedAt: r.startedAt.toISOString(),
            status: r.status,
          }
        }),
      )
      return {
        ok: false,
        result: {
          data: {
            error: `"${rawId}" matches more than one run in this workspace. Ask the user which one they meant (or use a longer / full id).`,
            candidates,
          },
          isError: true,
        },
      }
    }

    return { ok: true, run: inWorkspace[0] }
  }

  const getWorkflowRun = buildTool({
    name: 'getWorkflowRun',
    description:
      'Inspect a workflow run — current status, step trail (with each step\'s truncated output), and any error. Use when the user asks "what happened with my X workflow?", and ALWAYS before asserting or re-asserting that a past run performed an action: the step `output` is the evidence of what actually happened, and a "completed" status alone is not proof of a side-effect. ' +
      'Accepts a short id copied straight from the interface (it shows only an 8-character prefix) as well as a full UUID — pass whatever the user gave you VERBATIM. NEVER pad, truncate-then-extend, or invent characters to force a short id into a full UUID: a fabricated id resolves to nothing, which this tool cannot distinguish from "you made this up". If the id you passed does not resolve, that is NOT proof the run does not exist — call getWorkflow for that workflow\'s recentRuns instead of guessing.',
    inputSchema: z.object({
      runId: runIdShape,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const resolved = await resolveRunId(context, input.runId)
      if (!resolved.ok) return resolved.result

      const run = resolved.run
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

  const listSlackChannels = buildTool({
    name: 'listSlackChannels',
    description:
      "Browse Slack channels visible to the delivering assistant's bot: each channel's id (a Slack `C…`/`G…` id) and name. " +
      'If the user supplied a concrete channel id, pass it as `channelId`: that performs an authoritative direct lookup for the exact channel. A channel missing from the browse list is NOT proof the bot lacks access; never ask for an invite or reconnect from list absence alone. Use the direct lookup or `proposeWorkflow` to check it. ' +
      'When choosing by name, call this before setting a Slack delivery target, then use the chosen channel\'s `id` on the terminal step\'s `deliver` as `{ channelType: "slack", channelId: "<id>" }`. ' +
      'The internal channel UUID from `listChannels` is NOT a Slack channel id and fails `channel_not_found` — always use an id from here. ' +
      '`isMember: true` marks channels the bot is already in (postable without a join).',
    inputSchema: z.object({
      assistantId: z
        .string()
        .uuid()
        .optional()
        .describe('The delivering assistant (the workflow step target). Defaults to the current assistant.'),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe('A concrete user-supplied Slack channel id to verify directly. Omit only when browsing channels.'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (!deps.listSlackChannels) {
        return { data: 'Slack channel discovery is not available in this context.', isError: true }
      }
      const res = await deps.listSlackChannels({
        assistantId: input.assistantId ?? context.assistantId,
        channelId: input.channelId,
      })
      if (!res.ok) return { data: res.reason, isError: true }
      return { data: { channels: res.channels } }
    },
  })

  const listSlackMembers = buildTool({
    name: 'listSlackMembers',
    description:
      "List the Slack workspace's members this workspace's bot can see: each member's id (a Slack `U…` id), handle, display name, and real name. " +
      'Call this whenever a Slack message should MENTION (tag / notify) specific people — a workflow step prompt, a reminder, or a direct send. ' +
      'Slack only notifies via the literal mention syntax `<@MEMBER_ID>` (e.g. `<@U0123ABCD>`): embed the exact id from here in the message text or step prompt. ' +
      'Plain `@name` renders as text and notifies nobody, and `<@handle>` (a handle inside the id syntax) renders as broken literal text — never use either.',
    inputSchema: z.object({
      assistantId: z
        .string()
        .uuid()
        .optional()
        .describe('The delivering assistant (the workflow step target). Defaults to the current assistant.'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (!deps.listSlackMembers) {
        return { data: 'Slack member discovery is not available in this context.', isError: true }
      }
      const res = await deps.listSlackMembers({ assistantId: input.assistantId ?? context.assistantId })
      if (!res.ok) return { data: res.reason, isError: true }
      return { data: { members: res.members } }
    },
  })

  return {
    proposeWorkflow,
    createWorkflow,
    updateWorkflow,
    getWorkflow,
    runWorkflow,
    listWorkflows,
    getWorkflowRun,
    listSlackChannels,
    listSlackMembers,
  }
}

function outcomeStatus(o: RunOutcome): string {
  if (o.kind === 'completed') return 'completed'
  if (o.kind === 'failed') return 'failed'
  return o.reason === 'wait' ? 'awaiting_wait' : 'awaiting_input'
}
