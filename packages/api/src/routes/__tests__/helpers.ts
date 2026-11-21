/**
 * Shared test helpers for API route integration tests.
 *
 * Provides a minimal Express app factory and mock builders so each
 * route test can mount a single router with injected dependencies.
 */

import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { duplexPair } from 'node:stream'
import { text } from 'node:stream/consumers'
import express, { type Router } from 'express'

/**
 * Build a minimal Express app with JSON parsing, the given router
 * mounted at `mountPath`, and an optional auth middleware shim.
 *
 * For routes that use `mergeParams: true` (e.g. integrations, telegram-linking),
 * pass a parameterized `mountPath` like `/api/assistants/:assistantId/integrations`.
 * The test request URL should use a concrete value (e.g. `/api/assistants/a_1/integrations`).
 *
 * Usage:
 *   const app = createTestApp('/api/feedback', feedbackRoutes())
 *   const res = await request(app).post('/api/feedback').send(body)
 */
export function createTestApp(
  mountPath: string,
  router: Router,
  opts?: { userId?: string; authSessionId?: string; authVersion?: number },
): express.Express {
  const app = express()

  // Capture raw body for Stripe webhook tests
  app.use(express.json({
    verify: (req, _res, buf) => {
      ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
    },
  }))

  // Inject userId if provided (simulates auth middleware)
  if (opts?.userId) {
    app.use((_req, _res, next) => {
      ;(_req as express.Request & { userId?: string }).userId = opts.userId
      ;(_req as express.Request & { authSessionId?: string }).authSessionId = opts.authSessionId
      ;(_req as express.Request & { authVersion?: number }).authVersion = opts.authVersion
      next()
    })
  }

  app.use(mountPath, router)
  return app
}

/** Send HTTP requests through the mounted app without opening a listening socket. */
export function createInProcessRequester(app: express.Express) {
  const server = createServer(app)
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const incomingRequest = new Request(new URL(input, 'http://api.example.test'), init)
    const body = incomingRequest.body ? await incomingRequest.text() : undefined
    const [client, peer] = duplexPair()
    server.emit('connection', peer)
    try {
      const outgoing = request(incomingRequest.url, {
        method: incomingRequest.method,
        headers: Object.fromEntries(incomingRequest.headers),
        createConnection: () => client,
      })
      const received = once(outgoing, 'response')
      outgoing.end(body)
      const [incoming] = await received
      return new Response(await text(incoming) || null, {
        status: incoming.statusCode,
        headers: { 'content-type': incoming.headers['content-type'] ?? '' },
      })
    } finally {
      client.destroy()
      peer.destroy()
    }
  }
}

/**
 * Create a mock store object from a list of method names.
 * Each method is a vi.fn() that resolves undefined by default.
 */
export function mockStore<T extends Record<string, unknown>>(
  methods: (keyof T)[],
): T {
  const store: Record<string, unknown> = {}
  for (const m of methods) {
    store[m as string] = vi.fn().mockResolvedValue(undefined)
  }
  return store as T
}

// Re-export vi for convenience — callers import from vitest anyway,
// but this keeps the helpers self-contained.
import { vi } from 'vitest'
