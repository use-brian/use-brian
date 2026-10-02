/** Authenticated Office artifact routes. [COMP:api/office-routes] */
import { Router } from 'express'
import { officeAuthoredShellRoutes } from './office-authored-shell.js'
import {officeMetadataRoute,sendOfficeMetadata} from './office-metadata.js'
import type {OfficeMetadataReply} from '../db/office-read-projection.js'
import { z } from 'zod'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeArtifactToolProjection } from '@use-brian/core'
import { OfficeGenerationUnavailableError, type OfficeService } from '../office/service.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { ResolvedOfficeAccess } from '../office/access.js'

export type OfficeArtifactsRouteDeps = {
  service: OfficeService
  generationAvailable(family?: 'document' | 'presentation' | 'spreadsheet'): boolean
  list(userId: string, workspaceId: string, view: 'active' | 'archived' | 'trash' | 'retained'): Promise<OfficeArtifactToolProjection[]>
  restoreVersion(params: { userId: string; artifactId: string; targetVersionId: string; expectedVersion: number; summary: string }): Promise<{ id: string; version: number } | null>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  listVersions(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>>
  previewVersion(params: { userId: string; artifactId: string; versionId: string }): Promise<OfficeArtifactSnapshot | null>
  nameVersion(params: { userId: string; artifactId: string; versionId: string; summary: string }): Promise<boolean>
  copyVersion(params: { userId: string; artifactId: string; versionId: string; title: string }): Promise<{ artifactId: string; version: number } | null>
  listSharing(userId: string, artifactId: string): Promise<
    | { status: 'ok'; workspaceId: string; validForMs: number; defaultWorkspaceRole: 'view' | 'comment' | 'edit'; grants: Array<{ userId: string; role: 'view' | 'comment' | 'edit' | 'deny'; revokedAt: Date | null }>; members: Array<{ userId: string; userName?: string | null; email?: string | null; isOwner: boolean }> }
    | { status: 'unavailable' }
    | { status: 'changed' }
  >
  setGrant(params: { userId: string; artifactId: string; targetUserId: string; role: 'view' | 'comment' | 'edit'; reason?: string }): Promise<boolean>
  revokeGrant(params: { userId: string; artifactId: string; targetUserId: string }): Promise<boolean>
  setDefaultWorkspaceRole(params: { userId: string; artifactId: string; role: 'view' | 'comment' | 'edit' }): Promise<boolean>
  canRestoreVersion(userId: string, artifactId: string): Promise<boolean>
}

const CreateSchema = z.object({
  workspaceId: z.string().uuid(),
  assistantId: z.string().uuid(),
  family: z.enum(['document', 'presentation', 'spreadsheet']),
  outcome: z.string().min(1).max(4_000),
  audience: z.string().min(1).max(1_000),
  sourceHandles: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  templateId: z.string().uuid().optional(),
  additionalContext: z.string().min(1).max(4_000).optional(),
  idempotencyKey: z.string().min(8).max(255),
}).strict()

export function officeArtifactRoutes(deps: OfficeArtifactsRouteDeps): Router {
  const router = Router()
  router.use(officeAuthoredShellRoutes())
  const versionsReply=async(userId:string,artifactId:string):Promise<OfficeMetadataReply>=>{
    const access=await deps.resolveAccess(userId,artifactId)
    if(!access)return {status:404,body:{error:'Office artifact not found'}}
    return {workspaceId:access.workspaceId,body:{versions:await deps.listVersions(userId,artifactId)}}
  }
  const sharingReply=async(userId:string,artifactId:string):Promise<OfficeMetadataReply>=>{
    const access=await deps.resolveAccess(userId,artifactId)
    if(!access)return {status:404,body:{error:'Office artifact not found'}}
    const result=await deps.listSharing(userId,artifactId)
    if(result.status==='changed')return {status:409,body:{error:'member_directory_changed'}}
    if(result.status==='unavailable')return {status:404,body:{error:'Office artifact not found'}}
    const {status:_,workspaceId,validForMs,...sharing}=result
    return {workspaceId,validForMs,body:{...sharing,canManage:access.canManageSharing}}
  }
  router.get('/capabilities', (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const generationFamilies = (['document', 'presentation', 'spreadsheet'] as const).filter((family) => deps.generationAvailable(family))
    res.json({ generationAvailable: generationFamilies.length > 0, generationFamilies })
  })

  router.get('/artifacts', officeMetadataRoute(async (req, userId) => {
    const workspaceId = z.string().uuid().safeParse(req.query.workspaceId)
    const view = z.enum(['active', 'archived', 'trash', 'retained']).catch('active').parse(req.query.view)
    if (!workspaceId.success) return {status:400,body:{ error: 'workspaceId must be a UUID' }}
    return {workspaceId:workspaceId.data,body:{ artifacts: await deps.list(userId, workspaceId.data, view) }}
  }))

  router.post('/artifacts', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = CreateSchema.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office creation request', issues: body.error.issues })
    try {
      const input = {
        userId,
        ...body.data,
        sensitivity: 'internal' as const,
        compartments: [],
        projectIds: [],
        compartmentGrant: [],
        projectGrant: null,
      }
      const admitted = req.authSessionId && req.authVersion !== undefined && deps.service.createAuthenticated
        ? await deps.service.createAuthenticated(input, {actorUserId:userId,workspaceId:body.data.workspaceId,sessionId:req.authSessionId})
        : null
      const created = admitted ?? await deps.service.create(input)
      res.setHeader('Cache-Control','no-store')
      res.status(202).json(created)
    } catch (cause) {
      if (cause instanceof WorkspaceAccessError) return void res.status(cause.status).json({error:cause.code})
      if (cause instanceof OfficeGenerationUnavailableError) return void res.status(503).json({ error: cause.code })
      throw cause
    }
  })

  router.get('/artifacts/:artifactId', officeMetadataRoute(async (req, userId) => {
    const artifact = await deps.service.get({ userId, artifactId: String(req.params.artifactId) })
    if (!artifact) return {status:404,body:{ error: 'Office artifact not found' }}
    const root = await deps.getArtifact(userId, String(req.params.artifactId))
    if (!root) return {status:404,body:{error:'Office artifact not found'}}
    return {workspaceId:root.workspaceId,body:{artifact}}
  }))

  router.get('/artifacts/:artifactId/versions', officeMetadataRoute((req,userId)=>versionsReply(userId,String(req.params.artifactId))))

  router.get('/artifacts/:artifactId/versions/:versionId/preview', officeMetadataRoute(async (req,userId) => {
    const artifactId = String(req.params.artifactId)
    const access=await deps.resolveAccess(userId,artifactId)
    if(!access)return {status:404,body:{error:'Office artifact not found'}}
    const snapshot = await deps.previewVersion({ userId, artifactId, versionId: String(req.params.versionId) })
    if(!snapshot)return {status:404,body:{error:'Office version not found'}}
    return {workspaceId:access.workspaceId,body:{snapshot}}
  }))

  router.patch('/artifacts/:artifactId/versions/:versionId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ summary: z.string().min(1).max(1_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid version name' })
    const artifactId = String(req.params.artifactId)
    if (!(await deps.resolveAccess(userId, artifactId))?.canEdit) return void res.status(404).json({ error: 'Office artifact not found' })
    if (!await deps.nameVersion({ userId, artifactId, versionId: String(req.params.versionId), summary: body.data.summary })) return void res.status(404).json({ error: 'Office version not found' })
    await sendOfficeMetadata(res,userId,()=>versionsReply(userId,artifactId))
  })

  router.post('/artifacts/:artifactId/versions/:versionId/copy', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ title: z.string().min(1).max(1_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid copy request' })
    const artifactId = String(req.params.artifactId)
    if (!await deps.resolveAccess(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    const copied = await deps.copyVersion({ userId, artifactId, versionId: String(req.params.versionId), title: body.data.title })
    if (!copied) return void res.status(404).json({ error: 'Office version not found' })
    await sendOfficeMetadata(res,userId,async()=>{
      const [artifact,root]=await Promise.all([deps.service.get({userId,artifactId:copied.artifactId}),deps.getArtifact(userId,copied.artifactId)])
      if(!artifact||!root)return {status:404,body:{error:'Office artifact not found'}}
      return {status:201,workspaceId:root.workspaceId,body:{...copied,artifact}}
    })
  })

  router.get('/artifacts/:artifactId/sharing',officeMetadataRoute((req,userId)=>sharingReply(userId,String(req.params.artifactId))))

  router.put('/artifacts/:artifactId/sharing/:targetUserId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ role: z.enum(['view','comment','edit']), reason: z.string().min(1).max(1_000).optional() }).strict().safeParse(req.body)
    const targetUserId = z.string().uuid().safeParse(req.params.targetUserId)
    if (!body.success || !targetUserId.success) return void res.status(400).json({ error: 'Invalid sharing request' })
    const artifactId = String(req.params.artifactId)
    if (!(await deps.resolveAccess(userId, artifactId))?.canManageSharing) return void res.status(404).json({ error: 'Office artifact not found' })
    if (!await deps.setGrant({ userId, artifactId, targetUserId: targetUserId.data, ...body.data })) return void res.status(404).json({ error: 'Workspace member not found' })
    await sendOfficeMetadata(res,userId,()=>sharingReply(userId,artifactId))
  })

  router.delete('/artifacts/:artifactId/sharing/:targetUserId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const targetUserId = z.string().uuid().safeParse(req.params.targetUserId)
    if (!targetUserId.success) return void res.status(400).json({ error: 'Invalid sharing request' })
    const artifactId = String(req.params.artifactId)
    if (!(await deps.resolveAccess(userId, artifactId))?.canManageSharing) return void res.status(404).json({ error: 'Office artifact not found' })
    if (!await deps.revokeGrant({ userId, artifactId, targetUserId: targetUserId.data })) return void res.status(404).json({ error: 'Workspace member not found' })
    await sendOfficeMetadata(res,userId,()=>sharingReply(userId,artifactId))
  })

  router.patch('/artifacts/:artifactId/sharing', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ defaultWorkspaceRole: z.enum(['view','comment','edit']) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid default role' })
    const artifactId = String(req.params.artifactId)
    if (!(await deps.resolveAccess(userId, artifactId))?.canManageSharing) return void res.status(404).json({ error: 'Office artifact not found' })
    if (!await deps.setDefaultWorkspaceRole({ userId, artifactId, role: body.data.defaultWorkspaceRole })) return void res.status(404).json({ error: 'Office artifact not found' })
    await sendOfficeMetadata(res,userId,()=>sharingReply(userId,artifactId))
  })

  router.post('/artifacts/:artifactId/restore', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ targetVersionId: z.string().uuid(), expectedVersion: z.number().int().min(0), summary: z.string().min(1).max(1_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid restore request', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    if (!await deps.canRestoreVersion(userId, artifactId)) return void res.status(404).json({ error: 'Office artifact not found' })
    const restored = await deps.restoreVersion({ userId, artifactId, ...body.data })
    if (!restored) return void res.status(409).json({ error: 'version_conflict' })
    await sendOfficeMetadata(res,userId,async()=>{
      const reply=await versionsReply(userId,artifactId)
      if((reply.status??200)>=400)return reply
      return {...reply,body:{version:restored,...reply.body as {versions:unknown[]}}}
    })
  })

  return router
}
