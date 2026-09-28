/** Signed complete-package and reconnect fallback routes. [COMP:api/office-routes] */
import { createHash, createHmac } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { OfficeArtifactSnapshotSchema, OfficeCommandSchema, type OfficeArtifactSnapshot, type OfficeCommand } from '@use-brian/office-model'
import { officeGoldenSerialization } from '@use-brian/core'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { ResolvedOfficeAccess } from '../office/access.js'
import type { OfficeFileBinding, OfficeOutputScope } from '../office/file-binding.js'

export type OfficeOfflineContext = {
  artifact: OfficeArtifactRow
  access: ResolvedOfficeAccess
  snapshot: OfficeArtifactSnapshot
  update: Uint8Array
  stateVector: Uint8Array
  seq: number
  comments: unknown[]
  history: unknown[]
  validForMs: number
}

export type OfficeOfflineRouteDeps = {
  signingSecret: string
  load(userId: string, artifactId: string): Promise<OfficeOfflineContext | null>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  readResource(userId: string, workspaceId: string, resourceId: string): Promise<{ bytes: Uint8Array; mime: string; hash: string; validForMs: number; binding: OfficeFileBinding } | null>
  revalidatePackage(params: { userId: string; expected: OfficeOfflineContext; resourceBindings: OfficeFileBinding[]; packageFileId?: string; packageHash?: string }): Promise<{ scope: OfficeOutputScope; validForMs: number } | null>
  savePackage(params: { userId: string; workspaceId: string; artifactId: string; deviceId: string; bytes: Uint8Array; hash: string; scope: OfficeOutputScope }): Promise<string>
  upsert(params: { userId: string; artifactId: string; versionId: string; workspaceId: string; deviceId: string; packageFileId: string; manifest: unknown; manifestHash: string; signature: string; stateVector: Uint8Array; pinned: boolean }): Promise<unknown>
  getPackage(userId: string, artifactId: string, deviceId: string): Promise<{ artifactVersionId: string; packageFileId: string; manifestHash: string; complete: boolean; revokedAt: Date | null } | null>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  syncCommands(params: { userId: string; artifactId: string; expectedSeq: number; commands: OfficeCommand[] }): Promise<{ snapshot: OfficeArtifactSnapshot; seq: number; baseVersion: number } | 'conflict' | null>
  createRecovery(params: { userId: string; artifactId: string; sourceVersionId: string; title: string; snapshot: OfficeArtifactSnapshot }): Promise<{ artifactId: string } | null>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}

function attributeOfflineCommand(input: OfficeCommand, userId: string): OfficeCommand {
  const command = OfficeCommandSchema.parse(input)
  return OfficeCommandSchema.parse({
    ...command,
    actor: { type: 'user', id: userId },
    origin: 'offline',
    ...(command.kind === 'batch' ? { commands: command.commands.map(child => attributeOfflineCommand(child, userId)) } : {}),
  })
}

export function officeOfflineRoutes(deps: OfficeOfflineRouteDeps): Router {
  const router = Router()
  router.post('/artifacts/:artifactId/offline-packages', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ deviceId: z.string().min(8).max(255), pinned: z.boolean().default(false), expectedVersion: z.number().int().min(0) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office offline package request', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const context = await deps.load(userId, artifactId)
    if (!context) return void res.status(404).json({ error: 'Office artifact not found' })
    if (context.artifact.lifecycleState !== 'active') return void res.status(409).json({ error: 'offline_package_requires_active_artifact' })
    if (!context.artifact.headVersionId || context.artifact.headVersion !== body.data.expectedVersion) return void res.status(409).json({ error: 'version_head_changed' })
    const resources: Array<{ id: string; mime: string; hash: string; bytes: string }> = []
    const resourceBindings: OfficeFileBinding[] = []
    for (const ref of context.snapshot.resources) {
      const resource = await deps.readResource(userId, context.artifact.workspaceId, ref.id)
      if (!resource || resource.hash !== ref.hash || resource.mime !== ref.mime) return void res.status(409).json({ error: 'offline_resource_incomplete', resourceId: ref.id })
      resources.push({ id: ref.id, mime: resource.mime, hash: resource.hash, bytes: Buffer.from(resource.bytes).toString('base64') })
      resourceBindings.push(resource.binding)
    }
    const renderedFallback = officeGoldenSerialization(context.snapshot)
    const payload = {
      artifact: {
        artifactId,
        family: context.artifact.family,
        mode: context.artifact.mode,
        title: context.artifact.title,
        version: context.artifact.headVersion,
        lifecycleState: context.artifact.lifecycleState,
        role: context.access.role,
      },
      snapshot: context.snapshot,
      seq: context.seq,
      baseVersion: context.artifact.headVersion,
      yjsUpdate: Buffer.from(context.update).toString('base64'),
      comments: context.comments,
      history: context.history,
      renderedFallback,
      resources,
    }
    const manifest = { schemaVersion: 1, artifactId, artifactVersionId: context.artifact.headVersionId, version: context.artifact.headVersion, generatedAt: new Date().toISOString(), snapshotHash: createHash('sha256').update(canonical(context.snapshot)).digest('hex'), updateHash: createHash('sha256').update(context.update).digest('hex'), fallbackHash: createHash('sha256').update(renderedFallback).digest('hex'), resourceHashes: resources.map((resource) => ({ id: resource.id, hash: resource.hash })), commentCount: context.comments.length, historyCount: context.history.length }
    const manifestHash = createHash('sha256').update(canonical(manifest)).digest('hex')
    const signature = createHmac('sha256', deps.signingSecret).update(manifestHash).digest('hex')
    const bytes = new TextEncoder().encode(JSON.stringify({ manifest, signature, payload }))
    const packageHash = createHash('sha256').update(bytes).digest('hex')
    const beforeWrite = await deps.revalidatePackage({ userId, expected: context, resourceBindings })
    if (!beforeWrite) return void res.status(409).json({ error: 'office_projection_changed' })
    const packageFileId = await deps.savePackage({ userId, workspaceId: context.artifact.workspaceId, artifactId, deviceId: body.data.deviceId, bytes, hash: packageHash, scope: beforeWrite.scope })
    const beforeRecord = await deps.revalidatePackage({ userId, expected: context, resourceBindings, packageFileId, packageHash })
    if (!beforeRecord) return void res.status(409).json({ error: 'office_projection_changed' })
    const record = await deps.upsert({ userId, artifactId, versionId: context.artifact.headVersionId, workspaceId: context.artifact.workspaceId, deviceId: body.data.deviceId, packageFileId, manifest, manifestHash, signature, stateVector: context.stateVector, pinned: body.data.pinned })
    const [published, savedRecord] = await Promise.all([
      deps.revalidatePackage({ userId, expected: context, resourceBindings, packageFileId, packageHash }),
      deps.getPackage(userId, artifactId, body.data.deviceId),
    ])
    if (!published || !savedRecord?.complete || savedRecord.revokedAt || savedRecord.artifactVersionId !== context.artifact.headVersionId || savedRecord.packageFileId !== packageFileId || savedRecord.manifestHash !== manifestHash) {
      return void res.status(409).json({ error: 'office_projection_changed' })
    }
    res.setHeader('X-Brian-Media-Valid-For-Ms', String(Math.min(30_000, published.validForMs)))
    res.append('Access-Control-Expose-Headers', 'X-Brian-Media-Valid-For-Ms')
    res.status(201).json({ record, manifest, signature, payload })
  })
  router.post('/artifacts/:artifactId/offline-sync', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({
      expectedSeq: z.number().int().min(0),
      commands: z.array(OfficeCommandSchema).max(10_000),
      deviceId: z.string().min(8).max(255),
      recoveryTitle: z.string().trim().min(1).max(1000),
      recoverySnapshot: OfficeArtifactSnapshotSchema,
    }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office offline sync', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const [access, artifact] = await Promise.all([deps.resolveAccess(userId, artifactId), deps.getArtifact(userId, artifactId)])
    if (!access?.canEdit || !artifact || artifact.lifecycleState !== 'active') return void res.status(409).json({ status: 'needs_attention', reason: 'access_revoked', quarantine: true })
    if (body.data.recoverySnapshot.artifactId !== artifactId || body.data.recoverySnapshot.workspaceId !== artifact.workspaceId || body.data.recoverySnapshot.family !== artifact.family) {
      return void res.status(400).json({ error: 'Invalid Office recovery snapshot' })
    }
    const commands = body.data.commands.map(command => attributeOfflineCommand(command, userId))
    const applied = await deps.syncCommands({ userId, artifactId, expectedSeq: body.data.expectedSeq, commands })
    if (applied === 'conflict') {
      const savedPackage = await deps.getPackage(userId, artifactId, body.data.deviceId)
      const recovery = savedPackage?.complete && !savedPackage.revokedAt
        ? await deps.createRecovery({ userId, artifactId, sourceVersionId: savedPackage.artifactVersionId, title: body.data.recoveryTitle, snapshot: body.data.recoverySnapshot })
        : null
      if (recovery) return void res.status(409).json({ status: 'needs_attention', reason: 'structural_conflict', recoveryArtifactId: recovery.artifactId })
      const current = await deps.resolveAccess(userId, artifactId)
      return void res.status(409).json(current?.canEdit
        ? { status: 'sync_failed', reason: 'recovery_publication_failed' }
        : { status: 'needs_attention', reason: 'access_revoked', quarantine: true })
    }
    if (!applied) {
      const current = await deps.resolveAccess(userId, artifactId)
      return void res.status(current?.canEdit ? 404 : 409).json(current?.canEdit
        ? { error: 'Office artifact not found' }
        : { status: 'needs_attention', reason: 'access_revoked', quarantine: true })
    }
    const current = await deps.resolveAccess(userId, artifactId)
    if (!current?.canEdit) return void res.status(409).json({ status: 'needs_attention', reason: 'access_revoked', quarantine: true })
    res.json({ status: 'synced', seq: applied.seq })
  })
  return router
}

export function officeOfflineContextRevision(context: OfficeOfflineContext): string {
  return JSON.stringify({
    artifact: context.artifact,
    access: context.access,
    snapshot: context.snapshot,
    update: Buffer.from(context.update).toString('base64'),
    stateVector: Buffer.from(context.stateVector).toString('base64'),
    seq: context.seq,
    comments: context.comments,
    history: context.history,
  })
}
