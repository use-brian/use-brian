import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { crmOperationsRoutes } from '../crm-operations.js'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const DEFINITION_ID = '33333333-3333-4333-8333-333333333333'

function build(role: 'owner' | 'admin' | 'member' = 'owner') {
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) }
  const service = { execute: vi.fn().mockResolvedValue({
    command: 'create_intake_credential', created: true, duplicate: false,
    emittedEventIds: [], record: { id: 'credential-1' }, oneTimeSecret: 'sk_intake_once',
  }) }
  const readStore = {
    authenticate: vi.fn(),
    listDefinitions: vi.fn().mockResolvedValue([{ id: DEFINITION_ID, definitionKey: 'contact_form' }]),
    listCredentials: vi.fn().mockResolvedValue([{ id: 'credential-1', prefix: 'sk_intake_abcd' }]),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = USER_ID; next() })
  app.use('/api/crm', crmOperationsRoutes({ workspaceStore, service, readStore } as never))
  return { app, service, readStore }
}

describe('[COMP:api/crm-operations-route] intake configuration REST adapter', () => {
  it('lists definitions for members but keeps credentials admin-only', async () => {
    const member = build('member')
    expect((await request(member.app).get(`/api/crm/${WORKSPACE_ID}/operations/intake-definitions`)).status).toBe(200)
    expect((await request(member.app).get(`/api/crm/${WORKSPACE_ID}/operations/intake-credentials`)).status).toBe(403)
    expect(member.readStore.listCredentials).not.toHaveBeenCalled()
  })

  it('creates a credential through the canonical service and reveals its key once', async () => {
    const owner = build()
    const response = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/intake-credentials`)
      .send({ label: 'Website', definitionIds: [DEFINITION_ID] })
    expect(response.status).toBe(201)
    expect(response.body.key).toBe('sk_intake_once')
    expect(owner.service.execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: expect.objectContaining({ canConfigure: true }),
    }), { kind: 'create_intake_credential', label: 'Website', definitionIds: [DEFINITION_ID] })
  })

  it('does not accept request-owned authority fields', async () => {
    const owner = build()
    const response = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/intake-credentials`)
      .send({ label: 'Website', definitionIds: [DEFINITION_ID], actor: { kind: 'user' } })
    expect(response.status).toBe(400)
    expect(owner.service.execute).not.toHaveBeenCalled()
  })
})
