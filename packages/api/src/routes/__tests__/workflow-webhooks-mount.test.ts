/**
 * Regression tests for the webhook receiver's MOUNTING + RAW-BODY handling.
 * Component tag: [COMP:api/workflow-webhooks-route].
 *
 * Guards two latent bugs fixed 2026-06-30 (both invisible to the isolated
 * receiver unit test in `workflow-webhooks.test.ts`):
 *
 *  1. Mount ordering — the public receiver MUST register before the bare
 *     `app.use('/api', requireAuth(...))` guards in `boot.ts`. Express runs
 *     path-prefix middleware in registration order, so a webhook route mounted
 *     after the first bare `/api` guard is 401'd before its handler runs. An
 *     external sender carries `X-Workflow-Signature`, never a Bearer token, so
 *     it can never satisfy `requireAuth`.
 *
 *  2. Raw-body capture — the global `express.json()` consumes the stream for
 *     `application/json` and leaves `req.body` a parsed object (not a Buffer),
 *     stashing the exact bytes on `req.rawBody`. HMAC must run over `rawBody`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'

vi.mock('@use-brian/core', async (io) => ({
  ...(await io<typeof import('@use-brian/core')>()),
  advanceWorkflowRun: vi.fn(async () => ({ kind: 'completed', runId: 'run-1' })),
}))

import { workflowWebhookRoutes } from '../workflow-webhooks.js'
import { requireAuth } from '../../auth/middleware.js'

const SECRET = 'webhook-secret'

function webhookWorkflow() {
  return {
    id: 'wf-1',
    workspaceId: 'ws-1',
    createdBy: 'u-1',
    enabled: true,
    trigger: { kind: 'webhook' },
    webhookSecret: SECRET,
  }
}

function sign(body: Buffer, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/**
 * Build an app that mirrors `boot.ts`: a global `express.json()` with the same
 * raw-body `verify` hook, plus a bare `requireAuth` `/api` guard and the
 * webhook route, mounted in a chosen order.
 */
function buildApp({ webhookFirst }: { webhookFirst: boolean }) {
  const findByWebhookSlugSystem = vi.fn(async () => webhookWorkflow())
  const createRun = vi.fn(async () => ({ id: 'run-1' }))

  const app = express()
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
      },
    }),
  )

  const mountWebhook = () =>
    app.use(
      '/api',
      workflowWebhookRoutes({
        workflowStore: { findByWebhookSlugSystem } as never,
        runStore: { createRun } as never,
        runDeps: {} as never,
      }),
    )

  const mountGuard = () => {
    const guarded = express.Router()
    guarded.get('/views', (_req, res) => res.json({ ok: true }))
    app.use('/api', requireAuth('jwt-secret'), guarded)
  }

  if (webhookFirst) {
    mountWebhook()
    mountGuard()
  } else {
    mountGuard()
    mountWebhook()
  }

  return { app, findByWebhookSlugSystem, createRun }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/workflow-webhooks-route] webhook mount ordering + raw body', () => {
  it('reaches the handler when mounted BEFORE the bare /api guard (the fix)', async () => {
    const { app, findByWebhookSlugSystem } = buildApp({ webhookFirst: true })
    const raw = JSON.stringify({ order: 42 })
    const res = await request(app)
      .post('/api/workflow-webhooks/hook-1')
      .set('Content-Type', 'application/json')
      .set('X-Workflow-Signature', sign(Buffer.from(raw)))
      .send(raw) // no Authorization header — external senders never carry one
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(200)
    expect(findByWebhookSlugSystem).toHaveBeenCalledWith('hook-1')
  })

  it('is shadowed (401) when mounted AFTER the bare /api guard (the bug)', async () => {
    const { app, findByWebhookSlugSystem } = buildApp({ webhookFirst: false })
    const raw = JSON.stringify({ order: 42 })
    const res = await request(app)
      .post('/api/workflow-webhooks/hook-1')
      .set('Content-Type', 'application/json')
      .set('X-Workflow-Signature', sign(Buffer.from(raw)))
      .send(raw)
    expect(res.status).toBe(401)
    expect(findByWebhookSlugSystem).not.toHaveBeenCalled()
  })

  it('verifies HMAC over req.rawBody for application/json (not the parsed object)', async () => {
    const { app, createRun } = buildApp({ webhookFirst: true })
    const raw = JSON.stringify({ nested: { a: 1 }, list: [1, 2, 3] })
    const res = await request(app)
      .post('/api/workflow-webhooks/hook-1')
      .set('Content-Type', 'application/json')
      .set('X-Workflow-Signature', sign(Buffer.from(raw)))
      .send(raw)
    // A signature mismatch (HMAC over an empty buffer) would 401 here.
    expect(res.status).toBe(200)
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ input: { nested: { a: 1 }, list: [1, 2, 3] } }),
    )
  })

  it('boot.ts mounts the webhook receiver before the first bare /api requireAuth guard', () => {
    const src = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
    const webhookIdx = src.indexOf('workflowWebhookRoutes({')
    const firstGuardIdx = src.search(/app\.use\('\/api', requireAuth\(env\.JWT_SECRET\)/)
    expect(webhookIdx).toBeGreaterThan(0)
    expect(firstGuardIdx).toBeGreaterThan(0)
    expect(webhookIdx).toBeLessThan(firstGuardIdx)
  })
})
