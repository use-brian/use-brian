/** Persisted Office activity/steering routes. [COMP:api/office-routes] */
import { Router } from 'express'
import {officeMetadataRoute} from './office-metadata.js'
import { z } from 'zod'
import { officeImportDiagnostics } from '../db/office-generation.js'
import type { OfficeGenerationEventRow, OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeJobsRouteDeps = {
  get(userId: string, jobId: string): Promise<OfficeGenerationJobRow | null>
  events(userId: string, jobId: string, afterSeq: number): Promise<OfficeGenerationEventRow[]>
  steer(params: { userId: string; workspaceId: string; jobId: string; instruction: string }): Promise<{ id: string }>
  wake?(userId: string): void
  cancel(userId: string, jobId: string): Promise<boolean>
}

export function officeJobRoutes(deps: OfficeJobsRouteDeps): Router {
  const router = Router()
  router.get('/jobs/:jobId', officeMetadataRoute(async (req, userId) => {
    const job = await deps.get(userId, String(req.params.jobId))
    if (!job) return {status:404,body:{ error: 'Office job not found' }}
    return {workspaceId:job.workspaceId,body:{job:{...job, importDiagnostics: officeImportDiagnostics(job.checkpoint)}}}
  }))

  router.get('/jobs/:jobId/events', officeMetadataRoute(async (req, userId) => {
    const jobId = String(req.params.jobId)
    const job = await deps.get(userId, jobId)
    if (!job) return {status:404,body:{ error: 'Office job not found' }}
    const afterSeq = z.coerce.number().int().min(0).catch(0).parse(req.query.afterSeq)
    return {workspaceId:job.workspaceId,body:{ events: await deps.events(userId, jobId, afterSeq) }}
  }))

  router.post('/jobs/:jobId/steering', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ instruction: z.string().min(1).max(10_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid steering request' })
    const jobId = String(req.params.jobId)
    const job = await deps.get(userId, jobId)
    if (!job || !['queued', 'running', 'needs_input'].includes(job.status)) return void res.status(409).json({ error: 'Job cannot accept steering' })
    const result = await deps.steer({ userId, workspaceId: job.workspaceId, jobId, instruction: body.data.instruction })
    deps.wake?.(userId)
    res.status(202).json(result)
  })

  router.post('/jobs/:jobId/cancel', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const jobId = String(req.params.jobId)
    if (!await deps.get(userId, jobId)) return void res.status(404).json({ error: 'Office job not found' })
    if (!await deps.cancel(userId, jobId)) return void res.status(409).json({ error: 'Job is already terminal' })
    res.status(202).json({ ok: true })
  })
  return router
}
