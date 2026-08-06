/** Signed complete-package and reconnect fallback routes. [COMP:api/office-routes] */
import { createHash, createHmac } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { OfficeCommandSchema, type OfficeArtifactSnapshot, type OfficeCommand } from '@use-brian/office-model'
import { officeGoldenSerialization } from '@use-brian/core'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { ResolvedOfficeAccess } from '../office/access.js'

export type OfficeOfflineRouteDeps = {
  signingSecret: string
  load(userId: string, artifactId: string): Promise<{ artifact: OfficeArtifactRow; access: ResolvedOfficeAccess; snapshot: OfficeArtifactSnapshot; update: Uint8Array; stateVector: Uint8Array; seq: number; comments: unknown[]; history: unknown[] } | null>
  readResource(userId: string, workspaceId: string, resourceId: string): Promise<{ bytes: Uint8Array; mime: string; hash: string } | null>
  savePackage(params: { userId: string; workspaceId: string; artifactId: string; deviceId: string; bytes: Uint8Array }): Promise<string>
  upsert(params: { userId: string; artifactId: string; versionId: string; workspaceId: string; deviceId: string; packageFileId: string; manifest: unknown; manifestHash: string; signature: string; stateVector: Uint8Array; pinned: boolean }): Promise<unknown>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  appendCommand(params: { userId: string; artifactId: string; expectedSeq: number; command: OfficeCommand }): Promise<{ snapshot: OfficeArtifactSnapshot; seq: number; baseVersion: number } | 'conflict' | null>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}

export function officeOfflineRoutes(deps: OfficeOfflineRouteDeps): Router {
  const router = Router()
  router.get('/artifacts/:artifactId/resources/:resourceId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    const resourceId = String(req.params.resourceId)
    const context = await deps.load(userId, artifactId)
    if (!context) return void res.status(404).json({ error: 'Office resource not found' })
    const ref = context.snapshot.resources.find((resource) => resource.id === resourceId)
    if (!ref) return void res.status(404).json({ error: 'Office resource not found' })
    const resource = await deps.readResource(userId, context.artifact.workspaceId, resourceId)
    const bytesHash = resource ? createHash('sha256').update(resource.bytes).digest('hex') : null
    if (!resource || resource.hash !== ref.hash || bytesHash !== ref.hash) {
      return void res.status(409).json({ error: 'office_resource_incomplete', resourceId })
    }
    const etag = `"${ref.hash}"`
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('Content-Type', ref.mime)
    res.setHeader('Content-Length', resource.bytes.byteLength)
    res.setHeader('ETag', etag)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers['if-none-match'] === etag) return void res.status(304).end()
    res.send(Buffer.from(resource.bytes))
  })
  router.post('/artifacts/:artifactId/offline-packages', async (req, res) => {
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
    for (const ref of context.snapshot.resources) {
      const resource = await deps.readResource(userId, context.artifact.workspaceId, ref.id)
      if (!resource || resource.hash !== ref.hash) return void res.status(409).json({ error: 'offline_resource_incomplete', resourceId: ref.id })
      resources.push({ id: ref.id, mime: resource.mime, hash: resource.hash, bytes: Buffer.from(resource.bytes).toString('base64') })
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
    const packageFileId = await deps.savePackage({ userId, workspaceId: context.artifact.workspaceId, artifactId, deviceId: body.data.deviceId, bytes })
    const record = await deps.upsert({ userId, artifactId, versionId: context.artifact.headVersionId, workspaceId: context.artifact.workspaceId, deviceId: body.data.deviceId, packageFileId, manifest, manifestHash, signature, stateVector: context.stateVector, pinned: body.data.pinned })
    res.status(201).json({ record, manifest, signature, payload })
  })
  router.post('/artifacts/:artifactId/offline-sync', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ expectedSeq: z.number().int().min(0), commands: z.array(OfficeCommandSchema).max(10_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office offline sync', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const access = await deps.resolveAccess(userId, artifactId)
    if (!access || !access.canEdit) return void res.status(409).json({ status: 'needs_attention', reason: 'access_revoked', quarantine: true })
    let seq = body.data.expectedSeq
    let snapshot: OfficeArtifactSnapshot | undefined
    for (const command of body.data.commands) {
      const applied = await deps.appendCommand({ userId, artifactId, expectedSeq: seq, command })
      if (applied === 'conflict') return void res.status(409).json({ status: 'needs_attention', reason: 'structural_conflict', changeSet: { commands: body.data.commands, expectedSeq: body.data.expectedSeq } })
      if (!applied) return void res.status(404).json({ error: 'Office artifact not found' })
      seq = applied.seq
      snapshot = applied.snapshot
    }
    res.json({ status: 'synced', seq, snapshot })
  })
  return router
}
