/**
 * Express app, request middleware and health routes.
 *
 * Boot register module registerHttp: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`HttpScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { sanitizeDeep } from '@use-brian/agent-runtime/security/sanitize.js'
import { createRateLimiter } from '@use-brian/core/security/rate-limiter.js'
import { detectInternalLinkAliasReadiness } from '../internal-link-capabilities.js'
import express, { type Express } from 'express'
import { createApiCorsMiddleware } from '../cors-policy.js'
import { type MessageStoreClient, createMessageStoreClient } from '../chat-archive/message-store-client.js'
import { createChatArchiveLiveMedia } from '../chat-archive/live-media.js'
import { attachClientTimezone } from '../auth/client-timezone.js'
import { setMediaTokenSecret } from '../media-token.js'
import { configureCrmHomeAppParentSigner } from '../crm-operations/integration-department-authority.js'
import type { HttpScope } from './scope.js'

export function registerHttp(scope: HttpScope) {
  const { env, ports } = scope
  if (!env.JWT_SECRET) {
    throw new Error('[boot] JWT_SECRET is required to run this service.')
  }
  // Bind the media-token signing secret for the channel pipeline's actor
  // media tokens (late-bound seam — see media-token.ts).
  configureCrmHomeAppParentSigner(env.JWT_SECRET)
  setMediaTokenSecret(env.JWT_SECRET)

  const app: Express = express()
  ports.mountManagedHttpIngress?.(app)
  const port = parseInt(env.PORT || new URL(env.API_URL).port || '4000')

  // The archive runs against its own database, so every interaction with it is
  // an HTTP contract. Null when it is not deployed: chat history is simply
  // absent rather than the platform failing to boot.
  const messageStoreClient: MessageStoreClient | null = createMessageStoreClient(env)
  const chatArchiveLiveMedia = messageStoreClient ? createChatArchiveLiveMedia(messageStoreClient) : undefined

  // ── Middleware: raw-body capture + JSON ──
  // 15mb ceiling: the WhatsApp connector forwards inbound media inline as
  // base64 (`/internal/whatsapp/inbound`) up to a 10MB raw cap, which inflates
  // to ~13.4MB encoded plus JSON envelope. Express's default 100kb limit 413s
  // any media-bearing message, silently dropping it from ingest. Other routes
  // post small JSON, so the higher ceiling only matters for that relay.
  const jsonParser = express.json({
    limit: '15mb',
    verify: (req, _res, buf) => {
      ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
    },
  })
  app.use((req, res, next) => {
    // Signed local-file PUTs are raw byte streams. Let their route consume the
    // request directly even when the uploaded file itself is JSON.
    if (
      req.path === '/api/local-files'
      || /^\/api\/applications(?:\/|$)/.test(req.path)
      || (req.method === 'PUT' && /^\/internal\/chat-archive\/media\/[^/]+\/content$/.test(req.path))
      || (req.method === 'POST' && /^\/bridge\/v1\/channels\/[^/]+\/media\/[^/]+$/.test(req.path))
      // The public CRM intake route owns a tighter 1 MiB parser. Skipping the
      // global 15 MiB parser is what makes the byte limit apply before JSON
      // decoding instead of after the body is already resident in memory.
      || (req.method === 'POST' && /^\/api\/crm\/intake\/[^/]+\/submissions$/.test(req.path))
    ) {
      next()
      return
    }
    jsonParser(req, res, next)
  })

  // ── CORS ──
  app.use(createApiCorsMiddleware([env.APP_URL, env.FEED_URL, env.AUTHED_APP_URL].filter(Boolean) as string[]))

  // ── Client timezone capture ──
  app.use(attachClientTimezone())

  // ── Rate limiting (600 req/60s per actor; bypassed in dev) ──
  if (env.NODE_ENV !== 'development') {
    const rateLimiter = createRateLimiter({ maxRequests: 600 })
    app.use((req, res, next) => {
      rateLimiter.middleware(req, res, next, (r) => {
        const auth = r.headers['authorization']
        const header = Array.isArray(auth) ? auth[0] : auth
        if (header && header.startsWith('Bearer ')) return `u:${header.slice(7)}`
        const forwarded = r.headers['x-forwarded-for']
        const forwardedHead = Array.isArray(forwarded) ? forwarded[0] : forwarded
        return `ip:${r.ip ?? forwardedHead?.split(',')[0]?.trim() ?? 'unknown'}`
      })
    })
  }

  // ── Unicode sanitization on all incoming JSON bodies ──
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeDeep(req.body)
    }
    next()
  })

  // ── Health check ──
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Public rollout signal consumed by app-web's own `/api/desktop-config`.
  // It reports only schema readiness and never resolves an alias or target.
  app.get('/capabilities/internal-links', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await detectInternalLinkAliasReadiness())
  })

  return { messageStoreClient, app, port, chatArchiveLiveMedia } as const
}
