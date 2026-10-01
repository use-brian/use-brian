import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { buildShopifyAuthorizeUrl, normalizeShopDomain } from '../shopify/client.js'
import { ConnectorSetupError } from './setup-service.js'
import { connectorSetupStartSchema } from './setup-routes.js'
import type { TransactionalConnectorSetup } from './transactional-setup.js'

const selection = connectorSetupStartSchema.omit({ provider: true })
const shop = z.string().max(255).transform(v => normalizeShopDomain(v)).refine(v => !!v)
const pair = { clientId: z.string().min(1).max(1024).regex(/^[^\r\n]+$/), clientSecret: z.string().min(1).max(8192).regex(/^[^\r\n]+$/) }
function human(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store')
  if (!req.userId || !req.authSessionId) { res.status(401).json({ error: 'connector_setup_human_required' }); return false }
  return true
}
function failed(res: Response, error: unknown) {
  res.status(409).json({ error: error instanceof ConnectorSetupError ? error.code : 'connector_setup_failed' })
}
/** Precedes the legacy handlers. Requests without setup intent retain their
 * legacy contract. No app credential, account or active connector is published
 * while the reviewed path awaits OAuth and human consent. */
export function shopifySetupRoutes(service: TransactionalConnectorSetup, redirectUri?: string): Router {
  const router = Router()
  router.post('/shopify/app-credentials', async (req, res, next) => {
    if (req.body?.setup === undefined) { next(); return }
    if (!human(req, res)) return
    const parsed = z.object({ setup: selection, shopDomain: shop, ...pair,
      scopes: z.array(z.string().regex(/^(read|write)_[a-z_]+$/)).min(1).max(100).default(['read_products']),
    }).strict().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'connector_setup_request_invalid' }); return }
    if (!redirectUri) { res.status(503).json({ error: 'connector_setup_redirect_unconfigured' }); return }
    const p = parsed.data
    try {
      const setup = await service.start(req.userId!, { ...p.setup, provider: 'shopify', authSessionId: req.authSessionId!,
        oauth: { shopDomain: p.shopDomain!, clientId: p.clientId, clientSecret: p.clientSecret, redirectUri } })
      const state = `${setup.id}.${setup.nonce}`
      res.json({ ...setup, state, authorizeUrl: buildShopifyAuthorizeUrl({ shopDomain: p.shopDomain!, clientId: p.clientId,
        redirectUri, scopes: p.scopes, state }) })
    } catch (e) { failed(res, e) }
  })
  router.post('/shopify/oauth-callback', async (req, res, next) => {
    if (req.body?.setupId === undefined) { next(); return }
    if (!human(req, res)) return
    const parsed = z.object({ setupId: z.string().uuid(), workspaceId: z.string().uuid(),
      params: z.record(z.string(), z.string().max(8192)),
    }).strict().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'connector_setup_request_invalid' }); return }
    const p = parsed.data, state = p.params.state ?? '', prefix = `${p.setupId}.`
    if (!state.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(state.slice(prefix.length))) {
      res.status(400).json({ error: 'connector_setup_binding_mismatch' }); return
    }
    try {
      res.json(await service.stageVerifiedCredentials(req.userId!, p.setupId, state.slice(prefix.length), { params: p.params },
        { sessionId: req.authSessionId!, workspaceId: p.workspaceId, provider: 'shopify' }))
    } catch (e) { failed(res, e) }
  })
  router.post('/shopify/store-credentials', async (req, res, next) => {
    if (req.body?.setup === undefined) { next(); return }
    if (!human(req, res)) return
    const parsed = z.object({ setup: selection,
      shopifyTokens: z.object({ shopDomain: shop, accessToken: z.string().min(1).max(8192) }).strict(),
    }).strict().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'connector_setup_request_invalid' }); return }
    const p = parsed.data
    try {
      const setup = await service.start(req.userId!, { ...p.setup, provider: 'shopify', authSessionId: req.authSessionId! })
      res.json(await service.stageVerifiedCredentials(req.userId!, setup.id, setup.nonce,
        { shopDomain: p.shopifyTokens.shopDomain, accessToken: p.shopifyTokens.accessToken },
        { sessionId: req.authSessionId!, workspaceId: p.setup.workspaceId, provider: 'shopify' }))
    } catch (e) { failed(res, e) }
  })
  return router
}
