/**
 * `scheduleWorkflow` chat tool — Phase B (Q4 §13).
 *
 * Creates a `scheduled_jobs` row with `workflow_id` set so the poll worker
 * fires the workflow on a recurring schedule, and mirrors the schedule onto
 * `workflows.trigger` so the web builder (which renders `workflows.trigger`
 * verbatim) shows "Scheduled" instead of the stale "Manual". Reuses the same
 * schedule shape (`once`/`daily`/`weekly`/`monthly`/`cron`) as
 * `createScheduledJob` to keep authoring uniform.
 *
 * A workflow carries a single trigger, so scheduling is idempotent-replace:
 * an existing scheduled-trigger job for the workflow is updated in place (and
 * any stray duplicates reaped) rather than stacking a second hourly fire.
 *
 * The executor branch in `packages/api/src/scheduling/executor.ts` reads
 * `job.workflow_id` and calls `runWorkflowFromJob` instead of the user-
 * channel dispatch.
 *
 * [COMP:workflow/scheduled-trigger]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { computeNextRun, type StructuredSchedule } from '../scheduling/schedule.js'
import type { JobStore, ScheduledJob, ScheduledJobMode } from '../scheduling/types.js'
import type { WorkflowStore } from './types.js'

const scheduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('once'),
    datetime: z
      .string()
      .describe('Local datetime (no Z or offset), e.g. "2026-04-09T15:30:00".'),
  }),
  z.object({
    type: z.literal('daily'),
    time: z.string().describe('HH:MM in 24h format'),
  }),
  z.object({
    type: z.literal('weekly'),
    days: z.array(z.string()).describe('Day names: monday, tuesday, etc.'),
    time: z.string(),
  }),
  z.object({
    type: z.literal('monthly'),
    dayOfMonth: z.number().min(1).max(31),
    time: z.string(),
  }),
  z.object({
    type: z.literal('cron'),
    expression: z.string().describe('Cron expression: min hour dom month dow'),
  }),
])

export type ScheduleWorkflowToolDeps = {
  workflowStore: WorkflowStore
  jobStore: JobStore
  /**
   * Resolve the workspace's primary assistant id for billing / cron
   * attribution. The primary owns the schedule's user-side bookkeeping
   * (channel attribution, billing user). Same shape as the executor's
   * `resolvePrimary` callback.
   */
  resolvePrimary: (workspaceId: string) => Promise<string | null>
}

export type WorkflowScheduleSyncDeps = {
  jobStore: JobStore
  resolvePrimary: (workspaceId: string) => Promise<string | null>
}

/**
 * Create or idempotently update the single scheduled-trigger `scheduled_jobs`
 * row that fires a workflow on a schedule, reaping any duplicate trigger rows.
 *
 * Shared by `scheduleWorkflow` (chat) and the workflows REST route (web
 * builder) so BOTH paths keep `scheduled_jobs` ⇄ `workflows.trigger` in exact
 * lockstep. Duplicating this idempotent-replace inline is what produced the
 * 2026-06-04 double-fire and 2026-06-10 cross-member stacking incidents — one
 * helper, one source of truth for "one firing trigger per workflow". The
 * replace is workflow-scoped (any member's row), not caller-scoped.
 *
 * Returns the firing job id + next run, or `{ error }` (no primary assistant).
 */
export async function syncWorkflowScheduleTrigger(
  deps: WorkflowScheduleSyncDeps,
  params: {
    workflowId: string
    workspaceId: string
    /** Authoring user — owns the trigger row's user-side bookkeeping. */
    userId: string
    schedule: StructuredSchedule
    timezone: string
    input?: Record<string, unknown>
    /**
     * Trigger-row policy carried from the workflow's `trigger` (scheduling-
     * authoring-unification). All optional and additive — omitted fields leave
     * the existing row value untouched on the update arm and default on create.
     * `mode` defaults to 'local'; the nag pair + silent + viewId mirror the
     * `scheduled_jobs` columns. See docs/architecture/features/workflow.md.
     */
    mode?: ScheduledJobMode
    silentUntilFire?: boolean
    nagIntervalMins?: number | null
    nagUntilKeyword?: string | null
    viewId?: string | null
  },
): Promise<{ jobId: string; nextRunAt: Date } | { error: string }> {
  const primaryAssistantId = await deps.resolvePrimary(params.workspaceId)
  if (!primaryAssistantId) return { error: 'Workspace has no primary assistant.' }

  const nextRunAt = computeNextRun(params.schedule, params.timezone)
  const instructions = JSON.stringify({
    kind: 'workflow_trigger',
    workflowId: params.workflowId,
    input: params.input ?? {},
  })

  const existing = await deps.jobStore.listTriggerJobsForWorkflowSystem(params.workflowId)
  let job: ScheduledJob
  if (existing.length > 0) {
    const [keep, ...duplicates] = existing
    job =
      (await deps.jobStore.update(keep.id, {
        schedule: params.schedule,
        timezone: params.timezone,
        instructions,
        nextRunAt,
        enabled: true,
        // Policy is additive — only patch a field the caller actually passed,
        // so a plain reschedule never clobbers an existing mode / nag / page.
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        ...(params.silentUntilFire !== undefined ? { silentUntilFire: params.silentUntilFire } : {}),
        ...(params.nagIntervalMins !== undefined ? { nagIntervalMins: params.nagIntervalMins } : {}),
        ...(params.nagUntilKeyword !== undefined ? { nagUntilKeyword: params.nagUntilKeyword } : {}),
        ...(params.viewId !== undefined ? { viewId: params.viewId } : {}),
      })) ?? keep
    for (const dup of duplicates) {
      await deps.jobStore.delete(dup.id).catch(() => {})
    }
  } else {
    job = await deps.jobStore.create({
      assistantId: primaryAssistantId,
      userId: params.userId,
      schedule: params.schedule,
      timezone: params.timezone,
      mode: params.mode ?? 'local',
      instructions,
      channelType: 'workflow',
      channelId: params.workflowId,
      nextRunAt,
      silentUntilFire: params.silentUntilFire,
      nagIntervalMins: params.nagIntervalMins ?? null,
      nagUntilKeyword: params.nagUntilKeyword ?? null,
      workflowId: params.workflowId,
      workflowStepRunId: null,
      viewId: params.viewId ?? null,
    })
  }
  return { jobId: job.id, nextRunAt }
}

/**
 * Delete every scheduled-trigger row for a workflow. Called when a workflow's
 * trigger changes AWAY from `schedule` (so it stops firing) or the workflow is
 * deleted. Best-effort per row; returns the count removed.
 */
export async function clearWorkflowScheduleTriggers(
  deps: { jobStore: JobStore },
  workflowId: string,
): Promise<number> {
  const existing = await deps.jobStore.listTriggerJobsForWorkflowSystem(workflowId)
  let removed = 0
  for (const job of existing) {
    if (await deps.jobStore.delete(job.id).catch(() => false)) removed++
  }
  return removed
}

export function createScheduleWorkflowTool(deps: ScheduleWorkflowToolDeps): Tool {
  return buildTool({
    // Hidden from the model: scheduling is set inline on createWorkflow /
    // updateWorkflow via `trigger`. Kept callable for back-compat / forwarding.
    hiddenFromModel: true,
    name: 'scheduleWorkflow',
    description:
      `DEPRECATED — pass the schedule trigger directly to \`createWorkflow\` (for a new workflow) or ` +
      `\`updateWorkflow\` (for an existing one) as \`trigger: { kind: "schedule", schedule, timezone? }\`; ` +
      `that schedules in the SAME call, so there is no longer a separate scheduling step. Retained for ` +
      `back-compat — do NOT call this after createWorkflow. ` +
      `Schedules a workflow to run on a recurring (or one-time) cron-like schedule. ` +
      `The workflow runs server-side at the scheduled time(s); each fire creates a fresh run with ` +
      `the trigger payload you pass via \`input\`. ` +
      `Confirm the schedule and the workflow name with the user before calling. When the result ` +
      `includes a \`relativeTime\` field, surface it (e.g. "next run in 3 hours") so the user can ` +
      `catch timezone mistakes.`,
    inputSchema: z.object({
      workflowId: z.string().uuid().describe('Workflow id to schedule. Use listWorkflows to find it.'),
      schedule: scheduleSchema,
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone, e.g. "Asia/Tokyo". Omit to use the user\'s current timezone.'),
      input: z
        .record(z.unknown())
        .optional()
        .describe('Optional trigger payload, available to steps as `{{input.X}}`.'),
    }),
    timeoutMs: 30_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: 'Workflows require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to schedule workflows.',
          isError: true,
        }
      }
      const workflow = await deps.workflowStore.getById(context.userId, input.workflowId)
      if (!workflow || workflow.workspaceId !== context.workspaceId) {
        return { data: `Workflow ${input.workflowId} not found in workspace.`, isError: true }
      }
      if (!workflow.enabled) {
        return { data: `Workflow "${workflow.name}" is disabled.`, isError: true }
      }

      const timezone = input.timezone ?? context.userTimezone ?? 'UTC'
      const schedule = input.schedule as StructuredSchedule

      // Create/idempotently-replace the firing trigger row (workflow-scoped,
      // reaps duplicates) via the shared helper — the SAME lockstep the web
      // builder's REST route now uses, so the two authoring paths can never
      // drift. See `syncWorkflowScheduleTrigger`.
      const synced = await syncWorkflowScheduleTrigger(deps, {
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        userId: context.userId,
        schedule,
        timezone,
        input: input.input,
      })
      if ('error' in synced) return { data: synced.error, isError: true }

      // Keep `workflows.trigger` in lockstep with the scheduled-jobs row that
      // actually fires. The web builder reads `workflows.trigger` verbatim;
      // without this write a chat-scheduled workflow keeps displaying "Manual"
      // even though it is genuinely scheduled (the bug this fixes).
      await deps.workflowStore.update(context.userId, workflow.id, {
        trigger: { kind: 'schedule', schedule: input.schedule, timezone },
      })

      return {
        data: {
          jobId: synced.jobId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          nextRun: synced.nextRunAt.toISOString(),
          ...formatRelativeTime(synced.nextRunAt),
          schedule: input.schedule,
          timezone,
        },
      }
    },
  })
}

function formatRelativeTime(nextRunAt: Date): { relativeTime?: string } {
  const diffMs = nextRunAt.getTime() - Date.now()
  if (diffMs < 0 || diffMs > 24 * 60 * 60 * 1000) return {}
  const totalMinutes = Math.round(diffMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`)
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`)
  return { relativeTime: `in ${parts.join(' ') || 'less than a minute'}` }
}
