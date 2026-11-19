/** Shared in both editions. No provider calls. [COMP:feed/post-working-copies] */
import { Router } from 'express'
import { z } from 'zod'
import { parsePostMedia } from '../content-planning/media.js'
import { postWorkingCopiesStore, WorkingCopyError, type WorkingCopyInput } from '../db/post-working-copies.js'
import { resolvePlanningAccess } from './content-planning.js'

const uuid = z.string().uuid()
const inputSchema = z.object({
  revision: z.number().int().min(0).max(2_000_000_000),
  mutationId: uuid,
  baseTitle: z.string().max(240).optional(),
  create: z.object({ platform: z.enum(['instagram', 'threads', 'twitter', 'xhs', 'linkedin', 'email']) }).optional(),
  content: z.object({
    sourceSensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
    sourceCompartments: z.array(z.string()).max(100).optional(), sourceProjectIds: z.array(uuid).max(100).optional(),
    sourceFileIds: z.array(uuid).max(1000).optional(), sourceMemoryIds: z.array(uuid).max(1000).optional(),
    selectedMemoryIds: z.array(uuid).max(100).optional(),
    title: z.string().max(200), privateBrief: z.string().max(20_000),
    text: z.string().max(100_000), textEdited: z.boolean().optional(), postFormat: z.enum(['post', 'thread', 'article']),
    threadSegments: z.array(z.string().max(100_000)).max(100),
    article: z.object({ sourceUrl: z.string().max(2048), title: z.string().max(2000), description: z.string().max(20_000) }),
    media: z.array(z.unknown()).max(20),
  }),
})

export function postWorkingCopiesRoutes(options: {
  store?: typeof postWorkingCopiesStore
  resolveAccess?: typeof resolvePlanningAccess
} = {}): Router {
  const router = Router()
  const store = options.store ?? postWorkingCopiesStore
  const access = options.resolveAccess ?? resolvePlanningAccess
  const path = '/:assistantId/post-working-copies/:sessionId'
  router.all<{ assistantId: string; sessionId: string }>(path, async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'PUT') { next(); return }
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!uuid.safeParse(req.params.sessionId).success) { res.status(400).json({ error: 'Invalid session id' }); return }
    try {
      const ctx = await access(req.userId, req.params.assistantId)
      if (!ctx || (req.method === 'PUT' && !ctx.canDraft)) {
        res.status(403).json({ error: 'Draft access required' }); return
      }
      if (req.method === 'GET') {
        res.json({ copy: await store.get(req.params.assistantId, req.params.sessionId, req.userId) }); return
      }
      const parsed = inputSchema.safeParse(req.body)
      const media = parsed.success ? parsePostMedia(parsed.data.content.media) : null
      if (!parsed.success || !media?.ok) {
        res.status(400).json({ error: 'Invalid working copy' }); return
      }
      const input: WorkingCopyInput = { ...parsed.data, content: { ...parsed.data.content, media: media.media } }
      const copy = await store.put(req.params.assistantId, req.params.sessionId, req.userId, input)
      res.json({ copy })
    } catch (error) {
      if (error instanceof WorkingCopyError) res.status(error.status).json({ error: error.message })
      else { console.error('[post-working-copies] request failed', error); res.status(500).json({ error: 'Working copy unavailable' }) }
    }
  })
  return router
}
