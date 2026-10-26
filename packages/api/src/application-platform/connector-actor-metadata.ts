/** Public installation key projection only. [COMP:api/connector-actor-context] */
import { Router } from 'express'
import { query } from '../db/client.js'

export function connectorActorMetadataRoutes(issuer: string, readPublicKeys = async (configuredIssuer: string): Promise<unknown> =>
  (await query<{ jwks: unknown }>('SELECT connector_actor_public_jwks($1) AS jwks', [configuredIssuer])).rows[0].jwks): Router {
  const router = Router()
  router.get('/.well-known/usebrian-connector-jwks.json', async (_req, res) => {
    res.set('Cache-Control', 'no-store')
    try { res.json(await readPublicKeys(issuer)) }
    catch { res.status(503).json({ error: 'connector_identity_unavailable' }) }
  })
  return router
}
