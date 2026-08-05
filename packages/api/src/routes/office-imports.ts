/** Safe Office import job admission; parsing stays in the worker. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeImportsRouteDeps = {
  available(): boolean
  createShell(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; title: string; templateVersionId: string | null; capabilityVersion: number; sensitivity: 'public' | 'internal' | 'confidential' }): Promise<OfficeArtifactRow>
  deleteEmptyShell(userId: string, artifactId: string): Promise<boolean>
  createJob(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: OfficeGenerationJobRow['jobKind']; brief: unknown; authorityProjection: unknown; templateVersionId?: string; idempotencyKey: string }): Promise<OfficeGenerationJobRow>
  wake?(userId: string): void
}

export function officeImportRoutes(deps: OfficeImportsRouteDeps): Router {
  const router = Router()
  router.post('/imports', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ workspaceId: z.string().uuid(), assistantId: z.string().uuid(), family: z.enum(['document','presentation']), sourceFileId: z.string().uuid(), title: z.string().min(1).max(1_000), templateVersionId: z.string().uuid(), sensitivity: z.enum(['public','internal','confidential']).default('internal'), idempotencyKey: z.string().min(8).max(255) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office import request', issues: body.error.issues })
    if (!deps.available()) return void res.status(503).json({ error: 'office_import_unavailable' })
    const artifact = await deps.createShell({ userId, workspaceId: body.data.workspaceId, family: body.data.family, title: body.data.title, templateVersionId: body.data.templateVersionId, capabilityVersion: 1, sensitivity: body.data.sensitivity })
    let job: OfficeGenerationJobRow
    try {
      job = await deps.createJob({ userId, workspaceId: body.data.workspaceId, artifactId: artifact.id, assistantId: body.data.assistantId, jobKind: 'import', brief: { sourceFileId: body.data.sourceFileId, family: body.data.family, title: body.data.title }, authorityProjection: { sensitivity: body.data.sensitivity, sourceHandles: [`file:${body.data.sourceFileId}`] }, templateVersionId: body.data.templateVersionId, idempotencyKey: body.data.idempotencyKey })
    } catch (cause) {
      await deps.deleteEmptyShell(userId, artifact.id)
      throw cause
    }
    if (job.artifactId !== artifact.id) await deps.deleteEmptyShell(userId, artifact.id)
    deps.wake?.(userId)
    res.status(202).json({ artifactId: job.artifactId, jobId: job.id })
  })
  return router
}
