/**
 * Page-action routes — button bindings CRUD, the per-page forward resolve,
 * and the invoke dispatch.
 *
 * Mount point: `/api` (URLs: `/api/page-actions`, `/api/pages/:pageId/actions`,
 * `/api/pages/:pageId/actions/:actionId/invoke`), under `requireAuth` exactly
 * like the workflows router.
 *
 * Authorization model (v1, documented in the spec): any workspace member who
 * can SEE the page (RLS + clearance through `savedViewStore.getById`) may
 * press its buttons — the same posture as manually running a workflow. The
 * invoke re-validates server-side that the binding actually resolves for the
 * page (via `resolveForPage`), so a crafted actionId/pageId pair cannot fire
 * a binding the page doesn't carry.
 *
 * Dispatch:
 *  - `workflow` → a run stamped `trigger_kind='button'` with page-event-shaped
 *    input (`{{input.event.pageId}}` addresses the page;
 *    `workflow_runs.trigger_page_id` stamps via the existing input-shape rule,
 *    so the run shows in the page-header chip), advanced INLINE like a manual
 *    run — never queue-owned.
 *  - `goal` → an Autopilot goal hosted on the page (`host: {type:'page'}`),
 *    through the same `GoalStore.create` path as `setGoal` — clarity gate,
 *    verifier, and metering unchanged. 501 when no goal store is wired.
 *
 * Spec: docs/architecture/features/page-actions.md.
 *
 * [COMP:api/page-actions-route]
 */

import { Router } from 'express'
import { z } from 'zod'
import {
  advanceWorkflowRun,
  CreatePageActionSchema,
  UpdatePageActionSchema,
  type ExecutorDeps,
  type GoalStore,
  type PageAction,
  type SavedViewStore,
  type WorkflowRunStore,
  type WorkflowStore,
} from '@sidanclaw/core'

import type { PageActionsStore } from '../db/page-actions-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'

export type PageActionsRouteOptions = {
  pageActionsStore: PageActionsStore
  workspaceStore: Pick<WorkspaceStore, 'getRole'>
  savedViewStore: Pick<SavedViewStore, 'getById'>
  pageTemplateStore: Pick<PageTemplateStore, 'getById'>
  workflowStore: Pick<WorkflowStore, 'getById'>
  runStore: Pick<WorkflowRunStore, 'createRun'>
  executorDeps: ExecutorDeps
  /** P2 — goal-kind dispatch. Absent → invoking a goal action returns 501. */
  goalStore?: Pick<GoalStore, 'create'>
}

function unauthorized(res: { status: (n: number) => { json: (b: unknown) => void } }) {
  res.status(401).json({ error: 'Unauthorized' })
}
function badRequest(res: { status: (n: number) => { json: (b: unknown) => void } }, message: string) {
  res.status(400).json({ error: message })
}
function notFound(res: { status: (n: number) => { json: (b: unknown) => void } }, message: string) {
  res.status(404).json({ error: message })
}
function notMember(res: { status: (n: number) => { json: (b: unknown) => void } }) {
  res.status(403).json({ error: 'Not a member of this workspace' })
}

function serializeAction(a: PageAction) {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    blueprintId: a.blueprintId,
    pageId: a.pageId,
    label: a.label,
    icon: a.icon,
    confirmCopy: a.confirmCopy,
    action: a.action,
    enabled: a.enabled,
    position: a.position,
    updatedAt: a.updatedAt,
  }
}

export function pageActionsRoutes(opts: PageActionsRouteOptions): Router {
  const router = Router()

  /** Workflow-kind actions must point at a live workflow in the same workspace. */
  async function validateWorkflowAction(
    userId: string,
    workspaceId: string,
    action: { kind: string; workflowId?: string },
  ): Promise<string | null> {
    if (action.kind !== 'workflow') return null
    const workflow = await opts.workflowStore.getById(userId, action.workflowId ?? '')
    if (!workflow || workflow.workspaceId !== workspaceId) {
      return 'action.workflowId does not match a workflow in this workspace.'
    }
    return null
  }

  // ── POST /page-actions — create a binding ─────────────────────────────
  router.post('/page-actions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = CreatePageActionSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }
    const body = parsed.data
    const role = await opts.workspaceStore.getRole(userId, body.workspaceId)
    if (!role) return notMember(res)

    // Scope target must live in the same workspace (RLS-scoped reads prove it).
    if ('blueprintId' in body.scope) {
      const template = await opts.pageTemplateStore.getById(userId, body.scope.blueprintId)
      if (!template || template.workspaceId !== body.workspaceId) {
        return badRequest(res, 'scope.blueprintId does not match a blueprint in this workspace.')
      }
    } else {
      const page = await opts.savedViewStore.getById(userId, body.scope.pageId)
      if (!page || page.workspaceId !== body.workspaceId) {
        return badRequest(res, 'scope.pageId does not match a page in this workspace.')
      }
    }
    const actionError = await validateWorkflowAction(userId, body.workspaceId, body.action)
    if (actionError) return badRequest(res, actionError)
    if (body.action.kind === 'goal' && !opts.goalStore) {
      return badRequest(res, 'Goal actions are not available on this deployment.')
    }

    const created = await opts.pageActionsStore.create(userId, {
      workspaceId: body.workspaceId,
      blueprintId: 'blueprintId' in body.scope ? body.scope.blueprintId : null,
      pageId: 'pageId' in body.scope ? body.scope.pageId : null,
      label: body.label,
      icon: body.icon ?? null,
      confirmCopy: body.confirmCopy ?? null,
      action: body.action,
      position: body.position ?? 0,
    })
    res.status(201).json(serializeAction(created))
  })

  // ── GET /page-actions?workspaceId=&blueprintId= — authoring list ──────
  router.get('/page-actions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const q = z
      .object({ workspaceId: z.string().uuid(), blueprintId: z.string().uuid() })
      .safeParse(req.query)
    if (!q.success) return badRequest(res, 'workspaceId and blueprintId are required.')
    const role = await opts.workspaceStore.getRole(userId, q.data.workspaceId)
    if (!role) return notMember(res)
    const rows = await opts.pageActionsStore.listForBlueprint(
      userId,
      q.data.workspaceId,
      q.data.blueprintId,
    )
    res.json({ actions: rows.map(serializeAction) })
  })

  // ── PATCH /page-actions/:id ────────────────────────────────────────────
  router.patch('/page-actions/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = UpdatePageActionSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }
    const existing = await opts.pageActionsStore.getById(userId, req.params.id)
    if (!existing) return notFound(res, 'Action not found')
    if (parsed.data.action) {
      const actionError = await validateWorkflowAction(userId, existing.workspaceId, parsed.data.action)
      if (actionError) return badRequest(res, actionError)
      if (parsed.data.action.kind === 'goal' && !opts.goalStore) {
        return badRequest(res, 'Goal actions are not available on this deployment.')
      }
    }
    const updated = await opts.pageActionsStore.update(userId, req.params.id, parsed.data)
    if (!updated) return notFound(res, 'Action not found')
    res.json(serializeAction(updated))
  })

  // ── DELETE /page-actions/:id ───────────────────────────────────────────
  router.delete('/page-actions/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const removed = await opts.pageActionsStore.delete(userId, req.params.id)
    if (!removed) return notFound(res, 'Action not found')
    res.status(204).end()
  })

  // ── GET /pages/:pageId/actions — the header's forward resolve ─────────
  router.get('/pages/:pageId/actions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const pageId = z.string().uuid().safeParse(req.params.pageId)
    if (!pageId.success) return badRequest(res, 'Invalid pageId')
    const page = await opts.savedViewStore.getById(userId, pageId.data)
    if (!page) return notFound(res, 'Page not found')
    const rows = await opts.pageActionsStore.resolveForPage(userId, page.workspaceId, page.id)
    res.json({ actions: rows.map(serializeAction) })
  })

  // ── POST /pages/:pageId/actions/:actionId/invoke ───────────────────────
  router.post('/pages/:pageId/actions/:actionId/invoke', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const params = z
      .object({ pageId: z.string().uuid(), actionId: z.string().uuid() })
      .safeParse(req.params)
    if (!params.success) return badRequest(res, 'Invalid pageId or actionId')

    // Visibility proof: the RLS + clearance-scoped page read.
    const page = await opts.savedViewStore.getById(userId, params.data.pageId)
    if (!page) return notFound(res, 'Page not found')
    const role = await opts.workspaceStore.getRole(userId, page.workspaceId)
    if (!role) return notMember(res)

    // Binding proof: the action must RESOLVE for this page (covers both
    // scopes + enabled) — a crafted id pair cannot fire someone else's button.
    const resolved = await opts.pageActionsStore.resolveForPage(userId, page.workspaceId, page.id)
    const action = resolved.find((a) => a.id === params.data.actionId)
    if (!action) return notFound(res, 'Action not found on this page')

    if (action.action.kind === 'workflow') {
      const workflow = await opts.workflowStore.getById(userId, action.action.workflowId)
      if (!workflow || workflow.workspaceId !== page.workspaceId) {
        return badRequest(res, 'The bound workflow no longer exists in this workspace.')
      }
      if (!workflow.enabled) return badRequest(res, 'The bound workflow is disabled.')

      const run = await opts.runStore.createRun({
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        triggeredBy: userId,
        triggerKind: 'button',
        // Page-event-shaped input: steps address {{input.event.pageId}}, and
        // trigger_page_id stamps off `trigger.sourceType='page'` +
        // `event.pageId` (workflow-store.extractTriggerPageId), so the run
        // surfaces in the page-header chip with no further wiring.
        input: {
          trigger: {
            sourceType: 'page',
            provider: 'page',
            kind: 'button',
            actionId: action.id,
            pageId: page.id,
            actorId: userId,
          },
          event: { pageId: page.id, action: 'button', title: page.name, actorId: userId },
          ...(action.action.vars ? { vars: action.action.vars } : {}),
        },
      })
      const outcome = await advanceWorkflowRun(opts.executorDeps, run.id)
      return res.json({
        kind: 'workflow',
        runId: outcome.runId,
        workflowId: workflow.id,
        status:
          outcome.kind === 'completed'
            ? 'completed'
            : outcome.kind === 'failed'
              ? 'failed'
              : 'paused',
        finalOutput: outcome.kind === 'completed' ? (outcome.finalOutput ?? null) : null,
        error: outcome.kind === 'failed' ? outcome.error : null,
      })
    }

    // kind === 'goal'
    if (!opts.goalStore) {
      return res.status(501).json({ error: 'Goal actions are not available on this deployment.' })
    }
    const baseOutcome = action.action.outcome ?? `Work on "${page.name}" to completion`
    const goal = await opts.goalStore.create({
      workspaceId: page.workspaceId,
      // The optional authoring note rides the outcome text (GoalCreateParams
      // has no separate context field) — the clarity gate reads it there.
      outcome: action.action.note ? `${baseOutcome} — ${action.action.note}` : baseOutcome,
      // Page-hosted, sub-work-measured — the clarity gate + verifier refine
      // from here exactly as a chat-set goal would.
      doneWhen: { kind: 'subtasks' },
      host: { type: 'page', id: page.id },
      means: {},
      budget: {},
      createdByUserId: userId,
    })
    res.json({ kind: 'goal', goalId: goal.id, outcome: goal.outcome })
  })

  return router
}
