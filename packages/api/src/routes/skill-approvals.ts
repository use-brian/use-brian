/**
 * Skill approvals route — workspace-owner surface for resolving the
 * curator's approval rows: `staged_skill_update` / `staged_skill_creation`
 * / `workflow_refinement` (origin-aware induction).
 *
 * The unified `/api/approvals` route (`approvals.ts`) returns 422 for
 * these kinds with `nativeSurface: 'web'`; the web UI then calls
 * this router to actually approve / reject.
 *
 * Mounted at `/api/skills/approvals` behind `requireAuth`.
 *
 * [COMP:api/skill-approvals-route]
 *
 *   GET    /                       — list pending curator approvals, each
 *                                    `staged_skill_update` row enriched with
 *                                    a `targetSkill` snapshot (name + current
 *                                    content) and each `workflow_refinement`
 *                                    row with a `targetWorkflow` snapshot
 *                                    (name + current step prompt) for the
 *                                    queue's headline + diff
 *   POST   /:id/approve            — apply patch / create umbrella / apply
 *                                    workflow refinement; a creation approve
 *                                    optionally applies the attach offer
 *                                    (body `{ attach: true, attachStepId? }`)
 *   POST   /:id/reject             — mark rejected, no mutation
 */

import { Router } from 'express'
import { matchInducedSkill, type ExistingSkillForMatch } from '@use-brian/core'
import { query } from '../db/client.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { WorkspaceSkillStore } from '../db/skill-store.js'
import type { WorkspaceSkillFilesStore } from '../db/workspace-skill-files-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'
import type { EntityLinksStore, WorkflowStore } from '@use-brian/core'
import type { ValidatedDefinitionEditor } from './workflows.js'

export type SkillApprovalRouteOptions = {
  approvalsStore: PendingApprovalsStore
  workspaceStore: WorkspaceStore
  workspaceSkillStore: WorkspaceSkillStore
  fileStore: WorkspaceSkillFilesStore
  enablementStore: WorkspaceSkillEnablementStore
  /** Optional — when present, induction governance (re-derivation matching +
   *  `learned_from` provenance edges) is wired on staged-creation approval
   *  (`docs/architecture/engine/skill-system.md` §5.1, §5.4, §6). */
  entityLinks?: EntityLinksStore
  /**
   * Origin-aware induction deps. Both optional (minimal boots, tests):
   * absent, `workflow_refinement` rows list but approve returns 501, and
   * the attach offer on creation approves is skipped. `workflowStore` backs
   * the GET enrichment (workflow name + current step prompt);
   * `applyDefinitionEdit` is the validated write path shared with the REST
   * builder (`createValidatedDefinitionEditor`, `routes/workflows.ts`).
   */
  workflowStore?: WorkflowStore
  applyDefinitionEdit?: ValidatedDefinitionEditor
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

      // Enrich `staged_skill_update` rows with a snapshot of the target
      // skill (name + current content) so the unified queue can render a
      // headline and a current-vs-proposed diff without a per-card
      // round-trip. `getByIdSystem` bypasses RLS, so re-scope every hit to
      // the route workspace before it leaves the API.
      const targetIds = Array.from(
        new Set(
          rows
            .filter((r) => r.kind === 'staged_skill_update')
            .map((r) => (r.approvalPayload as { targetSkillId?: unknown }).targetSkillId)
            .filter((v): v is string => typeof v === 'string'),
        ),
      )
      const targets = new Map<
        string,
        { id: string; name: string; slug: string; content: string }
      >()
      for (const id of targetIds) {
        const skill = await opts.workspaceSkillStore.getByIdSystem(id)
        if (skill && skill.workspaceId === workspaceId) {
          targets.set(id, {
            id: skill.rowId,
            name: skill.name,
            slug: skill.slug,
            content: skill.content,
          })
        }
      }

      // Enrich workflow-touching rows (`workflow_refinement`, plus creation
      // rows carrying an attach offer) with a workflow snapshot: name for
      // the headline, and — for refinements — the current step prompt so
      // the card renders a current-vs-proposed diff. RLS-scoped read; a
      // vanished workflow yields null (the UI blocks approve).
      const workflowIds = Array.from(
        new Set(
          rows
            .map(
              (r) =>
                (r.approvalPayload as { workflowId?: unknown; attachTo?: { workflowId?: unknown } }),
            )
            .flatMap((p) => [p.workflowId, p.attachTo?.workflowId])
            .filter((v): v is string => typeof v === 'string'),
        ),
      )
      const workflows = new Map<
        string,
        {
          id: string
          name: string
          steps: Array<{ id: string; type: string; prompt: string | null }>
        }
      >()
      if (opts.workflowStore && workflowIds.length > 0) {
        for (const id of workflowIds) {
          try {
            const wf = await opts.workflowStore.getById(userId, id)
            if (wf && wf.workspaceId === workspaceId) {
              workflows.set(id, {
                id: wf.id,
                name: wf.name,
                steps: wf.definition.steps.map((s) => ({
                  id: s.id,
                  type: s.type,
                  prompt: s.type === 'assistant_call' ? s.prompt : null,
                })),
              })
            }
          } catch {
            // Enrichment is best-effort; the card renders without it.
          }
        }
      }

      res.json({
        approvals: rows.map((r) => {
          const payload = r.approvalPayload as {
            targetSkillId?: unknown
            workflowId?: unknown
            attachTo?: { workflowId?: unknown }
          }
          const targetSkillId = payload.targetSkillId
          const workflowId =
            typeof payload.workflowId === 'string'
              ? payload.workflowId
              : typeof payload.attachTo?.workflowId === 'string'
                ? payload.attachTo.workflowId
                : null
          return {
            id: r.id,
            kind: r.kind,
            status: r.status,
            arguments: r.arguments,
            approvalPayload: r.approvalPayload,
            originatingAssistantId: r.originatingAssistantId,
            createdAt: r.createdAt.toISOString(),
            // null for creation rows, and for update rows whose target was
            // deleted after staging (the UI blocks approve in that case).
            targetSkill:
              typeof targetSkillId === 'string'
                ? (targets.get(targetSkillId) ?? null)
                : null,
            // null when the row touches no workflow, and when the workflow
            // vanished after staging (the UI blocks refinement approve, and
            // hides the attach offer).
            targetWorkflow: workflowId ? (workflows.get(workflowId) ?? null) : null,
          }
        }),
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
      approval.kind !== 'staged_skill_creation' &&
      approval.kind !== 'workflow_refinement'
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
      let attachOutcome: { applied: boolean; error?: string } | undefined
      if (approval.kind === 'staged_skill_update') {
        await applyStagedSkillUpdate(approval.arguments, approval.workspaceId, userId, opts)
      } else if (approval.kind === 'workflow_refinement') {
        await applyWorkflowRefinement(approval.arguments, approval.workspaceId, userId, opts)
      } else {
        const { skillSlug } = await applyStagedSkillCreation(
          approval.arguments,
          approval.workspaceId,
          approval.originatingAssistantId,
          approval.approvalPayload,
          userId,
          opts,
        )
        // Attach offer (origin-aware induction): explicit opt-in from the
        // card (`body.attach === true`). Best-effort AFTER the skill exists
        // — a rejected attach (validation, vanished step) never unwinds the
        // approved creation; the outcome rides the response instead.
        const body = (req.body ?? {}) as { attach?: boolean; attachStepId?: string }
        const attachTo = ((approval.approvalPayload ?? {}) as {
          attachTo?: { workflowId?: string; stepId?: string }
        }).attachTo
        if (body.attach === true && attachTo?.workflowId) {
          attachOutcome = await applyAttachOffer({
            workflowId: attachTo.workflowId,
            stepId: typeof body.attachStepId === 'string' ? body.attachStepId : attachTo.stepId,
            skillSlug,
            workspaceId: approval.workspaceId,
            userId,
            opts,
          })
        }
      }

      const settled = await opts.approvalsStore.respond(approvalId, 'approved', userId)
      res.json({
        status: 'approved',
        applied: true,
        kind: approval.kind,
        approval: settled,
        ...(attachOutcome ? { attach: attachOutcome } : {}),
      })
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
      approval.kind !== 'staged_skill_creation' &&
      approval.kind !== 'workflow_refinement'
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

/**
 * Apply an approved `workflow_refinement`: replace the target step's prompt
 * through the validated definition-edit path (`createValidatedDefinitionEditor`
 * — the same schema + page-anchor + dependency-preflight bar as the REST
 * builder). Throws on a validation rejection so the row stays pending — the
 * user can reject it instead.
 */
async function applyWorkflowRefinement(
  args: unknown,
  workspaceId: string,
  approverUserId: string,
  opts: SkillApprovalRouteOptions,
): Promise<void> {
  const parsed = args as {
    workflowId?: string
    stepId?: string
    patch?: { prompt?: string }
  }
  if (!parsed.workflowId || !parsed.stepId || !parsed.patch?.prompt) {
    throw new Error('Invalid workflow_refinement arguments')
  }
  if (!opts.applyDefinitionEdit) {
    throw new Error('Workflow refinement apply is not wired on this deployment')
  }
  const { workflowId, stepId } = parsed
  const prompt = parsed.patch.prompt
  const result = await opts.applyDefinitionEdit({
    userId: approverUserId,
    workspaceId,
    workflowId,
    mutate: (definition) => {
      const step = definition.steps.find((s) => s.id === stepId)
      if (!step) return { error: `Step '${stepId}' no longer exists in the workflow` }
      if (step.type !== 'assistant_call') {
        return { error: `Step '${stepId}' is not an assistant_call step` }
      }
      step.prompt = prompt
      return definition
    },
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
}

/**
 * Apply the attach offer of an approved workflow-origin skill creation:
 * append the new skill's slug to the target step's `skills` allow-list,
 * through the same validated definition-edit path. Best-effort — the caller
 * reports the outcome instead of unwinding the created skill.
 */
async function applyAttachOffer(params: {
  workflowId: string
  stepId: string | undefined
  skillSlug: string
  workspaceId: string
  userId: string
  opts: SkillApprovalRouteOptions
}): Promise<{ applied: boolean; error?: string }> {
  if (!params.opts.applyDefinitionEdit) {
    return { applied: false, error: 'Workflow edit path not wired on this deployment' }
  }
  if (!params.stepId) {
    return { applied: false, error: 'No target step resolved for the attach offer' }
  }
  const stepId = params.stepId
  const result = await params.opts.applyDefinitionEdit({
    userId: params.userId,
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    mutate: (definition) => {
      const step = definition.steps.find((s) => s.id === stepId)
      if (!step) return { error: `Step '${stepId}' no longer exists in the workflow` }
      if (step.type !== 'assistant_call') {
        return { error: `Step '${stepId}' is not an assistant_call step` }
      }
      if (!step.skills?.includes(params.skillSlug)) {
        step.skills = [...(step.skills ?? []), params.skillSlug]
      }
      return definition
    },
  })
  return result.ok ? { applied: true } : { applied: false, error: result.error }
}

async function applyStagedSkillCreation(
  args: unknown,
  workspaceId: string,
  originatingAssistantId: string | null,
  approvalPayload: unknown,
  approverUserId: string,
  opts: SkillApprovalRouteOptions,
): Promise<{ skillSlug: string }> {
  const parsed = args as StagedCreationArgs
  if (!parsed.umbrella) {
    throw new Error('Invalid staged_skill_creation arguments')
  }
  // Origin-aware induction: a workflow-origin candidate routes its
  // `learned_from` provenance edge at the source WORKFLOW instead of the
  // assistant (D6) — the workflow is where the pattern actually lives.
  const sourceWorkflowIds = (approvalPayload as { sourceWorkflowIds?: unknown })
    ?.sourceWorkflowIds
  const sourceWorkflowId =
    Array.isArray(sourceWorkflowIds) && typeof sourceWorkflowIds[0] === 'string'
      ? sourceWorkflowIds[0]
      : null

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
      sourceWorkflowId,
      approverUserId,
    })
    return { skillSlug: match.slug }
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

  // Provenance audit trail — `learned_from` edge to the source workflow
  // (workflow-origin inductions) or the originating assistant (interactive).
  emitLearnedFromEdge(opts, {
    skillRowId: created.rowId,
    workspaceId,
    originatingAssistantId,
    sourceWorkflowId,
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
  return { skillSlug: parsed.umbrella.slug }
}

/**
 * Emit a `learned_from` induction-provenance edge, fire-and-forget
 * (`docs/architecture/engine/skill-system.md` §6). The edge records WHERE
 * the skill was induced and doubles as the re-derivation audit trail.
 * Provenance target: the source WORKFLOW when the induction came from a
 * workflow-origin session (`sourceWorkflowId` from the approval payload —
 * origin-aware induction D6), otherwise the originating assistant. With
 * neither there is no provenance to record, so we skip. A missing
 * `entityLinks` dep (route constructed without it) also skips. An edge
 * failure never breaks the approval write.
 */
function emitLearnedFromEdge(
  opts: SkillApprovalRouteOptions,
  params: {
    skillRowId: string
    workspaceId: string
    originatingAssistantId: string | null
    sourceWorkflowId?: string | null
    approverUserId: string
  },
): void {
  if (!opts.entityLinks) return
  const target = params.sourceWorkflowId
    ? { targetKind: 'workflow' as const, targetId: params.sourceWorkflowId }
    : params.originatingAssistantId
      ? { targetKind: 'assistant' as const, targetId: params.originatingAssistantId }
      : null
  if (!target) return
  void opts.entityLinks
    .create({
      sourceKind: 'skill',
      sourceId: params.skillRowId,
      targetKind: target.targetKind,
      targetId: target.targetId,
      edgeType: 'learned_from',
      workspaceId: params.workspaceId,
      source: 'model',
      userId: params.approverUserId,
      assistantId: params.originatingAssistantId ?? undefined,
      attributes: {},
    })
    .catch((err) =>
      console.error(
        `[skill-approvals] learned_from edge failed (skill=${params.skillRowId} → ${target.targetKind}:${target.targetId}):`,
        err,
      ),
    )
}
