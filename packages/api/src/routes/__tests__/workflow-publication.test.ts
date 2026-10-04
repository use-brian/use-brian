import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowRecord, WorkflowStore } from '@use-brian/core'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { mountWorkflowPublicationRoutes } from '../workflow-publication.js'
import { publicationRevision, type PublicationConsent } from '../../workflow/publication-consent.js'

const WF = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const WS = '33333333-3333-4333-8333-333333333333'
const INTEGRATION = '44444444-4444-4444-8444-444444444444'
function fixture({ userId = USER as string | null, role = 'owner', creator = USER } = {}) {
  const workflow = { id: WF, workspaceId: WS, createdBy: creator, managedBy: null,
    updatedAt: new Date('2026-09-30T08:00:00Z'), definition: { startStepId: 'remind', steps: [{
      id: 'remind', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Prepare an update',
      deliver: { channelType: 'telegram', channelId: '-100123', channelIntegrationId: INTEGRATION },
    }] } } as WorkflowRecord
  let consents: PublicationConsent[] = []
  let version = 0
  const store = { list: vi.fn(async () => consents), isStepRunning: vi.fn(),
    version: vi.fn(async () => String(version)),
    withPublicationLock: async <T>(_workflowId: string, _userId: string, action: () => Promise<T>) => action(),
    approve: vi.fn(async (c: Omit<PublicationConsent, 'id' | 'approvedAt' | 'revokedAt'>, expectedVersion: string) => {
      if (expectedVersion !== String(version)) return false
      consents = [{ ...c, id: 'approval', approvedAt: new Date().toISOString(), revokedAt: null }]
      version++
      return true
    }), revoke: vi.fn(async () => { consents = []; version++ }) }
  const getById = vi.fn(async () => workflow)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { Object.assign(req, { userId }); next() })
  mountWorkflowPublicationRoutes(app, {
    workflowStore: { getById } as unknown as WorkflowStore,
    workspaceStore: { getRole: vi.fn(async () => role) } as unknown as WorkspaceStore,
    publicationConsentStore: store,
  })
  return { app, workflow, store, getById, body: { acknowledged: true, workflowUpdatedAt: workflow.updatedAt.toISOString(), consentVersion: '0' } }
}
const path = `/workflows/${WF}/steps/remind/publication-consent`
describe('[COMP:api/workflow-publication] attended consent', () => {
  it('creates server-owned consent only after explicit confirmation of the current saved workflow', async () => {
    const f = fixture()
    const response = await request(f.app).post(path).send(f.body).expect(200)
    expect(f.store.approve).toHaveBeenCalledWith(expect.objectContaining({ approvedByUserId: USER,
      workflowRevision: publicationRevision(f.workflow), workspaceId: WS, channelId: '-100123', channelIntegrationId: INTEGRATION }), '0')
    expect(response.body.consents[0]).toMatchObject({ active: true, stepId: 'remind' })
    expect(response.body.consents[0]).not.toHaveProperty('approvedByUserId')
    expect(response.body.eligibleStepIds).toEqual(['remind'])
    expect(Date.parse(response.body.consents[0].expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 86400_000)
  })
  it.each([{}, { acknowledged: false }, { acknowledged: true }, { acknowledged: true, workflowUpdatedAt: 'bad' }])(
    'rejects absent or invalid confirmation %j', async body => {
      const f = fixture(); await request(f.app).post(path).send(body).expect(400)
      expect(f.store.approve).not.toHaveBeenCalled()
    })
  it('does not accept caller-supplied approval identity or destination overrides', async () => {
    const f = fixture()
    await request(f.app).post(path).send({ ...f.body, approvedByUserId: WS, channelId: '-100999' }).expect(400)
    expect(f.store.approve).not.toHaveBeenCalled()
  })
  it.each([{ userId: null, status: 401 }, { role: 'member', status: 403 }, { creator: WS, status: 403 }])(
    'rejects unauthorized consent %j', async options => {
      const f = fixture(options); await request(f.app).post(path).send(f.body).expect(options.status)
      expect(f.store.approve).not.toHaveBeenCalled()
    })
  it('refuses stale workflow confirmation', async () => {
    const f = fixture(); f.workflow.updatedAt = new Date('2026-09-30T09:00:00Z')
    await request(f.app).post(path).send(f.body).expect(409)
    expect(f.store.approve).not.toHaveBeenCalled()
  })
  it('does not resurrect revoked consent from a stale approval dialog', async () => {
    const f = fixture()
    await request(f.app).delete(path).expect(200)
    await request(f.app).post(path).send(f.body).expect(409)
    const response = await request(f.app).get(`/workflows/${WF}/publication-consents`).expect(200)
    expect(response.body.consentVersion).toBe('1')
    expect(response.body.consents).toEqual([])
  })
  it('shows changed workflow consent as inactive', async () => {
    const f = fixture(); await request(f.app).post(path).send(f.body).expect(200)
    f.workflow.updatedAt = new Date('2026-09-30T09:00:00Z')
    const response = await request(f.app).get(`/workflows/${WF}/publication-consents`).expect(200)
    expect(response.body.consents[0].active).toBe(false)
  })
  it('allows a demoted member to revoke their own consent, never someone else’s', async () => {
    const f = fixture({ role: 'member' }); await request(f.app).delete(path).expect(200)
    expect(f.store.revoke).toHaveBeenCalledExactlyOnceWith(WF, 'remind', USER)
  })
  it('requires pinned destinations without questions', async () => {
    const f = fixture(); Object.assign(f.workflow.definition.steps[0], { question: {} })
    await request(f.app).post(path).send(f.body).expect(400)
    expect(f.store.approve).not.toHaveBeenCalled()
  })
})
