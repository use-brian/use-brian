/** Authenticated Office artifact routes. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeArtifactToolProjection, OfficeToolPort } from '@use-brian/core'

export type OfficeArtifactsRouteDeps = {
  service: OfficeToolPort
  list(userId: string, workspaceId: string, view: 'active' | 'archived' | 'trash'): Promise<OfficeArtifactToolProjection[]>
  restoreVersion(params: { userId: string; artifactId: string; targetVersionId: string; expectedVersion: number; summary: string }): Promise<{ id: string; version: number } | null>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  listVersions(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>>
  canRestore(userId: string, artifactId: string): Promise<boolean>
}

const CreateSchema = z.object({
  workspaceId: z.string().uuid(),
  assistantId: z.string().uuid(),
  family: z.enum(['document', 'presentation']),
  outcome: z.string().min(1).max(4_000),
  audience: z.string().min(1).max(1_000),
  sourceHandles: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  templateId: z.string().uuid().optional(),
  canonicalWebsite: z.string().url().refine((url) => url.startsWith('https:')).optional(),
  companyHasNoWebsite: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(255),
}).strict()

export function officeArtifactRoutes(deps: OfficeArtifactsRouteDeps): Router {
  const router = Router()
  router.get('/artifacts', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = z.string().uuid().safeParse(req.query.workspaceId)
    const view = z.enum(['active', 'archived', 'trash']).catch('active').parse(req.query.view)
    if (!workspaceId.success) return void res.status(400).json({ error: 'workspaceId must be a UUID' })
    res.json({ artifacts: await deps.list(userId, workspaceId.data, view) })
  })

  router.post('/artifacts', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = CreateSchema.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office creation request', issues: body.error.issues })
    const created = await deps.service.create({ userId, ...body.data })
    res.status(202).json(created)
  })

  router.get('/artifacts/:artifactId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifact = await deps.service.get({ userId, artifactId: String(req.params.artifactId) })
    if (!artifact) return void res.status(404).json({ error: 'Office artifact not found' })
    res.json({ artifact })
  })

  router.get('/artifacts/:artifactId/versions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    if (!await deps.getArtifact(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    res.json({ versions: await deps.listVersions(userId, artifactId) })
  })

  router.post('/artifacts/:artifactId/restore', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ targetVersionId: z.string().uuid(), expectedVersion: z.number().int().min(0), summary: z.string().min(1).max(1_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid restore request', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    if (!await deps.canRestore(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    const restored = await deps.restoreVersion({ userId, artifactId, ...body.data })
    if (!restored) return void res.status(409).json({ error: 'version_conflict' })
    res.json({ version: restored })
  })

  return router
}
