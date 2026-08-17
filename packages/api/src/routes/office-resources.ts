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

type ResourceContext = {
  artifact: OfficeArtifactRow
  access: ResolvedOfficeAccess
  snapshot: OfficeArtifactSnapshot
}

export type OfficeResourceRouteDeps = {
  load(userId: string, artifactId: string): Promise<ResourceContext | null>
  readUpload(userId: string, workspaceId: string, fileId: string): Promise<{ bytes: Uint8Array; sensitivity: OfficeArtifactRow['sensitivity'] } | null>
  normalizeImage?(bytes: Uint8Array): Promise<NormalizedOfficeImage>
  persistImage(params: {
    userId: string
    workspaceId: string
    artifactId: string
    sensitivity: OfficeArtifactRow['sensitivity']
    image: NormalizedOfficeImage
  }): Promise<{ id: string; sensitivity?: OfficeArtifactRow['sensitivity'] }>
  readResource(userId: string, workspaceId: string, resourceId: string): Promise<{ bytes: Uint8Array; mime: string; hash: string } | null>
}

const Admission = z.object({ fileId: z.string().uuid(), kind: z.literal('image') }).strict()

export function officeResourceRoutes(deps: OfficeResourceRouteDeps): Router {
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

  router.post('/artifacts/:artifactId/resources', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = Admission.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'office_resource_request_invalid', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const context = await deps.load(userId, artifactId)
    if (!context) return void res.status(404).json({ error: 'Office artifact not found' })
    if (context.artifact.lifecycleState !== 'active') return void res.status(409).json({ error: 'office_artifact_inactive' })
    if (!context.access.canEdit) return void res.status(403).json({ error: 'office_edit_required' })
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
    const persisted = await deps.persistImage({
      userId,
      workspaceId: context.artifact.workspaceId,
      artifactId,
      sensitivity: maxSensitivity(context.artifact.sensitivity, upload.sensitivity),
      image,
    })
    const resource: OfficeResourceRef = OfficeResourceRefSchema.parse({
      id: persisted.id,
      kind: 'image',
      hash: image.hash,
      mime: image.mime,
      sensitivity: persisted.sensitivity ?? context.artifact.sensitivity,
    })
    res.status(201).json({ resource, widthPx: image.widthPx, heightPx: image.heightPx })
  })

  return router
}

function maxSensitivity(left: OfficeArtifactRow['sensitivity'], right: OfficeArtifactRow['sensitivity']): OfficeArtifactRow['sensitivity'] {
  const rank = { public: 0, internal: 1, confidential: 2 } as const
  return rank[left] >= rank[right] ? left : right
}
