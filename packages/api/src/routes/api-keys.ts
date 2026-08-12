/**
 * Edition-neutral per-assistant API key management.
 * [COMP:api/integrations-api-keys]
 */
import { Router } from 'express'
import { z } from 'zod'
import type { ApiKeyStore } from '../db/api-key-store.js'

type AssistantParams = { assistantId: string }

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(['chat', 'agent']).default('chat'),
  audience: z.enum(['external', 'internal']).default('external'),
  anonymousContext: z.enum(['thin', 'full']).default('thin'),
}).strict()

export function apiKeyRoutes(store: ApiKeyStore): Router {
  const router = Router({ mergeParams: true })

  router.post<AssistantParams>('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid input', detail: parsed.error.message }); return }
    if (parsed.data.audience === 'internal' && parsed.data.anonymousContext === 'full') {
      res.status(400).json({
        error: 'Invalid input',
        detail: 'anonymousContext "full" applies to external-audience keys only',
      })
      return
    }
    try {
      const created = await store.create({
        assistantId: req.params.assistantId,
        name: parsed.data.name,
        actingUserId: userId,
        scope: parsed.data.scope,
        audience: parsed.data.audience,
        anonymousContext: parsed.data.anonymousContext,
      })
      res.json({
        id: created.id,
        name: created.name,
        key: created.plaintext,
        prefix: created.prefix,
        scope: created.scope,
        audience: created.audience,
        anonymousContext: created.anonymousContext,
        status: created.status,
        createdAt: created.createdAt,
        lastUsedAt: created.lastUsedAt,
      })
    } catch (err) {
      if ((err as Error).message.includes('Not authorized')) {
        res.status(403).json({ error: 'Not authorized to modify this assistant' })
        return
      }
      console.error('[api-keys] create failed:', err)
      res.status(500).json({ error: 'Failed to create API key' })
    }
  })

  router.get<AssistantParams>('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return }
    try {
      res.json({ keys: await store.listForUser(userId, req.params.assistantId) })
    } catch (err) {
      console.error('[api-keys] list failed:', err)
      res.status(500).json({ error: 'Failed to list API keys' })
    }
  })

  router.delete<{ assistantId: string; keyId: string }>('/:keyId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return }
    try {
      if (!(await store.revokeForUser(userId, req.params.keyId))) {
        res.status(404).json({ error: 'API key not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[api-keys] revoke failed:', err)
      res.status(500).json({ error: 'Failed to revoke API key' })
    }
  })

  return router
}
