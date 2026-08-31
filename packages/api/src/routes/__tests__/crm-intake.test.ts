import { readFileSync } from 'node:fs'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { CrmOperationsError, createRateLimiter } from '@use-brian/core'
import { crmIntakeRoutes } from '../crm-intake.js'

const CREDENTIAL_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const DEFINITION_ID = '33333333-3333-4333-8333-333333333333'
const TOKEN = `sk_intake_${CREDENTIAL_ID}_secret`

function build(options: { maxRequests?: number } = {}) {
  const service = {
    execute: vi.fn().mockResolvedValue({
      command: 'record_submission', created: true, duplicate: false,
      emittedEventIds: ['event-1'],
      record: { submissionId: 'submission-1', contactId: 'contact-1', followUpTaskId: null },
    }),
  }
  const readStore = {
    authenticate: vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      credentialId: CREDENTIAL_ID,
      definitionId: DEFINITION_ID,
      definitionKey: 'contact_form',
    }),
    listDefinitions: vi.fn(),
    listCredentials: vi.fn(),
  }
  const app = express()
  app.use('/api', crmIntakeRoutes({
    service,
    readStore,
    rateLimiter: createRateLimiter({ maxRequests: options.maxRequests ?? 60, windowMs: 60_000 }),
  }))
  return { app, service, readStore }
}

function submit(
  app: express.Express,
  body: Record<string, unknown> = { fields: { name: 'Ari Example' } },
) {
  return request(app)
    .post('/api/crm/intake/contact_form/submissions')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Idempotency-Key', 'request-1')
    .send(body)
}

describe('[COMP:api/crm-intake-route] public atomic CRM intake', () => {
  it('derives workspace, actor, and definition from authentication and returns bounded ids', async () => {
    const { app, service } = build()
    const response = await submit(app)
    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      submissionId: 'submission-1', contactId: 'contact-1', followUpTaskId: null, duplicate: false,
    })
    expect(service.execute).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'intake_key', credentialId: CREDENTIAL_ID, definitionId: DEFINITION_ID },
      authority: { role: 'system', canWrite: true, canConfigure: false, trustedIdentitySources: [] },
      requestId: undefined,
    }, {
      kind: 'record_submission', definitionKey: 'contact_form', idempotencyKey: 'request-1',
      fields: { name: 'Ari Example' },
    })
  })

  it('requires bearer authentication and idempotency without revealing credential state', async () => {
    const { app, readStore } = build()
    const noAuth = await request(app)
      .post('/api/crm/intake/contact_form/submissions')
      .set('Idempotency-Key', 'request-1')
      .send({ fields: {} })
    expect(noAuth.status).toBe(401)
    const noIdempotency = await request(app)
      .post('/api/crm/intake/contact_form/submissions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ fields: {} })
    expect(noIdempotency.status).toBe(400)
    expect(readStore.authenticate).not.toHaveBeenCalled()
  })

  it('rejects attempts to nominate workspace, actor, verification, or routing', async () => {
    const { app, service } = build()
    const response = await submit(app, {
      fields: { name: 'Ari Example' },
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user' },
      verified: true,
      ownerUserId: CREDENTIAL_ID,
    })
    expect(response.status).toBe(400)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('maps changed-body idempotency conflicts and identical duplicates', async () => {
    const conflict = build()
    conflict.service.execute.mockRejectedValueOnce(new CrmOperationsError(
      'idempotency_conflict', 'Idempotency key was already used with another request.',
    ))
    expect((await submit(conflict.app)).status).toBe(409)

    const duplicate = build()
    duplicate.service.execute.mockResolvedValueOnce({
      command: 'record_submission', created: false, duplicate: true, emittedEventIds: [],
      record: { submissionId: 'submission-1', contactId: 'contact-1', followUpTaskId: null },
    })
    const response = await submit(duplicate.app)
    expect(response.status).toBe(200)
    expect(response.body.duplicate).toBe(true)
  })

  it('rate-limits by credential candidate plus source address before authentication', async () => {
    const { app, readStore } = build({ maxRequests: 1 })
    expect((await submit(app)).status).toBe(201)
    expect((await submit(app)).status).toBe(429)
    expect(readStore.authenticate).toHaveBeenCalledOnce()
  })

  it('rejects bodies above the dedicated 1 MiB parser limit', async () => {
    const { app, service } = build()
    const response = await submit(app, { fields: { message: 'x'.repeat(1_048_577) } })
    expect(response.status).toBe(413)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('does not expose read or arbitrary tool routes to an intake key', async () => {
    const { app } = build()
    expect((await request(app)
      .get('/api/crm/intake/contact_form/submissions')
      .set('Authorization', `Bearer ${TOKEN}`)).status).toBe(404)
    expect((await request(app)
      .post('/api/brain/mcp')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({})).status).toBe(404)
  })

  it('is mounted before the first bare JWT guard and skipped by the global parser', () => {
    const source = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
    const intakeIndex = source.indexOf("app.use('/api', crmIntakeRoutes({")
    const firstGuardIndex = source.search(/app\.use\('\/api', requireAuth\(env\.JWT_SECRET\)/)
    expect(intakeIndex).toBeGreaterThan(0)
    expect(firstGuardIndex).toBeGreaterThan(0)
    expect(intakeIndex).toBeLessThan(firstGuardIndex)
    expect(source).toContain("/^\\/api\\/crm\\/intake\\/[^/]+\\/submissions$/.test(req.path)")
  })
})
