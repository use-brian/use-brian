import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ScopeEvidence, WorkflowRecord, WorkflowRunRecord } from '@use-brian/core'
vi.mock('../../db/derived-scope-store.js', async original => ({
  ...await original<typeof import('../../db/derived-scope-store.js')>(),
  readCurrentScopeSources: vi.fn(async () => []),
}))
import { readCurrentScopeSources } from '../../db/derived-scope-store.js'
import { validateAudienceScopeEvidence } from '../../context-scope/caller-evidence.js'
import { createWorkflowPublicationAuthorizer, createWorkflowPublicationDispatcher, publicationRevision, publicationTarget, type PublicationConsent } from '../publication-consent.js'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ASST = '33333333-3333-4333-8333-333333333333'
const WF = '44444444-4444-4444-8444-444444444444'
const INT = '55555555-5555-4555-8555-555555555555'
const RUN = '66666666-6666-4666-8666-666666666666'
const now = Date.parse('2026-09-30T12:00:00Z')
const ceiling: AccessCeiling = { workspaceId: WS, userId: USER, clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null }
const evidence: ScopeEvidence = { sensitivity: 'internal', compartments: [], projectIds: [], sources: [{
  workspaceId: WS, userId: USER, assistantId: null, resourceKind: 'memory', resourceId: WF,
  version: '1', sensitivity: 'internal', compartments: [], projectIds: [],
}] }
function fixture() {
  const workflow = { id: WF, workspaceId: WS, createdBy: USER, managedBy: null,
    updatedAt: new Date('2026-09-30T08:00:00Z'), definition: { startStepId: 'remind', steps: [{
      id: 'remind', type: 'assistant_call', target: { assistantId: ASST }, prompt: 'Prepare the update',
      deliver: { channelType: 'telegram', channelId: '-100123', channelIntegrationId: INT },
    }] } } as WorkflowRecord
  const run = { id: RUN, workflowId: WF, workspaceId: WS, status: 'running', triggeredBy: USER,
    startedAt: new Date('2026-09-30T10:00:00Z') } as WorkflowRunRecord
  const consent: PublicationConsent = { id: 'approval', workflowId: WF, workspaceId: WS, stepId: 'remind',
    workflowRevision: publicationRevision(workflow), approvedByUserId: USER,
    channelType: 'telegram', channelId: '-100123', channelIntegrationId: INT,
    approvedAt: '2026-09-30T09:00:00Z', expiresAt: '2026-10-30T09:00:00Z', revokedAt: null }
  let locked = false
  const store = { list: vi.fn(async () => [consent]), version: vi.fn(async () => '0'), approve: vi.fn(), revoke: vi.fn(), isStepRunning: vi.fn(async () => true),
    withPublicationLock: async <T>(_workflowId: string, _userId: string, action: () => Promise<T>) => {
      locked = true
      try { return await action() } finally { locked = false }
    },
  }
  const resolveAudience = vi.fn(async () => ({ allowed: true as const, source: 'binding' as const, ceiling: { ...ceiling, userId: '' } }))
  const getRole = vi.fn(async () => 'owner' as const)
  const resolveLiveAccess = vi.fn(async () => ceiling)
  const validateEvidence = vi.fn(validateAudienceScopeEvidence)
  const authorize = createWorkflowPublicationAuthorizer({ store,
    workflowStore: { findByIdSystem: vi.fn(async () => workflow) }, runStore: { getRunSystem: vi.fn(async () => run) },
    resolveAudience, getRole, resolveLiveAccess, validateEvidence,
    findAssistant: vi.fn(async () => ({ id: ASST, workspaceId: WS }) as never), now: () => now,
  })
  const input = { workspaceId: WS, assistantId: ASST, userId: USER, channelType: 'telegram',
    channelId: '-100123', channelIntegrationId: INT, scopeEvidence: structuredClone(evidence),
    publication: { runId: RUN, stepId: 'remind' } }
  const dispatch = createWorkflowPublicationDispatcher({ store, runStore: { getRunSystem: vi.fn(async () => run) }, authorizePublication: authorize })
  return { workflow, run, consent, store, resolveAudience, getRole, resolveLiveAccess, validateEvidence, authorize, input, dispatch, locked: () => locked }
}
beforeEach(() => {
  vi.mocked(readCurrentScopeSources).mockReset()
  vi.mocked(readCurrentScopeSources).mockImplementation(async (_pool, _workspace, sources) =>
    sources.map(source => ({ state: 'current', source })))
})

describe('[COMP:workflow/publication-consent] destination-bound prepared output', () => {
  it('permits the consenting owner private context without erasing provenance or widening audience labels', async () => {
    const f = fixture()
    await expect(validateAudienceScopeEvidence(evidence, { ...ceiling, userId: '' })).rejects.toMatchObject({ diagnostic: 'user_visibility' })
    await expect(f.authorize(f.input)).resolves.toEqual({ allowed: true, approvalId: 'approval' })
    expect(f.validateEvidence).toHaveBeenCalledWith(evidence, ceiling)
    expect(f.input.scopeEvidence).toEqual(evidence)
    expect(readCurrentScopeSources).toHaveBeenCalledOnce()
  })
  it.each(['missing', 'revoked', 'expired', 'wrong-user', 'wrong-destination', 'wrong-integration', 'wrong-workspace', 'edited', 'late-approval', 'same-millisecond'])(
    'refuses %s consent', async reason => {
      const f = fixture()
      if (reason === 'missing') f.store.list.mockResolvedValue([])
      if (reason === 'revoked') f.consent.revokedAt = '2026-09-30T11:00:00Z'
      if (reason === 'expired') f.consent.expiresAt = '2026-09-30T11:00:00Z'
      if (reason === 'wrong-user') f.consent.approvedByUserId = ASST
      if (reason === 'wrong-destination') f.consent.channelId = '-100999'
      if (reason === 'wrong-integration') f.consent.channelIntegrationId = WF
      if (reason === 'wrong-workspace') f.consent.workspaceId = WF
      if (reason === 'edited') f.workflow.updatedAt = new Date('2026-09-30T11:00:00Z')
      if (reason === 'late-approval') f.consent.approvedAt = '2026-09-30T11:00:00Z'
      if (reason === 'same-millisecond') f.consent.approvedAt = f.run.startedAt.toISOString()
      await expect(f.authorize(f.input)).resolves.toEqual({ allowed: false })
    })
  it.each(['other-actor', 'different-assistant', 'different-destination', 'different-integration', 'different-step', 'not-running', 'missing-evidence', 'session-sink', 'external', 'demoted'])(
    'refuses %s execution', async reason => {
      const f = fixture()
      if (reason === 'other-actor') f.run.triggeredBy = ASST
      if (reason === 'different-assistant') f.input.assistantId = USER
      if (reason === 'different-destination') f.input.channelId = '-100999'
      if (reason === 'different-integration') f.input.channelIntegrationId = WF
      if (reason === 'different-step') f.input.publication.stepId = 'other'
      if (reason === 'not-running') f.store.isStepRunning.mockResolvedValue(false)
      if (reason === 'missing-evidence') f.input.scopeEvidence = undefined as never
      if (reason === 'session-sink') Object.assign(f.input, { sessionId: 'private-origin' })
      if (reason === 'external') Object.assign(f.input, { recipientMode: 'external' })
      if (reason === 'demoted') f.getRole.mockResolvedValue('member' as never)
      await expect(f.authorize(f.input)).resolves.toEqual({ allowed: false })
    })
  it.each(['other-private-owner', 'clearance', 'teams', 'projects', 'held', 'revoked-live-access', 'database-error'])(
    'keeps %s source restriction enforced', async reason => {
      const f = fixture()
      if (reason === 'other-private-owner') f.input.scopeEvidence.sources![0].userId = ASST
      if (reason === 'clearance') f.input.scopeEvidence.sensitivity = 'confidential'
      if (reason === 'teams') f.input.scopeEvidence.compartments = ['finance']
      if (reason === 'projects') f.input.scopeEvidence.projectIds = [WF]
      if (reason === 'held') vi.mocked(readCurrentScopeSources).mockResolvedValue([{ state: 'held' }] as never)
      if (reason === 'revoked-live-access') f.resolveLiveAccess.mockResolvedValue({ ...ceiling, clearance: 'public' })
      if (reason === 'database-error') vi.mocked(readCurrentScopeSources).mockRejectedValue(new Error('offline'))
      await expect(f.authorize(f.input)).resolves.toEqual({ allowed: false })
    })
  it.each(['owner', 'clearance', 'team', 'project', 'unverifiable', 'stale_input'])(
    'revalidates current source state before publishing: %s', async change => {
      const f = fixture(), source = f.input.scopeEvidence.sources![0]
      if (change === 'unverifiable' || change === 'stale_input') {
        vi.mocked(readCurrentScopeSources).mockResolvedValue([{ state: change, source }])
      } else {
        const current = { ...source }
        if (change === 'owner') current.userId = ASST
        if (change === 'clearance') current.sensitivity = 'confidential'
        if (change === 'team') current.compartments = ['finance']
        if (change === 'project') current.projectIds = [WF]
        vi.mocked(readCurrentScopeSources).mockResolvedValue([{ state: 'changed', source, current }])
      }
      await expect(f.authorize(f.input)).resolves.toEqual({ allowed: false })
    })
  it.each(['revoked', 'demoted', 'edited', 'expired'])(
    'refuses consent %s during source revalidation', async reason => {
      const f = fixture()
      f.validateEvidence.mockImplementationOnce(async () => {
        if (reason === 'revoked') f.consent.revokedAt = new Date(now).toISOString()
        if (reason === 'demoted') f.getRole.mockResolvedValue('member' as never)
        if (reason === 'edited') f.workflow.updatedAt = new Date(now)
        if (reason === 'expired') f.consent.expiresAt = new Date(now - 1).toISOString()
        return evidence
      })
      await expect(f.authorize(f.input)).resolves.toEqual({ allowed: false })
    })
  it('rechecks and sends within the publication dispatch lock', async () => {
    const f = fixture()
    const send = vi.fn(async () => { expect(f.locked()).toBe(true); return 'telegram-message' })
    await expect(f.dispatch(f.input, f.consent.id, send)).resolves.toEqual({ allowed: true, messageId: 'telegram-message' })
    expect(send).toHaveBeenCalledOnce()
    expect(f.locked()).toBe(false)
  })
  it('does not dispatch using a revoked or replaced receipt', async () => {
    const f = fixture(); const send = vi.fn()
    await expect(f.dispatch(f.input, 'old-approval', send)).resolves.toEqual({ allowed: false })
    f.consent.revokedAt = new Date(now).toISOString()
    await expect(f.dispatch(f.input, f.consent.id, send)).resolves.toEqual({ allowed: false })
    expect(send).not.toHaveBeenCalled()
  })
  it('requires an audience binding even when publication was approved', async () => {
    const f = fixture()
    f.resolveAudience.mockResolvedValue({ allowed: true, source: 'public', ceiling } as never)
    await expect(f.authorize(f.input)).resolves.toEqual({ allowed: false })
  })
  it.each(['question', 'questionResponse', 'principal', 'managed', 'reply', 'unpinned'])(
    'does not offer consent for %s steps', key => {
      const f = fixture()
      const step = f.workflow.definition.steps[0]
      if (key === 'principal') Object.assign(f.workflow.definition, { principal: { kind: 'api_external_client' } })
      else if (key === 'managed') f.workflow.managedBy = 'knowledge'
      else if (key === 'reply') Object.assign(step, { deliver: { channelType: 'whatsapp', replyToTrigger: true } })
      else if (key === 'unpinned') Object.assign(step, { deliver: { channelType: 'telegram', channelId: '-100123' } })
      else Object.assign(step, { [key]: {} })
      expect(publicationTarget(f.workflow, 'remind')).toBeNull()
    })
})
