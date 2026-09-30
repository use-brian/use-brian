import type { Router, Request, Response } from 'express'
import { z } from 'zod'
import type { WorkflowRecord, WorkflowStore } from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  createPublicationConsentStore, publicationRevision, publicationTarget, type PublicationConsentStore,
} from '../workflow/publication-consent.js'

export function mountWorkflowPublicationRoutes(router: Router, options: {
  workflowStore: WorkflowStore; workspaceStore: WorkspaceStore; publicationConsentStore?: PublicationConsentStore
}) {
  const store = options.publicationConsentStore ?? createPublicationConsentStore()
  const bodySchema = z.object({ acknowledged: z.literal(true), workflowUpdatedAt: z.string().datetime(),
    consentVersion: z.string().regex(/^(0|[1-9]\d*)$/).max(20) }).strict()
  const ids = z.object({ id: z.string().uuid(), stepId: z.string().min(1).max(200).optional() })
  async function context(req: Request, res: Response) {
    const userId = (req as Request & { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    if (!ids.safeParse(req.params).success) { res.status(400).json({ error: 'Invalid workflow or step' }); return null }
    const workflow = await options.workflowStore.getById(userId, String(req.params.id))
    if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return null }
    const role = await options.workspaceStore.getRole(userId, workflow.workspaceId)
    if (!role) { res.status(403).json({ error: 'Workspace access required' }); return null }
    return { workflow, userId, canManage: workflow.createdBy === userId && (role === 'owner' || role === 'admin') }
  }
  async function payload(ctx: { workflow: WorkflowRecord; userId: string; canManage: boolean }) {
    const { workflow, userId, canManage } = ctx
    const revision = publicationRevision(workflow)
    const { consents, consentVersion } = await store.withPublicationLock(workflow.id, userId, async () => ({
      consents: await store.list(workflow.id, userId), consentVersion: await store.version(workflow.id, userId),
    }))
    const seen = new Set<string>()
    return {
      canManage,
      consentVersion,
      workflowUpdatedAt: workflow.updatedAt.toISOString(),
      eligibleStepIds: workflow.definition.steps.filter(s => publicationTarget(workflow, s.id)).map(s => s.id),
      consents: consents.filter(c => { if (seen.has(c.stepId)) return false; seen.add(c.stepId); return true }).map(c => ({
        stepId: c.stepId, channelType: c.channelType, channelId: c.channelId, channelIntegrationId: c.channelIntegrationId,
        approvedAt: c.approvedAt, expiresAt: c.expiresAt,
        active: canManage && !c.revokedAt && c.workflowRevision === revision && Date.parse(c.expiresAt) > Date.now(),
      })),
    }
  }
  router.get('/workflows/:id/publication-consents', async (req, res) => {
    const ctx = await context(req, res)
    if (ctx) res.json(await payload(ctx))
  })
  router.post('/workflows/:id/steps/:stepId/publication-consent', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!ctx.canManage) { res.status(403).json({ error: 'Only the workflow creator with owner or admin access can approve publication' }); return }
    const body = bodySchema.safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: 'Explicit publication acknowledgement required' }); return }
    if (body.data.workflowUpdatedAt !== ctx.workflow.updatedAt.toISOString()) {
      res.status(409).json({ error: 'Workflow changed; review the saved workflow again' }); return
    }
    const stepId = String(req.params.stepId)
    const target = publicationTarget(ctx.workflow, stepId)
    if (!target) { res.status(400).json({ error: 'Select a fixed Telegram group destination and integration without a question action' }); return }
    // Versioned, serialized replacement prevents an older dialog/request from
    // resurrecting consent after a concurrent withdrawal. Keep the old audit rows.
    const approved = await store.approve({
      workflowId: ctx.workflow.id, workspaceId: ctx.workflow.workspaceId, stepId,
      approvedByUserId: ctx.userId, workflowRevision: publicationRevision(ctx.workflow), ...target,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, body.data.consentVersion)
    if (!approved) { res.status(409).json({ error: 'Publication consent changed; review it again' }); return }
    res.json(await payload(ctx))
  })
  router.delete('/workflows/:id/steps/:stepId/publication-consent', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    // A source owner may always withdraw their own consent, including after demotion.
    await store.revoke(ctx.workflow.id, String(req.params.stepId), ctx.userId)
    res.json(await payload(ctx))
  })
}
