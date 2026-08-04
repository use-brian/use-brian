/** Office template registry endpoints. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'

export type OfficeTemplatesRouteDeps = {
  list(userId: string, workspaceId: string, family?: 'document' | 'presentation'): Promise<unknown[]>
  createDraft(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential' }): Promise<{ id: string }>
  createTemplateShell(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; title: string; templateVersionId: null; capabilityVersion: number; sensitivity: 'public' | 'internal' | 'confidential'; mode: 'template' }): Promise<{ id: string }>
  createCompileJob(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: 'template_compile'; brief: unknown; authorityProjection: unknown; idempotencyKey: string }): Promise<{ id: string }>
  wakeCompile?(userId: string): void
  transitionLifecycle(params: { userId: string; templateId: string; action: 'deprecate' | 'restore' | 'trash' | 'purge'; reason: string }): Promise<unknown | null>
}

export function officeTemplateRoutes(deps: OfficeTemplatesRouteDeps): Router {
  const router = Router()
  router.get('/templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = z.string().uuid().safeParse(req.query.workspaceId)
    const family = z.enum(['document', 'presentation']).optional().safeParse(req.query.family)
    if (!workspaceId.success || !family.success) return void res.status(400).json({ error: 'Invalid template query' })
    res.json({ templates: await deps.list(userId, workspaceId.data, family.data) })
  })
  router.post('/templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ workspaceId: z.string().uuid(), family: z.enum(['document', 'presentation']), name: z.string().min(1).max(255), description: z.string().min(1).max(4_000), sensitivity: z.enum(['public', 'internal', 'confidential']).default('internal') }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template draft', issues: body.error.issues })
    const [template, artifact] = await Promise.all([
      deps.createDraft({ userId, ...body.data }),
      deps.createTemplateShell({ userId, workspaceId: body.data.workspaceId, family: body.data.family, title: body.data.name, templateVersionId: null, capabilityVersion: 1, sensitivity: body.data.sensitivity, mode: 'template' }),
    ])
    res.status(201).json({ ...template, draftArtifactId: artifact.id })
  })
  router.post('/templates/:templateId/compile', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const source = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('upload'), fileId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal('scratch') }).strict(),
      z.object({ kind: z.literal('promote'), artifactVersionId: z.string().uuid() }).strict(),
    ])
    const body = z.object({ workspaceId: z.string().uuid(), draftArtifactId: z.string().uuid(), assistantId: z.string().uuid().nullable().default(null), source, idempotencyKey: z.string().min(8).max(255) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template compile request', issues: body.error.issues })
    const job = await deps.createCompileJob({ userId, workspaceId: body.data.workspaceId, artifactId: body.data.draftArtifactId, assistantId: body.data.assistantId, jobKind: 'template_compile', brief: { templateId: String(req.params.templateId), source: body.data.source }, authorityProjection: { sensitivity: 'internal' }, idempotencyKey: body.data.idempotencyKey })
    deps.wakeCompile?.(userId)
    res.status(202).json({ jobId: job.id })
  })
  router.post('/templates/:templateId/lifecycle', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ action: z.enum(['deprecate', 'restore', 'trash', 'purge']), reason: z.string().min(1).max(2_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template lifecycle request', issues: body.error.issues })
    const template = await deps.transitionLifecycle({ userId, templateId: String(req.params.templateId), ...body.data })
    if (!template) return void res.status(409).json({ error: 'template_lifecycle_blocked' })
    res.json({ template })
  })
  return router
}
