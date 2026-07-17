/**
 * OAuth 2.1 / MCP discovery metadata.
 *
 * Two well-known endpoints exposed at the API origin:
 *
 *   - `/.well-known/oauth-protected-resource` (RFC 9728) — tells the MCP
 *     client which authorization server protects this resource.
 *   - `/.well-known/oauth-authorization-server` (RFC 8414) — the
 *     authorization-server metadata: token + authorize + register endpoints,
 *     supported grant types, PKCE method.
 *
 * Both are stateless and unauthenticated. Spec compliance is what makes the
 * claude.ai / Claude Desktop / ChatGPT custom-connector "Connect" button
 * able to discover this server.
 *
 * Component tag: [COMP:api/brain-oauth].
 */

import { Router, type Request, type Response } from 'express'

export type MetadataOptions = {
  /** Public API origin, e.g. `https://api.usebrian.ai`. */
  apiUrl: string
  /** Public marketing/docs origin, e.g. `https://usebrian.ai` (env.APP_URL). */
  webUrl: string
}

export function oauthMetadataRoutes(opts: MetadataOptions): Router {
  const router = Router()
  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json({
      resource: `${opts.apiUrl}/api/brain/mcp`,
      authorization_servers: [opts.apiUrl],
      bearer_methods_supported: ['header'],
      resource_documentation: `${opts.webUrl}/docs/api`,
    })
  })

  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json({
      issuer: opts.apiUrl,
      authorization_endpoint: `${opts.apiUrl}/api/brain/oauth/authorize`,
      token_endpoint: `${opts.apiUrl}/api/brain/oauth/token`,
      registration_endpoint: `${opts.apiUrl}/api/brain/oauth/register`,
      scopes_supported: ['read', 'read_write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    })
  })

  return router
}
