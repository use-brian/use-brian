/**
 * Workflow store + run store, backed by PostgreSQL.
 *
 * Two interfaces, two factories:
 *   - createDbWorkflowStore(): WorkflowStore — definitions (RLS-gated reads).
 *   - createDbWorkflowRunStore(): WorkflowRunStore — runs + step runs. Reads
 *     are split: the route-side `getRunById` and `listStepRuns` go through
 *     RLS; the executor's `getRunSystem` / writes use the bare `query`
 *     helper (the executor authorizes via the originating route or the
 *     poll worker, then mutates without per-row RLS).
 *
 * Mirrors the tasks-store / job-store split: the application owns the
 * authorization boundary; DB stores are thin SQL adapters.
 *
 * [COMP:api/workflow-store]
 */

import type {
  ClaimedRun,
  EventSubscription,
  EventTriggeredWorkflow,
  PageWorkflowRunSummary,
  RunQueueStore,
  WorkflowDefinition,
  WorkflowLifecycleRow,
  WorkflowLifecycleState,
  WorkflowModelAlias,
  WorkflowRecord,
  WorkflowRunOutcome,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStepRunStatus,
  WorkflowStepType,
  WorkflowStore,
  WorkflowTrigger,
  WorkflowTriggerKind,
} from '@sidanclaw/core'
import { query, queryWithRLS } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

// ── workflows ───────────────────────────────────────────────────────────

const WORKFLOW_SELECT = `
  id,
  workspace_id        AS "workspaceId",
  created_by          AS "createdBy",
  name,
  description,
  definition,
  enabled,
  paused_reason       AS "pausedReason",
  trigger,
  webhook_slug        AS "webhookSlug",
  webhook_secret      AS "webhookSecret",
  model_alias         AS "modelAlias",
  max_turns           AS "maxTurns",
  research_mode       AS "researchMode",
  name_manually_set   AS "nameManuallySet",
  lifecycle_state     AS "lifecycleState",
  lifecycle_transitioned_at AS "lifecycleTransitionedAt",
  lifecycle_reason    AS "lifecycleReason",
  pinned,
  digested_at         AS "digestedAt",
  digest_verdict      AS "digestVerdict",
  created_at          AS "createdAt",
  updated_at          AS "updatedAt"
`

type WorkflowRow = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  description: string | null
  definition: WorkflowDefinition
  enabled: boolean
  pausedReason: string | null
  trigger: WorkflowTrigger | null
  webhookSlug: string | null
  webhookSecret: string | null
  modelAlias: WorkflowModelAlias
  maxTurns: number | null
  researchMode: boolean
  nameManuallySet: boolean
  lifecycleState: WorkflowLifecycleState
  lifecycleTransitionedAt: Date | null
  lifecycleReason: string | null
  pinned: boolean
  digestedAt: Date | null
  digestVerdict: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Backfill per-step run settings (`modelAlias`, `researchMode`, `maxTurns`)
 * from the workflow row's legacy columns onto any `assistant_call` step
 * that doesn't yet carry its own values. Lets pre-per-step workflows keep
 * the executor's "step-level always wins" contract without a data
 * migration — the row's columns are still the source of truth for
 * legacy authored workflows; the executor never reads them directly.
 *
 * Produces a new definition object — never mutates `def`.
 */
function backfillStepRunSettings(
  def: WorkflowDefinition,
  row: WorkflowRow,
): WorkflowDefinition {
  return {
    ...def,
    steps: def.steps.map((s) => {
      if (s.type !== 'assistant_call') return s
      return {
        ...s,
        modelAlias: s.modelAlias ?? row.modelAlias,
        researchMode: s.researchMode ?? row.researchMode,
        maxTurns: s.maxTurns ?? row.maxTurns,
      }
    }),
  }
}

function rowToWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy,
    name: row.name,
    description: row.description,
    definition: backfillStepRunSettings(row.definition, row),
    enabled: row.enabled,
    pausedReason: row.pausedReason,
    trigger: row.trigger ?? { kind: 'manual' },
    webhookSlug: row.webhookSlug,
    webhookSecret: row.webhookSecret,
    modelAlias: row.modelAlias,
    maxTurns: row.maxTurns,
    researchMode: row.researchMode,
    nameManuallySet: row.nameManuallySet,
    lifecycleState: row.lifecycleState,
    lifecycleTransitionedAt: row.lifecycleTransitionedAt,
    lifecycleReason: row.lifecycleReason,
    pinned: row.pinned,
    digestedAt: row.digestedAt,
    digestVerdict: row.digestVerdict,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function createDbWorkflowStore(): WorkflowStore {
  return {
    async create({
      userId,
      workspaceId,
      name,
      description,
      definition,
      trigger,
      webhookSlug,
      webhookSecret,
      modelAlias,
      maxTurns,
      researchMode,
    }) {
      const result = await queryWithRLS<WorkflowRow>(
        userId,
        `INSERT INTO workflows (
           workspace_id, created_by, name, description, definition, trigger,
           webhook_slug, webhook_secret,
           model_alias, max_turns, research_mode
         )
         VALUES (
           $1, $2, $3, $4, $5, COALESCE($6::jsonb, '{"kind":"manual"}'::jsonb),
           $7, $8,
           COALESCE($9, 'pro'), $10, COALESCE($11, false)
         )
         RETURNING ${WORKFLOW_SELECT}`,
        [
          workspaceId,
          userId,
          name,
          description ?? null,
          JSON.stringify(definition),
          trigger ? JSON.stringify(trigger) : null,
          webhookSlug ?? null,
          webhookSecret ?? null,
          modelAlias ?? null,
          maxTurns ?? null,
          researchMode ?? null,
        ],
      )
      const record = rowToWorkflow(result.rows[0])
      notifyWorkspaceChange(record.workspaceId, 'workflow', 'create', record.id)
      return record
    },
    async getById(userId, id) {
      const result = await queryWithRLS<WorkflowRow>(
        userId,
        `SELECT ${WORKFLOW_SELECT} FROM workflows WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToWorkflow(result.rows[0]) : null
    },
    async list(userId, workspaceId, opts) {
      // Archived workflows are hidden from every default listing (mig 308);
      // surfaces that render the archived section opt in explicitly.
      const archivedFilter = opts?.includeArchived ? '' : `AND lifecycle_state <> 'archived'`
      const result = await queryWithRLS<WorkflowRow>(
        userId,
        `SELECT ${WORKFLOW_SELECT} FROM workflows
         WHERE workspace_id = $1 ${archivedFilter}
         ORDER BY updated_at DESC`,
        [workspaceId],
      )
      return result.rows.map(rowToWorkflow)
    },
    async update(userId, id, fields) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (fields.name !== undefined) { sets.push(`name = $${idx}`); values.push(fields.name); idx++ }
      if (fields.description !== undefined) { sets.push(`description = $${idx}`); values.push(fields.description); idx++ }
      if (fields.definition !== undefined) { sets.push(`definition = $${idx}`); values.push(JSON.stringify(fields.definition)); idx++ }
      if (fields.enabled !== undefined) { sets.push(`enabled = $${idx}`); values.push(fields.enabled); idx++ }
      // Re-enabling clears a storm-guard pause — the reason described why the
      // workflow was disabled; once a member turns it back on it's stale.
      if (fields.enabled === true) { sets.push('paused_reason = NULL') }
      if (fields.trigger !== undefined) { sets.push(`trigger = $${idx}::jsonb`); values.push(JSON.stringify(fields.trigger)); idx++ }
      if (fields.webhookSlug !== undefined) { sets.push(`webhook_slug = $${idx}`); values.push(fields.webhookSlug); idx++ }
      if (fields.webhookSecret !== undefined) { sets.push(`webhook_secret = $${idx}`); values.push(fields.webhookSecret); idx++ }
      if (fields.modelAlias !== undefined) { sets.push(`model_alias = $${idx}`); values.push(fields.modelAlias); idx++ }
      if (fields.maxTurns !== undefined) { sets.push(`max_turns = $${idx}`); values.push(fields.maxTurns); idx++ }
      if (fields.researchMode !== undefined) { sets.push(`research_mode = $${idx}`); values.push(fields.researchMode); idx++ }
      if (fields.nameManuallySet !== undefined) { sets.push(`name_manually_set = $${idx}`); values.push(fields.nameManuallySet); idx++ }
      if (fields.pinned !== undefined) { sets.push(`pinned = $${idx}`); values.push(fields.pinned); idx++ }
      if (fields.lifecycleState !== undefined) {
        // The user-facing restore path (mig 308). Stamps the transition and
        // clears the sweep's reason so the row reads clean again.
        sets.push(`lifecycle_state = $${idx}`); values.push(fields.lifecycleState); idx++
        sets.push('lifecycle_transitioned_at = now()')
        sets.push('lifecycle_reason = NULL')
      }

      if (sets.length === 0) {
        // Nothing to patch — read back current state.
        const cur = await queryWithRLS<WorkflowRow>(
          userId,
          `SELECT ${WORKFLOW_SELECT} FROM workflows WHERE id = $1`,
          [id],
        )
        return cur.rows[0] ? rowToWorkflow(cur.rows[0]) : null
      }

      if (fields.lifecycleState === undefined) {
        // Any real user edit is activity: un-stale the row immediately
        // instead of waiting for the next sweep tick (mig 308). Archived
        // rows stay archived until an explicit restore. Appended only when
        // a real patch runs, so an empty-fields update stays a pure read.
        sets.push(`lifecycle_state = CASE WHEN lifecycle_state = 'stale' THEN 'active' ELSE lifecycle_state END`)
      }

      values.push(id)
      const result = await queryWithRLS<WorkflowRow>(
        userId,
        `UPDATE workflows SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${WORKFLOW_SELECT}`,
        values,
      )
      if (!result.rows[0]) return null
      const record = rowToWorkflow(result.rows[0])
      notifyWorkspaceChange(record.workspaceId, 'workflow', 'update', record.id)
      return record
    },
    async updateAutoName(userId, id, name) {
      // Auto-titler write — mirrors `sessions.updateSessionTitle`. Only
      // writes when name_manually_set = false so a user rename sticks. Note
      // we do NOT bump updated_at here (no trigger fires for this column-
      // only update because the WHERE filter still touches `name` via the
      // SET; the global `trigger_set_updated_at` is on UPDATE — we let it
      // run and accept the bump, since the row is mutating).
      const result = await queryWithRLS<{ workspaceId: string }>(
        userId,
        `UPDATE workflows
            SET name = $2
          WHERE id = $1 AND name_manually_set = false
          RETURNING workspace_id AS "workspaceId"`,
        [id, name],
      )
      if (result.rows[0]) notifyWorkspaceChange(result.rows[0].workspaceId, 'workflow', 'update', id)
      return (result.rowCount ?? 0) > 0
    },
    async delete(userId, id) {
      const result = await queryWithRLS<{ workspaceId: string }>(
        userId,
        `DELETE FROM workflows WHERE id = $1 RETURNING workspace_id AS "workspaceId"`,
        [id],
      )
      if (result.rows[0]) notifyWorkspaceChange(result.rows[0].workspaceId, 'workflow', 'delete', id)
      return result.rowCount !== null && result.rowCount > 0
    },
    async findByWebhookSlugSystem(slug) {
      // System lookup — bypasses RLS so the public webhook receiver can
      // resolve the workflow before any user identity is available. The
      // route handler then validates the HMAC and uses workflow.createdBy
      // as the authorization fallback.
      const result = await query<WorkflowRow>(
        `SELECT ${WORKFLOW_SELECT} FROM workflows
         WHERE webhook_slug = $1 AND enabled = true
         LIMIT 1`,
        [slug],
      )
      return result.rows[0] ? rowToWorkflow(result.rows[0]) : null
    },
    async findByIdSystem(workflowId) {
      // System lookup — bypasses RLS so the workflow executor can advance
      // scheduled-trigger runs (`workflow_runs.triggered_by` is null by
      // spec, leaving the RLS-gated `getById` with no per-user context).
      // Membership was enforced upstream when the trigger row was
      // provisioned; the run's workspace_id carries the boundary
      // downstream. Mirrors `findByWebhookSlugSystem` for the scheduled
      // and wait-wakeup paths.
      const result = await query<WorkflowRow>(
        `SELECT ${WORKFLOW_SELECT} FROM workflows WHERE id = $1 LIMIT 1`,
        [workflowId],
      )
      return result.rows[0] ? rowToWorkflow(result.rows[0]) : null
    },
  }
}

// ── workflow_runs + workflow_step_runs ──────────────────────────────────

const RUN_SELECT = `
  id,
  workflow_id     AS "workflowId",
  workspace_id    AS "workspaceId",
  triggered_by    AS "triggeredBy",
  trigger_kind    AS "triggerKind",
  status,
  input,
  vars,
  current_step_id AS "currentStepId",
  error,
  outcome,
  started_at      AS "startedAt",
  finished_at     AS "finishedAt",
  last_active_at  AS "lastActiveAt"
`

type RunRow = {
  id: string
  workflowId: string
  workspaceId: string
  triggeredBy: string | null
  triggerKind: WorkflowTriggerKind
  status: WorkflowRunStatus
  input: Record<string, unknown>
  vars: Record<string, unknown>
  currentStepId: string | null
  error: Record<string, unknown> | null
  outcome: WorkflowRunOutcome | null
  startedAt: Date
  finishedAt: Date | null
  lastActiveAt: Date
}

function rowToRun(row: RunRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workspaceId: row.workspaceId,
    triggeredBy: row.triggeredBy,
    triggerKind: row.triggerKind,
    status: row.status,
    input: row.input ?? {},
    vars: row.vars ?? {},
    currentStepId: row.currentStepId,
    error: row.error,
    outcome: row.outcome ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastActiveAt: row.lastActiveAt,
  }
}

const STEP_RUN_SELECT = `
  id,
  run_id        AS "runId",
  step_id       AS "stepId",
  step_type     AS "stepType",
  status,
  input,
  output,
  error,
  started_at    AS "startedAt",
  finished_at   AS "finishedAt"
`

type StepRunRow = {
  id: string
  runId: string
  stepId: string
  stepType: WorkflowStepType
  status: WorkflowStepRunStatus
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  error: Record<string, unknown> | null
  startedAt: Date
  finishedAt: Date | null
}

function rowToStepRun(row: StepRunRow): WorkflowStepRunRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    stepType: row.stepType,
    status: row.status,
    input: row.input ?? {},
    output: row.output,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

/**
 * The doc page that CHANGED and fired a `page`-event-triggered run, read from
 * the run input the dispatcher built (`event-trigger.ts buildInput`):
 * `input.trigger.sourceType === 'page'` and the changed page at
 * `input.event.pageId` (the watched page is `input.trigger.pageId` — not this).
 * Returns null for every other source / a malformed input — the column is
 * nullable and this is best-effort, never throwing on a surprising shape.
 */
export function extractTriggerPageId(
  input: Record<string, unknown> | undefined,
): string | null {
  const trigger = input?.trigger
  if (!trigger || typeof trigger !== 'object') return null
  if ((trigger as { sourceType?: unknown }).sourceType !== 'page') return null
  const event = input?.event
  if (!event || typeof event !== 'object') return null
  const pageId = (event as { pageId?: unknown }).pageId
  return typeof pageId === 'string' && pageId.length > 0 ? pageId : null
}

export function createDbWorkflowRunStore(): WorkflowRunStore {
  return {
    async createRun({ workflowId, workspaceId, triggeredBy, triggerKind, input }) {
      // System-level write: the route handler authorized the run by
      // resolving the workflow via the user's RLS view; the run record
      // itself is system-owned.
      //
      // When a `page` event source started the run, stamp the CHANGED page
      // (`input.event.pageId`) onto trigger_page_id so that page can later
      // surface the runs it triggered. The watched page is `input.trigger.
      // pageId` — deliberately NOT what we key on. Other sources leave it null.
      const triggerPageId = extractTriggerPageId(input)
      const result = await query<RunRow>(
        `INSERT INTO workflow_runs (workflow_id, workspace_id, triggered_by, trigger_kind, input, trigger_page_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${RUN_SELECT}`,
        [
          workflowId,
          workspaceId,
          triggeredBy,
          triggerKind,
          JSON.stringify(input ?? {}),
          triggerPageId,
        ],
      )
      const run = rowToRun(result.rows[0])
      notifyWorkspaceChange(workspaceId, 'workflow_run', 'create', run.id)
      return run
    },
    async getRunById(userId, id) {
      const result = await queryWithRLS<RunRow>(
        userId,
        `SELECT ${RUN_SELECT} FROM workflow_runs WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToRun(result.rows[0]) : null
    },
    async getRunSystem(id) {
      const result = await query<RunRow>(
        `SELECT ${RUN_SELECT} FROM workflow_runs WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToRun(result.rows[0]) : null
    },
    async updateRun(id, fields) {
      const sets: string[] = ['last_active_at = now()']
      const values: unknown[] = []
      let idx = 1

      if (fields.status !== undefined) { sets.push(`status = $${idx}`); values.push(fields.status); idx++ }
      if (fields.currentStepId !== undefined) { sets.push(`current_step_id = $${idx}`); values.push(fields.currentStepId); idx++ }
      if (fields.vars !== undefined) { sets.push(`vars = $${idx}`); values.push(JSON.stringify(fields.vars)); idx++ }
      if (fields.error !== undefined) { sets.push(`error = $${idx}`); values.push(fields.error === null ? null : JSON.stringify(fields.error)); idx++ }
      if (fields.finishedAt !== undefined) { sets.push(`finished_at = $${idx}`); values.push(fields.finishedAt); idx++ }
      if (fields.outcome !== undefined) { sets.push(`outcome = $${idx}`); values.push(fields.outcome === null ? null : JSON.stringify(fields.outcome)); idx++ }

      if (sets.length === 1) {
        // Only last_active_at would be updated — skip the round-trip and
        // return the current row instead.
        const cur = await query<RunRow>(
          `SELECT ${RUN_SELECT} FROM workflow_runs WHERE id = $1`,
          [id],
        )
        return cur.rows[0] ? rowToRun(cur.rows[0]) : null
      }

      values.push(id)
      const result = await query<RunRow>(
        `UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${RUN_SELECT}`,
        values,
      )
      if (!result.rows[0]) return null
      const run = rowToRun(result.rows[0])
      // Run lifecycle transitions (status / step advance / outcome) are the
      // live-activity signal; the coalescer absorbs many-step bursts.
      notifyWorkspaceChange(run.workspaceId, 'workflow_run', 'update', run.id)
      return run
    },
    async createStepRun({ runId, stepId, stepType, input }) {
      const result = await query<StepRunRow & { workspaceId: string | null }>(
        `INSERT INTO workflow_step_runs (run_id, step_id, step_type, status, input)
         VALUES ($1, $2, $3, 'running', $4)
         RETURNING ${STEP_RUN_SELECT},
           (SELECT workspace_id FROM workflow_runs WHERE id = run_id) AS "workspaceId"`,
        [runId, stepId, stepType, JSON.stringify(input ?? {})],
      )
      notifyWorkspaceChange(result.rows[0]?.workspaceId, 'workflow_run', 'update', runId)
      return rowToStepRun(result.rows[0])
    },
    async updateStepRun(id, fields) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (fields.status !== undefined) { sets.push(`status = $${idx}`); values.push(fields.status); idx++ }
      if (fields.output !== undefined) { sets.push(`output = $${idx}`); values.push(fields.output === null ? null : JSON.stringify(fields.output)); idx++ }
      if (fields.error !== undefined) { sets.push(`error = $${idx}`); values.push(fields.error === null ? null : JSON.stringify(fields.error)); idx++ }
      if (fields.finishedAt !== undefined) { sets.push(`finished_at = $${idx}`); values.push(fields.finishedAt); idx++ }

      if (sets.length === 0) {
        const cur = await query<StepRunRow>(
          `SELECT ${STEP_RUN_SELECT} FROM workflow_step_runs WHERE id = $1`,
          [id],
        )
        return cur.rows[0] ? rowToStepRun(cur.rows[0]) : null
      }

      values.push(id)
      const result = await query<StepRunRow & { workspaceId: string | null }>(
        `UPDATE workflow_step_runs SET ${sets.join(', ')} WHERE id = $${idx}
         RETURNING ${STEP_RUN_SELECT},
           (SELECT workspace_id FROM workflow_runs WHERE id = run_id) AS "workspaceId"`,
        values,
      )
      if (!result.rows[0]) return null
      notifyWorkspaceChange(result.rows[0].workspaceId, 'workflow_run', 'update', result.rows[0].runId)
      return rowToStepRun(result.rows[0])
    },
    async listStepRuns(userId, runId) {
      const result = await queryWithRLS<StepRunRow>(
        userId,
        `SELECT ${STEP_RUN_SELECT} FROM workflow_step_runs
         WHERE run_id = $1 ORDER BY started_at`,
        [runId],
      )
      return result.rows.map(rowToStepRun)
    },
    async listRunsForWorkflow(userId, workflowId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200)
      const values: unknown[] = [workflowId]
      let statusClause = ''
      if (opts?.status && opts.status.length > 0) {
        values.push(opts.status)
        statusClause = ` AND status = ANY($${values.length}::text[])`
      }
      values.push(limit)
      const result = await queryWithRLS<RunRow>(
        userId,
        `SELECT ${RUN_SELECT} FROM workflow_runs
         WHERE workflow_id = $1${statusClause}
         ORDER BY started_at DESC
         LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(rowToRun)
    },
    async getLatestOutcomeForWorkflowSystem(workflowId, excludeRunId) {
      // System read (no RLS) — the executor calls this on every advance to
      // build the `{{lastRun.*}}` scope. Most recent TERMINAL run's distilled
      // outcome, excluding the run currently executing. `finished_at DESC
      // NULLS LAST` orders by terminal time; `started_at` breaks ties and
      // covers any terminal row whose finished_at was never stamped.
      const result = await query<{ id: string; outcome: WorkflowRunOutcome | null }>(
        `SELECT id, outcome FROM workflow_runs
          WHERE workflow_id = $1
            AND id <> $2
            AND status IN ('completed', 'failed', 'timeout')
          ORDER BY finished_at DESC NULLS LAST, started_at DESC
          LIMIT 1`,
        [workflowId, excludeRunId],
      )
      const row = result.rows[0]
      if (!row?.outcome) return row?.outcome ?? null
      // Blueprint output-contract: when that run saved a blueprint RECORD,
      // surface its typed fields as `lastRun.output.*` (+ `outputStatus` so a
      // condition can gate on completeness). Two producers stamp the run id:
      // a direct `saveBlueprintRecord` in the consult (source_kind='workflow')
      // and the research-synthesis arm of an anchored research step (the
      // engine stamps its SOURCE kind, 'research', with sourceRef=runId) —
      // match both. Read-time enrichment keeps the core executor
      // record-agnostic and works for any historical run. Failure degrades to
      // the plain outcome.
      try {
        const rec = await query<{ fields: Record<string, unknown>; status: string }>(
          `SELECT fields, status FROM blueprint_records
            WHERE source_kind IN ('workflow', 'research') AND source_id = $1
            ORDER BY updated_at DESC
            LIMIT 1`,
          [row.id],
        )
        if (rec.rows[0]) {
          return {
            ...row.outcome,
            output: rec.rows[0].fields ?? {},
            outputStatus: rec.rows[0].status,
          } as WorkflowRunOutcome
        }
      } catch (err) {
        console.warn('[workflow-store] lastRun.output enrichment failed:', err)
      }
      return row.outcome
    },
    async listRunsForPage(userId, pageId, opts) {
      const limit = Math.min(opts?.limit ?? 20, 100)
      // RLS-gated on both tables (workspace_member policies). The JOIN to
      // workflows yields the display name; `outcome.summary` is the distilled
      // result the chip shows once a run terminates. Newest first.
      const result = await queryWithRLS<{
        runId: string
        workflowId: string
        workflowName: string
        status: WorkflowRunStatus
        startedAt: Date
        finishedAt: Date | null
        outcome: WorkflowRunOutcome | null
      }>(
        userId,
        `SELECT r.id            AS "runId",
                r.workflow_id   AS "workflowId",
                w.name          AS "workflowName",
                r.status        AS "status",
                r.started_at    AS "startedAt",
                r.finished_at   AS "finishedAt",
                r.outcome       AS "outcome"
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.trigger_page_id = $1
          ORDER BY r.started_at DESC
          LIMIT $2`,
        [pageId, limit],
      )
      return result.rows.map(
        (row): PageWorkflowRunSummary => ({
          runId: row.runId,
          workflowId: row.workflowId,
          workflowName: row.workflowName,
          status: row.status,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          outcomeSummary: row.outcome?.summary ?? null,
        }),
      )
    },
  }
}

// ── Phase B helpers ────────────────────────────────────────────────────

/**
 * Look up the run id that owns a paused step run. Used by the scheduling
 * executor's wait wake-up path to resolve `scheduled_jobs.workflow_step_run_id`
 * back to the run that should resume.
 */
export async function getRunIdForStepRun(stepRunId: string): Promise<string | null> {
  const result = await query<{ runId: string }>(
    `SELECT run_id AS "runId" FROM workflow_step_runs WHERE id = $1`,
    [stepRunId],
  )
  return result.rows[0]?.runId ?? null
}

/**
 * Resolve the workspace's primary assistant for billing / cron-session
 * attribution on workflow-backed scheduled jobs. Mirrors the inline
 * lookup in apps/api/src/index.ts so wait wake-up can build a job
 * scaffold without re-hitting the user-channel dispatch path.
 */
export async function getPrimaryAssistantForWorkspace(workspaceId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM assistants WHERE workspace_id = $1 AND kind = 'primary' LIMIT 1`,
    [workspaceId],
  )
  return result.rows[0]?.id ?? null
}

// ── Event-trigger helpers (workflow event dispatcher) ───────────────────

/**
 * Every event-triggered workflow in a workspace. The shared workflow event
 * dispatcher (`createWorkflowEventDispatcher`) calls this once per
 * dispatched event, then does the source + `match` filtering in-process —
 * a connector instance and a channel integration are both expressible as
 * `trigger.event.sources[]`, so the lookup is workspace-scoped, not
 * source-scoped. System read — bypasses RLS because producers (poll
 * workers, channel webhooks) run with no user identity (mirrors
 * `findByWebhookSlugSystem`). Returns only `enabled` workflows whose
 * `trigger.kind='event'`.
 */
export async function findEventTriggeredWorkflowsSystem(
  workspaceId: string,
): Promise<EventTriggeredWorkflow[]> {
  const result = await query<{
    workflowId: string
    workspaceId: string
    sources: EventSubscription[] | null
  }>(
    `SELECT id AS "workflowId", workspace_id AS "workspaceId",
            trigger->'event'->'sources' AS "sources"
       FROM workflows
      WHERE workspace_id = $1
        AND enabled = true
        AND trigger->>'kind' = 'event'`,
    [workspaceId],
  )
  return result.rows.map((r) => ({
    workflowId: r.workflowId,
    workspaceId: r.workspaceId,
    sources: Array.isArray(r.sources) ? r.sources : [],
  }))
}

/**
 * The user who created a workflow. The workflow event dispatcher uses it
 * as the run's `triggered_by` for billing attribution — an event-fired
 * run has no initiating user, so it falls back to the creator (the same
 * choice the webhook receiver makes).
 */
export async function getWorkflowCreatorSystem(
  workflowId: string,
): Promise<string | null> {
  const result = await query<{ createdBy: string }>(
    `SELECT created_by AS "createdBy" FROM workflows WHERE id = $1`,
    [workflowId],
  )
  return result.rows[0]?.createdBy ?? null
}

// ── Admin (cross-tenant) reads — Wave 3 / ADM-A ──────────────────────
//
// These bypass RLS by design — the admin route layer is gated by
// `requireAdminKey`. Reads only; admin does not author or mutate runs
// (the executor + the user-side route + the poll worker own writes).
// See docs/plans/company-brain/admin-ui-revamp.md → Surface #3.

/** Filter / pagination params for the cross-tenant runs list. */
export type AdminWorkflowRunListParams = {
  workspaceId?: string
  status?: WorkflowRunStatus | WorkflowRunStatus[]
  /** Opaque cursor returned by the previous page. `${startedAtIso}_${id}`. */
  cursor?: string
  limit?: number
}

/** One row in the cross-tenant runs table — flattened metadata only. */
export type AdminWorkflowRunRow = {
  id: string
  workflowId: string
  workflowName: string
  workspaceId: string
  triggeredBy: string | null
  triggerKind: WorkflowTriggerKind
  status: WorkflowRunStatus
  currentStepId: string | null
  startedAt: Date
  finishedAt: Date | null
  lastActiveAt: Date
  /** Total step runs attached to this run. Powers the "8 / 12 steps" cell. */
  stepCount: number
  /** Duration in seconds; null while still running. */
  durationSeconds: number | null
}

export type AdminWorkflowRunListResult = {
  rows: AdminWorkflowRunRow[]
  /** Next-page cursor; null when no more rows. */
  nextCursor: string | null
}

/**
 * Detail row — admin-side `getRun` joins the workflow name and step runs.
 * Step run errors are returned as-is. Output is NOT returned cross-tenant.
 */
export type AdminWorkflowRunDetail = {
  run: AdminWorkflowRunRow
  workflow: {
    id: string
    name: string
    description: string | null
    enabled: boolean
  }
  stepRuns: Array<{
    id: string
    stepId: string
    stepType: WorkflowStepType
    status: WorkflowStepRunStatus
    startedAt: Date
    finishedAt: Date | null
    durationSeconds: number | null
    error: Record<string, unknown> | null
  }>
}

/**
 * Cross-tenant runs list. Bypasses RLS. Aggregates step counts in the
 * same query.
 */
export async function listRunsForAdmin(
  params: AdminWorkflowRunListParams,
): Promise<AdminWorkflowRunListResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  const where: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (params.workspaceId) {
    where.push(`r.workspace_id = $${idx++}`)
    values.push(params.workspaceId)
  }
  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status]
    where.push(`r.status = ANY($${idx++}::text[])`)
    values.push(statuses)
  }
  if (params.cursor) {
    const decoded = decodeRunCursor(params.cursor)
    if (decoded) {
      where.push(`(r.started_at, r.id) < ($${idx++}, $${idx++})`)
      values.push(decoded.startedAt, decoded.id)
    }
  }

  // Fetch limit+1 to detect more pages.
  values.push(limit + 1)
  const result = await query<{
    id: string
    workflowId: string
    workflowName: string
    workspaceId: string
    triggeredBy: string | null
    triggerKind: WorkflowTriggerKind
    status: WorkflowRunStatus
    currentStepId: string | null
    startedAt: Date
    finishedAt: Date | null
    lastActiveAt: Date
    stepCount: string
  }>(
    `SELECT
       r.id,
       r.workflow_id        AS "workflowId",
       w.name               AS "workflowName",
       r.workspace_id       AS "workspaceId",
       r.triggered_by       AS "triggeredBy",
       r.trigger_kind       AS "triggerKind",
       r.status,
       r.current_step_id    AS "currentStepId",
       r.started_at         AS "startedAt",
       r.finished_at        AS "finishedAt",
       r.last_active_at     AS "lastActiveAt",
       COALESCE(s.cnt, 0)::text AS "stepCount"
     FROM workflow_runs r
     JOIN workflows w ON w.id = r.workflow_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS cnt
         FROM workflow_step_runs sr
        WHERE sr.run_id = r.id
     ) s ON true
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.started_at DESC, r.id DESC
     LIMIT $${idx}`,
    values,
  )

  const rows = result.rows.slice(0, limit).map((r) => ({
    id: r.id,
    workflowId: r.workflowId,
    workflowName: r.workflowName,
    workspaceId: r.workspaceId,
    triggeredBy: r.triggeredBy,
    triggerKind: r.triggerKind,
    status: r.status,
    currentStepId: r.currentStepId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    lastActiveAt: r.lastActiveAt,
    stepCount: parseInt(r.stepCount, 10),
    durationSeconds: r.finishedAt
      ? Math.max(0, Math.floor((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000))
      : null,
  }))
  const hasMore = result.rows.length > limit
  const last = rows.length > 0 ? rows[rows.length - 1] : null
  const nextCursor = hasMore && last
    ? encodeRunCursor({ startedAt: last.startedAt, id: last.id })
    : null
  return { rows, nextCursor }
}

/**
 * Cross-tenant run detail — joins workflow + step runs. Step run output
 * is NOT returned (privacy boundary).
 */
export async function getRunByIdForAdmin(
  id: string,
): Promise<AdminWorkflowRunDetail | null> {
  const runResult = await query<{
    id: string
    workflowId: string
    workflowName: string
    workflowDescription: string | null
    workflowEnabled: boolean
    workspaceId: string
    triggeredBy: string | null
    triggerKind: WorkflowTriggerKind
    status: WorkflowRunStatus
    currentStepId: string | null
    startedAt: Date
    finishedAt: Date | null
    lastActiveAt: Date
  }>(
    `SELECT
       r.id,
       r.workflow_id        AS "workflowId",
       w.name               AS "workflowName",
       w.description        AS "workflowDescription",
       w.enabled            AS "workflowEnabled",
       r.workspace_id       AS "workspaceId",
       r.triggered_by       AS "triggeredBy",
       r.trigger_kind       AS "triggerKind",
       r.status,
       r.current_step_id    AS "currentStepId",
       r.started_at         AS "startedAt",
       r.finished_at        AS "finishedAt",
       r.last_active_at     AS "lastActiveAt"
     FROM workflow_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1`,
    [id],
  )
  if (!runResult.rows[0]) return null
  const r = runResult.rows[0]

  const stepsResult = await query<{
    id: string
    stepId: string
    stepType: WorkflowStepType
    status: WorkflowStepRunStatus
    startedAt: Date
    finishedAt: Date | null
    error: Record<string, unknown> | null
  }>(
    `SELECT
       id,
       step_id      AS "stepId",
       step_type    AS "stepType",
       status,
       started_at   AS "startedAt",
       finished_at  AS "finishedAt",
       error
     FROM workflow_step_runs
     WHERE run_id = $1
     ORDER BY started_at ASC, id ASC`,
    [id],
  )

  const durationSeconds = r.finishedAt
    ? Math.max(0, Math.floor((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000))
    : null

  return {
    run: {
      id: r.id,
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      workspaceId: r.workspaceId,
      triggeredBy: r.triggeredBy,
      triggerKind: r.triggerKind,
      status: r.status,
      currentStepId: r.currentStepId,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      lastActiveAt: r.lastActiveAt,
      stepCount: stepsResult.rows.length,
      durationSeconds,
    },
    workflow: {
      id: r.workflowId,
      name: r.workflowName,
      description: r.workflowDescription,
      enabled: r.workflowEnabled,
    },
    stepRuns: stepsResult.rows.map((s) => ({
      id: s.id,
      stepId: s.stepId,
      stepType: s.stepType,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationSeconds: s.finishedAt
        ? Math.max(0, Math.floor((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000))
        : null,
      error: s.error,
    })),
  }
}

/**
 * Workflow-runs summary card — failure rate + retry indicator over a
 * window.
 */
export type AdminWorkflowRunsSummary = {
  generatedAt: string
  windowDays: number
  totalRuns: number
  failedRuns: number
  completedRuns: number
  awaitingInputRuns: number
  failureRate: number
  topFailingWorkflows: Array<{
    workflowId: string
    workflowName: string
    failureCount: number
    totalCount: number
  }>
}

export async function getRunsSummaryForAdmin(opts?: {
  windowDays?: number
}): Promise<AdminWorkflowRunsSummary> {
  const windowDays = Math.min(Math.max(opts?.windowDays ?? 7, 1), 90)
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const totalsResult = await query<{
    status: WorkflowRunStatus
    count: string
  }>(
    `SELECT status, COUNT(*)::text AS count
       FROM workflow_runs
      WHERE started_at >= $1
      GROUP BY status`,
    [since],
  )

  let totalRuns = 0
  let failedRuns = 0
  let completedRuns = 0
  let awaitingInputRuns = 0
  for (const r of totalsResult.rows) {
    const n = parseInt(r.count, 10)
    totalRuns += n
    if (r.status === 'failed' || r.status === 'timeout') failedRuns += n
    if (r.status === 'completed') completedRuns += n
    if (r.status === 'awaiting_input' || r.status === 'awaiting_wait') awaitingInputRuns += n
  }
  const failureRate = totalRuns > 0 ? failedRuns / totalRuns : 0

  const topResult = await query<{
    workflowId: string
    workflowName: string
    failureCount: string
    totalCount: string
  }>(
    `SELECT
       r.workflow_id        AS "workflowId",
       w.name               AS "workflowName",
       SUM(CASE WHEN r.status IN ('failed', 'timeout') THEN 1 ELSE 0 END)::text AS "failureCount",
       COUNT(*)::text       AS "totalCount"
     FROM workflow_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.started_at >= $1
     GROUP BY r.workflow_id, w.name
     HAVING SUM(CASE WHEN r.status IN ('failed', 'timeout') THEN 1 ELSE 0 END) > 0
     ORDER BY SUM(CASE WHEN r.status IN ('failed', 'timeout') THEN 1 ELSE 0 END) DESC,
              COUNT(*) DESC
     LIMIT 10`,
    [since],
  )

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totalRuns,
    failedRuns,
    completedRuns,
    awaitingInputRuns,
    failureRate,
    topFailingWorkflows: topResult.rows.map((r) => ({
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      failureCount: parseInt(r.failureCount, 10),
      totalCount: parseInt(r.totalCount, 10),
    })),
  }
}

/**
 * Encode the (startedAt, id) keyset cursor. Mirrors the approvals cursor
 * helper but uses startedAt as the time component (workflow runs sort
 * by startedAt DESC, not createdAt).
 */
export function encodeRunCursor(c: { startedAt: Date; id: string }): string {
  const raw = `${c.startedAt.toISOString()}_${c.id}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

export function decodeRunCursor(cursor: string): { startedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const idx = raw.lastIndexOf('_')
    if (idx <= 0) return null
    const startedAtIso = raw.slice(0, idx)
    const id = raw.slice(idx + 1)
    const startedAt = new Date(startedAtIso)
    if (Number.isNaN(startedAt.getTime()) || id.length === 0) return null
    return { startedAt, id }
  } catch {
    return null
  }
}

// ── Event run queue (mig 302) ───────────────────────────────────────────
//
// Event dispatch enqueues `pending` runs; the run-queue worker
// (`@sidanclaw/core` → workflow/run-queue.ts) drains them through these
// system-level methods. Spec: docs/architecture/features/workflow.md →
// "Event run queue — enqueue, drain, storm guard".
// [COMP:workflow/run-queue]

/**
 * The queue's persistence port. Claiming is one row at a time — claims are
 * cheap next to the multi-step LLM run they admit, and per-claim selection
 * keeps the fairness rules (per-workflow serialization, per-workspace cap)
 * exact within a replica's own claims: a run this call just claimed (fresh
 * `claimed_at`, still `pending`) already counts against its workflow and
 * workspace in the next call's eligibility.
 */
export function createWorkflowRunQueueStore(): RunQueueStore {
  return {
    async claimNextPendingRunSystem({ leaseSeconds, maxClaimAttempts, workspaceCap }) {
      const result = await query<{ id: string; workflowId: string; workspaceId: string }>(
        `UPDATE workflow_runs
            SET claimed_at = now(), claim_attempts = claim_attempts + 1
          WHERE id = (
            SELECT r.id FROM workflow_runs r
             WHERE r.status = 'pending'
               -- Queue-owned runs ONLY. Event dispatch is the sole producer
               -- that enqueues (status='pending') without inline-advancing, and
               -- stamps trigger_kind='event' precisely so its runs are
               -- distinguishable here. Every OTHER path (schedule, manual/
               -- "Run now", webhook, goal tick, wait-wakeup) creates its run
               -- status='pending' too — the column default — then advances it
               -- INLINE; a crash can orphan one in 'pending' forever. Claiming
               -- those re-runs their delivery side-effects: the 2026-07-06
               -- storm was ~70 stale trigger_kind='schedule' runs orphaned
               -- since 2026-05 being drained oldest-first, re-firing a user's
               -- reminder. The trigger_kind='event' gate — mirrored on the two
               -- reapers below — is the invariant that keeps the queue's reach
               -- to the runs it owns, across the pending→running transition.
               -- See docs → "Event run queue".
               AND r.trigger_kind = 'event'
               AND (r.claimed_at IS NULL OR r.claimed_at < now() - make_interval(secs => $1))
               AND r.claim_attempts < $2
               -- Per-workflow serialization: no sibling running or freshly claimed.
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_runs s
                  WHERE s.workflow_id = r.workflow_id
                    AND s.id <> r.id
                    AND (s.status = 'running'
                         OR (s.status = 'pending'
                             AND s.claimed_at IS NOT NULL
                             AND s.claimed_at >= now() - make_interval(secs => $1)))
               )
               -- Per-workspace in-flight cap (running + freshly claimed).
               AND (
                 SELECT count(*) FROM workflow_runs w
                  WHERE w.workspace_id = r.workspace_id
                    AND w.id <> r.id
                    AND (w.status = 'running'
                         OR (w.status = 'pending'
                             AND w.claimed_at IS NOT NULL
                             AND w.claimed_at >= now() - make_interval(secs => $1)))
               ) < $3
             ORDER BY r.started_at
             LIMIT 1
             FOR UPDATE OF r SKIP LOCKED
          )
          RETURNING id, workflow_id AS "workflowId", workspace_id AS "workspaceId"`,
        [leaseSeconds, maxClaimAttempts, workspaceCap],
      )
      const row = result.rows[0]
      if (!row) return null
      const claimed: ClaimedRun = {
        runId: row.id,
        workflowId: row.workflowId,
        workspaceId: row.workspaceId,
      }
      return claimed
    },

    async failExhaustedPendingRunsSystem({ leaseSeconds, maxClaimAttempts }) {
      const result = await query(
        `UPDATE workflow_runs
            SET status = 'failed', finished_at = now(),
                error = jsonb_build_object(
                  'message', 'Run queue gave up after repeated claim attempts.',
                  'reason', 'run_queue_exhausted')
          WHERE status = 'pending'
            -- Queue-owned runs only (see claimNextPendingRunSystem) — never
            -- fail an inline-path run the queue does not own.
            AND trigger_kind = 'event'
            AND claim_attempts >= $2
            AND claimed_at IS NOT NULL
            AND claimed_at < now() - make_interval(secs => $1)`,
        [leaseSeconds, maxClaimAttempts],
      )
      return result.rowCount ?? 0
    },

    async requeueStaleRunningRunsSystem({ staleSeconds, maxClaimAttempts }) {
      // Attempts remaining → back to pending for a fresh claim
      // (advanceWorkflowRun is re-entrant over persisted step state).
      const requeued = await query(
        `UPDATE workflow_runs
            SET status = 'pending', claimed_at = NULL
          WHERE status = 'running'
            -- Queue-owned runs only (see claimNextPendingRunSystem). This is
            -- why the marker is trigger_kind, not status: once a run is
            -- 'running' its origin is otherwise indistinguishable, and an
            -- inline schedule/manual run re-queued to 'pending' would be
            -- re-claimed and re-delivered. A stale reminder must stay dead,
            -- never be resurrected hours late.
            AND trigger_kind = 'event'
            AND last_active_at < now() - make_interval(secs => $1)
            AND claim_attempts < $2`,
        [staleSeconds, maxClaimAttempts],
      )
      // Exhausted → fail visibly instead of poison-looping.
      const failed = await query(
        `UPDATE workflow_runs
            SET status = 'failed', finished_at = now(),
                error = jsonb_build_object(
                  'message', 'Run stalled and exceeded retry attempts.',
                  'reason', 'run_queue_stale')
          WHERE status = 'running'
            -- Queue-owned runs only (see claimNextPendingRunSystem).
            AND trigger_kind = 'event'
            AND last_active_at < now() - make_interval(secs => $1)
            AND claim_attempts >= $2`,
        [staleSeconds, maxClaimAttempts],
      )
      return (requeued.rowCount ?? 0) + (failed.rowCount ?? 0)
    },
  }
}

/**
 * Runs a workflow started inside the trailing window — the storm-guard
 * counter (`started_at` defaults to the insert time, so this counts
 * enqueues). System-level: the dispatcher has no acting user.
 */
export async function countRecentRunsForWorkflowSystem(
  workflowId: string,
  windowSeconds: number,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*) AS count FROM workflow_runs
      WHERE workflow_id = $1 AND started_at > now() - make_interval(secs => $2)`,
    [workflowId, windowSeconds],
  )
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

/**
 * Storm-guard pause: disable the workflow and record why. The
 * `enabled = true` filter in `findEventTriggeredWorkflowsSystem` then drops
 * subsequent events for free; a PATCH re-enable clears `paused_reason`
 * (see `createDbWorkflowStore().update`).
 */
export async function pauseWorkflowSystem(
  workflowId: string,
  reason: string,
): Promise<void> {
  const result = await query<{ workspaceId: string }>(
    `UPDATE workflows SET enabled = false, paused_reason = $2, updated_at = now()
      WHERE id = $1
      RETURNING workspace_id AS "workspaceId"`,
    [workflowId, reason],
  )
  if (result.rows[0]) notifyWorkspaceChange(result.rows[0].workspaceId, 'workflow', 'update', workflowId)
}

// ── workflow lifecycle sweep (mig 308) ──────────────────────────────────
// System-level reads/writes for the lifecycle sweep worker
// (packages/api/src/workers/workflow-lifecycle-worker.ts). The worker has
// no acting user; the policy lives in @sidanclaw/core `decideLifecycle`.
// [COMP:workflow/lifecycle]

type LifecycleSweepRow = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  description: string | null
  trigger: WorkflowTrigger | null
  enabled: boolean
  pinned: boolean
  lifecycleState: WorkflowLifecycleState
  lifecycleTransitionedAt: Date | null
  digestedAt: Date | null
  createdAt: Date
  updatedAt: Date
  lastRunAt: Date | null
  runCount: number
  hasLiveFire: boolean
}

/**
 * Every workflow with the aggregates the lifecycle policy needs: last run
 * start + total run count (lateral over `idx_workflow_runs_workflow`) and
 * whether any enabled `scheduled_jobs` row still points at the workflow
 * (`hasLiveFire` — a pending future fire or wait continuation). One query,
 * all workspaces; the sweep worker partitions per workspace itself.
 */
export async function listLifecycleSweepRowsSystem(): Promise<
  Array<WorkflowLifecycleRow & { createdBy: string }>
> {
  const result = await query<LifecycleSweepRow>(
    `SELECT w.id,
            w.workspace_id              AS "workspaceId",
            w.created_by                AS "createdBy",
            w.name,
            w.description,
            w.trigger,
            w.enabled,
            w.pinned,
            w.lifecycle_state           AS "lifecycleState",
            w.lifecycle_transitioned_at AS "lifecycleTransitionedAt",
            w.digested_at               AS "digestedAt",
            w.created_at                AS "createdAt",
            w.updated_at                AS "updatedAt",
            r."lastRunAt",
            COALESCE(r."runCount", 0)::int AS "runCount",
            EXISTS (
              SELECT 1 FROM scheduled_jobs j
               WHERE j.workflow_id = w.id AND j.enabled = true
            ) AS "hasLiveFire"
       FROM workflows w
       LEFT JOIN LATERAL (
         SELECT MAX(started_at) AS "lastRunAt", COUNT(*) AS "runCount"
           FROM workflow_runs WHERE workflow_id = w.id
       ) r ON true`,
  )
  return result.rows.map((row) => ({
    ...row,
    trigger: row.trigger ?? { kind: 'manual' },
    runCount: Number(row.runCount),
  }))
}

/**
 * Apply one sweep transition. Archival also disables the workflow so no
 * trigger path (webhook lookup, event finder, scheduled fire) can start a
 * run on a retired row; restore is the PATCH `lifecycleState: 'active'`
 * path in `createDbWorkflowStore().update`, which re-enables explicitly.
 */
export async function applyLifecycleTransitionSystem(
  workflowId: string,
  state: WorkflowLifecycleState,
  reason: string | null,
): Promise<void> {
  const result = await query<{ workspaceId: string }>(
    `UPDATE workflows
        SET lifecycle_state = $2,
            lifecycle_reason = $3,
            lifecycle_transitioned_at = now(),
            enabled = CASE WHEN $2 = 'archived' THEN false ELSE enabled END
      WHERE id = $1
      RETURNING workspace_id AS "workspaceId"`,
    [workflowId, state, reason],
  )
  if (result.rows[0]) notifyWorkspaceChange(result.rows[0].workspaceId, 'workflow', 'update', workflowId)
}

/**
 * Stamp the digest pass's verdict on the reviewed rows. Idempotence anchor:
 * the digest batch selects `digested_at IS NULL`, so each workflow is
 * reviewed at most once. (This bumps `updated_at` via the table trigger —
 * harmless: stale-row reactivation is run-only, see `touchedSinceTransition`.)
 */
export async function markWorkflowsDigestedSystem(
  workflowIds: string[],
  verdicts: Map<string, string>,
): Promise<void> {
  if (workflowIds.length === 0) return
  const ids: string[] = []
  const verdictValues: string[] = []
  for (const id of workflowIds) {
    ids.push(id)
    verdictValues.push(verdicts.get(id) ?? 'not_repeatable')
  }
  await query(
    `UPDATE workflows w
        SET digested_at = now(), digest_verdict = v.verdict
       FROM unnest($1::uuid[], $2::text[]) AS v(id, verdict)
      WHERE w.id = v.id`,
    [ids, verdictValues],
  )
}

/**
 * Hard delete for the sweep's one-off retirement path (archived one-shot
 * workflows past the delete grace). `workflow_runs` cascade via FK — the
 * caller emits the audit event carrying a summary snapshot first.
 */
export async function deleteWorkflowSystem(workflowId: string): Promise<boolean> {
  const result = await query<{ workspaceId: string }>(
    `DELETE FROM workflows WHERE id = $1 RETURNING workspace_id AS "workspaceId"`,
    [workflowId],
  )
  if (result.rows[0]) notifyWorkspaceChange(result.rows[0].workspaceId, 'workflow', 'delete', workflowId)
  return result.rowCount !== null && result.rowCount > 0
}
