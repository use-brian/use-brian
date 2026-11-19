import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { CrmIntegrationScopeError } from '@use-brian/core/crm/integration-authority.js'
import { CrmOperationsError, type CrmOperationsServicePort } from '@use-brian/core/crm/operations-types.js'
import { defineWorkspaceModuleRegistry } from '@use-brian/shared'
import { crmIntegrationRoutes, crmIntegrationCredentialRoutes } from '../crm-integration.js'
import { workspaceModuleRoutes } from '../workspace-modules.js'
import type { CrmIntegrationStore, CrmIntegrationPrincipal } from '../../db/crm-integration-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { WorkspaceModulesStore } from '../../db/workspace-modules-store.js'
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
    memberProfiles: () => memberProfiles }))
  const jwtGuard = vi.fn((_req, res) => res.status(401).json({ error: 'jwt_only' }))
  app.use('/api', jwtGuard)
  return { app, service, association, memberProfiles, authenticate, jwtGuard }
}

describe('[COMP:api/crm-integration-auth] Route isolation and shared adapters', () => {
  it.each(['/association/orders', '/association/module', '/association/tickets', '/association/media/example'])(
    'does not expose retired Association via %s', async path => {
      const f = fixture()
      expect((await request(f.app).get(`/api/crm/integration${path}`).set('Authorization', `Bearer ${token}`)).status).toBe(403)
      expect(f.service.execute).not.toHaveBeenCalled()
    },
  )
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
