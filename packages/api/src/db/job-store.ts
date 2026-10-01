import type { PoolClient } from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { computeNextRun } from '@use-brian/core'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { assertLegacyJobCreation, lockOperationalPolicy, readWorkflowScheduleAuthority } from '../workspace-access/operational-admission.js'
import type { JobStore, ScheduledJob, ScheduledJobMode, ScheduledJobState, StructuredSchedule } from '@use-brian/core'
import { query, getPool } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

/**
 * Guard against Invalid Date reaching Postgres. pg serialises an Invalid
 * Date as "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN", which Postgres rejects
 * with SQLSTATE 22007 — crashing the poll worker mid-catch. We fall back
 * to "one hour from now" and log loudly so the bad schedule is visible in
 * the next triage tick.
 */
function safeNextRunAt(jobId: string, value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    const fallback = new Date(Date.now() + 60 * 60 * 1000)
    console.error(
      `[job-store] Invalid next_run_at for job ${jobId}; falling back to ${fallback.toISOString()}.`,
    )
    return fallback
  }
  return value
}

type JobRow = {
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
  silentUntilFire: boolean
  nagIntervalMins: number | null
  nagUntilKeyword: string | null
  state: ScheduledJobState | null
  workflowId: string | null
  workflowStepRunId: string | null
  viewId: string | null
  contextGroupId: string | null
  contextProjectId: string | null
  contextCompartments: string[]
  contextProjectIds: string[]
  scheduleClaimId?: string | null
  requiresScheduleClaim?: boolean
}

const JOB_SELECT = `
  id, assistant_id as "assistantId", user_id as "userId",
  schedule, timezone, mode, instructions,
  channel_type as "channelType", channel_id as "channelId",
  enabled, next_run_at as "nextRunAt",
  last_run_at as "lastRunAt", last_status as "lastStatus",
  silent_until_fire as "silentUntilFire",
  nag_interval_mins as "nagIntervalMins",
  nag_until_keyword as "nagUntilKeyword",
  state_json as "state",
  workflow_id as "workflowId",
  workflow_step_run_id as "workflowStepRunId",
  view_id as "viewId",
  context_group_id as "contextGroupId",
  context_project_id as "contextProjectId",
  context_compartments as "contextCompartments",
  context_project_ids as "contextProjectIds",
  schedule_claim_id as "scheduleClaimId",
  (workflow_authoring_snapshot IS NOT NULL) as "requiresScheduleClaim"
`

/**
 * scheduled_jobs has no workspace_id column — resolve it through the owning
 * assistant for the realtime `scheduled_job` signal. Fire-and-forget like
 * every other emitter: a resolution failure must never affect the write.
 */
function notifyJobChange(jobId: string, assistantId: string, action: 'create' | 'update' | 'delete'): void {
  // Async IIFE so a synchronous throw from `query` (or a non-promise return
  // under a test mock) degrades into the same swallowed rejection — the
  // signal is telemetry, the write path must never feel it.
  void (async () => {
    const r = await query<{ workspaceId: string | null }>(
      `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
      [assistantId],
    )
    notifyWorkspaceChange(r.rows[0]?.workspaceId, 'scheduled_job', action, jobId)
  })().catch(() => {})
}

/**
 * Retire a spent one-off schedule's backing workflow to `archived` so a fired
 * reminder leaves the active Workflow grid. Called from `markCompleted` (for a
 * `channel_type = 'workflow'` once-job — a `createWorkflow`-shaped one-off we
 * must not hard-delete, since at this seam it is indistinguishable from a
 * hand-built workflow) and from `markFailed` (a once-job never retries, so a
 * failure is terminal and the workflow is equally spent).
 *
 * Archive, not delete: reversible via PATCH `lifecycleState:'active'`; the only
 * hard delete stays the sweep's grace-gated, digest-gated one-off delete. The
 * `pinned = false` guard honors the user's pin veto
 * and `applyLifecycleTransitionSystem` (which also flips `enabled = false` on
 * archive). Best-effort like every cross-table write here — a failure logs and
 * never affects the job write. Spec: docs/architecture/features/
 * workflow-lifecycle.md -> "Spent one-off schedules".
 */
async function retireBackingWorkflow(workflowId: string): Promise<void> {
  try {
    const r = await query<{ workspaceId: string }>(
      `UPDATE workflows
          SET lifecycle_state = 'archived',
              lifecycle_reason = 'One-off schedule completed',
              lifecycle_transitioned_at = now(),
              enabled = false
        WHERE id = $1
          AND pinned = false
          AND lifecycle_state <> 'archived'
        RETURNING workspace_id AS "workspaceId"`,
      [workflowId],
    )
    if (r.rows[0]) notifyWorkspaceChange(r.rows[0].workspaceId, 'workflow', 'update', workflowId)
  } catch (err) {
    console.error(`[job-store] failed to archive backing workflow ${workflowId}:`, err)
  }
}

function rowToJob(row: JobRow): ScheduledJob {
  return {
    ...row,
    state: row.state ?? {},
  }
}

/** Caller holds the workspace barrier through workflow + firing-row publication.
 * No model fields, caller grants, fresh capture, or mode defaults enter here. */
export async function insertWorkflowScheduleJob(client: PoolClient, workspaceId: string, workflowId: string,
  requested?: Parameters<JobStore['create']>[0]): Promise<ScheduledJob> {
  const source = await readWorkflowScheduleAuthority(client, workspaceId, workflowId)
  const trigger = source.trigger
  const instructions = JSON.stringify({ kind: 'workflow_trigger', workflowId, input: {} })
  if (requested) {
    const expected = { assistantId: source.assistantId, userId: source.userId, channelType: 'workflow', channelId: workflowId,
      workflowId, schedule: trigger.schedule, timezone: trigger.timezone ?? 'UTC', mode: trigger.mode ?? 'local',
      instructions, workflowStepRunId: null, viewId: null,
      contextGroupId: source.contextGroupId, contextProjectId: source.contextProjectId,
      contextCompartments: source.compartments, contextProjectIds: source.projectIds,
      silentUntilFire: trigger.policy?.silentUntilFire ?? false,
      nagIntervalMins: trigger.policy?.nagIntervalMins ?? null, nagUntilKeyword: trigger.policy?.nagUntilKeyword ?? null }
    for (const [key, value] of Object.entries(expected)) {
      const supplied = requested[key as keyof typeof requested]
      if (supplied !== undefined && !isDeepStrictEqual(supplied, value)) throw new WorkspaceAccessError('workflow_schedule_binding_conflict', 409)
    }
  }
  const existing = (await client.query<JobRow & { snapshot: unknown }>(`SELECT ${JOB_SELECT},workflow_authoring_snapshot AS snapshot
    FROM scheduled_jobs WHERE workflow_id=$1 AND workflow_step_run_id IS NULL FOR UPDATE`, [workflowId])).rows
  if (existing.length) {
    if (existing.length !== 1 || !existing[0].enabled || !isDeepStrictEqual(existing[0].snapshot, source.snapshot)) {
      throw new WorkspaceAccessError('workflow_schedule_binding_conflict', 409)
    }
    return rowToJob(existing[0])
  }
  const nextRunAt = computeNextRun(trigger.schedule, trigger.timezone ?? 'UTC')
  if (!Number.isFinite(nextRunAt.getTime())) throw new WorkspaceAccessError('workflow_schedule_invalid', 409)
  const row = (await client.query<JobRow>(`INSERT INTO scheduled_jobs(assistant_id,user_id,schedule,timezone,mode,instructions,
    channel_type,channel_id,next_run_at,workflow_id,context_group_id,context_project_id,context_compartments,context_project_ids,
    silent_until_fire,nag_interval_mins,nag_until_keyword,workflow_authoring_snapshot)
    VALUES($1,$2,$3::jsonb,$4,$5,$6,'workflow',$7::text,$8,$7::uuid,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) RETURNING ${JOB_SELECT}`,
  [source.assistantId,source.userId,JSON.stringify(trigger.schedule),trigger.timezone ?? 'UTC',trigger.mode ?? 'local',instructions,
    workflowId,nextRunAt,source.contextGroupId,source.contextProjectId,source.compartments,source.projectIds,
    trigger.policy?.silentUntilFire ?? false,trigger.policy?.nagIntervalMins ?? null,trigger.policy?.nagUntilKeyword ?? null,JSON.stringify(source.snapshot)])).rows[0]
  // Sticky tombstone: deleting the transient firing row must not allow an
  // old queue object to fall back to unproven legacy dispatch after a mode change.
  await client.query('UPDATE workflows SET schedule_authoring_pinned=true WHERE id=$1', [workflowId])
  return rowToJob(row)
}

export function createDbJobStore(): JobStore {
  return {
    async create(params) {
      const client = await getPool().connect()
      const result = await (async () => {
        try {
          await client.query('BEGIN')
          const pointer = (await client.query('SELECT workspace_id FROM assistants WHERE id=$1', [params.assistantId])).rows[0]?.workspace_id
          const policy = pointer ? await lockOperationalPolicy(client, pointer) : undefined
          if (policy?.setupState === 'ready' && params.workflowId && !params.workflowStepRunId) {
            const inherited = await insertWorkflowScheduleJob(client, pointer, params.workflowId, params)
            await client.query('COMMIT')
            return { rows: [inherited as JobRow] }
          }
          await assertLegacyJobCreation(client, params.assistantId)
          const inserted = await client.query<JobRow>(
            `INSERT INTO scheduled_jobs (
               assistant_id, user_id, schedule, timezone, mode, instructions,
               channel_type, channel_id, next_run_at,
               silent_until_fire, nag_interval_mins, nag_until_keyword,
               workflow_id, workflow_step_run_id, view_id,
               context_group_id, context_project_id, context_compartments,
               context_project_ids
             )
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15,
                    COALESCE($16::uuid, wr.context_group_id, s.context_group_id, w.context_group_id),
                    COALESCE($17::uuid, wr.context_project_id, s.context_project_id, w.context_project_id),
                    CASE
                      WHEN $18::text[] IS NOT NULL THEN $18::text[]
                      WHEN wr.id IS NOT NULL THEN wr.context_compartments
                      WHEN s.id IS NOT NULL THEN s.context_compartments
                      WHEN g.compartment_key IS NOT NULL THEN ARRAY[g.compartment_key]::text[]
                      ELSE ARRAY[]::text[]
                    END,
                    CASE
                      WHEN $19::uuid[] IS NOT NULL THEN $19::uuid[]
                      WHEN $17::uuid IS NOT NULL THEN ARRAY[$17::uuid]::uuid[]
                      WHEN wr.id IS NOT NULL THEN wr.context_project_ids
                      WHEN s.context_project_id IS NOT NULL THEN ARRAY[s.context_project_id]::uuid[]
                      WHEN w.context_project_id IS NOT NULL THEN ARRAY[w.context_project_id]::uuid[]
                      ELSE ARRAY[]::uuid[]
                    END
               FROM (SELECT $13::uuid AS workflow_id,
                            $14::uuid AS workflow_step_run_id,
                            $7::text AS channel_type,
                            $8::text AS channel_id) input
               LEFT JOIN workflow_step_runs wsr ON wsr.id = input.workflow_step_run_id
               LEFT JOIN workflow_runs wr ON wr.id = wsr.run_id
               LEFT JOIN workflows w ON w.id = COALESCE(wr.workflow_id, input.workflow_id)
               LEFT JOIN sessions s
                 ON input.channel_type = 'session_resume' AND s.id::text = input.channel_id
               LEFT JOIN workspace_groups g
                 ON g.id = COALESCE($16::uuid, wr.context_group_id, s.context_group_id, w.context_group_id)
             RETURNING ${JOB_SELECT}`,
            [
              params.assistantId,
              params.userId,
              JSON.stringify(params.schedule),
              params.timezone,
              params.mode ?? 'local',
              params.instructions,
              params.channelType,
              params.channelId,
              params.nextRunAt,
              params.silentUntilFire ?? false,
              params.nagIntervalMins ?? null,
              params.nagUntilKeyword ?? null,
              params.workflowId ?? null,
              params.workflowStepRunId ?? null,
              params.viewId ?? null,
              params.contextGroupId ?? null,
              params.contextProjectId ?? null,
              params.contextCompartments === undefined ? null : params.contextCompartments,
              params.contextProjectIds === undefined ? null : params.contextProjectIds,
            ],
          )

          await client.query('COMMIT')
          return inserted
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      })()

      // Retroactive `users.timezone` backfill. When the model captures a
      // concrete IANA zone on a scheduled job (e.g. "Asia/Hong_Kong" from
      // user intent), and the owning user is still on the 'UTC' default,
      // adopt the job's zone as the user's zone. This is the only
      // structured-data path that reliably catches telegram-only users
      // who never touch web chat — the 2026-04-18 Cynthia signup was UTC
      // because the mini-app verify never captured tz, and she stayed UTC
      // for 5 days even though her 2026-04-19 pill job was Asia/Hong_Kong.
      // Gated on the zone actually being different from UTC so we never
      // "backfill" UTC onto UTC or overwrite an already-meaningful zone.
      // Fire-and-forget WOULD be wrong here — if it fails the next job
      // creation retries anyway, but the UPDATE is idempotent so awaiting
      // gives us a cleaner test story.
      if (params.timezone && params.timezone !== 'UTC') {
        await query(
          `UPDATE users
              SET timezone = $2, updated_at = now()
            WHERE id = $1 AND (timezone IS NULL OR timezone = 'UTC')`,
          [params.userId, params.timezone],
        ).catch((err) => {
          console.error('[job-store] users.timezone backfill failed:', err)
        })
      }

      const job = rowToJob(result.rows[0])
      notifyJobChange(job.id, job.assistantId, 'create')
      return job
    },

    async update(id, updates) {
      const sets: string[] = ['updated_at = now()']
      const values: unknown[] = []
      let idx = 1

      if (updates.schedule !== undefined) { sets.push(`schedule = $${idx}`); values.push(JSON.stringify(updates.schedule)); idx++ }
      if (updates.timezone !== undefined) { sets.push(`timezone = $${idx}`); values.push(updates.timezone); idx++ }
      if (updates.mode !== undefined) { sets.push(`mode = $${idx}`); values.push(updates.mode); idx++ }
      if (updates.instructions !== undefined) { sets.push(`instructions = $${idx}`); values.push(updates.instructions); idx++ }
      if (updates.enabled !== undefined) { sets.push(`enabled = $${idx}`); values.push(updates.enabled); idx++ }
      if (updates.nextRunAt !== undefined) { sets.push(`next_run_at = $${idx}`); values.push(updates.nextRunAt); idx++ }
      if (updates.channelType !== undefined) { sets.push(`channel_type = $${idx}`); values.push(updates.channelType); idx++ }
      if (updates.channelId !== undefined) { sets.push(`channel_id = $${idx}`); values.push(updates.channelId); idx++ }
      if (updates.silentUntilFire !== undefined) { sets.push(`silent_until_fire = $${idx}`); values.push(updates.silentUntilFire); idx++ }
      if (updates.nagIntervalMins !== undefined) { sets.push(`nag_interval_mins = $${idx}`); values.push(updates.nagIntervalMins); idx++ }
      if (updates.nagUntilKeyword !== undefined) { sets.push(`nag_until_keyword = $${idx}`); values.push(updates.nagUntilKeyword); idx++ }
      if (updates.viewId !== undefined) { sets.push(`view_id = $${idx}`); values.push(updates.viewId); idx++ }

      values.push(id)
      const result = await query<JobRow>(
        `UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${JOB_SELECT}`,
        values,
      )
      if (!result.rows[0]) return null
      const job = rowToJob(result.rows[0])
      notifyJobChange(job.id, job.assistantId, 'update')
      return job
    },

    async delete(id) {
      const result = await query<{ assistantId: string }>(
        `DELETE FROM scheduled_jobs WHERE id = $1 RETURNING assistant_id AS "assistantId"`,
        [id],
      )
      if (result.rows[0]) notifyJobChange(id, result.rows[0].assistantId, 'delete')
      return (result.rowCount ?? 0) > 0
    },

    async get(id) {
      const result = await query<JobRow>(
        `SELECT ${JOB_SELECT} FROM scheduled_jobs WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToJob(result.rows[0]) : null
    },

    async list(assistantId, userId) {
      const result = await query<JobRow>(
        `SELECT ${JOB_SELECT} FROM scheduled_jobs WHERE assistant_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
        [assistantId, userId],
      )
      return result.rows.map(rowToJob)
    },

    async listFiringJobsForWorkflowSystem(workflowId) {
      // EVERY firing row of the workflow, ANY channel — no `channel_type`
      // filter, so a delivery-backed reminder's messaging/doc row is included.
      // Still excludes wait wake-ups (workflow_step_run_id IS NULL). Oldest
      // first: reconcilers keep row [0], which is the originally-authored one
      // holding the user's delivery target.
      //
      // Do NOT reintroduce a `channel_type = 'workflow'` variant. That filter
      // is what let a rescheduled Telegram reminder mint a second firing row
      // and deliver two identical daily summaries (2026-08-08); graded by
      // `pnpm check` (invariants/workflow-firing-row-reconcile).
      const result = await query<JobRow>(
        `SELECT ${JOB_SELECT} FROM scheduled_jobs
           WHERE workflow_id = $1 AND workflow_step_run_id IS NULL
           ORDER BY created_at ASC`,
        [workflowId],
      )
      return result.rows.map(rowToJob)
    },

    async listEnabledByView(userId, viewId) {
      // Backs the doc page-view schedule badge (migration 229). Owner-scoped
      // (user_id) so a member never sees another member's job instructions on a
      // shared page; enabled-only because a paused schedule shouldn't claim the
      // page is auto-maintained. Soonest-firing first. Bare `query()` with an
      // explicit user_id matches `list` / `countEnabledRecurring` — the userId
      // is in the WHERE clause and this runs from an RLS-authorised route that
      // already confirmed the user can see the page.
      const result = await query<JobRow>(
        `SELECT ${JOB_SELECT} FROM scheduled_jobs
           WHERE view_id = $1 AND user_id = $2 AND enabled = true
           ORDER BY next_run_at ASC`,
        [viewId, userId],
      )
      return result.rows.map(rowToJob)
    },

    async getDueJobs() {
      // Atomic lease claim. The plain `SELECT ... WHERE next_run_at <= now()`
      // we used before was unsafe: `markCompleted` only advances next_run_at
      // *after* the executor returns, so any process death mid-execution
      // (e.g. container OOM) left the row pickable on the next tick. On
      // 2026-05-01 this turned a single OOMing cron into ~1,191 fires in 7h
      // ($7.51 of overhead, ~90% of platform spend that day).
      //
      // Now: the SELECT-and-advance happens in one statement. We push
      // next_run_at 10 minutes into the future as a lease before the
      // executor runs. markCompleted/markFailed overwrites that to the real
      // next-run time on the success/failure paths (unchanged). If the
      // process dies before either fires, the lease holds and the worst-case
      // re-fire rate becomes 6/hour instead of 170/hour.
      //
      // FOR UPDATE SKIP LOCKED is defense in depth — we run min=max=1 today,
      // but the same statement is correct under any future scale-out.
      // Pinned jobs are only discovered here, never leased in a batch.
      const pinned = (await query<JobRow>(`SELECT ${JOB_SELECT} FROM scheduled_jobs
        WHERE workflow_authoring_snapshot IS NOT NULL AND enabled AND next_run_at<=clock_timestamp()
        AND (schedule_claim_id IS NULL OR schedule_claim_expires_at<=clock_timestamp()) ORDER BY id`)).rows.map(rowToJob)
      const result = await query<JobRow>(
        `UPDATE scheduled_jobs
         SET next_run_at = now() + interval '10 minutes',
             updated_at = now()
         WHERE id IN (
           SELECT id FROM scheduled_jobs
           WHERE next_run_at <= now() AND enabled = true AND workflow_authoring_snapshot IS NULL
           FOR UPDATE SKIP LOCKED
         )
         RETURNING ${JOB_SELECT}`,
        [],
      )
      return [...pinned, ...result.rows.map(rowToJob)]
    },

    async claimDueJob(id) {
      const pointer = (await query<{ workspaceId: string; workflowId: string }>(`SELECT w.workspace_id AS "workspaceId",w.id AS "workflowId"
        FROM scheduled_jobs j JOIN workflows w ON w.id=j.workflow_id WHERE j.id=$1 AND j.workflow_authoring_snapshot IS NOT NULL`, [id])).rows[0]
      if (!pointer) return null
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        // Canonical lock order: workspace, workflow, then job (also deletion).
        const source = await readWorkflowScheduleAuthority(client, pointer.workspaceId, pointer.workflowId)
        const job = (await client.query<JobRow & { snapshot: unknown }>(`SELECT ${JOB_SELECT},workflow_authoring_snapshot AS snapshot
          FROM scheduled_jobs WHERE id=$1 AND workflow_id=$2 AND enabled AND next_run_at<=clock_timestamp()
          AND (schedule_claim_id IS NULL OR schedule_claim_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED`, [id,pointer.workflowId])).rows[0]
        if (!job) { await client.query('COMMIT'); return null }
        if (!isDeepStrictEqual(job.snapshot,source.snapshot)) throw new WorkspaceAccessError('workflow_schedule_binding_conflict', 409)
        const claimed = (await client.query<JobRow>(`UPDATE scheduled_jobs SET schedule_claim_expires_at=clock_timestamp()+interval '10 minutes',updated_at=now(),
          schedule_claim_id=gen_random_uuid(),schedule_claim_consumed=false WHERE id=$1 RETURNING ${JOB_SELECT}`, [id])).rows[0]
        await client.query('COMMIT')
        return rowToJob(claimed)
      } catch (error) {
        await client.query('ROLLBACK')
        if (error instanceof WorkspaceAccessError || (error as { reason?: string }).reason === 'workflow_authority_unavailable') return null
        throw error
      } finally { client.release() }
    },

    async advanceScheduleClaimNag(id, claimId, activeNag, nextRunAt) {
      // Single-row CAS: never take a workflow/workspace lock after this lock.
      // Merge rather than replacing failure counters or other runtime state.
      const result = await query(`UPDATE scheduled_jobs
        SET state_json=COALESCE(state_json,'{}'::jsonb) || jsonb_build_object('activeNag',$3::jsonb),
          next_run_at=$4,updated_at=now()
        WHERE id=$1 AND schedule_claim_id=$2 AND workflow_authoring_snapshot IS NOT NULL
          AND enabled AND NOT schedule_claim_consumed AND schedule_claim_expires_at>clock_timestamp()`,
      [id,claimId,JSON.stringify(activeNag),safeNextRunAt(id,nextRunAt)])
      return (result.rowCount ?? 0) > 0
    },

    async finishScheduleClaim(id, claimId, outcome) {
      const unchanged = { applied: false, disabled: false, failures: 0 }
      const pointer = (await query<{ workspaceId: string; workflowId: string }>(`SELECT w.workspace_id AS "workspaceId",w.id AS "workflowId"
        FROM scheduled_jobs j JOIN workflows w ON w.id=j.workflow_id WHERE j.id=$1 AND j.workflow_authoring_snapshot IS NOT NULL`, [id])).rows[0]
      if (!pointer) return unchanged
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await lockOperationalPolicy(client,pointer.workspaceId)
        await client.query('SELECT id FROM workflows WHERE id=$1 AND workspace_id=$2 FOR SHARE', [pointer.workflowId,pointer.workspaceId])
        const job = (await client.query<JobRow>(`SELECT ${JOB_SELECT} FROM scheduled_jobs
          WHERE id=$1 AND workflow_id=$2 AND schedule_claim_id=$3 AND schedule_claim_consumed FOR UPDATE`, [id,pointer.workflowId,claimId])).rows[0]
        if (!job) { await client.query('COMMIT'); return unchanged }
        const failures = outcome.success ? 0 : (job.state?.consecutiveFailures ?? 0) + 1
        const disabled = job.schedule.type === 'once' || failures >= outcome.maxConsecutiveFailures
        const state = { ...job.state, consecutiveFailures: failures }
        // Read under the claim-fenced row lock: a resolved nag resumes its
        // normal schedule; an open cycle keeps the executor's exact deadline.
        const nextRunAt = !disabled && job.nagIntervalMins != null && job.state?.activeNag
          ? job.nextRunAt : outcome.nextRunAt
        await client.query(`UPDATE scheduled_jobs SET enabled=enabled AND NOT $3,next_run_at=$4,last_run_at=clock_timestamp(),
          last_status=$5,state_json=$6::jsonb,schedule_claim_id=NULL,schedule_claim_expires_at=NULL,updated_at=now() WHERE id=$1 AND schedule_claim_id=$2`,
        [id,claimId,disabled,safeNextRunAt(id,nextRunAt),outcome.success ? 'completed' : 'failed',JSON.stringify(state)])
        await client.query('COMMIT')
        return { applied: true,disabled,failures }
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },

    async markCompleted(id, nextRunAt) {
      // Read the row to learn (a) whether a nag cycle is open (activeNag)
      // and (b) whether this is a one-shot we should reap on success.
      //
      // (a) Open nag cycle: the executor advanced `next_run_at` to
      //     `now + nagIntervalMins * 60_000` already. Preserve that
      //     override — overwriting with `computeNextRun(schedule, tz)`
      //     would push the next nag to tomorrow.
      // (b) One-shot completion: a non-nag `once` job has done its job.
      //     Reap it (and the implicit one-step reminder workflow) instead
      //     of leaving a disabled trigger row behind. The audit lives in
      //     `workflow_runs` + `analytics_events`. The cascade mirrors
      //     `deleteScheduledJob`'s `channelType !== 'workflow'` guard so a
      //     `scheduleWorkflow`-backed multi-step workflow stays intact.
      const rowResult = await query<{
        schedule: StructuredSchedule
        nag_interval_mins: number | null
        channel_type: string
        workflow_id: string | null
        state_json: { activeNag?: unknown } | null
        assistant_id: string
      }>(
        `SELECT schedule, nag_interval_mins, channel_type, workflow_id, state_json, assistant_id
           FROM scheduled_jobs WHERE id = $1 AND workflow_authoring_snapshot IS NULL`,
        [id],
      )
      const row = rowResult.rows[0]
      if (!row) return

      const hasOpenNag = row.state_json != null && 'activeNag' in row.state_json
      const isOnceNonNag =
        row.schedule?.type === 'once' && row.nag_interval_mins == null

      if (isOnceNonNag) {
        // Reap the trigger row.
        await query(`DELETE FROM scheduled_jobs WHERE id = $1 AND workflow_authoring_snapshot IS NULL AND workflow_authoring_snapshot IS NULL`, [id])
        // Cascade-delete the implicit one-step reminder workflow. A
        // `scheduleWorkflow`-backed job (channelType 'workflow') points at
        // a user-authored multi-step workflow we must leave intact —
        // mirrors `deleteScheduledJob` at
        // packages/core/src/scheduling/tools.ts:406-410.
        if (row.workflow_id && row.channel_type !== 'workflow') {
          await query<{ workspaceId: string }>(
            `DELETE FROM workflows WHERE id = $1 RETURNING workspace_id AS "workspaceId"`,
            [row.workflow_id],
          )
            .then((r) => {
              // The implicit one-step reminder workflow is list-visible;
              // its reap must repaint the workflow surfaces too.
              if (r.rows[0]) notifyWorkspaceChange(r.rows[0].workspaceId, 'workflow', 'delete', row.workflow_id!)
            })
            .catch((err) => {
              console.error(
                `[job-store] failed to cascade-delete workflow ${row.workflow_id} for job ${id}:`,
                err,
              )
            })
        } else if (row.workflow_id) {
          // channel_type === 'workflow': a `createWorkflow`-shaped one-off (the
          // shape the model builds for reminders today). We can't tell it apart
          // from a hand-built one-off-scheduled workflow at this seam, so retire
          // it to `archived` (reversible) instead of deleting — its single fire
          // is spent, so it leaves the active grid. The sweep's grace-gated
          // one-off delete GCs it later.
          await retireBackingWorkflow(row.workflow_id)
        }
        notifyJobChange(id, row.assistant_id, 'delete')
        return
      }

      if (hasOpenNag) {
        // Don't touch next_run_at — executor already advanced it to
        // `now + nagIntervalMins * 60_000`. Just stamp last_run_at /
        // last_status.
        await query(
          `UPDATE scheduled_jobs SET last_run_at = now(), last_status = 'completed', updated_at = now() WHERE id = $1 AND workflow_authoring_snapshot IS NULL`,
          [id],
        )
        notifyJobChange(id, row.assistant_id, 'update')
        return
      }

      await query(
        `UPDATE scheduled_jobs SET last_run_at = now(), last_status = 'completed', next_run_at = $2, updated_at = now() WHERE id = $1 AND workflow_authoring_snapshot IS NULL`,
        [id, safeNextRunAt(id, nextRunAt)],
      )
      notifyJobChange(id, row.assistant_id, 'update')
    },

    async markFailed(id, nextRunAt) {
      // Fold the discriminators the terminal-failure reap needs into the same
      // UPDATE's RETURNING — no extra read on the common recurring-failure path.
      const result = await query<{
        assistantId: string
        schedule: StructuredSchedule
        nagIntervalMins: number | null
        workflowId: string | null
      }>(
        `UPDATE scheduled_jobs SET last_run_at = now(), last_status = 'failed', next_run_at = $2, updated_at = now() WHERE id = $1 AND workflow_authoring_snapshot IS NULL
         RETURNING assistant_id AS "assistantId", schedule, nag_interval_mins AS "nagIntervalMins", workflow_id AS "workflowId"`,
        [id, safeNextRunAt(id, nextRunAt)],
      )
      const row = result.rows[0]
      if (!row) return
      notifyJobChange(id, row.assistantId, 'update')

      // A `once` job never retries — the poll worker disables it on the first
      // failure — so `markFailed` on a once-job is always terminal and its
      // backing workflow is spent. Retire it (archived, so the failed fire
      // stays visible + debuggable) the same way `markCompleted` does, so a
      // failed reminder also leaves the active grid. Recurring failures (which
      // will retry or hit the auto-disable backstop) and nag parents are left
      // alone.
      const isOnceNonNag = row.schedule?.type === 'once' && row.nagIntervalMins == null
      if (isOnceNonNag && row.workflowId) {
        await retireBackingWorkflow(row.workflowId)
      }
    },

    async purgeDisabledOlderThan(cutoff) {
      // System-level GC — not user-scoped, so a bare `query()` is correct
      // (no RLS context to thread through). Mirrors the views-prune
      // worker's once-a-day reap. The audit for what these rows USED to
      // do lives in `workflow_runs` + `analytics_events`; the disabled
      // trigger row carries no information past disable.
      //
      // Age is measured by `COALESCE(last_run_at, created_at)` — when the job
      // actually went inactive — NOT `updated_at`. `updated_at` is bumped by
      // unrelated table-wide migrations/backfills, which resets the TTL clock
      // for all history and silently stops the GC (observed 2026-05-31: a
      // 2026-05-21 migration bumped every disabled row's `updated_at`, so the
      // reap matched 0 rows while 146 disabled rows piled up). `last_run_at`
      // reflects the last fire; `created_at` covers disabled-without-running.
      const result = await query(
        `DELETE FROM scheduled_jobs WHERE enabled = false AND COALESCE(last_run_at, created_at) < $1`,
        [cutoff],
      )
      return result.rowCount ?? 0
    },

    async countEnabledRecurring(userId) {
      // Powers the per-user enabled-recurring cap enforced in
      // `createScheduledJob`. Once-jobs and disabled rows are excluded —
      // the cap is about "actively-firing schedules", not history. Bare
      // `query()` because the userId is already in the WHERE clause and
      // the cap check runs in a user-bound tool execution path.
      const result = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM scheduled_jobs
           WHERE user_id = $1 AND enabled = true AND schedule->>'type' != 'once'`,
        [userId],
      )
      return Number(result.rows[0]?.count ?? 0)
    },

    async setState(id, state) {
      await query(
        `UPDATE scheduled_jobs SET state_json = $2, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(state ?? {})],
      )
    },

    async resolveActiveNag(id, userId, observedNag, nextRunAt) {
      // One statement/transaction: PostgreSQL rechecks the cycle predicate
      // after waiting for a concurrent writer, and subtracts from the LIVE
      // JSON rather than a stale snapshot (notably consecutiveFailures).
      const result = await query<{ assistantId: string }>(`UPDATE scheduled_jobs
        SET state_json=state_json - 'activeNag',next_run_at=$4,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND enabled AND state_json->'activeNag'=$3::jsonb
        RETURNING assistant_id AS "assistantId"`,
      [id,userId,JSON.stringify(observedNag),safeNextRunAt(id,nextRunAt)])
      if (!result.rows[0]) return false
      notifyJobChange(id,result.rows[0].assistantId,'update')
      return true
    },

    async listActiveNagsForUser(userId) {
      // Backed by partial index idx_jobs_active_nag (migration 073).
      const result = await query<JobRow>(
        `SELECT ${JOB_SELECT} FROM scheduled_jobs
         WHERE user_id = $1 AND state_json ? 'activeNag' AND enabled = true`,
        [userId],
      )
      return result.rows.map(rowToJob)
    },

    async search(params) {
      // Keyset pagination on `(created_at DESC, id DESC)`. Stable ordering
      // + a tie-breaker on `id` so we don't drop rows that happen to share
      // a created_at microsecond. The hard limit is enforced by the tool
      // layer (max 50) but defensively clamped here too — a Gemini 400
      // from an over-budget tool result is the failure mode we're guarding
      // against (the 4,839-row incident, 2026-05-25).
      const limit = Math.max(1, Math.min(params.limit, 50))

      // Base arm: the caller's own jobs. Workspace arm (when a workspace is
      // in scope): plus every workflow-TRIGGER job of a workflow in that
      // workspace, any creator — a trigger fires a workspace-scoped object
      // every member can already view/disable via the builder, so its
      // trigger rows carry the same visibility. Teammates' personal
      // reminders stay private (they never have channel_type='workflow').
      // Structural discriminator per scheduled-trigger.ts: scheduled
      // triggers are channel_type='workflow' with no step-run id (wait
      // wake-ups carry one). Membership is implied by the session that
      // supplied workspaceId. (Incident 2026-06-10: a member's runaway
      // hourly triggers were invisible to every other member.)
      const where: string[] = []
      const values: unknown[] = [params.assistantId, params.userId]
      let idx = 3
      if (params.workspaceId) {
        where.push(
          `((assistant_id = $1 AND user_id = $2) OR (channel_type = 'workflow' AND workflow_step_run_id IS NULL AND workflow_id IN (SELECT id FROM workflows WHERE workspace_id = $${idx})))`,
        )
        values.push(params.workspaceId)
        idx++
      } else {
        where.push('assistant_id = $1', 'user_id = $2')
      }

      if (params.enabled !== undefined) {
        where.push(`enabled = $${idx}`)
        values.push(params.enabled)
        idx++
      }
      if (params.text !== undefined && params.text.trim() !== '') {
        where.push(`instructions ILIKE '%' || $${idx} || '%'`)
        values.push(params.text)
        idx++
      }
      if (params.scheduleType === 'once') {
        where.push(`schedule->>'type' = 'once'`)
      } else if (params.scheduleType === 'recurring') {
        where.push(`schedule->>'type' != 'once'`)
      }

      if (params.cursor) {
        const parsed = decodeCursor(params.cursor)
        if (parsed) {
          where.push(`(created_at, id) < ($${idx}, $${idx + 1})`)
          values.push(parsed.createdAt)
          values.push(parsed.id)
          idx += 2
        }
      }

      // Fetch limit + 1 so we know if there's a next page without a
      // separate COUNT or follow-up query.
      values.push(limit + 1)
      const limitParam = `$${idx}`

      const result = await query<JobRow & { createdAt: Date }>(
        `SELECT ${JOB_SELECT}, created_at as "createdAt"
           FROM scheduled_jobs
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limitParam}`,
        values,
      )

      let nextCursor: string | null = null
      const rows = result.rows
      if (rows.length > limit) {
        const lastIncluded = rows[limit - 1]
        nextCursor = encodeCursor({
          createdAt: lastIncluded.createdAt,
          id: lastIncluded.id,
        })
        rows.length = limit
      }

      return {
        jobs: rows.map(rowToJob),
        nextCursor,
      }
    },
  }
}

/**
 * Opaque base64 cursor for keyset pagination. The shape is intentionally
 * an internal detail — clients pass `nextCursor` back verbatim.
 */
type CursorPayload = { createdAt: Date; id: string }

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(
    JSON.stringify({ c: payload.createdAt.toISOString(), i: payload.id }),
    'utf8',
  ).toString('base64')
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { c?: string; i?: string }
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null
    const createdAt = new Date(parsed.c)
    if (Number.isNaN(createdAt.getTime())) return null
    return { createdAt, id: parsed.i }
  } catch {
    return null
  }
}
