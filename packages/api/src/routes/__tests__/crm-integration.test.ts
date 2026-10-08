import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { CrmIntegrationScopeError, CrmOperationsError, type CrmOperationsServicePort, type AssociationServicePort } from '@use-brian/core'
import { defineWorkspaceModuleRegistry } from '@use-brian/shared'
import { crmIntegrationRoutes, crmIntegrationCredentialRoutes } from '../crm-integration.js'
import { crmAssociationRoutes, associationMemberContext, workspaceModuleRoutes } from '../crm-association.js'
import { createAssociationService } from '../../association/service.js'
import type { CrmIntegrationStore, CrmIntegrationPrincipal } from '../../db/crm-integration-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { WorkspaceModulesStore } from '../../db/workspace-modules-store.js'
import type { AssociationStore } from '../../db/association-store.js'
import { authenticateBrainRequest } from '../../brain-mcp/auth.js'
import type { BrainKeyStore } from '../../db/brain-keys-store.js'
import { parseCrmIntakeToken } from '../../db/crm-intake-store.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'

const workspaceId = randomUUID(), credentialId = randomUUID(), userId = randomUUID(), eventId = randomUUID()
const token = `sk_crm_${credentialId}_${'A'.repeat(43)}`
const principal: CrmIntegrationPrincipal = { workspaceId, credentialId, grants: [{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all' } }] }
function fixture(auth: CrmIntegrationPrincipal | null = principal) {
  const service = { execute: vi.fn().mockResolvedValue({ command: 'save_event', record: { id: eventId }, created: true }) }
  const association = { execute: vi.fn().mockRejectedValue(new CrmIntegrationScopeError('association.read')) }
  const memberProfiles = {
    getMemberProfile: vi.fn(),
    updateMemberProfile: vi.fn(),
    updateMemberVerifiedEmail: vi.fn(),
  }
  const authenticate = vi.fn().mockResolvedValue(auth)
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: { authenticate }, service: service as CrmOperationsServicePort,
    association: association as AssociationServicePort, memberProfiles: () => memberProfiles }))
  const jwtGuard = vi.fn((_req, res) => res.status(401).json({ error: 'jwt_only' }))
  app.use('/api', jwtGuard)
  return { app, service, association, memberProfiles, authenticate, jwtGuard }
}

describe('[COMP:api/crm-integration-auth] Route isolation and shared adapters', () => {
  it('carries only the authenticated departmental issuer and ceiling into canonical commands', async () => {
    const departmentId = randomUUID(), assistantId = randomUUID()
    const departmentRead = { workspaceId, userId, assistantId, base: 'public' as const,
      departments: { [departmentId]: 'confidential' as const }, contextDepartment: null,
      binding: [departmentId], cap: 'confidential' as const }
    const executionLimits = { clearance: 'public' as const, compartments: null, mutationCompartments: [],
      projectIds: [randomUUID()], visibilityAssistantIds: [assistantId], sharedAudience: true }
    const f = fixture({ ...principal, departmentRead, executionLimits })
    f.service.execute.mockImplementationOnce(async () => {
      await Promise.resolve()
      expect(currentAgentAccess()).toMatchObject({ workspaceId, userId, departmentRead, ...executionLimits })
      return { command: 'save_event', record: { id: eventId }, created: true }
    })
    const response = await request(f.app).post('/api/crm/integration/operations/commands')
      .set('Authorization', `Bearer ${token}`).send({ kind: 'save_event', slug: 'fictional-event', title: 'Fictional event',
        startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10 })
    expect(response.status).toBe(201)
    expect(f.service.execute).toHaveBeenCalledTimes(1)
    expect(currentAgentAccess()).toBeUndefined()
  })
  it('returns scoped recovery for stage commands without exposing source details', async () => {
    const f = fixture({ ...principal, grants: [{ operation: 'crm.records.write', selectors: {} }] })
    f.service.execute.mockRejectedValueOnce(Object.assign(new Error('Hidden source details'), { code: 'scope_operation_denied' }))
    const response = await request(f.app).post('/api/crm/integration/operations/commands')
      .set('Authorization', `Bearer ${token}`).send({ kind: 'set_deal_pipeline_stage', dealId: eventId, pipelineId: randomUUID(), stageId: randomUUID() })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'scope_operation_denied', message: expect.stringContaining('administrator') })
    expect(JSON.stringify(response.body)).not.toContain('Hidden source')
  })
  it.each(['audit','event-delivery'])('refuses %s reads without a persisted departmental credential ceiling', async (resource) => {
    const f=fixture({...principal,grants:[{operation:'crm.audit.read',selectors:{}}]})
    const response=await request(f.app).get(`/api/crm/integration/operations/${resource}`)
      .set('Authorization',`Bearer ${token}`)
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({error:'not_authorized',message:expect.stringContaining('Department access')})
    expect(JSON.stringify(response.body)).not.toContain('subjectId')
  })
  it('exposes only the bounded member profile and requires record-write authority for edits', async () => {
    const grants = [{ operation: 'crm.records.read', selectors: {} }, { operation: 'crm.records.write', selectors: {} }] as const
    const f = fixture({ ...principal, grants: [...grants] })
    const profile = { contactId: eventId, name: 'Fictional Member', email: 'member@example.test', phone: null,
      organisationName: 'Example Org', position: null, mailingAddress: null, updatedAt: '2026-09-12T08:00:00.000Z' }
    f.memberProfiles.getMemberProfile.mockResolvedValueOnce(profile)
    const read = await request(f.app).get(`/api/crm/integration/operations/member-profiles/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ profile })
    expect(read.headers['cache-control']).toBe('no-store')

    f.memberProfiles.updateMemberProfile.mockResolvedValueOnce({ ...profile, phone: '+852 2000 0000' })
    const update = { expectedUpdatedAt: profile.updatedAt, phone: '+852 2000 0000' }
    const written = await request(f.app).patch(`/api/crm/integration/operations/member-profiles/${eventId}`)
      .set('Authorization', `Bearer ${token}`).send(update)
    expect(written.status).toBe(200)
    expect(written.body.profile.phone).toBe('+852 2000 0000')
    expect(f.memberProfiles.updateMemberProfile).toHaveBeenCalledWith(eventId, update)

    const extra = await request(f.app).patch(`/api/crm/integration/operations/member-profiles/${eventId}`)
      .set('Authorization', `Bearer ${token}`).send({ ...update, email: 'other@example.test' })
    expect(extra.status).toBe(400)
    expect(f.memberProfiles.updateMemberProfile).toHaveBeenCalledTimes(1)

    const verifiedEmail = { expectedUpdatedAt: profile.updatedAt, email: 'New.Member@Example.test', verificationId: credentialId }
    f.memberProfiles.updateMemberVerifiedEmail.mockResolvedValueOnce({ ...profile, email: 'new.member@example.test' })
    const emailWritten = await request(f.app).patch(`/api/crm/integration/operations/member-profiles/${eventId}/verified-email`)
      .set('Authorization', `Bearer ${token}`).send(verifiedEmail)
    expect(emailWritten.status).toBe(200)
    expect(emailWritten.body.profile.email).toBe('new.member@example.test')
    expect(f.memberProfiles.updateMemberVerifiedEmail).toHaveBeenCalledWith(eventId, {
      ...verifiedEmail, email: 'new.member@example.test',
    })
  })
  it('denies member-profile edits without crm.records.write', async () => {
    const f = fixture({ ...principal, grants: [{ operation: 'crm.records.read', selectors: {} }] })
    const response = await request(f.app).patch(`/api/crm/integration/operations/member-profiles/${eventId}`)
      .set('Authorization', `Bearer ${token}`).send({ expectedUpdatedAt: '2026-09-12T08:00:00.000Z', name: 'New name' })
    expect(response.status).toBe(403)
    expect(f.memberProfiles.updateMemberProfile).not.toHaveBeenCalled()
    const emailResponse = await request(f.app).patch(`/api/crm/integration/operations/member-profiles/${eventId}/verified-email`)
      .set('Authorization', `Bearer ${token}`).send({
        expectedUpdatedAt: '2026-09-12T08:00:00.000Z', email: 'new@example.test', verificationId: credentialId,
      })
    expect(emailResponse.status).toBe(403)
    expect(f.memberProfiles.updateMemberVerifiedEmail).not.toHaveBeenCalled()
  })
  it('exposes normalized provider receipts through the shared integration adapter', async () => {
    const f = fixture()
    f.association.execute.mockResolvedValueOnce({ command: 'reconcile_provider_entitlement', record: { id: eventId }, created: true, receipt: { id: credentialId, state: 'applied' } } as never)
    const event = { provider: 'fixture', providerReference: 'fictional-subscription', providerPeriodId: 'period-1', eventId: 'event-1', occurredAt: '2026-09-09T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: eventId, status: 'cancelled' } }
    const accepted = await request(f.app).post('/api/crm/integration/association/provider-entitlement-events').set('Authorization', `Bearer ${token}`).send(event)
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ entitlement: { id: eventId }, receipt: { state: 'applied' } })
    expect(f.association.execute).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'integration_key', credentialId } }), { kind: 'reconcile_provider_entitlement', event })
    f.association.execute.mockResolvedValueOnce({ command: 'list_provider_receipts', items: [{ id: credentialId }], nextCursor: 'next-page' } as never)
    const page = await request(f.app).get('/api/crm/integration/association/provider-receipts?limit=10&state=retry').set('Authorization', `Bearer ${token}`)
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({ receipts: [{ id: credentialId }], nextCursor: 'next-page' })
    expect(f.association.execute).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: 'list_provider_receipts', limit: 10, state: 'retry' }))
  })
  it('exposes the closed order financial-evidence command to the scoped backend adapter', async () => {
    const f = fixture(), event = { provider: 'stripe', providerReference: 'cs_fixture', adjustmentReference: 're_fixture',
      eventId: 'evt_financial', kind: 'refund', status: 'succeeded', amountMinor: 400, currency: 'USD',
      occurredAt: '2026-09-09T00:00:00Z', metadata: {} }
    f.association.execute.mockResolvedValueOnce({ command: 'reconcile_provider_financial_event', record: { id: eventId, refundState: 'partial' },
      created: true, receipt: { id: credentialId, state: 'applied' } } as never)
    const accepted = await request(f.app).post(`/api/crm/integration/association/orders/${eventId}/provider-financial-events`)
      .set('Authorization', `Bearer ${token}`).send(event)
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ order: { id: eventId, refundState: 'partial' }, created: true, receipt: { state: 'applied' } })
    expect(f.association.execute).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'integration_key', credentialId } }),
      { kind: 'reconcile_provider_financial_event', orderId: eventId, event })
  })
  it('preserves order financial totals on the scoped integration list route', async () => {
    const f = fixture(), summary = [{ currency: 'USD', orderCount: 1, settledOrderCount: 1, subtotalMinor: '1000',
      discountMinor: '0', grossMinor: '1000', refundedMinor: '400', netMinor: '600', pendingMinor: '0' }]
    f.association.execute.mockResolvedValueOnce({ command: 'list_orders', items: [{ id: eventId }], nextCursor: null,
      financialSummary: summary } as never)
    const response = await request(f.app).get(`/api/crm/integration/association/orders?eventId=${eventId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ orders: [{ id: eventId }], financialSummary: summary })
  })
  it('exposes notification evidence only through the exact order route', async () => {
    const f = fixture()
    f.association.execute.mockResolvedValueOnce({ command: 'list_order_notifications', items: [], nextCursor: null } as never)
    const response = await request(f.app).get(`/api/crm/integration/association/orders/${eventId}/notifications?limit=10`)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ notifications: [], nextCursor: null })
    expect(f.association.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId, actor: { kind: 'integration_key', credentialId } }),
      { kind: 'list_order_notifications', orderId: eventId, limit: 10 },
    )
  })
  it('runs before JWT-only guards, derives context from the CRM credential and exposes no secret', async () => {
    const f = fixture()
    const result = await request(f.app).get('/api/crm/integration/catalog').set('Authorization', `Bearer ${token}`)
    expect(result.status).toBe(200)
    expect(result.body.grants).toEqual(principal.grants)
    expect(result.body).toMatchObject({ workspaceId, credentialId })
    expect(result.headers['cache-control']).toBe('no-store')
    expect(JSON.stringify(result.body)).not.toContain(token)
    expect(f.jwtGuard).not.toHaveBeenCalled()
    const response = await request(f.app).post('/api/crm/integration/operations/events').set('Authorization', `Bearer ${token}`).send({
      slug: 'fixture', title: 'Fixture', startsAt: '2099-01-01T10:00:00Z', endsAt: '2099-01-01T12:00:00Z', timezone: 'UTC', mode: 'venue',
    })
    expect(response.status).toBe(201)
    expect(f.service.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'integration_key', credentialId },
      authority: expect.objectContaining({ integration: { credentialId, grants: principal.grants }, trustedIdentitySources: [] }) }), expect.objectContaining({ kind: 'save_event' }))
  })
  it.each(['', 'Bearer sk_intake_fixture', 'Bearer sk_brian_fixture', 'Bearer first-party-jwt'])(
    'rejects other credential families before authentication: %s', async (authorization) => {
      const f = fixture()
      const response = await request(f.app).get('/api/crm/integration/catalog').set('Authorization', authorization)
      expect(response.status).toBe(401)
      expect(f.authenticate).not.toHaveBeenCalled()
    },
  )
  it('rejects invalid/revoked keys and does not fall through to another authority', async () => {
    const f = fixture(null)
    expect((await request(f.app).get('/api/crm/integration/catalog').set('Authorization', `Bearer ${token}`)).status).toBe(401)
    expect(f.jwtGuard).not.toHaveBeenCalled()
  })
  it('returns 401 when a previously authenticated key loses admission at transaction time', async () => {
    const f=fixture()
    f.service.execute.mockRejectedValueOnce(new CrmOperationsError('credential_revoked','The CRM integration credential is no longer active.'))
    const response=await request(f.app).post('/api/crm/integration/operations/events').set('Authorization',`Bearer ${token}`).send({
      slug: 'fixture',title: 'Fixture',startsAt: '2099-01-01T10:00:00Z',endsAt: '2099-01-01T12:00:00Z',timezone: 'UTC',mode: 'venue',
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toBe('credential_revoked')
    expect(f.jwtGuard).not.toHaveBeenCalled()
  })
  it.each(['/modules/association/actions', '/operations/intake-credentials', '/operations/integration-credentials', '/operations/contacts/erase', '/operations/privacy/erase', '/chat', '/brain/mcp'])(
    'has no machine escalation route: %s', async (path) => {
      const f = fixture()
      const response = await request(f.app).post(`/api/crm/integration${path}`).set('Authorization', `Bearer ${token}`).send({ confirmed: true })
      expect(response.status).toBe(403)
      expect(response.body.error).toBe('integration_scope_denied')
      expect(f.service.execute).not.toHaveBeenCalled()
      expect(f.jwtGuard).not.toHaveBeenCalled()
    },
  )
  it('does not let an integration credential invoke the member receipt retry route', async () => {
    const f = fixture()
    const response = await request(f.app).post('/api/crm/integration/association/provider-receipts/00000000-0000-4000-8000-000000000000/retry')
      .set('Authorization', `Bearer ${token}`).send({})
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('integration_scope_denied')
  })
  it('refuses body workspace/actor authority and command-level credential administration', async () => {
    const f = fixture()
    for (const field of ['workspaceId', 'actor', 'authority']) {
      const response = await request(f.app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${token}`).send({ kind: 'save_event', [field]: workspaceId })
      expect(response.status).toBe(422)
    }
    const response = await request(f.app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${token}`).send({ kind: 'revoke_intake_credential', credentialId })
    expect(response.status).toBe(403)
    expect(f.service.execute).not.toHaveBeenCalled()
  })
  it('denies an ungranted command before calling the canonical service', async () => {
    const f = fixture({ ...principal, grants: [{ operation: 'crm.records.read', selectors: {} }] })
    const response = await request(f.app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${token}`).send({ kind: 'archive_segment', segmentId: eventId })
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('integration_scope_denied')
    expect(f.service.execute).not.toHaveBeenCalled()
  })
  it('cannot authenticate CRM keys at Brain MCP or the definition-scoped intake boundary', async () => {
    const brain = { authenticate: vi.fn(), getById: vi.fn() } as unknown as BrainKeyStore
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as express.Request
    expect(await authenticateBrainRequest(req, { brainKeyStore: brain })).toBeNull()
    expect(parseCrmIntakeToken(token)).toBeNull()
  })
  it('member adapters ignore machine headers and verify workspace membership before commands', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue(null) } as unknown as WorkspaceStore
    const service = { execute: vi.fn() } as unknown as AssociationServicePort
    const app = express()
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    expect((await request(app).get(`/api/crm/${workspaceId}/association/orders`).set('Authorization', `Bearer ${token}`)).status).toBe(401)
    expect(workspaceStore.getRole).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
  })
  it('maps member destination preview with all contacts before order detail matching', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
    const preview = { choices: [], validForMs: 30_000 }
    const service = { execute: vi.fn().mockResolvedValue({ command: 'preview_order_destinations', record: preview }) } as unknown as AssociationServicePort
    const app = express()
    app.use((req, _res, next) => { req.userId = userId; next() })
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    const response = await request(app).get(`/api/crm/${workspaceId}/association/orders/destinations?contactIds=${eventId},${credentialId}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ preview })
    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'user', userId } }), { kind: 'preview_order_destinations', contactIds: [eventId, credentialId] })
  })
  it('maps the authenticated member receipt retry route to the closed canonical command', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
    const service = { execute: vi.fn().mockResolvedValue({ command: 'retry_provider_receipt', record: { id: eventId }, created: false,
      receipt: { id: credentialId, state: 'applied' } }) } as unknown as AssociationServicePort
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    const response = await request(app).post(`/api/crm/${workspaceId}/association/provider-receipts/${credentialId}/retry`).send({})
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ result: { id: eventId }, receipt: { id: credentialId, state: 'applied' }, created: false })
    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'user', userId } }),
      { kind: 'retry_provider_receipt', receiptId: credentialId })
  })
  it('maps the authenticated member roster route without exposing it on the integration adapter', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
    const service = { execute: vi.fn().mockResolvedValue({ command: 'list_operational_roster', items: [{ id: eventId }], nextCursor: null }) } as unknown as AssociationServicePort
    const app = express()
    app.use((req, _res, next) => { req.userId = userId; next() })
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    const response = await request(app).get(`/api/crm/${workspaceId}/association/events/${eventId}/operational-roster?limit=25`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ registrations: [{ id: eventId }], nextCursor: null })
    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'user', userId } }),
      { kind: 'list_operational_roster', eventId, limit: 25 })
    const integration = fixture()
    expect((await request(integration.app).get(`/api/crm/integration/association/events/${eventId}/operational-roster`).set('Authorization', `Bearer ${token}`)).status).toBe(403)
    expect(integration.association.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: 'integration_key', credentialId } }),
      { kind: 'list_operational_roster', eventId, limit: 50 })
  })
  it('maps owner promotion reads and writes to the closed canonical commands', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
    const service = { execute: vi.fn()
      .mockResolvedValueOnce({ command: 'list_promotions', items: [{ id: credentialId }], nextCursor: null })
      .mockResolvedValueOnce({ command: 'save_promotion', record: { id: credentialId }, created: true }) } as unknown as AssociationServicePort
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    const listed = await request(app).get(`/api/crm/${workspaceId}/association/promotions?status=active&limit=25`)
    expect(listed.status).toBe(200)
    expect(listed.body).toEqual({ promotions: [{ id: credentialId }], nextCursor: null })
    expect(service.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({ actor: { kind: 'user', userId } }),
      { kind: 'list_promotions', status: 'active', limit: 25 })
    const promotion = { key: 'launch', name: 'Launch offer', code: 'EXAMPLE-10', discountType: 'percentage',
      percentageBasisPoints: 1_000, targetKind: 'event', targetIds: [eventId], combinesWithMemberPrice: false,
      releaseOnFullRefund: false, status: 'active' }
    const saved = await request(app).post(`/api/crm/${workspaceId}/association/promotions`).send(promotion)
    expect(saved.status).toBe(201)
    expect(saved.body).toEqual({ promotion: { id: credentialId }, created: true })
    expect(service.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({ actor: { kind: 'user', userId } }),
      { kind: 'save_promotion', promotion: { ...promotion, recurrenceMode: 'once', applyMode: 'each_eligible_item' } })
  })
  it('maps the reviewed member check-in correction to its closed command', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
    const service = { execute: vi.fn().mockResolvedValue({ command: 'correct_check_in', record: { id: eventId, status: 'confirmed' } }) } as unknown as AssociationServicePort
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    const response = await request(app).post(`/api/crm/${workspaceId}/association/registrations/${eventId}/check-in-correction`)
      .send({ expectedStatus: 'checked_in', reason: 'Scanned the wrong badge' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ registration: { id: eventId, status: 'confirmed' } })
    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: 'user', userId } }), {
      kind: 'correct_check_in', registrationId: eventId, correction: { expectedStatus: 'checked_in', reason: 'Scanned the wrong badge' },
    })
  })
  it('previews credential bindings only for authenticated managers with validated assistant and cap', async () => {
    const role = vi.fn().mockResolvedValue('owner')
    const workspaceStore = { getRole: role } as unknown as WorkspaceStore
    const bindingOptions = vi.fn().mockResolvedValue({ mode: 'department-v2', choices: [], assistants: [], validForMs: 30000 })
    const credentials = { bindingOptions } as unknown as CrmIntegrationStore
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/crm', crmIntegrationCredentialRoutes({ workspaceStore, credentials }))
    const path = `/api/crm/${workspaceId}/operations/integration-credentials/binding-options`
    const response = await request(app).get(path).query({ assistantId: eventId, cap: 'confidential' })
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(bindingOptions).toHaveBeenCalledExactlyOnceWith(workspaceId, userId, { assistantId: eventId, cap: 'confidential' })
    expect((await request(app).get(path).query({ cap: 'unknown' })).status).toBe(400)
    role.mockResolvedValue('member')
    expect((await request(app).get(path)).status).toBe(403)
    expect(bindingOptions).toHaveBeenCalledTimes(1)
  })
  it('keeps member module reads separate from owner/admin actions and credential issuance', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('member') } as unknown as WorkspaceStore
    const credentials = { create: vi.fn(), listForMember: vi.fn() } as unknown as CrmIntegrationStore
    const modules = { listForMember: vi.fn().mockResolvedValue([{ state: 'disabled', version: 1 }]), act: vi.fn() } as unknown as WorkspaceModulesStore
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/workspaces', workspaceModuleRoutes({ workspaceStore, modules }))
    app.use('/api/crm', crmIntegrationCredentialRoutes({ workspaceStore, credentials }))
    expect((await request(app).get(`/api/workspaces/${workspaceId}/modules`)).status).toBe(200)
    expect((await request(app).post(`/api/workspaces/${workspaceId}/modules/association/actions`).send({ action: 'enable', expectedVersion: 1 })).status).toBe(403)
    expect((await request(app).post(`/api/crm/${workspaceId}/operations/integration-credentials`).send({})).status).toBe(403)
    expect(modules.act).not.toHaveBeenCalled()
    expect(credentials.create).not.toHaveBeenCalled()
  })
  it('routes a second registered module without Association service changes', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
    const registry = defineWorkspaceModuleRegistry({ test_module: {
      key: 'test_module', defaultState: 'disabled',
      blockingCountCompatibility: { field: 'pendingJobs', blockerKey: 'pending_jobs' },
    } } as const)
    const modules = {
      listForMember: vi.fn(),
      act: vi.fn().mockResolvedValue({
        module: { workspaceId, moduleKey: 'test_module', state: 'draining', version: 2 },
        changed: true, blockingWork: [{ key: 'pending_jobs', count: 3 }],
      }),
    } as unknown as WorkspaceModulesStore
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/workspaces', workspaceModuleRoutes({ workspaceStore, modules, registry }))
    const response = await request(app).post(`/api/workspaces/${workspaceId}/modules/test_module/actions`)
      .send({ action: 'request_disable', expectedVersion: 1 })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ changed: true, pendingJobs: 3,
      module: { moduleKey: 'test_module' }, blockingWork: [{ key: 'pending_jobs', count: 3 }] })
    expect(modules.act).toHaveBeenCalledWith(workspaceId, userId, 'test_module',
      { action: 'request_disable', expectedVersion: 1 })
    const unknown = await request(app).post(`/api/workspaces/${workspaceId}/modules/unregistered/actions`)
      .send({ action: 'enable', expectedVersion: 0 })
    expect(unknown.status).toBe(422)
    expect(unknown.body.error).toBe('invalid_input')
  })
})

describe('[COMP:api/association-media] integration read', () => {
  const mediaId = randomUUID()
  function mediaApp(grants: CrmIntegrationPrincipal['grants']) {
    const signedReadUrl = vi.fn(async () => 'https://acct.blob.core.windows.net/files/k?sig=x')
    const store = { list: vi.fn(async () => []), get: vi.fn(async (ws: string, id: string) => (ws === workspaceId && id === mediaId
      ? { id, name: 'a.jpg', title: 'a.jpg', mime: 'image/jpeg', sizeBytes: 1, storageUri: `az://files/${workspaceId}/${id}`, updatedAt: '2026-09-24T00:00:00.000Z' }
      : null)) }
    const resolver = { forWorkspace: vi.fn(), forUri: vi.fn(async () => ({ signedReadUrl })) }
    const app = express()
    app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: { authenticate: vi.fn().mockResolvedValue({ ...principal, grants }) },
      service: {} as CrmOperationsServicePort, association: {} as AssociationServicePort,
      websiteMedia: { store, resolver: resolver as never } }))
    return { app, store, signedReadUrl }
  }

  it('redirects to the signed URL for a key holding association.read, scoped to its workspace', async () => {
    const { app, store } = mediaApp([{ operation: 'association.read', selectors: {} }])
    const res = await request(app).get(`/api/crm/integration/association/media/${mediaId}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('blob.core.windows.net')
    expect(store.get).toHaveBeenCalledWith(workspaceId, mediaId)
  })

  it('refuses a key without association.read and 404s unknown ids', async () => {
    const denied = mediaApp([{ operation: 'crm.catalog.configure', selectors: {} }])
    const res = await request(denied.app).get(`/api/crm/integration/association/media/${mediaId}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(denied.signedReadUrl).not.toHaveBeenCalled()
    const allowed = mediaApp([{ operation: 'association.read', selectors: {} }])
    const missing = await request(allowed.app).get(`/api/crm/integration/association/media/${randomUUID()}`).set('Authorization', `Bearer ${token}`)
    expect(missing.status).toBe(404)
  })
})
