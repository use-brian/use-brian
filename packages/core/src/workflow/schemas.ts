/**
 * Zod schemas for workflow definitions. These are the runtime source of
 * truth — validation gates both the authoring tool (`proposeWorkflow`) and
 * the persistence path (`createWorkflow`).
 *
 * Mirrors `types.ts` exactly. When changing one, change the other.
 *
 * [COMP:workflow/schemas]
 */

import { z } from 'zod'
import { WORKFLOW_STEP_TYPES } from './types.js'
import { ResearchDepthConfigSchema } from '../engine/research-depth.js'

// ── Step ID and common shape ────────────────────────────────────────────

const stepIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Step IDs must start with a letter and contain only letters, digits, _ or -.')

const commonSchema = {
  id: stepIdSchema,
  description: z.string().max(280).optional(),
  nextStepId: stepIdSchema.nullable().optional(),
  storeOutputAs: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'storeOutputAs must be a simple identifier.')
    .optional(),
} as const

// ── assistant_call ──────────────────────────────────────────────────────

// `assistant_call` targets are the literal 'primary' sentinel (resolved to the
// workspace's primary assistant by the executor) or a concrete assistant UUID.
// A human-readable name (e.g. "product-assistant") is NOT valid — there is no
// name→id resolution anywhere, so a slug reaches the consult's assistant lookup
// as a raw value Postgres then fails to cast to uuid ("invalid input syntax for
// type uuid"). Enforce the documented contract here (workflow.md → "Locked V1
// decisions") so a bad target is rejected at authoring time with an actionable
// message instead of producing a workflow that fails 100% of its runs.
const assistantTargetSchema = z
  .union([z.literal('primary'), z.string().uuid()], {
    errorMap: () => ({
      message:
        "assistantId must be 'primary' (the workspace's primary assistant) or a concrete assistant UUID, not a name. Use 'primary' unless you have a specific assistant's id.",
    }),
  })
  .describe(
    "Target assistant: the literal 'primary' (default - the workspace's primary assistant) or a concrete assistant UUID. Never a human-readable name; there is no name lookup.",
  )

/**
 * Exactly one whole-string interpolation token (`{{vars.x}}` / `{{input.x}}`,
 * mirroring `interpolation.ts`'s TOKEN with the vars|input head the resolver
 * enforces). Used by `page.id` for run-time-resolved anchors — e.g. a
 * webhook payload carrying the page to update. A MIXED string
 * ("page-{{vars.x}}") is rejected: the resolved value must be one page id,
 * nothing else.
 */
const interpolationTokenSchema = z
  .string()
  .regex(
    /^\{\{\s*(vars|input)\.[a-zA-Z0-9_.]+\s*\}\}$/,
    'must be a page UUID or exactly one {{vars.x}} / {{input.x}} token',
  )

/**
 * Page anchor — the bounded "edit page X" / "create a page" configuration.
 * Three strict variants (unknown keys fail loudly so a future variant
 * reaching this server is an authoring error, never a silent no-anchor):
 *
 *  - `{ id }`       — anchor an existing page: a uuid, or (Phase B) exactly
 *                     one whole-string `{{vars/input}}` token resolved at
 *                     run time and UUID-shape-checked before the consult
 *                     (typed `invalid_page_anchor` on a bad resolution).
 *                     Arbitrary strings still fail at authoring time.
 *  - `{ create }`   — create a saved page this run and anchor to it.
 *                     `title` may interpolate `{{vars/input}}`.
 *  - `{ fromStep }` — the page a prior `{ create }` step made this run.
 *                     Reference validity is checked in the definition-level
 *                     superRefine below.
 */
const pageAnchorSchema = z.union([
  z.object({ id: z.union([z.string().uuid(), interpolationTokenSchema]) }).strict(),
  z
    .object({
      create: z.literal(true),
      title: z.string().min(1).max(256).optional(),
      nestUnder: z.string().uuid().optional(),
      /**
       * Cross-run page identity. `'per-run'` (default) creates a fresh page
       * every run; `'per-workflow'` find-or-creates against a stable
       * `<workflowId>:<stepId>` anchor key so a recurring workflow reuses ONE
       * page instead of minting an empty duplicate each fire. See
       * docs/architecture/features/workflow.md → "assistant_call page anchor".
       */
      reuse: z.enum(['per-run', 'per-workflow']).optional(),
    })
    .strict(),
  z.object({ fromStep: stepIdSchema }).strict(),
])

const assistantCallStepSchema = z.object({
  ...commonSchema,
  type: z.literal('assistant_call'),
  target: z.object({
    assistantId: assistantTargetSchema,
    capabilityId: z.string().min(1).max(128).optional(),
  }),
  prompt: z.string().min(1).max(8000),
  /**
   * Optional allow-list of tool names the callee may use during this step.
   * Enforced: the executor threads this through `ConsultRequest.allowedTools`
   * and the callee executor narrows its tool surface to exactly this set.
   * See workflow-builder.md → "Schema changes".
   */
  tools: z.array(z.string().min(1).max(128)).max(64).optional(),
  /**
   * Optional allow-list of brain skill slugs the callee may activate. When
   * non-empty the executor threads it through `ConsultRequest.skills` and the
   * callee executor offers the `useSkill` tool over exactly these skills (each
   * still gated by the callee assistant's enablement + clearance). Injected
   * after the `tools` allow-list, so a `tools` restriction never strips
   * `useSkill`. See docs/architecture/features/workflow.md → "assistant_call skills".
   */
  skills: z.array(z.string().min(1).max(128)).max(64).optional(),
  /**
   * Optional list of brain skill slugs the callee is FORCED to run: their
   * instructions are injected into the callee system prompt (a `# Required
   * Skills` block) instead of being offered via `useSkill`. Same enablement +
   * clearance gates as `skills`; an enforced slug is not also offered for
   * discovery. Threaded via `ConsultRequest.enforcedSkills`. See
   * docs/architecture/features/workflow.md → "assistant_call skills".
   */
  enforcedSkills: z.array(z.string().min(1).max(128)).max(64).optional(),
  /**
   * Optional page anchor. When set, the callee runs doc-anchored (doc tools
   * injected, `ToolContext.docViewId` set) against the resolved page.
   * See docs/architecture/features/workflow.md → "assistant_call page anchor".
   */
  page: pageAnchorSchema.optional(),
  /**
   * Optional delivery target. When set, the step's text response is pushed
   * to this user channel after the consult completes — best-effort, a push
   * failure never fails the step. This is what lets a one-step workflow
   * stand in for a scheduled job.
   *
   * `thread.fromStep` makes the push a THREAD REPLY under the message an
   * earlier deliver-step posted this run (Slack thread / Telegram reply):
   * the executor records each delivered message's platform id under the
   * reserved run var `__deliveryMsg_<stepId>` and passes it as the reply
   * anchor. Both steps must deliver to the same channel; if the referenced
   * step delivered nothing this run (branch routed around it, push failed),
   * the message falls back to a top-level post and the step's `__delivery`
   * outcome records `thread: 'parent_missing'`.
   * See docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
   */
  deliver: z
    .object({
      channelType: z.enum(['web', 'telegram', 'slack', 'whatsapp']),
      channelId: z.string().min(1).max(256),
      thread: z.object({ fromStep: stepIdSchema }).strict().optional(),
    })
    .optional(),
  /**
   * Session continuity. `per_run` (default) — each fire is a fresh consult.
   * `persistent` — the callee reuses one durable session keyed on the
   * workflow + step, so a recurring workflow accumulates history across
   * fires (the cron-session equivalent).
   * See docs/architecture/engine/scheduled-jobs.md → "Session continuity".
   */
  session: z.enum(['per_run', 'persistent']).optional(),
  /**
   * Optional research-depth override — a tier preset and/or numeric
   * overrides. Raises the callee's turn / tool-call / wall-clock caps for a
   * research-heavy step. See `packages/core/src/engine/research-depth.ts`.
   */
  depth: ResearchDepthConfigSchema.optional(),
  modelAlias: z.enum(['standard', 'pro', 'max']).optional(),
  researchMode: z.boolean().optional(),
  maxTurns: z.number().int().min(1).max(60).nullable().optional(),
  /**
   * The step's OUTPUT blueprint (blueprint output contract). On a research +
   * page-anchored step the executor runs the fan-out as the gather and the
   * synthesis engine fills the blueprint (record-first, page projected —
   * structural-synthesis P4). On any other step kind the callee is directed
   * to persist its deliverable as the blueprint's typed record via
   * `saveBlueprintRecord`. Either way the record stamps the run id, which the
   * next run reads as `{{lastRun.output.<key>}}`. The value is a blueprint
   * slug: a built-in skill id, a workspace skill slug, or a page-template id.
   * Absent → the step's output is unbound (free-form). See
   * docs/architecture/brain/structural-synthesis.md → "The record".
   */
  blueprintId: z.string().min(1).max(128).optional(),
})

// ── tool_call ───────────────────────────────────────────────────────────

const approvalSchema = z.object({
  deliveryChannel: z.enum(['web', 'telegram', 'slack', 'whatsapp']).optional(),
  expiresAfterHours: z.number().int().min(1).max(24 * 30).optional(),
})

const toolCallStepSchema = z.object({
  ...commonSchema,
  type: z.literal('tool_call'),
  toolName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'toolName must be a valid identifier.'),
  arguments: z.record(z.unknown()),
  approval: approvalSchema.optional(),
})

// ── wait ────────────────────────────────────────────────────────────────

const waitDurationSchema = z
  .object({
    minutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
    hours: z.number().int().min(0).max(24 * 30).optional(),
    days: z.number().int().min(0).max(30).optional(),
  })
  .refine(
    (d) => (d.minutes ?? 0) + (d.hours ?? 0) + (d.days ?? 0) > 0,
    'duration must be at least 1 minute total.',
  )

// Note: the "exactly one of until/at" check lives in `WorkflowDefinitionSchema`'s
// superRefine below, because `discriminatedUnion` rejects `.refine()`-wrapped
// objects (they're ZodEffects, not ZodObject).
const waitStepSchema = z.object({
  ...commonSchema,
  type: z.literal('wait'),
  until: z.object({ duration: waitDurationSchema }).optional(),
  at: z
    .object({
      datetime: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
          'datetime must be local ISO without offset (e.g. "2026-05-10T08:00:00").',
        ),
      timezone: z.string().min(1).max(64).optional(),
    })
    .optional(),
})

// ── branch ──────────────────────────────────────────────────────────────

// JSONLogic rule — accept any non-null object/array. Semantic validation
// happens at evaluation time in `condition.ts`.
//
// We deliberately do NOT annotate this as `z.ZodType<unknown>` because that
// collapses required-ness — Zod treats `unknown` as optional, which would
// make BranchStep.condition optional in the inferred type. The concrete
// union keeps it required.
const jsonLogicSchema = z.union([
  z.record(z.unknown()),
  z.array(z.unknown()),
  z.boolean(),
])

const branchStepSchema = z.object({
  ...commonSchema,
  type: z.literal('branch'),
  condition: jsonLogicSchema,
  nextStepIdIfTrue: stepIdSchema.nullable(),
  nextStepIdIfFalse: stepIdSchema.nullable(),
})

// ── send_page ───────────────────────────────────────────────────────────

/**
 * Recipient / subject source for `send_page`. Strict variants so an unknown
 * key fails loudly at authoring. `recordField` names a typed field on the
 * page's blueprint record; `literal` is a fixed string (interpolatable).
 */
const sendPageValueSourceSchema = z.union([
  z.object({ recordField: z.string().min(1).max(128) }).strict(),
  z.object({ literal: z.string().min(1).max(512) }).strict(),
])

/**
 * Deterministic verbatim send of a doc page (the page-action button lane).
 * No model call: body = the page's markdown export; to/subject come from the
 * page's blueprint record or literals. Runtime-gated to button-triggered
 * runs and executed via the `ExecutorDeps.sendPage` port (egress clearance
 * gate + `page_send_log` at-most-once claim + Gmail send live there).
 * See docs/architecture/features/page-actions.md → "send_page".
 */
const sendPageStepSchema = z.object({
  ...commonSchema,
  type: z.literal('send_page'),
  page: z.union([z.string().uuid(), interpolationTokenSchema]),
  via: z.literal('gmail'),
  to: sendPageValueSourceSchema,
  subject: sendPageValueSourceSchema,
  instanceId: z.string().min(1).max(256).optional(),
})

// ── Step union + definition ─────────────────────────────────────────────

export const WorkflowStepSchema = z.discriminatedUnion('type', [
  assistantCallStepSchema,
  toolCallStepSchema,
  waitStepSchema,
  branchStepSchema,
  sendPageStepSchema,
])

/**
 * A step, tolerating the JSON-string form. Models recurrently emit
 * JSON-SERIALISED step objects (`steps: ["{\"id\": \"step_1\", ...}"]`) —
 * 4 authoring failures in 14 prod days plus the 2026-07-07 incident
 * session's "Validation Probe" turns burned discovering the shape. A string
 * that parses to an object is unwrapped before validation; anything else
 * falls through to the normal discriminated-union error. See
 * docs/architecture/engine/tool-input-tolerance.md.
 */
const tolerantStepSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Invalid JSON — let the raw string hit the union for a normal error.
    }
  }
  return v
}, WorkflowStepSchema)

export const WorkflowDefinitionSchema = z
  .object({
    startStepId: stepIdSchema,
    steps: z.array(tolerantStepSchema).min(1).max(50),
  })
  .superRefine((def, ctx) => {
    // Step IDs must be unique.
    const seen = new Set<string>()
    for (const step of def.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step id: "${step.id}"`,
          path: ['steps'],
        })
      }
      seen.add(step.id)
    }

    // startStepId must reference an existing step.
    if (!seen.has(def.startStepId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `startStepId "${def.startStepId}" does not match any step.id`,
        path: ['startStepId'],
      })
    }

    // Every nextStepId reference (or branch if/else) must point to an existing
    // step or be null. Catches authoring typos before runtime.
    const refs: Array<{ from: string; to: string | null | undefined; field: string }> = []
    for (const step of def.steps) {
      if (step.type === 'branch') {
        refs.push({ from: step.id, to: step.nextStepIdIfTrue, field: 'nextStepIdIfTrue' })
        refs.push({ from: step.id, to: step.nextStepIdIfFalse, field: 'nextStepIdIfFalse' })
      } else if (step.nextStepId !== undefined) {
        refs.push({ from: step.id, to: step.nextStepId, field: 'nextStepId' })
      }
    }
    for (const ref of refs) {
      if (ref.to !== null && ref.to !== undefined && !seen.has(ref.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${ref.from}".${ref.field} references unknown step "${ref.to}"`,
          path: ['steps'],
        })
      }
    }

    // Wait steps must specify exactly one of `until` / `at` (lifted out of
    // the step schema because discriminatedUnion rejects ZodEffects).
    for (const step of def.steps) {
      if (step.type === 'wait') {
        const hasUntil = !!step.until
        const hasAt = !!step.at
        if (hasUntil === hasAt) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `wait step "${step.id}" must specify exactly one of \`until\` or \`at\`.`,
            path: ['steps'],
          })
        }
      }
    }

    // `page.fromStep` must reference an existing `assistant_call` step that
    // creates a page (`page.create === true`) and must not reference itself.
    // Mirrors the nextStepId reference checks above — catches the dangling
    // composition at authoring time instead of a `page_anchor_unresolved`
    // failure on every run.
    const createSteps = new Set(
      def.steps
        .filter(
          (s) =>
            s.type === 'assistant_call' &&
            s.page !== undefined &&
            'create' in s.page,
        )
        .map((s) => s.id),
    )
    for (const [i, step] of def.steps.entries()) {
      if (step.type !== 'assistant_call' || step.page === undefined) continue
      if (!('fromStep' in step.page)) continue
      const ref = step.page.fromStep
      if (ref === step.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".page.fromStep must not reference itself.`,
          path: ['steps', i, 'page', 'fromStep'],
        })
      } else if (!createSteps.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".page.fromStep references "${ref}", which is not an assistant_call step with page.create — only pages created by an earlier step this run can be anchored via fromStep.`,
          path: ['steps', i, 'page', 'fromStep'],
        })
      }
    }

    // `deliver.thread.fromStep` must reference a DIFFERENT assistant_call step
    // that delivers to the SAME channel — the thread parent is the message
    // that step posted this run. Also platform-gated: only Slack (thread_ts)
    // and Telegram (reply) support threaded replies. Mirrors the page.fromStep
    // checks — catches the dangling reference at authoring time instead of a
    // silent top-level fallback on every run.
    const deliverSteps = new Map(
      def.steps
        .filter((s) => s.type === 'assistant_call' && s.deliver !== undefined)
        .map((s) => [s.id, (s as { deliver: { channelType: string; channelId: string } }).deliver]),
    )
    for (const [i, step] of def.steps.entries()) {
      if (step.type !== 'assistant_call' || !step.deliver?.thread) continue
      const ref = step.deliver.thread.fromStep
      if (step.deliver.channelType !== 'slack' && step.deliver.channelType !== 'telegram') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".deliver.thread is only supported for slack (thread reply) and telegram (reply) deliveries — ${step.deliver.channelType} has no threaded replies.`,
          path: ['steps', i, 'deliver', 'thread'],
        })
        continue
      }
      if (ref === step.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".deliver.thread.fromStep must not reference itself.`,
          path: ['steps', i, 'deliver', 'thread', 'fromStep'],
        })
        continue
      }
      const parent = deliverSteps.get(ref)
      if (!parent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".deliver.thread.fromStep references "${ref}", which is not an assistant_call step with a \`deliver\` target — the thread parent must be a message an earlier deliver-step posts this run.`,
          path: ['steps', i, 'deliver', 'thread', 'fromStep'],
        })
      } else if (
        parent.channelType !== step.deliver.channelType ||
        parent.channelId !== step.deliver.channelId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".deliver.thread.fromStep references "${ref}", which delivers to a different channel (${parent.channelType} "${parent.channelId}" vs ${step.deliver.channelType} "${step.deliver.channelId}") — a thread reply must target the same channel as its parent message.`,
          path: ['steps', i, 'deliver', 'thread', 'fromStep'],
        })
      }
    }
  })

// ── Step-type tag list ──────────────────────────────────────────────────

export const STEP_TYPE_VALUES = WORKFLOW_STEP_TYPES

// ── Trigger config ──────────────────────────────────────────────────────

/**
 * Trigger configuration stored on `workflows.trigger` (mig 141).
 *
 * - `manual` — no auto-trigger; runs come from the `Run now` button or the
 *   `runWorkflow` chat tool.
 * - `schedule` — informational summary; the actual cron lives on a
 *   `scheduled_jobs` row with `workflow_id` set (mig 116). Saving the
 *   trigger keeps the two in sync via the workflows REST route.
 * - `webhook` — the receiver at `/api/workflow-webhooks/:slug` is enabled
 *   for this workflow. The slug + HMAC secret live in dedicated columns
 *   (`webhook_slug`, `webhook_secret`) so they can be rotated independently.
 *   An optional `match.condition` (JSONLogic over the parsed payload) lets the
 *   receiver fire on only specific events and ACK the rest with 200.
 * - `event` — fired when an event arrives on any subscribed source whose
 *   optional `match` filter passes. Sources are connector instances, channel
 *   integrations, and/or doc-page subtrees — all first-class.
 *   `createWorkflowEventDispatcher` dispatches. See workflow-builder.md
 *   §Event trigger.
 */
const triggerScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), datetime: z.string() }),
  z.object({ type: z.literal('daily'), time: z.string() }),
  z.object({
    type: z.literal('weekly'),
    days: z.array(z.string()),
    time: z.string(),
  }),
  z.object({
    type: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(31),
    time: z.string(),
  }),
  z.object({ type: z.literal('cron'), expression: z.string() }),
])

// Event-trigger source + match. Mirrors `EventSourceRef` / `EventMatch` /
// `EventSubscription` in `types.ts`.
const eventSourceRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connector'),
    connectorInstanceId: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('channel'),
    channelIntegrationId: z.string().min(1).max(128),
    channel: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('page'),
    // The watched page id. Fires when a page is created/moved directly under it,
    // or when it is itself updated. The lifecycle action is matched via
    // `inChannels`, not encoded here — `pageId` is the source identity. uuid-only
    // by design (the `PAGE_EVENT_ROOT` sentinel is not a valid subscription).
    pageId: z.string().uuid(),
  }),
  z.object({
    // Id-less: the workspace's task table. Lifecycle actions (created /
    // completed / blocked / reopened / assigned / tagged / updated) are
    // matched via `inChannels`; task tags via the task-only `tags` filter.
    type: z.literal('task'),
  }),
])

const eventMatchSchema = z.object({
  keywords: z.array(z.string().min(1).max(200)).max(64).optional(),
  fromActors: z.array(z.string().min(1).max(256)).max(128).optional(),
  inChannels: z.array(z.string().min(1).max(256)).max(128).optional(),
  mentions: z.array(z.string().min(1).max(256)).max(128).optional(),
  // Task-event tag filter — overlap semantics; full set on `created`, ADDED
  // set on updates. Only task events carry tags; a `tags` filter on other
  // source kinds never matches.
  tags: z.array(z.string().min(1).max(64)).max(64).optional(),
  fromBots: z.boolean().optional(),
})

// The discriminant values of `eventSourceRefSchema` ('connector' | 'channel' |
// 'page' | 'task'), read off the union's options so the flatten-tolerance below
// can never diverge from the actual source types (adding a variant to the union
// extends this automatically). Used only by the preprocessor.
const EVENT_SOURCE_TYPE_VALUES = new Set(
  eventSourceRefSchema.options.map((o) => o.shape.type.value as string),
)

/**
 * The canonical subscription is `{ source: { type, ... }, match? }`. The prod
 * chat model (gemini-3-flash-preview) intermittently emits a FLATTENED entry
 * instead — lifting the source's fields to the entry top level, e.g.
 * `{ type: 'task', match: {...} }` — which otherwise fails validation with
 * "Required" (no `source`). This regressed real task-tag event triggers (the
 * `wf-task-tag-event` eval probe). `normalizeEventSubscriptionShape` rewrites
 * the *unambiguous* flattened form back to the nested one BEFORE validation.
 *
 * The lift fires only when `source` is absent AND a top-level `type` is one of
 * the known source-type discriminants. `match` is the ONLY other legal
 * entry-level key, so every remaining key is a misplaced source field: the lift
 * pulls all non-`match` keys into `source` (so a flattened connector entry's
 * `connectorInstanceId` / `provider` land in `source`, not just `type`). Any
 * other shape — already-nested, or genuinely malformed with neither `source`
 * nor a valid `type` — is passed through untouched, so the canonical form keeps
 * validating unchanged and invalid input still fails loudly (an unknown `type`
 * is not lifted, so it can't be silently rewritten into a bogus source). See
 * docs/architecture/features/workflow.md → "Event trigger" (flattened-source
 * tolerance).
 */
function normalizeEventSubscriptionShape(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const obj = value as Record<string, unknown>
  if ('source' in obj) return value
  if (typeof obj.type !== 'string' || !EVENT_SOURCE_TYPE_VALUES.has(obj.type)) return value
  const { match, ...source } = obj
  return match === undefined ? { source } : { source, match }
}

// Exported so the goals acting loop's `waitForEvent` tool can validate the
// subscription an agent parks a goal on — the same `(source, match)` struct an
// `event`-trigger workflow subscribes with. Wrapped in `z.preprocess` so the
// flattened source shape the model sometimes emits is lifted before validation
// (see `normalizeEventSubscriptionShape`); the nested form is untouched.
export const EventSubscriptionSchema = z.preprocess(
  normalizeEventSubscriptionShape,
  z.object({
    source: eventSourceRefSchema,
    match: eventMatchSchema.optional(),
  }),
)

export const WorkflowTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.literal('schedule'),
    schedule: triggerScheduleSchema,
    timezone: z.string().min(1).max(64).optional(),
    /**
     * Timezone ownership — mirrors `scheduled_jobs.mode`. `'local'` (default)
     * pins the captured zone; `'user'` follows the user's current tz.
     */
    mode: z.enum(['local', 'user']).optional(),
    /**
     * Authoring sugar for a reminder's delivery: a channel TYPE only. The
     * create/update path resolves the concrete chat id + Telegram forum topic
     * from the session and stamps it onto the sole (or terminal)
     * `assistant_call` step's `deliver`. Multi-step workflows set per-step
     * `deliver` directly; a `trigger.delivery` on a multi-step workflow is an
     * authoring warning. `web` is never a delivery target.
     * See docs/architecture/features/workflow.md §3.
     */
    delivery: z.object({ channel: z.enum(['telegram', 'slack', 'whatsapp']) }).optional(),
    /**
     * Trigger-row behavioral policy — mirrors the `scheduled_jobs` columns
     * (`silent_until_fire`, `nag_interval_mins`, `nag_until_keyword`). Lives on
     * the trigger, not the workflow definition, because it governs *when/how to
     * re-fire*, not what the run does. The nag pair must be set together.
     */
    policy: z
      .object({
        silentUntilFire: z.boolean().optional(),
        nagIntervalMins: z.number().int().min(1).max(1440).optional(),
        nagUntilKeyword: z.string().min(1).max(50).optional(),
      })
      .refine(
        (p) => (p.nagIntervalMins === undefined) === (p.nagUntilKeyword === undefined),
        {
          message:
            'policy.nagIntervalMins and policy.nagUntilKeyword must be set together (or both omitted).',
        },
      )
      .optional(),
  }),
  z.object({
    kind: z.literal('webhook'),
    /**
     * Optional server-side event filter. When present, the receiver
     * (`/api/workflow-webhooks/:slug`) evaluates `match.condition` — the same
     * vendored JSONLogic the `branch` step uses (`condition.ts`) — against
     * `{ input: <parsed payload> }`. A falsy result ACKs 200 WITHOUT starting a
     * run (the delivery is acknowledged, just not acted on); a truthy or absent
     * filter fires the workflow. Lets one webhook slug react to only specific
     * events (e.g. `{ "==": [{ "var": "input.type" }, "deal.won"] }`) without a
     * leading `branch` step. Mirrors the `event` trigger's `match`, but
     * JSONLogic-shaped because a webhook payload is arbitrary JSON rather than a
     * normalized event.
     */
    match: z.object({ condition: jsonLogicSchema }).strict().optional(),
  }),
  z.object({
    kind: z.literal('event'),
    event: z.object({
      sources: z.array(EventSubscriptionSchema).min(1).max(20),
    }),
  }),
])

export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>

/**
 * Canonical capability lists for the trigger surface — the values the
 * model-facing authoring surfaces (the `trigger` input description in
 * `workflow/tools.ts` and the `workflow-builder` builtin skill) must
 * enumerate, closed-world. Declared next to the schemas and compile-time
 * asserted against them (below), so a new trigger kind or event source type
 * cannot ship without these lists — and therefore the model-facing text —
 * moving in the same change. The skill side of the pairing is graded by
 * `pnpm check` (capability-surface pairing).
 */
export const WORKFLOW_TRIGGER_KINDS = [
  'manual',
  'schedule',
  'webhook',
  'event',
] as const satisfies readonly WorkflowTrigger['kind'][]

export const WORKFLOW_EVENT_SOURCE_TYPES = [
  'connector',
  'channel',
  'page',
  'task',
] as const satisfies readonly z.infer<typeof EventSubscriptionSchema>['source']['type'][]

// Compile-time exhaustiveness: `satisfies` (above) rejects a wrong/extra
// member; these reject a MISSING one — adding a union variant without
// extending the matching list is a type error.
type AssertNever<T extends never> = T
type _TriggerKindsExhaustive = AssertNever<
  Exclude<WorkflowTrigger['kind'], (typeof WORKFLOW_TRIGGER_KINDS)[number]>
>
type _EventSourceTypesExhaustive = AssertNever<
  Exclude<
    z.infer<typeof EventSubscriptionSchema>['source']['type'],
    (typeof WORKFLOW_EVENT_SOURCE_TYPES)[number]
  >
>
