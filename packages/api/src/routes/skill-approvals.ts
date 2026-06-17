/**
 * Skill approvals route — workspace-owner surface for resolving V2
 * `staged_skill_update` / `staged_skill_creation` approval rows.
 *
 * The unified `/api/approvals` route (`approvals.ts`) returns 422 for
 * these two kinds with `nativeSurface: 'web'`; the web UI then calls
 * this router to actually approve / reject.
 *
 * Mounted at `/api/skills/approvals` behind `requireAuth`.
 *
 * [COMP:api/skill-approvals-route]
 *
 *   GET    /                       — list pending skill approvals
 *   POST   /:id/approve            — apply patch / create umbrella
 *   POST   /:id/reject             — mark rejected, no mutation
 */

import { Router } from 'express'
import { matchInducedSkill, type ExistingSkillForMatch } from '@sidanclaw/core'
import { query } from '../db/client.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { WorkspaceSkillStore } from '../db/skill-store.js'
import type { WorkspaceSkillFilesStore } from '../db/workspace-skill-files-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'
import type { EntityLinksStore } from '@sidanclaw/core'

export type SkillApprovalRouteOptions = {
  approvalsStore: PendingApprovalsStore
  workspaceStore: WorkspaceStore
  workspaceSkillStore: WorkspaceSkillStore
  fileStore: WorkspaceSkillFilesStore
  enablementStore: WorkspaceSkillEnablementStore
  /** Optional — when present, induction governance (re-derivation matching +
   *  `learned_from` provenance edges) is wired on staged-creation approval
   *  (`docs/plans/skills-as-procedural-brain-primitive.md` §5.1, §5.4, §6). */
  entityLinks?: EntityLinksStore
}

export function skillApprovalsRoutes(opts: SkillApprovalRouteOptions): Router {
  const router = Router()

  // ── GET / — list pending skill approvals for the workspace ──────

  router.get('/', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId =
      typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    try {
      const rows = await opts.approvalsStore.listSkillApprovals(userId, workspaceId)
      res.json({
        approvals: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          arguments: r.arguments,
          approvalPayload: r.approvalPayload,
          originatingAssistantId: r.originatingAssistantId,
          createdAt: r.createdAt.toISOString(),
        })),
      })
    } catch (err) {
      console.error('[skill-approvals] list failed:', err)
      res.status(500).json({ error: 'Failed to list skill approvals' })
    }
  })

  // ── POST /:id/approve — apply the proposed mutation ─────────────

  router.post('/:id/approve', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const approvalId = req.params.id

    const approval = await opts.approvalsStore.getById(userId, approvalId)
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' })
      return
    }
    if (
      approval.kind !== 'staged_skill_update' &&
      approval.kind !== 'staged_skill_creation'
    ) {
      res.status(400).json({ error: 'Approval is not a skill approval' })
      return
    }
    const role = await opts.workspaceStore.getRole(userId, approval.workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Only workspace members can approve' })
      return
    }
    if (approval.status !== 'pending') {
      res.json({ status: approval.status, idempotent: true })
      return
    }

    try {
      if (approval.kind === 'staged_skill_update') {
        await applyStagedSkillUpdate(approval.arguments, approval.workspaceId, userId, opts)
      } else {
        await applyStagedSkillCreation(
          approval.arguments,
          approval.workspaceId,
          approval.originatingAssistantId,
          userId,
          opts,
        )
      }

      const settled = await opts.approvalsStore.respond(approvalId, 'approved', userId)
      res.json({ status: 'approved', applied: true, kind: approval.kind, approval: settled })
    } catch (err) {
      console.error('[skill-approvals] approve failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: 'Failed to apply approval', detail: message })
    }
  })

  // ── POST /:id/reject — mark rejected, no mutation ───────────────

  router.post('/:id/reject', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const approvalId = req.params.id
    const body = (req.body ?? {}) as { reason?: string }
    const reason =
      typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined

    const approval = await opts.approvalsStore.getById(userId, approvalId)
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' })
      return
    }
    if (
      approval.kind !== 'staged_skill_update' &&
      approval.kind !== 'staged_skill_creation'
    ) {
      res.status(400).json({ error: 'Approval is not a skill approval' })
      return
    }
    const role = await opts.workspaceStore.getRole(userId, approval.workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Only workspace members can reject' })
      return
    }
    if (approval.status !== 'pending') {
      res.json({ status: approval.status, idempotent: true })
      return
    }

    const settled = await opts.approvalsStore.respond(approvalId, 'rejected', userId, reason)
    res.json({ status: 'rejected', approval: settled })
  })

  return router
}

// ── Apply functions ────────────────────────────────────────────────

type StagedUpdateArgs = {
  targetSkillId: string
  patch: {
    newContent?: string
    diff?: string
    addedFiles?: Array<{
      kind: 'reference' | 'template' | 'script'
      name: string
      content: string
      description?: string
    }>
  }
}

async function applyStagedSkillUpdate(
  args: unknown,
  workspaceId: string,
  approverUserId: string,
  opts: SkillApprovalRouteOptions,
): Promise<void> {
  const parsed = args as StagedUpdateArgs
  if (!parsed.targetSkillId || !parsed.patch) {
    throw new Error('Invalid staged_skill_update arguments')
  }

  const skill = await opts.workspaceSkillStore.getByIdSystem(parsed.targetSkillId)
  if (!skill || skill.workspaceId !== workspaceId) {
    throw new Error(`Target skill ${parsed.targetSkillId} not found in workspace`)
  }
  if (skill.state === 'archived') {
    throw new Error(`Target skill ${parsed.targetSkillId} is archived`)
  }

  // Apply newContent if present. Approach W stamping happens via the
  // store's update path: any UPDATE on a `user`/`community` skill flips
  // write_origin to 'foreground' — re-affirming user ownership. For
  // already-`auto-generated` skills the approval flow promotes source
  // to 'user' here, again per Approach W.
  if (parsed.patch.newContent !== undefined) {
    await opts.workspaceSkillStore.update(approverUserId, workspaceId, parsed.targetSkillId, {
      content: parsed.patch.newContent,
    })
  }

  if (parsed.patch.addedFiles && parsed.patch.addedFiles.length > 0) {
    for (const file of parsed.patch.addedFiles) {
      await opts.fileStore.upsert(approverUserId, {
        workspaceSkillId: parsed.targetSkillId,
        kind: file.kind,
        name: file.name,
        content: file.content,
        description: file.description ?? null,
      })
    }
  }

  // Promote source from 'auto-generated' to 'user' on first approval
  // (Approach W stamping). For source already 'user'/'community' the
  // update() above already flipped write_origin to 'foreground'; we still
  // stamp `acknowledged_at` so the NEW badge clears.
  await query(
    `UPDATE workspace_skills
     SET source = CASE
                    WHEN source = 'auto-generated' THEN 'user'
                    ELSE source
                  END,
         author_id = COALESCE(author_id, $1),
         acknowledged_at = COALESCE(acknowledged_at, now()),
         updated_at = now()
     WHERE id = $2`,
    [approverUserId, parsed.targetSkillId],
  )
}

type StagedCreationArgs = {
  umbrella: {
    slug: string
    name: string
    description: string
    content: string
    supportFiles?: Array<{
      kind: 'reference' | 'template' | 'script'
      name: string
      content: string
      description?: string
    }>
  }
}

async function applyStagedSkillCreation(
  args: unknown,
  workspaceId: string,
  originatingAssistantId: string | null,
  approverUserId: string,
  opts: SkillApprovalRouteOptions,
): Promise<void> {
  const parsed = args as StagedCreationArgs
  if (!parsed.umbrella) {
    throw new Error('Invalid staged_skill_creation arguments')
  }

  // ── Induction governance: re-derivation matching (plan §5.2 + §10.4) ──
  // Before minting a new skill, check whether this induced skill is a
  // RE-DERIVATION of one already in the workspace. A match records an
  // independent re-derivation (raising confidence toward activation) and emits
  // a `learned_from` provenance edge to the SAME existing skill INSTEAD of
  // creating a duplicate. Deliberately strict (slug / near-duplicate name) so a
  // false negative just keeps a skill suggested a little longer.
  const existingSkills = await opts.workspaceSkillStore.listForWorkspace(workspaceId, {
    actingUserId: approverUserId,
  })
  const matchCandidates: ExistingSkillForMatch[] = existingSkills
    .filter((s) => s.state !== 'archived')
    .map((s) => ({ rowId: s.rowId, slug: s.slug, name: s.name, whenToUse: s.whenToUse }))
  const match = matchInducedSkill(
    { slug: parsed.umbrella.slug, name: parsed.umbrella.name },
    matchCandidates,
  )

  if (match) {
    // Re-derivation: bump the existing skill's count/confidence (never auto-
    // activates an `ingested`-source skill — that path is guarded in the store)
    // and emit a provenance edge to it. No new row.
    await opts.workspaceSkillStore.recordRederivation(match.rowId)
    emitLearnedFromEdge(opts, {
      skillRowId: match.rowId,
      workspaceId,
      originatingAssistantId,
      approverUserId,
    })
    return
  }

  // ── No match → create as a new induced skill ──
  // `inductionSource: 'self'` — derived from the team's own interaction /
  // correction trajectory (v1 default; an ingest-episode trajectory would set
  // 'ingested', which never auto-activates). The skill is human-approved here,
  // so it is created `source='user'` / `writeOrigin='foreground'`; the
  // induction_source column records the provenance tier regardless.
  //
  // Inserting a fresh workspace_skills row + its support files. The whole
  // sequence is best-effort wrapped — partial creation rolls back via
  // explicit cleanup since we don't have a transaction handle here. The
  // workspace_skills row is created first; on failure of subsequent file
  // upserts, the parent row is closed bi-temporally.
  const created = await opts.workspaceSkillStore.create(
    approverUserId,
    workspaceId,
    {
      slug: parsed.umbrella.slug,
      name: parsed.umbrella.name,
      description: parsed.umbrella.description,
      content: parsed.umbrella.content,
      category: 'custom',
      source: 'user',
      writeOrigin: 'foreground',
      originatingAssistantId,
      inductionSource: 'self',
    },
  )

  // Provenance audit trail — `learned_from` edge to the originating assistant.
  emitLearnedFromEdge(opts, {
    skillRowId: created.rowId,
    workspaceId,
    originatingAssistantId,
    approverUserId,
  })

  try {
    if (parsed.umbrella.supportFiles && parsed.umbrella.supportFiles.length > 0) {
      for (const file of parsed.umbrella.supportFiles) {
        await opts.fileStore.upsert(approverUserId, {
          workspaceSkillId: created.rowId,
          kind: file.kind,
          name: file.name,
          content: file.content,
          description: file.description ?? null,
        })
      }
    }
    // Enable for the originating assistant (S14 — automatically enabled
    // for the assistant whose pattern produced the umbrella). If no
    // originating assistant is known we leave the skill workspace-visible
    // but not enabled anywhere.
    if (originatingAssistantId) {
      await opts.enablementStore.enable(created.rowId, originatingAssistantId, approverUserId)
    }
  } catch (err) {
    // Best-effort cleanup so an interrupted creation doesn't leave an
    // orphan parent row visible in the UI.
    try {
      await opts.workspaceSkillStore.delete(approverUserId, workspaceId, created.rowId)
    } catch {}
    throw err
  }
}

/**
 * Emit a `learned_from` induction-provenance edge (skill → assistant), fire-
 * and-forget (`docs/plans/skills-as-procedural-brain-primitive.md` §6). The
 * edge records WHERE the skill was induced and doubles as the re-derivation
 * audit trail. Provenance target is the originating assistant; with no
 * originating assistant there is no provenance to record, so we skip. A
 * missing `entityLinks` dep (route constructed without it) also skips. An edge
 * failure never breaks the approval write.
 */
function emitLearnedFromEdge(
  opts: SkillApprovalRouteOptions,
  params: {
    skillRowId: string
    workspaceId: string
    originatingAssistantId: string | null
    approverUserId: string
  },
): void {
  if (!opts.entityLinks || !params.originatingAssistantId) return
  void opts.entityLinks
    .create({
      sourceKind: 'skill',
      sourceId: params.skillRowId,
      targetKind: 'assistant',
      targetId: params.originatingAssistantId,
      edgeType: 'learned_from',
      workspaceId: params.workspaceId,
      source: 'model',
      userId: params.approverUserId,
      assistantId: params.originatingAssistantId,
      attributes: {},
    })
    .catch((err) =>
      console.error(
        `[skill-approvals] learned_from edge failed (skill=${params.skillRowId} → assistant:${params.originatingAssistantId}):`,
        err,
      ),
    )
}
