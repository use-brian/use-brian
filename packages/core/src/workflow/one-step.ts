/**
 * One-step reminder workflow builder.
 *
 * Post Phase-2 cutover a scheduled job *is* a `scheduled_jobs` trigger row
 * pointing at a workflow. For a plain reminder that workflow is a single
 * `assistant_call` step that delivers to a user channel and reuses a
 * persistent session across fires. `createScheduledJob` and the nag-follow-up
 * chainer both build one through this helper; the data migration
 * (`159_scheduling_workflow_cutover.sql`) builds the identical shape in SQL.
 *
 * See docs/architecture/engine/scheduled-jobs.md → "What the one-step
 * workflow carries".
 *
 * [COMP:workflow/one-step]
 */

import { randomUUID } from 'node:crypto'
import type { WorkflowDefinition, WorkflowModelAlias, WorkflowStore, WorkflowTrigger } from './types.js'
import type { ResearchDepthConfig } from '../engine/research-depth.js'

/**
 * Default model tier for a scheduled-job reminder's agentic turn. Scheduled
 * jobs run on **Pro** unless the caller overrides it — a recurring brief /
 * scan / nag is worth the stronger model, and reminders are low-volume enough
 * that the tier bump is cheap. Mirrors the workflow-row default flipped to
 * 'pro' in migration 230. See docs/architecture/engine/scheduled-jobs.md →
 * "What the one-step workflow carries".
 */
export const REMINDER_DEFAULT_MODEL_ALIAS: WorkflowModelAlias = 'pro'

/**
 * Prepended to a scheduled job's instructions before they reach the model.
 * Without it, models read first-person instructions ("remind me to…") as a
 * directive being given TO them and reply with an acknowledgement instead of
 * the reminder body. The legacy `JobExecutor` prepended this per fire; post-
 * cutover it is baked into the `assistant_call` step prompt at build time.
 *
 * The wording is deliberately a *positive verbatim* frame ("your entire output
 * is sent to the user"), not the older "produce the message body / do NOT
 * describe what you will do" phrasing. That older framing named the artifact
 * "message body" (which the model echoed as a literal `Message body:` label)
 * and used inverse-psychology negations that primed the very meta-narration
 * they forbade — the model emitted its planning trail ("(This isn't shown to
 * the user)", "Ready to reply? Yes.", "(Word count: ~65)") plus a duplicated
 * body, all delivered verbatim. The prompt fix reduces that frequency; the
 * real defense is `sanitizeDeliveryText` at every delivery boundary (see
 * docs/architecture/engine/delivery-sanitization.md).
 *
 * Avoid the em dash here — a model can echo punctuation it sees in its prompt.
 *
 * Keep in sync with the `$framing$` literal in migration
 * `159_scheduling_workflow_cutover.sql`.
 */
export const CRON_TURN_FRAMING =
  '[Cron task] You are running a scheduled task. Your entire output is sent to the user verbatim as a chat message. Write only that message, addressing the user directly in second person. Output nothing else: no labels, no preamble, no planning notes, no word counts, no remarks about what you are doing or whether it is shown to the user, and never repeat the message. The system schedules any follow-up automatically, so do not call createScheduledJob, scheduleOnce, or any other tool to chain reminders.'

/** Apply the cron-turn framing to raw user instructions. */
export function frameSchedulerPrompt(instructions: string): string {
  return `${CRON_TURN_FRAMING}\n\n${instructions}`
}

/** `description` stamped on every workflow built by `buildOneStepReminderWorkflow`. */
export const REMINDER_WORKFLOW_DESCRIPTION = 'Scheduled reminder workflow.'

export type ReminderDeliverTarget = {
  channelType: 'web' | 'telegram' | 'slack' | 'whatsapp'
  channelId: string
}

/**
 * Build the one-step `assistant_call` definition for a scheduled reminder.
 * Exported separately so callers that need the definition without persisting
 * it (the nag chainer, tests) reuse the exact shape.
 */
export function oneStepReminderDefinition(params: {
  assistantId: string
  /** Raw user instructions — scheduler framing is applied internally. */
  instructions: string
  /**
   * Channel the step's text output is pushed to. Omit for a doc-maintaining
   * job: the page is the output surface, so the step runs (and patches the
   * page via tools) without delivering anything to a channel. Web is never a
   * deliver target — see docs/architecture/engine/scheduled-jobs.md →
   * "Channel delivery".
   */
  deliver?: ReminderDeliverTarget
  /** Optional research-depth override for the reminder's agentic turn. */
  depth?: ResearchDepthConfig
  /** Model tier for the run. Defaults to Pro (`REMINDER_DEFAULT_MODEL_ALIAS`). */
  modelAlias?: WorkflowModelAlias
}): WorkflowDefinition {
  // Step IDs must start with a letter per `WorkflowStepSchema`'s regex —
  // ~60% of raw UUIDs start with a hex digit (0–9), which gets rejected by
  // `PATCH /api/workflows/:id` on the next definition round-trip. The `s_`
  // prefix is the same prefix migration 209 applies to legacy rows.
  const stepId = `s_${randomUUID()}`
  return {
    startStepId: stepId,
    steps: [
      {
        id: stepId,
        type: 'assistant_call',
        target: { assistantId: params.assistantId },
        prompt: frameSchedulerPrompt(params.instructions),
        ...(params.deliver ? { deliver: params.deliver } : {}),
        session: 'persistent',
        nextStepId: null,
        modelAlias: params.modelAlias ?? REMINDER_DEFAULT_MODEL_ALIAS,
        ...(params.depth ? { depth: params.depth } : {}),
      },
    ],
  }
}

/**
 * Create a one-step reminder workflow and return its id.
 *
 * The schedule lives on the `scheduled_jobs` row that points at this workflow
 * (the 60s poll worker fires it), but the workflow's own `trigger` column is
 * **mirrored** to that schedule so the builder shows "Scheduled", not a
 * misleading "Manual". Pass the schedule trigger from the scheduling tool;
 * callers without a schedule (or one-off internal builds) may omit it and get
 * the `manual` default. This mirroring is the same lockstep `scheduleWorkflow`
 * performs — it removes the pervasive "trigger says manual but it runs on a
 * schedule" drift that every reminder used to create.
 */
export async function buildOneStepReminderWorkflow(
  store: WorkflowStore,
  params: {
    userId: string
    workspaceId: string
    assistantId: string
    /** Raw user instructions — scheduler framing is applied internally. */
    instructions: string
    /** Delivery target; omit for a doc-maintaining job (page is the surface). */
    deliver?: ReminderDeliverTarget
    name?: string
    /** Optional research-depth override threaded onto the assistant_call step. */
    depth?: ResearchDepthConfig
    /** Model tier for the run. Defaults to Pro (`REMINDER_DEFAULT_MODEL_ALIAS`). */
    modelAlias?: WorkflowModelAlias
    /**
     * Trigger to stamp on the workflow row so the builder reflects reality.
     * The scheduling tool passes `{ kind: 'schedule', schedule, timezone }`;
     * omit for the `manual` default. Always kept in lockstep with the backing
     * `scheduled_jobs` row.
     */
    trigger?: WorkflowTrigger
  },
): Promise<string> {
  const workflow = await store.create({
    userId: params.userId,
    workspaceId: params.workspaceId,
    name: params.name ?? 'Scheduled reminder',
    description: REMINDER_WORKFLOW_DESCRIPTION,
    definition: oneStepReminderDefinition({
      assistantId: params.assistantId,
      instructions: params.instructions,
      deliver: params.deliver,
      depth: params.depth,
      modelAlias: params.modelAlias,
    }),
    trigger: params.trigger ?? { kind: 'manual' },
  })
  return workflow.id
}
