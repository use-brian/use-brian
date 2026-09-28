/** Authenticated PDF editing-session routes. [COMP:api/office-pdf-routes] */
import { Router } from 'express'
import { z } from 'zod'
import { PdfSessionServiceError, type PdfSessionService } from '../office/pdf-session-service.js'

const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file_cache'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('workspace_file'), id: z.string().uuid() }).strict(),
])

const Create = z.object({
  workspaceId: z.string().uuid(),
  source: Source,
  signatureSource: Source.optional(),
  title: z.string().min(1).max(1_000),
  sensitivity: z.enum(['public', 'internal', 'confidential']).default('internal'),
  idempotencyKey: z.string().min(8).max(255),
  locale: z.string().min(2).max(35).optional(),
}).strict()

const AttachSignature = z.object({
  source: Source,
  expectedSeq: z.number().int().positive(),
}).strict()

const SaveToFiles = z.object({
  expectedSeq: z.number().int().positive(),
  releaseHash: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1).max(1_024).refine((path) => path.startsWith('/') && !path.startsWith('/office/sessions/')),
}).strict()

function userId(req: unknown): string | null {
  return (req as { userId?: string }).userId ?? null
}

function sendError(res: { status(code: number): { json(value: unknown): void } }, error: unknown): void {
  if (error instanceof PdfSessionServiceError) {
    res.status(error.status).json({ error: error.code, message: error.message })
    return
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    res.status(400).json({ error: error.code, message: error instanceof Error ? error.message : 'The PDF request failed.' })
    return
  }
  throw error
}

export function officePdfSessionRoutes(deps: { service: PdfSessionService }): Router {
  const router = Router()

  router.post('/pdf-sessions', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const owner = userId(req)
    if (!owner) return void res.status(401).json({ error: 'Unauthorized' })
    const body = Create.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'invalid_pdf_session_request', message: 'Check the PDF session details and try again.', issues: body.error.issues })
    try {
      res.status(201).json(await deps.service.create({ userId: owner, ...body.data }))
    } catch (error) { sendError(res, error) }
  })

  router.post('/artifacts/:artifactId/pdf/signature-assets', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const owner = userId(req)
    if (!owner) return void res.status(401).json({ error: 'Unauthorized' })
    const body = AttachSignature.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'invalid_signature_request', message: 'Choose a PNG or JPEG signature image and try again.' })
    try {
      res.status(201).json(await deps.service.attachSignature({ userId: owner, artifactId: String(req.params.artifactId), ...body.data }))
    } catch (error) { sendError(res, error) }
  })

  router.get('/artifacts/:artifactId/pdf/source', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    const owner = userId(req)
    if (!owner) return void res.status(401).json({ error: 'Unauthorized' })
    try {
      const artifactId = String(req.params.artifactId)
      const [{ session }, source] = await Promise.all([
        deps.service.get(owner, artifactId),
        deps.service.readSource(owner, artifactId),
      ])
      res.setHeader('X-Brian-Media-Valid-For-Ms', String(Math.max(1, Math.min(30_000, session.expiresAt.getTime() - Date.now()))))
      res.append('Access-Control-Expose-Headers', 'X-Brian-Media-Valid-For-Ms')
      res.type('application/pdf').send(Buffer.from(source.bytes))
    } catch (error) { sendError(res, error) }
  })

  router.post('/artifacts/:artifactId/pdf/save-to-files', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const owner = userId(req)
    if (!owner) return void res.status(401).json({ error: 'Unauthorized' })
    const body = SaveToFiles.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'invalid_save_request', message: 'Choose a valid workspace path and fresh flattened PDF.' })
    try {
      res.status(201).json(await deps.service.saveToFiles({ userId: owner, artifactId: String(req.params.artifactId), ...body.data }))
    } catch (error) { sendError(res, error) }
  })

  return router
}
