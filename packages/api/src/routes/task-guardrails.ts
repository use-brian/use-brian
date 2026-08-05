/**
 * Task guardrail routes — the UI half of the admission gate.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 *
 * Mounted at `/api/task-guardrails` behind `requireAuth`. Every route is
 * workspace-scoped and membership-checked at the boundary, which is what lets
 * the store below run system-level (see task-admission-store.ts header).
 *
 *   GET    /:workspaceId/rules                  — list (incl. inert `proposed`)
 *   POST   /:workspaceId/rules                  — create
 *   PATCH  /:workspaceId/rules/:id              — activate / disable
 *   DELETE /:workspaceId/rules/:id              — delete
 *   GET    /:workspaceId/candidates             — the suggestions tray
 *   POST   /:workspaceId/candidates/:id/accept  — promote to a real task
 *   POST   /:workspaceId/candidates/:id/dismiss — drop it (optionally with a reason)
 *   GET    /:workspaceId/tombstones             — what the workspace has rejected
 *   DELETE /:workspaceId/tombstones/:id         — un-teach one
 *
 * This is an AUTHENTICATED router, so it mounts through the normal
 * `mountExtraRoutes` hook without tripping the public-route ordering trap
 * documented in CLAUDE.md.
 *
 * [COMP:api/task-guardrails-route]
 */

import { Router } from 'express'
import type { Response } from 'express'
import { z } from 'zod'
import {
  validateRulePredicate,
  type TaskRuleEffect,
  type TaskRulePredicate,
} from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { createTask } from '../db/tasks.js'
import {
  createRule,
  deleteRule,
  deleteTombstone,
  getCandidate,
  listPendingCandidates,
  listRules,
  listTombstones,
  resolveCandidate,
  setRuleStatus,
  tombstoneFromCandidate,
} from '../db/task-admission-store.js'

const predicateSchema = z.object({
  source_kinds: z.array(z.string().min(1).max(64)).max(10).optional(),
  lanes: z.array(z.enum(['extracted', 'assistant'])).max(2).optional(),
  title_matches: z.array(z.string().min(2).max(120)).max(10).optional(),
  channel_refs: z.array(z.string().min(1).max(128)).max(20).optional(),
  require: z
    .array(
      z.enum([
        'assignee',
        'due',
        'description',
        'resolved_target',
        'explicit_commitment',
        'completion_signal',
        'agent_ready',
      ]),
    )
    .max(7)
    .optional(),
})

const createRuleSchema = z.object({
  effect: z.enum(['deny', 'require']),
  when: predicateSchema,
  nl_clause: z.string().min(3).max(300).nullish(),
  reason: z.string().max(500).nullish(),
  status: z.enum(['active', 'disabled']).optional(),
})

const patchRuleSchema = z.object({
  status: z.enum(['active', 'disabled', 'proposed']),
})

const dismissSchema = z.object({
  reason: z.string().min(3).max(500).nullish(),
})

export type TaskGuardrailRouteOptions = {
  workspaceStore: WorkspaceStore
}

export function taskGuardrailRoutes({
  workspaceStore,
}: TaskGuardrailRouteOptions): Router {
  const router = Router()

  async function requireWorkspaceMember(
    req: { userId?: string; params: { workspaceId: string } },
    res: Response,
  ): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    return role
  }

  // ── Rules ──────────────────────────────────────────────────────

  router.get('/:workspaceId/rules', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    try {
      const rules = await listRules({
        workspaceId: req.params.workspaceId,
        includeDisabled: true,
      })
      res.json({ rules })
    } catch (err) {
      console.error('[task-guardrails] list rules failed:', err)
      res.status(500).json({ error: 'Failed to list task rules' })
    }
  })

  router.post('/:workspaceId/rules', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return

    const parsed = createRuleSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid rule' })
      return
    }
    const predicate = parsed.data.when as TaskRulePredicate
    const effect = parsed.data.effect as TaskRuleEffect

    // Same validator the tool uses — a deny rule with no conditions would block
    // every task in the workspace, which is never what anyone means.
    const invalid = validateRulePredicate(effect, predicate)
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }

    try {
      const rule = await createRule({
        workspaceId: req.params.workspaceId,
        userId: (req as any).userId as string,
        effect,
        predicate,
        nlClause: parsed.data.nl_clause ?? null,
        reason: parsed.data.reason ?? null,
        status: parsed.data.status ?? 'active',
      })
      res.status(201).json({ rule })
    } catch (err) {
      console.error('[task-guardrails] create rule failed:', err)
      res.status(500).json({ error: 'Failed to create task rule' })
    }
  })

  router.patch('/:workspaceId/rules/:id', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return

    const parsed = patchRuleSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'status must be active, disabled, or proposed' })
      return
    }
    try {
      const rule = await setRuleStatus({
        workspaceId: req.params.workspaceId,
        ruleId: req.params.id,
        status: parsed.data.status,
      })
      if (!rule) {
        res.status(404).json({ error: 'Rule not found' })
        return
      }
      res.json({ rule })
    } catch (err) {
      console.error('[task-guardrails] patch rule failed:', err)
      res.status(500).json({ error: 'Failed to update task rule' })
    }
  })

  router.delete('/:workspaceId/rules/:id', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    try {
      const ok = await deleteRule({
        workspaceId: req.params.workspaceId,
        ruleId: req.params.id,
      })
      if (!ok) {
        res.status(404).json({ error: 'Rule not found' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[task-guardrails] delete rule failed:', err)
      res.status(500).json({ error: 'Failed to delete task rule' })
    }
  })

  // ── Candidates (the suggestions tray) ──────────────────────────

  router.get('/:workspaceId/candidates', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    try {
      const candidates = await listPendingCandidates(req.params.workspaceId)
      res.json({ candidates })
    } catch (err) {
      console.error('[task-guardrails] list candidates failed:', err)
      res.status(500).json({ error: 'Failed to list task suggestions' })
    }
  })

  /**
   * Accept — write the real task and close the candidate.
   *
   * The task is created WITHOUT re-running the gate: the user has just looked
   * at the suggestion and the thing that held it, and said yes. Re-gating would
   * block their own decision with the same near-duplicate that produced the
   * suggestion in the first place.
   */
  router.post('/:workspaceId/candidates/:id/accept', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    const userId = (req as any).userId as string
    try {
      const candidate = await getCandidate(req.params.workspaceId, req.params.id)
      if (!candidate || candidate.status !== 'pending') {
        res.status(404).json({ error: 'Suggestion not found' })
        return
      }
      const task = await createTask(userId, {
        workspaceId: req.params.workspaceId,
        title: candidate.title,
        due: candidate.due,
        source: 'extracted',
        sourceEpisodeId: candidate.sourceEpisodeId,
        attributes: candidate.quality?.description
          ? { description: candidate.quality.description }
          : undefined,
      })
      await resolveCandidate({
        workspaceId: req.params.workspaceId,
        candidateId: req.params.id,
        userId,
        status: 'accepted',
        createdTaskId: task.id,
      })
      res.json({ ok: true, task })
    } catch (err) {
      console.error('[task-guardrails] accept candidate failed:', err)
      res.status(500).json({ error: 'Failed to accept suggestion' })
    }
  })

  /**
   * Dismiss. A bare dismiss just closes the row; a dismiss WITH a reason also
   * writes a tombstone, so the same "no, and here's why" that upgrades a task
   * deletion into a lesson works from the tray too — without ever having
   * created the task.
   */
  router.post('/:workspaceId/candidates/:id/dismiss', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    const userId = (req as any).userId as string

    const parsed = dismissSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'reason must be 3-500 characters when provided' })
      return
    }

    try {
      const candidate = await getCandidate(req.params.workspaceId, req.params.id)
      if (!candidate || candidate.status !== 'pending') {
        res.status(404).json({ error: 'Suggestion not found' })
        return
      }
      if (parsed.data.reason) {
        await tombstoneFromCandidate({
          workspaceId: req.params.workspaceId,
          userId,
          title: candidate.title,
          reason: parsed.data.reason,
          sourceKind: candidate.sourceKind,
          lane: candidate.lane,
        })
      }
      await resolveCandidate({
        workspaceId: req.params.workspaceId,
        candidateId: req.params.id,
        userId,
        status: 'dismissed',
      })
      res.json({ ok: true, tombstoned: Boolean(parsed.data.reason) })
    } catch (err) {
      console.error('[task-guardrails] dismiss candidate failed:', err)
      res.status(500).json({ error: 'Failed to dismiss suggestion' })
    }
  })

  // ── Tombstones ─────────────────────────────────────────────────

  router.get('/:workspaceId/tombstones', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    try {
      const tombstones = await listTombstones(req.params.workspaceId)
      res.json({ tombstones })
    } catch (err) {
      console.error('[task-guardrails] list tombstones failed:', err)
      res.status(500).json({ error: 'Failed to list rejections' })
    }
  })

  router.delete('/:workspaceId/tombstones/:id', async (req, res) => {
    if (!(await requireWorkspaceMember(req as any, res))) return
    try {
      const ok = await deleteTombstone(req.params.workspaceId, req.params.id)
      if (!ok) {
        res.status(404).json({ error: 'Rejection not found' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[task-guardrails] delete tombstone failed:', err)
      res.status(500).json({ error: 'Failed to delete rejection' })
    }
  })

  return router
}
