import { Router } from 'express'
import { z } from 'zod'
import type { TransactionalConnectorSetup } from './transactional-setup.js'
import { ConnectorSetupError } from './setup-service.js'

const uuid = z.string().uuid()
export const connectorSetupStartSchema = z.object({ workspaceId: uuid, provider: z.string().min(1).max(100),
  operation: z.enum(['create', 'reconnect', 'share', 'transfer']), ownership: z.enum(['personal', 'workspace']),
  instanceId: uuid.optional(), expectedInstanceVersion: z.string().regex(/^\d+$/).optional(), sensitivity: z.enum(['public', 'internal', 'confidential']),
  expectedPolicyRevision: z.string().regex(/^\d+$/),
  destination: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('general'), projectId: uuid.optional() }).strict(),
    z.object({ kind: z.literal('department'), departmentId: uuid, projectId: uuid.optional() }).strict(),
  ]).optional(),
}).strict()

/** Mount behind requireAuth. A programmatic userId/owner fallback alone does
 * not qualify: a current interactive auth session is rechecked by admission. */
export function connectorSetupRoutes(service: TransactionalConnectorSetup): Router {
  const router = Router()
  router.get('/reconnect/:instanceId', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.vary('Authorization')
    const query = z.object({ workspaceId: uuid }).strict().safeParse(req.query)
    if (!req.userId || !req.authSessionId || !uuid.safeParse(req.params.instanceId).success || !query.success) {
      res.status(404).json({ error: 'connector_setup_not_found' }); return
    }
    try {
      res.json(await service.reconnectProjection(req.userId, req.authSessionId, query.data.workspaceId, String(req.params.instanceId)))
    } catch (e) {
      const hidden = e instanceof ConnectorSetupError && e.code === 'connector_setup_not_found'
      res.status(hidden ? 404 : 503).json({ error: hidden ? 'connector_setup_not_found' : 'connector_setup_failed' })
    }
  })
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!req.userId || !req.authSessionId) { res.status(401).json({ error: 'connector_setup_human_required' }); return }
    next()
  })
  router.post('/', async (req, res) => {
    const parsed = connectorSetupStartSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'connector_setup_request_invalid' }); return }
    try { res.json(await service.start(req.userId!, { ...parsed.data, authSessionId: req.authSessionId! })) }
    catch (e) { res.status(409).json({ error: e instanceof ConnectorSetupError ? e.code : 'connector_setup_failed' }) }
  })
  router.use('/:id', (req, res, next) => {
    if (!uuid.safeParse(req.params.id).success) { res.status(404).json({ error: 'connector_setup_not_found' }); return }
    next()
  })
  for (const action of ['status', 'stage', 'review', 'consent', 'activate', 'cancel'] as const) {
    router.post(`/:id/${action}`, async (req, res) => {
      const id = String(req.params.id), actor = req.userId!
      const schema = action === 'stage' ? z.object({ nonce: z.string().min(32).max(128), proof: z.unknown() }).strict()
        : action === 'consent' || action === 'activate' ? z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
          : z.object({}).strict()
      if (!schema.safeParse(req.body).success) { res.status(400).json({ error: 'connector_setup_request_invalid' }); return }
      try {
        const result = action === 'stage' ? await service.stageVerifiedCredentials(actor, id, req.body.nonce, req.body.proof, { sessionId: req.authSessionId! })
          : action === 'review' ? await service.prepareConsent(actor, id)
            : action === 'consent' ? await service.saveConsent(actor, id, req.body.digest)
              : action === 'activate' ? await service.activate(actor, id, req.body.digest)
                : action === 'cancel' ? await service.cancel(actor, id) : await service.get(actor, id)
        res.json(result)
      } catch (e) { res.status(409).json({ error: e instanceof ConnectorSetupError ? e.code : 'connector_setup_failed' }) }
    })
  }
  return router
}
