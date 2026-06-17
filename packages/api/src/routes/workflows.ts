/**
 * Workflow CRUD + manual run + run history routes.
 *
 * Mount point: `/api` (so URLs are `/api/workflows`, `/api/workflows/:id`,
 * `/api/workflows/:id/run`, `/api/workflows/:id/runs`).
 *
 * All routes require an authenticated user (mounted under `requireAuth`
 * in `apps/api/src/index.ts`). Workspace membership is verified via
 * `WorkspaceStore.getRole`; the underlying store reads still go through
 * `queryWithRLS`.
 *
 * Existing chat-tool authoring (`proposeWorkflow` / `createWorkflow` /
 * `runWorkflow`) continues to work — this surface adds the parallel REST
 * path the web builder UI consumes.
 *
 * The webhook receiver lives in a separate module (`workflow-webhooks.ts`)
 * because its auth model is HMAC-signature based rather than session-token
 * based.
 *
 * Spec: `docs/plans/company-brain/workflow-builder.md`.
 *
 * [COMP:api/workflows-route]
 */

import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import {
  advanceWorkflowRun,
  WorkflowDefinitionSchema,
  WorkflowTriggerSchema,
  syncWorkflowScheduleTrigger,
  clearWorkflowScheduleTriggers,
  type ExecutorDeps,
  type JobStore,
  type SavedViewStore,
  type WorkflowDefinition,
  type WorkflowRecord,
  type WorkflowRunStore,
  type WorkflowStore,
  type WorkflowTrigger,
} from '@sidanclaw/core'
import { z } from 'zod'
import type { WorkspaceStore } from '../db/workspace-store.js'

export type WorkflowsRouteOptions = {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  workspaceStore: WorkspaceStore
  /** Executor deps used by the manual-run path; same instance the chat tool uses. */
  executorDeps: ExecutorDeps
  /**
   * Optional emit hook for `workflow.created` / `workflow.deleted` audit
   * events. The chat-tool path already emits `workflow.created` — the REST
   * path uses this for the same shape so behaviour is uniform regardless
   * of which surface authored the workflow.
   */
  emitAudit?: (event: WorkflowAuditDelta) => Promise<void> | void
  /**
   * Page-anchor authoring checks for `assistant_call.page` (existence +
   * workspace match), RLS-scoped to the authoring user. Optional — when
   * absent, the checks are skipped and the callee executor's runtime gate
   * stays authoritative. Mirrors `WorkflowToolDeps.resolvePageAnchor`.
   */
  savedViewStore?: SavedViewStore
  /**
   * The workflow's ACTUAL scheduled-trigger rows for the GET detail route —
   * drift surfacing for the builder (the `workflows.trigger` column can say
   * "manual" while cron jobs fire; 2026-06-10 incident). Wired from
   * `jobStore.listTriggerJobsForWorkflowSystem`; the route's RLS-scoped
   * workflow read is the membership proof. Optional — absent omits
   * `triggerJobs` from the response.
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
   * Backing-job lifecycle for `schedule`-kind triggers authored through the
   * web builder. When BOTH are wired, a POST/PATCH that sets
   * `trigger.kind='schedule'` creates (or idempotently updates) the firing
   * `scheduled_jobs` row, and a trigger that leaves `schedule` (or a DELETE)
   * clears it — via the SAME `syncWorkflowScheduleTrigger` helper the
   * `scheduleWorkflow` chat tool uses. This closes the gap where a workflow
   * scheduled in the builder displayed "Scheduled" but never fired (the route
   * only wrote `workflows.trigger`, never the job row). Absent (tests / minimal
   * boots) → the trigger column is written but no job is reconciled.
   */
  jobStore?: JobStore
  resolvePrimary?: (workspaceId: string) => Promise<string | null>
}

export type WorkflowAuditDelta =
  | { type: 'workflow.created'; workspaceId: string; userId: string; workflowId: string; name: string }
  | { type: 'workflow.updated'; workspaceId: string; userId: string; workflowId: string; name: string }
  | { type: 'workflow.deleted'; workspaceId: string; userId: string; workflowId: string; name: string }

/** Workflow-level run settings — same vocabulary on create + update. */
const modelAliasSchema = z.enum(['standard', 'pro', 'max'])
/** Mig 196: clamped 1..60 to match `RESEARCH_BUDGET_CEILING.maxTurns`. */
const maxTurnsSchema = z.number().int().min(1).max(60)

const createBodySchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  definition: z.unknown(),
  trigger: z.unknown().optional(),
  modelAlias: modelAliasSchema.optional(),
  maxTurns: maxTurnsSchema.nullable().optional(),
  researchMode: z.boolean().optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  definition: z.unknown().optional(),
  enabled: z.boolean().optional(),
  trigger: z.unknown().optional(),
  /** Rotate the webhook secret. Only meaningful when trigger.kind='webhook'. */
  rotateWebhookSecret: z.boolean().optional(),
  modelAlias: modelAliasSchema.optional(),
  maxTurns: maxTurnsSchema.nullable().optional(),
  researchMode: z.boolean().optional(),
})

const runBodySchema = z.object({
  input: z.record(z.unknown()).optional(),
})

const unauthorized = (res: import('express').Response) =>
  void res.status(401).json({ error: 'Unauthorized' })
const notMember = (res: import('express').Response) =>
  void res.status(403).json({ error: 'Not a member of this workspace' })
const badRequest = (res: import('express').Response, message: string) =>
  void res.status(400).json({ error: message })

/**
 * Structured validation error response. Mirrors a Zod error into a stable
 * `{ error, issues }` shape the web builder consumes — `issues[i].path` is
 * the dotted-but-as-array Zod path (e.g. `['definition','steps',0,'id']`),
 * the client uses the first segment to scroll the offending section into
 * view and the rest to set inline error messages.
 */
function validationError(
  res: import('express').Response,
  prefix: string,
  err: import('zod').ZodError,
) {
  const rawIssues = err.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
    message: i.message,
  }))
  const summary = err.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ')
  res.status(400).json({
    error: prefix ? `${prefix}: ${summary}` : summary,
    issues: prefix
      ? rawIssues.map((i) => ({ ...i, path: [prefix, ...i.path] }))
      : rawIssues,
  })
}
const notFound = (res: import('express').Response, what = 'Not found') =>
  void res.status(404).json({ error: what })

/**
 * Page-anchor existence + workspace checks for `assistant_call.page`
 * (`{id}` anchors and `{create}.nestUnder` parents). Returns issues in the
 * same `{ path, message }` shape `validationError` emits — `path` is rooted
 * at `definition` so the builder UI lands the error on the right step.
 * Skipped when the route has no `savedViewStore` (the callee executor's
 * runtime gate stays authoritative). Draft anchors are a soft concern
 * (the builder picker communicates the prune caveat) — not flagged here.
 */
async function pageAnchorIssues(
  definition: WorkflowDefinition,
  ctx: { userId: string; workspaceId: string },
  savedViewStore: SavedViewStore | undefined,
): Promise<Array<{ path: Array<string | number>; message: string }>> {
  if (!savedViewStore) return []
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const issues: Array<{ path: Array<string | number>; message: string }> = []
  for (const [i, step] of definition.steps.entries()) {
    if (step.type !== 'assistant_call' || !step.page) continue
    const checks: Array<{ tail: string; id: string }> = []
    // Template anchors (`{{vars/input}}`, Phase B) resolve at run time —
    // skip the existence check; the executor's invalid_page_anchor +
    // the callee gate stay authoritative.
    if ('id' in step.page && UUID_SHAPE.test(step.page.id)) {
      checks.push({ tail: 'id', id: step.page.id })
    }
    if ('create' in step.page && step.page.nestUnder) {
      checks.push({ tail: 'nestUnder', id: step.page.nestUnder })
    }
    for (const check of checks) {
      const view = await savedViewStore.getById(ctx.userId, check.id)
      if (!view || view.workspaceId !== ctx.workspaceId) {
        issues.push({
          path: ['definition', 'steps', i, 'page', check.tail],
          message: 'page not found in this workspace',
        })
      }
    }
  }
  return issues
}

/** Generate a URL-safe slug + 32-byte hex secret for webhook triggers. */
function mintWebhookCredentials(): { slug: string; secret: string } {
  return {
    slug: randomBytes(12).toString('base64url'),
    secret: randomBytes(32).toString('hex'),
  }
}

function serializeWorkflow(w: import('@sidanclaw/core').WorkflowRecord) {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    createdBy: w.createdBy,
    name: w.name,
    description: w.description,
    definition: w.definition,
    enabled: w.enabled,
    trigger: w.trigger,
    webhookSlug: w.webhookSlug,
    webhookSecret: w.webhookSecret,
    modelAlias: w.modelAlias,
    maxTurns: w.maxTurns,
    researchMode: w.researchMode,
    nameManuallySet: w.nameManuallySet,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }
}

function serializeSummary(w: import('@sidanclaw/core').WorkflowRecord) {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    name: w.name,
    description: w.description,
    enabled: w.enabled,
    trigger: w.trigger,
    stepCount: w.definition.steps.length,
    updatedAt: w.updatedAt.toISOString(),
  }
}

export function workflowsRoutes(opts: WorkflowsRouteOptions): Router {
  const router = Router()

  // Reconcile the firing `scheduled_jobs` row from a workflow's trigger — the
  // web-builder counterpart of the `scheduleWorkflow` chat tool, via the SAME
  // shared helper so the two paths can never drift. Best-effort: a sync
  // failure logs but never fails the workflow write (the Active-triggers drift
  // card surfaces any residual mismatch). No-op unless jobStore + resolvePrimary
  // are wired (tests / minimal boots keep the legacy trigger-column-only write).
  async function reconcileScheduleTrigger(workflow: WorkflowRecord, userId: string): Promise<void> {
    if (!opts.jobStore || !opts.resolvePrimary) return
    try {
      if (workflow.trigger.kind === 'schedule') {
        await syncWorkflowScheduleTrigger(
          { jobStore: opts.jobStore, resolvePrimary: opts.resolvePrimary },
          {
            workflowId: workflow.id,
            workspaceId: workflow.workspaceId,
            userId,
            schedule: workflow.trigger.schedule,
            timezone: workflow.trigger.timezone ?? 'UTC',
            // Carry the trigger-row policy (scheduling-authoring-unification)
            // so a schedule authored / edited in the web builder keeps its
            // tz-mode + silent / nag settings on the firing row.
            mode: workflow.trigger.mode,
            silentUntilFire: workflow.trigger.policy?.silentUntilFire,
            nagIntervalMins: workflow.trigger.policy?.nagIntervalMins ?? null,
            nagUntilKeyword: workflow.trigger.policy?.nagUntilKeyword ?? null,
          },
        )
      } else {
        // Trigger left `schedule` — stop the workflow from firing.
        await clearWorkflowScheduleTriggers({ jobStore: opts.jobStore }, workflow.id)
      }
    } catch (err) {
      console.warn('[workflows] schedule-trigger reconcile failed:', err)
    }
  }

  // ── GET /workflows?workspaceId= ────────────────────────────────────────
  router.get('/workflows', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!workspaceId) return badRequest(res, 'workspaceId is required')

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    const rows = await opts.workflowStore.list(userId, workspaceId)
    res.json({ workflows: rows.map(serializeSummary) })
  })

  // ── GET /workflows/:id ─────────────────────────────────────────────────
  router.get('/workflows/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const workflow = await opts.workflowStore.getById(userId, req.params.id)
    if (!workflow) return notFound(res, 'Workflow not found')

    // The ACTUAL scheduled-trigger rows, any creator — lets the builder
    // show what really fires this workflow (and flag drift against the
    // `trigger` display column). The RLS-scoped getById above proved
    // membership for the system-level job read.
    const triggerJobs = opts.listTriggerJobs
      ? (await opts.listTriggerJobs(workflow.id)).map((j) => ({
          id: j.id,
          schedule: j.schedule,
          timezone: j.timezone,
          enabled: j.enabled,
          nextRunAt: j.nextRunAt.toISOString(),
          lastStatus: j.lastStatus,
          ownedByMe: j.userId === userId,
        }))
      : undefined

    res.json({ ...serializeWorkflow(workflow), ...(triggerJobs ? { triggerJobs } : {}) })
  })

  // ── POST /workflows ────────────────────────────────────────────────────
  router.post('/workflows', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = createBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return validationError(res, '', parsed.error)
    }
    const role = await opts.workspaceStore.getRole(userId, parsed.data.workspaceId)
    if (!role) return notMember(res)

    const definitionParsed = WorkflowDefinitionSchema.safeParse(parsed.data.definition)
    if (!definitionParsed.success) {
      return validationError(res, 'definition', definitionParsed.error)
    }

    // Page-anchor existence + workspace checks (mirrors the chat-tool path).
    const anchorIssues = await pageAnchorIssues(
      definitionParsed.data,
      { userId, workspaceId: parsed.data.workspaceId },
      opts.savedViewStore,
    )
    if (anchorIssues.length > 0) {
      return void res.status(400).json({
        error: anchorIssues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        issues: anchorIssues,
      })
    }

    let trigger: WorkflowTrigger = { kind: 'manual' }
    if (parsed.data.trigger !== undefined) {
      const triggerParsed = WorkflowTriggerSchema.safeParse(parsed.data.trigger)
      if (!triggerParsed.success) {
        return validationError(res, 'trigger', triggerParsed.error)
      }
      trigger = triggerParsed.data
    }

    // For webhook triggers, mint slug + secret at creation time. Callers
    // never supply them — the server is the only authority that can
    // generate cryptographically random values.
    const cred = trigger.kind === 'webhook' ? mintWebhookCredentials() : null

    const record = await opts.workflowStore.create({
      userId,
      workspaceId: parsed.data.workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      definition: definitionParsed.data,
      trigger,
      webhookSlug: cred?.slug ?? null,
      webhookSecret: cred?.secret ?? null,
      modelAlias: parsed.data.modelAlias,
      maxTurns: parsed.data.maxTurns ?? null,
      researchMode: parsed.data.researchMode,
    })

    // Create the backing firing job for a schedule trigger (closes the gap
    // where a builder-scheduled workflow displayed "Scheduled" but never fired).
    if (record.trigger.kind === 'schedule') {
      await reconcileScheduleTrigger(record, userId)
    }

    opts.emitAudit?.({
      type: 'workflow.created',
      workspaceId: record.workspaceId,
      userId,
      workflowId: record.id,
      name: record.name,
    })

    res.status(201).json(serializeWorkflow(record))
  })

  // ── PATCH /workflows/:id ───────────────────────────────────────────────
  router.patch('/workflows/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = updateBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return validationError(res, '', parsed.error)
    }

    const existing = await opts.workflowStore.getById(userId, req.params.id)
    if (!existing) return notFound(res, 'Workflow not found')

    const fields: Parameters<WorkflowStore['update']>[2] = {}
    if (parsed.data.name !== undefined) {
      fields.name = parsed.data.name
      // Mig 202 — a user-initiated rename pins the title so the auto-titler
      // stops touching it. Mirrors `renameSession` setting title_manually_set.
      fields.nameManuallySet = true
    }
    if (parsed.data.description !== undefined) fields.description = parsed.data.description
    if (parsed.data.enabled !== undefined) fields.enabled = parsed.data.enabled
    if (parsed.data.modelAlias !== undefined) fields.modelAlias = parsed.data.modelAlias
    if (parsed.data.maxTurns !== undefined) fields.maxTurns = parsed.data.maxTurns ?? null
    if (parsed.data.researchMode !== undefined) fields.researchMode = parsed.data.researchMode

    if (parsed.data.definition !== undefined) {
      const definitionParsed = WorkflowDefinitionSchema.safeParse(parsed.data.definition)
      if (!definitionParsed.success) {
        return validationError(res, 'definition', definitionParsed.error)
      }
      const anchorIssues = await pageAnchorIssues(
        definitionParsed.data,
        { userId, workspaceId: existing.workspaceId },
        opts.savedViewStore,
      )
      if (anchorIssues.length > 0) {
        return void res.status(400).json({
          error: anchorIssues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          issues: anchorIssues,
        })
      }
      fields.definition = definitionParsed.data
    }

    if (parsed.data.trigger !== undefined) {
      const triggerParsed = WorkflowTriggerSchema.safeParse(parsed.data.trigger)
      if (!triggerParsed.success) {
        return validationError(res, 'trigger', triggerParsed.error)
      }
      fields.trigger = triggerParsed.data

      // Webhook lifecycle:
      //   - changing to/staying on webhook → mint slug+secret on first
      //     transition or rotate when asked
      //   - leaving webhook → clear slug+secret (release the slug)
      if (triggerParsed.data.kind === 'webhook') {
        if (!existing.webhookSlug || parsed.data.rotateWebhookSecret) {
          const cred = mintWebhookCredentials()
          // Keep the slug stable across rotations when the user only asked
          // to rotate the secret; only mint a new slug when there isn't one.
          fields.webhookSlug = existing.webhookSlug ?? cred.slug
          fields.webhookSecret = cred.secret
        }
      } else if (existing.trigger.kind === 'webhook') {
        fields.webhookSlug = null
        fields.webhookSecret = null
      }
    } else if (parsed.data.rotateWebhookSecret && existing.trigger.kind === 'webhook') {
      // No trigger change but secret rotation requested.
      fields.webhookSecret = randomBytes(32).toString('hex')
    }

    const updated = await opts.workflowStore.update(userId, req.params.id, fields)
    if (!updated) return notFound(res, 'Workflow not found')

    // A trigger change reconciles the firing `scheduled_jobs` row: a schedule
    // trigger creates/updates the job; any other kind clears it. This is what
    // makes "Scheduled" in the builder actually fire (and "Manual" stop firing).
    if (parsed.data.trigger !== undefined) {
      await reconcileScheduleTrigger(updated, userId)
    }

    opts.emitAudit?.({
      type: 'workflow.updated',
      workspaceId: updated.workspaceId,
      userId,
      workflowId: updated.id,
      name: updated.name,
    })

    res.json(serializeWorkflow(updated))
  })

  // ── DELETE /workflows/:id ──────────────────────────────────────────────
  router.delete('/workflows/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const existing = await opts.workflowStore.getById(userId, req.params.id)
    if (!existing) return notFound(res, 'Workflow not found')

    const ok = await opts.workflowStore.delete(userId, req.params.id)
    if (!ok) return notFound(res, 'Workflow not found')

    // Stop any backing scheduled-trigger row from firing a now-deleted workflow
    // (it would otherwise fail every fire with workflow_not_found / disabled).
    if (opts.jobStore) {
      await clearWorkflowScheduleTriggers({ jobStore: opts.jobStore }, existing.id).catch((err) =>
        console.warn('[workflows] schedule-trigger clear on delete failed:', err),
      )
    }

    opts.emitAudit?.({
      type: 'workflow.deleted',
      workspaceId: existing.workspaceId,
      userId,
      workflowId: existing.id,
      name: existing.name,
    })
    res.status(204).end()
  })

  // ── POST /workflows/:id/run ────────────────────────────────────────────
  router.post('/workflows/:id/run', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = runBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }

    const workflow = await opts.workflowStore.getById(userId, req.params.id)
    if (!workflow) return notFound(res, 'Workflow not found')
    if (!workflow.enabled) return badRequest(res, 'Workflow is disabled')

    const run = await opts.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      triggeredBy: userId,
      triggerKind: 'manual',
      input: parsed.data.input,
    })

    const outcome = await advanceWorkflowRun(opts.executorDeps, run.id)
    const steps = await opts.runStore.listStepRuns(userId, run.id)

    res.json({
      runId: outcome.runId,
      status:
        outcome.kind === 'completed'
          ? 'completed'
          : outcome.kind === 'failed'
            ? 'failed'
            : outcome.reason === 'wait'
              ? 'awaiting_wait'
              : 'awaiting_input',
      finalOutput: outcome.kind === 'completed' ? outcome.finalOutput ?? null : null,
      error: outcome.kind === 'failed' ? outcome.error : null,
      paused:
        outcome.kind === 'paused' ? { stepId: outcome.stepId, reason: outcome.reason } : null,
      steps: steps.map((s) => ({
        id: s.id,
        stepId: s.stepId,
        type: s.stepType,
        status: s.status,
        durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
        output: s.output,
        error: s.error,
      })),
    })
  })

  // ── GET /workflows/:id/runs?limit= ─────────────────────────────────────
  router.get('/workflows/:id/runs', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const limit = Math.min(
      Math.max(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20, 1),
      100,
    )

    const workflow = await opts.workflowStore.getById(userId, req.params.id)
    if (!workflow) return notFound(res, 'Workflow not found')

    const runs = await opts.runStore.listRunsForWorkflow(userId, workflow.id, { limit })
    res.json({
      runs: runs.map((r) => ({
        id: r.id,
        workflowId: r.workflowId,
        triggerKind: r.triggerKind,
        status: r.status,
        currentStepId: r.currentStepId,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        error: r.error,
      })),
    })
  })

  // ── GET /workflows/:id/runs/:runId — single run with step trail ───────
  router.get('/workflows/:id/runs/:runId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const run = await opts.runStore.getRunById(userId, req.params.runId)
    if (!run || run.workflowId !== req.params.id) return notFound(res, 'Run not found')

    const steps = await opts.runStore.listStepRuns(userId, run.id)
    res.json({
      id: run.id,
      workflowId: run.workflowId,
      triggerKind: run.triggerKind,
      status: run.status,
      currentStepId: run.currentStepId,
      input: run.input,
      vars: run.vars,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      steps: steps.map((s) => ({
        id: s.id,
        stepId: s.stepId,
        type: s.stepType,
        status: s.status,
        input: s.input,
        output: s.output,
        error: s.error,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
      })),
    })
  })

  return router
}
