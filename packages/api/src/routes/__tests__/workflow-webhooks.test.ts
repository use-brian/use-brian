/**
 * Unit tests for the workflow webhook receiver.
 * Component tag: [COMP:api/workflow-webhooks-route].
 *
 * Mocks advanceWorkflowRun and mounts workflowWebhookRoutes() with
 * injected mock stores. Verifies the slug → workflow lookup (404 when
 * absent or not a webhook trigger), the HMAC-SHA256 signature gate
 * (401 on a bad signature), the disabled-workflow 409, and the
 * happy-path run kick-off + outcome → status mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createHmac } from 'node:crypto'
import { createTestApp } from './helpers.js'

vi.mock('@sidanclaw/core', async (io) => ({
  ...(await io<typeof import('@sidanclaw/core')>()),
  advanceWorkflowRun: vi.fn(),
}))

import { workflowWebhookRoutes } from '../workflow-webhooks.js'
import { advanceWorkflowRun } from '@sidanclaw/core'

const mockAdvance = vi.mocked(advanceWorkflowRun)

const SECRET = 'webhook-secret'
const workflowStore = { findByWebhookSlugSystem: vi.fn() }
const runStore = { createRun: vi.fn() }

function app() {
  return createTestApp(
    '/api',
    workflowWebhookRoutes({
      workflowStore: workflowStore as never,
      runStore: runStore as never,
      runDeps: {} as never,
    }),
  )
}

function webhookWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    workspaceId: 'ws-1',
    createdBy: 'u-1',
    enabled: true,
    trigger: { kind: 'webhook' },
    webhookSecret: SECRET,
    ...over,
  }
}

function sign(body: Buffer, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function post(slug: string, body: Buffer, signature: string) {
  return request(app())
    .post(`/api/workflow-webhooks/${slug}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Workflow-Signature', signature)
    .send(body)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/workflow-webhooks-route] POST /workflow-webhooks/:slug', () => {
  it('returns 404 when no workflow matches the slug', async () => {
    workflowStore.findByWebhookSlugSystem.mockResolvedValueOnce(null)
    const body = Buffer.from('{}')
    expect((await post('ghost', body, sign(body))).status).toBe(404)
  })

  it('returns 404 when the matched workflow is not a webhook trigger', async () => {
    workflowStore.findByWebhookSlugSystem.mockResolvedValueOnce(
      webhookWorkflow({ trigger: { kind: 'manual' } }),
    )
    const body = Buffer.from('{}')
    expect((await post('hook-1', body, sign(body))).status).toBe(404)
  })

  it('returns 401 when the HMAC signature does not match', async () => {
    workflowStore.findByWebhookSlugSystem.mockResolvedValueOnce(webhookWorkflow())
    const body = Buffer.from('{"a":1}')
    expect((await post('hook-1', body, sign(body, 'wrong-secret'))).status).toBe(401)
  })

  it('returns 409 when the workflow is disabled', async () => {
    workflowStore.findByWebhookSlugSystem.mockResolvedValueOnce(webhookWorkflow({ enabled: false }))
    const body = Buffer.from('{"a":1}')
    expect((await post('hook-1', body, sign(body))).status).toBe(409)
  })

  it('starts a run and maps a completed outcome to status=completed', async () => {
    workflowStore.findByWebhookSlugSystem.mockResolvedValueOnce(webhookWorkflow())
    runStore.createRun.mockResolvedValueOnce({ id: 'run-1' })
    mockAdvance.mockResolvedValueOnce({ kind: 'completed', runId: 'run-1' } as never)
    const body = Buffer.from('{"order":42}')
    const res = await post('hook-1', body, sign(body))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ runId: 'run-1', status: 'completed' })
    expect(runStore.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', triggeredBy: 'u-1', input: { order: 42 } }),
    )
  })

  it('maps a paused/wait outcome to status=awaiting_wait', async () => {
    workflowStore.findByWebhookSlugSystem.mockResolvedValueOnce(webhookWorkflow())
    runStore.createRun.mockResolvedValueOnce({ id: 'run-1' })
    mockAdvance.mockResolvedValueOnce({ kind: 'paused', reason: 'wait', runId: 'run-1' } as never)
    const body = Buffer.from('{}')
    const res = await post('hook-1', body, sign(body))
    expect(res.body.status).toBe('awaiting_wait')
  })
})
