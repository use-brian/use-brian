import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { type ProtectedFillService } from '@use-brian/core'
import { verifyBrowserExtSessionToken } from '../auth/browser-ext-pair-token.js'

const identity = z.object({
  workspaceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  browserProfileId: z.string().min(1).max(128),
}).strict()
const recoveryIdentity = identity.pick({ workspaceId: true, browserProfileId: true }).strict()
const scope = identity.extend({ destinationOrigin: z.string().min(1).max(2048) }).strict()
const createBody = scope.extend({ sources: z.array(z.object({
  kind: z.literal('crm'), entityId: z.string().uuid(),
  field: z.enum(['name', 'email', 'phone', 'company', 'jobTitle', 'address', 'website']),
}).strict()).min(1).max(20) }).strict()
const resolveBody = scope.extend({ items: z.array(z.object({
  referenceId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ref: z.string().regex(/^@e[1-9][0-9]{0,8}$/),
}).strict()).min(1).max(20) }).strict()
const denied = (res: Response, status = 403) => {
  res.status(status).json({ error: 'Protected fill unavailable', code: 'protected_fill_denied' })
}

/** Mount outside general requireAuth: extension endpoints accept ONLY session-kind JWTs.
 * Do not mount until all transport locks, source authorization and UI are wired.
 */
export function protectedBrowserFillRoutes(deps: {
  service: ProtectedFillService
  jwtSecret: string
  userAuth: RequestHandler
  extensionOrigins: ReadonlySet<string>
  /** Retire the task after extension has closed/detached all protected tabs. */
  onComplete: (sessionId: string) => Promise<void>
}): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    next()
  })
  router.post('/references', deps.userAuth, async (req, res) => {
    try {
      const parsed = createBody.safeParse(req.body)
      if (!parsed.success || !req.userId) { denied(res); return }
      const { sources, ...binding } = parsed.data
      res.status(201).json(await deps.service.create({ ...binding, userId: req.userId }, sources))
    } catch { denied(res) }
  })
  // Explicit extension-origin allowlist: never reflect arbitrary Origin, never
  // accept web access tokens/pairing tokens as resolver credentials.
  const extensionCors: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin
    if (!origin || !deps.extensionOrigins.has(origin)) { denied(res); return }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  }
  router.options(['/resolve', '/complete', '/recover'], extensionCors)
  router.post(['/resolve', '/complete', '/recover'], extensionCors, async (req, res) => {
    try {
      const token = req.headers.authorization
      const claims = token?.startsWith('Bearer ')
        ? verifyBrowserExtSessionToken(token.slice(7), deps.jwtSecret) : null
      if (!claims) { denied(res, 401); return }
      if (req.path === '/recover') {
        const parsed = recoveryIdentity.safeParse(req.body)
        if (!parsed.success || parsed.data.workspaceId !== claims.workspaceId ||
          parsed.data.browserProfileId !== claims.browserProfileId) { denied(res); return }
        res.json(await deps.service.recover({ ...parsed.data, userId: claims.userId },
          scope => deps.onComplete(scope.sessionId)))
      } else if (req.path === '/resolve') {
        const parsed = resolveBody.safeParse(req.body)
        if (!parsed.success || parsed.data.workspaceId !== claims.workspaceId ||
          parsed.data.browserProfileId !== claims.browserProfileId) { denied(res); return }
        const { items, ...binding } = parsed.data
        // This is the only HTTP response permitted to carry resolved values.
        res.json(await deps.service.resolve({ ...binding, userId: claims.userId }, items))
      } else {
        const parsed = identity.safeParse(req.body)
        if (!parsed.success || parsed.data.workspaceId !== claims.workspaceId ||
          parsed.data.browserProfileId !== claims.browserProfileId) { denied(res); return }
        await deps.service.complete(
          { ...parsed.data, userId: claims.userId },
          () => deps.onComplete(parsed.data.sessionId),
        )
        res.json({ status: 'completed' })
      }
    } catch { denied(res) }
  })
  return router
}
