import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { JobStore } from './types.js'
import { computeNextRun, type StructuredSchedule } from './schedule.js'
import type { WorkflowStore } from '../workflow/types.js'
import { buildOneStepReminderWorkflow, frameSchedulerPrompt, type ReminderDeliverTarget } from '../workflow/one-step.js'
import { generateWorkflowTitle } from '../workflow/auto-title.js'
import { ResearchDepthConfigSchema } from '../engine/research-depth.js'
import type { LLMProvider } from '../providers/types.js'
import type { DeliverToChannel } from '../workflow/executor.js'
import type {
  DeliveryTargetLabel,
  DeliveryTargetResolver,
  ViewWorkspaceResolver,
} from './delivery-resolution.js'
import {
  coerceDeliverChannel,
  describeDelivery,
  formatRelativeTime,
  resolveDeliveryChannel,
  resolveTargetView,
  sendDeliveryConfirmation,
} from './delivery-resolution.js'

// Back-compat re-export: the delivery-target + view-resolver types moved to
// delivery-resolution.ts (shared with the workflow authoring path), but
// external callers (apps/api wiring, scheduling/index.ts) import them here.
// See docs/plans/scheduling-authoring-unification.md §3.
export type { DeliveryTargetLabel, DeliveryTargetResolver, ViewWorkspaceResolver }

const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), datetime: z.string().describe('Datetime in the user\'s local timezone (no Z or offset), e.g. 2026-04-09T15:30:00. The timezone param handles UTC conversion.') }),
  z.object({ type: z.literal('daily'), time: z.string().describe('HH:MM in 24h format') }),
  z.object({ type: z.literal('weekly'), days: z.array(z.string()).describe('Day names: monday, tuesday, etc.'), time: z.string() }),
  z.object({ type: z.literal('monthly'), dayOfMonth: z.number().min(1).max(31), time: z.string() }),
  z.object({ type: z.literal('cron'), expression: z.string().describe('Cron expression: min hour dom month dow') }),
])

// Delivery channel coercion, target-label resolution, the confirmation ping,
// the channel-id resolver, and the relative-time formatter live in
// ./delivery-resolution.ts — shared with the workflow authoring path so a
// reminder's delivery resolves identically however it was authored.

/**
 * Dependencies for the scheduling tools.
 *
 * Post-cutover (scheduling ⇄ workflow unification) a scheduled job is a
 * `scheduled_jobs` trigger row + a one-step `assistant_call` workflow.
 * `createScheduledJob` builds both; the model-facing tool schemas are
 * unchanged. See docs/architecture/engine/scheduled-jobs.md → "Unified
 * execution model".
 */
export type SchedulingToolDeps = {
  jobStore: JobStore
  workflowStore: WorkflowStore
  /**
   * Optional — when supplied, `createScheduledJob` runs the workflow
   * auto-titler against `instructions + schedule` right after the trigger
   * row + one-step workflow are persisted. The resulting title overwrites
   * the `Scheduled reminder` placeholder via `workflowStore.updateAutoName`.
   * Bounded by `AUTO_TITLE_TIMEOUT_MS` so a slow Flash-Lite call can never
   * stall the tool reply. Absent in tests / non-API call sites — the
   * scheduling tools degrade silently to the placeholder.
   */
  provider?: LLMProvider
  /**
   * Optional — resolves a job's stored `(channelType, channelId)` into a
   * human-readable delivery target the tools echo back as `deliveryTarget`,
   * so the model can tell the user the EXACT chat + Telegram forum topic a
   * scheduled update will post to instead of a bare channel type. This is
   * what closes the "is it really going to this topic?" confidence gap — the
   * `deliveryChannel` input is type-only by design, but the resolved label
   * names the captured group/topic. Injected by the API from the seen-chats
   * inventory (`packages/api/src/scheduling/delivery-target.ts`); absent in
   * tests → the tools fall back to the bare channel type.
   * See docs/architecture/engine/scheduled-jobs.md → "Delivery-target capture".
   */
  resolveDeliveryTarget?: DeliveryTargetResolver
  /**
   * Optional — when supplied, an explicit `deliveryChannel` set to a
   * messaging channel (telegram/slack/whatsapp) posts a one-line confirmation
   * ping into that exact channel/topic, exercising the same delivery path the
   * job uses on fire. This is proof-by-demonstration that topic routing is
   * correct — the user sees the message land in the right thread now instead
   * of waiting for the next scheduled run. Best-effort: a failed ping never
   * fails the tool. Reuses the workflow channel-delivery executor dep.
   */
  deliverToChannel?: DeliverToChannel
  /**
   * Optional — validates a candidate doc-page target (`view_id`, migration
   * 229) before it's stored on the job. Returns the page's `workspaceId` (so
   * the tool can confirm it matches the scheduling context's workspace) or
   * `null` when the page doesn't exist / isn't visible to the user. Injected
   * by the API from `savedViewStore.getById` (RLS-scoped). When absent (tests,
   * non-doc call sites) the captured `docViewId` / `targetViewId` is
   * trusted as-is — the FK still enforces referential integrity. This guards
   * the *explicit* `targetViewId` override against a hallucinated / cross-
   * workspace id, which would otherwise fail the INSERT and error the whole
   * job. See docs/architecture/engine/scheduled-jobs.md → "Doc page target".
   */
  resolveViewWorkspace?: ViewWorkspaceResolver
}

/**
 * Synchronous budget for the workflow auto-titler. Keep generous enough for
 * a Flash-Lite stream (typically 300–600ms) but small enough that a stuck
 * provider can't visibly delay createScheduledJob's tool reply.
 */
const AUTO_TITLE_TIMEOUT_MS = 5_000

export function createSchedulingTools(deps: SchedulingToolDeps): {
  createScheduledJob: Tool
  updateScheduledJob: Tool
  searchScheduledJobs: Tool
  deleteScheduledJob: Tool
} {
  const { jobStore, workflowStore } = deps

  /**
   * Is this a scheduled WORKFLOW-TRIGGER row? Structural discriminator from
   * scheduled-trigger.ts: triggers carry `channelType='workflow'` and no
   * step-run id (wait wake-ups carry one; one-step reminders carry a
   * delivery channel type). These rows fire a workspace-scoped workflow, so
   * they get workspace-level visibility + management.
   */
  function isWorkflowTriggerJob(job: {
    workflowId: string | null
    channelType: string
    workflowStepRunId: string | null
  }): boolean {
    return job.workflowId !== null && job.channelType === 'workflow' && job.workflowStepRunId === null
  }

  /**
   * Authorization for update/delete: the OWNER always; a workspace TEAMMATE
   * only for workflow-trigger jobs whose workflow lives in the session's
   * workspace (the workspace-member-scoped `workflowStore.getById` read is
   * the membership proof — the same authority that lets any member disable
   * the workflow itself in the builder). Everything else: not managed —
   * including a teammate's personal reminders, and any job in a foreign
   * tenant. This is also the tools' ownership check, full stop: the store's
   * `get`/`update`/`delete` are system-level by-id queries, so before this
   * gate the tools never verified the caller owned the job at all.
   */
  async function canManageJob(
    job: import('./types.js').ScheduledJob,
    context: { userId: string; workspaceId?: string | null },
  ): Promise<boolean> {
    if (job.userId === context.userId) return true
    if (!context.workspaceId || !isWorkflowTriggerJob(job)) return false
    const workflow = await workflowStore.getById(context.userId, job.workflowId!)
    return !!workflow && workflow.workspaceId === context.workspaceId
  }

  const createScheduledJob = buildTool({
    // Folded into the workflow surface: scheduling is a workflow trigger, not a
    // separate concept. Hidden from the model (it creates/schedules via
    // createWorkflow with `trigger`), but kept callable for back-compat / tests
    // / the forwarding path. See docs/plans/scheduling-authoring-unification.md.
    hiddenFromModel: true,
    name: 'createScheduledJob',
    description: 'DEPRECATED — prefer `createWorkflow` with `trigger: { kind: "schedule", schedule, timezone?, delivery: { channel }, policy? }`, which creates the reminder (a 1-step scheduled workflow) in ONE call. This tool builds the identical 1-step scheduled workflow under the hood and is retained for back-compat; never pair it with createWorkflow/scheduleWorkflow for the same reminder. Create a scheduled job. Supports one-time (type="once" with ISO datetime) and recurring (daily/weekly/monthly/cron). Use "once" for reminders like "in 5 minutes". IMPORTANT: Before computing dates for "today", "tomorrow", "next Monday", etc., use the current date from User Context. If unsure, call getTime first. Never guess the date. ALWAYS confirm the schedule with the user before creating. When the result includes a relativeTime field, mention it (e.g. "I\'ll remind you in 3 hours") so the user can catch timezone mistakes. When deliveryChannel differs from the current channel, tell the user where the reminder will be sent (e.g. "I\'ll send it via Telegram").\n\nDelivery target: the result includes a `deliveryTarget.label` naming the EXACT chat and Telegram forum topic the job will post to (e.g. \'Telegram · group "GM Bro" · topic "Research"\'). Surface it verbatim so the user can confirm the destination — do NOT hedge about whether topic-level delivery works; it does, and the label proves it.\n\nTimezone: usually omit. The user\'s current timezone is auto-detected from their request context, so bare times like "remind me at 2pm" bind correctly. Only pass timezone when the user explicitly names a zone ("2pm Hong Kong time").\n\nPolicy fields (silentUntilFire, nagIntervalMins, nagUntilKeyword): set these instead of saving a free-text preference memory when the user attaches a behavioural rule to the job. silentUntilFire=true tells the system not to pre-announce or echo the upcoming fire in unrelated turns. nagIntervalMins + nagUntilKeyword together implement "remind every N min until they reply <keyword>" without the model having to chain follow-up jobs by hand.',
    inputSchema: z.object({
      schedule: scheduleSchema,
      timezone: z.string().optional().describe('IANA timezone, e.g., Asia/Tokyo. Omit unless the user explicitly named a zone — the tool defaults to the user\'s current timezone.'),
      instructions: z.string().describe('What to do on each run'),
      deliveryChannel: z.enum(['telegram', 'slack', 'whatsapp']).optional().describe('Channel TYPE to deliver the result to. Omit to use the preferred messaging channel (auto-detected). When set to a messaging channel while the user is chatting on that channel, delivery is pinned to the EXACT current chat — including the Telegram forum topic the user is in — captured automatically from the session. You do not (and cannot) pass a chat id or topic id; this enum is type-only by design. Setting a messaging channel also posts a confirmation ping into that chat/topic so the user can see where the update will land.\n\nResults are NEVER delivered to the web chat (the web UI is a pull surface, not a notification channel). If the user has no messaging channel connected and is not scheduling a doc-page update, the job cannot be created — tell them to connect Telegram, Slack, or WhatsApp first. When the user schedules from a doc page, the job updates that page in place and delivers nothing to a channel.'),
      silentUntilFire: z.boolean().optional().describe('When true, the assistant will not pre-announce, echo, or count down to this job in unrelated turns. Set this when the user explicitly says "don\'t mention it before then" or similar — store the rule on the job, not in memory.'),
      nagIntervalMins: z.number().int().min(1).max(1440).optional().describe('For "remind every N min until done" patterns. Set together with nagUntilKeyword. Leave unset for single-fire jobs.'),
      nagUntilKeyword: z.string().min(1).max(50).optional().describe('Resolution signal — the chat route stops the nag when the user reply contains this keyword (case-insensitive). Required when nagIntervalMins is set.'),
      depth: ResearchDepthConfigSchema.optional().describe('Research depth for the job\'s agentic run. Omit for a normal quick turn. Set { "tier": "deep" } for a research-heavy recurring job (e.g. daily investor scouting or market scans) so each run can search and read across many sources rather than ~2 cycles. Numeric overrides (maxTurns, maxToolCalls, timeoutMs) fine-tune within a tier.'),
      modelAlias: z.enum(['standard', 'pro', 'max']).optional().describe('Model tier for each run. Omit to use the default (Pro) — scheduled jobs run on Pro because a recurring brief/scan is worth the stronger model. Pass "standard" only for a trivial, high-frequency reminder where cost matters more than quality, or "max" for a heavy research/synthesis job.'),
      targetViewId: z.string().uuid().optional().describe('Doc page (a saved-view UUID) this recurring job maintains — set it when the job\'s purpose is to refresh or append to a specific page on a schedule, so that page shows a "scheduled" badge linking back to this job. Usually you can omit it: when the user schedules from inside a doc page, the open page is captured automatically. Pass it explicitly only to target a DIFFERENT page than the one in view (e.g. a page you just created this turn). Ignored for non-doc jobs (reminders, messaging-channel updates).'),
    }),

    async execute(input, context) {
      const schedule = input.schedule as StructuredSchedule
      // Prefer an explicit model-supplied tz only when the user named one.
      // Otherwise use the tool context's userTimezone, resolved per-request
      // from the client header / users.timezone.
      const timezone = input.timezone ?? context.userTimezone ?? 'UTC'
      const nextRunAt = computeNextRun(schedule, timezone)

      // A scheduled job is a one-step workflow + a trigger row; the workflow
      // row is workspace-scoped. Every assistant has a workspace (CHECK
      // `assistants_workspace_required`), so this guard should never fire —
      // it stays as a defensive mirror of the `scheduleWorkflow` tool.
      if (!context.workspaceId) {
        return {
          data: 'Scheduled jobs require a workspace-scoped chat. This assistant is not bound to a workspace.',
          isError: true,
        }
      }

      // Validation: nagIntervalMins requires nagUntilKeyword (and vice versa).
      const hasInterval = input.nagIntervalMins !== undefined
      const hasKeyword = input.nagUntilKeyword !== undefined
      if (hasInterval !== hasKeyword) {
        return {
          data: 'nagIntervalMins and nagUntilKeyword must be set together (or both omitted).',
          isError: true,
        }
      }

      // Per-user enabled-recurring cap (2026-05 nag-chain collapse). A
      // single user with one nag-pattern reminder (15-min interval) could
      // accumulate thousands of `scheduled_jobs` rows before the chain
      // collapse — at 4,839 rows the chat-side `searchScheduledJobs` tool
      // returned more text than the Gemini 1M-token context could hold and
      // every "show me my reminders" turn 400'd. Capping at 100 actively-
      // firing recurring schedules per user is well above any human use
      // case but bounds the worst-case row growth. Once-jobs reap on
      // completion and don't count against the cap. Disabled rows are
      // GC'd nightly by the cleanup worker.
      if (schedule.type !== 'once') {
        const enabledRecurring = await jobStore.countEnabledRecurring(context.userId)
        if (enabledRecurring >= 100) {
          return {
            data: 'You have reached the cap of 100 active recurring reminders. Use searchScheduledJobs to find and delete unused ones first.',
            isError: true,
          }
        }
      }

      // Doc page link (migration 229). Capture the page the chat is
      // anchored to (`context.docViewId`) unless the model named a
      // different one (`targetViewId`); validated against the context's
      // workspace so a stale/foreign id is dropped rather than failing the job.
      // Resolved before the channel decision: a doc-page job is the one
      // case where a web-context job is still allowed (the page is its surface).
      const viewId = await resolveTargetView(deps.resolveViewWorkspace, input.targetViewId ?? context.docViewId, context)

      // Resolve delivery channel: explicit override > preferred messaging channel > current channel.
      const { channelType: deliveryChannelType, channelId: deliveryChannelId } =
        resolveDeliveryChannel(context, input.deliveryChannel)

      // Web is not a delivery target. The web UI is a pull surface, so pushing
      // a scheduled result here only landed an unsolicited message in the
      // user's main chat thread. A job that resolves to web (a web/cron/
      // assistant-call session with no preferred messaging channel) is allowed
      // ONLY when it maintains a doc page — then the page IS the output
      // surface and the one-step workflow omits `deliver` entirely (the channel
      // push is a no-op for web anyway; see
      // packages/api/src/workflow/channel-delivery.ts). Otherwise the job is
      // rejected so the user is told to connect a channel instead of silently
      // scheduling a job that delivers nowhere.
      // See docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
      const coercedChannel = coerceDeliverChannel(deliveryChannelType)
      let deliver: ReminderDeliverTarget | undefined
      let rowChannelType: string
      let rowChannelId: string
      if (coercedChannel === 'web') {
        if (!viewId) {
          return {
            data: 'Scheduled results are not delivered to the web chat. Connect a messaging channel (Telegram, Slack, or WhatsApp) and schedule from there, or schedule from a doc page so the job updates that page in place.',
            isError: true,
          }
        }
        // Doc-maintaining job: run silently and patch the page via tools;
        // nothing is pushed to a channel. 'doc' is a row sentinel (like the
        // 'workflow' sentinel), never a deliver target.
        deliver = undefined
        rowChannelType = 'doc'
        rowChannelId = viewId
      } else {
        deliver = { channelType: coercedChannel, channelId: deliveryChannelId }
        rowChannelType = coercedChannel
        rowChannelId = deliveryChannelId
      }

      // Build the one-step assistant_call workflow this job fires. Mirror the
      // schedule onto the workflow's `trigger` (same lockstep `scheduleWorkflow`
      // does) so the builder shows "Scheduled" instead of a misleading
      // "Manual" — every scheduled job used to create a `trigger: manual`
      // workflow that nonetheless fired on a schedule (the drift the user sees).
      const workflowId = await buildOneStepReminderWorkflow(workflowStore, {
        userId: context.userId,
        workspaceId: context.workspaceId,
        assistantId: context.assistantId,
        instructions: input.instructions,
        deliver,
        depth: input.depth,
        modelAlias: input.modelAlias,
        trigger: { kind: 'schedule', schedule, timezone },
      })

      const job = await jobStore.create({
        assistantId: context.assistantId,
        userId: context.userId,
        schedule,
        timezone,
        // Every new job starts as 'local' (pinned to the tz captured above).
        // Transitions to 'user' happen only via updateScheduledJob.
        mode: 'local',
        // `instructions` is preserved on the trigger row — it is informational
        // (searchScheduledJobs) and the rollback source of truth. The workflow
        // step prompt is the framed, executed copy.
        instructions: input.instructions,
        channelType: rowChannelType,
        channelId: rowChannelId,
        nextRunAt,
        silentUntilFire: input.silentUntilFire,
        nagIntervalMins: input.nagIntervalMins ?? null,
        nagUntilKeyword: input.nagUntilKeyword ?? null,
        workflowId,
        viewId,
      })

      // Auto-title the underlying workflow (mig 202). `buildOneStepReminderWorkflow`
      // stamps the placeholder name "Scheduled reminder" — replace it with a
      // short LLM-generated title derived from the instructions + cadence so
      // listings (`searchScheduledJobs`, the workflow board, audit logs) carry
      // signal. Bounded by AUTO_TITLE_TIMEOUT_MS so a stuck provider can't
      // delay the tool reply; on timeout / failure the placeholder stays.
      let autoTitle: string | null = null
      if (deps.provider) {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), AUTO_TITLE_TIMEOUT_MS)
        try {
          const result = await generateWorkflowTitle(
            deps.provider,
            {
              instructions: input.instructions,
              schedule,
              timezone,
            },
            ac.signal,
          )
          if (result.title) {
            const written = await workflowStore.updateAutoName(
              context.userId,
              workflowId,
              result.title,
            )
            if (written) autoTitle = result.title
          }
        } catch (err) {
          console.warn('[scheduling/auto-title] failed:', err)
        } finally {
          clearTimeout(timer)
        }
      }

      const delivery = await describeDelivery(deps.resolveDeliveryTarget, {
        assistantId: context.assistantId,
        channelType: rowChannelType,
        channelId: rowChannelId,
      })

      // Confirmation ping: only when the user *deliberately* routed to a
      // messaging channel (explicit deliveryChannel). For a plain "remind me
      // here" — no override, delivery == current session — the reminder
      // itself is the proof, so a separate ping would just be noise.
      const confirmationSent = input.deliveryChannel
        ? await sendDeliveryConfirmation(deps.deliverToChannel, {
            workspaceId: context.workspaceId,
            assistantId: context.assistantId,
            userId: context.userId,
            channelType: rowChannelType,
            channelId: rowChannelId,
            nextRunAt,
            label: delivery.deliveryTarget?.label,
          })
        : false

      return {
        data: {
          id: job.id,
          title: autoTitle,
          schedule: input.schedule,
          nextRun: nextRunAt.toISOString(),
          ...formatRelativeTime(nextRunAt),
          ...delivery,
          currentChannel: context.channelType,
          confirmationSent,
          instructions: input.instructions,
          // Echo the linked doc page so the model can tell the user the
          // schedule now shows on that page. Null when not a doc-page job.
          targetViewId: job.viewId,
          mode: job.mode,
          timezone: job.timezone,
          silentUntilFire: job.silentUntilFire,
          nagIntervalMins: job.nagIntervalMins,
          nagUntilKeyword: job.nagUntilKeyword,
        },
      }
    },
  })

  const updateScheduledJob = buildTool({
    // Hidden from the model: rescheduling / policy / enable-disable / delivery /
    // tz-mode are all covered by `updateWorkflow` (it patches `trigger` +
    // `enabled`, and the trigger schema carries schedule/timezone/mode/delivery/
    // policy). Kept callable for back-compat. Scheduling = a workflow trigger.
    hiddenFromModel: true,
    name: 'updateScheduledJob',
    description: 'Update a scheduled job (schedule, instructions, delivery channel, timezone mode, enable/disable, or policy fields). The job keeps its existing timezone unless you explicitly change it. When the response includes a relativeTime field, mention it so the user can catch timezone mistakes (e.g. "I\'ll run it in 3 hours").\n\nDelivery channel: setting deliveryChannel to telegram/slack/whatsapp while the user is chatting on that channel re-pins the job to the EXACT current chat and Telegram forum topic — captured automatically from the session, no chat/topic id needed or accepted. The result echoes a `deliveryTarget.label` naming the resolved group/topic (surface it so the user can confirm), and a confirmation ping is posted into that channel so the user sees exactly where the update will land. This is the correct way to answer "send my scheduled update to this Telegram topic instead": call updateScheduledJob with deliveryChannel:"telegram" from within that topic. Do not claim topic-level delivery is unsupported or needs extra configuration — it is captured automatically.\n\nMode semantics:\n- "local" (default) — the job is pinned to a specific timezone. On travel, the user is offered the choice to rebase, keep, or float.\n- "user" — the job follows the user\'s current timezone. Useful for "remind me each morning" style reminders that should track the user wherever they are. When flipping a job to "user", pass mode="user" and omit timezone — the tool syncs it to the user\'s current tz automatically.\n\nPolicy fields (silentUntilFire, nagIntervalMins, nagUntilKeyword): use this tool — NOT saveMemory — when the user attaches a behavioural rule to an existing job. e.g. "don\'t mention the pill before 2pm" → set silentUntilFire=true. "nag every 15 min until I say done" → set nagIntervalMins=15, nagUntilKeyword="done". Storing these as memories instead pollutes the per-turn memory index.\n\nTo clear nag fields, pass null explicitly: { nagIntervalMins: null, nagUntilKeyword: null }.',
    inputSchema: z.object({
      jobId: z.string().describe('Job ID to update'),
      schedule: scheduleSchema.optional(),
      timezone: z.string().optional(),
      mode: z.enum(['local', 'user']).optional().describe('Timezone ownership mode. Flip to "user" to make the job follow the user\'s current tz; flip to "local" to pin it (pass timezone alongside).'),
      instructions: z.string().optional(),
      enabled: z.boolean().optional(),
      deliveryChannel: z.enum(['telegram', 'slack', 'whatsapp']).optional().describe('Change the delivery channel TYPE. Setting telegram/slack/whatsapp while the user is chatting on that channel re-pins delivery to the exact current chat and Telegram topic — captured automatically, no chat/topic id needed. The result echoes a deliveryTarget.label confirming the resolved group/topic, and a confirmation ping is posted into that channel. Web is not a valid delivery target (results are never pushed to the web chat); to stop delivering to a messaging channel, disable the job instead.'),
      silentUntilFire: z.boolean().optional().describe('When true, the assistant will not pre-announce, echo, or count down to this job in unrelated turns. Set this when the user explicitly says "don\'t mention it before then" or similar.'),
      nagIntervalMins: z.number().int().min(1).max(1440).nullable().optional().describe('For "remind every N min until done" patterns. Set together with nagUntilKeyword. Pass null to clear an existing nag config.'),
      nagUntilKeyword: z.string().min(1).max(50).nullable().optional().describe('Resolution signal — the chat route stops the nag when the user reply contains this keyword (case-insensitive). Required when nagIntervalMins is set. Pass null to clear.'),
      depth: ResearchDepthConfigSchema.optional().describe('Change the research depth — same shape as createScheduledJob ({ tier } and/or numeric overrides). Pass an empty object {} to reset to the standard quick turn.'),
      targetViewId: z.string().uuid().nullable().optional().describe('Repoint the doc page this job maintains (the page that shows its "scheduled" badge). Pass a saved-view UUID to link it to a different page, or null to unlink it from any page. Omit to leave the link unchanged.'),
    }),

    async execute(input, context) {
      const existing = await jobStore.get(input.jobId)
      if (!existing) return { data: `Job ${input.jobId} not found`, isError: true }
      // Owner or workspace teammate (workflow-trigger jobs only). Same
      // not-found wording as a missing row — no existence leak.
      if (!(await canManageJob(existing, context))) {
        return { data: `Job ${input.jobId} not found`, isError: true }
      }

      const updates: {
        schedule?: StructuredSchedule
        timezone?: string
        mode?: 'local' | 'user'
        instructions?: string
        enabled?: boolean
        channelType?: string
        channelId?: string
        nextRunAt?: Date
        silentUntilFire?: boolean
        nagIntervalMins?: number | null
        nagUntilKeyword?: string | null
        viewId?: string | null
      } = {}
      if (input.schedule) updates.schedule = input.schedule as StructuredSchedule
      if (input.instructions) updates.instructions = input.instructions
      if (input.enabled !== undefined) updates.enabled = input.enabled
      if (input.silentUntilFire !== undefined) updates.silentUntilFire = input.silentUntilFire
      if (input.nagIntervalMins !== undefined) updates.nagIntervalMins = input.nagIntervalMins
      if (input.nagUntilKeyword !== undefined) updates.nagUntilKeyword = input.nagUntilKeyword
      // Doc page link (migration 229). `null` clears it; a UUID repoints it
      // (validated against this context's workspace, dropped to null if it
      // doesn't resolve). Omitted → unchanged.
      if (input.targetViewId !== undefined) {
        updates.viewId = input.targetViewId === null
          ? null
          : await resolveTargetView(deps.resolveViewWorkspace, input.targetViewId, context)
      }

      // Validation: post-merge, the (interval, keyword) pair must be both set
      // together or both null.
      const effectiveInterval = input.nagIntervalMins !== undefined
        ? input.nagIntervalMins
        : existing.nagIntervalMins
      const effectiveKeyword = input.nagUntilKeyword !== undefined
        ? input.nagUntilKeyword
        : existing.nagUntilKeyword
      if ((effectiveInterval === null) !== (effectiveKeyword === null)) {
        return {
          data: 'nagIntervalMins and nagUntilKeyword must be set together (or both null).',
          isError: true,
        }
      }

      // Mode + timezone interactions (see updateScheduledJob doc above).
      if (input.mode) updates.mode = input.mode
      if (input.timezone) {
        updates.timezone = input.timezone
      } else if (input.mode === 'user' && context.userTimezone) {
        updates.timezone = context.userTimezone
      }

      // Resolve delivery channel change.
      if (input.deliveryChannel) {
        updates.channelType = input.deliveryChannel
        const preferred = context.preferredChannel
        updates.channelId = input.deliveryChannel === preferred?.channelType
          ? preferred.channelId
          : context.channelId
      }

      // Recompute next_run_at whenever schedule or timezone moves.
      if (input.schedule || updates.timezone) {
        const schedule = (input.schedule ?? existing.schedule) as StructuredSchedule
        const timezone = updates.timezone ?? existing.timezone
        updates.nextRunAt = computeNextRun(schedule, timezone)
      }

      const job = await jobStore.update(input.jobId, updates)
      if (!job) return { data: `Job ${input.jobId} not found`, isError: true }

      // Keep the one-step reminder workflow in sync with the trigger row.
      // Only a single-step assistant_call workflow is rewritten — a
      // `scheduleWorkflow`-backed job points at a user-authored multi-step
      // workflow that must not be mutated by a job edit.
      if (
        (input.instructions !== undefined ||
          input.deliveryChannel !== undefined ||
          input.depth !== undefined) &&
        job.workflowId
      ) {
        const wf = await workflowStore.getById(context.userId, job.workflowId)
        const step = wf && wf.definition.steps.length === 1 && wf.definition.steps[0].type === 'assistant_call'
          ? wf.definition.steps[0]
          : null
        if (wf && step) {
          await workflowStore.update(context.userId, wf.id, {
            definition: {
              ...wf.definition,
              steps: [{
                ...step,
                prompt: input.instructions !== undefined
                  ? frameSchedulerPrompt(input.instructions)
                  : step.prompt,
                deliver: input.deliveryChannel !== undefined
                  ? { channelType: coerceDeliverChannel(job.channelType), channelId: job.channelId }
                  : step.deliver,
                depth: input.depth !== undefined ? input.depth : step.depth,
              }],
            },
          })
        }
      }

      const delivery = await describeDelivery(deps.resolveDeliveryTarget, {
        assistantId: context.assistantId,
        channelType: job.channelType,
        channelId: job.channelId,
      })

      // Confirmation ping when the user deliberately retargeted to a messaging
      // channel — proof the next run lands in the right chat/topic.
      const confirmationSent = input.deliveryChannel
        ? await sendDeliveryConfirmation(deps.deliverToChannel, {
            workspaceId: context.workspaceId,
            assistantId: context.assistantId,
            userId: context.userId,
            channelType: job.channelType,
            channelId: job.channelId,
            nextRunAt: job.nextRunAt,
            label: delivery.deliveryTarget?.label,
          })
        : false

      return {
        data: {
          id: job.id,
          enabled: job.enabled,
          nextRun: job.nextRunAt.toISOString(),
          ...formatRelativeTime(job.nextRunAt),
          ...delivery,
          confirmationSent,
          targetViewId: job.viewId,
          timezone: job.timezone,
          mode: job.mode,
          silentUntilFire: job.silentUntilFire,
          nagIntervalMins: job.nagIntervalMins,
          nagUntilKeyword: job.nagUntilKeyword,
        },
      }
    },
  })

  const searchScheduledJobs = buildTool({
    // Hidden from the model: finding scheduled work is now `listWorkflows`
    // (it surfaces each workflow's trigger + cadence) and `getWorkflow`
    // (actual firing rows for one). Kept callable for back-compat / internal
    // readers. Scheduling = a workflow trigger, not a separate "scheduled job".
    hiddenFromModel: true,
    name: 'searchScheduledJobs',
    description: 'Search scheduled jobs with filters and pagination. Covers the current user\'s own jobs PLUS every workflow trigger in the current workspace, including triggers created by other members (a workflow trigger fires a shared workflow, so any member can see and manage it; teammates\' personal reminders stay private — ownedByMe distinguishes the two). Defaults to enabled-only and capped at 20 results — pass `enabled: false` to also include paused / disabled jobs, or omit `enabled` entirely to include both. Use `text` for case-insensitive substring matching against the instructions, `schedule` to filter to one of "recurring" / "once", and `cursor` to page through results larger than `limit` (hard max 50).',
    inputSchema: z.object({
      text: z.string().optional().describe('Case-insensitive substring match against instructions.'),
      enabled: z.boolean().optional().describe('Filter by enabled state. Defaults to true.'),
      schedule: z.enum(['recurring', 'once']).optional().describe('Filter to recurring (daily/weekly/monthly/cron) or once jobs.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max 50. Default 20.'),
      cursor: z.string().optional().describe('Opaque pagination cursor from a prior response.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const enabled = input.enabled ?? true
      const limit = Math.min(input.limit ?? 20, 50)

      const { jobs, nextCursor } = await jobStore.search({
        assistantId: context.assistantId,
        userId: context.userId,
        text: input.text,
        enabled,
        scheduleType: input.schedule,
        limit,
        cursor: input.cursor,
        // Workspace arm: include workflow-trigger jobs any member created —
        // a runaway trigger must be findable (and stoppable) by every
        // member, not only its creator. See canManageJob above.
        workspaceId: context.workspaceId ?? undefined,
      })

      if (jobs.length === 0) {
        return { data: { jobs: [], nextCursor: null } }
      }

      // Resolve titles from the underlying workflow row (mig 202 — the
      // workflow's `name` IS the job's display title). Best-effort: a
      // missing workflow (legacy job pre-cutover) falls back to the
      // instructions excerpt.
      const titles = new Map<string, string>()
      await Promise.all(
        jobs.map(async (j) => {
          if (!j.workflowId) return
          const wf = await workflowStore.getById(context.userId, j.workflowId)
          if (wf) titles.set(j.id, wf.name)
        }),
      )

      // Resolve a human-readable delivery target per distinct channel so the
      // model can verify *where* each job posts (e.g. which Telegram topic),
      // not just the bare type. Deduped by (channelType, channelId) — a page
      // of jobs usually shares only a couple of channels.
      const deliveryLabels = new Map<string, DeliveryTargetLabel>()
      if (deps.resolveDeliveryTarget) {
        const distinct = new Map<string, { channelType: string; channelId: string }>()
        for (const j of jobs) {
          distinct.set(`${j.channelType}::${j.channelId}`, {
            channelType: j.channelType,
            channelId: j.channelId,
          })
        }
        await Promise.all(
          [...distinct].map(async ([key, { channelType, channelId }]) => {
            try {
              const resolved = await deps.resolveDeliveryTarget!({
                assistantId: context.assistantId,
                channelType,
                channelId,
              })
              if (resolved) deliveryLabels.set(key, resolved)
            } catch (err) {
              console.warn('[scheduling/search] delivery label failed:', err)
            }
          }),
        )
      }

      return {
        data: {
          jobs: jobs.map((j) => ({
            id: j.id,
            title: titles.get(j.id) ?? null,
            instructions: j.instructions.slice(0, 80),
            schedule: j.schedule,
            enabled: j.enabled,
            nextRun: j.nextRunAt.toISOString(),
            deliveryChannel: j.channelType,
            deliveryTarget: deliveryLabels.get(`${j.channelType}::${j.channelId}`),
            timezone: j.timezone,
            mode: j.mode,
            lastStatus: j.lastStatus,
            silentUntilFire: j.silentUntilFire,
            nagIntervalMins: j.nagIntervalMins,
            nagUntilKeyword: j.nagUntilKeyword,
            // Workspace arm: false = a teammate's workflow trigger
            // (manageable by any member); personal reminders are always own.
            ownedByMe: j.userId === context.userId,
            // Set on workflow triggers — lets the model jump to getWorkflow.
            workflowId: isWorkflowTriggerJob(j) ? j.workflowId : undefined,
          })),
          nextCursor,
        },
      }
    },
  })

  const deleteScheduledJob = buildTool({
    // Hidden from the model: stopping a schedule is `updateWorkflow` (set
    // `{ enabled: false }` to pause, or change `trigger` to `manual` to drop
    // the schedule) — deleting a `scheduled_jobs` row does NOT stop a
    // workflow-triggered workflow (the trip wire that confused the model on
    // 2026-06-15). Kept callable for back-compat. Scheduling = a workflow trigger.
    hiddenFromModel: true,
    name: 'deleteScheduledJob',
    description: 'Delete a scheduled job. Works on your own jobs and on workflow triggers in the current workspace, including ones created by other members (a runaway trigger must be stoppable by any member). Teammates\' personal reminders cannot be touched.',
    inputSchema: z.object({
      jobId: z.string().describe('Job ID to delete'),
    }),

    async execute(input, context) {
      const job = await jobStore.get(input.jobId)
      if (!job) return { data: `Job ${input.jobId} not found`, isError: true }
      // Owner or workspace teammate (workflow-trigger jobs only). Same
      // not-found wording as a missing row — no existence leak.
      if (!(await canManageJob(job, context))) {
        return { data: `Job ${input.jobId} not found`, isError: true }
      }

      const deleted = await jobStore.delete(input.jobId)
      if (!deleted) return { data: `Job ${input.jobId} not found`, isError: true }

      // Cascade-delete the implicit one-step reminder workflow. A
      // `scheduleWorkflow`-backed job (channelType 'workflow') points at a
      // user-authored workflow we must leave intact.
      if (job.workflowId && job.channelType !== 'workflow') {
        await workflowStore.delete(context.userId, job.workflowId).catch((err) => {
          console.error(`[scheduling] failed to delete reminder workflow ${job.workflowId}:`, err)
        })
      }

      return { data: `Deleted job ${input.jobId}.` }
    },
  })

  return { createScheduledJob, updateScheduledJob, searchScheduledJobs, deleteScheduledJob }
}
