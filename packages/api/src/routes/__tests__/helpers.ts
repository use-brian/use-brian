/**
 * Shared test helpers for API route integration tests.
 *
 * Provides a minimal Express app factory and mock builders so each
 * route test can mount a single router with injected dependencies.
 */

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
  opts?: { userId?: string },
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
      next()
    })
  }

  app.use(mountPath, router)
  return app
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
