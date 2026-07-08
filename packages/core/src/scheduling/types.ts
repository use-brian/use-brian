import type { StructuredSchedule } from './schedule.js'

/**
 * How the job's timezone is owned.
 *
 *   'local' — the `timezone` column is authoritative and set at job
 *             creation. Travel nudges may offer to rebase it.
 *   'user'  — the `timezone` column mirrors `users.timezone` and is
 *             kept in sync whenever the user's tz changes (either
 *             via explicit update or accepted travel rebase).
 *
 * The executor and poll worker always read `scheduled_jobs.timezone`;
 * mode only governs who is allowed to write it.
 */
export type ScheduledJobMode = 'local' | 'user'

/**
 * Per-job runtime state. JSONB on the row, structured here so callers
 * see the typed shape. New keys can be added without a migration.
 *
 * `activeNag` is set by the executor at fire time when a job has
 * `nagIntervalMins` configured, and cleared by the chat-route post-user-
 * turn hook when the user's reply matches `nagUntilKeyword`. See
 * docs/architecture/engine/scheduled-jobs.md → "Structured policy fields".
 *
 * `parentNagJobId` + `cycleDate` mark a job as a runtime-managed nag
 * follow-up: a `once` job auto-created by the executor when a parent's
 * `activeNag` opens, used to deliver an actual nag at +N minutes
 * without depending on the model to call `createScheduledJob` itself.
 * The follow-up's executor short-circuits (and disables itself) when
 * the parent's `activeNag` is missing or its `cycleDate` no longer
 * matches — preventing yesterday's stragglers from extending today's
 * cycle.
 */
export type ScheduledJobState = {
  activeNag?: {
    /** ISO timestamp of the original fire that opened this nag cycle. */
    openedAt: string
    /** YYYY-MM-DD in the job's timezone — used to detect already-resolved-today. */
    cycleDate: string
  }
  /** Parent job whose `activeNag` lifecycle gates this follow-up's fire. */
  parentNagJobId?: string
  /** Cycle this follow-up was scheduled for. Compared against the parent's
   *  current `activeNag.cycleDate` at fire time. */
  cycleDate?: string
  /**
   * Path B durable chat resume trigger (Q22 RESOLVED). Set by the approval
   * resolution endpoint when the in-memory promise registry has no entry
   * for the approval (i.e. the original chat process restarted). The poll
   * worker dispatches matching rows to the injected `resumeHandler`
   * instead of the standard executor, and the handler re-enters the query
   * loop using the suspended state recorded in `session_resume_points`.
   *
   * See docs/plans/company-brain/approvals.md → "Chat resume — Path B
   * (lightweight checkpoint)" and migration 124.
   */
  triggerKind?: 'session_resume'
  /** Companion payload for `triggerKind: 'session_resume'`. */
  resume?: {
    sessionId: string
    approvalId: string
  }
  /**
   * Consecutive-failure counter for the auto-disable backstop. Incremented
   * by the poll worker each time a recurring job's executor throws, and
   * reset to 0 on the next success. When it reaches
   * `PollWorkerOptions.maxConsecutiveFailures` the worker disables the job
   * (and fires `onJobAutoDisabled`) instead of re-arming it forever. A
   * permanently-broken config (bad `assistant_call` target, deleted
   * connector) thus dies after ~N fires rather than failing unboundedly —
   * the moat-workflow incident (162 identical hourly failures, 2026-06).
   * Absent = no failures recorded since the last success.
   * See docs/architecture/engine/scheduled-jobs.md → "Failure semantics".
   */
  consecutiveFailures?: number
}

export type ScheduledJob = {
  id: string
  assistantId: string
  userId: string
  schedule: StructuredSchedule
  timezone: string
  mode: ScheduledJobMode
  instructions: string
  channelType: string
  channelId: string
  enabled: boolean
  nextRunAt: Date
  lastRunAt: Date | null
  lastStatus: string | null
  /** Layer-1 hint: do not pre-announce or echo this job in unrelated turns. */
  silentUntilFire: boolean
  /**
   * For "remind every N min until done" patterns. Set together with
   * `nagUntilKeyword`. Executor + chat-route hook use these together
   * with `state.activeNag` to bridge cron and user sessions.
   * `null` = single-fire, no nag loop.
   */
  nagIntervalMins: number | null
  nagUntilKeyword: string | null
  /** Per-job runtime state — currently `activeNag` only. */
  state: ScheduledJobState
  /**
   * Workflow primitive (Q4 §13). When set, the executor branches to the
   * workflow advancement path instead of the user-channel dispatch.
   *   - `workflowId` only         → scheduled trigger; each fire creates
   *     a fresh `workflow_runs` row.
   *   - `workflowId` + `workflowStepRunId` → wait wake-up; advances the
   *     named step run that the executor previously paused.
   * Both null = legacy job (instructions in user channel).
   * See migration 116 + docs/architecture/features/workflow.md.
   */
  workflowId: string | null
  workflowStepRunId: string | null
  /**
   * Doc page (`saved_views.id`) this job maintains (migration 229). Set
   * when a "research X and update this page" job is scheduled from inside a
   * doc page — captured from `ToolContext.docViewId` (or an explicit
   * `targetViewId`). The page view surfaces a schedule badge for every
   * enabled job that targets it (`JobStore.listEnabledByView`). `null` for
   * non-doc jobs. `ON DELETE SET NULL` detaches the job when the page is
   * deleted. See docs/architecture/engine/scheduled-jobs.md → "Doc page
   * target".
   */
  viewId: string | null
}

export type JobStore = {
  create(params: {
    assistantId: string
    userId: string
    schedule: StructuredSchedule
    timezone: string
    mode?: ScheduledJobMode
    instructions: string
    channelType: string
    channelId: string
    nextRunAt: Date
    silentUntilFire?: boolean
    nagIntervalMins?: number | null
    nagUntilKeyword?: string | null
    /** Workflow primitive — set together for wait wake-ups, workflowId-only for scheduled triggers. */
    workflowId?: string | null
    workflowStepRunId?: string | null
    /** Doc page this job maintains (migration 229). Omit/null for non-doc jobs. */
    viewId?: string | null
  }): Promise<ScheduledJob>

  update(id: string, updates: {
    schedule?: StructuredSchedule
    timezone?: string
    mode?: ScheduledJobMode
    instructions?: string
    enabled?: boolean
    nextRunAt?: Date
    channelType?: string
    channelId?: string
    silentUntilFire?: boolean
    nagIntervalMins?: number | null
    nagUntilKeyword?: string | null
    /** Repoint (or clear, with `null`) the doc page this job maintains (migration 229). */
    viewId?: string | null
  }): Promise<ScheduledJob | null>

  delete(id: string): Promise<boolean>

  get(id: string): Promise<ScheduledJob | null>

  list(assistantId: string, userId: string): Promise<ScheduledJob[]>

  /**
   * Every enabled job a user owns that targets a given doc page
   * (`view_id`), ordered by `next_run_at` ascending (soonest first). Backs
   * the page-view schedule badge (migration 229) — one page can carry many
   * jobs. Scoped to the owner: a member sees only their own schedules on a
   * shared page, never another member's job instructions. Backed by the
   * partial index `idx_jobs_view`.
   */
  listEnabledByView(userId: string, viewId: string): Promise<ScheduledJob[]>

  getDueJobs(): Promise<ScheduledJob[]>

  markCompleted(id: string, nextRunAt: Date): Promise<void>
  markFailed(id: string, nextRunAt: Date): Promise<void>

  /**
   * Replace the job's `state_json`. The executor uses this to set
   * `activeNag` at fire time; the chat-route post-user-turn hook uses it
   * to clear `activeNag` on resolution. Pass an empty object `{}` (not
   * `null`) to clear all keys.
   */
  setState(id: string, state: ScheduledJobState): Promise<void>

  /**
   * Find every active nag cycle for a user. Backed by the partial index
   * `idx_jobs_active_nag` (migration 073). Used by the chat-route post-
   * user-turn hook to scan recent user replies against `nag_until_keyword`.
   */
  listActiveNagsForUser(userId: string): Promise<ScheduledJob[]>

  /**
   * Filterable + paginated search backing `searchScheduledJobs`. Defaults
   * are applied by the tool layer (enabled=true, limit=20, hard max 50);
   * the store treats the params as opaque filters. Pagination uses keyset
   * on `(created_at DESC, id DESC)` — the returned `nextCursor` is an
   * opaque base64 string the caller passes back on the next call.
   *
   * `scheduleType: 'recurring'` matches `schedule->>'type' != 'once'`;
   * `'once'` matches `schedule->>'type' = 'once'`.
   *
   * Returns `nextCursor: null` when there are no more rows past the
   * current page.
   */
  search(params: {
    assistantId: string
    userId: string
    text?: string
    enabled?: boolean
    scheduleType?: 'recurring' | 'once'
    limit: number
    cursor?: string
    /**
     * Workspace visibility arm. When set, the result includes — beyond the
     * caller's own `(assistantId, userId)` jobs — every WORKFLOW-TRIGGER job
     * of a workflow in this workspace, regardless of which member created
     * it. A workflow trigger fires a workspace-scoped object any member can
     * already view and disable via the builder, so its trigger rows carry
     * the same visibility; teammates' personal reminders stay private.
     * Structural discriminator: `channel_type='workflow' AND
     * workflow_step_run_id IS NULL` (scheduled triggers; wait wake-ups
     * carry a step-run id, reminders carry a delivery channel type).
     * The caller passes its session's workspace — membership is implied.
     * Incident origin: 2026-06-10, a member's runaway hourly triggers were
     * invisible to every other member (`searchScheduledJobs` → `[]`).
     */
    workspaceId?: string
  }): Promise<{ jobs: ScheduledJob[]; nextCursor: string | null }>

  /**
   * Every scheduled-trigger row of one workflow, any creator — the
   * structural filter above, ordered oldest first. System-level: callers
   * authorize via the workflow read (workspace-member-scoped
   * `workflowStore.getById`) before calling. Backs `scheduleWorkflow`'s
   * cross-member idempotent-replace dedup and the trigger-row surfacing on
   * `getWorkflow` / the builder.
   */
  listTriggerJobsForWorkflowSystem(workflowId: string): Promise<ScheduledJob[]>

  /**
   * EVERY firing row of one workflow regardless of channel — both the
   * `channel_type='workflow'` trigger rows AND the messaging/doc-channel
   * REMINDER rows (`workflow_step_run_id IS NULL`, any channel). Unlike
   * `listTriggerJobsForWorkflowSystem` (which filters to `channel_type='workflow'`),
   * this sees the reminder row a delivery-backed scheduled workflow fires from.
   * System-level (same authorization model as the sibling). Used by
   * `updateWorkflow` to reconcile a reminder reschedule to exactly one firing
   * row — scheduling is a workflow trigger, so editing the workflow must own
   * the reminder row too. See docs/architecture/features/workflow.md §3.
   */
  listFiringJobsForWorkflowSystem(workflowId: string): Promise<ScheduledJob[]>

  /**
   * System-level GC of disabled trigger rows older than `cutoff`. Returns
   * the deleted row count. Called by the daily cleanup worker
   * (`packages/api/src/scheduling/cleanup-worker.ts`). The audit trail
   * for what these rows used to do lives in `workflow_runs` +
   * `analytics_events`; a disabled trigger row carries no information
   * past disable.
   *
   * Backs the "control plane vs history plane" split — `scheduled_jobs`
   * holds active firing definitions only; one-shots delete on completion
   * via `markCompleted`, and this method reaps disabled rows on the 30d
   * cadence. See docs/architecture/engine/scheduled-jobs.md.
   *
   * Age MUST be measured by `COALESCE(last_run_at, created_at)` (when the job
   * went inactive), NOT `updated_at`: a table-wide migration bumps `updated_at`
   * and silently resets the TTL clock for all history (observed 2026-05-31 —
   * the reap matched 0 rows while 146 disabled rows accumulated).
   */
  purgeDisabledOlderThan(cutoff: Date): Promise<number>

  /**
   * Count enabled recurring (`schedule.type !== 'once'`) jobs for a user.
   * Powers the per-user cap enforced by `createScheduledJob` (default 100).
   * Once-jobs and disabled rows are excluded — the cap is about
   * "actively-firing schedules", not history.
   */
  countEnabledRecurring(userId: string): Promise<number>
}

/**
 * One row drained from `pending_ingest_batches` (company-brain WS-3).
 * Opaque to the worker — `events` is an adapter-shaped array that the
 * downstream processor (Pipeline B, once WU-3.6 lands) interprets.
 *
 * See docs/plans/company-brain/ingest.md → "Engine components / Pending
 * batches" and packages/api/migrations/131_pending_ingest_batches.sql.
 */
export type PendingBatch = {
  id: string
  workspaceId: string
  ruleId: string
  source: string
  firesAt: Date
  events: unknown[]
  createdAt: Date
  /**
   * Per-rule Episode sensitivity override (migration 183) denormalised
   * from `ingest_rules.episode_sensitivity` at append-time. NULL means
   * use the source default. The batch processor reads this directly
   * instead of joining back to the rule.
   */
  episodeSensitivity: 'public' | 'internal' | 'confidential' | null
}

/**
 * Store seam for the batch worker. The SELECT FOR UPDATE SKIP LOCKED
 * row-locks must live in the same transaction as the per-row UPDATE
 * that releases them — exposing `claim()` separately would force callers
 * to also receive a tx handle. Keeping the tx scoped inside the store
 * via a callback lets the worker stay DB-agnostic.
 *
 * Implementations open a transaction, claim up to `limit` due rows
 * (`fires_at < now() AND processed_at IS NULL`), invoke `handler`, then
 * COMMIT (or ROLLBACK on throw).
 */
export type BatchStore = {
  withClaimedBatches: <T>(
    limit: number,
    handler: (
      batches: PendingBatch[],
      markProcessed: (id: string) => Promise<void>,
    ) => Promise<T>,
  ) => Promise<T>
}
