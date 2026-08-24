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
import type { ToolCallStep, WorkflowDefinition } from './types.js'
import { buildReachability, findCycle, parallelRegionSteps } from './graph.js'
import { ResearchDepthConfigSchema } from '../engine/research-depth.js'

// ── Step ID and common shape ────────────────────────────────────────────

const stepIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Step IDs must start with a letter and contain only letters, digits, _ or -.')

/**
 * Maximum fan-out width of one step. Each parallel branch is typically a
 * full assistant consult, so the width cap is a spend/concurrency guard,
 * not a parser limit.
 */
export const MAX_FAN_OUT_WIDTH = 5

const commonSchema = {
  id: stepIdSchema,
  description: z.string().max(280).optional(),
  // Scalar = sequential; ARRAY = parallel fan-out (every listed step starts
  // when this one completes; a downstream step reachable from several live
  // paths is the implicit join). Null = terminal.
  nextStepId: z
    .union([stepIdSchema, z.array(stepIdSchema).min(1).max(MAX_FAN_OUT_WIDTH)])
    .nullable()
    .optional(),
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
  deliver: z.union([
    z.object({
      channelType: z.enum(['web', 'telegram', 'slack', 'whatsapp', 'msteams', 'custom', 'feishu']),
      channelId: z.string().min(1).max(256),
      channelIntegrationId: z.string().uuid().optional(),
      thread: z.object({ fromStep: stepIdSchema }).strict().optional(),
    }).strict(),
    z.object({
      channelType: z.literal('whatsapp'),
      replyToTrigger: z.literal(true),
    }).strict(),
  ]).optional(),
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
  // Unlike a mutable connector policy, this is part of the workflow's
  // definition: every run must pause even when the tool otherwise resolves
  // to allow. The external-client reply boundary relies on this invariant.
  required: z.boolean().optional(),
  // Approval pings have no custom-channel renderer yet (approvals are out of
  // the custom-channel v1 scope); the enum stays narrower than deliver's.
  deliveryChannel: z.enum(['web', 'telegram', 'slack', 'whatsapp', 'msteams', 'feishu']).optional(),
  expiresAfterHours: z.number().int().min(1).max(24 * 30).optional(),
})

const toolCallStepSchema = z.object({
  ...commonSchema,
  type: z.literal('tool_call'),
  toolName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.:-]+$/, 'toolName contains unsupported characters.'),
  arguments: z.record(z.unknown()),
  approval: approvalSchema.optional(),
})

const REVIEWED_REPLY_TOOL = 'imapSendMessage'
const REVIEWED_REPLY_TO = '{{input.event.sender}}'
const REVIEWED_REPLY_SUBJECT = '{{input.event.subject}}'
const REVIEWED_REPLY_THREAD = '{{input.event.message_id}}'
const REVIEWED_REPLY_BODY_RE = /^\{\{vars\.([a-zA-Z][a-zA-Z0-9_]*)\}\}$/
const REVIEWED_REPLY_ARGUMENT_KEYS = new Set(['to', 'subject', 'body', 'inReplyTo', 'account'])

function canonicalToolName(toolName: string): string {
  const suffix = toolName.indexOf('__')
  return suffix === -1 ? toolName : toolName.slice(0, suffix)
}

/**
 * Structural contract for the only egress step accepted in an
 * external-client workflow. Exported so the executor can enforce the same
 * shape against legacy/directly persisted definitions at run time.
 */
export function reviewedClientReplyViolation(step: ToolCallStep): string | null {
  if (canonicalToolName(step.toolName) !== REVIEWED_REPLY_TOOL) {
    return 'only imapSendMessage may cross the reviewed external-client reply boundary'
  }
  if (step.approval?.required !== true) {
    return 'the reviewed IMAP reply must set approval.required to true'
  }
  const keys = Object.keys(step.arguments)
  const unknown = keys.find((key) => !REVIEWED_REPLY_ARGUMENT_KEYS.has(key))
  if (unknown) {
    return `the reviewed IMAP reply cannot set arguments.${unknown}`
  }
  const to = step.arguments.to
  if (!Array.isArray(to) || to.length !== 1 || to[0] !== REVIEWED_REPLY_TO) {
    return `the reviewed IMAP reply recipient must be exactly ["${REVIEWED_REPLY_TO}"]`
  }
  const subject = step.arguments.subject
  if (
    typeof subject !== 'string'
    || subject.split(REVIEWED_REPLY_SUBJECT).length !== 2
    || subject.replace(REVIEWED_REPLY_SUBJECT, '').includes('{{')
    || subject.replace(REVIEWED_REPLY_SUBJECT, '').includes('}}')
  ) {
    return `the reviewed IMAP reply subject must contain exactly one ${REVIEWED_REPLY_SUBJECT} token and no other interpolation`
  }
  if (typeof step.arguments.body !== 'string' || !REVIEWED_REPLY_BODY_RE.test(step.arguments.body)) {
    return 'the reviewed IMAP reply body must be exactly one {{vars.<draft>}} token'
  }
  if (step.arguments.inReplyTo !== REVIEWED_REPLY_THREAD) {
    return `the reviewed IMAP reply thread must be exactly "${REVIEWED_REPLY_THREAD}"`
  }
  if ('account' in step.arguments) {
    const account = step.arguments.account
    if (typeof account !== 'string' || !account.trim() || account.includes('{{') || account.includes('}}')) {
      return 'the reviewed IMAP reply account must be one literal connected mailbox address'
    }
  }
  return null
}

function reviewedReplyBodyVar(step: ToolCallStep): string | null {
  return typeof step.arguments.body === 'string'
    ? REVIEWED_REPLY_BODY_RE.exec(step.arguments.body)?.[1] ?? null
    : null
}

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

/**
 * Builder-canvas node position (board-space pixels). Keys of
 * `definition.layout` are step ids plus the reserved `__trigger` node.
 * Presentation only — the executor never reads it.
 */
const nodePositionSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict()

const externalUserIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'externalUserId contains control characters')

const externalClientWorkflowPrincipalSchema = z
  .object({
    kind: z.literal('api_external_client'),
    apiKeyId: z.string().uuid(),
    assistantId: z.string().uuid(),
    resolve: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('static'),
        externalUserId: externalUserIdSchema,
      }).strict(),
      z.object({
        kind: z.literal('event_sender_map'),
        clients: z.array(z.object({
          sender: z.string().email().max(320),
          externalUserId: externalUserIdSchema,
        }).strict()).min(1).max(500),
      }).strict(),
    ]),
  })
  .strict()

export const WorkflowDefinitionSchema = z
  .object({
    // Scalar = one entry step; ARRAY = trigger fan-out (every listed step
    // starts in parallel when the trigger fires) — same shape and width cap
    // as a step's nextStepId array.
    startStepId: z
      .union([stepIdSchema, z.array(stepIdSchema).min(1).max(MAX_FAN_OUT_WIDTH)]),
    steps: z.array(tolerantStepSchema).min(1).max(50),
    principal: externalClientWorkflowPrincipalSchema.optional(),
    layout: z.record(nodePositionSchema).optional(),
  })
  .superRefine((def, ctx) => {
    if (def.principal) {
      if (def.principal.resolve.kind === 'event_sender_map') {
        const senders = new Set<string>()
        for (const [i, client] of def.principal.resolve.clients.entries()) {
          const sender = client.sender.trim().toLowerCase()
          if (senders.has(sender)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `client principal sender map contains duplicate sender "${sender}".`,
              path: ['principal', 'resolve', 'clients', i, 'sender'],
            })
          }
          senders.add(sender)
        }
      }

      const reachability = buildReachability(def as WorkflowDefinition)
      const reviewedReplies = def.steps.filter((step) => step.type === 'tool_call')
      if (reviewedReplies.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'an external-client workflow may contain at most one reviewed IMAP reply step.',
          path: ['steps'],
        })
      }
      for (const [i, step] of def.steps.entries()) {
        if (step.type === 'tool_call') {
          const violation = reviewedClientReplyViolation(step)
          if (violation) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `external-client workflow step "${step.id}" is not a valid reviewed reply: ${violation}.`,
              path: ['steps', i],
            })
            continue
          }
          const bodyVar = reviewedReplyBodyVar(step)
          const producer = bodyVar
            ? def.steps.find((candidate) =>
                candidate.type === 'assistant_call'
                && candidate.storeOutputAs === bodyVar
                && reachability.get(candidate.id)?.has(step.id),
              )
            : undefined
          if (!producer) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `external-client reviewed reply step "${step.id}" must take its body from a reachable ` +
                'preceding assistant_call storeOutputAs variable.',
              path: ['steps', i, 'arguments', 'body'],
            })
          }
          continue
        }
        if (step.type !== 'assistant_call' && step.type !== 'branch') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `external-client workflow step "${step.id}" must be assistant_call, branch, or a structurally reviewed IMAP reply; ` +
              'the principal-bound model lane has no other tool, wait, send, or page egress.',
            path: ['steps', i, 'type'],
          })
          continue
        }
        if (step.type !== 'assistant_call') continue

        if (
          step.target.assistantId !== 'primary'
          && step.target.assistantId !== def.principal.assistantId
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `external-client workflow step "${step.id}" targets assistant ${step.target.assistantId}, ` +
              `but the inherited API key belongs to ${def.principal.assistantId}.`,
            path: ['steps', i, 'target', 'assistantId'],
          })
        }

        const forbidden: Array<[unknown, string]> = [
          [step.target.capabilityId, 'target.capabilityId'],
          [step.skills?.length ? step.skills : undefined, 'skills'],
          [step.enforcedSkills?.length ? step.enforcedSkills : undefined, 'enforcedSkills'],
          [step.page, 'page'],
          [step.deliver, 'deliver'],
          [step.session === 'persistent' ? step.session : undefined, 'session'],
          [step.depth, 'depth'],
          [step.researchMode === true ? step.researchMode : undefined, 'researchMode'],
          [step.blueprintId, 'blueprintId'],
        ]
        for (const [value, field] of forbidden) {
          if (value === undefined) continue
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `external-client workflow step "${step.id}" cannot set ${field}; ` +
              'the principal-bound lane is an isolated, non-delivering draft consult.',
            path: ['steps', i, ...field.split('.')],
          })
        }
      }
    }

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

    // Every startStepId entry must reference an existing step; a trigger
    // fan-out array must also list distinct entries.
    const starts = Array.isArray(def.startStepId) ? def.startStepId : [def.startStepId]
    for (const start of starts) {
      if (!seen.has(start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `startStepId "${start}" does not match any step.id`,
          path: ['startStepId'],
        })
      }
    }
    for (const dupe of new Set(starts.filter((id, i) => starts.indexOf(id) !== i))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `startStepId lists "${dupe}" more than once — trigger fan-out entries must be distinct.`,
        path: ['startStepId'],
      })
    }

    // Every nextStepId reference (or branch if/else, or fan-out array entry)
    // must point to an existing step or be null. Catches authoring typos
    // before runtime.
    const refs: Array<{ from: string; to: string | null | undefined; field: string }> = []
    for (const step of def.steps) {
      if (step.type === 'branch') {
        refs.push({ from: step.id, to: step.nextStepIdIfTrue, field: 'nextStepIdIfTrue' })
        refs.push({ from: step.id, to: step.nextStepIdIfFalse, field: 'nextStepIdIfFalse' })
      } else if (Array.isArray(step.nextStepId)) {
        // Fan-out: every entry must exist and entries must be distinct.
        const dupes = step.nextStepId.filter((id, i) => step.nextStepId!.indexOf(id) !== i)
        for (const dupe of new Set(dupes)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.id}".nextStepId lists "${dupe}" more than once — fan-out targets must be distinct.`,
            path: ['steps'],
          })
        }
        for (const [k, to] of step.nextStepId.entries()) {
          refs.push({ from: step.id, to, field: `nextStepId[${k}]` })
        }
      } else if (step.nextStepId !== undefined) {
        refs.push({ from: step.id, to: step.nextStepId, field: 'nextStepId' })
      }
    }
    let hasDanglingRef = false
    for (const ref of refs) {
      if (ref.to !== null && ref.to !== undefined && !seen.has(ref.to)) {
        hasDanglingRef = true
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${ref.from}".${ref.field} references unknown step "${ref.to}"`,
          path: ['steps'],
        })
      }
    }

    // The execution graph must be a DAG. Cycles never worked — the linear
    // executor would loop a run forever (bounded only by consult budgets) —
    // and the parallel scheduler's join rule ("run when no live path can
    // still reach me") requires acyclicity to guarantee progress. Skipped
    // when a reference dangles: the graph walk drops unknown edges, so its
    // verdict would be about a different graph than the author wrote.
    if (!hasDanglingRef) {
      const cycle = findCycle(def as WorkflowDefinition)
      if (cycle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `workflow steps form a cycle (${cycle.join(' → ')}). Runs execute each step at most once — ` +
            `for iteration, use a recurring trigger with {{lastRun.*}} instead.`,
          path: ['steps'],
        })
      }

      // Pause-capable steps cannot sit inside a parallel region (reachable
      // from one fan-out edge but not a sibling edge): a `wait` pauses the
      // WHOLE run while the sibling path is still executing, which the
      // single-cursor resume model cannot represent. The executor's
      // pause-while-parallel guard is the authoritative runtime backstop
      // (a branch can route around a static convergence).
      if (!cycle) {
        const unsafe = parallelRegionSteps(def as WorkflowDefinition)
        for (const [i, step] of def.steps.entries()) {
          if (step.type === 'wait' && unsafe.has(step.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `wait step "${step.id}" sits on a parallel branch that a sibling branch never rejoins — ` +
                `a wait cannot pause the run while sibling steps are still executing. ` +
                `Move it before the fan-out or after the join.`,
              path: ['steps', i],
            })
          }
        }
      }
    }

    // Layout keys must reference real steps (or the reserved __trigger node)
    // so a renamed/removed step cannot leave phantom coordinates behind.
    if (def.layout) {
      for (const key of Object.keys(def.layout)) {
        if (key !== '__trigger' && !seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `layout references unknown step "${key}"`,
            path: ['layout', key],
          })
        }
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

    // Bot integrations are part of Telegram and Feishu delivery identity.
    // Reject inert ids on other channel types instead of persisting a
    // selection runtime would ignore.
    for (const [i, step] of def.steps.entries()) {
      if (
        step.type === 'assistant_call' &&
        step.deliver &&
        'channelIntegrationId' in step.deliver &&
        step.deliver.channelIntegrationId &&
        step.deliver.channelType !== 'telegram' &&
        step.deliver.channelType !== 'feishu'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".deliver.channelIntegrationId is only supported for telegram and feishu delivery.`,
          path: ['steps', i, 'deliver', 'channelIntegrationId'],
        })
      }
    }

    // `deliver.thread.fromStep` must reference a DIFFERENT assistant_call step
    // that delivers to the SAME channel — the thread parent is the message
    // that step posted this run. Also platform-gated: Slack (thread_ts),
    // Telegram (reply), and Feishu (reply_in_thread) support threaded replies. Mirrors the page.fromStep
    // checks — catches the dangling reference at authoring time instead of a
    // silent top-level fallback on every run.
    const deliverSteps = new Map(
      def.steps
        .filter((s) =>
          s.type === 'assistant_call' &&
          s.deliver !== undefined &&
          'channelId' in s.deliver,
        )
        .map((s) => [s.id, (s as { deliver: {
          channelType: string
          channelId: string
          channelIntegrationId?: string
        } }).deliver]),
    )
    for (const [i, step] of def.steps.entries()) {
      if (
        step.type !== 'assistant_call' ||
        !step.deliver ||
        !('thread' in step.deliver) ||
        !step.deliver.thread
      ) continue
      const ref = step.deliver.thread.fromStep
      if (step.deliver.channelType !== 'slack' && step.deliver.channelType !== 'telegram' && step.deliver.channelType !== 'feishu') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}".deliver.thread is only supported for slack, telegram, and feishu deliveries — ${step.deliver.channelType} has no threaded replies.`,
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
        parent.channelId !== step.deliver.channelId ||
        parent.channelIntegrationId !== step.deliver.channelIntegrationId
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
  z.object({
    // Id-less: the workspace's knowledge base (every source + manual
    // entries). Lifecycle actions (created / updated / deleted) are matched
    // via `inChannels`; the entry's frontmatter tags via `tags`; its title
    // via `keywords`. Path-prefix scoping rides a `branch` step off
    // `{{input.event.path}}`, not `match`.
    type: z.literal('knowledge'),
  }),
  z.object({
    // Id-less: the workspace's brand records. Lifecycle actions (created /
    // updated / approved / superseded) are matched via `inChannels`; the
    // brand slug via `tags` (the multi-brand scoping axis); its name via
    // `keywords`.
    type: z.literal('brand'),
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
    delivery: z.object({ channel: z.enum(['telegram', 'slack', 'whatsapp', 'feishu']) }).optional(),
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
  'knowledge',
  'brand',
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
