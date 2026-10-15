/**
 * REST for governed Briefs (project-briefs.md -> "Commands"). Every route is
 * a thin call into the same service as Brian's tools, so the Brief pane and
 * Brian share authority, revision checks, errors and receipts.
 *
 * [COMP:api/brief-publication]
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import {
  briefHistory,
  dismissProposal,
  ensureBrief,
  inspectBrief,
  listDepartmentBriefs,
  proposeChange,
  adoptPageAsProposal,
  repairBrief,
  saveDraft,
  selectDepartmentBriefs,
  type BriefActor,
} from '../briefs/service.js'
import { applyDirection, restoreRevision } from '../briefs/publication.js'
import { maintainBriefContext } from '../briefs/maintenance.js'
import { maintainBriefContextSchema } from '../briefs/tools.js'

const UUID = z.string().uuid()
const lines = z.array(z.string().trim().min(1).max(2000)).max(50)
const sections = z.object({ outcome: lines.optional(), rules: lines.optional(), decisions: lines.optional() }).strict()
const evidence = z.object({ kind: z.string().trim().min(1).max(64), id: z.string().max(200).nullable().optional(),
  version: z.string().max(200).nullable().optional(), passage: z.string().max(4000).nullable().optional(),
  label: z.string().max(200).nullable().optional() }).strict()

const ensureBody = z.object({ ownerKind: z.enum(['project', 'department']), ownerId: UUID, locale: z.string().max(10).optional() }).strict()
const draftBody = z.object({ sections, summary: z.string().max(2000).optional() }).strict()
const proposeBody = z.object({ sections, evidence: z.array(evidence).min(1).max(20), summary: z.string().max(2000).optional() }).strict()
const applyBody = z.object({
  proposalId: UUID.optional(), sections: sections.optional(),
  expectedDirectionRevision: z.number().int().min(0), expectedSelectionRevision: z.number().int().min(0),
  activeWork: z.enum(['pause', 'continue']).default('pause'), idempotencyKey: UUID,
}).strict()
const selectBody = z.object({ departmentBindingIds: z.array(UUID).max(20), expectedSelectionRevision: z.number().int().min(0),
  activeWork: z.enum(['pause', 'continue']).default('pause'), idempotencyKey: UUID }).strict()

export function briefRoutes(): Router {
  const router = Router({ mergeParams: true })

  function actorOf(req: Request, res: Response): BriefActor | null {
    const userId = req.userId
    const workspaceId = String(req.params.workspaceId ?? '')
    if (!userId) { res.status(401).json({ error: 'unauthorized' }); return null }
    if (!UUID.safeParse(workspaceId).success) { res.status(404).json({ error: 'brief_not_found' }); return null }
    return { userId, workspaceId, assistantId: null }
  }

  /** Typed errors keep their status; a bad body is 400; anything else is a crash. */
  function handle(work: (actor: BriefActor, req: Request) => Promise<unknown>, status = 200) {
    return async (req: Request, res: Response) => {
      const actor = actorOf(req, res)
      if (!actor) return
      try {
        res.status(status).json(await work(actor, req))
      } catch (error) {
        if (error instanceof WorkspaceAccessError) return void res.status(error.status).json({ error: error.code })
        if (error instanceof z.ZodError) return void res.status(400).json({ error: 'brief_ops_invalid' })
        throw error
      }
    }
  }
  const param = (req: Request, name: string) => UUID.parse(req.params[name])

  router.get('/workspaces/:workspaceId/briefs/departments', handle(async actor => ({ departmentBriefs: await listDepartmentBriefs(actor) })))
  router.get('/workspaces/:workspaceId/briefs/by-owner/:ownerKind/:ownerId', handle(async (actor, req) => {
    const kind = z.enum(['project', 'department']).parse(req.params.ownerKind)
    return { brief: await inspectBrief(actor, { owner: { kind, id: param(req, 'ownerId') } }) }
  }))
  router.post('/workspaces/:workspaceId/briefs/ensure', handle(async (actor, req) => {
    const body = ensureBody.parse(req.body)
    const ensured = await ensureBrief(actor, { kind: body.ownerKind, id: body.ownerId }, { locale: body.locale })
    return { ...ensured, brief: await inspectBrief(actor, { bindingId: ensured.bindingId }) }
  }))
  router.get('/workspaces/:workspaceId/briefs/:bindingId', handle(async (actor, req) => ({ brief: await inspectBrief(actor, { bindingId: param(req, 'bindingId') }) })))
  router.get('/workspaces/:workspaceId/briefs/:bindingId/revisions', handle(async (actor, req) => ({ revisions: await briefHistory(actor, param(req, 'bindingId')) })))
  router.put('/workspaces/:workspaceId/briefs/:bindingId/draft', handle(async (actor, req) => {
    const body = draftBody.parse(req.body)
    return { draft: await saveDraft(actor, param(req, 'bindingId'), { sections: body.sections }, { summary: body.summary ?? null }) }
  }))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/proposals', handle(async (actor, req) => {
    const body = proposeBody.parse(req.body)
    return { proposal: await proposeChange(actor, param(req, 'bindingId'), { sections: body.sections }, { evidence: body.evidence, summary: body.summary ?? null }) }
  }, 201))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/proposals/:proposalId/dismiss', handle(async (actor, req) => {
    await dismissProposal(actor, param(req, 'proposalId'))
    return { dismissed: param(req, 'proposalId') }
  }))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/apply', handle(async (actor, req) => {
    const body = applyBody.parse(req.body)
    return { receipt: await applyDirection(actor, param(req, 'bindingId'), {
      proposalId: body.proposalId ?? null, ...(body.sections ? { change: { sections: body.sections } } : {}),
      expectedDirectionRevision: body.expectedDirectionRevision, expectedSelectionRevision: body.expectedSelectionRevision,
      activeWork: body.activeWork, idempotencyKey: body.idempotencyKey,
    }) }
  }))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/revisions/:revisionId/restore', handle(async (actor, req) =>
    restoreRevision(actor, param(req, 'bindingId'), param(req, 'revisionId')), 201))
  router.put('/workspaces/:workspaceId/briefs/:bindingId/departments', handle(async (actor, req) => {
    const body = selectBody.parse(req.body)
    return { receipt: await selectDepartmentBriefs(actor, param(req, 'bindingId'), body) }
  }))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/repair', handle(async (actor, req) => repairBrief(actor, param(req, 'bindingId'))))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/adopt-page', handle(async (actor, req) => {
    const body = z.object({ pageId: UUID, section: z.enum(['outcome', 'rules', 'decisions']) }).strict().parse(req.body)
    return { proposal: await adoptPageAsProposal(actor, param(req, 'bindingId'), body) }
  }, 201))
  router.post('/workspaces/:workspaceId/briefs/:bindingId/context', handle(async (actor, req) => {
    const body = maintainBriefContextSchema.omit({ bindingId: true }).parse(req.body)
    return maintainBriefContext(actor, param(req, 'bindingId'), body)
  }))
  return router
}
