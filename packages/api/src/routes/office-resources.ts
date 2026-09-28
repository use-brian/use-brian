/** Authorized Office resource admission and reads. [COMP:api/office-resources] */
import { createHash } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  MAX_OFFICE_IMAGE_BYTES,
  normalizeOfficeImageResource,
  type NormalizedOfficeImage,
} from '@use-brian/core'
import {
  OfficeResourceRefSchema,
  type OfficeArtifactSnapshot,
  type OfficeResourceRef,
} from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { ResolvedOfficeAccess } from '../office/access.js'
import { classifyOfficeOutput, sameOfficeFileBinding, type OfficeFileBinding, type OfficeOutputScope } from '../office/file-binding.js'

type ResourceContext = {
  artifact: OfficeArtifactRow
  access: ResolvedOfficeAccess
  snapshot: OfficeArtifactSnapshot
}

export type OfficeResourceRouteDeps = {
  load(userId: string, artifactId: string): Promise<ResourceContext | null>
  readUpload(userId: string, workspaceId: string, fileId: string): Promise<{ bytes: Uint8Array; binding: OfficeFileBinding; validForMs: number } | null>
  normalizeImage?(bytes: Uint8Array): Promise<NormalizedOfficeImage>
  persistImage(params: {
    userId: string
    workspaceId: string
    artifactId: string
    scope: OfficeOutputScope
    image: NormalizedOfficeImage
  }): Promise<{ id: string; sensitivity?: OfficeArtifactRow['sensitivity'] }>
  readResource(userId: string, workspaceId: string, resourceId: string): Promise<{ bytes: Uint8Array; mime: string; hash: string; validForMs: number; binding: OfficeFileBinding } | null>
}

const Admission = z.object({ fileId: z.string().uuid(), kind: z.literal('image') }).strict()

export function officeResourceRoutes(deps: OfficeResourceRouteDeps): Router {
  const router = Router()

  router.get('/artifacts/:artifactId/resources/:resourceId', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const artifactId = String(req.params.artifactId)
    const resourceId = String(req.params.resourceId)
    const context = await deps.load(userId, artifactId)
    if (!context || (req.query.workspaceId !== undefined && req.query.workspaceId !== context.artifact.workspaceId)) return void res.status(404).json({ error: 'Office resource not found' })
    const ref = context.snapshot.resources.find((resource) => resource.id === resourceId)
    if (!ref) return void res.status(404).json({ error: 'Office resource not found' })
    const referenceRevision = JSON.stringify(ref)
    const started = performance.now()
    const resource = await deps.readResource(userId, context.artifact.workspaceId, resourceId)
    const current = await deps.load(userId, artifactId)
    const currentRef = current?.snapshot.resources.find((entry) => entry.id === resourceId)
    if (!resource || !current || current.artifact.workspaceId !== context.artifact.workspaceId ||
      !currentRef || JSON.stringify(currentRef) !== referenceRevision) {
      return void res.status(404).json({ error: 'Office resource not found' })
    }
    const validForMs = Math.floor(Math.min(30_000, resource.validForMs) - (performance.now() - started))
    if (!Number.isFinite(validForMs) || validForMs <= 0) return void res.status(404).json({ error: 'Office resource not found' })
    const bytesHash = createHash('sha256').update(resource.bytes).digest('hex')
    if (resource.hash !== ref.hash || bytesHash !== ref.hash || resource.mime !== ref.mime) {
      return void res.status(409).json({ error: 'office_resource_incomplete', resourceId })
    }
    res.setHeader('X-Brian-Media-Valid-For-Ms', String(validForMs))
    res.append('Access-Control-Expose-Headers', 'X-Brian-Media-Valid-For-Ms')
    res.setHeader('Content-Type', ref.mime)
    res.setHeader('Content-Length', resource.bytes.byteLength)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Bypass Express's automatic ETag/304 handling for protected bytes.
    res.end(Buffer.from(resource.bytes))
  })

  router.post('/artifacts/:artifactId/resources', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = Admission.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'office_resource_request_invalid', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const context = await deps.load(userId, artifactId)
    if (!context) return void res.status(404).json({ error: 'Office artifact not found' })
    if (context.artifact.lifecycleState !== 'active') return void res.status(409).json({ error: 'office_artifact_inactive' })
    if (!context.access.canEdit) return void res.status(403).json({ error: 'office_edit_required' })
    const contextRevision = admissionContextRevision(context)
    const upload = await deps.readUpload(userId, context.artifact.workspaceId, body.data.fileId)
    if (!upload) return void res.status(404).json({ error: 'office_image_source_unavailable' })
    if (upload.bytes.byteLength > MAX_OFFICE_IMAGE_BYTES) return void res.status(413).json({ error: 'office_image_too_large' })
    let image: NormalizedOfficeImage
    try {
      image = await (deps.normalizeImage ?? normalizeOfficeImageResource)(upload.bytes)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'office_image_invalid'
      if (code === 'office_image_too_large') return void res.status(413).json({ error: code })
      return void res.status(415).json({ error: code === 'office_image_unsupported' ? code : 'office_image_invalid' })
    }
    const [sourceBeforePublish, current] = await Promise.all([
      deps.readUpload(userId, context.artifact.workspaceId, body.data.fileId),
      deps.load(userId, artifactId),
    ])
    if (!sourceBeforePublish || !sameOfficeFileBinding(upload.binding, sourceBeforePublish.binding) ||
      !current || !current.access.canEdit || current.artifact.lifecycleState !== 'active' ||
      admissionContextRevision(current) !== contextRevision) {
      return void res.status(409).json({ error: 'office_projection_changed' })
    }
    const scope = classifyOfficeOutput({
      sensitivity: context.artifact.sensitivity,
      compartments: context.artifact.compartments,
      projectIds: context.artifact.projectIds,
    }, upload.binding)
    const persisted = await deps.persistImage({
      userId,
      workspaceId: context.artifact.workspaceId,
      artifactId,
      scope,
      image,
    })
    const [sourceAfterPublish, published, finalContext] = await Promise.all([
      deps.readUpload(userId, context.artifact.workspaceId, body.data.fileId),
      deps.readResource(userId, context.artifact.workspaceId, persisted.id),
      deps.load(userId, artifactId),
    ])
    if (!sourceAfterPublish || !sameOfficeFileBinding(upload.binding, sourceAfterPublish.binding) ||
      !published || published.hash !== image.hash || published.mime !== image.mime ||
      !finalContext || admissionContextRevision(finalContext) !== contextRevision) {
      return void res.status(409).json({ error: 'office_projection_changed' })
    }
    const validForMs = Math.floor(Math.min(sourceAfterPublish.validForMs, published.validForMs))
    if (!Number.isFinite(validForMs) || validForMs <= 0) return void res.status(404).json({ error: 'Office resource not found' })
    const resource: OfficeResourceRef = OfficeResourceRefSchema.parse({
      id: persisted.id,
      kind: 'image',
      hash: image.hash,
      mime: image.mime,
      sensitivity: persisted.sensitivity ?? scope.sensitivity,
    })
    res.setHeader('X-Brian-Media-Valid-For-Ms', String(Math.min(30_000, validForMs)))
    res.append('Access-Control-Expose-Headers', 'X-Brian-Media-Valid-For-Ms')
    res.status(201).json({ resource, widthPx: image.widthPx, heightPx: image.heightPx })
  })

  return router
}

function admissionContextRevision(context: ResourceContext): string {
  return JSON.stringify({ artifact: context.artifact, access: context.access, snapshot: context.snapshot })
}
