import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrmOperationsError } from '@use-brian/core/crm/operations-types.js'
import { createRateLimiter } from '@use-brian/core/security/rate-limiter.js'
import { crmIntakeRoutes } from '../crm-intake.js'
import { bootCompositionSource } from '../../boot/__tests__/composition-source.js'

const CREDENTIAL_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const DEFINITION_ID = '33333333-3333-4333-8333-333333333333'
const TOKEN = `sk_intake_${CREDENTIAL_ID}_secret`
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

function build(options: { maxRequests?: number; trustProxy?: string } = {}) {
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
  if (options.trustProxy) app.set('trust proxy', options.trustProxy)
  app.use('/api', crmIntakeRoutes({
    service,
    readStore,
    rateLimiter: createRateLimiter({ maxRequests: options.maxRequests ?? 60, windowMs: 60_000 }),
  }))
  // One listening endpoint per fixture, including the full burst/recovery test.
  // Avoid opening and recycling an ephemeral server for every individual request.
  const server = app.listen(0)
  servers.push(server)
  return { app: server, service, readStore }
}

function submit(
  app: Server,
  body: Record<string, unknown> = { fields: { name: 'Ari Example' } },
) {
  return request(app)
    .post('/api/crm/intake/contact_form/submissions')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Idempotency-Key', 'request-1')
    .send(body)
}

describe('[COMP:api/crm-intake-route] public atomic CRM intake', () => {
  it('forwards bounded proof and refuses nested authority flags before invoking the service', async () => {
    const { app, service } = build()
    const identityProof = { keyId: 'fixture_backend', definitionVersion: 1, verifiedAt: '2026-09-08T12:00:00Z', signature: 'A'.repeat(86) }
    expect((await submit(app, { fields: { name: 'Fixture' }, identityProof })).status).toBe(201)
    expect(service.execute).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ identityProof }))
    service.execute.mockClear()
    expect((await submit(app, { fields: {}, externalIdentity: { provider: 'fixture', subject: 'subject', verified: true } })).status).toBe(400)
    expect((await submit(app, { fields: {}, identityProof: { ...identityProof, privateKey: 'never_accept' } })).status).toBe(400)
    expect(service.execute).not.toHaveBeenCalled()
  })
  it('forwards one bounded image attachment outside the definition-mapped field object', async () => {
    const { app, service } = build()
    const attachment = {
      key: 'business_card', name: 'card.png', mimeType: 'image/png',
      contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    }
    expect((await submit(app, { fields: { name: 'Fixture' }, attachments: [attachment] })).status).toBe(201)
    expect(service.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attachments: [attachment] }))
  })
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
    const limited = await submit(app)
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
    expect(limited.body).toMatchObject({ error: 'rate_limited', retryable: true, retryAfterSeconds: 60 })
    expect(readStore.authenticate).toHaveBeenCalledOnce()
  })

  it('enforces the initial sixty-attempt ceiling and recovers after the indicated delay', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00Z'))
    try {
      const { app, service } = build()
      for (let attempt = 0; attempt < 60; attempt++) expect((await submit(app)).status).toBe(201)
      const refused = await submit(app)
      expect(refused.status).toBe(429)
      expect(service.execute).toHaveBeenCalledTimes(60)
      clock.mockReturnValue(Date.parse('2026-01-01T00:00:59.999Z'))
      expect((await submit(app)).status).toBe(429)
      clock.mockReturnValue(Date.parse('2026-01-01T00:01:00Z'))
      expect((await submit(app)).status).toBe(201)
      expect(service.execute).toHaveBeenCalledTimes(61)
    } finally { clock.mockRestore() }
  })

  it('ignores rotated forwarded headers when proxy trust is disabled and rejects before parsing', async () => {
    const { app, readStore } = build({ maxRequests: 1 })
    const post = () => request(app).post('/api/crm/intake/contact_form/submissions')
      .set('Authorization', `Bearer ${TOKEN}`).set('Idempotency-Key', 'request-1')
    expect((await post().set('X-Forwarded-For', '198.51.100.1').send({ fields: {} })).status).toBe(201)
    const refused = await post().set('X-Forwarded-For', '198.51.100.2')
      .set('Content-Type', 'application/json').send('{')
    expect(refused.status).toBe(429)
    expect(refused.body.error).toBe('rate_limited')
    expect(readStore.authenticate).toHaveBeenCalledOnce()
  })

  it('uses only the trusted proxy boundary and closest untrusted hop for source buckets', async () => {
    const { app, readStore } = build({ maxRequests: 1, trustProxy: 'loopback' })
    const post = (forwarded: string, credential = CREDENTIAL_ID) => request(app)
      .post('/api/crm/intake/contact_form/submissions')
      .set('Authorization', `Bearer sk_intake_${credential}_secret`)
      .set('Idempotency-Key', 'request-1').set('X-Forwarded-For', forwarded).send({ fields: {} })
    expect((await post('198.51.100.1, 203.0.113.1')).status).toBe(201)
    expect((await post('198.51.100.2, 203.0.113.1')).status).toBe(429)
    expect((await post('198.51.100.2, 203.0.113.2')).status).toBe(201)
    expect((await post('198.51.100.2, 203.0.113.1', '44444444-4444-4444-8444-444444444444')).status).toBe(201)
    expect(readStore.authenticate).toHaveBeenCalledTimes(3)
  })

  it('rejects bodies above the dedicated 2 MiB parser limit', async () => {
    const { app, service } = build()
    const response = await submit(app, { fields: { message: 'x'.repeat(2_097_153) } })
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
    const source = bootCompositionSource()
    const intakeIndex = source.indexOf("app.use('/api', crmIntakeRoutes({")
    const firstGuardIndex = source.search(/app\.use\('\/api', requireAuth\(env\.JWT_SECRET\)/)
    expect(intakeIndex).toBeGreaterThan(0)
    expect(firstGuardIndex).toBeGreaterThan(0)
    expect(intakeIndex).toBeLessThan(firstGuardIndex)
    expect(source).toContain("/^\\/api\\/crm\\/intake\\/[^/]+\\/submissions$/.test(req.path)")
  })
})
