/** Browser API preflight policy and opaque desktop-origin admission. */
import type { RequestHandler } from 'express'

/** Static method/header policy only; actual routes retain their authorization. */
export function createApiCorsMiddleware(origins: readonly string[]): RequestHandler {
  const allowedOrigins = new Set(origins)
  return (req, res, next) => {
    // These routes own their extension-only CORS, including preflight.
    if (/^\/api\/protected-browser-fill\/(resolve|complete|recover)$/.test(req.path)) { next(); return }
    // Application origins/headers are resolved from the exact registered client.
    if (/^\/api\/applications(?:\/|$)/.test(req.path)) { next(); return }
    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Access-Control-Allow-Credentials', 'true')
      res.header('Vary', 'Origin')
      if (req.method === 'OPTIONS') res.header('Access-Control-Max-Age', '600')
    } else if (origin === 'null' && (
      req.path === '/api/brain/mcp' || /^\/api\/home-apps\/[^/]+\/state$/.test(req.path)
      || isOpaqueDesktopBearerRequest({
        path: req.path,
        authorization: req.headers.authorization,
        requestedHeaders: req.headers['access-control-request-headers'],
      })
    )) {
      // Opaque origins are shared by unrelated frames. Admit the existing
      // bearer/bridge paths without credentials or a cached origin admission.
      res.header('Access-Control-Allow-Origin', 'null')
      res.header('Vary', 'Origin')
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Content-Range, Authorization, X-Client-Timezone, X-Brian-Access-Review-Id, X-Brian-Access-Review-Hash')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  }
}

function headerIncludesAuthorization(value: string | readonly string[] | undefined): boolean {
  const joined = typeof value === 'string' ? value : value?.join(',')
  return joined
    ?.split(',')
    .some((header) => header.trim().toLowerCase() === 'authorization') ?? false
}

export function isOpaqueDesktopBearerRequest(input: {
  path: string
  authorization?: string | readonly string[]
  requestedHeaders?: string | readonly string[]
}): boolean {
  const authorization = typeof input.authorization === 'string'
    ? input.authorization
    : input.authorization?.[0]
  if (authorization?.startsWith('Bearer ') && authorization.length > 'Bearer '.length) {
    return true
  }
  if (headerIncludesAuthorization(input.requestedHeaders)) return true

  // Desktop refresh carries its explicit refresh-token secret in the JSON body,
  // so its preflight has Content-Type but no Authorization header.
  return input.path === '/auth/refresh'
}
